"""Explicit standing draft collection; never complete-action or research approval."""

from datetime import datetime, time, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job, enqueue_notification
from . import issuer_sources as sources
from .data_evidence import _audit, _audit_binding, _owner
from .runtime import _milliseconds
from .model_runtime import _clock


SCHEMA = "investor-issuer-schedule.schema.json"
JOB_TYPE = "investor_issuer_capture"
ZONE = ZoneInfo("America/New_York")


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("INVESTOR_ISSUER_SCHEDULE_" + code)


def _control(db, schedule, row, at):
    doc = sources._sealed(row, SCHEMA, "$defs/control")
    _audit_binding(db, row, "investor_control_issuer_schedule", "investor_issuer_schedule_control", row["id"])
    _check(row["workspace_id"] == schedule["workspace_id"] and row["schedule_id"] == doc["schedule_id"] == schedule["id"]
        and row["actor_id"] == schedule["actor_id"] and doc["schedule_hash"] == schedule["content_hash"]
        and row["version"] == doc["version"] and row["enabled"] == int(doc["enabled"])
        and schedule["created_at"] <= row["created_at"] == doc["created_at"] <= at)
    return doc


def _schedule(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_issuer_schedules WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    doc = sources._sealed(row, SCHEMA, "$defs/policy"); _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_register_issuer_schedule", "investor_issuer_schedule", row["id"])
    grant, policy, control = sources._grant(db, workspace, row["authority_id"], at)
    _check(row["created_at"] <= at and row["authority_id"] == doc["authority_id"] and grant["content_hash"] == doc["authority_hash"]
        and row["actor_id"] == grant["actor_id"] and policy["valid_from"] <= doc["valid_from"] < doc["valid_until"] <= policy["valid_until"])
    rows = db.execute("SELECT * FROM investor_issuer_schedule_controls WHERE schedule_id=? ORDER BY version", (identifier,)).fetchall()
    _check(len(rows) <= 1000)
    previous = row["created_at"]
    for index, entry in enumerate(rows, 1):
        _control(db, row, entry, at); _check(entry["version"] == index and previous <= entry["created_at"]); previous = entry["created_at"]
    return row, doc, rows[-1] if rows else None, grant, policy, control


def _active(value, at):
    _, doc, control, _, parent, parent_control = value
    return (control is not None and control["enabled"] == 1 and doc["valid_from"] <= at < doc["valid_until"]
        and sources._active(parent, parent_control, at))


def _active_ids(db, workspace, fund_id, at):
    rows = db.execute("""SELECT s.id FROM investor_issuer_schedules s JOIN investor_issuer_authorities a ON a.id=s.authority_id
      JOIN investor_issuer_schedule_controls c ON c.schedule_id=s.id
      WHERE s.workspace_id=? AND json_extract(a.document_json,'$.fund_id')=? AND c.enabled=1
        AND c.version=(SELECT max(version) FROM investor_issuer_schedule_controls WHERE schedule_id=s.id)
      ORDER BY s.id LIMIT 1001""", (workspace, fund_id)).fetchall()
    _check(len(rows) <= 1000, "LIMIT")
    return [row["id"] for row in rows if _active(_schedule(db, workspace, row["id"], at), at)]


def register_schedule(db, workspace, actor, policy, *, now=None):
    policy = sources._object(canonical_json(policy)); validate_contract(policy, SCHEMA, fragment="$defs/policy")
    at = _milliseconds(now)
    for key in ("valid_from", "valid_until"): policy[key] = _milliseconds(policy[key])
    with transaction(db):
        _owner(db, workspace, actor)
        grant, parent, _ = sources._grant(db, workspace, policy["authority_id"], at)
        _check(grant["actor_id"] == actor and grant["content_hash"] == policy["authority_hash"]
            and parent["valid_from"] <= policy["valid_from"] < policy["valid_until"] <= parent["valid_until"])
        digest = content_hash(policy)
        old = db.execute("SELECT id FROM investor_issuer_schedules WHERE workspace_id=? AND content_hash=?", (workspace, digest)).fetchone()
        if old: return dict(_schedule(db, workspace, old["id"], at)[0])
        identifier = new_id("issuer-schedule")
        audit = _audit(db, actor, "investor_register_issuer_schedule", "investor_issuer_schedule", identifier, {"content_hash": digest}, at)
        db.execute("INSERT INTO investor_issuer_schedules VALUES(?,?,?,?,?,?,?,?)", (identifier, workspace, grant["id"], canonical_json(policy), digest, actor, at, audit))
        set_schedule_enabled(db, workspace, actor, identifier, False, now=at)
        return dict(db.execute("SELECT * FROM investor_issuer_schedules WHERE id=?", (identifier,)).fetchone())


def set_schedule_enabled(db, workspace, actor, identifier, enabled, *, now=None):
    _check(type(enabled) is bool); at = _milliseconds(now)
    with transaction(db):
        _owner(db, workspace, actor); value = _schedule(db, workspace, identifier, at)
        row, doc, old, _, parent, parent_control = value
        _check(not enabled or doc["valid_from"] <= at < doc["valid_until"] and sources._active(parent, parent_control, at), "INACTIVE")
        _check(not enabled or not set(_active_ids(db, workspace, parent["fund_id"], at)) - {identifier}, "AMBIGUOUS")
        if old and old["enabled"] == int(enabled): return dict(old)
        version = old["version"] + 1 if old else 1; _check(version <= 1000, "LIMIT")
        control = {"schema_version": "investor-issuer-schedule-control-v1", "schedule_id": identifier, "schedule_hash": row["content_hash"],
            "version": version, "enabled": enabled, "created_at": at}
        digest = content_hash(control); key = new_id("issuer-schedule-control")
        audit = _audit(db, actor, "investor_control_issuer_schedule", "investor_issuer_schedule_control", key, {"content_hash": digest}, at)
        db.execute("INSERT INTO investor_issuer_schedule_controls VALUES(?,?,?,?,?,?,?,?,?,?)", (key, workspace, identifier, version, int(enabled),
            canonical_json(control), digest, actor, at, audit))
        return dict(db.execute("SELECT * FROM investor_issuer_schedule_controls WHERE id=?", (key,)).fetchone())


def _deadline(at, policy):
    day = instant(at).astimezone(ZONE).date()
    return _milliseconds(min(instant(policy["valid_until"]), datetime.combine(day + timedelta(days=1), time(), tzinfo=ZONE)))


def discover_issuer_requests(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000); at = _clock(now); local = instant(at).astimezone(ZONE)
    rows = db.execute("""SELECT s.* FROM investor_issuer_schedules s JOIN investor_issuer_schedule_controls c ON c.schedule_id=s.id
      JOIN investor_issuer_authorities a ON a.id=s.authority_id
      WHERE c.enabled=1 AND c.version=(SELECT max(version) FROM investor_issuer_schedule_controls WHERE schedule_id=s.id)
        AND json_extract(s.document_json,'$.valid_from')<=? AND json_extract(s.document_json,'$.valid_until')>?
        AND NOT EXISTS(SELECT 1 FROM investor_issuer_requests r WHERE r.workspace_id=s.workspace_id
          AND r.fund_id=json_extract(a.document_json,'$.fund_id') AND r.issuer_day=?)
      ORDER BY s.created_at,s.id LIMIT ?""", (at, at, local.date().isoformat(), limit)).fetchall()
    for row in rows:
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        try:
            with transaction(db):
                value = _schedule(db, row["workspace_id"], row["id"], at)
                _, policy, control, _, parent, _ = value
                if not _active(value, at) or local.hour < policy["run_after_hour"]: continue
                _check(_active_ids(db, row["workspace_id"], parent["fund_id"], at) == [row["id"]], "AMBIGUOUS")
                until = _deadline(at, policy)
                if instant(at) + timedelta(seconds=31) >= instant(until): continue
                if db.execute("SELECT 1 FROM investor_issuer_requests WHERE workspace_id=? AND fund_id=? AND issuer_day=?",
                        (row["workspace_id"], parent["fund_id"], local.date().isoformat())).fetchone(): continue
                start = (local.date() - timedelta(days=policy["lookback_days"] - 1)).isoformat()
                requested, _, fresh = sources._start(db, row["workspace_id"], row["actor_id"], row["authority_id"], uuid4().hex, start, local.date().isoformat(), at)
                _check(fresh)
                identifier = new_id("issuer-scheduled-request")
                doc = {"schema_version": "investor-issuer-scheduled-request-v1", "workspace_id": row["workspace_id"],
                    "schedule_id": row["id"], "schedule_hash": row["content_hash"], "control_id": control["id"], "control_hash": control["content_hash"],
                    "issuer_request_id": requested["id"], "issuer_request_hash": requested["content_hash"], "created_at": at, "valid_until": until}
                digest = content_hash(doc)
                audit = _audit(db, row["actor_id"], "investor_schedule_issuer_capture", "investor_issuer_schedule_request", identifier, {"content_hash": digest}, at)
                db.execute("INSERT INTO investor_issuer_schedule_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["workspace_id"], row["id"], control["id"],
                    requested["id"], canonical_json(doc), digest, row["actor_id"], at, until, audit))
        except WorkbenchError as error:
            if str(error) in sources._STOP: raise
            enqueue_notification(db, "issuer-schedule-gap:" + row["id"], "investor.issuer_schedule_gap",
                {"workspace_id": row["workspace_id"], "schedule_id": row["id"], "code": "ISSUER_SCHEDULE_UNAVAILABLE"}, now=at)
    pending = db.execute("""SELECT r.* FROM investor_issuer_schedule_requests r WHERE NOT EXISTS(SELECT 1 FROM job_runs j
      WHERE j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash)
      ORDER BY r.created_at,r.id LIMIT ?""", (JOB_TYPE, limit)).fetchall()
    return [enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["content_hash"], max_attempts=1, now=at) for row in pending]


