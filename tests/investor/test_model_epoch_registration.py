"""Explicit fictional owner intent and all-or-none publication, never production."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import epoch_source_fixture as fixture, test_current_correction_fixture as setup
from worker.investor import model_epoch_registration as registration, model_epoch_source as source, eodhd_sources
from worker.investor.evidence_monitor_runtime import discover_evidence_monitor_requests
from worker.investor.monitor_admission import monitor_evidence_document
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash
from worker.orchestration.jobs import claim_job, complete_job
from worker.orchestration.runtime import command_handler


CALCULATED = "2026-10-20T10:00:04.000Z"
PUBLISHED = "2026-10-20T10:00:05.000Z"
TABLES = ("investor_model_epochs", "investor_monitor_evidence_inputs", "investor_evidence_monitor_requests", "investor_evidence_model_checkpoints",
    "investor_evidence_checkpoint_payloads", "investor_evidence_monitor_runs", "investor_evidence_run_payloads", "investor_observations", "audit_events", "outbox")


class ModelEpochRegistrationTests(unittest.TestCase):
    setUp = setup.CurrentCorrectionFixtureTests.setUp

    def seed(self):
        self.inputs = fixture.create(self.db, self.path)

    def revision(self): return self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]

    def preview(self):
        return registration.register_model_epoch_preview(self.db, "w", "owner", self.inputs["model_id"], self.inputs["references"], self.inputs["windows"],
            expected_revision=self.revision(), owner_interaction=True, now=fixture.NOW)

    def body(self, preview):
        return {"schema_version": "investor-model-epoch-submit-v1", "preview_id": preview["preview_id"], "expected_preview_hash": content_hash(preview),
            "expected_revision": preview["workspace_revision"], "idempotency_key": "fictional-explicit-current-epoch", "acknowledgements": {key: True for key in registration.ACKS}}

    def prepare(self, request, times=None):
        lease = claim_job(self.db, "fictional-epoch-registration", 300, registration.JOB_TYPE, now=CALCULATED)
        self.assertIsNotNone(lease)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        self.assertEqual(job["period"], request["request_id"])
        clock = (lambda: CALCULATED) if times is None else lambda: times[0]
        effect = command_handler(self.db, clock=clock)(job, lease)["effect"]
        return job, lease, effect

    def snapshot(self):
        return {table: [tuple(row) for row in self.db.execute("SELECT rowid,* FROM " + table + " ORDER BY rowid")] for table in TABLES}

    def test_owner_preview_and_separate_acknowledged_intent_atomically_store_new_source_state_run_and_paused_observation(self):
        self.seed(); initial = self.snapshot(); revision = self.revision()
        preview = self.preview(); self.assertEqual(preview["workspace_revision"], revision + 1)
        self.assertEqual(self.snapshot(), {**initial, "audit_events": self.snapshot()["audit_events"]})
        self.db.execute("SAVEPOINT fictional_unregistered_epoch_input")
        try:
            from worker.investor.data_evidence import _audit
            audit = _audit(self.db, "owner", "investor_admit_monitor_source", "investor_monitor_evidence_input", "fictional-unregistered-input", {"content_hash": content_hash(preview["input"])}, fixture.NOW)
            with self.assertRaisesRegex(Exception, "epoch input binding differs"):
                self.db.execute("INSERT INTO investor_monitor_evidence_inputs VALUES('fictional-unregistered-input','w',?,'owner_reviewed_reconstructed',?,?,'owner',?,?,?)", (
                    self.inputs["model_id"], canonical_json(preview["input"]), content_hash(preview["input"]), preview["input"]["created_at"], preview["input"]["valid_until"], audit))
        finally: self.db.execute("ROLLBACK TO fictional_unregistered_epoch_input"); self.db.execute("RELEASE fictional_unregistered_epoch_input")
        body = self.body(preview)
        for key in registration.ACKS:
            invalid = deepcopy(body); invalid["acknowledgements"][key] = False
            before = list(self.db.iterdump())
            with self.assertRaises(ValueError): registration.enqueue_model_epoch_registration(self.db, "w", "owner", invalid, now=fixture.NOW)
            self.assertEqual(before, list(self.db.iterdump()))
        request = registration.enqueue_model_epoch_registration(self.db, "w", "owner", body, now=fixture.NOW)
        before = list(self.db.iterdump())
        self.assertEqual(request, registration.enqueue_model_epoch_registration(self.db, "w", "owner", body, now=fixture.NOW))
        self.assertEqual(before, list(self.db.iterdump()))
        conflict = {**body, "expected_preview_hash": "0" * 64}
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_CONFLICT"): registration.enqueue_model_epoch_registration(self.db, "w", "owner", conflict, now=fixture.NOW)
        for table in TABLES[:-2]: self.assertEqual(self.snapshot()[table], initial[table])
        times = [CALCULATED]; job, lease, effect = self.prepare(request, times); times[0] = PUBLISHED
        with patch.object(source, "replay_model_epoch_source", side_effect=AssertionError("NO_RAW_REPLAY_IN_WRITER")), \
                patch.object(source, "_basis", side_effect=AssertionError("NO_BASELINE_REPLAY_IN_WRITER")):
            complete_job(self.db, lease, {}, effect=effect, now=PUBLISHED, clock=lambda: PUBLISHED)
        row = self.db.execute("SELECT * FROM investor_model_epochs").fetchone(); doc = json.loads(row["document_json"])
        self.assertTrue(doc["source_registered"]); self.assertTrue(doc["first_state_published"])
        self.assertFalse(doc["monitoring_resumed"]); self.assertFalse(doc["trading_permission"])
        self.assertEqual(doc["calculated_at"], CALCULATED); self.assertEqual(doc["created_at"], PUBLISHED)
        self.assertEqual(doc["epoch"], preview["input"]["epoch"])
        self.assertEqual(registration._header(self.db, "w", "owner", row["id"], "registration")[1], doc)
        checkpoint = json.loads(self.db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?", (row["checkpoint_id"],)).fetchone()[0])
        original = json.loads(initial["investor_evidence_checkpoint_payloads"][-1][-1])
        self.assertEqual(checkpoint["previous_hash"], content_hash(original)); self.assertEqual(checkpoint["sequence"], original["sequence"] + 1)
        self.assertEqual(checkpoint["schema_version"], "investor-evidence-model-checkpoint-v4")
        self.assertEqual(checkpoint["projection_hash"], preview["input"]["projection_hash"])
        source_row = self.db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=?", (row["input_id"],)).fetchone()
        self.assertEqual(json.loads(source_row["document_json"]), preview["input"])
        self.assertEqual(source_row["created_at"], fixture.NOW)
        audit = self.db.execute("SELECT created_at FROM audit_events WHERE id=?", (source_row["audit_id"],)).fetchone()
        self.assertEqual(audit[0], PUBLISHED)
        payload = json.loads(self.db.execute("SELECT payload FROM investor_evidence_run_payloads WHERE run_id=?", (row["monitor_run_id"],)).fetchone()[0])
        self.assertEqual(payload["observation"]["monitoring"], "paused"); self.assertIsNone(payload["observation"]["next_review_at"])
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (job["id"],)).fetchone()[0], "succeeded")
        after = self.snapshot()
        for table in TABLES:
            self.assertEqual(after[table][:len(initial[table])], initial[table], table)
        self.assertEqual(after["outbox"], initial["outbox"])
        for table in ("portfolios", "accounts", "ledger_events", "postings"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
        self.assertEqual(discover_evidence_monitor_requests(self.db, now=PUBLISHED), [])
        with self.assertRaises(ValueError): monitor_evidence_document(self.db, "w", row["model_id"], row["input_id"], PUBLISHED)
        with self.assertRaises(WorkbenchError): source.replay_model_epoch_source(self.db, "w", "owner", preview["epoch_definition"], preview["input"], now=PUBLISHED)
        for table in ("investor_model_epoch_previews", "investor_model_epoch_requests", "investor_model_epochs"):
            for operation in ("DELETE FROM ", "UPDATE "):
                with self.assertRaises(Exception): self.db.execute(operation + table + (" SET content_hash='" + "0" * 64 + "'" if operation.startswith("UPDATE") else ""))
        with self.assertRaisesRegex(Exception, "own continuation protocol"):
            self.db.execute("INSERT INTO investor_monitor_evidence_inputs SELECT 'fictional-discarded-epoch',workspace_id,model_id,source_qualification,document_json,content_hash,actor_id,created_at,valid_until,audit_id FROM investor_monitor_evidence_inputs WHERE id=?", (
                preview["previous_input_id"],))
        self.assertEqual(list(self.db.execute("PRAGMA foreign_key_check")), [])
        self.assertEqual(self.db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_stale_fence_expired_lease_stop_and_late_failure_never_publish_a_partial_epoch_or_duplicate_old_state(self):
        self.seed(); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "OWNER_INTERACTION_REQUIRED"):
            registration.register_model_epoch_preview(self.db, "w", "owner", self.inputs["model_id"], self.inputs["references"], self.inputs["windows"], expected_revision=self.revision(), now=fixture.NOW)
        self.assertEqual(before, list(self.db.iterdump()))
        preview = self.preview(); body = self.body(preview)
        with self.assertRaises(WorkbenchError): registration.enqueue_model_epoch_registration(self.db, "w", "foreign", body, now=fixture.NOW)
        request = registration.enqueue_model_epoch_registration(self.db, "w", "owner", body, now=fixture.NOW)
        times = [CALCULATED]; job, lease, effect = self.prepare(request, times); baseline = self.snapshot(); revision = self.revision()
        self.db.execute("SAVEPOINT fictional_revoke_epoch_grant")
        try:
            grant = self.db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
            eodhd_sources.set_authority_enabled(self.db, "w", "owner", grant, False, now=PUBLISHED)
            with self.assertRaisesRegex(WorkbenchError, "SOURCE_CHANGED"): complete_job(self.db, lease, {}, effect=effect, now=CALCULATED)
            self.assertEqual(self.snapshot(), {**baseline, "audit_events": self.snapshot()["audit_events"]})
        finally: self.db.execute("ROLLBACK TO fictional_revoke_epoch_grant"); self.db.execute("RELEASE fictional_revoke_epoch_grant")
        times[0] = "2026-10-20T10:10:04.000Z"
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"): complete_job(self.db, lease, {}, effect=effect, now=times[0])
        times[0] = PUBLISHED
        self.db.execute("CREATE TRIGGER fictional_epoch_late_failure BEFORE INSERT ON investor_evidence_run_payloads BEGIN SELECT RAISE(ABORT,'fictional epoch late failure'); END")
        with self.assertRaisesRegex(Exception, "fictional epoch late failure"): complete_job(self.db, lease, {}, effect=effect, now=PUBLISHED)
        self.db.execute("DROP TRIGGER fictional_epoch_late_failure")
        self.assertEqual(self.snapshot(), baseline); self.assertEqual(self.revision(), revision)
        with patch.object(source, "replay_model_epoch_source", side_effect=AssertionError("NO_STOPPED_RAW_REPLAY")) as raw:
            with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
                registration.prepare_model_epoch_registration_job(self.db, job, lease, clock=lambda: PUBLISHED, stop_requested=lambda: True)
        raw.assert_not_called()
        times[0] = "2026-10-20T10:10:03.000Z"
        # Keep the lease valid to isolate the independent owner-preview deadline.
        self.db.execute("SAVEPOINT fictional_long_epoch_lease")
        try:
            self.db.execute("UPDATE job_runs SET lease_until='2026-10-20T10:20:00.000000Z' WHERE id=?", (job["id"],))
            with self.assertRaisesRegex(WorkbenchError, "PUBLICATION_EXPIRED"): complete_job(self.db, lease, {}, effect=effect, now=times[0])
            times[0] = PUBLISHED
            with self.assertRaisesRegex(WorkbenchError, "PUBLICATION_EXPIRED"):
                complete_job(self.db, lease, {}, effect=effect, now=PUBLISHED, clock=lambda: "2026-10-20T10:10:03.000Z")
            self.assertEqual(self.snapshot(), baseline); self.assertEqual(self.revision(), revision)
        finally: self.db.execute("ROLLBACK TO fictional_long_epoch_lease"); self.db.execute("RELEASE fictional_long_epoch_lease")
        times[0] = PUBLISHED
        stopped = registration.prepare_model_epoch_registration_job(self.db, job, lease, clock=lambda: PUBLISHED,
            stop_requested=lambda: self.db.execute("SELECT count(*) FROM investor_model_epochs").fetchone()[0] > 0)
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"): complete_job(self.db, lease, {}, effect=stopped["effect"], now=PUBLISHED)
        self.assertEqual(self.snapshot(), baseline); self.assertEqual(self.revision(), revision)
        complete_job(self.db, lease, {}, effect=effect, now=PUBLISHED)
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"): complete_job(self.db, lease, {}, effect=effect, now=PUBLISHED)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_model_epochs").fetchone()[0], 1)


if __name__ == "__main__": unittest.main()
