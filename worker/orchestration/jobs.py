"""Persistent jobs with attempt history and fenced, lease-checked commits."""

from dataclasses import dataclass
from datetime import timedelta
import json

from .db import WorkbenchError, canonical_json, instant, new_id, stamp, transaction


@dataclass(frozen=True)
class Lease:
    job_id: str
    owner: str
    fencing_token: int
    attempt: int
    lease_until: str


@dataclass(frozen=True)
class JobCommit:
    result: object
    outcome: str = "succeeded"


@dataclass(frozen=True)
class ExternalCommit:
    """Only a fixed local publisher may complete this job outside our transaction."""


def _positive_int(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise WorkbenchError(name + "_MUST_BE_POSITIVE_INTEGER")
    return value


def enqueue_job(connection, job_type, scope, period, input_version, max_attempts=3,
                not_before=None, command_request_id=None, now=None):
    if not all(isinstance(value, str) and value.strip() for value in (job_type, scope, period, input_version)):
        raise WorkbenchError("JOB_IDENTITY_REQUIRED")
    _positive_int(max_attempts, "MAX_ATTEMPTS")
    created, ready = stamp(now), stamp(not_before if not_before is not None else now)
    with transaction(connection):
        existing = connection.execute(
            "SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?",
            (job_type, scope, period, input_version)).fetchone()
        if existing:
            if existing["max_attempts"] != max_attempts or existing["command_request_id"] != command_request_id:
                raise WorkbenchError("JOB_IDEMPOTENCY_CONFLICT")
            return dict(existing)
        job_id = new_id("job")
        connection.execute("""INSERT INTO job_runs
            (id,command_request_id,job_type,scope,period,input_version,status,max_attempts,not_before,created_at,updated_at)
            VALUES(?,?,?,?,?,?,'queued',?,?,?,?)""",
                           (job_id, command_request_id, job_type, scope, period, input_version,
                            max_attempts, ready, created, created))
        return dict(connection.execute("SELECT * FROM job_runs WHERE id=?", (job_id,)).fetchone())


def _expire(connection, current):
    rows = connection.execute("SELECT * FROM job_runs WHERE status='running' AND lease_until<=?", (current,)).fetchall()
    for row in rows:
        connection.execute("""UPDATE job_attempts SET status='lease_expired',finished_at=?,error_json=?
            WHERE job_id=? AND attempt=? AND status='running'""",
                           (current, canonical_json({"code": "LEASE_EXPIRED"}), row["id"], row["attempt_count"]))
        status = "retry_queued" if row["attempt_count"] < row["max_attempts"] else "failed"
        connection.execute("""UPDATE job_runs SET status=?,lease_owner=NULL,lease_until=NULL,
            fencing_token=fencing_token+1,not_before=?,updated_at=?,result_json=? WHERE id=?""",
                           (status, current, current, canonical_json({"code": "LEASE_EXPIRED"}), row["id"]))
        if row["job_type"] == "monthly_evaluation" and status == "failed":
            from .evaluations import fail_exhausted_cycle
            fail_exhausted_cycle(connection, row["id"], current)


def claim_job(connection, owner, lease_seconds=60, job_type=None, now=None):
    if not isinstance(owner, str) or not owner.strip():
        raise WorkbenchError("LEASE_OWNER_REQUIRED")
    _positive_int(lease_seconds, "LEASE_SECONDS")
    current = stamp(now)
    with transaction(connection):
        _expire(connection, current)
        query = "SELECT * FROM job_runs WHERE status IN ('queued','retry_queued') AND not_before<=? AND attempt_count<max_attempts"
        parameters = [current]
        # Provider credentials share a bounded connection budget across workers.
        # SQLite's immediate transaction makes this global price-job mutex atomic.
        query += """ AND (job_type != 'market_collect_prices' OR NOT EXISTS (
            SELECT 1 FROM job_runs active WHERE active.job_type='market_collect_prices'
              AND active.status='running' AND active.lease_until>?))"""
        parameters.append(current)
        if isinstance(job_type, tuple):
            if not job_type or any(not isinstance(value, str) or not value for value in job_type):
                raise WorkbenchError("INVALID_JOB_TYPE_FILTER")
            query += " AND job_type IN (" + ",".join("?" for _ in job_type) + ")"
            parameters.extend(job_type)
        elif job_type is not None:
            query += " AND job_type=?"
            parameters.append(job_type)
        row = connection.execute(query + " ORDER BY not_before,created_at,id LIMIT 1", parameters).fetchone()
        if row is None:
            return None
        until = stamp(instant(current) + timedelta(seconds=lease_seconds))
        token, attempt = row["fencing_token"] + 1, row["attempt_count"] + 1
        connection.execute("""UPDATE job_runs SET status='running',lease_owner=?,lease_until=?,
            fencing_token=?,heartbeat_at=?,attempt_count=?,updated_at=? WHERE id=?""",
                           (owner, until, token, current, attempt, current, row["id"]))
        connection.execute("""INSERT INTO job_attempts(id,job_id,attempt,fencing_token,status,started_at)
            VALUES(?,?,?,?,'running',?)""", (new_id("attempt"), row["id"], attempt, token, current))
        if row["job_type"] == "monthly_evaluation":
            from .evaluations import start_cycle
            start_cycle(connection, row["id"], current)
        return Lease(row["id"], owner, token, attempt, until)


def assert_lease(connection, lease, now=None):
    row = connection.execute("""SELECT * FROM job_runs WHERE id=? AND status='running'
        AND lease_owner=? AND fencing_token=? AND attempt_count=? AND lease_until>?""",
                             (lease.job_id, lease.owner, lease.fencing_token, lease.attempt, stamp(now))).fetchone()
    if row is None:
        raise WorkbenchError("STALE_OR_EXPIRED_LEASE")
    return row


def heartbeat(connection, lease, lease_seconds=60, now=None):
    _positive_int(lease_seconds, "LEASE_SECONDS")
    current = stamp(now)
    with transaction(connection):
        assert_lease(connection, lease, current)
        until = stamp(instant(current) + timedelta(seconds=lease_seconds))
        connection.execute("UPDATE job_runs SET heartbeat_at=?,lease_until=?,updated_at=? WHERE id=?",
                           (current, until, current, lease.job_id))
        return Lease(lease.job_id, lease.owner, lease.fencing_token, lease.attempt, until)


def enqueue_notification(connection, dedup_key, topic, payload, max_attempts=3, now=None):
    """Persist only. A separate transport must handle at-least-once delivery."""
    _positive_int(max_attempts, "MAX_ATTEMPTS")
    if not dedup_key or not topic:
        raise WorkbenchError("NOTIFICATION_IDENTITY_REQUIRED")
    body, current = canonical_json(payload), stamp(now)
    with transaction(connection):
        existing = connection.execute("SELECT * FROM outbox WHERE dedup_key=?", (dedup_key,)).fetchone()
        if existing:
            if existing["topic"] != topic or existing["payload_json"] != body:
                raise WorkbenchError("NOTIFICATION_IDEMPOTENCY_CONFLICT")
            return existing["id"]
        notification_id = new_id("notice")
        connection.execute("""INSERT INTO outbox
            (id,dedup_key,topic,payload_json,status,max_attempts,not_before,created_at)
            VALUES(?,?,?,?,'pending',?,?,?)""",
                           (notification_id, dedup_key, topic, body, max_attempts, current, current))
        return notification_id


def complete_job(connection, lease, result, outcome="succeeded", effect=None, notification=None, now=None, clock=None):
    if outcome not in ("succeeded", "skipped", "partial", "failed"):
        raise WorkbenchError("INVALID_SUCCESS_OUTCOME")
    current = stamp(now)
    with transaction(connection):
        assert_lease(connection, lease, current)
        if effect is not None:
            committed = effect(connection)
            if isinstance(committed, JobCommit):
                result, outcome = committed.result, committed.outcome
                if outcome not in ("succeeded", "skipped", "partial", "failed"):
                    raise WorkbenchError("INVALID_COMMIT_OUTCOME")
        if notification is not None:
            enqueue_notification(connection, notification["dedup_key"], notification["topic"],
                                 notification["payload"], now=current)
        finished = stamp(clock()) if clock is not None else current
        if instant(finished) < instant(current):
            raise WorkbenchError("JOB_CLOCK_REGRESSION")
        assert_lease(connection, lease, now=finished)
        finalizing_job = connection.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()
        if finalizing_job["job_type"] == "governance_verification_v2":
            from worker.governance_verification.runner import assert_finalization
            assert_finalization(connection, finalizing_job, lease, result, outcome, finished)
            finished = stamp(clock()) if clock is not None else finished
            if instant(finished) < instant(current):
                raise WorkbenchError("JOB_CLOCK_REGRESSION")
            assert_lease(connection, lease, now=finished)
        if outcome == "succeeded":
            job = connection.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()
            if job["job_type"] == "market_collect":
                from .collections import assert_collection_finalization
                request = connection.execute("SELECT * FROM command_requests WHERE id=?", (job["command_request_id"],)).fetchone()
                assert_collection_finalization(connection, request, job, lease, now=finished)
            elif job["job_type"] == "market_collect_prices":
                from .price_collections import assert_price_collection_finalization
                request = connection.execute("SELECT * FROM command_requests WHERE id=?", (job["command_request_id"],)).fetchone()
                assert_price_collection_finalization(connection, request, job, lease, now=finished)
        connection.execute("""UPDATE job_attempts SET status=?,finished_at=? WHERE job_id=? AND attempt=?""",
                           (outcome, finished, lease.job_id, lease.attempt))
        connection.execute("""UPDATE job_runs SET status=?,result_json=?,lease_owner=NULL,lease_until=NULL,
            updated_at=? WHERE id=?""", (outcome, canonical_json(result), finished, lease.job_id))


def fail_job(connection, lease, error, retryable=True, partial=False, retry_delay_seconds=30, now=None):
    if isinstance(retry_delay_seconds, bool) or not isinstance(retry_delay_seconds, int) or retry_delay_seconds < 0:
        raise WorkbenchError("INVALID_RETRY_DELAY")
    current, payload = stamp(now), canonical_json(error)
    with transaction(connection):
        row = assert_lease(connection, lease, current)
        retry = retryable and row["attempt_count"] < row["max_attempts"]
        status = "retry_queued" if retry else "partial" if partial else "failed"
        ready = stamp(instant(current) + timedelta(seconds=retry_delay_seconds * (2 ** (lease.attempt - 1))))
        connection.execute("UPDATE job_attempts SET status=?,finished_at=?,error_json=? WHERE job_id=? AND attempt=?",
                           ("partial" if partial else "failed", current, payload, lease.job_id, lease.attempt))
        connection.execute("""UPDATE job_runs SET status=?,result_json=?,not_before=?,lease_owner=NULL,
                           lease_until=NULL,updated_at=? WHERE id=?""", (status, payload, ready, current, lease.job_id))
        if row["job_type"] == "monthly_evaluation" and not retry:
            from .evaluations import fail_exhausted_cycle
            fail_exhausted_cycle(connection, lease.job_id, current)
        return status


def run_one(connection, owner, handler, job_type=None, lease_seconds=60, clock=None):
    """Compute outside the write transaction; return a short fenced commit effect."""
    clock = (lambda: None) if clock is None else clock
    lease = claim_job(connection, owner, lease_seconds, job_type, now=clock())
    if lease is None:
        return None
    row = dict(connection.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
    try:
        prepared = handler(row, lease)
        if isinstance(prepared, ExternalCommit):
            from .external import committed_monthly_job
            if row["job_type"] != "monthly_evaluation" or committed_monthly_job(connection, lease) is None:
                raise WorkbenchError("EXTERNAL_COMMIT_RECEIPT_REQUIRED")
        else:
            if row["job_type"] == "monthly_evaluation":
                raise WorkbenchError("MONTHLY_EVALUATION_EXTERNAL_COMMIT_REQUIRED")
            complete_job(connection, lease, prepared.get("result", {}), prepared.get("outcome", "succeeded"),
                         prepared.get("effect"), prepared.get("notification"), now=clock(), clock=clock)
    except Exception as exc:
        if row["job_type"] == "monthly_evaluation":
            from .external import committed_monthly_job
            committed = committed_monthly_job(connection, lease)
            if committed is not None:
                return committed
        try:
            retryable = True
            if row["job_type"] == "market_collect" and isinstance(exc, WorkbenchError):
                from .collections import COLLECTION_TERMINAL_CODES
                scheduled = connection.execute("SELECT 1 FROM collection_schedule_slots WHERE command_request_id=?", (row["command_request_id"],)).fetchone()
                retryable = not (str(exc) in COLLECTION_TERMINAL_CODES and (scheduled or str(exc) == "COLLECTION_BINDING_INVALID"))
            elif row["job_type"] == "market_collect_prices" and isinstance(exc, WorkbenchError):
                from .price_collections import PRICE_COLLECTION_TERMINAL_CODES
                scheduled = connection.execute("SELECT 1 FROM price_collection_schedule_slots WHERE command_request_id=?", (row["command_request_id"],)).fetchone()
                retryable = not (str(exc) in PRICE_COLLECTION_TERMINAL_CODES and (scheduled or str(exc) == "PRICE_COLLECTION_BINDING_INVALID"))
            fail_job(connection, lease, {"code": type(exc).__name__, "message": str(exc)}, retryable=retryable, now=clock())
        except WorkbenchError as lease_error:
            if str(lease_error) != "STALE_OR_EXPIRED_LEASE":
                raise
        raise
    return dict(connection.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