def _request(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_issuer_schedule_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    doc = sources._sealed(row, SCHEMA, "$defs/request"); _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_schedule_issuer_capture", "investor_issuer_schedule_request", identifier)
    schedule, policy, _, _, _, _ = _schedule(db, workspace, row["schedule_id"], at)
    control = db.execute("SELECT * FROM investor_issuer_schedule_controls WHERE id=?", (row["control_id"],)).fetchone(); _control(db, schedule, control, at)
    request, requested, _, _ = sources._request_header(db, workspace, row["issuer_request_id"], at)
    source_control = db.execute("SELECT created_at FROM investor_issuer_controls WHERE id=?", (request["control_id"],)).fetchone()
    local = instant(row["created_at"]).astimezone(ZONE)
    _check(all(row[k] == doc[k] for k in ("workspace_id", "schedule_id", "control_id", "issuer_request_id", "created_at", "valid_until"))
        and row["actor_id"] == schedule["actor_id"] == request["actor_id"] and doc["schedule_hash"] == schedule["content_hash"]
        and doc["control_hash"] == control["content_hash"] and doc["issuer_request_hash"] == request["content_hash"]
        and request["authority_id"] == schedule["authority_id"] and control["enabled"] == 1
        and schedule["created_at"] <= control["created_at"] <= row["created_at"] and source_control["created_at"] <= row["created_at"]
        and policy["valid_from"] <= row["created_at"] < policy["valid_until"] and local.hour >= policy["run_after_hour"]
        and row["created_at"] == request["created_at"] <= at and row["valid_until"] == _deadline(row["created_at"], policy)
        and requested["end_date"] == request["issuer_day"] and requested["start_date"] == (instant(row["created_at"]).astimezone(ZONE).date() - timedelta(days=policy["lookback_days"] - 1)).isoformat())
    return row, doc, request, requested


def _eligible(db, row, at):
    value = _schedule(db, row["workspace_id"], row["schedule_id"], at)
    return (_active(value, at) and value[2]["id"] == row["control_id"] and at < row["valid_until"]
        and _active_ids(db, row["workspace_id"], value[4]["fund_id"], at) == [row["schedule_id"]])


def prepare_issuer_capture(db, job, lease, *, clock=None, stop_requested=None):
    clock = clock or (lambda: None); at = _clock(clock())
    row, _, requested, document = _request(db, job["scope"], job["period"], at)
    _check(job["id"] == lease.job_id and job["job_type"] == JOB_TYPE and job["command_request_id"] is None
        and job["max_attempts"] == 1 and job["input_version"] == row["content_hash"])
    def guard(connection, checked): assert_lease(connection, lease, now=checked)
    guard(db, at)
    _check(not db.execute("SELECT 1 FROM investor_issuer_captures WHERE request_id=?", (requested["id"],)).fetchone(), "ALREADY_FINISHED")
    ready = instant(at) + timedelta(seconds=31) < min(instant(row["valid_until"]), instant(lease.lease_until))
    effect = sources._prepare_started_issuer_draft(db, row["workspace_id"], row["actor_id"], requested, document,
        clock=clock, stop_requested=stop_requested, guard=guard, eligible=lambda connection, checked: ready and _eligible(connection, row, checked))
    def commit(connection):
        result = effect(connection); checked = result["created_at"]; guard(connection, checked)
        capture = connection.execute("SELECT * FROM investor_issuer_captures WHERE id=?", (result["capture_id"],)).fetchone()
        value = {"schema_version": "investor-issuer-scheduled-result-v1", "workspace_id": row["workspace_id"], "request_id": row["id"],
            "request_hash": row["content_hash"], "job_id": job["id"], "fencing_token": lease.fencing_token, "capture_id": capture["id"],
            "capture_hash": capture["content_hash"], "status": result["status"], "created_at": checked, "research_admitted": False}
        validate_contract(value, SCHEMA, fragment="$defs/result"); digest = content_hash(value); identifier = new_id("issuer-scheduled-result")
        audit = _audit(connection, row["actor_id"], "investor_finish_issuer_schedule", "investor_issuer_schedule_result", identifier, {"content_hash": digest}, checked)
        connection.execute("INSERT INTO investor_issuer_schedule_results VALUES(?,?,?,?,?,?,?,?,?,?)", (identifier, row["workspace_id"], row["id"], job["id"],
            capture["id"], canonical_json(value), digest, row["actor_id"], checked, audit))
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        return JobCommit({"capture_id": capture["id"], "code": result["reason_code"], "research_admitted": False},
            "succeeded" if result["status"] == "captured" else "failed" if result["status"] == "transport_failed" else "skipped")
    return {"effect": commit}


def inspect_scheduled_request(db, workspace, actor, identifier, *, now=None):
    _owner(db, workspace, actor); at = _clock(now); checked = instant(now)
    row, _, _, _ = _request(db, workspace, identifier, at)
    job = db.execute("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?",
        (JOB_TYPE, workspace, identifier, row["content_hash"])).fetchone()
    result = db.execute("SELECT * FROM investor_issuer_schedule_results WHERE request_id=?", (identifier,)).fetchone()
    if job: _check(job["max_attempts"] == 1 and job["command_request_id"] is None and instant(job["created_at"]) <= checked)
    state = "queued" if job is None or job["attempt_count"] == 0 else "indeterminate"
    capture_id = None
    if result:
        doc = sources._sealed(result, SCHEMA, "$defs/result")
        _audit_binding(db, result, "investor_finish_issuer_schedule", "investor_issuer_schedule_result", result["id"])
        captured, receipt, original, _, _, _ = sources._capture_header(db, workspace, result["capture_id"], at)
        _check(job is not None and all(result[key] == doc[key] for key in ("workspace_id", "request_id", "job_id", "capture_id", "created_at"))
            and result["actor_id"] == row["actor_id"] and result["workspace_id"] == workspace and result["request_id"] == identifier
            and original["id"] == row["issuer_request_id"] and captured["created_at"] == result["created_at"] <= at
            and doc["capture_hash"] == captured["content_hash"] and doc["request_hash"] == row["content_hash"]
            and doc["status"] == captured["status"] and doc["job_id"] == job["id"] and doc["fencing_token"] == job["fencing_token"]
            and job["attempt_count"] == 1)
        outcome = {"captured": "succeeded", "transport_failed": "failed", "superseded": "skipped"}[doc["status"]]
        attempt = db.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1", (job["id"],)).fetchone()
        _check(attempt is not None and job["status"] == attempt["status"] == outcome and attempt["fencing_token"] == doc["fencing_token"]
            and instant(attempt["started_at"]) < instant(result["created_at"]) + timedelta(milliseconds=1)
            and instant(result["created_at"]) <= instant(attempt["finished_at"]) <= checked
            and instant(attempt["started_at"]) <= instant(attempt["finished_at"])
            and sources._object(job["result_json"]) == {"capture_id": captured["id"], "code": receipt["reason_code"], "research_admitted": False})
        state, capture_id = doc["status"], captured["id"]
    elif job and job["status"] == "succeeded":
        _check(False)
    return {"request_id": identifier, "request_hash": row["content_hash"], "issuer_request_id": row["issuer_request_id"],
        "capture_id": capture_id, "status": state, "automatic_retry_permitted": False, "research_admitted": False}
