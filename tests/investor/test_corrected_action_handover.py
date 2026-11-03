"""Explicit fictional source handover through default core, never a new checkpoint."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import test_correction_consent as fixture, test_runtime as runtime
from worker.investor import action_review_jobs as jobs, action_review_workflow as review, corrected_action_handover as handover
from worker.investor import corrected_action_source as corrected, data_evidence, eodhd_sources, managed_actions
from worker.orchestration.db import WorkbenchError, content_hash, open_database
from worker.orchestration.jobs import claim_job, complete_job
from worker.orchestration.runtime import run_pending_once


OWNER = "synthetic-investor"
PREVIEW = "2026-11-07T06:00:05.000Z"
AT = "2026-11-07T06:00:05.002Z"


class CorrectedActionHandoverTests(unittest.TestCase):
    setUp = runtime.InvestorRuntimeTests.setUp
    assert_no_finance = runtime.InvestorRuntimeTests.assert_no_finance
    seed = fixture.CorrectionConsentTests.seed
    enqueue = fixture.CorrectionConsentTests.enqueue
    finish = fixture.CorrectionConsentTests.finish

    def prepared(self, *, enable=False):
        self.seed(); result = self.finish(self.enqueue()); self.assertEqual(result["outcome"], "confirmed")
        self.correction = self.db.execute("SELECT * FROM investor_correction_consents WHERE id=?", (result["confirmation_id"],)).fetchone()
        revision = self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
        self.preview = review.register_action_review_preview(self.db, "w", OWNER, {"authority_id": self.value["authority_id"], "expected_revision": revision,
            "idempotency_key": "fictional-fresh-handover-source-preview"}, now=PREVIEW, owner_interaction=True)
        self.handover_body = {"schema_version": handover.SUBMIT, "preview_id": self.preview["preview_id"], "correction_id": self.correction["id"],
            "expected_correction_hash": self.correction["content_hash"], "expected_revision": self.preview["workspace_revision"],
            "idempotency_key": "fictional-corrected-source-handover", "enable_rule": enable, "acknowledgements": {key: True for key in handover.ACKS}}
        return self.handover_body

    def enqueue_handover(self):
        return jobs.enqueue_action_review_request(self.db, "w", OWNER, "confirmation", self.handover_body, now=AT)

    def finish_handover(self, request):
        for _ in range(12):
            result = run_pending_once(self.db, "fictional-corrected-source-core", clock=lambda: AT)
            row = self.db.execute("SELECT document_json FROM investor_action_review_job_results WHERE request_id=?", (request["request_id"],)).fetchone()
            if row: return json.loads(row[0])
            self.assertIsNotNone(result)
        self.fail("HANDOVER_JOB_REQUIRED")

    def counts(self):
        return {name: self.db.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in (
            "investor_models", "investor_model_controls", "investor_monitor_evidence_inputs", "investor_evidence_model_checkpoints",
            "investor_data_sources", "investor_data_reviews", "investor_action_authorities", "investor_action_controls", "investor_action_review_confirmations")}

    def test_default_core_registers_one_disabled_successor_with_exact_approved_facts_and_original_knowledge_without_resuming_monitoring(self):
        self.prepared(); before = self.counts()
        names = ("investor_models", "investor_model_controls", "investor_monitor_evidence_inputs", "investor_evidence_model_checkpoints", "investor_evidence_checkpoint_payloads")
        rows = lambda: {name: [tuple(row) for row in self.db.execute("SELECT rowid,* FROM " + name + " ORDER BY rowid")] for name in names}
        original_rows = rows()
        original = managed_actions._anchor(self.db, "w", OWNER, json.loads(self.db.execute("SELECT document_json FROM investor_action_authorities WHERE id=?", (self.value["authority_id"],)).fetchone()[0])["base_review_id"],
            self.value["member"]["listing_review_id"], json.loads(self.db.execute("SELECT document_json FROM investor_action_authorities WHERE id=?", (self.value["authority_id"],)).fetchone()[0])["anchor_captures"], AT)["base"]
        origins_before = review._confirmed_event_origins(self.db, "w", original, AT)
        request = self.enqueue_handover(); result = self.finish_handover(request); self.assertEqual(result["outcome"], "confirmed", result)
        doc = review.resolve_action_review_confirmation(self.db, "w", OWNER, result["resource_id"], now=AT)
        self.assertEqual(doc["schema_version"], handover.CONFIRMATION); self.assertFalse(doc["request"]["enable_rule"])
        for name in ("investor_models", "investor_model_controls", "investor_monitor_evidence_inputs", "investor_evidence_model_checkpoints"):
            self.assertEqual(self.counts()[name], before[name])
        self.assertEqual(self.counts()["investor_action_authorities"], before["investor_action_authorities"] + 1)
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1", (doc["new_authority_id"],)).fetchone()[0], 0)
        current = data_evidence.resolve_review(self.db, "w", doc["new_review_id"], "actions", now=AT)
        origins = review._confirmed_event_origins(self.db, "w", current, AT)
        self.assertEqual(origins["fictional-dividend"], origins_before["fictional-dividend"])
        corrected_event = next(event for event in current["facts"]["events"] if event["id"].startswith("reviewed-correction:"))
        self.assertEqual(origins[corrected_event["id"]]["known_at"], json.loads(self.correction["document_json"])["baseline"]["knowledge_at"])
        self.assertNotEqual(origins[corrected_event["id"]]["known_at"], doc["created_at"])
        from worker.investor.retained_action_lineage import retained_action_knowledge
        with self.assertRaisesRegex(WorkbenchError, "CURRENT_EPOCH_PROTOCOL_REQUIRED"):
            retained_action_knowledge(self.db, "w", OWNER, [current], AT, AT)
        self.assertEqual(corrected.read_correction_consent_baseline(self.db, "w", OWNER, self.correction["id"], now=AT)["confirmation_id"], self.correction["id"])
        with self.assertRaises(WorkbenchError): corrected.prepare_corrected_action_source(self.db, "w", OWNER, self.correction["id"], now=AT)
        with self.assertRaises(WorkbenchError): managed_actions.set_authority_enabled(self.db, "w", OWNER, self.value["authority_id"], True, now=AT)
        self.assertEqual(self.enqueue_handover(), request); self.assertEqual(jobs.discover_action_review_requests(self.db, now=AT), [])
        self.assertEqual(rows(), original_rows)
        # Source handover cannot make an old state silently accept corrected
        # historical economics; this synthetic arithmetic probe is not admission.
        from worker.investor.retained_monitor_history import read_retained_monitor_history
        from worker.investor.action_correction_impact import _ledger
        from worker.investor.model_state import advance_evidence_model
        history = read_retained_monitor_history(self.db, "w", OWNER, doc["source_proof"]["model_id"], now=AT)
        projection = deepcopy(history["head_projection"])
        projection.update(created_at=AT, valid_until="2026-11-07T07:00:05.002Z")
        changed = lambda action: action["listing_id"] == current["facts"]["listing_id"] and (action.get("ex_at") or action["effective_at"]).startswith("2026-11-05")
        projection["corporate_actions"] = [action for action in history["original_actions"] if not changed(action)] + [
            action for action in _ledger(current["facts"], history["head"]["market_cutoffs"]["US"], doc["source_proof"]["knowledge_at"]) if changed(action)]
        with self.assertRaisesRegex(WorkbenchError, "ACTION_RESTATEMENT_REQUIRED"):
            advance_evidence_model(history["definition"], projection, history["head"], AT, input_hash=content_hash(projection))
        for key in ("quarantine_cleared", "research_admitted", "trading_permission", "raw_ai_sharing"): self.assertIs(doc[key], False)
        self.assertTrue(doc["monitor_data_readmission_required"]); self.assert_no_finance()

    def test_late_withdrawal_is_fenced_outside_the_writer_and_leaves_no_partial_source_rule_or_revision(self):
        self.prepared(enable=True); request = self.enqueue_handover(); jobs.discover_action_review_requests(self.db, now=AT)
        lease = claim_job(self.db, "fictional-handover-lease", job_type=jobs.JOB_TYPE, lease_seconds=300, now=AT)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()); calls = []
        prepare = handover.prepare_corrected_action_source
        def without_writer(*args, **kwargs):
            other = open_database(self.path)
            try: other.execute("BEGIN IMMEDIATE"); other.rollback(); calls.append(True)
            finally: other.close()
            return prepare(*args, **kwargs)
        with patch.object(handover, "prepare_corrected_action_source", side_effect=without_writer): descriptor = jobs.prepare_action_review_job(self.db, job, lease, clock=lambda: AT)
        self.assertTrue(calls); before = self.counts(); revision = self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
        eodhd_sources.set_authority_enabled(self.db, "w", OWNER, self.value["member"]["eodhd_authority_id"], False, now=AT)
        complete_job(self.db, lease, {}, effect=descriptor["effect"], clock=lambda: AT, now=AT)
        output = json.loads(self.db.execute("SELECT document_json FROM investor_action_review_job_results WHERE request_id=?", (request["request_id"],)).fetchone()[0])
        self.assertEqual(output["outcome"], "rejected"); self.assertEqual(self.counts(), before)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0], revision)
        self.assertEqual(jobs.discover_action_review_requests(self.db, now=AT), []); self.assert_no_finance()

    def test_late_failure_after_new_rule_and_source_insertion_rolls_every_partial_business_row_back_without_retry(self):
        self.prepared(enable=True); before = self.counts(); revision = self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
        request = self.enqueue_handover(); original = managed_actions.set_authority_enabled
        def fail(connection, workspace, actor, identifier, enabled, **kwargs):
            value = original(connection, workspace, actor, identifier, enabled, **kwargs)
            if identifier == self.value["authority_id"]: raise WorkbenchError("FICTIONAL_LATE_HANDOVER_FAILURE")
            return value
        with patch.object(managed_actions, "set_authority_enabled", side_effect=fail): result = self.finish_handover(request)
        self.assertEqual(result["outcome"], "rejected"); self.assertEqual(self.counts(), before)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0], revision)
        self.assertEqual(jobs.discover_action_review_requests(self.db, now=AT), []); self.assert_no_finance()

    def test_closed_explicit_protocol_does_not_borrow_earlier_consent_maintenance_or_client_economics(self):
        body = self.prepared(); before = list(self.db.iterdump())
        for changes in ({"new_events": []}, {"facts": {}}, {"source_proof": {}}, {"acknowledgements": {}}, {"enable_rule": None}, {"expected_revision": True}):
            with self.assertRaises(ValueError): jobs.enqueue_action_review_request(self.db, "w", OWNER, "confirmation", {**body, **changes}, now=AT)
        missing = deepcopy(body); del missing["enable_rule"]
        with self.assertRaises(ValueError): jobs.enqueue_action_review_request(self.db, "w", OWNER, "confirmation", missing, now=AT)
        wrong = {**body, "expected_correction_hash": "0" * 64}
        with self.assertRaises(WorkbenchError): handover.prepare_handover(self.db, "w", OWNER, wrong, now=AT)
        with self.assertRaises(WorkbenchError): handover.prepare_handover(self.db, "w", "foreign", body, now=AT)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()


if __name__ == "__main__": unittest.main()
