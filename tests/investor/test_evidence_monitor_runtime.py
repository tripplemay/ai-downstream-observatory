"""Default core monitoring using only fictional, receipt-backed fixtures."""

import json
import unittest
from unittest.mock import patch

from tests.investor import test_data_pipeline as pipeline, test_runtime as queue
from tests.investor.test_monitor_data import NOW
from worker.investor.monitor_admission import admit_monitor_data
from worker.investor.evidence_monitor_runtime import discover_evidence_monitor_requests, prepare_evidence_monitor_job, resolve_checkpoint, purge_monitor_payload
from worker.investor.data_evidence import review_source
from worker.orchestration.jobs import claim_job, complete_job
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash
from worker.orchestration.runtime import run_pending_once


class EvidenceMonitorRuntimeTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    monitor_fixture = pipeline.DataPipelineCliTests.monitor_fixture
    save = queue.InvestorRuntimeTests.save
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def seed(self, funding=False):
        definition, windows, settings, refs = self.monitor_fixture()
        if funding:
            settings["funding_intent"] = {"id": "fictional-funding", "amount_cny": "1000", "expected_at": NOW}
        source = admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], windows, settings, now=NOW)
        self.windows, self.settings = windows, settings
        return definition, source, refs

    def calculate(self, at=NOW):
        value = run_pending_once(self.db, "qualified-fictional", clock=lambda: at)
        self.assertEqual(value["status"], "succeeded", value)
        row = self.db.execute("SELECT * FROM investor_evidence_monitor_runs ORDER BY rowid DESC LIMIT 1").fetchone()
        self.assertIsNotNone(row)
        return row, json.loads(self.db.execute("SELECT payload FROM investor_evidence_run_payloads WHERE run_id=?", (row["id"],)).fetchone()[0])

    def test_default_core_publishes_replayable_observation_without_financial_writes(self):
        definition, _, _ = self.seed()
        row, value = self.calculate()
        self.assertEqual(row["status"], "observe")
        state, reason = resolve_checkpoint(self.db, "w", definition, row["checkpoint_id"], NOW)
        self.assertIsNone(reason); self.assertEqual(state["sequence"], 1)
        self.assertEqual(value["assessment"]["model_nav_cny"], "10000")
        self.assertEqual(value["observation"]["monitoring"], "active")
        ref = json.loads(self.db.execute("SELECT document_json FROM investor_observations WHERE id=?", (row["observation_id"],)).fetchone()[0])
        self.assertEqual(ref["schema_version"], "investor-model-observation-ref-v1")
        for metadata in (json.loads(row["document_json"]), ref):
            for key in ("quotes", "fx", "quantities", "model_nav_cny", "assessment", "observation"):
                self.assertNotIn(key, metadata)
        self.assertIsNone(run_pending_once(self.db, "qualified-fictional", clock=lambda: NOW))
        self.assert_no_finance()

    def test_due_funding_produces_decision_but_never_changes_model_units_or_cash(self):
        definition, _, _ = self.seed(True)
        row, value = self.calculate()
        self.assertEqual(row["status"], "decision_required")
        self.assertIn("NEW_PLANNED_FUNDING", value["assessment"]["reason_codes"])
        self.assertEqual(value["assessment"]["allocation_method"], "contribution_repair_without_sales")
        state, reason = resolve_checkpoint(self.db, "w", definition, row["checkpoint_id"], NOW)
        self.assertIsNone(reason)
        self.assertLess(float(state["cash_by_currency"]["CNY"]), .01)
        self.assertEqual(value["assessment"]["model_nav_cny"], "10000")
        self.assert_no_finance()

    def test_periodic_recheck_reuses_state_without_extending_its_receipt_lifetime(self):
        definition, _, _ = self.seed()
        first, _ = self.calculate()
        before, _ = resolve_checkpoint(self.db, "w", definition, first["checkpoint_id"], NOW)
        later = "2026-01-03T12:15:03.000Z"
        second, _ = self.calculate(later)
        after, reason = resolve_checkpoint(self.db, "w", definition, second["checkpoint_id"], later)
        self.assertIsNone(reason); self.assertEqual(after, before)
        self.assertEqual(second["checkpoint_id"], first["checkpoint_id"])
        self.assertEqual(second["valid_until"], first["valid_until"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_monitor_runs").fetchone()[0], 2)
        self.assertEqual(second["created_at"], later)
        self.assert_no_finance()

    def test_new_funding_input_reuses_units_but_recomputes_current_cost_and_decision(self):
        definition, _, _ = self.seed()
        first, _ = self.calculate()
        before, _ = resolve_checkpoint(self.db, "w", definition, first["checkpoint_id"], NOW)
        self.settings["funding_intent"] = {"id": "funding-after-observation", "amount_cny": "1000", "expected_at": NOW}
        source = admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], self.windows, self.settings, now=NOW)
        second, value = self.calculate()
        self.assertEqual(second["status"], "decision_required")
        self.assertEqual(second["checkpoint_id"], first["checkpoint_id"])
        self.assertGreater(float(value["assessment"]["estimated_cost_cny"]), 0)
        self.assertEqual(json.loads(second["document_json"])["checkpoint_hash"], content_hash(before))
        self.assertEqual(json.loads(second["document_json"])["projection_hash"], json.loads(source["document_json"])["projection_hash"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
        self.assert_no_finance()

    def test_legacy_full_step_requests_remain_replayable_before_sparse_upgrade(self):
        definition, _, _ = self.seed()
        with patch("worker.investor.evidence_monitor_runtime.ENGINE_VERSION", "investor-evidence-model-watcher-v1"):
            self.calculate()
            second, _ = self.calculate("2026-01-03T12:15:03.000Z")
        before, reason = resolve_checkpoint(self.db, "w", definition, second["checkpoint_id"], "2026-01-03T12:15:03.000Z")
        self.assertIsNone(reason); self.assertEqual(before["sequence"], 2)
        third, _ = self.calculate("2026-01-03T12:15:03.000Z")
        self.assertEqual(third["checkpoint_id"], second["checkpoint_id"])
        after, reason = resolve_checkpoint(self.db, "w", definition, third["checkpoint_id"], "2026-01-03T12:15:03.000Z")
        self.assertIsNone(reason); self.assertEqual(after, before)
        self.assert_no_finance()

    def test_sixteen_qualified_poll_windows_do_not_inflate_the_state_chain(self):
        self.seed()
        for offset in range(16):
            at = f"2026-01-03T{12 + offset // 4:02d}:{offset % 4 * 15:02d}:03.000Z"
            row, value = self.calculate(at)
            self.assertEqual(row["status"], "observe")
            self.assertEqual(value["observation"]["evaluated_at"], at)
            self.assertIsNone(run_pending_once(self.db, "qualified-fictional", clock=lambda: at))
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_monitor_requests").fetchone()[0], 16)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_monitor_runs").fetchone()[0], 16)
        self.assertEqual(self.db.execute("SELECT count(DISTINCT checkpoint_id) FROM investor_evidence_monitor_runs").fetchone()[0], 1)
        self.assert_no_finance()

    def test_derivative_payload_requires_due_owner_audited_purge_and_cannot_be_restored(self):
        definition, _, _ = self.seed()
        row, _ = self.calculate()
        with self.assertRaisesRegex(WorkbenchError, "PURGE_NOT_DUE"):
            purge_monitor_payload(self.db, "w", "synthetic-investor", "run", row["id"], now=NOW)
        for sql in ("UPDATE investor_evidence_monitor_runs SET content_hash='x'", "DELETE FROM investor_evidence_model_checkpoints",
                    "DELETE FROM investor_evidence_run_payloads", "UPDATE investor_evidence_checkpoint_payloads SET payload=x'7b7d'"):
            with self.assertRaises(Exception): self.db.execute(sql)
        expiry = row["valid_until"]
        purge_monitor_payload(self.db, "w", "synthetic-investor", "run", row["id"], now=expiry)
        self.assertIsNone(self.db.execute("SELECT payload FROM investor_evidence_run_payloads WHERE run_id=?", (row["id"],)).fetchone())
        with self.assertRaises(Exception): self.db.execute("INSERT INTO investor_evidence_run_payloads VALUES(?,?)", (row["id"], b"{}"))
        purge_monitor_payload(self.db, "w", "synthetic-investor", "checkpoint", row["checkpoint_id"], now=expiry)
        state, reason = resolve_checkpoint(self.db, "w", definition, row["checkpoint_id"], expiry)
        self.assertIsNone(state); self.assertEqual(reason, "MONITOR_CHECKPOINT_SOURCE_EXPIRED")
        self.assert_no_finance()

    def prepared(self, seconds=60):
        discover_evidence_monitor_requests(self.db, now=NOW)
        lease = claim_job(self.db, "qualified-prepare", seconds, "investor_evidence_monitor", now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        return job, lease, prepare_evidence_monitor_job(self.db, job, lease, clock=lambda: NOW)

    def test_pause_profile_source_and_implementation_change_fence_prepared_results(self):
        for change in ("pause", "profile", "input", "implementation"):
            with self.subTest(change=change):
                if change != "pause": self.db.close(); self.doCleanups(); self.setUp()
                definition, _, _ = self.seed()
                job, lease, prepared = self.prepared()
                if change == "pause":
                    self.db.execute("INSERT INTO investor_model_controls VALUES('pause','w',?,2,0,'synthetic-investor','monitor-select-audit',?)", (definition["model_id"], NOW))
                if change == "profile": self.save()
                if change == "input":
                    self.settings["funding_intent"] = {"id": "new-fictional", "amount_cny": "1000", "expected_at": NOW}
                    admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], self.windows, self.settings, now=NOW)
                with patch("worker.investor.evidence_monitor_runtime.implementation_hash", return_value="0" * 64) if change == "implementation" else patch.dict({}, {}):
                    complete_job(self.db, lease, {}, effect=prepared["effect"], now=NOW)
                self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (job["id"],)).fetchone()[0], "skipped")
                for table in ("investor_evidence_monitor_runs", "investor_evidence_model_checkpoints", "investor_evidence_run_payloads", "investor_evidence_checkpoint_payloads"):
                    self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
                self.assert_no_finance()

    def test_source_withdrawal_publishes_gap_without_reusing_old_valuation(self):
        _, _, refs = self.seed()
        self.calculate()
        rights = refs[0]["rights"]
        later = "2026-01-03T12:15:03.000Z"
        review_source(self.db, "w", "synthetic-investor", rights["source_id"], "withdrawn", None, "Fictional withdrawal", rights["valid_until"], now=later)
        row, result = self.calculate(later)
        self.assertEqual(row["status"], "blocked"); self.assertIsNone(row["checkpoint_id"])
        self.assertIsNone(result["assessment"]); self.assertNotIn("model_change", result["observation"])
        self.assertEqual(result["observation"]["gaps"][0]["code"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.assertIsNone(run_pending_once(self.db, "qualified-fictional", clock=lambda: "2026-01-03T12:30:03.000Z"))
        self.assert_no_finance()

    def test_stale_lease_and_post_write_restore_lock_roll_back_all_derivatives(self):
        self.seed()
        _, old, prepared = self.prepared(1)
        later = "2026-01-03T12:00:05.000Z"
        winner = claim_job(self.db, "qualified-winner", 60, "investor_evidence_monitor", now=later)
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            complete_job(self.db, old, {}, effect=prepared["effect"], now=later)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (winner.job_id,)).fetchone())
        ready = prepare_evidence_monitor_job(self.db, job, winner, clock=lambda: later)
        before = self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0]
        observations = self.db.execute("SELECT count(*) FROM investor_observations").fetchone()[0]
        def locked(connection):
            result = ready["effect"](connection)
            (self.path.parent / "RESTORE_PENDING_REVIEW").write_text("Fictional restore lock")
            return result
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            complete_job(self.db, winner, {}, effect=locked, now=later)
        for table in ("investor_evidence_monitor_runs", "investor_evidence_model_checkpoints", "investor_evidence_run_payloads", "investor_evidence_checkpoint_payloads"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_observations").fetchone()[0], observations)
        self.assert_no_finance()


if __name__ == "__main__": unittest.main()
