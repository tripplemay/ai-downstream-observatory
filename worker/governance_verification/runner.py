"""Fenced controlled runner: private evidence writes only, synthetic finance elsewhere."""

from hashlib import sha256
import sys
import tempfile
import time

from worker.orchestration.db import ROOT, WorkbenchError, assert_writable, canonical_json, content_hash, new_id, stamp, instant
from worker.orchestration.jobs import JobCommit, assert_lease, heartbeat, enqueue_notification
from .binding import job_binding
from .checker import check_bytes, strict_json, MAX_ARTIFACT_BYTES
from .process import bounded_process, clean_environment


def prepare_verification(connection, job, lease, *, lease_seconds=300, clock=None, stop_requested=None):
    clock = (lambda: None) if clock is None else clock
    if connection.in_transaction:
        raise WorkbenchError("VERIFICATION_EXECUTION_REQUIRES_NO_TRANSACTION")
    assert_writable(connection)
    assert_lease(connection, lease, clock())
    request, context, attempt = job_binding(connection, job, lease)
    started = stamp(clock())
    if instant(started) < instant(attempt["started_at"]):
        raise WorkbenchError("VERIFICATION_CLOCK_REGRESSION")
    next_heartbeat = time.monotonic() + min(30, lease_seconds / 3)
    def health():
        nonlocal next_heartbeat
        if stop_requested is not None and stop_requested():
            raise WorkbenchError("VERIFICATION_INTERRUPTED")
        assert_writable(connection)
        assert_lease(connection, lease, clock())
        if time.monotonic() >= next_heartbeat:
            heartbeat(connection, lease, lease_seconds, clock())
            next_heartbeat = time.monotonic() + min(30, lease_seconds / 3)
    with tempfile.TemporaryDirectory(prefix="etf-verifier-runtime-") as directory:
        # -I rejects user site/PYTHONPATH; only this fixed, hash-bound source root is added.
        program = "import runpy,sys;sys.path.insert(0," + repr(str(ROOT)) + ");runpy.run_module('worker.governance_verification.fixture',run_name='__main__')"
        output, stderr = bounded_process([sys.executable, "-I", "-B", "-c", program],
            environment=clean_environment(directory), cwd=ROOT, health=health, timeout=60, output_limit=MAX_ARTIFACT_BYTES - 4096)
    if stderr:
        raise WorkbenchError("VERIFICATION_UNEXPECTED_STDERR")
    health()
    job_binding(connection, job, lease)
    artifact = strict_json(output)
    # Do not let child output choose its lease or identity envelope.
    if not isinstance(artifact, dict) or any(key in artifact for key in ("binding", "started_at", "finished_at")):
        raise WorkbenchError("VERIFICATION_CHILD_ENVELOPE_INVALID")
    if artifact.get("fixture", {}).get("portfolio_id") == request["portfolio_id"]:
        raise WorkbenchError("VERIFICATION_SYNTHETIC_SCOPE_REQUIRED")
    finished = stamp(clock())
    if instant(finished) < instant(started):
        raise WorkbenchError("VERIFICATION_CLOCK_REGRESSION")
    artifact.update(binding={"request_id": request["id"], "job_id": job["id"], "attempt_id": attempt["id"],
                             "attempt": lease.attempt, "fencing_token": lease.fencing_token, "context_hash": request["context_hash"]},
                    started_at=started, finished_at=finished)
    body = canonical_json(artifact).encode()
    result = check_bytes(body)
    execution_id, artifact_id = new_id("verification-execution"), new_id("verification-artifact")
    digest, result_hash = sha256(body).hexdigest(), content_hash(result)
    job_result = {"schema_version": "verification-job-result-v2", "request_id": request["id"],
                  "execution_id": execution_id, "context_hash": request["context_hash"],
                  "result_hash": result_hash, "status": result["status"]}
    def persist(db):
        health()
        current_request, current_context, _ = job_binding(db, job, lease)
        if current_request != request or current_context != context or check_bytes(body, digest) != result:
            raise WorkbenchError("VERIFICATION_PREPARED_CHANGED")
        recorded = stamp(clock())
        db.execute("""INSERT INTO verification_artifacts(id,request_id,job_id,attempt,fencing_token,kind,body,body_sha256,created_at)
            VALUES(?,?,?,?,?,'execution',?,?,?)""", (artifact_id, request["id"], job["id"], lease.attempt, lease.fencing_token, body, digest, recorded))
        db.execute("""INSERT INTO verification_executions(id,request_id,job_id,attempt_id,attempt,fencing_token,context_hash,
            artifact_id,artifact_sha256,result_json,result_hash,status,execution_authority,data_provenance,acceptance_scope,
            started_at,finished_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'controlled_runner','synthetic','engineering_subcheck',?,?,?)""",
            (execution_id, request["id"], job["id"], attempt["id"], lease.attempt, lease.fencing_token, request["context_hash"],
             artifact_id, digest, canonical_json(result), result_hash, result["status"], started, finished, recorded))
        enqueue_notification(db, "verification:" + execution_id, "governance_verification.completed", job_result, now=recorded)
        return JobCommit(job_result, {"pass": "succeeded", "fail": "failed", "blocked": "skipped"}[result["status"]])
    return {"effect": persist}


