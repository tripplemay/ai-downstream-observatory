"""Ordinary single-attempt jobs over retained fictional sources, never approval."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as runtime
from tests.investor.test_action_correction_impact import correction_case, CHECKED, OWNER
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.investor import correction_impact_jobs as jobs, eodhd_sources, action_review_workflow as review
from worker.investor.correction_change_fence import correction_change_fence
from worker.orchestration.db import WorkbenchError, open_database
from worker.orchestration.jobs import claim_job, complete_job, run_one
from worker.orchestration.runtime import command_handler, run_pending_once


def settled_correction_case(db, path):
    value = correction_case(db, path)
    with offline_protocol_fixture():
        # Finish the already-due periodic evaluation before the owner's source
        # witness. A competing evaluation must still invalidate an older CAS.
        for unused in range(24):
            if run_pending_once(db, "fictional-settle-before-owner-preview", clock=lambda: CHECKED) is None: break
        else: raise AssertionError("FICTIONAL_CORE_NOT_SETTLED")
        revision = db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
        preview = review.register_action_review_preview(db, "w", OWNER, {"authority_id": value["authority_id"], "expected_revision": revision,
            "idempotency_key": "fictional-settled-correction-source-preview"}, now=CHECKED, owner_interaction=True)
        value["request"].update(preview_id=preview["preview_id"], expected_revision=preview["workspace_revision"])
        return value


class CorrectionImpactJobTests(unittest.TestCase):
    setUp = runtime.InvestorRuntimeTests.setUp
    assert_no_finance = runtime.InvestorRuntimeTests.assert_no_finance

    def seed(self):
        self.enterContext(offline_protocol_fixture()); self.value = settled_correction_case(self.db, self.path)
        return jobs.enqueue_correction_impact(self.db, "w", OWNER, self.value["request"], now=CHECKED)

    def result(self, request):
        row = self.db.execute("SELECT * FROM investor_correction_impact_results WHERE request_id=?", (request["request_id"],)).fetchone()
        self.assertIsNotNone(row); return json.loads(row["document_json"])

    def prepare_job(self, request):
        jobs.discover_correction_impact_requests(self.db, now=CHECKED)
        lease = claim_job(self.db, "fictional-correction", job_type=jobs.JOB_TYPE, lease_seconds=300, now=CHECKED)
        self.assertIsNotNone(lease); job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        descriptor = jobs.prepare_correction_impact_job(self.db, job, lease, clock=lambda: CHECKED)
        return lease, descriptor

    def test_explicit_intent_default_core_and_original_nonce_recovery_never_advance_cas_or_create_approval(self):
        request = self.seed(); before = self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
        baseline = {name: self.db.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in (
            "investor_data_reviews", "investor_action_review_confirmations", "investor_model_controls", "investor_evidence_model_checkpoints")}
        self.assertEqual(request, jobs.enqueue_correction_impact(self.db, "w", OWNER, self.value["request"], now=CHECKED))
        for unused in range(12):
            done = run_pending_once(self.db, "fictional-correction-core", clock=lambda: CHECKED)
            if self.db.execute("SELECT 1 FROM investor_correction_impact_results WHERE request_id=?", (request["request_id"],)).fetchone(): break
            self.assertIsNotNone(done)
        result = self.result(request); self.assertEqual(result["outcome"], "preview_ready", result)
        self.assertTrue(result["impact"]["comparison"]["economics_changed"]); self.assertFalse(result["impact"]["economic_correction_approved"])
        self.assertEqual(result["change_fence"], correction_change_fence(self.db, "w", OWNER))
        self.assertEqual(before, self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0])
        self.assertEqual(baseline, {name: self.db.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in baseline})
        self.assertEqual(jobs.discover_correction_impact_requests(self.db, now=CHECKED), [])
        self.assertEqual(jobs.enqueue_correction_impact(self.db, "w", OWNER, self.value["request"], now="2026-11-07T07:00:00.000Z"), request)
        self.assert_no_finance()

    def test_busy_changed_body_foreign_owner_and_immutable_rows_leave_no_extra_intent(self):
        request = self.seed(); before = list(self.db.iterdump())
        body = deepcopy(self.value["request"]); body["idempotency_key"] = "fictional-other-correction"
        with self.assertRaisesRegex(WorkbenchError, "BUSY"): jobs.enqueue_correction_impact(self.db, "w", OWNER, body, now=CHECKED)
        body = deepcopy(self.value["request"]); body["decisions"][0]["reason"] = "different hypothesis"
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_CONFLICT"): jobs.enqueue_correction_impact(self.db, "w", OWNER, body, now=CHECKED)
        with self.assertRaises(WorkbenchError): jobs.enqueue_correction_impact(self.db, "w", "foreign", self.value["request"], now=CHECKED)
        self.assertEqual(before, list(self.db.iterdump()))
        import sqlite3
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("DELETE FROM investor_correction_impact_requests WHERE id=?", (request["request_id"],))
        self.assert_no_finance()

    def test_prepare_holds_no_writer_lock_and_changed_control_before_commit_rejects_without_impact(self):
        request = self.seed(); original = jobs.compare_action_correction_impact; checked = []
        def inspect(*args, **kwargs):
            other = open_database(self.path)
            try: other.execute("BEGIN IMMEDIATE"); other.rollback(); checked.append(True)
            finally: other.close()
            return original(*args, **kwargs)
        with patch.object(jobs, "compare_action_correction_impact", side_effect=inspect): lease, descriptor = self.prepare_job(request)
        self.assertTrue(checked)
        other = open_database(self.path)
        try: eodhd_sources.set_authority_enabled(other, "w", OWNER, self.value["member"]["eodhd_authority_id"], False, now=CHECKED)
        finally: other.close()
        complete_job(self.db, lease, {}, effect=descriptor["effect"], now=CHECKED, clock=lambda: CHECKED)
        result = self.result(request); self.assertEqual(result["outcome"], "rejected"); self.assertIsNone(result["impact"])
        self.assert_no_finance()

    def test_queued_expiry_does_not_execute_expensive_replay_and_never_retries(self):
        request = self.seed(); later = "2026-11-07T06:05:04.001Z"
        jobs.discover_correction_impact_requests(self.db, now=later)
        with patch.object(jobs, "compare_action_correction_impact", side_effect=AssertionError("NO_EXPIRED_REPLAY")):
            done = run_one(self.db, "fictional-expired-correction", command_handler(self.db, clock=lambda: later), job_type=jobs.JOB_TYPE, clock=lambda: later)
        self.assertEqual(done["status"], "succeeded"); self.assertEqual(done["max_attempts"], 1)
        result = self.result(request); self.assertEqual(result["code"], "CORRECTION_IMPACT_EXPIRED")
        self.assertEqual(jobs.discover_correction_impact_requests(self.db, now=later), []); self.assert_no_finance()

    def test_source_purge_revision_and_owner_bound_metadata_fence_is_not_an_approval(self):
        request = self.seed(); original = correction_change_fence(self.db, "w", OWNER); count = self.db.total_changes
        self.assertEqual(correction_change_fence(self.db, "w", OWNER), original); self.assertEqual(self.db.total_changes, count)
        with self.assertRaises(WorkbenchError): correction_change_fence(self.db, "w", "foreign")
        self.db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id='w'")
        self.assertNotEqual(correction_change_fence(self.db, "w", OWNER), original)
        jobs.discover_correction_impact_requests(self.db, now=CHECKED)
        done = run_one(self.db, "fictional-stale-correction", command_handler(self.db, clock=lambda: CHECKED), job_type=jobs.JOB_TYPE, clock=lambda: CHECKED)
        self.assertEqual(done["status"], "succeeded"); self.assertEqual(self.result(request)["outcome"], "rejected"); self.assert_no_finance()


if __name__ == "__main__": unittest.main()
