"""Explicit collection commands through real jobs, with synthetic HTTP bytes."""

from datetime import timedelta
import json
import os
import unittest
from unittest.mock import patch

from worker.market.collection import persist_collection, prepare_collection, verify_provider_capture
from worker.orchestration.db import WorkbenchError, instant, stamp
from worker.orchestration.jobs import claim_job
from worker.orchestration.runtime import run_pending_once, sync_requests
from tests.market.test_collection import add_request, db_state, fake_download, fixture, payload, utc_now


class MarketCollectionRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = fixture(self)

    def request(self, value=None, identity="synthetic-runtime-collection"):
        return add_request(self.db, identity, payload() if value is None else value)

    def run_worker(self, **kwargs):
        return run_pending_once(self.db, "synthetic-runtime-worker", lease_seconds=300, clock=utc_now, **kwargs)

    def no_market_effects(self):
        for table in ("market_provider_captures", "market_batches", "market_batch_pages", "market_batch_members",
                      "market_observations", "market_publications", "market_publication_events"):
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0], 0, table)

    def test_real_dispatch_downloads_outside_transaction_and_commits_with_same_fence(self):
        request = self.request()
        facts_before = [tuple(row) for row in self.db.execute("SELECT * FROM ledger_events")]
        boundaries = []
        def prepare(db, command, job, lease):
            boundaries.append(("prepare", db.in_transaction, lease.fencing_token))
            return prepare_collection(db, command, job, lease)
        def persist(db, prepared, **kwargs):
            boundaries.append(("persist", db.in_transaction, prepared.receipt["fencing_token"]))
            return persist_collection(db, prepared, **kwargs)
        with patch("worker.orchestration.runtime.prepare_collection", prepare), \
                patch("worker.orchestration.runtime.persist_collection", persist), \
                patch("worker.market.collection.download_ecb_xml", fake_download(inspect=lambda: self.assertFalse(self.db.in_transaction))) as download:
            job = self.run_worker()
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual(job["command_request_id"], request["id"])
        self.assertEqual(boundaries, [("prepare", False, job["fencing_token"]), ("persist", True, job["fencing_token"])])
        result = json.loads(job["result_json"])
        self.assertEqual(result["batch_status"], "published")
        self.assertFalse(result["live_advice_eligible"])
        proof = verify_provider_capture(self.db, result["batch_id"])
        self.assertEqual(proof["id"], result["capture_id"])
        attempt = self.db.execute("SELECT * FROM job_attempts WHERE job_id=?", (job["id"],)).fetchone()
        self.assertEqual((attempt["status"], attempt["attempt"], attempt["fencing_token"]), ("succeeded", 1, job["fencing_token"]))
        self.assertEqual([tuple(row) for row in self.db.execute("SELECT * FROM ledger_events")], facts_before)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0)

    def test_repeat_dispatch_keeps_one_job_attempt_capture_and_publication(self):
        self.request()
        with patch("worker.market.collection.download_ecb_xml", side_effect=fake_download()) as download:
            first = self.run_worker()
            before = db_state(self.db)
            self.assertEqual(sync_requests(self.db, now=utc_now()), [])
            self.assertIsNone(self.run_worker())
            self.assertEqual(db_state(self.db), before)
            download.assert_called_once_with("daily")
        self.assertEqual(first["status"], "succeeded")
        for table in ("job_runs", "job_attempts", "market_provider_captures", "market_publication_events"):
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0], 1, table)

    def test_failed_transport_retries_without_leaking_details_or_publishing_partial_data(self):
        self.request()
        with patch("worker.market.collection.download_ecb_xml", side_effect=RuntimeError("synthetic-sensitive-response-marker")):
            with self.assertRaisesRegex(WorkbenchError, "^PROVIDER_COLLECTION_FAILED$"):
                self.run_worker()
        self.no_market_effects()
        job = self.db.execute("SELECT * FROM job_runs").fetchone()
        self.assertEqual(job["status"], "retry_queued")
        failed_attempt = dict(self.db.execute("SELECT * FROM job_attempts").fetchone())
        self.assertEqual(failed_attempt["status"], "failed")
        self.assertEqual(json.loads(failed_attempt["error_json"]), {"code": "WorkbenchError", "message": "PROVIDER_COLLECTION_FAILED"})
        self.assertNotIn("synthetic-sensitive-response-marker", job["result_json"])
        self.assertGreater(instant(job["not_before"]), utc_now())
        # Advance only the disposable retry readiness, not the provider's clock.
        self.db.execute("UPDATE job_runs SET not_before=? WHERE id=?", (stamp(utc_now() - timedelta(seconds=1)), job["id"]))
        with patch("worker.market.collection.download_ecb_xml", fake_download()):
            succeeded = self.run_worker()
        self.assertEqual((succeeded["status"], succeeded["attempt_count"]), ("succeeded", 2))
        self.assertEqual(dict(self.db.execute("SELECT * FROM job_attempts WHERE id=?", (failed_attempt["id"],)).fetchone()), failed_attempt)
        receipt = json.loads(self.db.execute("SELECT receipt_json FROM market_provider_captures").fetchone()[0])
        self.assertEqual((receipt["attempt"], receipt["fencing_token"]), (2, succeeded["fencing_token"]))
        verify_provider_capture(self.db, json.loads(succeeded["result_json"])["batch_id"])

    def test_retries_are_bounded_and_never_create_a_fake_success_receipt(self):
        self.request()
        with patch("worker.market.collection.download_ecb_xml", side_effect=RuntimeError("synthetic failure")) as download:
            for attempt in range(1, 4):
                with self.assertRaisesRegex(WorkbenchError, "PROVIDER_COLLECTION_FAILED"):
                    self.run_worker()
                job = self.db.execute("SELECT * FROM job_runs").fetchone()
                self.assertEqual(job["attempt_count"], attempt)
                self.assertEqual(job["status"], "failed" if attempt == 3 else "retry_queued")
                self.db.execute("UPDATE job_runs SET not_before=? WHERE id=?", (stamp(utc_now() - timedelta(seconds=1)), job["id"]))
            before = db_state(self.db)
            self.assertIsNone(self.run_worker())
            self.assertEqual(db_state(self.db), before)
            self.assertEqual(download.call_count, 3)
        self.no_market_effects()
        self.assertEqual([row[0] for row in self.db.execute("SELECT status FROM job_attempts ORDER BY attempt")], ["failed"] * 3)

    def test_uncommitted_persistence_failure_rolls_back_capture_and_head_together(self):
        self.request()
        def fail_after_insert(db, prepared, **kwargs):
            persist_collection(db, prepared, **kwargs)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM market_provider_captures").fetchone()[0], 1)
            raise WorkbenchError("SYNTHETIC_COMMIT_INTERRUPTED")
        with patch("worker.market.collection.download_ecb_xml", fake_download()), \
                patch("worker.orchestration.runtime.persist_collection", fail_after_insert):
            with self.assertRaisesRegex(WorkbenchError, "SYNTHETIC_COMMIT_INTERRUPTED"):
                self.run_worker()
        self.no_market_effects()
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "retry_queued")
        self.assertEqual(self.db.execute("SELECT status FROM job_attempts").fetchone()[0], "failed")

    def test_expired_and_reclaimed_worker_cannot_commit_or_fail_the_new_attempt(self):
        self.request()
        reclaimed = []
        def reclaim():
            running = self.db.execute("SELECT * FROM job_runs").fetchone()
            reclaimed.append(claim_job(self.db, "synthetic-other-worker", 300, "market_collect", now=running["lease_until"]))
        with patch("worker.market.collection.download_ecb_xml", fake_download(inspect=reclaim)):
            with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
                self.run_worker()
        self.no_market_effects()
        job = self.db.execute("SELECT * FROM job_runs").fetchone()
        self.assertEqual((job["status"], job["attempt_count"], job["fencing_token"]), ("running", 2, reclaimed[0].fencing_token))
        self.assertEqual([row[0] for row in self.db.execute("SELECT status FROM job_attempts ORDER BY attempt")], ["lease_expired", "running"])

    def test_recovery_marker_appearing_during_download_blocks_publication(self):
        self.request()
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        with patch("worker.market.collection.download_ecb_xml", fake_download(inspect=marker.touch)):
            with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
                self.run_worker()
        self.no_market_effects()
        before = db_state(self.db)
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            self.run_worker()
        self.assertEqual(db_state(self.db), before)

    def test_read_only_environment_does_not_claim_or_download(self):
        self.request()
        before = db_state(self.db)
        with patch.dict(os.environ, {"WORKBENCH_MODE": "read_only"}), \
                patch("worker.market.collection.download_ecb_xml") as download:
            with self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
                self.run_worker()
            download.assert_not_called()
        self.assertEqual(db_state(self.db), before)

    def test_unsafe_payload_is_not_downloaded_or_echoed_into_attempt_errors(self):
        self.request({**payload(), "url": "https://synthetic-sensitive-host.invalid/path?token=synthetic-private-marker"})
        with patch("worker.market.collection.download_ecb_xml") as download:
            with self.assertRaisesRegex(WorkbenchError, "^INVALID_MARKET_COLLECT$"):
                self.run_worker()
            download.assert_not_called()
        self.no_market_effects()
        self.assertEqual(json.loads(self.db.execute("SELECT error_json FROM job_attempts").fetchone()[0]),
                         {"code": "WorkbenchError", "message": "INVALID_MARKET_COLLECT"})

    def test_stale_publication_revision_is_rejected_before_another_download(self):
        self.request()
        with patch("worker.market.collection.download_ecb_xml", fake_download()):
            first = self.run_worker()
        original = {name: rows for name, rows in db_state(self.db).items() if name.startswith("market_")}
        self.request(identity="synthetic-stale-cas")
        with patch("worker.market.collection.download_ecb_xml") as download:
            with self.assertRaisesRegex(WorkbenchError, "STALE_PUBLICATION_REVISION"):
                self.run_worker()
            download.assert_not_called()
        self.assertEqual({name: rows for name, rows in db_state(self.db).items() if name.startswith("market_")}, original)
        verify_provider_capture(self.db, json.loads(first["result_json"])["batch_id"])

    def test_cross_scope_job_is_refused_before_download(self):
        self.request()
        sync_requests(self.db, now=utc_now())
        self.db.execute("UPDATE job_runs SET scope='synthetic-other-portfolio'")
        with patch("worker.market.collection.download_ecb_xml") as download:
            with self.assertRaisesRegex(WorkbenchError, "COMMAND_JOB_SCOPE_MISMATCH"):
                self.run_worker()
            download.assert_not_called()
        self.no_market_effects()

    def test_stop_requested_after_download_leaves_no_capture_or_publication(self):
        self.request()
        stopped = [False]
        with patch("worker.market.collection.download_ecb_xml", fake_download(inspect=lambda: stopped.__setitem__(0, True))):
            with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
                self.run_worker(stop_requested=lambda: stopped[0])
        self.no_market_effects()
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "retry_queued")


if __name__ == "__main__":
    unittest.main()
