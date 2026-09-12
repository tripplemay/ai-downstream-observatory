"""Controlled process seams verify fencing, not a real financial publisher."""

from datetime import timedelta
import json
import subprocess
import unittest
from unittest.mock import patch

from tests.market.support import NOW
from tests.orchestration.test_evaluations import EvaluationFixture, domain_commit
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, open_database, stamp, transaction
from worker.orchestration.external import committed_monthly_job, publish_monthly
from worker.orchestration.jobs import ExternalCommit, claim_job, complete_job, fail_job, run_one
from worker.orchestration.runtime import run_pending_once


class FakeProcess:
    def __init__(self, complete=None, polls=0, code=0):
        self.complete, self.polls, self.code = complete, polls, code
        self.returncode = None
        self.terminated = False

    def poll(self):
        if self.returncode is not None:
            return self.returncode
        if self.polls:
            self.polls -= 1
            return None
        if self.complete:
            action, self.complete = self.complete, None
            action()
        self.returncode = self.code
        return self.returncode

    def terminate(self):
        self.terminated, self.returncode = True, -15

    def kill(self):
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


class EvaluationBridgeTests(EvaluationFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.schedule()
        self.cycles, self.jobs = self.dispatch()
        self.argv_patch = patch("worker.orchestration.external._publisher_argv",
                                side_effect=lambda lease: ["node", "/fixed/synthetic-publisher.mjs", "--job-id", lease.job_id])
        self.argv_patch.start()
        self.addCleanup(self.argv_patch.stop)

    def bridge(self, lease, process, **options):
        return publish_monthly(self.db, self.jobs[0], lease, clock=lambda: NOW,
                               process_factory=lambda *args, **kwargs: process, **options)

    def test_node_can_commit_on_separate_connection_without_python_write_lock(self):
        lease = self.claim()
        other = open_database(self.path)
        self.addCleanup(other.close)
        def commit():
            self.assertFalse(self.db.in_transaction)
            domain_commit(other, lease)
        self.assertIsInstance(self.bridge(lease, FakeProcess(commit)), ExternalCommit)
        self.assertEqual(committed_monthly_job(self.db, lease)["status"], "succeeded")

    def test_bridge_inside_python_transaction_never_starts_process(self):
        lease = self.claim()
        with transaction(self.db):
            with self.assertRaisesRegex(WorkbenchError, "REQUIRES_NO_TRANSACTION"):
                self.bridge(lease, FakeProcess())

    def test_process_exit_zero_without_database_receipt_is_not_success(self):
        lease = self.claim()
        with self.assertRaisesRegex(WorkbenchError, "DID_NOT_COMMIT:0"):
            self.bridge(lease, FakeProcess())
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "running")

    def test_lost_response_or_nonzero_exit_after_commit_recovers_exact_receipt(self):
        lease = self.claim()
        self.assertIsInstance(self.bridge(lease, FakeProcess(lambda: domain_commit(self.db, lease), code=137)), ExternalCommit)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM evaluation_attempts").fetchone()[0], 1)

    def test_external_marker_without_bound_result_is_rejected_and_retried(self):
        with self.assertRaisesRegex(WorkbenchError, "EXTERNAL_COMMIT_RECEIPT_REQUIRED"):
            run_one(self.db, "synthetic-worker", lambda job, lease: ExternalCommit(),
                    job_type="monthly_evaluation", clock=lambda: NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "retry_queued")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM evaluation_attempts").fetchone()[0], 0)

    def test_monthly_handler_cannot_use_the_python_result_commit_path(self):
        with self.assertRaisesRegex(WorkbenchError, "MONTHLY_EVALUATION_EXTERNAL_COMMIT_REQUIRED"):
            run_one(self.db, "synthetic-worker", lambda job, lease: {"result": {"outcome": "unchanged"}},
                    job_type="monthly_evaluation", clock=lambda: NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "retry_queued")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM evaluation_attempts").fetchone()[0], 0)

    def test_run_one_does_not_complete_twice_or_relabel_lost_success(self):
        def handler(job, lease):
            domain_commit(self.db, lease)
            raise RuntimeError("synthetic response loss")
        result = run_one(self.db, "synthetic-worker", handler, job_type="monthly_evaluation", clock=lambda: NOW)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(self.db.execute("SELECT attempt_count FROM job_runs").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM evaluation_attempts").fetchone()[0], 1)

    def test_plain_success_without_domain_attempt_fails_receipt_validation(self):
        lease = self.claim()
        complete_job(self.db, lease, {"schema_version": "monthly-evaluation-job-result-v1",
                                     "cycle_id": self.cycles[0], "evaluation_attempt_id": "not-present",
                                     "outcome": "unchanged", "proposal_id": None}, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "RECEIPT_INVALID"):
            committed_monthly_job(self.db, lease)

    def test_stale_worker_cannot_accept_newer_attempt_success(self):
        stale = self.claim(seconds=1)
        newer = claim_job(self.db, "new-worker", job_type="monthly_evaluation", now=NOW + timedelta(seconds=2))
        domain_commit(self.db, newer, NOW + timedelta(seconds=2))
        with self.assertRaisesRegex(WorkbenchError, "LEASE_MISMATCH"):
            committed_monthly_job(self.db, stale)

    def test_parent_poll_renews_lease_without_sharing_connection_across_threads(self):
        lease = self.claim(seconds=3)
        elapsed = [0.0]
        process = FakeProcess(lambda: domain_commit(self.db, lease, NOW + timedelta(seconds=elapsed[0])), polls=18)
        def sleep(seconds):
            elapsed[0] += seconds
        result = publish_monthly(self.db, self.jobs[0], lease, lease_seconds=3,
                                 clock=lambda: NOW + timedelta(seconds=elapsed[0]),
                                 process_factory=lambda *args, **kwargs: process,
                                 monotonic=lambda: elapsed[0], sleep=sleep)
        self.assertIsInstance(result, ExternalCommit)
        self.assertGreater(self.db.execute("SELECT heartbeat_at FROM job_runs").fetchone()[0], stamp(NOW))
        self.assertGreater(elapsed[0], 3)

    def test_heartbeat_racing_success_returns_receipt_instead_of_retry(self):
        lease = self.claim(seconds=3)
        elapsed = [0.0]
        process = FakeProcess(polls=100)
        def sleep(seconds):
            elapsed[0] += seconds
            if elapsed[0] >= 1 and self.db.execute("SELECT status FROM job_runs").fetchone()[0] == "running":
                domain_commit(self.db, lease, NOW + timedelta(seconds=elapsed[0]))
        result = publish_monthly(self.db, self.jobs[0], lease, lease_seconds=3,
                                 clock=lambda: NOW + timedelta(seconds=elapsed[0]),
                                 process_factory=lambda *args, **kwargs: process,
                                 monotonic=lambda: elapsed[0], sleep=sleep)
        self.assertIsInstance(result, ExternalCommit)
        self.assertTrue(process.terminated)

    def test_timeout_terminates_child_without_fabricating_success(self):
        lease = self.claim()
        process = FakeProcess(polls=100)
        times = iter([0.0, 0.0, 2.0])
        with self.assertRaisesRegex(WorkbenchError, "PUBLISHER_TIMEOUT"):
            self.bridge(lease, process, monotonic=lambda: next(times), sleep=lambda seconds: None, max_run_seconds=1)
        self.assertTrue(process.terminated)
        self.assertIsNone(committed_monthly_job(self.db, lease))

    def test_shutdown_and_restore_during_work_terminate_old_child(self):
        lease = self.claim()
        process = FakeProcess(polls=100)
        with self.assertRaisesRegex(WorkbenchError, "PUBLISHER_INTERRUPTED"):
            self.bridge(lease, process, stop_requested=lambda: True)
        self.assertTrue(process.terminated)
        (self.path.parent / "RESTORE_PENDING_REVIEW").touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            self.bridge(lease, FakeProcess())

    def test_lost_lease_terminates_child_and_cannot_change_new_attempt(self):
        lease = self.claim(seconds=1)
        elapsed = [0.0]
        process = FakeProcess(polls=100)
        newer = []
        def sleep(seconds):
            elapsed[0] = 2.0
            if not newer:
                newer.append(claim_job(self.db, "new-worker", job_type="monthly_evaluation",
                                       now=NOW + timedelta(seconds=2)))
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED"):
            publish_monthly(self.db, self.jobs[0], lease, lease_seconds=1,
                            clock=lambda: NOW + timedelta(seconds=elapsed[0]),
                            process_factory=lambda *args, **kwargs: process,
                            monotonic=lambda: elapsed[0], sleep=sleep)
        self.assertTrue(process.terminated)
        self.assertEqual(self.db.execute("SELECT lease_owner FROM job_runs").fetchone()[0], "new-worker")
        domain_commit(self.db, newer[0], NOW + timedelta(seconds=2))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM evaluation_attempts").fetchone()[0], 1)

    def test_fixed_publisher_argument_shape_contains_lease_identity_only(self):
        from worker.orchestration import external
        lease = self.claim()
        self.argv_patch.stop()
        with patch.object(external.DEPLOYED_PUBLISHER.__class__, "is_file", return_value=True), \
                patch("worker.orchestration.external.shutil.which", return_value="/fixed/node"):
            self.assertEqual(external._publisher_argv(lease), ["/fixed/node", "/app/worker-bridge/monthly-evaluation.mjs",
                "--job-id", lease.job_id, "--lease-owner", lease.owner, "--fencing-token", str(lease.fencing_token),
                "--attempt", str(lease.attempt)])

    def test_subprocess_inherits_verified_database_not_a_request_path(self):
        lease = self.claim()
        def factory(argv, **options):
            self.assertEqual(options["env"]["WORKBENCH_DB_PATH"], str(self.path.resolve()))
            self.assertFalse(options["shell"])
            self.assertEqual(options["stdin"], subprocess.DEVNULL)
            self.assertNotIn("payload", " ".join(argv))
            return FakeProcess(lambda: domain_commit(self.db, lease))
        with patch.dict("os.environ", {"WORKBENCH_DB_PATH": "/not/the/active/database"}):
            self.assertIsInstance(publish_monthly(self.db, self.jobs[0], lease, clock=lambda: NOW,
                                                  process_factory=factory), ExternalCommit)

    def test_runtime_routes_monthly_to_controlled_external_branch(self):
        def publisher(db, job, lease, **options):
            self.assertFalse(db.in_transaction)
            domain_commit(db, lease, outcome="blocked")
            return ExternalCommit()
        with patch("worker.orchestration.runtime.publish_monthly", side_effect=publisher):
            result = run_pending_once(self.db, "synthetic-worker", clock=lambda: NOW)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(json.loads(result["result_json"])["outcome"], "blocked")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM ledger_events").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM approval_events").fetchone()[0], 0)

    def test_old_success_receipt_survives_immediate_human_retry_generation(self):
        lease = self.claim()
        domain_commit(self.db, lease, outcome="blocked")
        payload = {"cycle_id": self.cycles[0]}
        with transaction(self.db):
            self.db.execute("""UPDATE evaluation_cycles SET status='pending',outcome=NULL,completed_at=NULL,
                terminal_attempt_id=NULL,state_revision=state_revision+1 WHERE id=?""", (self.cycles[0],))
            self.db.execute("""INSERT INTO command_requests VALUES
                ('quick-retry','p','monthly_evaluation','quick-retry',?,?,'synthetic-human',?)""",
                            (content_hash(payload), canonical_json(payload), stamp(NOW)))
            self.db.execute("""INSERT INTO evaluation_cycle_requests VALUES
                ('quick-retry',?,2,'synthetic-human','Explicit synthetic retry',?)""", (self.cycles[0], stamp(NOW)))
        self.assertEqual(committed_monthly_job(self.db, lease)["status"], "succeeded")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM evaluation_attempts").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
