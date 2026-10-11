"""Research admission with invented evidence and stubbed transport only."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import evidence_fixture as fixture, test_runtime as queue
from tests.investor.fixtures import profile
from worker.investor.data_evidence import review_source
from worker.investor.runtime import prepare_research_job, sync_research_requests
from worker.investor.source_inputs import admit_evidence_input, enqueue_evidence_request, resolve_evidence_input
from worker.orchestration.db import WorkbenchError
from worker.orchestration.jobs import claim_job, complete_job
from worker.orchestration.runtime import run_pending_once


class EvidenceResearchTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    save = queue.InvestorRuntimeTests.save
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def create(self):
        return fixture.create(self.db, "w", "synthetic-investor")

    def calculate(self, later=queue.NOW):
        return run_pending_once(self.db, "fictional-stub-test", clock=lambda: later)

    def test_admission_metadata_only_queues_current_profile_and_default_worker_calculates(self):
        self.save(); values = self.create()
        document = json.loads(values["source"]["document_json"])
        self.assertNotIn("dataset", document)
        self.assertNotIn("observations", document)
        self.assertIsNotNone(values["source"]["request_id"])
        self.assertEqual(self.calculate()["status"], "succeeded")
        result = json.loads(self.db.execute("SELECT document_json FROM investor_research_runs").fetchone()[0])
        self.assertEqual(result["result"]["data_mode"], "reconstructed")
        self.assertEqual(result["result"]["status"], "risk_options_ready")
        self.assertIsNone(result["result"]["selected_parameters"])
        self.assertEqual(result["registry"]["phases"]["train"]["completed"], 3)
        self.assertEqual(result["registry"]["phases"]["holdout"]["registered"], 0)
        self.assertFalse(result["result"]["live_advice_eligible"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_reference_plans").fetchone()[0], 0)
        self.assert_no_finance()

    def test_reconstruction_stays_hash_stable_later_and_does_not_write_during_read(self):
        values = self.create(); before = self.db.total_changes
        first = resolve_evidence_input(self.db, "w", values["source"]["id"], now=queue.NOW)
        later = resolve_evidence_input(self.db, "w", values["source"]["id"], now="2026-01-03T00:00:00.000Z")
        self.assertEqual(first, later); self.assertEqual(self.db.total_changes, before)
        self.assertIsNone(values["source"]["request_id"])
        self.save(); self.assertIsNotNone(enqueue_evidence_request(self.db, "w", values["source"], queue.NOW))
        with self.assertRaisesRegex(WorkbenchError, "OUT_OF_SCOPE"):
            resolve_evidence_input(self.db, "other", values["source"]["id"], now=queue.NOW)

    def test_identical_evidence_and_design_reuses_admission_at_a_later_clock(self):
        self.save(); values = self.create()
        before = self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0]
        repeated = admit_evidence_input(self.db, "w", "synthetic-investor", values["captures"], values["actions"], [], fixture.START, fixture.END,
            values["plan"], values["policy"], now="2026-01-03T00:00:00.000Z")
        self.assertEqual(repeated["id"], values["source"]["id"])
        self.assertEqual(repeated["request_id"], values["source"]["request_id"])
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_inputs").fetchone()[0], 1)

    def test_catalog_roles_are_not_arbitrary_strategy_metadata(self):
        values = fixture.create(self.db, "w", "synthetic-investor", admit=False)
        policy = deepcopy(values["policy"]); policy["roles"] = {"CN:ALPHA": "defensive", "CN:BETA": "growth"}
        with self.assertRaisesRegex(WorkbenchError, "ROLE_BINDING_INVALID"):
            admit_evidence_input(self.db, "w", "synthetic-investor", values["captures"], values["actions"], [], fixture.START, fixture.END,
                values["plan"], policy, now=queue.NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_inputs").fetchone()[0], 0)

    def test_confirmed_fixture_risk_creates_exploratory_plan_from_frozen_three_phases(self):
        self.save(profile("0.30")); self.create()
        self.assertEqual(self.calculate()["status"], "succeeded")
        result = json.loads(self.db.execute("SELECT document_json FROM investor_research_runs").fetchone()[0])
        self.assertEqual(result["result"]["status"], "reference_ready")
        self.assertEqual(result["registry"]["phases"], {"train": {"registered": 3, "completed": 3},
            "validation": {"registered": 1, "completed": 1}, "holdout": {"registered": 1, "completed": 1}})
        self.assertIsNotNone(result["registry"]["freeze_hash"])
        self.assertEqual(result["result"]["holdout_unseen_status"], "not_independently_verified")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_reference_plans").fetchone()[0], 1)
        plan = json.loads(self.db.execute("SELECT document_json FROM investor_reference_plans").fetchone()[0])
        self.assertEqual(plan["data_mode"], "reconstructed")
        self.assertEqual({row["listing_id"]: row["weight"] for row in plan["targets"]}, result["result"]["selected_parameters"]["weights"])
        self.assertEqual(plan["reference_evidence"]["result_hash"], result["result"]["result_hash"])
        self.assertFalse(plan["live_advice_eligible"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_models").fetchone()[0], 0)
        self.assert_no_finance()

    def test_expiry_and_withdrawal_are_normal_blocked_checks_not_default_quotes(self):
        self.save(); values = self.create()
        review_source(self.db, "w", "synthetic-investor", values["rights"]["source_id"], "withdrawn", None,
            "Fictional withdrawal", fixture.EXPIRY, now=queue.NOW)
        self.assertEqual(self.calculate()["status"], "succeeded")
        result = json.loads(self.db.execute("SELECT document_json FROM investor_research_runs").fetchone()[0])
        self.assertEqual(result["reason_codes"], ["REFERENCE_SOURCE_NO_LONGER_CURRENT"])
        self.assertIsNone(result["result"])
        later = values["source"]["valid_until"]
        self.save(profile("0.30")); enqueue_evidence_request(self.db, "w", values["source"], later)
        self.assertEqual(self.calculate(later)["status"], "succeeded")
        result = json.loads(self.db.execute("SELECT document_json FROM investor_research_runs ORDER BY rowid DESC").fetchone()[0])
        self.assertEqual(result["reason_codes"], ["REFERENCE_SOURCE_EXPIRED"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_trial_intents").fetchone()[0], 0)

    def test_source_change_during_backtest_preserves_intent_but_never_completed_result(self):
        self.save(); values = self.create()
        from worker.investor.trials import compare_backtest
        def changed(*args, **kwargs):
            review_source(self.db, "w", "synthetic-investor", values["rights"]["source_id"], "withdrawn", None,
                "Fictional mid-phase withdrawal", fixture.EXPIRY, now=queue.NOW)
            return compare_backtest(*args, **kwargs)
        with patch("worker.investor.trials.compare_backtest", side_effect=changed):
            with self.assertRaisesRegex(WorkbenchError, "INVESTOR_RESEARCH_PREPARATION_FAILED"):
                self.calculate()
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "retry_queued")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_trial_intents").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_trial_results").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_research_runs").fetchone()[0], 0)
        self.assert_no_finance()

    def test_withdrawal_after_preparation_skips_publication(self):
        self.save(); values = self.create(); sync_research_requests(self.db, now=queue.NOW)
        lease = claim_job(self.db, "fictional", 60, "investor_research", now=queue.NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs").fetchone())
        prepared = prepare_research_job(self.db, job, lease, clock=lambda: queue.NOW)
        review_source(self.db, "w", "synthetic-investor", values["rights"]["source_id"], "withdrawn", None,
            "Fictional precommit withdrawal", fixture.EXPIRY, now=queue.NOW)
        complete_job(self.db, lease, {}, effect=prepared["effect"], now=queue.NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "skipped")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_research_runs").fetchone()[0], 0)
        self.assert_no_finance()

    def test_reference_failure_rolls_back_run_plan_link_and_observation_but_keeps_trials(self):
        from worker.investor.reference_plan import persist_reference_plan
        self.save(profile("0.30")); self.create()
        def failed(*args, **kwargs):
            persist_reference_plan(*args, **kwargs)
            raise WorkbenchError("FICTIONAL_PUBLICATION_FAILURE")
        with patch("worker.investor.reference_plan.persist_reference_plan", side_effect=failed):
            with self.assertRaisesRegex(WorkbenchError, "INVESTOR_RESEARCH_PUBLICATION_FAILED"):
                self.calculate()
        for table in ("investor_research_runs", "investor_reference_plans", "investor_reference_evidence", "investor_observations"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0, table)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_trial_intents").fetchone()[0], 5)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_trial_results").fetchone()[0], 5)
        self.assert_no_finance()
