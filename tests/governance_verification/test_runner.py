from datetime import timedelta
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from worker.governance_verification.binding import job_binding
from worker.governance_verification.checker import check_bytes, strict_json
from worker.governance_verification.fixture import _initialize, execute_fixture
from worker.governance_verification.runner import prepare_verification
from worker.governance_verification.process import bounded_process
from worker.governance_verification.source import BUNDLE, SIDECAR, source_manifest
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash, instant, open_database, stamp
from worker.orchestration.jobs import claim_job, complete_job
from worker.orchestration.runtime import role_commands, run_pending_once, sync_requests


NOW = instant("2026-01-05T00:00:00.000000Z")


class VerificationRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="etf-verification-integration-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "workbench.db"
        _initialize(self.path)
        self.node = shutil.which("node")
        self.argv = [self.node, str(ROOT / "web/node_modules/tsx/dist/cli.mjs"),
                     str(ROOT / "tests/governance_verification/request.ts"), str(self.path)]
        result = subprocess.run(self.argv, cwd=ROOT, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.receipt = strict_json(result.stdout)
        self.db = open_database(self.path)
        self.addCleanup(self.db.close)

    def job(self):
        return sync_requests(self.db, now=NOW, command_types=role_commands("verifier"))[0]

    def test_normal_request_dispatch_lease_real_execution_and_independent_ts_read(self):
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_requests").fetchone()[0], 1)
        self.assertIsNone(run_pending_once(self.db, "core-worker", role="core", clock=lambda: NOW))
        result = run_pending_once(self.db, "verifier", role="verifier", clock=lambda: NOW)
        self.assertEqual(result["status"], "succeeded")
        artifact = self.db.execute("SELECT * FROM verification_artifacts").fetchone()
        checked = check_bytes(bytes(artifact["body"]), artifact["body_sha256"])
        self.assertEqual(checked["status"], "pass")
        self.assertEqual(self.db.execute("SELECT count(*) FROM ledger_events").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM valuation_runs").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM performance_runs").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM activations").fetchone()[0], 0)
        self.assertIsNone(run_pending_once(self.db, "verifier", role="verifier", clock=lambda: NOW))
        state = subprocess.run([*self.argv, "read"], cwd=ROOT, capture_output=True, timeout=30)
        self.assertEqual(state.returncode, 0, state.stderr.decode())
        view = strict_json(state.stdout)["requests"][0]
        self.assertEqual(view["evidence_issues"], [])
        self.assertEqual(view["execution"]["status"], "pass")
        replay = subprocess.run([*self.argv, "replay"], cwd=ROOT, capture_output=True, timeout=30)
        self.assertEqual(replay.returncode, 0, replay.stderr.decode())
        self.assertEqual(strict_json(replay.stdout)["request_id"], self.receipt["request_id"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_requests").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_executions").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='governance_verification.completed'").fetchone()[0], 1)

    def test_no_direct_pass_without_controlled_execution(self):
        self.job()
        lease = claim_job(self.db, "verifier", now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "VERIFICATION_EXECUTION_REQUIRED"):
            complete_job(self.db, lease, {"status": "pass"}, now=NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_artifacts").fetchone()[0], 0)

    def test_damaged_orphan_request_is_diagnosed_without_starving_normal_request(self):
        payload = {"schema_version": "verification-request-v2", "verification_request_id": "damaged-orphan",
                   "portfolio_id": self.receipt["portfolio_id"], "check_id": self.receipt["check_id"], "context_hash": self.receipt["context_hash"]}
        self.db.execute("""INSERT INTO command_requests(id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at)
            VALUES('damaged-orphan',?,'governance_verification_v2','damaged-orphan',?,?,'system:governance-verifier-v2',?)""",
            (self.receipt["portfolio_id"], content_hash(payload), canonical_json(payload), stamp(NOW - timedelta(days=1))))
        result = run_pending_once(self.db, "verifier", role="verifier", clock=lambda: NOW)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='governance_verification.request_invalid'").fetchone()[0], 1)
        self.assertIsNone(run_pending_once(self.db, "verifier", role="verifier", clock=lambda: NOW))
        self.assertIsNone(self.db.execute("SELECT id FROM job_runs WHERE command_request_id='damaged-orphan'").fetchone())

    def test_expired_fence_cannot_publish_prepared_real_artifact_and_retry_can(self):
        self.job()
        old = claim_job(self.db, "old", lease_seconds=1, now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (old.job_id,)).fetchone())
        prepared = prepare_verification(self.db, job, old, lease_seconds=1, clock=lambda: NOW)
        fresh = claim_job(self.db, "new", now=NOW + timedelta(seconds=2))
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            complete_job(self.db, old, {}, effect=prepared["effect"], now=NOW + timedelta(seconds=2))
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_executions").fetchone()[0], 0)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (fresh.job_id,)).fetchone())
        prepared = prepare_verification(self.db, job, fresh, clock=lambda: NOW + timedelta(seconds=2))
        complete_job(self.db, fresh, {}, effect=prepared["effect"], now=NOW + timedelta(seconds=2))
        self.assertEqual(self.db.execute("SELECT status FROM verification_executions").fetchone()[0], "pass")

    def test_recovery_marker_after_prepare_rolls_back_evidence(self):
        self.job()
        lease = claim_job(self.db, "verifier", now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        prepared = prepare_verification(self.db, job, lease, clock=lambda: NOW)
        (self.path.parent / "RESTORE_PENDING_REVIEW").touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            complete_job(self.db, lease, {}, effect=prepared["effect"], now=NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_executions").fetchone()[0], 0)

    def test_child_failure_creates_failed_attempt_not_trusted_execution(self):
        with patch("worker.governance_verification.runner.bounded_process", side_effect=ValueError("VERIFICATION_PROCESS_FAILED:7")):
            with self.assertRaisesRegex(ValueError, "PROCESS_FAILED"):
                run_pending_once(self.db, "verifier", role="verifier", clock=lambda: NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_attempts").fetchone()[0], "failed")
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "retry_queued")
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_executions").fetchone()[0], 0)

    def test_notification_failure_rolls_back_artifact_execution_and_terminal_state(self):
        with patch("worker.governance_verification.runner.enqueue_notification", side_effect=ValueError("SYNTHETIC_NOTIFICATION_FAILURE")):
            with self.assertRaisesRegex(ValueError, "SYNTHETIC_NOTIFICATION_FAILURE"):
                run_pending_once(self.db, "verifier", role="verifier", clock=lambda: NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_artifacts").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_executions").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='governance_verification.completed'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT status FROM job_attempts").fetchone()[0], "failed")
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "retry_queued")

    def test_lease_expiring_during_final_commit_rolls_back_all_evidence(self):
        self.job()
        lease = claim_job(self.db, "verifier", lease_seconds=1, now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        prepared = prepare_verification(self.db, job, lease, lease_seconds=1, clock=lambda: NOW)
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            complete_job(self.db, lease, {}, effect=prepared["effect"], now=NOW, clock=lambda: NOW + timedelta(seconds=2))
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_artifacts").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_executions").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='governance_verification.completed'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "running")

    def test_child_cannot_supply_its_own_identity_or_emit_stderr(self):
        self.job()
        lease = claim_job(self.db, "verifier", now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        outputs = ((b'{"binding":{}}', b"", "CHILD_ENVELOPE_INVALID"),
                   (b'{}', b"unexpected warning", "UNEXPECTED_STDERR"),
                   (b'{"process":{},"process":{}}', b"", "DUPLICATE_JSON_KEY"))
        for output, errors, code in outputs:
            with self.subTest(code=code), patch("worker.governance_verification.runner.bounded_process", return_value=(output, errors)):
                with self.assertRaisesRegex(ValueError, code):
                    prepare_verification(self.db, job, lease, clock=lambda: NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_artifacts").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_executions").fetchone()[0], 0)

    def test_worker_stop_requested_prevents_execution_evidence(self):
        with self.assertRaisesRegex(WorkbenchError, "VERIFICATION_INTERRUPTED"):
            run_pending_once(self.db, "verifier", role="verifier", clock=lambda: NOW, stop_requested=lambda: True)
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_executions").fetchone()[0], 0)

    def test_fault_injected_actual_output_is_recorded_as_failed_subcheck(self):
        artifact = execute_fixture()
        result = strict_json(artifact["performance"]["run"]["result_json"])
        result["net_profit_cny"] = "50.125"
        artifact["performance"]["run"]["result_json"] = canonical_json(result)
        with patch("worker.governance_verification.runner.bounded_process", return_value=(canonical_json(artifact).encode(), b"")):
            job = run_pending_once(self.db, "verifier", role="verifier", clock=lambda: NOW)
        self.assertEqual(job["status"], "failed")
        self.assertEqual(self.db.execute("SELECT status FROM verification_executions").fetchone()[0], "fail")
        state = subprocess.run([*self.argv, "read"], cwd=ROOT, capture_output=True, timeout=30)
        self.assertEqual(state.returncode, 0, state.stderr.decode())
        view = strict_json(state.stdout)["requests"][0]
        self.assertEqual(view["evidence_issues"], [])
        self.assertEqual(view["execution"]["status"], "fail")

    def test_cross_scope_and_stale_source_refused(self):
        self.job()
        lease = claim_job(self.db, "verifier", now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        with self.assertRaisesRegex(WorkbenchError, "JOB_BINDING_INVALID"):
            job_binding(self.db, {**job, "scope": "other"}, lease)
        with patch("worker.governance_verification.source.source_manifest", return_value={"schema_version": "verification-source-v2", "files": {}}):
            with self.assertRaisesRegex(WorkbenchError, "REQUEST_INVALID"):
                prepare_verification(self.db, job, lease, clock=lambda: NOW)

    def test_source_change_while_child_runs_cannot_publish_evidence(self):
        current = source_manifest()
        with patch("worker.governance_verification.source.source_manifest", side_effect=[current, {"schema_version": "verification-source-v2", "files": {}}]):
            with self.assertRaisesRegex(WorkbenchError, "REQUEST_INVALID"):
                run_pending_once(self.db, "verifier", role="verifier", clock=lambda: NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_artifacts").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM verification_executions").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT status FROM job_attempts").fetchone()[0], "failed")

    def test_real_delayed_child_heartbeats_current_lease(self):
        began = time.monotonic()
        clock = lambda: NOW + timedelta(seconds=time.monotonic() - began)
        def delayed(argv, **options):
            argv = [*argv[:-1], "import time;time.sleep(0.45);" + argv[-1]]
            return bounded_process(argv, **options)
        with patch("worker.governance_verification.runner.bounded_process", side_effect=delayed):
            result = run_pending_once(self.db, "verifier", role="verifier", lease_seconds=1, clock=clock)
        self.assertEqual(result["status"], "succeeded")
        attempt = self.db.execute("SELECT * FROM job_attempts").fetchone()
        self.assertGreater(instant(result["heartbeat_at"]), instant(attempt["started_at"]) + timedelta(seconds=.2))

    def test_dedicated_cli_role_does_not_need_supplier_credentials(self):
        environment = {**os.environ, "LONGPORT_APP_KEY": "SYNTHETIC-NOT-A-CREDENTIAL",
                       "LONGPORT_APP_SECRET": "SYNTHETIC-NOT-A-CREDENTIAL", "NODE_OPTIONS": "--require /not-allowed"}
        result = subprocess.run([sys.executable, "-m", "worker.orchestration", "--db", str(self.path), "--once", "--role", "verifier"],
                                cwd=ROOT, env=environment, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(strict_json(result.stdout)["status"], "succeeded")
        self.assertEqual(self.db.execute("SELECT count(*) FROM ledger_events").fetchone()[0], 0)


class SourceInventoryTests(unittest.TestCase):
    def setUp(self):
        current = source_manifest()
        self.temp = tempfile.TemporaryDirectory(prefix="etf-verification-source-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for relative in current["files"]:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        self.assertEqual(source_manifest(self.root), current)

    def node_source(self, *, build=False):
        if build:
            program = ("import {sourceFiles} from " + json.dumps((ROOT / "scripts/verification-source.mjs").as_uri())
                       + ";process.stdout.write(JSON.stringify(sourceFiles(process.argv[1]))+'\\n');")
            argv = [shutil.which("node"), "--input-type=module", "-e", program, str(self.root)]
        else:
            argv = [shutil.which("node"), str(ROOT / "web/node_modules/tsx/dist/cli.mjs"),
                    str(ROOT / "tests/governance_verification/source.ts"), str(self.root)]
        return subprocess.run(argv, cwd=ROOT, capture_output=True, timeout=30)

    def test_python_node_build_and_typescript_source_inventory_are_identical(self):
        current = source_manifest(self.root)
        build = self.node_source(build=True)
        self.assertEqual(build.returncode, 0, build.stderr.decode())
        self.assertEqual(strict_json(build.stdout), {name: value for name, value in current["files"].items() if name not in (BUNDLE, SIDECAR)})
        server = self.node_source()
        self.assertEqual(server.returncode, 0, server.stderr.decode())
        self.assertEqual(strict_json(server.stdout), current)

    def test_changed_source_new_source_or_bundle_rejects_stale_build(self):
        for relative in ("worker/governance_verification/runner.py", "worker/governance_verification/unexpected.py", "web/dist/governance-fixture.mjs"):
            with self.subTest(relative=relative):
                path = self.root / relative
                previous = path.read_bytes() if path.exists() else None
                path.write_bytes((previous or b"") + b"\n# changed\n")
                try:
                    with self.assertRaisesRegex(ValueError, "STALE_FIXTURE_BUILD"):
                        source_manifest(self.root)
                    self.assertNotEqual(self.node_source().returncode, 0)
                finally:
                    if previous is None: path.unlink()
                    else: path.write_bytes(previous)

    def test_symlink_to_internal_file_or_directory_rejected(self):
        path = self.root / "scripts/verification-source.mjs"
        other = self.root / "scripts/copied-source.mjs"
        path.rename(other)
        path.symlink_to(other)
        with self.assertRaisesRegex(ValueError, "SYMLINK"):
            source_manifest(self.root)
        self.assertNotEqual(self.node_source().returncode, 0)
        self.assertNotEqual(self.node_source(build=True).returncode, 0)

        path.unlink()
        other.rename(path)
        original = self.root / "scripts"
        alternate = self.root / "internal-scripts"
        original.rename(alternate)
        original.symlink_to(alternate, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "SYMLINK"):
            source_manifest(self.root)
        self.assertNotEqual(self.node_source().returncode, 0)
        self.assertNotEqual(self.node_source(build=True).returncode, 0)

    def test_namespace_initializer_cannot_change_unlisted_python_entrypoint(self):
        (self.root / "worker/__init__.py").write_text("raise RuntimeError('unexpected namespace initializer')\n")
        with self.assertRaisesRegex(ValueError, "NAMESPACE_INITIALIZER_FORBIDDEN"):
            source_manifest(self.root)
        self.assertNotEqual(self.node_source().returncode, 0)
        self.assertNotEqual(self.node_source(build=True).returncode, 0)

    def test_missing_inventory_directory_is_not_silently_omitted(self):
        shutil.rmtree(self.root / "worker/accounting")
        with self.assertRaisesRegex(ValueError, "SOURCE_INVALID"):
            source_manifest(self.root)
        self.assertNotEqual(self.node_source().returncode, 0)
        self.assertNotEqual(self.node_source(build=True).returncode, 0)
