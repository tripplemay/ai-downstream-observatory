"""Normal TS human requests -> actual Python CLI -> fixed Node accounting publisher."""

from dataclasses import replace
from datetime import timedelta
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from worker.orchestration.csv_imports import CSV_COMMANDS, committed_csv_job, csv_request_binding, publish_csv
from worker.orchestration.db import WorkbenchError, open_database, stamp, instant, transaction
from worker.orchestration.jobs import ExternalCommit, Lease, claim_job, run_one
from worker.orchestration.runtime import role_commands, run_pending_once, sync_requests


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests/orchestration/csv-background-fixture.ts"


class ExitOnly:
    pid = 123456789
    returncode = 0

    def poll(self):
        return self.returncode


class CsvBackgroundTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="csv-background-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.path = self.directory / "workbench.db"
        self.environment = patch.dict(os.environ, {"WORKBENCH_DB_PATH": str(self.path), "WORKBENCH_DATA_DIR": str(self.directory), "WORKBENCH_MODE": "ledger"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.identity = self.fixture("create", "2")
        self.db = open_database(self.path)
        self.addCleanup(self.db.close)

    def fixture(self, action, argument, now=None):
        argv = ["node", "--import", str(ROOT / "web/node_modules/tsx/dist/loader.mjs"), str(FIXTURE), action, str(self.path), argument]
        if now:
            argv.append(stamp(now))
        result = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, timeout=45)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def lease(self, seconds=300):
        sync_requests(self.db, command_types=CSV_COMMANDS)
        lease = claim_job(self.db, "synthetic-csv-worker", lease_seconds=seconds, job_type=CSV_COMMANDS)
        self.assertIsNotNone(lease)
        return lease

    def job(self, lease):
        return dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())

    def cli(self):
        result = subprocess.run([sys.executable, "-m", "worker.orchestration", "--db", str(self.path), "--once", "--role", "core"], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["status"], "succeeded")
        return value

    def completed_lease(self, job_id):
        job = self.db.execute("SELECT * FROM job_runs WHERE id=?", (job_id,)).fetchone()
        attempt = self.db.execute("SELECT started_at FROM job_attempts WHERE job_id=? AND attempt=?", (job_id, job["attempt_count"])).fetchone()
        return Lease(job_id, "historical-owner-not-a-proof", job["fencing_token"], job["attempt_count"], stamp(instant(attempt[0]) + timedelta(seconds=300)))

    def test_normal_cli_preview_confirm_and_independent_ts_python_receipts(self):
        preview_job = self.cli()
        preview_lease = self.completed_lease(preview_job["job_id"])
        self.assertEqual(committed_csv_job(self.db, preview_lease)["status"], "succeeded")
        preview = self.fixture("read", self.identity["request_id"])
        self.assertEqual(preview["row_count"], 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM ledger_events").fetchone()[0], 0)
        confirmation = self.fixture("confirm", self.identity["request_id"])
        final_job = self.cli()
        self.assertEqual(committed_csv_job(self.db, self.completed_lease(final_job["job_id"]))["status"], "succeeded")
        final = self.fixture("read", confirmation["request_id"])
        self.assertEqual(final["confirmed_revision"], 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM ledger_events").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM csv_import_outcomes").fetchone()[0], 2)
        self.assertIsNone(run_pending_once(self.db, "idle", role="core"))
        self.assertEqual(self.fixture("read", self.identity["request_id"]), preview)

    def test_roles_only_core_dispatches_csv(self):
        for role in ("verifier", "longport"):
            self.assertFalse(set(CSV_COMMANDS) & set(role_commands(role)))
            self.assertEqual(sync_requests(self.db, command_types=role_commands(role)), [])
        self.assertEqual(len(sync_requests(self.db, command_types=role_commands("core"))), 1)

    def test_cancelled_and_expired_accepted_requests_get_terminal_jobs_without_launch(self):
        self.fixture("cancel", self.identity["request_id"])
        with patch("worker.orchestration.csv_imports.subprocess.Popen") as launch:
            with self.assertRaisesRegex(WorkbenchError, "CSV_BACKGROUND_CANCELLED"):
                run_pending_once(self.db, "worker", role="core")
            launch.assert_not_called()
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "failed")
        self.assertIsNone(run_pending_once(self.db, "worker", role="core"))

    def test_expired_request_is_not_forever_queued(self):
        expires = self.db.execute("SELECT expires_at FROM csv_background_requests").fetchone()[0]
        with patch("worker.orchestration.csv_imports.subprocess.Popen") as launch:
            with self.assertRaisesRegex(WorkbenchError, "CSV_BACKGROUND_EXPIRED"):
                run_pending_once(self.db, "worker", role="core", clock=lambda: expires)
            launch.assert_not_called()
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "failed")

    def test_short_lease_and_parent_transaction_never_start_node(self):
        lease = self.lease(149)
        with patch("worker.orchestration.csv_imports.subprocess.Popen") as launch:
            with self.assertRaisesRegex(WorkbenchError, "INSUFFICIENT_LEASE"):
                publish_csv(self.db, self.job(lease), lease)
            with transaction(self.db):
                with self.assertRaisesRegex(WorkbenchError, "REQUIRES_NO_TRANSACTION"):
                    publish_csv(self.db, self.job(lease), lease)
            launch.assert_not_called()

    def test_exit_zero_and_external_marker_are_not_receipts(self):
        lease = self.lease()
        with self.assertRaisesRegex(WorkbenchError, "DID_NOT_COMMIT"):
            publish_csv(self.db, self.job(lease), lease, process_factory=lambda *args, **kwargs: ExitOnly())
        self.assertIsNone(committed_csv_job(self.db, lease))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM import_batches").fetchone()[0], 0)

    def test_regular_success_path_cannot_bypass_external_receipt(self):
        sync_requests(self.db, command_types=CSV_COMMANDS)
        with self.assertRaisesRegex(WorkbenchError, "CSV_BACKGROUND_EXTERNAL_COMMIT_REQUIRED"):
            run_one(self.db, "worker", lambda *_: {"result": {}}, job_type=CSV_COMMANDS, lease_seconds=300)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "retry_queued")

    def test_safe_child_environment_and_fixed_lease_only_argv(self):
        lease = self.lease()
        captured = {}
        def factory(argv, **options):
            captured.update(argv=argv, **options)
            return ExitOnly()
        with patch.dict(os.environ, {"NODE_OPTIONS": "--bad", "LONGPORT_APP_SECRET": "synthetic-secret", "WORKBENCH_SESSION_SECRET": "synthetic-session", "HTTPS_PROXY": "http://invalid"}):
            with self.assertRaisesRegex(WorkbenchError, "DID_NOT_COMMIT"):
                publish_csv(self.db, self.job(lease), lease, process_factory=factory)
        self.assertEqual(set(captured["env"]), {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "WORKBENCH_DB_PATH", "WORKBENCH_DATA_DIR"})
        self.assertEqual(len(captured["argv"]), 10)
        self.assertTrue(captured["argv"][1].endswith("web/dist/csv-background.mjs"))
        self.assertIs(captured["shell"], False)
        self.assertIs(captured["start_new_session"], True)
        self.assertEqual(captured["stdout"], subprocess.DEVNULL)
        self.assertEqual(captured["stderr"], subprocess.PIPE)

    def test_lost_response_after_real_commit_recovers_without_second_attempt(self):
        sync_requests(self.db, command_types=CSV_COMMANDS)
        def handler(job, lease):
            publish_csv(self.db, job, lease)
            raise OSError("synthetic lost response after COMMIT")
        result = run_one(self.db, "worker", handler, job_type=CSV_COMMANDS, lease_seconds=300)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["attempt_count"], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM csv_background_results").fetchone()[0], 1)

    def test_running_child_timeout_stop_recovery_and_fence_loss_are_read_only(self):
        lease = self.lease()
        running = ExitOnly()
        running.returncode = None
        def stop(process):
            process.returncode = -15
        for reason in ("timeout", "stop", "recovery", "fence"):
            running.returncode = None
            options = {}
            if reason == "timeout":
                ticks = iter((0, 121))
                options["monotonic"] = lambda: next(ticks)
            elif reason == "stop":
                stop_checks = iter((False, True))
                options["stop_requested"] = lambda: next(stop_checks)
            calls = 0
            def factory(*args, **kwargs):
                if reason == "recovery":
                    (self.directory / "RESTORE_PENDING_REVIEW").touch()
                return running
            def active(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls > 1 and reason == "fence":
                    raise WorkbenchError("STALE_OR_EXPIRED_LEASE")
                return original(*args, **kwargs)
            from worker.orchestration.csv_imports import _active as original
            with patch("worker.orchestration.csv_imports._stop", side_effect=stop), patch("worker.orchestration.csv_imports._active", side_effect=active), patch("worker.orchestration.jobs.heartbeat") as heartbeat:
                with self.assertRaises(WorkbenchError):
                    publish_csv(self.db, self.job(lease), lease, process_factory=factory, **options)
                heartbeat.assert_not_called()
            (self.directory / "RESTORE_PENDING_REVIEW").unlink(missing_ok=True)
            self.assertEqual(running.returncode, -15)
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM csv_background_results").fetchone()[0], 0)

    def test_completed_receipt_rejects_other_fence_and_corrupt_manifest(self):
        finished = self.cli()
        lease = self.completed_lease(finished["job_id"])
        with self.assertRaisesRegex(WorkbenchError, "RECEIPT_INVALID"):
            committed_csv_job(self.db, replace(lease, fencing_token=lease.fencing_token + 1))
        for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='csv_import_manifests'").fetchall():
            self.db.execute('DROP TRIGGER "' + row[0] + '"')
        self.db.execute("UPDATE csv_import_manifests SET content_hash=?", ("0" * 64,))
        with self.assertRaisesRegex(WorkbenchError, "RECEIPT_INVALID"):
            committed_csv_job(self.db, lease)

    def test_raw_input_corruption_is_quarantined_once_not_dispatched(self):
        for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='csv_background_requests'").fetchall():
            self.db.execute('DROP TRIGGER "' + row[0] + '"')
        self.db.execute("UPDATE csv_background_requests SET csv_bytes=?", (b"synthetic altered raw bytes",))
        self.assertEqual(sync_requests(self.db, command_types=CSV_COMMANDS), [])
        self.assertEqual(sync_requests(self.db, command_types=CSV_COMMANDS), [])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM outbox WHERE topic='csv_background.request_invalid'").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM job_runs").fetchone()[0], 0)

    def test_maximum_raw_mapping_whitespace_preserves_cross_language_binding(self):
        previous = self.path
        self.path = self.directory / "padded.db"
        try:
            identity = self.fixture("create-padded", "1")
            other = open_database(self.path)
            self.addCleanup(other.close)
            command = other.execute("SELECT * FROM command_requests WHERE id=?", (identity["request_id"],)).fetchone()
            binding = csv_request_binding(other, command)
            self.assertEqual(len(binding["input"]["mapping"].encode()), 256 * 1024)
            self.assertGreater(len(binding["row"]["input_json"].encode()), 500000)
            self.assertEqual(len(sync_requests(other, command_types=CSV_COMMANDS)), 1)
        finally:
            self.path = previous

    def test_fixed_node_entry_blocks_network_dns_and_child_process_apis(self):
        script = r'''
          import assert from 'node:assert/strict';
          process.argv=['node','csv','--job-id','missing','--lease-owner','synthetic','--attempt','1','--fencing-token','1'];
          await import(process.env.CSV_TEST_BUNDLE);
          assert.equal(process.exitCode,1);
          const net=await import('node:net'),dns=await import('node:dns'),cp=await import('node:child_process'),wt=await import('node:worker_threads');
          for(const attempt of [()=>net.connect(1,'127.0.0.1'),()=>dns.lookup('fixture.invalid',()=>{}),
            ()=>dns.promises.resolve4('fixture.invalid'),()=>new dns.Resolver().resolve4('fixture.invalid',()=>{}),
            ()=>cp.spawn('echo',['forbidden']),()=>new wt.Worker('forbidden'),()=>fetch('http://fixture.invalid')]) {
            assert.throws(attempt,/CSV_BACKGROUND_NETWORK_FORBIDDEN/);
          }
          process.exitCode=0; process.stdout.write('guard-verified\n');
        '''
        result = subprocess.run(["node", "--input-type=module", "--eval", script], cwd=ROOT, env={**os.environ, "CSV_TEST_BUNDLE": (ROOT / "web/dist/csv-background.mjs").as_uri()}, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "guard-verified\n")
        self.assertEqual(result.stderr, "CSV_BACKGROUND_STALE_LEASE\n")

    def test_fixed_error_codes_and_output_cap_never_become_success(self):
        lease = self.lease()
        for output, expected in ((b"VERSION_CONFLICT\n", "VERSION_CONFLICT"), (b"synthetic secret details\n", "DID_NOT_COMMIT"), (b"x" * 4097, "OUTPUT_LIMIT")):
            process = ExitOnly()
            read, write = os.pipe()
            os.write(write, output)
            os.close(write)
            process.stderr = os.fdopen(read, "rb", buffering=0)
            with self.assertRaisesRegex(WorkbenchError, expected):
                publish_csv(self.db, self.job(lease), lease, process_factory=lambda *args, **kwargs: process)
            self.assertIsNone(committed_csv_job(self.db, lease))

    def test_real_confirm_receipt_corruption_matrix_is_independently_rejected(self):
        self.cli()
        confirmation = self.fixture("confirm", self.identity["request_id"])
        job = self.cli()
        lease = self.completed_lease(job["job_id"])
        mutations = (
            ("UPDATE job_runs SET input_version='wrong' WHERE id=?", (lease.job_id,)),
            ("UPDATE job_attempts SET finished_at='2000-01-01T00:00:00.000000Z' WHERE job_id=?", (lease.job_id,)),
            ("UPDATE csv_background_results SET result_hash=? WHERE request_id=?", ("0" * 64, confirmation["request_id"])),
            ("UPDATE csv_import_outcomes SET result_json='{}'", ()),
            ("UPDATE csv_import_outcomes SET result_json=json_set(result_json,'$.receipt.revision',json('true')) WHERE row_number=1", ()),
            ("UPDATE csv_import_outcomes SET result_json=json_set(result_json,'$.resolution.row',json('true')) WHERE row_number=2", ()),
            ("UPDATE ledger_events SET payload_json='{}'", ()),
            ("UPDATE csv_mapping_versions SET definition_json='{}'", ()),
            ("UPDATE audit_events SET payload_json='{}' WHERE action='request_csv_background'", ()),
            ("UPDATE import_rows SET errors_json='[\"synthetic corruption\"]'", ()),
            ("UPDATE ledger_heads SET revision=0", ()),
        )
        for sql, values in mutations:
            with self.subTest(sql=sql):
                clone = sqlite3.connect(":memory:", isolation_level=None)
                clone.row_factory = sqlite3.Row
                try:
                    self.db.backup(clone)
                    for trigger in clone.execute("SELECT name FROM sqlite_master WHERE type='trigger'").fetchall():
                        clone.execute('DROP TRIGGER "' + trigger[0] + '"')
                    clone.execute(sql, values)
                    with self.assertRaisesRegex(WorkbenchError, "RECEIPT_INVALID"):
                        committed_csv_job(clone, lease)
                finally:
                    clone.close()

    def test_review_reason_uses_ecmascript_trim_not_python_whitespace(self):
        self.cli()
        confirmation = self.fixture("confirm-unicode-reason", self.identity["request_id"])
        job = self.cli()
        lease = self.completed_lease(job["job_id"])
        self.assertEqual(committed_csv_job(self.db, lease)["status"], "succeeded")
        self.assertEqual(self.fixture("read", confirmation["request_id"])["confirmed_revision"], 2)


if __name__ == "__main__":
    unittest.main()
