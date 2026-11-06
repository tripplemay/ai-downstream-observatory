"""Explicit async preparation only; never register an epoch or activate it."""

from datetime import timedelta

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job
from . import model_epoch_registration as registration, managed_actions as managed
from .data_evidence import _audit, _audit_binding, _object, _owner
from .model_contracts import validate_definition
from .model_runtime import _clock

JOB_TYPE = "investor_epoch_preview"
SCHEMA = "investor-epoch-preview-jobs.schema.json"


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("EPOCH_PREVIEW_" + code)


def _validate(value, kind): validate_contract(value, SCHEMA, fragment="$defs/" + kind)


def _model(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_models WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _check(row is not None, "OUT_OF_SCOPE")
    doc = _object(row["document_json"]); validate_definition(doc)
    _check(content_hash(doc) == row["content_hash"] and canonical_json(doc) == row["document_json"]
        and doc["model_id"] == row["id"] and doc["created_at"] == row["created_at"]
        and instant(row["created_at"]) <= instant(at), "MODEL_CHANGED")
    return row, doc


def request_header(db, workspace, actor, identifier, at):
    _owner(db, workspace, actor)
    row = db.execute("SELECT * FROM investor_epoch_preview_requests WHERE workspace_id=? AND id=?", (workspace, identifier)).fetchone()
    _check(row is not None and row["actor_id"] == actor, "OUT_OF_SCOPE")
    doc = _object(row["document_json"]); _validate(doc, "request"); body = doc["body"]
    _check(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"]
        and doc["request_id"] == row["id"] and content_hash(body) == row["request_hash"]
        and all(doc[key] == row[key] for key in ("workspace_id", "model_id", "actor_id", "created_at", "valid_until", "request_hash"))
        and body["model_id"] == row["model_id"] and body["expected_revision"] == row["expected_revision"]
        and body["idempotency_key"] == row["idempotency_key"] and instant(row["created_at"]) <= instant(at)
        and 0 < (instant(row["valid_until"]) - instant(row["created_at"])).total_seconds() <= 300, "HEADER_CHANGED")
    _audit_binding(db, row, "investor_request_epoch_preview", "investor_epoch_preview_request", row["id"])
    model, definition = _model(db, workspace, row["model_id"], at)
    _check(body["expected_model_hash"] == model["content_hash"] and instant(row["valid_until"]) <= instant(definition["valid_until"]), "MODEL_CHANGED")
    return row, doc


def enqueue_epoch_preview(db, workspace, actor, body, *, now=None):
    assert_writable(db); _owner(db, workspace, actor); _validate(body, "submit")
    body = _object(canonical_json(body)); at = _clock(now); digest = content_hash(body)
    with transaction(db):
        old = db.execute("SELECT id,request_hash FROM investor_epoch_preview_requests WHERE workspace_id=? AND idempotency_key=?", (workspace, body["idempotency_key"])).fetchone()
        if old:
            _check(old["request_hash"] == digest, "DUPLICATE_CONFLICT")
            return request_header(db, workspace, actor, old["id"], at)[1]
        registration._revision(db, workspace, actor, body["expected_revision"])
        model, definition = _model(db, workspace, body["model_id"], at)
        _check(model["content_hash"] == body["expected_model_hash"], "MODEL_CHANGED")
        _check(instant(at) < instant(definition["valid_until"]), "EXPIRED")
        _check(not db.execute("SELECT 1 FROM investor_model_epochs WHERE workspace_id=? AND model_id=?", (workspace, model["id"])).fetchone(), "ALREADY_REGISTERED")
        _check(not db.execute("""SELECT 1 FROM investor_epoch_preview_requests r LEFT JOIN investor_epoch_preview_results u ON u.request_id=r.id
          LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
          WHERE r.workspace_id=? AND r.expected_revision=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running')) LIMIT 1""",
          (JOB_TYPE, workspace, body["expected_revision"], at)).fetchone(), "BUSY")
        identifier = new_id("epoch-preview-request"); until = _clock(min(instant(definition["valid_until"]), instant(at) + timedelta(minutes=5)))
        doc = {"schema_version": "investor-epoch-preview-request-v1", "request_id": identifier, "workspace_id": workspace, "model_id": model["id"],
            "actor_id": actor, "body": body, "request_hash": digest, "created_at": at, "valid_until": until, "trading_permission": False}
        _validate(doc, "request"); hashed = content_hash(doc)
        audit = _audit(db, actor, "investor_request_epoch_preview", "investor_epoch_preview_request", identifier, {"content_hash": hashed}, at)
        db.execute("INSERT INTO investor_epoch_preview_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, model["id"], body["expected_revision"],
            body["idempotency_key"], digest, canonical_json(doc), hashed, actor, at, until, audit))
        return doc


