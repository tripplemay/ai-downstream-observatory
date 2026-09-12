from datetime import timedelta
import json
import unittest
from unittest.mock import patch

from worker.orchestration import (
    WorkbenchError, claim_job, complete_job, enqueue_job, enqueue_notification,
    fail_job, heartbeat, open_database, run_one,
)
from worker.orchestration.db import canonical_json, content_hash, stamp
from worker.orchestration.runtime import run_pending_once, sync_requests

from tests.market.support import NOW, database, document, ledger_event, rules, seed_account


class JobTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = database(self)
        seed_account(self.db)

    def enqueue(self, max_attempts=3):
        return enqueue_job(self.db, "valuation", "p", "2025-01-03", "input-v1", max_attempts=max_attempts, now=NOW)

    def test_job_identity_dedup_and_different_configuration_conflict(self):
        first = self.enqueue()
        self.assertEqual(self.enqueue()["id"], first["id"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM job_runs").fetchone()[0], 1)
        with self.assertRaisesRegex(WorkbenchError, "IDEMPOTENCY_CONFLICT"):
            self.enqueue(max_attempts=4)

    def test_only_one_owner_claims_a_job(self):
        self.enqueue()
        other = open_database(self.path)
        self.addCleanup(other.close)
        first = claim_job(self.db, "worker1", now=NOW)
        self.assertIsNotNone(first)
        self.assertIsNone(claim_job(other, "worker2", now=NOW))

    def test_expiry_fencing_blocks_old_worker_commit(self):
        self.enqueue()
        stale = claim_job(self.db, "worker1", lease_seconds=5, now=NOW)
        current = claim_job(self.db, "worker2", now=NOW + timedelta(seconds=6))
        self.assertGreater(current.fencing_token, stale.fencing_token)
        self.assertEqual(current.attempt, 2)
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED"):
            complete_job(self.db, stale, {"bad": True}, now=NOW + timedelta(seconds=6))
        complete_job(self.db, current, {"ok": True}, now=NOW + timedelta(seconds=7))
        statuses = [row[0] for row in self.db.execute("SELECT status FROM job_attempts ORDER BY attempt")]
        self.assertEqual(statuses, ["lease_expired", "succeeded"])

    def test_heartbeat_cannot_resurrect_expired_lease(self):
        self.enqueue()
        lease = claim_job(self.db, "worker", lease_seconds=5, now=NOW)
        refreshed = heartbeat(self.db, lease, lease_seconds=10, now=NOW + timedelta(seconds=4))
        self.assertEqual(refreshed.fencing_token, lease.fencing_token)
        self.assertIsNone(claim_job(self.db, "other", now=NOW + timedelta(seconds=6)))
        with self.assertRaises(WorkbenchError):
            heartbeat(self.db, lease, now=NOW + timedelta(seconds=15))

    def test_failure_not_success_backoff_and_retry_budget(self):
        self.enqueue(max_attempts=2)
        first = claim_job(self.db, "worker", now=NOW)
        status = fail_job(self.db, first, {"code": "NETWORK"}, now=NOW)
        self.assertEqual(status, "retry_queued")
        self.assertIsNone(claim_job(self.db, "worker", now=NOW + timedelta(seconds=29)))
        second = claim_job(self.db, "worker", now=NOW + timedelta(seconds=30))
        status = fail_job(self.db, second, {"code": "NETWORK"}, now=NOW + timedelta(seconds=31))
        self.assertEqual(status, "failed")
        self.assertIsNone(claim_job(self.db, "worker", now=NOW + timedelta(days=1)))
        self.assertEqual([row[0] for row in self.db.execute("SELECT status FROM job_attempts ORDER BY attempt")], ["failed", "failed"])

    def test_partial_and_expiry_exhaustion_are_not_success(self):
        self.enqueue(max_attempts=1)
        lease = claim_job(self.db, "worker", now=NOW)
        self.assertEqual(fail_job(self.db, lease, {"missing_pages": [2]}, partial=True, now=NOW), "partial")
        other = enqueue_job(self.db, "valuation", "p", "2025-01-04", "input-v2", max_attempts=1, now=NOW)
        claim_job(self.db, "worker", lease_seconds=1, now=NOW)
        self.assertIsNone(claim_job(self.db, "other", now=NOW + timedelta(seconds=2)))
        self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (other["id"],)).fetchone()[0], "failed")

    def test_effect_job_and_outbox_commit_atomically(self):
        self.enqueue()
        lease = claim_job(self.db, "worker", now=NOW)
        notification = {"dedup_key": "job:done", "topic": "valuation.complete", "payload": {"quality": "complete"}}
        complete_job(self.db, lease, {"done": True}, notification=notification, now=NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "succeeded")
        self.assertEqual(self.db.execute("SELECT status FROM outbox").fetchone()[0], "pending")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM notification_attempts").fetchone()[0], 0)
        self.assertEqual(enqueue_notification(self.db, **notification, now=NOW), self.db.execute("SELECT id FROM outbox").fetchone()[0])
        with self.assertRaises(WorkbenchError):
            enqueue_notification(self.db, "job:done", "different", {}, now=NOW)

    def test_failed_effect_rolls_back_all_results(self):
        self.enqueue()
        lease = claim_job(self.db, "worker", now=NOW)
        def effect(db):
            enqueue_notification(db, "never-committed", "test", {}, now=NOW)
            raise RuntimeError("simulated crash before commit")
        with self.assertRaises(RuntimeError):
            complete_job(self.db, lease, {}, effect=effect, now=NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "running")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0)

    def test_run_one_failure_records_attempt_without_silent_success(self):
        self.enqueue()
        def failing_handler(row, lease):
            raise ValueError("bad input")
        with self.assertRaises(ValueError):
            run_one(self.db, "worker", failing_handler, clock=lambda: NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "retry_queued")
        self.assertIn("bad input", self.db.execute("SELECT error_json FROM job_attempts").fetchone()[0])

    def test_runtime_restore_marker_and_read_only_refuse_new_writes(self):
        self.enqueue()
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        marker.touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            claim_job(self.db, "worker", now=NOW)
        marker.unlink()
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}):
            with self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
                enqueue_notification(self.db, "read-only", "test", {}, now=NOW)

    def test_restore_marker_created_during_effect_rolls_back_commit(self):
        self.enqueue()
        lease = claim_job(self.db, "worker", now=NOW)
        def effect(db):
            enqueue_notification(db, "not-committed", "test", {}, now=NOW)
            (self.path.parent / "RESTORE_PENDING_REVIEW").touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            complete_job(self.db, lease, {}, effect=effect, now=NOW)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "running")

    def test_lease_expiring_during_effect_rolls_back_commit(self):
        self.enqueue()
        lease = claim_job(self.db, "worker", lease_seconds=1, now=NOW)
        def effect(db):
            enqueue_notification(db, "expired-effect", "test", {}, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED"):
            complete_job(self.db, lease, {}, effect=effect, now=NOW, clock=lambda: NOW + timedelta(seconds=2))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "running")


class DispatcherTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = database(self)
        seed_account(self.db)

    def request(self, name, kind, payload):
        self.db.execute("""INSERT INTO command_requests
            (id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at)
            VALUES(?,'p',?,?,?,?, 'test',?)""", (name, kind, name, content_hash(payload), canonical_json(payload), stamp(NOW)))

    def test_explicit_valuation_request_runs_once_and_writes_immutable_result(self):
        ledger_event(self.db, "opening", [("cash_settled", "100000"), ("opening_equity", "-100000")])
        self.request("req:1", "valuation", {"cutoff_at": stamp(NOW), "rules": rules()})
        self.assertEqual(len(sync_requests(self.db, now=NOW)), 1)
        self.assertEqual(len(sync_requests(self.db, now=NOW)), 0)
        result = run_pending_once(self.db, "worker", clock=lambda: NOW)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(json.loads(result["result_json"])["nav_cny"], "100000")
        self.assertIsNone(run_pending_once(self.db, "worker", clock=lambda: NOW))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM valuation_runs").fetchone()[0], 1)

    def test_partial_ingestion_persists_evidence_without_success_or_publication(self):
        data = document()
        data["batch"]["expected_pages"] = 2
        data["batch"]["expected_rows"] = 2
        self.request("req:partial", "market_ingest", {"document": data, "publish": True})
        result = run_pending_once(self.db, "worker", clock=lambda: NOW)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(self.db.execute("SELECT status FROM market_batches").fetchone()[0], "partial")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_batch_pages").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_publications").fetchone()[0], 0)

    def test_unrelated_job_types_not_claimed(self):
        self.request("req:unrelated", "not_implemented", {})
        enqueue_job(self.db, "research_external", "p", "2025-01-03", "v1", now=NOW)
        self.assertIsNone(run_pending_once(self.db, "worker", clock=lambda: NOW))
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "queued")


if __name__ == "__main__":
    unittest.main()
