"""Container-only synthetic verifier execution, never a governance acceptance claim."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile

sys.path.insert(0, "/app")
from worker.governance_verification.checker import check_bytes, strict_json
from worker.governance_verification.fixture import _initialize
from worker.governance_verification.source import BUNDLE, SIDECAR, source_manifest
from worker.orchestration.db import ROOT, canonical_json, content_hash, open_database
from worker.orchestration.runtime import role_commands


def require(condition, message):
    if not condition:
        raise SystemExit(message)


require((os.getuid(), os.getgid()) == (10001, 10001), "Verifier must be unprivileged")
require(ROOT == Path("/app"), "Verifier source root differs from deployed source root")
require({name for _, name in socket.if_nameindex()} == {"lo"}, "Verifier network is not disabled")
require(not any(key.startswith("LONGPORT_") or key in ("WORKBENCH_PASSWORD_HASH", "WORKBENCH_SESSION_SECRET") for key in os.environ),
        "Verifier inherited unrelated credentials")
require(role_commands("verifier") == ("governance_verification_v2",), "Verifier role is not isolated")
require("governance_verification_v2" not in role_commands("core") + role_commands("longport"), "Another role may consume verification work")
source = source_manifest()
web = strict_json(sys.argv[1])
expected_web = {"schema_version": "verification-image-source-smoke-v1", "source_manifest_sha256": content_hash(source),
                "bundle_sha256": source["files"][BUNDLE], "sidecar_sha256": source["files"][SIDECAR],
                "source_file_count": len(source["files"])}
require(web == expected_web, "Web and worker fixed source inventories or bundles differ")
with tempfile.TemporaryDirectory(prefix="verification-container-smoke-") as directory:
    path = Path(directory) / "synthetic.db"
    _initialize(path)
    bridge = [shutil.which("node"), str(ROOT / "web/dist/verification-container-bridge.mjs")]
    requested = subprocess.run([*bridge, "request", str(path)], cwd=ROOT, capture_output=True, text=True, timeout=30)
    require(requested.returncode == 0 and not requested.stderr, "Normal TS request service failed: " + requested.stderr[:2000])
    receipt = strict_json(requested.stdout)
    require(receipt["status"] == "queued", "Normal request did not queue")
    db = open_database(path)
    try:
        require(db.execute("SELECT COUNT(*) FROM verification_requests").fetchone()[0] == 1, "TS request replay duplicated work")
        argv = [sys.executable, "-m", "worker.orchestration", "--db", str(path), "--once", "--role"]
        core = subprocess.run([*argv, "core"], cwd=ROOT, capture_output=True, text=True, timeout=30)
        require(core.returncode == 0 and not core.stdout and not core.stderr, "Core role consumed verifier work")
        require(db.execute("SELECT COUNT(*) FROM job_runs").fetchone()[0] == 0, "Core role queued verifier work")
        run = subprocess.run([*argv, "verifier"], cwd=ROOT, capture_output=True, text=True, timeout=120)
        require(run.returncode == 0 and not run.stderr, "Verifier CLI did not complete: " + run.stderr[:2000])
        job = db.execute("SELECT * FROM job_runs").fetchone()
        execution = db.execute("SELECT * FROM verification_executions").fetchone()
        artifact = db.execute("SELECT * FROM verification_artifacts").fetchone()
        require(job is not None and execution is not None and artifact is not None, "Verifier did not persist all evidence")
        require(strict_json(run.stdout) == {"job_id": job["id"], "status": "succeeded"}, "Verifier CLI receipt mismatch")
        result = check_bytes(bytes(artifact["body"]), artifact["body_sha256"])
        require(result["status"] == "pass" and result["gate_eligible"] is False and result["completed_requirements"] == [], "Verifier overstated acceptance")
        require(execution["result_hash"] == content_hash(result) and strict_json(execution["result_json"]) == result, "Persisted result differs from independent recheck")
        require(execution["artifact_sha256"] == hashlib.sha256(bytes(artifact["body"])).hexdigest(), "Artifact bytes mismatch")
        read = subprocess.run([*bridge, "read", str(path)], cwd=ROOT, capture_output=True, text=True, timeout=30)
        require(read.returncode == 0 and not read.stderr, "Independent TS proof rejected execution: " + read.stderr[:2000])
        proof = strict_json(read.stdout)
        require(proof == {"request_id": receipt["request_id"], "status": "pass", "independent_ts_proof": True,
                          "downloaded_artifact_sha256": artifact["body_sha256"], "gate_eligible": False}, "Independent TS proof receipt mismatch")
        for table in ("ledger_events", "postings", "valuation_runs", "performance_runs", "proposals", "reservations", "activations", "governance_verification_runs"):
            require(db.execute('SELECT COUNT(*) FROM "' + table + '"').fetchone()[0] == 0, "Synthetic execution leaked into request database: " + table)
        repeat = subprocess.run([*argv, "verifier"], cwd=ROOT, capture_output=True, text=True, timeout=30)
        require(repeat.returncode == 0 and not repeat.stdout and not repeat.stderr, "Verifier repeated a completed request")
        require(db.execute("SELECT COUNT(*) FROM verification_executions").fetchone()[0] == 1, "Verifier duplicated evidence")
        require(source_manifest() == source, "Execution changed fixed source")
        print(canonical_json({"schema_version": "verification-container-smoke-v1", "status": "passed", "runtime_uid": os.getuid(),
            "sqlite_schema_version": db.execute("PRAGMA user_version").fetchone()[0], "source_manifest_sha256": content_hash(source),
            "bundle_path": "/app/" + BUNDLE, "bundle_sha256": source["files"][BUNDLE], "sidecar_sha256": source["files"][SIDECAR],
            "source_file_count": len(source["files"]), "web_worker_sources_equal": True, "network_disabled": True,
            "credentials_present": False, "verifier_role_isolated": True, "fixed_node_fixture_executed": True,
            "normal_ts_request": True, "independent_ts_proof": True, "persisted_blob_rechecked": True,
            "request_financial_rows": 0, "acceptance_scope": "engineering_subcheck",
            "data_provenance": "synthetic", "gate_eligible": False, "completed_requirements": []}))
    finally:
        db.close()