def discover_epoch_previews(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000); at = _clock(now)
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investor_epoch_preview_requests'").fetchone(): return []
    assert_writable(db); managed._stopped(db, stop_requested); result = []
    for row in db.execute("""SELECT r.* FROM investor_epoch_preview_requests r LEFT JOIN job_runs j
      ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      WHERE j.id IS NULL ORDER BY r.created_at,r.id LIMIT ?""", (JOB_TYPE, limit)).fetchall():
        request_header(db, row["workspace_id"], row["actor_id"], row["id"], at)
        result.append(enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["content_hash"], max_attempts=1, now=at))
    return result


def _error(error):
    if str(error) in managed.STOP: raise error
    if "EXPIRED" in str(error): return "EPOCH_PREVIEW_EXPIRED"
    if any(value in str(error) for value in ("VERSION", "CHANGED", "ALREADY_REGISTERED", "CONFLICT")): return "EPOCH_PREVIEW_CHANGED"
    return "EPOCH_PREVIEW_SOURCE_UNAVAILABLE"


def job_result(value):
    return {key: value[key] for key in ("request_id", "result_id", "outcome", "code", "preview_id", "trading_permission")}


def prepare_epoch_preview_job(db, job, lease, *, clock=None, stop_requested=None):
    clock = clock or (lambda: None); at = _clock(clock()); managed._stopped(db, stop_requested); live = assert_lease(db, lease, at)
    _check(all(live[key] == job[key] for key in ("id", "job_type", "scope", "period", "input_version", "command_request_id", "max_attempts", "attempt_count")), "JOB_CHANGED")
    raw = db.execute("SELECT actor_id FROM investor_epoch_preview_requests WHERE id=? AND workspace_id=?", (job["period"], job["scope"])).fetchone()
    _check(raw is not None, "OUT_OF_SCOPE"); row, doc = request_header(db, job["scope"], raw[0], job["period"], at)
    _check(job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["input_version"] == row["content_hash"]
        and job["max_attempts"] == job["attempt_count"] == 1, "JOB_CHANGED")
    prepared, failure = None, None
    try:
        _check(instant(at) < instant(row["valid_until"]), "EXPIRED")
        prepared = registration.prepare_model_epoch_preview(db, row["workspace_id"], row["actor_id"], row["model_id"],
            expected_revision=row["expected_revision"], owner_interaction=True, now=at, clock=clock, stop_requested=stop_requested)
    except ValueError as error: failure = _error(error)

    def commit(connection):
        _check(connection is db, "CONNECTION_CHANGED"); current = _clock(clock()); managed._stopped(db, stop_requested); assert_lease(db, lease, current)
        selected, selected_doc = request_header(db, row["workspace_id"], row["actor_id"], row["id"], current)
        _check(selected["content_hash"] == row["content_hash"] and selected_doc == doc, "CHANGED")
        preview, code, deadline = None, failure, row["valid_until"]
        if prepared:
            try:
                _check(instant(at) <= instant(current) < instant(deadline), "EXPIRED")
                preview = prepared(db)
                deadline = min(deadline, preview["valid_until"], key=instant)
            except ValueError as error: code = _error(error)
        identifier = new_id("epoch-preview-result")
        value = {"schema_version": "investor-epoch-preview-result-v1", "result_id": identifier, "request_id": row["id"], "workspace_id": row["workspace_id"],
            "model_id": row["model_id"], "actor_id": row["actor_id"], "request_hash": row["content_hash"], "job_id": job["id"], "fencing_token": lease.fencing_token,
            "outcome": "preview_ready" if preview else "rejected", "code": "EPOCH_PREVIEW_READY" if preview else code,
            "preview_id": preview["preview_id"] if preview else None, "preview_hash": content_hash(preview) if preview else None,
            "created_at": _clock(clock()), "valid_until": deadline, "epoch_registered": False, "monitoring_resumed": False, "trading_permission": False}
        _validate(value, "result"); managed._stopped(db, stop_requested)
        _check(instant(current) <= instant(value["created_at"]), "CLOCK_REGRESSION"); assert_lease(db, lease, value["created_at"])
        audit = _audit(db, row["actor_id"], "investor_finish_epoch_preview", "investor_epoch_preview_result", identifier, {"content_hash": content_hash(value)}, value["created_at"])
        db.execute("INSERT INTO investor_epoch_preview_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["id"], row["workspace_id"], row["model_id"], job["id"], lease.fencing_token,
            value["outcome"], value["code"], value["preview_id"], canonical_json(value), content_hash(value), row["actor_id"], value["created_at"], audit))
        return JobCommit(job_result(value))
    return {"effect": commit}


def assert_epoch_preview_finalization(db, job, lease, result, outcome, finished):
    row = db.execute("SELECT document_json FROM investor_epoch_preview_results WHERE job_id=? AND request_id=?", (job["id"], job["period"])).fetchone()
    _check(row is not None and outcome == "succeeded", "FINALIZATION_CHANGED")
    value = _object(row[0]); _validate(value, "result")
    _check(value["fencing_token"] == lease.fencing_token and result == job_result(value)
        and instant(value["created_at"]) <= instant(finished), "FINALIZATION_CHANGED")
    if value["outcome"] == "preview_ready":
        _check(instant(finished) < instant(value["valid_until"]), "FINALIZATION_EXPIRED")
