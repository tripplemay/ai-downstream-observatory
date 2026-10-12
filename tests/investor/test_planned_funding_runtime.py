"""Default core funding integration with invented receipts, no real transport."""

import json
import sqlite3
import unittest

from tests.investor import test_data_pipeline as pipeline, test_runtime as queue, test_evidence_monitor_runtime as monitors
from tests.investor.test_monitor_data import NOW
from worker.investor.evidence_monitor_runtime import _binding, discover_evidence_monitor_requests, prepare_evidence_monitor_job, resolve_checkpoint
from worker.investor.model_state import advance_evidence_model
from worker.investor.monitor_admission import admit_monitor_data
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, transaction
from worker.orchestration.jobs import claim_job, complete_job


DUE = "2026-01-03T16:00:00.000Z"


class PlannedFundingRuntimeTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    save = queue.InvestorRuntimeTests.save
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance
    calculate = monitors.EvidenceMonitorRuntimeTests.calculate
    prepared = monitors.EvidenceMonitorRuntimeTests.prepared

    def seed(self, fixed=True, conflict=False, costs=True):
        definition, windows, settings, _ = pipeline.DataPipelineCliTests.monitor_fixture(self, fixed_policy=fixed, extra_closed_day=True)
        if conflict: settings["funding_intent"] = {"id": "another-intent", "amount_cny": "1000", "expected_at": NOW}
        if not costs: settings["policy"]["costs"] = None
        admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], windows, settings, now=NOW)
        self.definition = definition
        self.plan = {"schema_version": "investor-funding-plan-v1", "start_date": "2026-01-02", "horizon_years": 1,
            "evaluation_timezone": "Asia/Shanghai", "initial_capital_cny": "100.01", "annual_contribution_cny": "10.01",
            "first_annual_date": "2026-01-04", "entry_method": "three_tranches_60_days", "actual_arrivals_confirmed": False,
            "execution_authorized": False, "live_advice_eligible": False}
        return definition

    def funding(self, at=NOW):
        with transaction(self.db):
            version = self.db.execute("SELECT count(*) FROM investor_funding_plans").fetchone()[0] + 1
            identifier, audit_id = "funding:" + str(version), "funding-audit:" + str(version)
            revision = self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
            result = {"funding_plan_id": identifier, "version": version, "profile_id": self.definition["profile_id"],
                "profile_hash": self.definition["profile_hash"], "actual_arrivals_confirmed": False, "execution_authorized": False}
            command = {"action": "save_funding_plan", "expected_revision": revision, "idempotency_key": identifier, "funding_plan": self.plan}
            self.db.execute("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,'synthetic-investor','investor_save_funding_plan','investor_workspace','w',?,?)",
                (audit_id, canonical_json({"input": command, "result": result}), at))
            self.db.execute("INSERT INTO investor_funding_plans(id,workspace_id,profile_id,version,profile_hash,document_json,content_hash,actor_id,created_at,audit_id) VALUES(?,'w',?,?,?,?,?,'synthetic-investor',?,?)",
                (identifier, self.definition["profile_id"], version, self.definition["profile_hash"], canonical_json(self.plan), content_hash(self.plan), at, audit_id))
            self.db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id='w'")
        return identifier

    def state(self, run, at):
        checkpoint, reason = resolve_checkpoint(self.db, "w", self.definition, run["checkpoint_id"], at)
        self.assertIsNone(reason)
        return checkpoint

    def test_future_to_due_uses_default_core_and_never_deposits_or_applies_proposals(self):
        self.seed(False); self.funding()
        first, initial = self.calculate()
        before = self.state(first, NOW)
        self.assertEqual(initial["assessment"]["funding_status"], "not_due")
        second, value = self.calculate(DUE)
        after = self.state(second, DUE)
        self.assertEqual(value["assessment"]["funding_status"], "hypothetical_due")
        self.assertEqual(value["assessment"]["outcome"], "decision_required")
        self.assertEqual(after["schema_version"], "investor-evidence-model-checkpoint-v3")
        self.assertEqual(value["assessment"]["model_nav_cny"], "10000")
        self.assertEqual(before, after)
        self.assert_no_finance()

    def test_fixed_due_reuses_sparse_policy_state_and_keeps_open_review_without_execution(self):
        self.seed(); self.funding()
        first, initial = self.calculate()
        before = self.state(first, NOW)
        second, due = self.calculate(DUE)
        after = self.state(second, DUE)
        self.assertEqual(after["sequence"], 2)
        for key in ("quantities", "cash_by_currency", "initialized_at", "receivables", "processed_actions"):
            self.assertEqual(after[key], before[key])
        repeated, value = self.calculate("2026-01-03T16:15:03.000Z")
        self.assertEqual(repeated["checkpoint_id"], second["checkpoint_id"])
        self.assertEqual(value["assessment"]["reason_codes"], ["PLANNED_FUNDING_REVIEW_OPEN"])
        self.assertEqual(value["assessment"]["next_policy_state"], due["assessment"]["next_policy_state"])
        request = json.loads(self.db.execute("SELECT document_json FROM investor_evidence_monitor_requests ORDER BY rowid DESC LIMIT 1").fetchone()[0])
        self.assertEqual(request["engine_version"], "investor-evidence-model-watcher-v4")
        self.assert_no_finance()

    def test_plan_version_changed_during_prepare_skips_old_atomic_publication(self):
        self.seed(); self.funding()
        job, lease, prepared = self.prepared()
        self.funding()
        complete_job(self.db, lease, {}, effect=prepared["effect"], now=NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (job["id"],)).fetchone()[0], "skipped")
        for table in ("investor_evidence_monitor_runs", "investor_evidence_model_checkpoints", "outbox"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
        self.calculate(); self.assert_no_finance()

    def test_exact_release_boundary_fences_old_prepared_result_and_next_check(self):
        self.seed(); self.funding()
        at = "2026-01-03T15:59:59.999Z"
        discover_evidence_monitor_requests(self.db, now=at)
        lease = claim_job(self.db, "funding-boundary", 60, "investor_evidence_monitor", now=at)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        times = iter((at, DUE))
        prepared = prepare_evidence_monitor_job(self.db, job, lease, clock=lambda: next(times))
        complete_job(self.db, lease, {}, effect=prepared["effect"], now=DUE)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (job["id"],)).fetchone()[0], "skipped")
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox").fetchone()[0], 0)
        _, due = self.calculate(DUE); self.assertEqual(due["assessment"]["funding_status"], "hypothetical_due")
        self.assert_no_finance()

    def test_later_plan_does_not_rewrite_existing_checkpoint_lineage(self):
        self.seed(); self.funding()
        first, _ = self.calculate(DUE)
        before = self.state(first, DUE)
        self.funding("2026-01-03T16:01:00.000Z")
        second, value = self.calculate("2026-01-03T16:01:00.000Z")
        after = self.state(second, "2026-01-03T16:01:00.000Z")
        self.assertEqual(self.state(first, "2026-01-03T16:01:00.000Z"), before)
        self.assertNotEqual(after["funding_binding"], before["funding_binding"])
        self.assertEqual(value["assessment"]["funding_status"], "not_due")
        self.assertEqual(after["quantities"], before["quantities"]); self.assertEqual(after["cash_by_currency"], before["cash_by_currency"])
        self.assert_no_finance()

    def test_conflicting_intents_publish_specific_gap_not_double_budget(self):
        self.seed(conflict=True); self.funding()
        row, value = self.calculate()
        self.assertEqual(row["status"], "blocked"); self.assertIsNone(row["checkpoint_id"])
        self.assertEqual(value["observation"]["gaps"][0]["code"], "MONITOR_FUNDING_INTENTS_CONFLICT")
        self.assert_no_finance()

    def test_unknown_costs_cannot_publish_funding_policy_checkpoint(self):
        self.seed(costs=False); self.funding()
        row, value = self.calculate(DUE)
        self.assertEqual(row["status"], "blocked"); self.assertIsNone(row["checkpoint_id"])
        self.assertIn("CANNOT_COMPARE_CHANGE_COST", value["assessment"]["reason_codes"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 0)
        self.assert_no_finance()

    def test_old_checkpoint_promotes_once_when_first_private_plan_is_saved(self):
        self.seed()
        first, _ = self.calculate()
        before = self.state(first, NOW)
        self.assertEqual(before["schema_version"], "investor-evidence-model-checkpoint-v2")
        self.funding()
        second, _ = self.calculate()
        after = self.state(second, NOW)
        self.assertEqual(after["schema_version"], "investor-evidence-model-checkpoint-v3")
        self.assertEqual(after["sequence"], 2)
        self.assertEqual(self.state(first, NOW), before)
        self.assertEqual(after["quantities"], before["quantities"]); self.assertEqual(after["cash_by_currency"], before["cash_by_currency"])
        self.assert_no_finance()

    def test_plan_window_expiry_publishes_gap_and_deduplicates_waiting_for_new_plan(self):
        self.seed()
        self.plan.update(start_date="2025-01-04", annual_contribution_cny="0", first_annual_date=None)
        self.funding()
        first, _ = self.calculate()
        before = self.state(first, NOW)
        row, value = self.calculate(DUE)
        self.assertEqual(row["status"], "blocked"); self.assertIsNone(row["checkpoint_id"])
        self.assertEqual(value["observation"]["gaps"][0]["code"], "MONITOR_FUNDING_PLAN_WINDOW_EXPIRED")
        count = self.db.execute("SELECT count(*) FROM investor_evidence_monitor_requests").fetchone()[0]
        self.assertEqual(discover_evidence_monitor_requests(self.db, now="2026-01-03T16:15:03.000Z"), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_monitor_requests").fetchone()[0], count)
        self.assertEqual(self.state(first, DUE), before); self.assert_no_finance()

    def test_sql_rejects_downgraded_or_unbound_funding_checkpoint_payload(self):
        self.seed(); self.funding()
        job, lease, prepared = self.prepared()
        values = _binding(self.db, job, NOW)
        result = advance_evidence_model(self.definition, values[3], values[4], NOW,
            input_hash=values[2]["content_hash"], sparse=True, planned_funding=values[9]["request"])
        value = result["checkpoint"]
        with self.assertRaisesRegex(WorkbenchError, "FIXTURE_ROLLBACK"):
            with transaction(self.db):
                self.db.execute("INSERT INTO investor_evidence_model_checkpoints VALUES('sql-funding-checkpoint','w',?,?,1,NULL,?,?,?,?)",
                    (self.definition["model_id"], values[2]["id"], content_hash(value), value["projection_hash"], NOW, values[8]))
                downgraded = {key: item for key, item in value.items() if key != "funding_binding"}
                downgraded["schema_version"] = "investor-evidence-model-checkpoint-v2"
                changed = {**value, "funding_binding": {**value["funding_binding"], "funding_plan_id": "other-plan"}}
                for bad in (downgraded, changed):
                    with self.assertRaisesRegex(sqlite3.IntegrityError, "planned funding checkpoint"):
                        self.db.execute("INSERT INTO investor_evidence_checkpoint_payloads VALUES('sql-funding-checkpoint',?)", (canonical_json(bad).encode(),))
                self.db.execute("INSERT INTO investor_evidence_checkpoint_payloads VALUES('sql-funding-checkpoint',?)", (canonical_json(value).encode(),))
                raise WorkbenchError("FIXTURE_ROLLBACK")
        complete_job(self.db, lease, {}, effect=prepared["effect"], now=NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (job["id"],)).fetchone()[0], "succeeded")
        self.assert_no_finance()


if __name__ == "__main__": unittest.main()
