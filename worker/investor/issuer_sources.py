"""Owner-scoped issuer drafts: durable single attempts, deduplicated raw bytes.

Collection permission is separate from economic source review. Nothing here
admits research, schedules a trade, selects a portfolio or changes its weights.
"""

import base64
from datetime import timedelta
from hashlib import sha256
import re
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.market.providers import vanguard_capture as receiver
from worker.market.providers.vanguard_distributions import MAX_BYTES, PARSER_VERSION, distribution_url, distribution_window, parse_vanguard_distributions
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, stamp, transaction
from .data_evidence import _audit, _audit_binding, _object, _owner
from .runtime import _milliseconds
from .model_runtime import _clock


OFFICIAL = "isolated_fixed_issuer_https"
SYNTHETIC = "injected_test_issuer"
SCHEMA = "investor-issuer-capture.schema.json"
_KEY = re.compile(r"[a-f0-9]{32}\Z", re.ASCII)
_STOP = {"WORKER_STOP_REQUESTED", "WORKBENCH_READ_ONLY", "RESTORE_PENDING_REVIEW"}
_FAILURES = {
    "VANGUARD_CAPTURE_CALL_TIMEOUT": "ISSUER_CAPTURE_TIMEOUT",
    "VANGUARD_CAPTURE_DOWNLOAD_TIMEOUT": "ISSUER_CAPTURE_TIMEOUT",
    "VANGUARD_CAPTURE_CONNECTION_TARGET_FORBIDDEN": "ISSUER_CAPTURE_ROUTE_FORBIDDEN",
    "VANGUARD_CAPTURE_NONPUBLIC_ADDRESS_FORBIDDEN": "ISSUER_CAPTURE_ROUTE_FORBIDDEN",
    "VANGUARD_CAPTURE_HTTP_FORBIDDEN": "ISSUER_CAPTURE_HTTP_FORBIDDEN",
    "VANGUARD_CAPTURE_HTTP_RATE_LIMITED": "ISSUER_CAPTURE_RATE_LIMITED",
    "VANGUARD_CAPTURE_HTTP_UNAVAILABLE": "ISSUER_CAPTURE_UNAVAILABLE",
    "VANGUARD_CAPTURE_INVALID": "ISSUER_CAPTURE_INVALID_RESPONSE",
}


def _check(value, code="INVALID"):
    if not value:
        raise WorkbenchError("INVESTOR_ISSUER_" + code)


