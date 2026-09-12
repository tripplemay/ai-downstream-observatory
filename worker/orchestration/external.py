"""Fixed local publisher bridge; the database, not process output, is the receipt."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import time

from .db import WorkbenchError, assert_writable, instant
from .jobs import ExternalCommit, assert_lease, heartbeat


DEPLOYED_PUBLISHER = Path("/app/worker-bridge/monthly-evaluation.mjs")
LOCAL_PUBLISHER = Path(__file__).resolve().parents[2] / "web/dist/monthly-evaluation.mjs"
RESULT_KEYS = {"schema_version", "cycle_id", "evaluation_attempt_id", "outcome", "proposal_id"}


def committed_monthly_job(connection, lease):
    """Return only this lease's complete, bound domain receipt; never trust stdout."""
    job = connection.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()
    if job is None or job["status"] != "succeeded":
        return None
    if (job["job_type"] != "monthly_evaluation" or job["fencing_token"] != lease.fencing_token
            or job["attempt_count"] != lease.attempt or job["lease_owner"] is not None
            or job["lease_until"] is not None):
        raise WorkbenchError("EXTERNAL_COMMIT_LEASE_MISMATCH")
    attempt = connection.execute("""SELECT * FROM job_attempts
        WHERE job_id=? AND attempt=? AND fencing_token=? AND status='succeeded'""",
                                 (lease.job_id, lease.attempt, lease.fencing_token)).fetchone()
    try:
        result = json.loads(job["result_json"])
        if (not isinstance(result, dict) or set(result) != RESULT_KEYS
                or result["schema_version"] != "monthly-evaluation-job-result-v1"
                or result["outcome"] not in ("unchanged", "proposed", "blocked")):
            raise ValueError("shape")
        domain = connection.execute("""SELECT a.*,c.status AS cycle_status,c.outcome AS cycle_outcome,
            c.terminal_attempt_id,c.portfolio_id,r.generation,
            (SELECT MAX(n.generation) FROM evaluation_cycle_requests n WHERE n.cycle_id=c.id) AS current_generation
            FROM evaluation_attempts a
            JOIN evaluation_cycles c ON c.id=a.cycle_id
            JOIN evaluation_cycle_requests r ON r.cycle_id=c.id
            WHERE a.id=? AND a.cycle_id=? AND r.command_request_id=?""",
                                    (result["evaluation_attempt_id"], result["cycle_id"],
                                     job["command_request_id"])).fetchone()
        if (attempt is None or domain is None or domain["job_attempt_id"] != attempt["id"]
                or domain["portfolio_id"] != job["scope"]
                or domain["status"] != ("blocked" if result["outcome"] == "blocked" else "succeeded")):
            raise ValueError("binding")
        recorded_result = json.loads(domain["result_json"])
        if (not isinstance(recorded_result, dict) or recorded_result.get("outcome") != result["outcome"]
                or recorded_result.get("proposal_id") != result["proposal_id"]
                or attempt["finished_at"] is None or domain["completed_at"] is None
                or instant(attempt["finished_at"]) != instant(domain["completed_at"])
                or instant(job["updated_at"]) != instant(domain["completed_at"])):
            raise ValueError("domain result")
        if domain["generation"] == domain["current_generation"]:
            if (domain["terminal_attempt_id"] != domain["id"] or domain["cycle_outcome"] != result["outcome"]
                    or domain["cycle_status"] != ("blocked" if result["outcome"] == "blocked" else "completed")):
                raise ValueError("current terminal binding")
        elif result["outcome"] != "blocked":
            raise ValueError("completed cycle cannot reopen")
        if result["proposal_id"] is not None:
            if not isinstance(result["proposal_id"], str) or not result["proposal_id"]:
                raise ValueError("proposal")
            proposal = connection.execute("SELECT portfolio_id FROM proposals WHERE id=?",
                                          (result["proposal_id"],)).fetchone()
            if proposal is None or proposal["portfolio_id"] != job["scope"]:
                raise ValueError("proposal scope")
        if ((result["outcome"] == "proposed" and result["proposal_id"] is None)
                or (result["outcome"] == "unchanged" and result["proposal_id"] is not None)):
            raise ValueError("outcome proposal mismatch")
    except (ValueError, TypeError, KeyError) as error:
        raise WorkbenchError("EXTERNAL_COMMIT_RECEIPT_INVALID") from error
    return dict(job)


def _publisher_argv(lease):
    script = DEPLOYED_PUBLISHER if DEPLOYED_PUBLISHER.is_file() else LOCAL_PUBLISHER
    node = shutil.which("node")
    if not script.is_file() or node is None:
        raise WorkbenchError("MONTHLY_PUBLISHER_UNAVAILABLE")
    return [node, str(script), "--job-id", lease.job_id, "--lease-owner", lease.owner,
            "--fencing-token", str(lease.fencing_token), "--attempt", str(lease.attempt)]


def _stop(process):
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)


def publish_monthly(connection, job, lease, lease_seconds=300, clock=None,
                    *, process_factory=None, monotonic=None, sleep=None, max_run_seconds=300,
                    stop_requested=None):
    """Keep the lease alive while Node owns the only financial write transaction."""
    if connection.in_transaction:
        raise WorkbenchError("EXTERNAL_COMMIT_REQUIRES_NO_TRANSACTION")
    if job["job_type"] != "monthly_evaluation" or job["id"] != lease.job_id:
        raise WorkbenchError("EXTERNAL_COMMIT_JOB_TYPE_INVALID")
    if lease_seconds < 1 or max_run_seconds <= 0:
        raise WorkbenchError("INVALID_EXTERNAL_BRIDGE_TIMEOUT")
    clock = (lambda: None) if clock is None else clock
    monotonic = time.monotonic if monotonic is None else monotonic
    sleep = time.sleep if sleep is None else sleep
    process_factory = subprocess.Popen if process_factory is None else process_factory
    assert_writable(connection)
    assert_lease(connection, lease, clock())
    database = next((row[2] for row in connection.execute("PRAGMA database_list") if row[1] == "main"), None)
    if not database:
        raise WorkbenchError("EXTERNAL_COMMIT_REQUIRES_FILE_DATABASE")
    environment = {**os.environ, "WORKBENCH_DB_PATH": str(Path(database).resolve())}
    argv = _publisher_argv(lease)
    process = process_factory(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, env=environment, shell=False)
    started = monotonic()
    interval = min(30.0, lease_seconds / 3)
    next_heartbeat = started + interval
    try:
        while process.poll() is None:
            if stop_requested is not None and stop_requested():
                raise WorkbenchError("MONTHLY_PUBLISHER_INTERRUPTED")
            current = monotonic()
            if current - started >= max_run_seconds:
                raise WorkbenchError("MONTHLY_PUBLISHER_TIMEOUT")
            if current >= next_heartbeat:
                if committed_monthly_job(connection, lease) is not None:
                    _stop(process)
                    return ExternalCommit()
                heartbeat(connection, lease, lease_seconds, now=clock())
                next_heartbeat = current + interval
            sleep(min(0.2, max(0.01, next_heartbeat - current)))
        if committed_monthly_job(connection, lease) is None:
            raise WorkbenchError("MONTHLY_PUBLISHER_DID_NOT_COMMIT:" + str(process.returncode))
        return ExternalCommit()
    except BaseException:
        _stop(process)
        # A lost response, a timeout or a heartbeat racing a successful commit
        # cannot turn an already committed financial result into a new attempt.
        if committed_monthly_job(connection, lease) is not None:
            return ExternalCommit()
        raise
