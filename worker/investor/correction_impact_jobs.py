"""Explicit, single-attempt hypothetical impact jobs. Never correction consent."""

from datetime import timedelta

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job
from . import action_review_workflow as review, managed_actions as managed
from .action_correction_impact import compare_action_correction_impact
from .correction_change_fence import correction_change_fence
from .data_evidence import _audit, _audit_binding, _object, _owner
from .model_runtime import _clock
from .implementation import implementation_hash


SCHEMA = "investor-correction-impact-job.schema.json"
JOB_TYPE = "investor_correction_impact"


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("CORRECTION_IMPACT_" + code)


def _validate(doc, kind):
    validate_contract(doc, SCHEMA, fragment="$defs/" + kind)


def request_header(db, workspace, actor, identifier, at):
    _owner(db, workspace, actor)
    row = db.execute("SELECT * FROM investor_correction_impact_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _check(row is not None, "OUT_OF_SCOPE"); doc = _object(row["document_json"]); _validate(doc, "request"); body = doc["body"]
    _check(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"] and row["actor_id"] == actor
        and doc["request_id"] == row["id"] and content_hash(body) == row["request_hash"]
        and all(doc[key] == row[key] for key in ("workspace_id", "request_hash", "created_at", "valid_until"))
        and all(body[key] == row[key] for key in ("model_id", "preview_id", "expected_revision", "idempotency_key"))
        and type(body["expected_revision"]) is int and row["created_at"] <= at
        and 0 < (instant(row["valid_until"]) - instant(row["created_at"])).total_seconds() <= 300)
    _audit_binding(db, row, "investor_enqueue_correction_impact", "investor_correction_impact_request", identifier)
    _, preview = review._preview_header(db, workspace, actor, row["preview_id"])
    _check(preview["workspace_revision"] == row["expected_revision"] and preview["created_at"] <= row["created_at"] and row["valid_until"] <= preview["valid_until"])
    return row, doc


def enqueue_correction_impact(db, workspace, actor, body, *, now=None):
    _owner(db, workspace, actor); validate_contract(body, "investor-action-correction-impact.schema.json")
    body = _object(canonical_json(body)); at, digest = _clock(now), content_hash(body)
    _check(type(body["expected_revision"]) is int and len(canonical_json(body).encode()) <= 524288, "INPUT_INVALID")
    with transaction(db):
        old = db.execute("SELECT id,request_hash FROM investor_correction_impact_requests WHERE workspace_id=? AND idempotency_key=?", (workspace, body["idempotency_key"])).fetchone()
        if old:
            _check(old["request_hash"] == digest, "DUPLICATE_CONFLICT"); return request_header(db, workspace, actor, old["id"], at)[1]
        review._revision(db, workspace, actor, body["expected_revision"])
        _, preview = review._preview_header(db, workspace, actor, body["preview_id"])
        _check(preview["workspace_revision"] == body["expected_revision"], "VERSION_CHANGED")
        _check(preview["created_at"] <= at < preview["valid_until"], "EXPIRED")
        _check(db.execute("SELECT 1 FROM investor_models WHERE id=? AND workspace_id=?", (body["model_id"], workspace)).fetchone(), "MODEL_REQUIRED")
        busy = db.execute("""SELECT 1 FROM investor_correction_impact_requests r LEFT JOIN investor_correction_impact_results u ON u.request_id=r.id
          LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
          WHERE r.workspace_id=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running','retry_queued')) LIMIT 1""", (JOB_TYPE, workspace, at)).fetchone()
        _check(not busy, "BUSY")
        until = min(preview["valid_until"], _clock(instant(at) + timedelta(minutes=5)))
        identifier = new_id("correction-impact-request")
        doc = {"schema_version": "investor-correction-impact-job-request-v1", "request_id": identifier, "workspace_id": workspace,
            "body": body, "request_hash": digest, "created_at": at, "valid_until": until}
        _validate(doc, "request"); hashed = content_hash(doc)
        audit = _audit(db, actor, "investor_enqueue_correction_impact", "investor_correction_impact_request", identifier, {"content_hash": hashed}, at)
        db.execute("INSERT INTO investor_correction_impact_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, body["model_id"], body["preview_id"],
            body["expected_revision"], body["idempotency_key"], digest, canonical_json(doc), hashed, actor, at, until, audit))
        return doc


