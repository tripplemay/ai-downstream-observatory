"""A bounded owner activation intent; pause remains a direct metadata operation."""

from datetime import timedelta

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job
from . import epoch_continuation as controls, model_epoch_registration as registration, managed_actions as managed
from .data_evidence import _audit, _audit_binding, _object, _owner
from .model_runtime import _clock

JOB_TYPE = "investor_epoch_control"
SCHEMA = "investor-epoch-control-jobs.schema.json"


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("EPOCH_CONTROL_" + code)


def _validate(value, kind): validate_contract(value, SCHEMA, fragment="$defs/" + kind)


def request_header(db, workspace, actor, identifier, at):
    _owner(db, workspace, actor)
    row = db.execute("SELECT * FROM investor_epoch_control_requests WHERE workspace_id=? AND id=?", (workspace, identifier)).fetchone()
    _check(row is not None and row["actor_id"] == actor, "OUT_OF_SCOPE")
    doc = _object(row["document_json"]); _validate(doc, "request"); body = doc["body"]
    _check(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"]
        and doc["request_id"] == row["id"] and content_hash(body) == row["request_hash"]
        and all(doc[key] == row[key] for key in ("workspace_id", "model_id", "epoch_id", "actor_id", "created_at", "valid_until", "request_hash"))
        and body["epoch_id"] == row["epoch_id"] and body["expected_revision"] == row["expected_revision"]
        and body["idempotency_key"] == row["idempotency_key"] and instant(row["created_at"]) <= instant(at)
        and 0 < (instant(row["valid_until"]) - instant(row["created_at"])).total_seconds() <= 300, "HEADER_CHANGED")
    _audit_binding(db, row, "investor_request_epoch_control", "investor_epoch_control_request", row["id"])
    root, _ = registration._header(db, workspace, actor, row["epoch_id"], "registration")
    checkpoint = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?",
        (body["expected_checkpoint"]["id"], workspace, row["model_id"])).fetchone()
    _check(root["model_id"] == row["model_id"] and root["content_hash"] == body["expected_registration_hash"]
        and root["created_at"] <= row["created_at"] and instant(row["valid_until"]) <= instant(root["valid_until"])
        and checkpoint is not None and controls._ref(checkpoint) == body["expected_checkpoint"]
        and checkpoint["created_at"] <= row["created_at"], "HEADER_CHANGED")
    return row, doc


def enqueue_epoch_control(db, workspace, actor, body, *, now=None):
    assert_writable(db); _owner(db, workspace, actor); controls._validate(body, "control_submit")
    body = _object(canonical_json(body)); _check(body["enabled"] is True, "INPUT_INVALID")
    at = _clock(now); digest = content_hash(body)
    with transaction(db):
        old = db.execute("SELECT id,request_hash FROM investor_epoch_control_requests WHERE workspace_id=? AND idempotency_key=?", (workspace, body["idempotency_key"])).fetchone()
        if old:
            _check(old["request_hash"] == digest, "DUPLICATE_CONFLICT")
            return request_header(db, workspace, actor, old["id"], at)[1]
        controls._revision(db, workspace, actor, body["expected_revision"])
        root, _ = registration._header(db, workspace, actor, body["epoch_id"], "registration")
        _check(root["content_hash"] == body["expected_registration_hash"] and instant(root["created_at"]) <= instant(at) < instant(root["valid_until"]), "CHANGED")
        _check(not db.execute("SELECT 1 FROM investor_epoch_controls WHERE workspace_id=? AND idempotency_key=?", (workspace, body["idempotency_key"])).fetchone(), "DUPLICATE_CONFLICT")
        _check(not db.execute("""SELECT 1 FROM investor_epoch_control_requests r LEFT JOIN investor_epoch_control_results u ON u.request_id=r.id
          LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
          WHERE r.workspace_id=? AND r.expected_revision=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running')) LIMIT 1""",
          (JOB_TYPE, workspace, body["expected_revision"], at)).fetchone(), "BUSY")
        until = _clock(min(instant(root["valid_until"]), instant(at) + timedelta(minutes=5)))
        identifier = new_id("epoch-control-request")
        doc = {"schema_version": "investor-epoch-control-request-v1", "request_id": identifier, "workspace_id": workspace, "model_id": root["model_id"],
            "epoch_id": root["id"], "actor_id": actor, "body": body, "request_hash": digest, "created_at": at, "valid_until": until, "trading_permission": False}
        _validate(doc, "request"); encoded, hashed = canonical_json(doc), content_hash(doc)
        audit = _audit(db, actor, "investor_request_epoch_control", "investor_epoch_control_request", identifier, {"content_hash": hashed}, at)
        db.execute("INSERT INTO investor_epoch_control_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, root["model_id"], root["id"],
            body["expected_revision"], body["idempotency_key"], digest, encoded, hashed, actor, at, until, audit))
        return doc


