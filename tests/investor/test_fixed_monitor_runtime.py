"""Fictional receipt-to-state publication; no real provider or finance writes."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import test_data_pipeline as pipeline, test_runtime as queue
from tests.investor.test_monitor_data import NOW
from tests.investor import test_evidence_monitor_runtime as monitors
from worker.investor.monitor_admission import admit_monitor_data, current_monitor_model
from worker.investor.evidence_monitor_runtime import resolve_checkpoint
from worker.investor.model_contracts import definition_basis
from worker.orchestration.db import content_hash, canonical_json, WorkbenchError
from worker.orchestration.jobs import complete_job


class FixedMonitorRuntimeTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    save = queue.InvestorRuntimeTests.save
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance
    calculate = monitors.EvidenceMonitorRuntimeTests.calculate
    prepared = monitors.EvidenceMonitorRuntimeTests.prepared

    def seed(self, funding=False):
        definition, windows, settings, refs = pipeline.DataPipelineCliTests.monitor_fixture(self, fixed_policy=True)
        # The transport's old bands are not authority for the frozen v2 rule.
        settings["policy"].update(weight_band="0", absolute_band_cny="0")
        if funding: settings["funding_intent"] = {"id": "fictional-funding", "amount_cny": "1000", "expected_at": NOW}
        source = admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], windows, settings, now=NOW)
        self.definition, self.windows, self.settings = definition, windows, settings
        return definition, source, refs

    def test_new_reference_binds_frozen_parameters_and_uses_only_new_engine(self):
        definition, _, _ = self.seed()
        reference = json.loads(self.db.execute("SELECT document_json FROM investor_reference_plans").fetchone()[0])
        self.assertEqual(reference["schema_version"], "investor-reference-plan-v2")
        self.assertEqual(reference["fixed_policy"], definition["fixed_policy"])
        self.assertNotIn("尚不支持", reference["strategy_evidence"])
        row, payload = self.calculate()
        request = json.loads(self.db.execute("SELECT document_json FROM investor_evidence_monitor_requests").fetchone()[0])
        self.assertEqual(request["engine_version"], "investor-evidence-model-watcher-v3")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_requests").fetchone()[0], 0)
        self.assertEqual(payload["assessment"]["schema_version"], "investor-model-assessment-v2")
        state, reason = resolve_checkpoint(self.db, "w", definition, row["checkpoint_id"], NOW)
        self.assertIsNone(reason); self.assertEqual(state["schema_version"], "investor-evidence-model-checkpoint-v2")
        self.assertEqual(state["policy_state"], payload["assessment"]["next_policy_state"])
        self.assertEqual(payload["observation"]["monitoring"], "active")
        self.assert_no_finance()

    def test_polling_keeps_policy_anchor_and_sparse_checkpoint(self):
        definition, _, _ = self.seed(True)
        first, value = self.calculate()
        before, _ = resolve_checkpoint(self.db, "w", definition, first["checkpoint_id"], NOW)
        for at in ("2026-01-03T12:15:03.000Z", "2026-01-03T12:30:03.000Z"):
            later, repeated = self.calculate(at)
            after, reason = resolve_checkpoint(self.db, "w", definition, later["checkpoint_id"], at)
            self.assertIsNone(reason); self.assertEqual(after, before)
            self.assertEqual(later["checkpoint_id"], first["checkpoint_id"])
            self.assertEqual(repeated["assessment"]["reason_codes"], ["PLANNED_FUNDING_REVIEW_OPEN"])
            self.assertEqual(repeated["assessment"]["next_policy_state"], value["assessment"]["next_policy_state"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
        self.assert_no_finance()

    def test_new_funding_advances_only_policy_state_and_never_units_or_cash(self):
        definition, _, _ = self.seed()
        first, _ = self.calculate()
        before, _ = resolve_checkpoint(self.db, "w", definition, first["checkpoint_id"], NOW)
        self.settings["funding_intent"] = {"id": "new-funding", "amount_cny": "1000", "expected_at": NOW}
        admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], self.windows, self.settings, now=NOW)
        second, result = self.calculate()
        after, reason = resolve_checkpoint(self.db, "w", definition, second["checkpoint_id"], NOW)
        self.assertIsNone(reason); self.assertEqual(after["sequence"], 2)
        for key in ("quantities", "cash_by_currency", "initialized_at", "receivables", "processed_actions"):
            self.assertEqual(after[key], before[key])
        self.assertIsNotNone(after["policy_state"]["last_funding_hash"])
        self.assertEqual(result["assessment"]["outcome"], "decision_required")
        self.assert_no_finance()

    def test_unqualified_costs_publish_gap_without_consuming_policy_state(self):
        definition, _, _ = self.seed()
        first, _ = self.calculate()
        before, _ = resolve_checkpoint(self.db, "w", definition, first["checkpoint_id"], NOW)
        self.settings["funding_intent"] = {"id": "fund-without-cost", "amount_cny": "1000", "expected_at": NOW}
        self.settings["policy"]["costs"] = None
        admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], self.windows, self.settings, now=NOW)
        second, value = self.calculate()
        self.assertEqual(second["status"], "blocked"); self.assertIsNone(second["checkpoint_id"])
        self.assertEqual(value["assessment"]["next_policy_state"], before["policy_state"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
        self.assert_no_finance()

    def test_pause_fences_prepared_new_policy_checkpoint_and_outbox(self):
        self.seed(True)
        job, lease, prepared = self.prepared()
        self.db.execute("INSERT INTO investor_model_controls SELECT 'pause-fixed',workspace_id,model_id,version+1,0,actor_id,audit_id,? FROM investor_model_controls", (NOW,))
        complete_job(self.db, lease, {}, effect=prepared["effect"], now=NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (job["id"],)).fetchone()[0], "skipped")
        for table in ("investor_evidence_model_checkpoints", "investor_evidence_monitor_runs", "outbox"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
        self.assert_no_finance()

    def test_resealed_model_rule_is_not_the_verified_reference(self):
        definition, _, _ = self.seed()
        altered = deepcopy(definition); altered["fixed_policy"]["parameters"]["minimum_days_between_rebalances"] = 1
        altered["target_definition_hash"] = content_hash(definition_basis(altered))
        self.db.execute("DROP TRIGGER investor_model_no_update")
        self.db.execute("UPDATE investor_models SET document_json=?,content_hash=?", (canonical_json(altered), content_hash(altered)))
        with self.assertRaisesRegex(WorkbenchError, "MODEL_NOT_CURRENT"):
            current_monitor_model(self.db, "w", definition["model_id"], NOW)
        self.assert_no_finance()

    def test_rule_checkpoint_and_watcher_versions_cannot_be_mixed(self):
        definition, _, _ = self.seed()
        _, _, prepared = self.prepared()
        self.db.execute("DROP TRIGGER investor_evidence_request_no_update")
        request = self.db.execute("SELECT * FROM investor_evidence_monitor_requests").fetchone()
        value = json.loads(request["document_json"]); value["engine_version"] = "investor-evidence-model-watcher-v2"
        self.db.execute("UPDATE investor_evidence_monitor_requests SET document_json=?,input_version=?", (canonical_json(value), content_hash(value)))
        # The prepared effect independently rebinds and refuses mixed versions.
        with self.assertRaisesRegex(WorkbenchError, "PUBLICATION_FAILED"): prepared["effect"](self.db)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 0)
        self.assert_no_finance()


if __name__ == "__main__": unittest.main()