def discover_correction_impact_requests(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000, "LIMIT_INVALID"); at = _clock(now); result = []
    managed._stopped(db, stop_requested)
    rows = db.execute("""SELECT id,workspace_id,actor_id FROM investor_correction_impact_requests r WHERE NOT EXISTS(
      SELECT 1 FROM job_runs j WHERE j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id) ORDER BY created_at,id LIMIT ?""", (JOB_TYPE, limit)).fetchall()
    for selected in rows:
        managed._stopped(db, stop_requested)
        with transaction(db):
            row, _ = request_header(db, selected["workspace_id"], selected["actor_id"], selected["id"], at)
            result.append(enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["content_hash"], max_attempts=1, now=at))
    return result


def _error(error):
    code = str(error)
    if code in managed.STOP: raise error
    if any(key in code for key in ("VERSION", "CHANGED", "SCOPE")): return "CORRECTION_IMPACT_VERSION_CHANGED"
    if "EXPIRED" in code: return "CORRECTION_IMPACT_EXPIRED"
    if any(key in code for key in ("TAX", "PAYMENT", "EVENT", "DECISIONS", "REASON", "ANSWERS", "CONTRACT_INVALID")): return "CORRECTION_IMPACT_INVALID_ANSWERS"
    return "CORRECTION_IMPACT_SOURCE_UNAVAILABLE"


def prepare_correction_impact_job(db, job, lease, *, clock=None, stop_requested=None):
    clock = (lambda: None) if clock is None else clock
    at = _clock(clock()); managed._stopped(db, stop_requested); assert_lease(db, lease, at)
    raw = db.execute("SELECT actor_id FROM investor_correction_impact_requests WHERE id=? AND workspace_id=?", (job["period"], job["scope"])).fetchone()
    _check(raw is not None, "OUT_OF_SCOPE"); row, doc = request_header(db, job["scope"], raw["actor_id"], job["period"], at)
    _check(job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["input_version"] == row["content_hash"] and job["max_attempts"] == job["attempt_count"] == 1)
    implementation = implementation_hash(); impact, fence, failure = None, None, None
    try:
        _check(at < row["valid_until"], "EXPIRED")
        with transaction(db, immediate=False):
            impact = compare_action_correction_impact(db, row["workspace_id"], row["actor_id"], doc["body"], now=at, stop_requested=stop_requested)
            fence = correction_change_fence(db, row["workspace_id"], row["actor_id"])
    except ValueError as error: impact, failure = None, _error(error)

    def commit(connection):
        _check(connection is db, "CONNECTION_CHANGED"); current = _clock(clock()); managed._stopped(db, stop_requested); assert_lease(db, lease, current)
        selected, selected_doc = request_header(db, row["workspace_id"], row["actor_id"], row["id"], current)
        _check(selected["content_hash"] == row["content_hash"] and selected_doc == doc, "BINDING_CHANGED")
        ready, code = impact, failure
        if ready is not None:
            try:
                _check(current < row["valid_until"] and current < ready["valid_until"], "EXPIRED")
                _check(implementation_hash() == implementation, "IMPLEMENTATION_CHANGED")
                review._revision(db, row["workspace_id"], row["actor_id"], row["expected_revision"])
                _check(correction_change_fence(db, row["workspace_id"], row["actor_id"]) == fence, "SOURCE_CHANGED")
            except ValueError as error: ready, code = None, _error(error)
        current = _clock(clock()); managed._stopped(db, stop_requested); assert_lease(db, lease, current)
        _check(ready is None or current < min(row["valid_until"], ready["valid_until"]), "EXPIRED")
        identifier = new_id("correction-impact-result"); outcome = "preview_ready" if ready else "rejected"
        code = "CORRECTION_IMPACT_READY" if ready else code
        result = {"schema_version": "investor-correction-impact-job-result-v1", "result_id": identifier, "request_id": row["id"],
            "workspace_id": row["workspace_id"], "request_hash": row["content_hash"], "job_id": job["id"], "fencing_token": lease.fencing_token,
            "outcome": outcome, "code": code, "impact": ready, "change_fence": fence if ready else None, "implementation_hash": implementation, "created_at": current}
        _validate(result, "result"); hashed = content_hash(result)
        audit = _audit(db, row["actor_id"], "investor_finish_correction_impact", "investor_correction_impact_result", identifier, {"content_hash": hashed}, current)
        db.execute("INSERT INTO investor_correction_impact_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["id"], row["workspace_id"], job["id"],
            lease.fencing_token, outcome, code, canonical_json(result), hashed, row["actor_id"], current, audit))
        return JobCommit({"request_id": row["id"], "result_id": identifier, "outcome": outcome, "code": code, "research_admitted": False})
    return {"effect": commit}
