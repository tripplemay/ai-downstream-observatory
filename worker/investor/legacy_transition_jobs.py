"""Explicit owner intent; one local attempt atomically confirms and registers v5."""

from datetime import timedelta

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job
from . import legacy_transition_source as source, legacy_transition_workflow as workflow, managed_actions as managed
from .data_evidence import _audit, _audit_binding, _object, _owner
from .model_runtime import _clock


SCHEMA = "investor-legacy-transition-job.schema.json"
JOB_TYPE = "investor_legacy_transition"


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("LEGACY_TRANSITION_JOB_" + code)


def _validate(doc, fragment):
    try: validate_contract(doc, SCHEMA, fragment="$defs/" + fragment)
    except ValueError: raise WorkbenchError("LEGACY_TRANSITION_JOB_DOCUMENT_INVALID") from None


def source_request(receipt, nonce):
    return {"transition_id": receipt["confirmation_id"], "transition_hash": content_hash(receipt),
        "expected_revision": receipt["workspace_revision"], "idempotency_key": "legacy-source:" + content_hash(nonce)}


def request_header(db, workspace, actor, identifier, *, now=None):
    _owner(db, workspace, actor)
    row = db.execute("SELECT * FROM investor_legacy_transition_job_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _check(row is not None, "OUT_OF_SCOPE")
    doc = _object(row["document_json"]); _validate(doc, "request"); body = doc["body"]
    _check(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"] and row["actor_id"] == actor
        and doc["request_id"] == row["id"] and all(doc[key] == row[key] for key in
            ("workspace_id", "model_id", "kind", "request_hash", "created_at", "valid_until"))
        and type(body["expected_revision"]) is int and body["expected_revision"] == row["expected_revision"]
        and body["idempotency_key"] == row["idempotency_key"] and content_hash(body) == row["request_hash"]
        and instant(row["created_at"]) <= instant(_clock(now))
        and 0 < (instant(row["valid_until"]) - instant(row["created_at"])).total_seconds() <= 300)
    model = db.execute("SELECT id FROM investor_models WHERE workspace_id=? AND id=?", (workspace, row["model_id"])).fetchone()
    _check(model is not None)
    _audit_binding(db, row, "investor_enqueue_legacy_transition", "investor_legacy_transition_job_request", identifier)
    if row["kind"] == "preview": _check(body["model_id"] == row["model_id"] and row["preview_id"] is None)
    else:
        _, witness, _ = workflow._preview_header(db, workspace, actor, body["preview_id"])
        _check(witness["preview_id"] == row["preview_id"] and witness["model_id"] == row["model_id"]
            and witness["workspace_revision"] == row["expected_revision"] and witness["created_at"] <= row["created_at"]
            and row["valid_until"] <= witness["valid_until"] and content_hash(witness) == body["expected_preview_hash"])
    return row, doc


def enqueue_legacy_transition_request(db, workspace, actor, kind, body, *, now=None):
    managed._stopped(db, None); _owner(db, workspace, actor)
    _check(kind in ("preview", "confirmation"), "KIND_INVALID")
    workflow._validate(body, "preview_request" if kind == "preview" else "submit")
    body = _object(canonical_json(body)); digest, at = content_hash(body), _clock(now)
    with transaction(db):
        old = db.execute("SELECT id,kind,request_hash FROM investor_legacy_transition_job_requests WHERE workspace_id=? AND idempotency_key=?",
            (workspace, body["idempotency_key"])).fetchone()
        if old:
            _check(old["kind"] == kind and old["request_hash"] == digest, "DUPLICATE_CONFLICT")
            return request_header(db, workspace, actor, old["id"], now=at)[1]
        workflow._revision(db, workspace, actor, body["expected_revision"])
        busy = db.execute("""SELECT 1 FROM investor_legacy_transition_job_requests r LEFT JOIN investor_legacy_transition_job_results u ON u.request_id=r.id
          LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
          WHERE r.workspace_id=? AND r.valid_until>? AND u.id IS NULL AND (j.id IS NULL OR j.status IN ('queued','running','retry_queued')) LIMIT 1""",
            (JOB_TYPE, workspace, at)).fetchone()
        _check(not busy, "BUSY")
        until, preview_id = _clock(instant(at) + timedelta(minutes=5)), None
        if kind == "preview": model_id = body["model_id"]
        else:
            _, witness, _ = workflow._preview_header(db, workspace, actor, body["preview_id"])
            _check(witness["workspace_revision"] == body["expected_revision"], "VERSION_CHANGED")
            _check(content_hash(witness) == body["expected_preview_hash"], "PREVIEW_CHANGED")
            _check(witness["created_at"] <= at < witness["valid_until"], "PREVIEW_EXPIRED")
            model_id, preview_id, until = witness["model_id"], witness["preview_id"], min(until, witness["valid_until"])
        _check(db.execute("SELECT 1 FROM investor_models WHERE workspace_id=? AND id=?", (workspace, model_id)).fetchone(), "MODEL_UNAVAILABLE")
        _check(not db.execute("SELECT 1 FROM investor_legacy_transition_confirmations WHERE workspace_id=? AND model_id=?", (workspace, model_id)).fetchone(), "ALREADY_CONFIRMED")
        identifier = new_id("legacy-transition-job-request")
        doc = {"schema_version": "investor-legacy-transition-job-request-v1", "request_id": identifier, "workspace_id": workspace,
            "model_id": model_id, "kind": kind, "body": body, "request_hash": digest, "created_at": at, "valid_until": until}
        _validate(doc, "request"); hashed = content_hash(doc)
        audit = _audit(db, actor, "investor_enqueue_legacy_transition", "investor_legacy_transition_job_request", identifier, {"content_hash": hashed}, at)
        db.execute("INSERT INTO investor_legacy_transition_job_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, kind, model_id,
            preview_id, body["expected_revision"], body["idempotency_key"], digest, canonical_json(doc), hashed, actor, at, until, audit))
        return doc


