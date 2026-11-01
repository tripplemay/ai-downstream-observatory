"""Durable owner intent; fenced local review jobs, never provider or trading jobs."""

from datetime import timedelta

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job
from . import action_review_workflow as workflow, managed_actions as managed
from .data_evidence import _audit, _audit_binding, _object, _owner
from .model_runtime import _clock


SCHEMA = "investor-action-review-job.schema.json"
JOB_TYPE = "investor_action_review"


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("ACTION_REVIEW_JOB_" + code)


def _validate(doc, fragment):
    try: validate_contract(doc, SCHEMA, fragment="$defs/" + fragment)
    except ValueError: raise WorkbenchError("ACTION_REVIEW_JOB_DOCUMENT_INVALID") from None


def request_header(db, workspace, actor, identifier, *, now=None):
    _owner(db, workspace, actor)
    row = db.execute("SELECT * FROM investor_action_review_job_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _check(row is not None, "OUT_OF_SCOPE")
    doc = _object(row["document_json"]); _validate(doc, "request")
    body = doc["body"]
    _check(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"] and row["actor_id"] == actor
        and doc["request_id"] == row["id"] and all(doc[key] == row[key] for key in ("workspace_id", "kind", "request_hash", "created_at", "valid_until"))
        and type(body["expected_revision"]) is int and body["expected_revision"] == row["expected_revision"]
        and body["idempotency_key"] == row["idempotency_key"] and content_hash(body) == row["request_hash"]
        and instant(row["created_at"]) <= instant(_clock(now)) and 0 < (instant(row["valid_until"]) - instant(row["created_at"])).total_seconds() <= 300)
    _audit_binding(db, row, "investor_enqueue_action_review", "investor_action_review_job_request", identifier)
    authority, policy, _ = managed._authority(db, workspace, row["authority_id"], _clock(now))
    _check(authority["actor_id"] == actor and doc["provider_symbol"] == policy["provider_symbol"])
    if row["kind"] == "preview":
        _check(body["authority_id"] == row["authority_id"] and row["preview_id"] is None)
    else:
        _, preview = workflow._preview_header(db, workspace, actor, body["preview_id"])
        _check(preview["preview_id"] == row["preview_id"] and preview["authority_id"] == row["authority_id"]
            and preview["workspace_revision"] == row["expected_revision"] and row["valid_until"] <= preview["valid_until"])
    return row, doc


def enqueue_action_review_request(db, workspace, actor, kind, body, *, now=None):
    """Short private intent write; enqueueing does not advance workspace revision."""
    managed._stopped(db, None); _owner(db, workspace, actor)
    _check(kind in ("preview", "confirmation"), "KIND_INVALID")
    workflow._validate(body, "preview_request" if kind == "preview" else "submit")
    body = _object(canonical_json(body)); digest, at = content_hash(body), _clock(now)
    with transaction(db):
        old = db.execute("SELECT id,kind,request_hash FROM investor_action_review_job_requests WHERE workspace_id=? AND idempotency_key=?",
            (workspace, body["idempotency_key"])).fetchone()
        if old:
            _check(old["kind"] == kind and old["request_hash"] == digest, "DUPLICATE_CONFLICT")
            return request_header(db, workspace, actor, old["id"], now=at)[1]
        workflow._revision(db, workspace, actor, body["expected_revision"])
        busy = db.execute("""SELECT 1 FROM investor_action_review_job_requests r LEFT JOIN investor_action_review_job_results u ON u.request_id=r.id
          LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
          WHERE r.workspace_id=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running','retry_queued')) LIMIT 1""",
            (JOB_TYPE, workspace, at)).fetchone()
        _check(not busy, "BUSY")
        until = _clock(instant(at) + timedelta(minutes=5)); preview_id = None
        if kind == "preview": authority_id = body["authority_id"]
        else:
            _, preview = workflow._preview_header(db, workspace, actor, body["preview_id"])
            _check(preview["workspace_revision"] == body["expected_revision"], "VERSION_CHANGED")
            _check(preview["created_at"] <= at < preview["valid_until"], "PREVIEW_EXPIRED")
            authority_id, preview_id, until = preview["authority_id"], preview["preview_id"], min(until, preview["valid_until"])
        _check(not workflow._retired(db, workspace, authority_id), "RULE_RETIRED")
        _, policy, _ = managed._authority(db, workspace, authority_id, at)
        identifier = new_id("action-review-job-request")
        doc = {"schema_version": "investor-action-review-job-request-v1", "request_id": identifier, "workspace_id": workspace,
            "provider_symbol": policy["provider_symbol"], "kind": kind, "body": body, "request_hash": digest, "created_at": at, "valid_until": until}
        _validate(doc, "request"); hashed = content_hash(doc)
        audit = _audit(db, actor, "investor_enqueue_action_review", "investor_action_review_job_request", identifier, {"content_hash": hashed}, at)
        db.execute("INSERT INTO investor_action_review_job_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, kind, authority_id,
            preview_id, body["expected_revision"], body["idempotency_key"], digest, canonical_json(doc), hashed, actor, at, until, audit))
        return doc


def discover_action_review_requests(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000, "LIMIT_INVALID")
    managed._stopped(db, stop_requested); at = _clock(now)
    rows = db.execute("""SELECT r.id,r.workspace_id,r.actor_id FROM investor_action_review_job_requests r
      WHERE NOT EXISTS(SELECT 1 FROM job_runs j WHERE j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id)
      ORDER BY r.created_at,r.id LIMIT ?""", (JOB_TYPE, limit)).fetchall()
    jobs = []
    for selected in rows:
        managed._stopped(db, stop_requested)
        with transaction(db):
            row, _ = request_header(db, selected["workspace_id"], selected["actor_id"], selected["id"], now=at)
            jobs.append(enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["content_hash"], max_attempts=1, now=at))
    return jobs