def _sealed(row, schema, fragment=None):
    _check(row is not None, "OUT_OF_SCOPE")
    doc = _object(row["document_json"])
    validate_contract(doc, schema, **({"fragment": fragment} if fragment else {}))
    _check(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"])
    return doc


def _grant(db, workspace, authority_id, at):
    row = db.execute("SELECT * FROM investor_issuer_authorities WHERE id=? AND workspace_id=?", (authority_id, workspace)).fetchone()
    doc = _sealed(row, "investor-issuer-authority.schema.json")
    _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_register_issuer_authority", "investor_issuer_authority", authority_id)
    _check(row["created_at"] <= at and instant(doc["valid_from"]) < instant(doc["valid_until"]))
    distribution_url(doc["fund_id"], doc["has_distribution_yield"])
    control = db.execute("SELECT * FROM investor_issuer_controls WHERE authority_id=? AND workspace_id=? ORDER BY version DESC LIMIT 1", (authority_id, workspace)).fetchone()
    if control is not None:
        _control(db, row, control, at)
    return row, doc, control


def _control(db, authority, row, at):
    doc = _sealed(row, SCHEMA, "$defs/control")
    _owner(db, authority["workspace_id"], row["actor_id"])
    _check(row["authority_id"] == doc["authority_id"] == authority["id"] and row["workspace_id"] == authority["workspace_id"]
        and doc["authority_hash"] == authority["content_hash"] and row["actor_id"] == authority["actor_id"]
        and row["version"] == doc["version"] and row["enabled"] == int(doc["enabled"])
        and row["created_at"] == doc["created_at"] and authority["created_at"] <= row["created_at"] <= at)
    _audit_binding(db, row, "investor_control_issuer_authority", "investor_issuer_control", row["id"])
    return doc


def _active(policy, control, at):
    return control is not None and control["enabled"] == 1 and instant(policy["valid_from"]) <= instant(at) < instant(policy["valid_until"])


def register_authority(db, workspace, actor, policy, *, now=None):
    policy = _object(canonical_json(policy)); at = _milliseconds(now)
    validate_contract(policy, "investor-issuer-authority.schema.json")
    for key in ("valid_from", "valid_until"):
        policy[key] = _milliseconds(policy[key])
    _check(len(canonical_json(policy).encode()) <= 16384 and instant(policy["valid_from"]) < instant(policy["valid_until"]))
    distribution_url(policy["fund_id"], policy["has_distribution_yield"])
    digest = content_hash(policy)
    with transaction(db):
        _owner(db, workspace, actor)
        old = db.execute("SELECT id FROM investor_issuer_authorities WHERE workspace_id=? AND content_hash=?", (workspace, digest)).fetchone()
        if old:
            return dict(_grant(db, workspace, old["id"], at)[0])
        identifier = new_id("issuer-authority")
        audit = _audit(db, actor, "investor_register_issuer_authority", "investor_issuer_authority", identifier, {"content_hash": digest}, at)
        db.execute("INSERT INTO investor_issuer_authorities VALUES(?,?,?,?,?,?,?)", (identifier, workspace, canonical_json(policy), digest, actor, at, audit))
        set_authority_enabled(db, workspace, actor, identifier, False, now=at)
        return dict(db.execute("SELECT * FROM investor_issuer_authorities WHERE id=?", (identifier,)).fetchone())


def set_authority_enabled(db, workspace, actor, authority_id, enabled, *, now=None):
    _check(type(enabled) is bool); at = _milliseconds(now)
    with transaction(db):
        _owner(db, workspace, actor)
        row, policy, old = _grant(db, workspace, authority_id, at)
        _check(not enabled or instant(policy["valid_from"]) <= instant(at) < instant(policy["valid_until"]), "AUTHORITY_EXPIRED")
        if old is not None and old["enabled"] == int(enabled):
            return dict(old)
        identifier = new_id("issuer-control"); version = old["version"] + 1 if old else 1
        doc = {"schema_version": "investor-issuer-control-v1", "authority_id": authority_id, "authority_hash": row["content_hash"],
            "version": version, "enabled": enabled, "created_at": at}
        validate_contract(doc, SCHEMA, fragment="$defs/control")
        digest = content_hash(doc)
        audit = _audit(db, actor, "investor_control_issuer_authority", "investor_issuer_control", identifier, {"content_hash": digest}, at)
        db.execute("INSERT INTO investor_issuer_controls VALUES(?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, authority_id, version,
            int(enabled), canonical_json(doc), digest, actor, at, audit))
        return dict(db.execute("SELECT * FROM investor_issuer_controls WHERE id=?", (identifier,)).fetchone())