def assert_finalization(connection, job, lease, job_result, outcome, now):
    request, _, attempt = job_binding(connection, job, lease)
    execution = connection.execute("SELECT * FROM verification_executions WHERE job_id=?", (job["id"],)).fetchone()
    if execution is None:
        raise WorkbenchError("VERIFICATION_EXECUTION_REQUIRED")
    artifact = connection.execute("SELECT * FROM verification_artifacts WHERE id=?", (execution["artifact_id"],)).fetchone()
    if artifact is None:
        raise WorkbenchError("VERIFICATION_ARTIFACT_REQUIRED")
    body = bytes(artifact["body"])
    checked = check_bytes(body, execution["artifact_sha256"])
    envelope = strict_json(body)
    expected_binding = {"request_id": request["id"], "job_id": job["id"], "attempt_id": attempt["id"],
                        "attempt": lease.attempt, "fencing_token": lease.fencing_token, "context_hash": request["context_hash"]}
    expected_result = {"schema_version": "verification-job-result-v2", "request_id": request["id"],
                       "execution_id": execution["id"], "context_hash": request["context_hash"],
                       "result_hash": content_hash(checked), "status": checked["status"]}
    if (job_result != expected_result or envelope.get("binding") != expected_binding
            or envelope["fixture"]["portfolio_id"] == request["portfolio_id"]
            or strict_json(execution["result_json"]) != checked or execution["result_hash"] != content_hash(checked)
            or execution["request_id"] != request["id"] or execution["attempt_id"] != attempt["id"]
            or execution["attempt"] != lease.attempt or execution["fencing_token"] != lease.fencing_token
            or execution["context_hash"] != request["context_hash"] or execution["status"] != checked["status"]
            or execution["execution_authority"] != "controlled_runner" or execution["data_provenance"] != "synthetic"
            or execution["acceptance_scope"] != "engineering_subcheck"
            or artifact["request_id"] != request["id"] or artifact["job_id"] != job["id"]
            or artifact["attempt"] != lease.attempt or artifact["fencing_token"] != lease.fencing_token
            or artifact["body_sha256"] != execution["artifact_sha256"] or artifact["kind"] != "execution"
            or envelope.get("started_at") != execution["started_at"] or envelope.get("finished_at") != execution["finished_at"]
            or not instant(attempt["started_at"]) <= instant(execution["started_at"]) <= instant(execution["finished_at"]) <= instant(execution["recorded_at"]) <= instant(now)
            or not instant(execution["finished_at"]) <= instant(artifact["created_at"]) <= instant(execution["recorded_at"])
            or outcome != {"pass": "succeeded", "fail": "failed", "blocked": "skipped"}[checked["status"]]):
        raise WorkbenchError("VERIFICATION_FINALIZATION_INVALID")
