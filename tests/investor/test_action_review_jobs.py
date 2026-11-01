"""Durable interactive review on invented source receipts, no real providers."""

import json
import sys
import unittest
from unittest.mock import patch

from tests.investor import test_action_review_workflow as fixture
from worker.investor import action_review_jobs as jobs, action_review_workflow as workflow, eodhd_sources
from worker.orchestration.db import WorkbenchError, instant, open_database
from worker.orchestration.jobs import claim_job, complete_job, run_one
from worker.orchestration.runtime import command_handler, run_pending_once


AT, CONFIRM = fixture.AT, fixture.CONFIRM


class ActionReviewJobTests(unittest.TestCase):
    setUp = fixture.ActionReviewWorkflowTests.setUp
    prepare = fixture.ActionReviewWorkflowTests.prepare
    policy = fixture.ActionReviewWorkflowTests.policy
    grant = fixture.ActionReviewWorkflowTests.grant
    next_source_day = fixture.ActionReviewWorkflowTests.next_source_day
    retained_reports = fixture.ActionReviewWorkflowTests.retained_reports
    revision = fixture.ActionReviewWorkflowTests.revision
    answers = fixture.ActionReviewWorkflowTests.answers
    assert_no_finance = fixture.ActionReviewWorkflowTests.assert_no_finance

    def preview_request(self, *, nonce="fictional-job-preview", now=AT):
        body = {"authority_id": self.authority["id"], "expected_revision": self.revision(), "idempotency_key": nonce}
        return jobs.enqueue_action_review_request(self.db, "w", "synthetic-investor", "preview", body, now=now)

    def complete(self, request, at=AT, *, full_core=False):
        if full_core:
            result = run_pending_once(self.db, "fictional-review-core", clock=lambda: at)
        else:
            jobs.discover_action_review_requests(self.db, now=at)
            result = run_one(self.db, "fictional-review-core", command_handler(self.db, clock=lambda: at), job_type=jobs.JOB_TYPE,
                lease_seconds=300, clock=lambda: at)
        self.assertIsNotNone(result); self.assertEqual(result["status"], "succeeded")
        row = self.db.execute("SELECT * FROM investor_action_review_job_results WHERE request_id=?", (request["request_id"],)).fetchone()
        self.assertIsNotNone(row); return json.loads(row["document_json"])

    def ready(self):
        self.retained_reports(); request = self.preview_request(); result = self.complete(request)
        self.assertEqual(result["outcome"], "preview_ready")
        self.preview = workflow._preview_header(self.db, "w", "synthetic-investor", result["resource_id"])[1]
        return result

    def test_enqueue_is_only_intent_and_does_not_stale_its_own_workspace_revision(self):
        self.retained_reports(); before = self.revision(); count = self.db.execute("SELECT count(*) FROM investor_data_reviews").fetchone()[0]
        request = self.preview_request()
        self.assertEqual(before, self.revision()); self.assertEqual(self.db.execute("SELECT count(*) FROM investor_action_review_previews").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_data_reviews").fetchone()[0], count)
        self.assertEqual(request, self.preview_request()); self.assertEqual(before, self.revision())
        result = self.complete(request, full_core=True)
        self.assertEqual(result["outcome"], "preview_ready"); self.assertEqual(self.revision(), before + 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_data_reviews").fetchone()[0], count); self.assert_no_finance()

    def test_core_preview_then_explicit_confirmation_are_atomic_once_only_and_metadata_only(self):
        self.ready(); before = self.revision(); body = self.answers()
        request = jobs.enqueue_action_review_request(self.db, "w", "synthetic-investor", "confirmation", body, now=CONFIRM)
        self.assertEqual(before, self.revision()); result = self.complete(request, CONFIRM)
        self.assertEqual(result["outcome"], "confirmed"); self.assertEqual(self.revision(), before + 1)
        original = workflow.resolve_action_review_confirmation(self.db, "w", "synthetic-investor", result["resource_id"], now=CONFIRM)
        self.assertFalse(original["request"]["enable_rule"])
        self.assertEqual(jobs.enqueue_action_review_request(self.db, "w", "synthetic-investor", "confirmation", body, now=CONFIRM), request)
        self.assertEqual(jobs.discover_action_review_requests(self.db, now=CONFIRM), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_action_review_confirmations").fetchone()[0], 1)
        self.assertNotIn("987.1234", json.dumps(result)); self.assertNotIn("tax_per_unit", json.dumps(result)); self.assert_no_finance()

    def test_owner_policy_is_fifteen_minutes_without_refreshing_original_deadline_or_old_operator_policy(self):
        self.retained_reports()
        legacy = workflow.register_action_review_preview(self.db, "w", "synthetic-investor", {
            "authority_id": self.authority["id"], "expected_revision": self.revision(), "idempotency_key": "fictional-legacy-preview"}, now=AT)
        self.assertNotIn("validity_policy", legacy)
        self.assertEqual((instant(legacy["valid_until"]) - instant(legacy["checked_at"])).total_seconds(), 60)
        result = self.complete(self.preview_request())
        self.preview = workflow._preview_header(self.db, "w", "synthetic-investor", result["resource_id"])[1]
        self.assertEqual(self.preview["validity_policy"], "owner_review_15m")
        self.assertEqual((instant(self.preview["valid_until"]) - instant(self.preview["checked_at"])).total_seconds(), 900)
        original = self.preview["valid_until"]
        later = "2026-11-03T06:05:04.001Z"
        view = workflow.resolve_action_review_preview(self.db, "w", "synthetic-investor", self.preview["preview_id"], now=later)
        self.assertEqual(view["preview"]["valid_until"], original)
        request = jobs.enqueue_action_review_request(self.db, "w", "synthetic-investor", "confirmation", self.answers(), now=later)
        self.assertEqual(self.complete(request, later)["outcome"], "confirmed"); self.assert_no_finance()

    def test_domain_preparation_cannot_commit_until_fenced_and_wrong_connection_is_rejected(self):
        self.retained_reports(); body = {"authority_id": self.authority["id"], "expected_revision": self.revision(), "idempotency_key": "fictional-prepared"}
        before = list(self.db.iterdump()); effect = workflow.prepare_action_review_preview(self.db, "w", "synthetic-investor", body, now=AT)
        self.assertEqual(list(self.db.iterdump()), before)
        other = open_database(self.path)
        try:
            with self.assertRaisesRegex(WorkbenchError, "PREPARED_CONNECTION_CHANGED"): effect(other)
        finally: other.close()
        self.assertEqual(list(self.db.iterdump()), before); effect(self.db); self.assert_no_finance()

    def test_busy_and_changed_nonce_payloads_never_create_additional_intents(self):
        self.retained_reports(); request = self.preview_request(); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "BUSY"): self.preview_request(nonce="another-nonce")
        body = {**request["body"], "authority_id": "fictional-wrong-authority"}
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_CONFLICT"):
            jobs.enqueue_action_review_request(self.db, "w", "synthetic-investor", "preview", body, now=AT)
        self.assertEqual(list(self.db.iterdump()), before)

    def test_preview_preparation_is_outside_the_write_lock_and_only_core_can_handle_it(self):
        self.retained_reports(); request = self.preview_request(); original = workflow._prepare_action_review_draft; checked = []
        def inspect(*args, **options):
            other = open_database(self.path)
            try: other.execute("BEGIN IMMEDIATE"); other.rollback(); checked.append(True)
            finally: other.close()
            return original(*args, **options)
        with patch.object(workflow, "_prepare_action_review_draft", side_effect=inspect): self.complete(request)
        self.assertTrue(checked)
        row = dict(self.db.execute("SELECT * FROM job_runs WHERE job_type=?", (jobs.JOB_TYPE,)).fetchone())
        with self.assertRaisesRegex(WorkbenchError, "DIFFERENT_WORKER_ROLE"): command_handler(self.db, clock=lambda: AT, role="longport")(row, None)

    def test_source_withdrawal_after_prepare_returns_rejection_and_no_source_approval(self):
        self.retained_reports(); request = self.preview_request(); jobs.discover_action_review_requests(self.db, now=AT)
        lease = claim_job(self.db, "fictional-review", job_type=jobs.JOB_TYPE, lease_seconds=300, now=AT)
        row = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        descriptor = jobs.prepare_action_review_job(self.db, row, lease, clock=lambda: AT)
        other = open_database(self.path)
        try: eodhd_sources.set_authority_enabled(other, "w", "synthetic-investor", self.member["eodhd_authority_id"], False, now=AT)
        finally: other.close()
        before = self.revision(); complete_job(self.db, lease, {}, effect=descriptor["effect"], now=AT, clock=lambda: AT)
        result = json.loads(self.db.execute("SELECT document_json FROM investor_action_review_job_results WHERE request_id=?", (request["request_id"],)).fetchone()[0])
        self.assertEqual(result["outcome"], "rejected"); self.assertEqual(result["code"], "ACTION_REVIEW_SOURCE_UNAVAILABLE")
        self.assertEqual(self.revision(), before); self.assertEqual(self.db.execute("SELECT count(*) FROM investor_action_review_previews").fetchone()[0], 0)

    def test_request_expiry_after_staged_domain_writes_rolls_back_then_registers_rejection(self):
        self.retained_reports(); request = self.preview_request(); jobs.discover_action_review_requests(self.db, now=AT)
        start = "2026-11-03T06:00:13.001Z"; expired = "2026-11-03T06:05:04.001Z"; current = [start]
        original = workflow._audit
        def expires(*args, **kwargs):
            value = original(*args, **kwargs); current[0] = expired; return value
        before = self.revision()
        with patch.object(workflow, "_audit", side_effect=expires):
            done = run_one(self.db, "fictional-review", command_handler(self.db, clock=lambda: current[0]), job_type=jobs.JOB_TYPE, lease_seconds=300, clock=lambda: current[0])
        self.assertEqual(done["status"], "succeeded")
        result = json.loads(self.db.execute("SELECT document_json FROM investor_action_review_job_results WHERE request_id=?", (request["request_id"],)).fetchone()[0])
        self.assertEqual(result["code"], "ACTION_REVIEW_REQUEST_EXPIRED"); self.assertEqual(result["outcome"], "rejected")
        self.assertEqual(self.revision(), before); self.assertEqual(self.db.execute("SELECT count(*) FROM investor_action_review_previews").fetchone()[0], 0)

    def test_final_lease_loss_rolls_back_domain_and_result_and_cannot_auto_retry(self):
        self.retained_reports(); self.preview_request(); jobs.discover_action_review_requests(self.db, now=AT)
        current = [AT]; expired = "2026-11-03T06:05:04.001Z"; original = jobs._audit; before = self.revision()
        def loses_lease(*args, **kwargs):
            value = original(*args, **kwargs); current[0] = expired; return value
        with patch.object(jobs, "_audit", side_effect=loses_lease), self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            run_one(self.db, "fictional-review", command_handler(self.db, clock=lambda: current[0]), job_type=jobs.JOB_TYPE, lease_seconds=300, clock=lambda: current[0])
        self.assertEqual(self.revision(), before)
        for table in ("investor_action_review_previews", "investor_action_review_job_results"): self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
        self.assertIsNone(claim_job(self.db, "not-a-retry", job_type=jobs.JOB_TYPE, now=expired))
        job = self.db.execute("SELECT * FROM job_runs WHERE job_type=?", (jobs.JOB_TYPE,)).fetchone()
        self.assertEqual((job["status"], job["attempt_count"], job["max_attempts"]), ("failed", 1, 1)); self.assert_no_finance()

    def test_scope_readonly_and_restore_guards_precede_private_preparation(self):
        self.retained_reports(); body = {"authority_id": self.authority["id"], "expected_revision": self.revision(), "idempotency_key": "forbidden"}
        before = list(self.db.iterdump())
        with patch.object(workflow, "_prepare_action_review_draft") as private:
            with self.assertRaises(WorkbenchError): jobs.enqueue_action_review_request(self.db, "w", "foreign", "preview", body, now=AT)
            with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), self.assertRaisesRegex(WorkbenchError, "READ_ONLY"):
                jobs.enqueue_action_review_request(self.db, "w", "synthetic-investor", "preview", body, now=AT)
            private.assert_not_called()
        self.assertEqual(before, list(self.db.iterdump()))

    def test_final_confirmation_lease_loss_rolls_back_manual_review_rules_and_result(self):
        self.ready(); body = self.answers()
        jobs.enqueue_action_review_request(self.db, "w", "synthetic-investor", "confirmation", body, now=CONFIRM)
        jobs.discover_action_review_requests(self.db, now=CONFIRM)
        tables = ("investor_data_sources", "investor_data_reviews", "investor_action_authorities", "investor_action_controls", "investor_action_review_confirmations")
        before = {table: [list(row) for row in self.db.execute("SELECT rowid,* FROM " + table + " ORDER BY rowid")] for table in tables}
        revision = self.revision(); current = [CONFIRM]; original = jobs._audit
        def expires(*args, **kwargs):
            value = original(*args, **kwargs); current[0] = "2026-11-03T06:05:05.001Z"; return value
        with patch.object(jobs, "_audit", side_effect=expires), self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            run_one(self.db, "fictional-confirmation-fence", command_handler(self.db, clock=lambda: current[0]), job_type=jobs.JOB_TYPE, lease_seconds=300, clock=lambda: current[0])
        self.assertEqual(self.revision(), revision)
        self.assertEqual({table: [list(row) for row in self.db.execute("SELECT rowid,* FROM " + table + " ORDER BY rowid")] for table in tables}, before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_action_review_job_results").fetchone()[0], 1)
        self.assertIsNone(claim_job(self.db, "not-a-retry", job_type=jobs.JOB_TYPE, now=current[0])); self.assert_no_finance()

    def test_late_restore_marker_rolls_back_domain_and_job_result_together(self):
        self.retained_reports(); self.preview_request(); jobs.discover_action_review_requests(self.db, now=AT)
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"; original = jobs._audit; revision = self.revision()
        def locked(*args, **kwargs):
            value = original(*args, **kwargs); marker.touch(); return value
        try:
            with patch.object(jobs, "_audit", side_effect=locked), self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
                run_one(self.db, "fictional-restore-fence", command_handler(self.db, clock=lambda: AT), job_type=jobs.JOB_TYPE, lease_seconds=300, clock=lambda: AT)
        finally:
            if marker.exists(): marker.unlink()
        self.assertEqual(self.revision(), revision)
        for table in ("investor_action_review_previews", "investor_action_review_job_results"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
        self.assert_no_finance()


if __name__ == "__main__":
    if "--contract" in sys.argv:
        case = ActionReviewJobTests(); case.setUp()
        try:
            case.ready()
            request = jobs.enqueue_action_review_request(case.db, "w", "synthetic-investor", "confirmation", case.answers(), now=CONFIRM)
            case.complete(request, CONFIRM)
            requests = [json.loads(row[0]) for row in case.db.execute("SELECT document_json FROM investor_action_review_job_requests ORDER BY created_at,rowid")]
            results = [json.loads(row[0]) for row in case.db.execute("SELECT document_json FROM investor_action_review_job_results ORDER BY created_at,rowid")]
            print(json.dumps({"requests": requests, "results": results, "witness": case.preview}))
        finally: case.doCleanups()
    else: unittest.main()
