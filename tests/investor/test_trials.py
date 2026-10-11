"""Persistent exploration audit, retries, exposure and cooperative lease renewal."""

from datetime import timedelta
import json
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as queue
from tests.investor.fixtures import profile
from worker.investor.runtime import prepare_research_job, sync_research_requests
from worker.investor.trials import TrialRecorder
from worker.orchestration.db import WorkbenchError, content_hash, instant
from worker.orchestration.jobs import assert_lease, claim_job, complete_job, fail_job


class InvestorTrialTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    save = queue.InvestorRuntimeTests.save
    request = queue.InvestorRuntimeTests.request
    synthetic = queue.InvestorRuntimeTests.synthetic
    calculate = queue.InvestorRuntimeTests.calculate
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def start(self, preferences=None):
        self.save(preferences or profile("0.30")); self.synthetic(); self.request()
        sync_research_requests(self.db, now=queue.NOW)
        lease = claim_job(self.db, "trial-worker", 60, "investor_research", now=queue.NOW)
        return dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()), lease

    def document(self):
        return json.loads(self.db.execute("SELECT document_json FROM investor_research_runs ORDER BY rowid DESC LIMIT 1").fetchone()[0])

    def test_unknown_risk_registers_train_only_without_freeze_or_holdout_exposure(self):
        self.save(); self.synthetic(); self.request(); self.calculate()
        receipt = self.document()["registry"]
        self.assertEqual(receipt["phases"], {"train": {"registered": 3, "completed": 3}, "validation": {"registered": 0, "completed": 0}, "holdout": {"registered": 0, "completed": 0}})
        self.assertIsNone(receipt["freeze_hash"])
        self.assertEqual(receipt["holdout_status"], "not_independently_verified")
        self.assert_no_finance()

    def test_candidate_freezes_all_train_receipts_before_validation_and_holdout(self):
        self.save(profile("0.30")); self.synthetic(); self.request(); self.calculate()
        document = self.document()
        self.assertEqual(document["result"]["status"], "reference_ready")
        self.assertEqual(document["registry"]["phases"]["holdout"], {"registered": 1, "completed": 1})
        frozen = self.db.execute("SELECT * FROM investor_candidate_freezes").fetchone()
        proof = json.loads(frozen["evidence_json"])
        self.assertEqual(proof["parameters_hash"], content_hash(document["result"]["selected_parameters"]))
        self.assertEqual(len(proof["train_result_hashes"]), 3)
        phases = self.db.execute("SELECT phase,parameters_hash FROM investor_trial_intents ORDER BY rowid").fetchall()
        self.assertEqual([row["phase"] for row in phases], ["train", "train", "train", "validation", "holdout"])
        self.assertTrue(all(row["parameters_hash"] == frozen["parameters_hash"] for row in phases[3:]))
        self.assert_no_finance()

    def test_crash_after_opening_holdout_keeps_intent_and_retry_reuses_completed_trials(self):
        job, lease = self.start()
        from worker.investor.trials import compare_backtest as original
        def crash(dataset, plan, parameters, phase, **kwargs):
            if phase == "holdout":
                raise ValueError("Private crash fixture")
            return original(dataset, plan, parameters, phase, **kwargs)
        with patch("worker.investor.trials.compare_backtest", side_effect=crash):
            with self.assertRaisesRegex(WorkbenchError, "^INVESTOR_RESEARCH_PREPARATION_FAILED$"):
                prepare_research_job(self.db, job, lease, clock=lambda: queue.NOW, allow_synthetic=True)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_trial_intents").fetchone()[0], 5)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_trial_results").fetchone()[0], 4)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_research_runs").fetchone()[0], 0)
        fail_job(self.db, lease, {"code": "SYNTHETIC_CRASH"}, retry_delay_seconds=0, now=queue.NOW)
        retry = claim_job(self.db, "retry", 60, "investor_research", now=queue.NOW)
        retry_job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (retry.job_id,)).fetchone())
        with patch("worker.investor.trials.compare_backtest", wraps=original) as replay:
            prepared = prepare_research_job(self.db, retry_job, retry, clock=lambda: queue.NOW, allow_synthetic=True)
        self.assertEqual(replay.call_count, 1)
        self.assertEqual(replay.call_args.args[3], "holdout")
        complete_job(self.db, retry, {}, effect=prepared["effect"], now=queue.NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_experiments").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_trial_intents").fetchone()[0], 5)
        self.assertEqual(self.document()["registry"]["holdout_status"], "not_independently_verified")
        self.assert_no_finance()

    def test_cosmetic_dataset_or_policy_changes_do_not_reset_overlapping_exposure(self):
        self.save(profile("0.30")); self.synthetic(); self.request(); self.calculate()
        self.synthetic(lambda data, plan, policy: policy.update(version="same-economics-new-label"))
        self.request(); self.calculate()
        receipt = self.document()["registry"]
        self.assertEqual(receipt["prior_window_exposures"], 1)
        self.assertEqual(receipt["holdout_status"], "previously_exposed")
        self.assertEqual(self.document()["result"]["holdout_unseen_status"], "not_independently_verified")
        self.assertFalse(self.document()["result"]["live_advice_eligible"])

    def test_failed_attempt_is_counted_as_exposure_by_next_experiment(self):
        job, lease = self.start()
        from worker.investor.trials import compare_backtest as original
        def crash(dataset, plan, parameters, phase, **kwargs):
            if phase == "holdout": raise RuntimeError("Synthetic failure")
            return original(dataset, plan, parameters, phase, **kwargs)
        with patch("worker.investor.trials.compare_backtest", side_effect=crash):
            with self.assertRaises(WorkbenchError): prepare_research_job(self.db, job, lease, clock=lambda: queue.NOW, allow_synthetic=True)
        fail_job(self.db, lease, {"code": "TEST"}, retryable=False, now=queue.NOW)
        self.synthetic(lambda data, plan, policy: policy.update(version="after-failed-holdout"))
        self.request(); self.calculate()
        self.assertEqual(self.document()["registry"]["prior_window_exposures"], 1)

    def test_heartbeat_allows_cooperative_calculation_longer_than_original_lease(self):
        job, lease = self.start()
        moment = [instant(queue.NOW)]
        clock = lambda: moment[0].isoformat(timespec="milliseconds").replace("+00:00", "Z")
        from worker.investor.trials import compare_backtest as original
        def slow(dataset, plan, parameters, phase, **kwargs):
            for _ in range(5):
                moment[0] += timedelta(seconds=20)
                kwargs["progress"]()
                assert_lease(self.db, lease, now=clock())
            return original(dataset, plan, parameters, phase, **kwargs)
        with patch("worker.investor.trials.compare_backtest", side_effect=slow):
            prepared = prepare_research_job(self.db, job, lease, clock=clock, allow_synthetic=True)
        self.assertGreater((moment[0] - instant(queue.NOW)).total_seconds(), 60)
        complete_job(self.db, lease, {}, effect=prepared["effect"], now=clock(), clock=clock)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "succeeded")
        self.assert_no_finance()

    def test_expired_lease_or_stop_cannot_publish_trial_receipt(self):
        job, lease = self.start()
        moment = [queue.NOW]
        from worker.investor.trials import compare_backtest as original
        def expired(dataset, plan, parameters, phase, **kwargs):
            moment[0] = "2026-01-02T12:02:03.000Z"
            kwargs["progress"]()
            return original(dataset, plan, parameters, phase, **kwargs)
        with patch("worker.investor.trials.compare_backtest", side_effect=expired):
            with self.assertRaisesRegex(WorkbenchError, "PREPARATION_FAILED"):
                prepare_research_job(self.db, job, lease, clock=lambda: moment[0], allow_synthetic=True)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_trial_intents").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_trial_results").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_research_runs").fetchone()[0], 0)

    def test_registry_rows_cannot_update_delete_or_replace(self):
        self.save(profile("0.30")); self.synthetic(); self.request(); self.calculate()
        for table in ("investor_experiments", "investor_trial_intents", "investor_trial_results", "investor_candidate_freezes"):
            with self.subTest(table=table):
                with self.assertRaisesRegex(Exception, "immutable"): self.db.execute("UPDATE " + table + " SET created_at=?", (queue.NOW,))
                with self.assertRaisesRegex(Exception, "immutable"): self.db.execute("DELETE FROM " + table)
                row = dict(self.db.execute("SELECT * FROM " + table).fetchone())
                with self.assertRaises(Exception): self.db.execute("INSERT OR REPLACE INTO " + table + "(" + ",".join(row) + ") VALUES(" + ",".join("?" for _ in row) + ")", tuple(row.values()))

    def test_sql_budget_and_candidate_freeze_gate_reject_extra_or_unregistered_trials(self):
        self.save(profile("0.30")); self.synthetic(); self.request(); self.calculate()
        row = dict(self.db.execute("SELECT * FROM investor_trial_intents WHERE phase='holdout'").fetchone())
        row["id"], row["parameters_hash"] = "rogue-trial", "a" * 64
        with self.assertRaisesRegex(Exception, "binding or budget"):
            self.db.execute("INSERT INTO investor_trial_intents(" + ",".join(row) + ") VALUES(" + ",".join("?" for _ in row) + ")", tuple(row.values()))

    def test_production_missing_or_synthetic_disabled_does_not_register_experiments(self):
        self.save(); self.request(); self.calculate(False)
        self.synthetic(); self.request(); self.calculate(False)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_experiments").fetchone()[0], 0)
        self.assertIsNone(self.document()["registry"])