def _error(error):
    code = str(error)
    if code in managed.STOP: raise error
    if "VERSION_CONFLICT" in code or "VERSION_CHANGED" in code: return "ACTION_REVIEW_VERSION_CHANGED"
    if "PREVIEW_EXPIRED" in code: return "ACTION_REVIEW_PREVIEW_EXPIRED"
    if "REQUEST_EXPIRED" in code: return "ACTION_REVIEW_REQUEST_EXPIRED"
    if "HISTORICAL" in code: return "ACTION_REVIEW_HISTORICAL_REVIEW_REQUIRED"
    if "RETIRED" in code: return "ACTION_REVIEW_RULE_RETIRED"
    if "AUTHORITY_SELECTION_CHANGED" in code: return "ACTION_REVIEW_SCOPE_CHANGED"
    if any(key in code for key in ("TAX", "PAYMENT", "EVENT_ANSWERS", "EVENT_DATE", "decimal", "SPLIT_RATIO")): return "ACTION_REVIEW_INVALID_ANSWERS"
    return "ACTION_REVIEW_SOURCE_UNAVAILABLE"


def _selection(db, row, doc):
    leaves = db.execute("""SELECT a.id FROM investor_action_authorities a WHERE a.workspace_id=? AND json_extract(a.document_json,'$.provider_symbol')=?
      AND NOT EXISTS(SELECT 1 FROM investor_action_review_confirmations c WHERE c.previous_authority_id=a.id) LIMIT 2""",
        (row["workspace_id"], doc["provider_symbol"])).fetchall()
    _check(len(leaves) == 1 and leaves[0]["id"] == row["authority_id"], "AUTHORITY_SELECTION_CHANGED")


def prepare_action_review_job(db, job, lease, *, clock=None, stop_requested=None):
    clock = (lambda: None) if clock is None else clock
    managed._stopped(db, stop_requested); at = _clock(clock()); assert_lease(db, lease, at)
    raw = db.execute("SELECT * FROM investor_action_review_job_requests WHERE id=? AND workspace_id=?", (job["period"], job["scope"])).fetchone()
    _check(raw is not None, "OUT_OF_SCOPE")
    row, doc = request_header(db, job["scope"], raw["actor_id"], job["period"], now=at)
    _check(job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["input_version"] == row["content_hash"]
        and job["max_attempts"] == job["attempt_count"] == 1, "BINDING_CHANGED")
    prepared, failure = None, None
    try:
        _check(at < row["valid_until"], "REQUEST_EXPIRED")
        _selection(db, row, doc)
        if row["kind"] == "preview":
            prepared = workflow.prepare_action_review_preview(db, row["workspace_id"], row["actor_id"], doc["body"], clock=clock, owner_interaction=True)
        else:
            prepared = workflow.prepare_action_review_confirmation(db, row["workspace_id"], row["actor_id"], doc["body"], clock=clock)
    except ValueError as error: failure = _error(error)

    def commit(connection):
        _check(connection is db, "PREPARED_CONNECTION_CHANGED")
        managed._stopped(db, stop_requested); current = _clock(clock()); assert_lease(db, lease, current)
        selected, selected_doc = request_header(db, row["workspace_id"], row["actor_id"], row["id"], now=current)
        _check(selected["content_hash"] == row["content_hash"] and selected_doc == doc, "BINDING_CHANGED")
        resource, error_code = None, failure
        if prepared is not None:
            try:
                with transaction(db):
                    _check(current < row["valid_until"], "REQUEST_EXPIRED")
                    _selection(db, row, doc)
                    resource = prepared(db)
                    managed._stopped(db, stop_requested); current = _clock(clock()); assert_lease(db, lease, current)
                    _check(current < row["valid_until"], "REQUEST_EXPIRED")
            except ValueError as error: resource, error_code = None, _error(error)
        outcome = "preview_ready" if resource and row["kind"] == "preview" else "confirmed" if resource else "rejected"
        code = "ACTION_REVIEW_PREVIEW_READY" if outcome == "preview_ready" else "ACTION_REVIEW_CONFIRMED" if outcome == "confirmed" else error_code
        current = _clock(clock()); managed._stopped(db, stop_requested); assert_lease(db, lease, current)
        identifier = new_id("action-review-job-result")
        result = {"schema_version": "investor-action-review-job-result-v1", "result_id": identifier, "request_id": row["id"],
            "request_hash": row["content_hash"], "workspace_id": row["workspace_id"], "kind": row["kind"], "job_id": job["id"],
            "fencing_token": lease.fencing_token, "outcome": outcome, "code": code,
            "resource_id": resource["preview_id" if row["kind"] == "preview" else "confirmation_id"] if resource else None,
            "resource_hash": content_hash(resource) if resource else None, "created_at": current,
            "research_admitted": False, "trading_permission": False, "provider_calls": 0}
        _validate(result, "result"); digest = content_hash(result)
        audit = _audit(db, row["actor_id"], "investor_finish_action_review", "investor_action_review_job_result", identifier, {"content_hash": digest}, current)
        db.execute("INSERT INTO investor_action_review_job_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["id"], row["workspace_id"], job["id"],
            lease.fencing_token, row["kind"], outcome, result["resource_id"], result["resource_hash"], code, canonical_json(result), digest, row["actor_id"], current, audit))
        return JobCommit({"request_id": row["id"], "result_id": identifier, "outcome": outcome, "code": code, "research_admitted": False})
    return {"effect": commit}