def _request_header(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_issuer_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    doc = _sealed(row, SCHEMA, "$defs/request")
    _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_start_issuer_capture", "investor_issuer_request", identifier)
    grant, policy, _ = _grant(db, workspace, row["authority_id"], at)
    control = db.execute("SELECT * FROM investor_issuer_controls WHERE id=? AND workspace_id=?", (row["control_id"], workspace)).fetchone()
    _control(db, grant, control, at)
    _check(all(row[k] == doc[k] for k in ("authority_id", "control_id", "request_key", "fund_id", "issuer_day", "created_at"))
        and row["fund_id"] == policy["fund_id"]
        and grant["content_hash"] == doc["authority_hash"] and control["content_hash"] == doc["control_hash"]
        and grant["actor_id"] == row["actor_id"] and row["created_at"] <= at and control["enabled"] == 1)
    _check(instant(policy["valid_from"]) <= instant(row["created_at"]) < instant(policy["valid_until"]))
    _check(doc["issuer_day"] == instant(row["created_at"]).astimezone(ZoneInfo("America/New_York")).date().isoformat())
    distribution_window(row["created_at"], doc["start_date"], doc["end_date"])
    return row, doc, grant, policy


def _capture_header(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_issuer_captures WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    doc = _sealed(row, SCHEMA, "$defs/result")
    _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_finish_issuer_capture", "investor_issuer_capture", identifier)
    request, requested, grant, policy = _request_header(db, workspace, row["request_id"], at)
    _check(all(row[column] == doc[key] for column, key in (("id", "capture_id"), ("workspace_id", "workspace_id"),
        ("request_id", "request_id"), ("qualification", "qualification"), ("status", "status"), ("raw_sha256", "raw_sha256"),
        ("raw_bytes", "raw_bytes"), ("created_at", "created_at"), ("retain_until", "retain_until")))
        and doc["request_hash"] == request["content_hash"] and request["actor_id"] == row["actor_id"]
        and request["created_at"] <= row["created_at"] <= at)
    if row["status"] == "captured":
        expiry = _milliseconds(min(instant(policy["valid_until"]), instant(row["created_at"]) + timedelta(days=policy["retention_days"])))
        _check(row["retain_until"] == expiry and row["created_at"] < expiry and doc["parser_version"] == PARSER_VERSION)
    return row, doc, request, requested, grant, policy


def request_state(db, workspace, actor, request_key, *, now=None):
    _owner(db, workspace, actor); _check(type(request_key) is str and _KEY.fullmatch(request_key))
    row = db.execute("SELECT id FROM investor_issuer_requests WHERE workspace_id=? AND request_key=?", (workspace, request_key)).fetchone()
    _check(row is not None, "OUT_OF_SCOPE"); at = _milliseconds(now)
    request = _request_header(db, workspace, row["id"], at)[0]
    result = db.execute("SELECT id FROM investor_issuer_captures WHERE request_id=?", (request["id"],)).fetchone()
    capture = _capture_header(db, workspace, result["id"], at)[0] if result else None
    return {"request_id": request["id"], "request_hash": request["content_hash"], "capture_id": capture["id"] if capture else None,
        "status": capture["status"] if capture else "indeterminate", "automatic_retry_permitted": False,
        "research_admitted": False, "live_advice_eligible": False}


def _start(db, workspace, actor, authority_id, key, start, end, at):
    _check(type(key) is str and _KEY.fullmatch(key)); distribution_window(at, start, end)
    with transaction(db):
        _owner(db, workspace, actor)
        previous = db.execute("SELECT id FROM investor_issuer_requests WHERE workspace_id=? AND request_key=?", (workspace, key)).fetchone()
        if previous:
            row, doc, _, _ = _request_header(db, workspace, previous["id"], at)
            _check(row["authority_id"] == authority_id and doc["start_date"] == start and doc["end_date"] == end, "REQUEST_KEY_CONFLICT")
            return row, doc, False
        grant, policy, control = _grant(db, workspace, authority_id, at)
        _check(_active(policy, control, at), "AUTHORITY_INACTIVE")
        day = instant(at).astimezone(ZoneInfo("America/New_York")).date().isoformat()
        _check(not db.execute("SELECT 1 FROM investor_issuer_requests WHERE workspace_id=? AND fund_id=? AND issuer_day=?", (workspace, policy["fund_id"], day)).fetchone(), "DAY_ALREADY_STARTED")
        identifier = new_id("issuer-request")
        doc = {"schema_version": "investor-issuer-request-v1", "authority_id": authority_id, "authority_hash": grant["content_hash"],
            "control_id": control["id"], "control_hash": control["content_hash"], "request_key": key, "fund_id": policy["fund_id"], "issuer_day": day,
            "start_date": start, "end_date": end, "created_at": at, "collection_scope": "unapproved_distribution_draft_only"}
        validate_contract(doc, SCHEMA, fragment="$defs/request"); digest = content_hash(doc)
        audit = _audit(db, actor, "investor_start_issuer_capture", "investor_issuer_request", identifier, {"content_hash": digest}, at)
        db.execute("INSERT INTO investor_issuer_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, authority_id, control["id"], key, policy["fund_id"], day,
            canonical_json(doc), digest, actor, at, audit))
        return db.execute("SELECT * FROM investor_issuer_requests WHERE id=?", (identifier,)).fetchone(), doc, True


def _validated_result(value, policy, request, before, after):
    _check(type(value) is dict and set(value) == {"schema_version", "raw", "receipt", "draft"} and value["schema_version"] == receiver.VERSION)
    raw = value["raw"]; _check(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES)
    encoded = canonical_json({**value["receipt"], "raw_base64": base64.b64encode(raw).decode()}).encode()
    raw, transport = receiver._receipt(encoded, {"fund_id": policy["fund_id"], "has_distribution_yield": policy["has_distribution_yield"], "timeout_seconds": 30}, before, after)
    draft = parse_vanguard_distributions(raw, fund_id=policy["fund_id"], has_distribution_yield=policy["has_distribution_yield"],
        start_date=request["start_date"], end_date=request["end_date"], retrieved_at=transport["retrieved_at"])
    _check(draft == value["draft"])
    return raw, _object(canonical_json(transport)), content_hash(draft)


def collect_issuer_draft(db, workspace, actor, authority_id, request_key, start_date, end_date, *,
        now=None, test_collector=None, stop_requested=None):
    _check(test_collector is None or callable(test_collector))
    _check(test_collector is not None or now is None, "PRODUCTION_CLOCK_NOT_CALLER_CONTROLLED")
    _check(not db.in_transaction, "IO_TRANSACTION_FORBIDDEN"); assert_writable(db); _owner(db, workspace, actor)
    def stopped():
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        assert_writable(db)
    stopped(); at = _milliseconds(now)
    request, document, fresh = _start(db, workspace, actor, authority_id, request_key, start_date, end_date, at)
    if not fresh:
        return request_state(db, workspace, actor, request_key, now=at)
    effect = _prepare_started_issuer_draft(db, workspace, actor, request, document, clock=lambda: now,
        test_collector=test_collector, stop_requested=stop_requested)
    with transaction(db):
        result = effect(db)
    return request_state(db, workspace, actor, request_key, now=result["created_at"])


def _prepare_started_issuer_draft(db, workspace, actor, request, document, *, clock,
        test_collector=None, stop_requested=None, guard=None, eligible=None):
    """Transport outside the write transaction; caller owns the final commit fence."""
    _check(not db.in_transaction, "IO_TRANSACTION_FORBIDDEN")
    at = _clock(clock())
    _, policy, _ = _grant(db, workspace, request["authority_id"], at)
    def stopped(connection):
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        assert_writable(connection)
        if guard: guard(connection, _clock(clock()))
    def changed(connection):
        stopped(connection); checked = _clock(clock())
        grant, current, head = _grant(connection, workspace, request["authority_id"], checked)
        return (grant["content_hash"] != document["authority_hash"] or not _active(current, head, checked)
            or head["id"] != document["control_id"] or eligible is not None and not eligible(connection, checked))
    raw = transport = draft_hash = None
    status, code = "superseded", "ISSUER_AUTHORITY_CHANGED"
    if not changed(db):
        before = stamp(instant(clock())); value = None
        try:
            collector = test_collector or receiver.collect_vanguard_distribution_draft
            value = collector(fund_id=policy["fund_id"], has_distribution_yield=policy["has_distribution_yield"],
                start_date=document["start_date"], end_date=document["end_date"], timeout_seconds=30)
        except Exception as error:
            if isinstance(error, WorkbenchError) and str(error) in _STOP: raise
            text = str(error)
            code = _FAILURES.get(text, "ISSUER_CAPTURE_TRANSPORT_FAILED") if isinstance(error, WorkbenchError) else "ISSUER_CAPTURE_TRANSPORT_FAILED"
            status = "transport_failed"
        if changed(db):
            status, code = "superseded", "ISSUER_AUTHORITY_CHANGED"
        elif value is not None:
            try:
                raw, transport, draft_hash = _validated_result(value, policy, document, before, stamp(instant(clock())))
                status, code = "captured", "ISSUER_DRAFT_CAPTURED"
            except Exception:
                raw = transport = draft_hash = None
                status, code = "transport_failed", "ISSUER_CAPTURE_RESPONSE_INVALID"
        elif status != "transport_failed":
            status, code = "transport_failed", "ISSUER_CAPTURE_RESPONSE_INVALID"
    def effect(connection):
        stopped(connection); created = _clock(clock())
        current_request = _request_header(connection, workspace, request["id"], created)[0]
        _check(current_request["content_hash"] == request["content_hash"])
        data, headers, draft, final, reason = raw, transport, draft_hash, status, code
        if changed(connection):
            data = headers = draft = None; final, reason = "superseded", "ISSUER_AUTHORITY_CHANGED"
        expiry = _milliseconds(min(instant(policy["valid_until"]), instant(created) + timedelta(days=policy["retention_days"]))) if final == "captured" else None
        _check(expiry is None or created < expiry)
        identifier = new_id("issuer-capture")
        receipt = {"schema_version": "investor-issuer-capture-v1", "capture_id": identifier, "workspace_id": workspace,
            "request_id": request["id"], "request_hash": request["content_hash"], "qualification": OFFICIAL if test_collector is None else SYNTHETIC,
            "status": final, "reason_code": reason, "raw_sha256": sha256(data).hexdigest() if data is not None else None,
            "raw_bytes": len(data) if data is not None else None, "draft_hash": draft,
            "parser_version": PARSER_VERSION if data is not None else None, "transport": headers, "created_at": created,
            "retain_until": expiry, "owner_reviewed": False, "research_admitted": False, "corporate_actions_complete": False, "live_advice_eligible": False}
        validate_contract(receipt, SCHEMA, fragment="$defs/result"); encoded = canonical_json(receipt)
        _check(len(encoded.encode()) <= 16384)
        digest = content_hash(receipt)
        audit = _audit(connection, actor, "investor_finish_issuer_capture", "investor_issuer_capture", identifier, {"content_hash": digest}, created)
        connection.execute("INSERT INTO investor_issuer_captures VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, request["id"], receipt["qualification"],
            final, receipt["raw_sha256"], receipt["raw_bytes"], encoded, digest, actor, created, expiry, audit))
        if data is not None:
            old = connection.execute("SELECT payload FROM investor_issuer_payloads WHERE workspace_id=? AND raw_sha256=?", (workspace, receipt["raw_sha256"])).fetchone()
            if old:
                _check(bytes(old[0]) == data, "PAYLOAD_CONFLICT")
            else:
                connection.execute("INSERT INTO investor_issuer_payloads VALUES(?,?,?,?,?)", (workspace, receipt["raw_sha256"], len(data), data, created))
        stopped(connection)
        return {"capture_id": identifier, "status": final, "reason_code": reason, "created_at": created}
    return effect