def discover_legacy_transition_requests(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000, "LIMIT_INVALID")
    managed._stopped(db, stop_requested); at = _clock(now)
    rows = db.execute("""SELECT r.id,r.workspace_id,r.actor_id FROM investor_legacy_transition_job_requests r
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
    if "VERSION_CONFLICT" in code or "VERSION_CHANGED" in code: return "LEGACY_TRANSITION_VERSION_CHANGED"
    if "PREVIEW_EXPIRED" in code: return "LEGACY_TRANSITION_PREVIEW_EXPIRED"
    if "REQUEST_EXPIRED" in code: return "LEGACY_TRANSITION_REQUEST_EXPIRED"
    if "ALREADY_CONFIRMED" in code: return "LEGACY_TRANSITION_ALREADY_CONFIRMED"
    if "RESTATEMENT" in code or "UNPROCESSED" in code: return "LEGACY_TRANSITION_RESTATEMENT_REQUIRED"
    return "LEGACY_TRANSITION_SOURCE_UNAVAILABLE"


def prepare_legacy_transition_job(db, job, lease, *, clock=None, stop_requested=None):
    clock = (lambda: None) if clock is None else clock
    managed._stopped(db, stop_requested); at = _clock(clock()); assert_lease(db, lease, at)
    raw = db.execute("SELECT * FROM investor_legacy_transition_job_requests WHERE id=? AND workspace_id=?", (job["period"], job["scope"])).fetchone()
    _check(raw is not None, "OUT_OF_SCOPE")
    row, doc = request_header(db, job["scope"], raw["actor_id"], job["period"], now=at)
    _check(job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["input_version"] == row["content_hash"]
        and job["max_attempts"] == job["attempt_count"] == 1, "BINDING_CHANGED")
    prepared, failure = None, None
    try:
        _check(at < row["valid_until"], "REQUEST_EXPIRED")
        prepare = workflow.prepare_legacy_transition_preview if row["kind"] == "preview" else workflow.prepare_legacy_transition_confirmation
        prepared = prepare(db, row["workspace_id"], row["actor_id"], doc["body"], clock=clock, stop_requested=stop_requested)
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
                    resource = prepared(db)
                    if row["kind"] == "confirmation":
                        # Both writes share the enclosing final lease-fenced transaction.
                        resource = source.admit_legacy_transition_source(db, row["workspace_id"], row["actor_id"],
                            source_request(resource, doc["body"]["idempotency_key"]), clock=clock, stop_requested=stop_requested)
                    managed._stopped(db, stop_requested); current = _clock(clock()); assert_lease(db, lease, current)
                    _check(current < row["valid_until"], "REQUEST_EXPIRED")
            except ValueError as error: resource, error_code = None, _error(error)
        outcome = "preview_ready" if resource and row["kind"] == "preview" else "registered" if resource else "rejected"
        code = "LEGACY_TRANSITION_PREVIEW_READY" if outcome == "preview_ready" else "LEGACY_TRANSITION_REGISTERED" if outcome == "registered" else error_code
        current = _clock(clock()); managed._stopped(db, stop_requested); assert_lease(db, lease, current)
        identifier = new_id("legacy-transition-job-result")
        result = {"schema_version": "investor-legacy-transition-job-result-v1", "result_id": identifier, "request_id": row["id"],
            "request_hash": row["content_hash"], "workspace_id": row["workspace_id"], "kind": row["kind"], "job_id": job["id"],
            "fencing_token": lease.fencing_token, "outcome": outcome, "code": code,
            "resource_id": resource["preview_id" if row["kind"] == "preview" else "admission_id"] if resource else None,
            "resource_hash": content_hash(resource) if resource else None, "created_at": current,
            "monitor_source_registered": outcome == "registered", "current_advice_certified": False,
            "monitoring_activated": False, "trading_permission": False, "provider_calls": 0}
        _validate(result, "result"); digest = content_hash(result)
        audit = _audit(db, row["actor_id"], "investor_finish_legacy_transition", "investor_legacy_transition_job_result", identifier, {"content_hash": digest}, current)
        db.execute("INSERT INTO investor_legacy_transition_job_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["id"], row["workspace_id"], job["id"],
            lease.fencing_token, row["kind"], outcome, result["resource_id"], result["resource_hash"], code, canonical_json(result), digest, row["actor_id"], current, audit))
        return JobCommit({"request_id": row["id"], "result_id": identifier, "outcome": outcome, "code": code, "monitor_source_registered": outcome == "registered"})
    return {"effect": commit}
