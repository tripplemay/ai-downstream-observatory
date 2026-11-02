"""Owner intent -> single core attempt -> atomic consent and v5 registration."""

import json
import sqlite3
import sys
import unittest
from unittest.mock import patch

from tests.investor import test_legacy_transition_source as fixture
from worker.investor import legacy_transition_jobs as jobs, legacy_transition_workflow as workflow, eodhd_sources
from worker.orchestration.db import WorkbenchError, content_hash, open_database
from worker.orchestration.jobs import claim_job, complete_job, run_one
from worker.orchestration.runtime import command_handler, run_pending_once


class LegacyTransitionJobTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.LegacyTransitionSourceTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.db = self.case.db; self.at = self.case.at
        self.case.case.model(audited=False, known_costs=True); self.case.case.confirm()
        self.model_id = self.case.case.definition["model_id"]
        for _ in range(10):
            if run_pending_once(self.db, "fictional-baseline-core", clock=lambda: self.at) is None: break
        else: self.fail("FICTIONAL_BASELINE_CORE_NOT_DRAINED")

    def revision(self):
        return self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]

    def enqueue_preview(self, **changes):
        body = {"model_id": self.model_id, "expected_revision": self.revision(), "idempotency_key": "fictional-legacy-job-preview", **changes}
        return jobs.enqueue_legacy_transition_request(self.db, "w", "synthetic-investor", "preview", body, now=self.at)

    def complete(self, request, *, full_core=False):
        if full_core:
            for _ in range(10):
                result = run_pending_once(self.db, "fictional-legacy-owner-core", clock=lambda: self.at)
                if self.db.execute("SELECT 1 FROM investor_legacy_transition_job_results WHERE request_id=?", (request["request_id"],)).fetchone(): break
                self.assertIsNotNone(result)
        else:
            jobs.discover_legacy_transition_requests(self.db, now=self.at)
            result = run_one(self.db, "fictional-legacy-owner-core", command_handler(self.db, clock=lambda: self.at),
                job_type=jobs.JOB_TYPE, lease_seconds=300, clock=lambda: self.at)
        self.assertIsNotNone(result); self.assertEqual(result["status"], "succeeded")
        row = self.db.execute("SELECT document_json FROM investor_legacy_transition_job_results WHERE request_id=?", (request["request_id"],)).fetchone()
        self.assertIsNotNone(row); return json.loads(row[0])

    def ready(self):
        result = self.complete(self.enqueue_preview()); self.assertEqual(result["outcome"], "preview_ready")
        self.preview = workflow._preview_header(self.db, "w", "synthetic-investor", result["resource_id"])[1]

    def answers(self):
        return {"schema_version": "investor-legacy-transition-submit-v1", "preview_id": self.preview["preview_id"],
            "expected_preview_hash": content_hash(self.preview), "expected_revision": self.preview["workspace_revision"],
            "idempotency_key": "fictional-legacy-job-confirmation", "acknowledgements": {key: True for key in
                ("preserve_original_accounting_and_knowledge", "revalidate_current_sources_on_every_use", "new_actions_keep_audited_knowledge",
                 "quality_gaps_are_not_current_advice", "research_only_no_trading")}}

    def test_enqueue_is_only_intent_and_the_default_core_prepares_a_real_witness_once(self):
        before = self.revision(); request = self.enqueue_preview()
        self.assertEqual(self.revision(), before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_legacy_transition_previews").fetchone()[0], 0)
        self.assertEqual(self.enqueue_preview(), request)
        result = self.complete(request, full_core=True); self.assertEqual(result["outcome"], "preview_ready")
        self.assertEqual(self.revision(), before + 1)
        self.assertEqual(jobs.discover_legacy_transition_requests(self.db, now=self.at), [])
        self.case.case.case.assert_no_finance()

    def test_confirmation_and_root_source_are_one_atomic_single_attempt_result_without_activating_monitoring(self):
        self.ready(); before = self.revision(); body = self.answers()
        controls = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_model_controls")]
        request = jobs.enqueue_legacy_transition_request(self.db, "w", "synthetic-investor", "confirmation", body, now=self.at)
        self.assertEqual(self.revision(), before)
        result = self.complete(request); self.assertEqual(result["outcome"], "registered"); self.assertEqual(self.revision(), before + 2)
        admission = json.loads(self.db.execute("SELECT document_json FROM investor_legacy_transition_admissions WHERE id=?", (result["resource_id"],)).fetchone()[0])
        receipt = json.loads(self.db.execute("SELECT document_json FROM investor_legacy_transition_confirmations WHERE id=?", (admission["transition_id"],)).fetchone()[0])
        self.assertEqual(content_hash(admission), result["resource_hash"])
        self.assertEqual(receipt["request"], body); self.assertEqual(receipt["workspace_revision"], before + 1)
        self.assertEqual(admission["workspace_revision"], before + 2); self.assertFalse(admission["monitoring_activated"])
        self.assertEqual(controls, [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_model_controls")])
        self.assertEqual(jobs.enqueue_legacy_transition_request(self.db, "w", "synthetic-investor", "confirmation", body, now=self.at), request)
        self.assertEqual(jobs.discover_legacy_transition_requests(self.db, now=self.at), [])
        self.assertNotIn("quotes", result); self.assertEqual(result["provider_calls"], 0); self.case.case.case.assert_no_finance()

    def test_second_connection_source_withdrawal_after_preparation_cannot_publish_either_half(self):
        self.ready(); request = jobs.enqueue_legacy_transition_request(self.db, "w", "synthetic-investor", "confirmation", self.answers(), now=self.at)
        jobs.discover_legacy_transition_requests(self.db, now=self.at)
        lease = claim_job(self.db, "fictional-legacy-race", job_type=jobs.JOB_TYPE, lease_seconds=300, now=self.at)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        descriptor = jobs.prepare_legacy_transition_job(self.db, job, lease, clock=lambda: self.at)
        other = open_database(self.case.case.case.path)
        try: eodhd_sources.set_authority_enabled(other, "w", "synthetic-investor", self.case.case.case.member["eodhd_authority_id"], False, now=self.at)
        finally: other.close()
        before = self.revision(); complete_job(self.db, lease, {}, effect=descriptor["effect"], now=self.at, clock=lambda: self.at)
        result = json.loads(self.db.execute("SELECT document_json FROM investor_legacy_transition_job_results WHERE request_id=?", (request["request_id"],)).fetchone()[0])
        self.assertEqual(result["outcome"], "rejected"); self.assertEqual(self.revision(), before)
        for table in ("investor_legacy_transition_confirmations", "investor_legacy_transition_admissions"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)

    def test_late_source_insert_failure_rolls_back_consent_revision_and_domain_input_without_retry(self):
        self.ready(); request = jobs.enqueue_legacy_transition_request(self.db, "w", "synthetic-investor", "confirmation", self.answers(), now=self.at)
        self.db.execute("CREATE TRIGGER fictional_legacy_job_abort BEFORE INSERT ON investor_legacy_transition_admissions BEGIN SELECT RAISE(ABORT,'fictional legacy job late failure'); END")
        before = self.revision(); inputs = self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0]
        jobs.discover_legacy_transition_requests(self.db, now=self.at)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "fictional legacy job late failure"):
            run_one(self.db, "fictional-legacy-atomic", command_handler(self.db, clock=lambda: self.at), job_type=jobs.JOB_TYPE, clock=lambda: self.at)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE period=?", (request["request_id"],)).fetchone()[0], "failed")
        self.assertEqual(self.revision(), before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], inputs)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_legacy_transition_confirmations").fetchone()[0], 0)
        self.assertIsNone(claim_job(self.db, "not-a-retry", job_type=jobs.JOB_TYPE, now=self.at))

    def test_same_nonce_cannot_change_intent_and_busy_does_not_create_another_request(self):
        self.enqueue_preview(); before = list(self.db.iterdump())
        with self.assertRaisesRegex(sqlite3.IntegrityError, "request binding differs"):
            self.db.execute("INSERT OR REPLACE INTO investor_legacy_transition_job_requests SELECT * FROM investor_legacy_transition_job_requests")
        with self.assertRaisesRegex(WorkbenchError, "BUSY"): self.enqueue_preview(idempotency_key="fictional-second-preview")
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_CONFLICT"): self.enqueue_preview(model_id="other")
        self.assertEqual(before, list(self.db.iterdump()))

    def test_expired_request_is_recorded_as_rejected_once_without_creating_a_witness(self):
        request = self.enqueue_preview(); self.at = "2026-11-03T06:05:04.002Z"
        result = self.complete(request); self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(result["code"], "LEGACY_TRANSITION_REQUEST_EXPIRED")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_legacy_transition_previews").fetchone()[0], 0)
        self.assertEqual(jobs.discover_legacy_transition_requests(self.db, now=self.at), [])

    def test_existing_owner_write_does_not_get_implicitly_rebased_or_approved(self):
        request = self.enqueue_preview(); before = self.revision()
        workflow.register_legacy_transition_preview(self.db, "w", "synthetic-investor", {**request["body"], "idempotency_key": "fictional-other-explicit-witness"}, now=self.at)
        result = self.complete(request); self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(result["code"], "LEGACY_TRANSITION_VERSION_CHANGED"); self.assertEqual(self.revision(), before + 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_legacy_transition_confirmations").fetchone()[0], 0)

    def test_wrong_connection_and_final_expired_lease_cannot_publish_a_combined_result(self):
        self.ready(); request = jobs.enqueue_legacy_transition_request(self.db, "w", "synthetic-investor", "confirmation", self.answers(), now=self.at)
        jobs.discover_legacy_transition_requests(self.db, now=self.at)
        lease = claim_job(self.db, "fictional-final-fence", job_type=jobs.JOB_TYPE, lease_seconds=60, now=self.at)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()); times = [self.at]
        effect = jobs.prepare_legacy_transition_job(self.db, job, lease, clock=lambda: times[0])["effect"]
        other = open_database(self.case.case.case.path)
        try:
            with self.assertRaisesRegex(WorkbenchError, "PREPARED_CONNECTION_CHANGED"): effect(other)
        finally: other.close()
        before = self.revision(); original = jobs.source.admit_legacy_transition_source
        def late(*args, **kwargs):
            value = original(*args, **kwargs); times[0] = "2026-11-03T06:01:04.002Z"; return value
        with patch.object(jobs.source, "admit_legacy_transition_source", side_effect=late), self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            complete_job(self.db, lease, {}, effect=effect, now=self.at, clock=lambda: times[0])
        self.assertEqual(self.revision(), before)
        for table in ("investor_legacy_transition_confirmations", "investor_legacy_transition_admissions"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_legacy_transition_job_results WHERE request_id=?", (request["request_id"],)).fetchone()[0], 0)

    def test_non_core_role_and_stop_boundary_do_not_publish(self):
        request = self.enqueue_preview(); jobs.discover_legacy_transition_requests(self.db, now=self.at)
        lease = claim_job(self.db, "fictional-wrong-role", job_type=jobs.JOB_TYPE, lease_seconds=300, now=self.at)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        with self.assertRaises(WorkbenchError): command_handler(self.db, clock=lambda: self.at, role="longport")(job, lease)
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            jobs.prepare_legacy_transition_job(self.db, job, lease, clock=lambda: self.at, stop_requested=lambda: True)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_legacy_transition_previews").fetchone()[0], 0)


if __name__ == "__main__":
    if sys.argv[1:] == ["--contract"]:
        case = LegacyTransitionJobTests(); case.setUp()
        try:
            request = case.enqueue_preview(); preview = case.complete(request); case.preview = workflow._preview_header(case.db, "w", "synthetic-investor", preview["resource_id"])[1]
            confirmation = jobs.enqueue_legacy_transition_request(case.db, "w", "synthetic-investor", "confirmation", case.answers(), now=case.at)
            registered = case.complete(confirmation)
            from worker.orchestration.db import canonical_json
            print(canonical_json({"preview_request": request, "preview_result": preview, "confirmation_request": confirmation, "registered_result": registered}))
        finally: case.doCleanups()
    else: unittest.main()