def resolve_issuer_capture(db, workspace, actor, capture_id, *, now=None, allow_synthetic=False):
    _check(type(allow_synthetic) is bool)
    _owner(db, workspace, actor); at = _milliseconds(now)
    row, doc, request, requested, _, policy = _capture_header(db, workspace, capture_id, at)
    _check(row["status"] == "captured", "CAPTURE_NOT_COMPLETE")
    _check(allow_synthetic or row["qualification"] == OFFICIAL, "SYNTHETIC_CAPTURE_FORBIDDEN")
    _check(_purge_header(db, workspace, capture_id, at) is None, "PAYLOAD_PURGED")
    _, current_policy, head = _grant(db, workspace, request["authority_id"], at)
    _check(_active(current_policy, head, at) and head["id"] == request["control_id"], "AUTHORITY_INACTIVE")
    _check(at < row["retain_until"], "RETENTION_EXPIRED")
    body = db.execute("SELECT payload FROM investor_issuer_payloads WHERE workspace_id=? AND raw_sha256=?", (workspace, row["raw_sha256"])).fetchone()
    _check(body is not None, "PAYLOAD_UNAVAILABLE"); raw = bytes(body[0])
    value = {"schema_version": receiver.VERSION, "raw": raw, "receipt": doc["transport"],
        "draft": parse_vanguard_distributions(raw, fund_id=policy["fund_id"], has_distribution_yield=policy["has_distribution_yield"],
            start_date=requested["start_date"], end_date=requested["end_date"], retrieved_at=doc["transport"]["retrieved_at"])}
    raw, transport, draft_hash = _validated_result(value, policy, requested, request["created_at"],
        stamp(instant(row["created_at"]) + timedelta(milliseconds=1)))
    _check(sha256(raw).hexdigest() == row["raw_sha256"] and len(raw) == row["raw_bytes"] and draft_hash == doc["draft_hash"])
    return {"capture": dict(row), "receipt": doc, "raw": raw, "draft": value["draft"]}