def discover_epoch_controls(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000); at = _clock(now)
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investor_epoch_control_requests'").fetchone(): return []
    assert_writable(db); managed._stopped(db, stop_requested); found = []
    for row in db.execute("""SELECT r.* FROM investor_epoch_control_requests r LEFT JOIN investor_epoch_control_results u ON u.request_id=r.id
      LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      WHERE u.id IS NULL AND j.id IS NULL ORDER BY r.created_at,r.id LIMIT ?""", (JOB_TYPE, limit)).fetchall():
        request_header(db, row["workspace_id"], row["actor_id"], row["id"], at)
        found.append(enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["content_hash"], max_attempts=1, now=at))
    return found


def _error(error):
    if str(error) in managed.STOP: raise error
    if "EXPIRED" in str(error): return "EPOCH_CONTROL_EXPIRED"
    if any(key in str(error) for key in ("VERSION", "CHANGED", "SCOPE", "CONFLICT")): return "EPOCH_CONTROL_CHANGED"
    return "EPOCH_CONTROL_SOURCE_UNAVAILABLE"


def prepare_epoch_control_job(db, job, lease, *, clock=None, stop_requested=None):
    clock = clock or (lambda: None); at = _clock(clock()); managed._stopped(db, stop_requested); live=assert_lease(db, lease, at)
    _check(all(live[key]==job[key] for key in ("id","job_type","scope","period","input_version","command_request_id","max_attempts","attempt_count")),"JOB_CHANGED")
    raw = db.execute("SELECT actor_id FROM investor_epoch_control_requests WHERE id=? AND workspace_id=?", (job["period"], job["scope"])).fetchone()
    _check(raw is not None, "OUT_OF_SCOPE"); row, doc = request_header(db, job["scope"], raw[0], job["period"], at)
    _check(job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["input_version"] == row["content_hash"]
        and job["max_attempts"] == job["attempt_count"] == 1)
    prepared, failure = None, None
    try:
        _check(instant(at) < instant(row["valid_until"]), "EXPIRED")
        prepared = controls.prepare_epoch_continuation_control(db, row["workspace_id"], row["actor_id"], doc["body"],
            owner_interaction=True, now=at, clock=clock, stop_requested=stop_requested)
    except ValueError as error: failure = _error(error)

    def commit(connection):
        _check(connection is db, "CONNECTION_CHANGED"); current = _clock(clock()); managed._stopped(db, stop_requested); assert_lease(db, lease, current)
        selected, selected_doc = request_header(db, row["workspace_id"], row["actor_id"], row["id"], current)
        _check(selected["content_hash"] == row["content_hash"] and selected_doc == doc, "CHANGED")
        control, code, deadline = None, failure, row["valid_until"]
        if prepared:
            try:
                deadline = min(deadline, prepared.deadline, key=instant)
                _check(instant(at) <= instant(current) < instant(deadline), "EXPIRED")
                control = prepared(db)
            except ValueError as error: code = _error(error)
        identifier = new_id("epoch-control-result"); outcome = "applied" if control else "rejected"
        value = {"schema_version": "investor-epoch-control-result-v1", "result_id": identifier, "request_id": row["id"], "workspace_id": row["workspace_id"],
            "actor_id": row["actor_id"], "request_hash": row["content_hash"], "job_id": job["id"], "fencing_token": lease.fencing_token, "outcome": outcome,
            "code": "EPOCH_CONTROL_APPLIED" if control else code, "control_id": control["control_id"] if control else None,
            "control_hash": content_hash(control) if control else None, "created_at": _clock(clock()), "valid_until": deadline, "trading_permission": False}
        _validate(value, "result"); hashed = content_hash(value)
        managed._stopped(db, stop_requested)
        _check(instant(current) <= instant(value["created_at"]), "CLOCK_REGRESSION"); assert_lease(db, lease, value["created_at"])
        audit = _audit(db, row["actor_id"], "investor_finish_epoch_control", "investor_epoch_control_result", identifier, {"content_hash": hashed}, value["created_at"])
        db.execute("INSERT INTO investor_epoch_control_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["id"], row["workspace_id"], job["id"], lease.fencing_token,
            outcome, value["code"], value["control_id"], canonical_json(value), hashed, row["actor_id"], value["created_at"], audit))
        return JobCommit({"request_id": row["id"], "result_id": identifier, "outcome": outcome, "code": value["code"], "trading_permission": False})
    return {"effect": commit}


def assert_epoch_control_finalization(db, job, lease, result, outcome, finished):
    row = db.execute("SELECT document_json FROM investor_epoch_control_results WHERE job_id=? AND request_id=?", (job["id"], job["period"])).fetchone()
    _check(row is not None and outcome == "succeeded", "FINALIZATION_CHANGED")
    value = _object(row[0]); _validate(value, "result")
    _check(value["fencing_token"] == lease.fencing_token and result == {"request_id":value["request_id"],"result_id":value["result_id"],
        "outcome":value["outcome"],"code":value["code"],"trading_permission":False}
        and instant(value["created_at"]) <= instant(finished), "FINALIZATION_CHANGED")
    if value["outcome"] == "applied":
        _check(instant(finished) < instant(value["valid_until"]), "FINALIZATION_EXPIRED")