def _purge_header(db, workspace, capture_id, at):
    row = db.execute("SELECT * FROM investor_issuer_purges WHERE capture_id=?", (capture_id,)).fetchone()
    if row is None:
        return None
    _check(row["workspace_id"] == workspace and row["created_at"] <= at
        and row["reason"] in ("retention_expired", "authority_no_longer_active"))
    _owner(db, workspace, row["actor_id"])
    audit = db.execute("SELECT * FROM audit_events WHERE id=?", (row["audit_id"],)).fetchone()
    _check(audit is not None and audit["actor_id"] == row["actor_id"] and audit["created_at"] == row["created_at"]
        and audit["action"] == "investor_purge_issuer_capture" and audit["object_type"] == "investor_issuer_capture"
        and audit["object_id"] == capture_id and _object(audit["payload_json"]) == {"reason": row["reason"]})
    return row


def purge_issuer_capture(db, workspace, actor, capture_id, *, now=None):
    at = _milliseconds(now)
    with transaction(db):
        _owner(db, workspace, actor)
        row, _, request, _, _, _ = _capture_header(db, workspace, capture_id, at)
        _check(row["status"] == "captured", "CAPTURE_NOT_COMPLETE")
        old = _purge_header(db, workspace, capture_id, at)
        if old:
            _check(old["created_at"] <= at)
            return dict(old)
        _, policy, head = _grant(db, workspace, request["authority_id"], at)
        inactive = not _active(policy, head, at) or head["id"] != request["control_id"]
        _check(inactive or row["retain_until"] <= at, "PURGE_NOT_DUE")
        reason = "retention_expired" if row["retain_until"] <= at else "authority_no_longer_active"
        audit = _audit(db, actor, "investor_purge_issuer_capture", "investor_issuer_capture", capture_id, {"reason": reason}, at)
        db.execute("INSERT INTO investor_issuer_purges VALUES(?,?,?,?,?,?)", (capture_id, workspace, reason, actor, at, audit))
        remaining = db.execute("SELECT 1 FROM investor_issuer_captures c WHERE c.workspace_id=? AND c.raw_sha256=? AND NOT EXISTS(SELECT 1 FROM investor_issuer_purges p WHERE p.capture_id=c.id)",
            (workspace, row["raw_sha256"])).fetchone()
        if not remaining:
            references = db.execute("SELECT id FROM investor_issuer_captures WHERE workspace_id=? AND raw_sha256=? LIMIT 100001", (workspace, row["raw_sha256"])).fetchall()
            _check(len(references) <= 100000, "PAYLOAD_REFERENCE_LIMIT")
            for reference in references:
                _check(_purge_header(db, workspace, reference["id"], at) is not None)
            db.execute("DELETE FROM investor_issuer_payloads WHERE workspace_id=? AND raw_sha256=?", (workspace, row["raw_sha256"]))
        return dict(db.execute("SELECT * FROM investor_issuer_purges WHERE capture_id=?", (capture_id,)).fetchone())
