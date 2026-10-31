"""Standing owner FX rule, leased single attempts and immutable current heads.

The owner reviews the standing derivation/use rule, not every new rate. All
automatic publications explicitly retain human_review_performed=False. Source
freshness and investment/trading authority remain separate downstream gates.
"""

import base64
from datetime import datetime, time, timedelta
from hashlib import sha256
from zoneinfo import ZoneInfo

from worker.accounting.decimal_math import decimal
from worker.market.contracts import validate_contract
from worker.market.providers import ecb_current as receiver
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, stamp, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job, enqueue_notification
from .data_evidence import _audit, _audit_binding, _object, _owner, review_source, store_source, validate_facts
from .model_runtime import _clock


SCHEMA = "investor-managed-fx.schema.json"
JOB_TYPE = "investor_current_fx"
QUALIFICATION = "isolated_ecb_reference_https"
ZONE = ZoneInfo("Europe/Berlin")
STOP = {"WORKER_STOP_REQUESTED", "WORKBENCH_READ_ONLY", "RESTORE_PENDING_REVIEW", "STALE_OR_EXPIRED_LEASE"}


def _check(value, code="INVALID"):
    if not value:
        raise WorkbenchError("INVESTOR_FX_" + code)


def _sealed(row, fragment):
    _check(row is not None, "OUT_OF_SCOPE")
    doc = _object(row["document_json"])
    validate_contract(doc, SCHEMA, fragment="$defs/" + fragment)
    _check(canonical_json(doc) == row["document_json"] and content_hash(doc) == row["content_hash"])
    return doc


def _control(db, authority, row, at):
    doc = _sealed(row, "control")
    _owner(db, authority["workspace_id"], row["actor_id"])
    _audit_binding(db, row, "investor_control_fx_authority", "investor_fx_control", row["id"])
    _check(row["workspace_id"] == authority["workspace_id"] and row["authority_id"] == doc["authority_id"] == authority["id"]
        and row["actor_id"] == authority["actor_id"] and doc["authority_hash"] == authority["content_hash"]
        and doc["version"] == row["version"] and type(row["enabled"]) is int and doc["enabled"] == bool(row["enabled"])
        and authority["created_at"] <= row["created_at"] == doc["created_at"] <= at)
    return doc


def _authority(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_fx_authorities WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    doc = _sealed(row, "authority")
    _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_register_fx_authority", "investor_fx_authority", identifier)
    _check(row["created_at"] <= at and instant(doc["valid_from"]) < instant(doc["valid_until"])
        and doc["currencies"] == sorted(doc["currencies"]))
    control = db.execute("SELECT * FROM investor_fx_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1", (identifier,)).fetchone()
    if control is not None:
        _control(db, row, control, at)
    return row, doc, control


def _active(policy, control, at):
    return control is not None and control["enabled"] == 1 and instant(policy["valid_from"]) <= instant(at) < instant(policy["valid_until"])


def _quarantined(db, authority_id, at):
    row = db.execute("SELECT id,workspace_id FROM investor_fx_publications WHERE authority_id=? AND status='blocked' ORDER BY sequence DESC LIMIT 1", (authority_id,)).fetchone()
    if row is None: return False
    blocked, _ = _publication_header(db, row["workspace_id"], row["id"], at)
    _check(blocked["authority_id"] == authority_id and blocked["status"] == "blocked")
    return True


def register_authority(db, workspace, actor, policy, *, now=None):
    policy = _object(canonical_json(policy)); at = _clock(now)
    validate_contract(policy, SCHEMA, fragment="$defs/authority")
    policy["currencies"] = sorted(policy["currencies"])
    for key in ("valid_from", "valid_until"):
        policy[key] = _clock(policy[key])
    _check(instant(policy["valid_from"]) < instant(policy["valid_until"]) and len(canonical_json(policy).encode()) <= 16384)
    digest = content_hash(policy)
    with transaction(db):
        _owner(db, workspace, actor)
        old = db.execute("SELECT id FROM investor_fx_authorities WHERE workspace_id=? AND content_hash=?", (workspace, digest)).fetchone()
        if old:
            return dict(_authority(db, workspace, old["id"], at)[0])
        identifier = new_id("fx-authority")
        audit = _audit(db, actor, "investor_register_fx_authority", "investor_fx_authority", identifier, {"content_hash": digest}, at)
        db.execute("INSERT INTO investor_fx_authorities VALUES(?,?,?,?,?,?,?)", (identifier, workspace, canonical_json(policy), digest, actor, at, audit))
        set_authority_enabled(db, workspace, actor, identifier, False, now=at)
        return dict(db.execute("SELECT * FROM investor_fx_authorities WHERE id=?", (identifier,)).fetchone())


def set_authority_enabled(db, workspace, actor, identifier, enabled, *, now=None):
    _check(type(enabled) is bool); at = _clock(now)
    with transaction(db):
        _owner(db, workspace, actor)
        authority, policy, old = _authority(db, workspace, identifier, at)
        _check(not enabled or instant(policy["valid_from"]) <= instant(at) < instant(policy["valid_until"]), "AUTHORITY_EXPIRED")
        _check(not enabled or not _quarantined(db, identifier, at), "SOURCE_QUARANTINED")
        if enabled:
            others = db.execute("""SELECT s.id FROM investor_fx_authorities s JOIN investor_fx_controls c ON c.authority_id=s.id
                WHERE s.workspace_id=? AND s.id!=? AND c.enabled=1 AND c.version=(SELECT max(version) FROM investor_fx_controls WHERE authority_id=s.id)
                AND json_extract(s.document_json,'$.valid_from')<=? AND json_extract(s.document_json,'$.valid_until')>? LIMIT 2""", (workspace, identifier, at, at)).fetchall()
            _check(not others, "ACTIVE_AUTHORITY_EXISTS")
        if old is not None and old["enabled"] == int(enabled):
            return dict(old)
        control_id = new_id("fx-control")
        doc = {"schema_version": "investor-fx-control-v1", "authority_id": identifier, "authority_hash": authority["content_hash"],
            "version": old["version"] + 1 if old else 1, "enabled": enabled, "created_at": at}
        validate_contract(doc, SCHEMA, fragment="$defs/control"); digest = content_hash(doc)
        audit = _audit(db, actor, "investor_control_fx_authority", "investor_fx_control", control_id, {"content_hash": digest}, at)
        db.execute("INSERT INTO investor_fx_controls VALUES(?,?,?,?,?,?,?,?,?,?)", (control_id, workspace, identifier, doc["version"], int(enabled),
            canonical_json(doc), digest, actor, at, audit))
        return dict(db.execute("SELECT * FROM investor_fx_controls WHERE id=?", (control_id,)).fetchone())


def _request(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_fx_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    doc = _sealed(row, "request")
    _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_schedule_fx_capture", "investor_fx_request", identifier)
    authority, policy, _ = _authority(db, workspace, row["authority_id"], at)
    control = db.execute("SELECT * FROM investor_fx_controls WHERE id=? AND workspace_id=?", (row["control_id"], workspace)).fetchone()
    _control(db, authority, control, at)
    local = instant(row["created_at"]).astimezone(ZONE)
    expiry = min(instant(policy["valid_until"]), datetime.combine(local.date() + timedelta(days=1), time(), tzinfo=ZONE))
    _check(all(row[key] == doc[key] for key in ("workspace_id", "authority_id", "control_id", "feed_day", "created_at", "valid_until"))
        and row["created_at"] <= at and row["actor_id"] == authority["actor_id"] and control["enabled"] == 1
        and doc["authority_hash"] == authority["content_hash"] and doc["control_hash"] == control["content_hash"]
        and local.hour >= 1 and row["feed_day"] == local.date().isoformat() and row["valid_until"] == _clock(expiry)
        and instant(policy["valid_from"]) <= instant(row["created_at"]) < instant(row["valid_until"]))
    return row, doc, authority, policy


def _current_request(db, row, doc, at):
    authority, policy, control = _authority(db, row["workspace_id"], row["authority_id"], at)
    _check(_active(policy, control, at) and control["id"] == row["control_id"] and control["content_hash"] == doc["control_hash"]
        and at < row["valid_until"] and not _quarantined(db, authority["id"], at), "REQUEST_SUPERSEDED")
    _head_current(db, row["workspace_id"], authority["id"], at)
    return authority, policy, control


def _head_current(db, workspace, authority_id, at):
    head = db.execute("SELECT id FROM investor_fx_publications WHERE authority_id=? AND workspace_id=? AND status='published' ORDER BY sequence DESC LIMIT 1",
        (authority_id, workspace)).fetchone()
    if head: _resolved_publication(db, workspace, head["id"], at)


def discover_current_fx(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000); at = _clock(now); local = instant(at).astimezone(ZONE)
    if local.hour >= 1:
        rows = db.execute("""SELECT s.* FROM investor_fx_authorities s JOIN investor_fx_controls c ON c.authority_id=s.id
            WHERE c.enabled=1 AND c.version=(SELECT max(version) FROM investor_fx_controls WHERE authority_id=s.id)
              AND json_extract(s.document_json,'$.valid_from')<=? AND json_extract(s.document_json,'$.valid_until')>?
              AND NOT EXISTS(SELECT 1 FROM investor_fx_requests r WHERE r.workspace_id=s.workspace_id AND r.feed_day=?)
              AND NOT EXISTS(SELECT 1 FROM investor_fx_publications p WHERE p.authority_id=s.id AND p.status='blocked')
            ORDER BY s.created_at,s.id LIMIT ?""", (at, at, local.date().isoformat(), limit)).fetchall()
        for row in rows:
            if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            with transaction(db):
                try:
                    authority, policy, control = _authority(db, row["workspace_id"], row["id"], at)
                    if not _active(policy, control, at): continue
                    _head_current(db, row["workspace_id"], row["id"], at)
                except ValueError as error:
                    if str(error) in STOP: raise
                    enqueue_notification(db, "fx-head-gap:" + row["id"], "investor.fx_source_gap",
                        {"workspace_id": row["workspace_id"], "authority_id": row["id"], "code": "FX_SOURCE_HEAD_UNAVAILABLE"}, now=at)
                    continue
                if db.execute("SELECT 1 FROM investor_fx_requests WHERE workspace_id=? AND feed_day=?", (row["workspace_id"], local.date().isoformat())).fetchone(): continue
                identifier = new_id("fx-request")
                doc = {"schema_version": "investor-fx-request-v1", "workspace_id": row["workspace_id"], "authority_id": authority["id"],
                    "authority_hash": authority["content_hash"], "control_id": control["id"], "control_hash": control["content_hash"],
                    "feed_day": local.date().isoformat(), "created_at": at,
                    "valid_until": _clock(min(instant(policy["valid_until"]), datetime.combine(local.date() + timedelta(days=1), time(), tzinfo=ZONE)))}
                validate_contract(doc, SCHEMA, fragment="$defs/request"); digest = content_hash(doc)
                audit = _audit(db, row["actor_id"], "investor_schedule_fx_capture", "investor_fx_request", identifier, {"content_hash": digest}, at)
                db.execute("INSERT INTO investor_fx_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["workspace_id"], authority["id"], control["id"],
                    doc["feed_day"], canonical_json(doc), digest, row["actor_id"], at, doc["valid_until"], audit))
    rows = db.execute("""SELECT r.* FROM investor_fx_requests r WHERE NOT EXISTS(SELECT 1 FROM job_runs j
        WHERE j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash)
        ORDER BY r.created_at,r.id LIMIT ?""", (JOB_TYPE, limit)).fetchall()
    return [enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["content_hash"], max_attempts=1, now=at) for row in rows]


def _validate_result(value, policy, before, after):
    _check(type(value) is dict and set(value) == {"schema_version", "raw", "receipt", "draft"} and value["schema_version"] == receiver.VERSION)
    raw = value["raw"]; _check(type(raw) is bytes and 0 < len(raw) <= receiver.ecb.MAX_BYTES)
    encoded = canonical_json({**value["receipt"], "raw_base64": base64.b64encode(raw).decode()}).encode()
    checked_raw, receipt = receiver._receipt(encoded, before, stamp(instant(after) + timedelta(milliseconds=1)))
    _check(checked_raw == raw)
    draft = receiver.build_current_fx_draft(raw, retrieved_at=receipt["retrieved_at"], currencies=policy["currencies"])
    _check(draft == value["draft"])
    return raw, receipt, draft


def prepare_current_fx(db, job, lease, *, clock=None, stop_requested=None):
    clock = clock or (lambda: None); at = _clock(clock()); value = None; status = None
    row, request, authority, policy = _request(db, job["scope"], job["period"], at)
    _check(job["id"] == lease.job_id and job["job_type"] == JOB_TYPE and job["command_request_id"] is None
        and job["max_attempts"] == 1 and job["input_version"] == row["content_hash"])
    assert_lease(db, lease, now=at)
    assert_writable(db)
    if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
    try: _current_request(db, row, request, at)
    except WorkbenchError as error:
        if str(error) in STOP: raise
        status = "superseded"
    if status is None:
        try:
            _check(instant(at) + timedelta(seconds=31) < min(instant(request["valid_until"]), instant(lease.lease_until)))
            _check(not db.in_transaction, "IO_TRANSACTION_FORBIDDEN")
            assert_writable(db)
            if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            value = receiver.collect_current_fx_draft(currencies=policy["currencies"], timeout_seconds=30)
            value = _validate_result(value, policy, at, _clock(clock()))
        except Exception as error:
            if isinstance(error, WorkbenchError) and str(error) in STOP: raise
            status = "transport_failed"
    def effect(connection):
        checked = _clock(clock()); assert_lease(connection, lease, now=checked)
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        final = status
        try: _current_request(connection, row, request, checked)
        except WorkbenchError as error:
            if str(error) in STOP: raise
            final = "superseded"
        raw = transport = draft = None
        if final is None:
            raw, transport, draft = value; final = "captured"
        identifier = new_id("fx-capture")
        expiry = _clock(min(instant(policy["valid_until"]), instant(checked) + timedelta(days=policy["retention_days"]))) if raw else None
        doc = {"schema_version": "investor-fx-capture-v1", "capture_id": identifier, "workspace_id": row["workspace_id"],
            "request_id": row["id"], "request_hash": row["content_hash"], "job_id": job["id"], "fencing_token": lease.fencing_token,
            "qualification": QUALIFICATION, "status": final,
            "reason_code": {"captured": "FX_DRAFT_CAPTURED", "transport_failed": "FX_CAPTURE_FAILED", "superseded": "FX_REQUEST_SUPERSEDED"}[final],
            "raw_sha256": sha256(raw).hexdigest() if raw else None, "raw_bytes": len(raw) if raw else None,
            "draft_hash": content_hash(draft) if draft else None, "transport": transport,
            "not_before": draft["metadata"]["not_before"] if draft else None, "created_at": checked, "retain_until": expiry,
            "owner_reviewed": False, "production_admitted": False}
        validate_contract(doc, SCHEMA, fragment="$defs/capture"); digest = content_hash(doc)
        audit = _audit(connection, row["actor_id"], "investor_finish_fx_capture", "investor_fx_capture", identifier, {"content_hash": digest}, checked)
        connection.execute("INSERT INTO investor_fx_captures VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["workspace_id"], row["id"], job["id"], final,
            doc["raw_sha256"], doc["raw_bytes"], doc["not_before"], canonical_json(doc), digest, row["actor_id"], checked, expiry, audit))
        if raw is not None:
            old = connection.execute("SELECT payload,raw_bytes FROM investor_fx_payloads WHERE workspace_id=? AND raw_sha256=?", (row["workspace_id"], doc["raw_sha256"])).fetchone()
            if old: _check(bytes(old["payload"]) == raw and old["raw_bytes"] == len(raw))
            else: connection.execute("INSERT INTO investor_fx_payloads VALUES(?,?,?,?,?)", (row["workspace_id"], doc["raw_sha256"], len(raw), raw, checked))
        return JobCommit({"capture_id": identifier, "code": doc["reason_code"], "production_admitted": False},
            "succeeded" if final == "captured" else "failed" if final == "transport_failed" else "skipped")
    return {"effect": effect}


def resolve_capture(db, workspace, identifier, *, now=None):
    at = _clock(now)
    row = db.execute("SELECT * FROM investor_fx_captures WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    doc = _sealed(row, "capture")
    _owner(db, workspace, row["actor_id"]); _audit_binding(db, row, "investor_finish_fx_capture", "investor_fx_capture", identifier)
    request, requested, authority, policy = _request(db, workspace, row["request_id"], at)
    _check(all(doc[key] == row[key] for key in ("request_id", "job_id", "workspace_id", "status", "raw_sha256", "raw_bytes", "not_before", "created_at", "retain_until"))
        and doc["capture_id"] == identifier and doc["request_hash"] == request["content_hash"] and row["actor_id"] == request["actor_id"]
        and request["created_at"] <= row["created_at"] <= at and row["status"] == "captured" and at < row["retain_until"])
    _check(not db.execute("SELECT 1 FROM investor_fx_purges WHERE capture_id=?", (identifier,)).fetchone(), "PAYLOAD_PURGED")
    job = db.execute("SELECT * FROM job_runs WHERE id=?", (row["job_id"],)).fetchone()
    attempt = db.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1", (row["job_id"],)).fetchone()
    _check(job is not None and attempt is not None and job["status"] == "succeeded" and job["job_type"] == JOB_TYPE
        and job["scope"] == workspace and job["period"] == request["id"] and job["input_version"] == request["content_hash"]
        and job["max_attempts"] == job["attempt_count"] == 1 and attempt["fencing_token"] == doc["fencing_token"]
        and _object(job["result_json"]) == {"capture_id": identifier, "code": "FX_DRAFT_CAPTURED", "production_admitted": False})
    payload = db.execute("SELECT * FROM investor_fx_payloads WHERE workspace_id=? AND raw_sha256=?", (workspace, row["raw_sha256"])).fetchone()
    _check(payload is not None and payload["raw_bytes"] == row["raw_bytes"])
    raw = bytes(payload["payload"])
    encoded = canonical_json({**doc["transport"], "raw_base64": base64.b64encode(raw).decode()}).encode()
    checked_raw, _ = receiver._receipt(encoded, max(request["created_at"], attempt["started_at"]), stamp(instant(row["created_at"]) + timedelta(milliseconds=1)))
    _check(checked_raw == raw and sha256(raw).hexdigest() == row["raw_sha256"] and len(raw) == row["raw_bytes"])
    draft = receiver.build_current_fx_draft(raw, retrieved_at=doc["transport"]["retrieved_at"], currencies=policy["currencies"])
    _check(content_hash(draft) == doc["draft_hash"] and draft["metadata"]["not_before"] == row["not_before"]
        and row["retain_until"] == _clock(min(instant(policy["valid_until"]), instant(row["created_at"]) + timedelta(days=policy["retention_days"]))))
    return {"capture": dict(row), "receipt": doc, "request": dict(request), "authority": dict(authority), "policy": policy, "raw": raw, "draft": draft}


def _publication_header(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_fx_publications WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    doc = _sealed(row, "publication")
    _owner(db, workspace, row["actor_id"]); _audit_binding(db, row, "investor_publish_fx_source", "investor_fx_publication", identifier)
    _check(all(row[key] == doc[key] for key in ("workspace_id", "authority_id", "capture_id", "sequence", "previous_id", "status", "created_at"))
        and doc["publication_id"] == row["id"] and row["created_at"] <= at
        and row["usd_review_id"] == doc["refs"].get("USD", {}).get("review_id")
        and row["hkd_review_id"] == doc["refs"].get("HKD", {}).get("review_id"))
    previous = db.execute("SELECT * FROM investor_fx_publications WHERE id=? AND workspace_id=?", (row["previous_id"], workspace)).fetchone() if row["previous_id"] else None
    if previous:
        previous_doc = _sealed(previous, "publication")
        _audit_binding(db, previous, "investor_publish_fx_source", "investor_fx_publication", previous["id"])
        _check(previous["authority_id"] == row["authority_id"] and previous["status"] == previous_doc["status"] == "published"
            and previous["content_hash"] == doc["previous_hash"] and previous["sequence"] < row["sequence"] and previous["created_at"] <= row["created_at"])
    else: _check(doc["previous_hash"] is None)
    return row, doc


def _facts(draft, authority_id):
    return {currency: {**facts, "monitor_series": {"authority_id": authority_id, "revision_policy": "append_only_no_restatements"}}
        for currency, facts in draft["facts"].items()}


def _source_document(captured, authority, identifier, currency):
    return {"title": "Managed ECB reference FX under owner standing rule", "reference": receiver.ecb.URLS[receiver.FEED],
        "excerpt": canonical_json({"publication_id": identifier, "authority_id": authority["id"], "authority_hash": authority["content_hash"],
            "capture_id": captured["capture"]["id"], "capture_hash": captured["capture"]["content_hash"], "currency": currency,
            "draft_hash": captured["receipt"]["draft_hash"], "human_review_performed": False,
            "basis": "standing_owner_derivation_rule_not_provider_certified", "metadata": captured["draft"]["metadata"]})}


def _resolved_publication(db, workspace, identifier, at, *, current=True):
    row, doc = _publication_header(db, workspace, identifier, at)
    capture = resolve_capture(db, workspace, row["capture_id"], now=at)
    authority, policy, control = _authority(db, workspace, row["authority_id"], at)
    original = db.execute("SELECT * FROM investor_fx_controls WHERE id=?", (doc["control_id"],)).fetchone()
    _control(db, authority, original, at)
    _check(doc["authority_hash"] == authority["content_hash"] and doc["control_hash"] == original["content_hash"]
        and doc["capture_hash"] == capture["capture"]["content_hash"] and row["actor_id"] == authority["actor_id"]
        and capture["request"]["authority_id"] == row["authority_id"] and capture["request"]["control_id"] == original["id"]
        and capture["capture"]["not_before"] <= row["created_at"] and capture["capture"]["created_at"] <= row["created_at"])
    if current:
        _check(_active(policy, control, at) and control["id"] == original["id"], "AUTHORITY_INACTIVE")
        _check(not _quarantined(db, row["authority_id"], at), "SOURCE_QUARANTINED")
    facts = _facts(capture["draft"], authority["id"])
    if row["status"] == "published":
        _check(set(doc["refs"]) == set(policy["currencies"]))
        for currency, ref in doc["refs"].items():
            review = db.execute("SELECT * FROM investor_data_reviews WHERE id=? AND workspace_id=?", (ref["review_id"], workspace)).fetchone()
            source = db.execute("SELECT * FROM investor_data_sources WHERE id=? AND workspace_id=?", (ref["source_id"], workspace)).fetchone()
            _check(review is not None and source is not None)
            reviewed = _object(review["document_json"])
            _check(set(reviewed) == {"schema_version", "source_id", "source_hash", "kind", "version", "decision", "facts", "reason", "valid_until", "review_basis"}
                and reviewed["schema_version"] == "investor-data-review-v1" and reviewed["source_id"] == source["id"] and reviewed["source_hash"] == source["content_hash"]
                and reviewed["kind"] == "fx" and reviewed["version"] == review["version"] and reviewed["decision"] == review["decision"] == "approved"
                and reviewed["valid_until"] == review["valid_until"] and reviewed["review_basis"] == "owner_reviewed_not_provider_certified")
            _check(review["content_hash"] == ref["review_hash"] == content_hash(reviewed)
                and source["content_hash"] == ref["source_hash"] == content_hash(_object(source["document_json"]))
                and source["kind"] == "fx" and review["source_id"] == source["id"] and review["actor_id"] == source["actor_id"] == row["actor_id"]
                and review["created_at"] == source["created_at"] == row["created_at"] and review["valid_until"] == capture["capture"]["retain_until"]
                and reviewed["facts"] == facts[currency] and content_hash(facts[currency]) == ref["facts_hash"])
            _check(_object(source["document_json"]) == _source_document(capture, authority, row["id"], currency))
            validate_facts("fx", facts[currency])
            _audit_binding(db, source, "investor_store_data_source", "investor_data_source", source["id"])
            _audit_binding(db, review, "investor_review_data_source", "investor_data_review", review["id"])
            latest = db.execute("SELECT id FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1", (source["id"],)).fetchone()
            _check(review["decision"] == "approved" and latest[0] == review["id"], "REVIEW_WITHDRAWN")
    return row, doc, facts


def validate_managed_review(db, workspace, review, facts, at):
    """Extra binding for managed series; manual legacy reviews stay unchanged."""
    series = facts.get("monitor_series")
    if not series: return
    authority = db.execute("SELECT id FROM investor_fx_authorities WHERE id=? AND workspace_id=?", (series["authority_id"], workspace)).fetchone()
    if authority is None: return
    publication = db.execute("SELECT id FROM investor_fx_publications WHERE workspace_id=? AND authority_id=? AND (usd_review_id=? OR hkd_review_id=?)",
        (workspace, authority["id"], review["id"], review["id"])).fetchone()
    _check(publication is not None, "REVIEW_NOT_BOUND")
    _, doc, expected = _resolved_publication(db, workspace, publication["id"], at)
    _check(doc["refs"][facts["currency"]]["review_id"] == review["id"] and expected[facts["currency"]] == facts)


def managed_review_unavailable(db, workspace, review_id, at):
    """Cheap verified permission/retention gate; it never approves payload bytes."""
    publication = db.execute("SELECT id FROM investor_fx_publications WHERE workspace_id=? AND (usd_review_id=? OR hkd_review_id=?)",
        (workspace, review_id, review_id)).fetchone()
    if publication is None: return None
    row, doc = _publication_header(db, workspace, publication["id"], at)
    authority, policy, control = _authority(db, workspace, row["authority_id"], at)
    original = db.execute("SELECT * FROM investor_fx_controls WHERE id=?", (doc["control_id"],)).fetchone()
    _control(db, authority, original, at)
    capture = db.execute("SELECT * FROM investor_fx_captures WHERE id=? AND workspace_id=?", (row["capture_id"], workspace)).fetchone()
    captured = _sealed(capture, "capture")
    _audit_binding(db, capture, "investor_finish_fx_capture", "investor_fx_capture", capture["id"])
    _check(capture["status"] == captured["status"] == "captured" and captured["capture_id"] == capture["id"]
        and captured["retain_until"] == capture["retain_until"] and capture["created_at"] <= row["created_at"]
        and doc["capture_hash"] == capture["content_hash"] and doc["authority_hash"] == authority["content_hash"]
        and doc["control_hash"] == original["content_hash"])
    if at >= capture["retain_until"] or instant(at) >= instant(policy["valid_until"]): return "REFERENCE_SOURCE_EXPIRED"
    if not _active(policy, control, at) or control["id"] != original["id"] or _quarantined(db, authority["id"], at):
        return "REFERENCE_SOURCE_NO_LONGER_CURRENT"
    if db.execute("SELECT 1 FROM investor_fx_purges WHERE capture_id=?", (capture["id"],)).fetchone(): return "REFERENCE_SOURCE_PAYLOAD_PURGED"
    return None


def _publish_selected_fx(db, rows, at, stop_requested):
    completed = []
    for selected in rows:
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        with transaction(db):
            if db.execute("SELECT 1 FROM investor_fx_publications WHERE capture_id=?", (selected["id"],)).fetchone(): continue
            captured = resolve_capture(db, selected["workspace_id"], selected["id"], now=at)
            request, requested, authority, policy = _request(db, selected["workspace_id"], captured["request"]["id"], at)
            _, _, control = _authority(db, selected["workspace_id"], authority["id"], at)
            _check(_active(policy, control, at) and control["id"] == request["control_id"], "AUTHORITY_INACTIVE")
            previous = db.execute("SELECT id FROM investor_fx_publications WHERE authority_id=? AND status='published' ORDER BY sequence DESC LIMIT 1", (authority["id"],)).fetchone()
            head = previous_doc = None
            facts = _facts(captured["draft"], authority["id"]); status, code = "published", "FX_SOURCE_PUBLISHED"
            if previous:
                head, previous_doc, old = _resolved_publication(db, selected["workspace_id"], previous["id"], at)
                advances = False
                for currency in policy["currencies"]:
                    old_rows = {row["observed_at"]: row for row in old[currency]["rows"]}
                    new_rows = {row["observed_at"]: row for row in facts[currency]["rows"]}
                    overlap = set(old_rows) & set(new_rows)
                    if not overlap: status, code = "blocked", "FX_SOURCE_OVERLAP_MISSING"; break
                    if any(decimal(old_rows[key]["value"]) != decimal(new_rows[key]["value"])
                            or old_rows[key]["assumed_available_at"] != new_rows[key]["assumed_available_at"] for key in overlap):
                        status, code = "blocked", "FX_SOURCE_RESTATEMENT"; break
                    if max(new_rows) < max(old_rows): status, code = "blocked", "FX_SOURCE_TAIL_REGRESSION"; break
                    advances = advances or max(new_rows) > max(old_rows)
                if status == "published" and not advances: status, code = "unchanged", "FX_SOURCE_UNCHANGED"
            if _quarantined(db, authority["id"], at): status, code = "blocked", "FX_SOURCE_QUARANTINED"
            identifier = new_id("fx-publication"); refs = {}
            if status == "published":
                for currency in policy["currencies"]:
                    source = store_source(db, selected["workspace_id"], authority["actor_id"], "fx", _source_document(captured, authority, identifier, currency), now=at)
                    reviewed = review_source(db, selected["workspace_id"], authority["actor_id"], source["id"], "approved", facts[currency],
                        "Automatic derivation under the owner's reviewed standing FX rule; no per-publication human review, provider certification or trade permission.",
                        captured["capture"]["retain_until"], now=at)
                    refs[currency] = {"review_id": reviewed["id"], "review_hash": reviewed["content_hash"], "source_id": source["id"],
                        "source_hash": source["content_hash"], "facts_hash": content_hash(facts[currency])}
            sequence = db.execute("SELECT coalesce(max(sequence),0)+1 FROM investor_fx_publications WHERE authority_id=?", (authority["id"],)).fetchone()[0]
            doc = {"schema_version": "investor-fx-publication-v1", "publication_id": identifier, "workspace_id": selected["workspace_id"],
                "authority_id": authority["id"], "authority_hash": authority["content_hash"], "control_id": control["id"], "control_hash": control["content_hash"],
                "capture_id": captured["capture"]["id"], "capture_hash": captured["capture"]["content_hash"], "sequence": sequence,
                "previous_id": head["id"] if head else None, "previous_hash": head["content_hash"] if head else None,
                "status": status, "reason_code": code, "refs": refs, "created_at": at, "human_review_performed": False, "trading_permission": False}
            validate_contract(doc, SCHEMA, fragment="$defs/publication"); digest = content_hash(doc)
            audit = _audit(db, authority["actor_id"], "investor_publish_fx_source", "investor_fx_publication", identifier, {"content_hash": digest}, at)
            db.execute("INSERT INTO investor_fx_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, selected["workspace_id"], authority["id"], captured["capture"]["id"],
                sequence, doc["previous_id"], status, refs.get("USD", {}).get("review_id"), refs.get("HKD", {}).get("review_id"),
                canonical_json(doc), digest, authority["actor_id"], at, audit))
            if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            completed.append(identifier)
    return completed


def publish_current_fx(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000); at = _clock(now); completed = []
    rows = db.execute("""SELECT c.id,c.workspace_id FROM investor_fx_captures c JOIN investor_fx_requests r ON r.id=c.request_id AND r.workspace_id=c.workspace_id
        JOIN investor_fx_controls control ON control.id=r.control_id WHERE c.status='captured' AND c.not_before<=? AND c.retain_until>?
          AND control.enabled=1 AND control.version=(SELECT max(version) FROM investor_fx_controls WHERE authority_id=r.authority_id)
          AND NOT EXISTS(SELECT 1 FROM investor_fx_publications p WHERE p.capture_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM investor_fx_purges p WHERE p.capture_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM investor_fx_publications p WHERE p.authority_id=r.authority_id AND p.status='blocked')
          AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.dedup_key='fx-publication-gap:'||c.id AND o.topic='investor.fx_publication_gap'
            AND json_extract(o.payload_json,'$.code')='FX_PUBLICATION_EVIDENCE_INVALID'
            AND json_extract(o.payload_json,'$.capture_id')=c.id AND json_extract(o.payload_json,'$.workspace_id')=c.workspace_id)
        ORDER BY c.created_at,c.id LIMIT ?""", (at, at, limit)).fetchall()
    for row in rows:
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        try:
            completed.extend(_publish_selected_fx(db, [row], at, stop_requested))
        except ValueError as error:
            if str(error) in STOP: raise
            enqueue_notification(db, "fx-publication-gap:" + row["id"], "investor.fx_publication_gap",
                {"workspace_id": row["workspace_id"], "capture_id": row["id"], "code": "FX_PUBLICATION_EVIDENCE_INVALID"}, now=at)
    return completed


def purge_capture(db, workspace, actor, identifier, *, now=None):
    at = _clock(now)
    with transaction(db):
        _owner(db, workspace, actor)
        row = db.execute("SELECT * FROM investor_fx_captures WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
        doc = _sealed(row, "capture")
        _audit_binding(db, row, "investor_finish_fx_capture", "investor_fx_capture", identifier)
        _check(row["status"] == "captured" and row["created_at"] <= at and row["actor_id"] == actor
            and doc["capture_id"] == row["id"] and all(doc[key] == row[key] for key in
                ("workspace_id", "request_id", "job_id", "status", "raw_sha256", "raw_bytes", "not_before", "created_at", "retain_until")))
        old = db.execute("SELECT * FROM investor_fx_purges WHERE capture_id=?", (identifier,)).fetchone()
        if old: return dict(old)
        request, _, authority, policy = _request(db, workspace, row["request_id"], at)
        _, _, control = _authority(db, workspace, authority["id"], at)
        expired = row["retain_until"] <= at
        _check(expired or not _active(policy, control, at) or control["id"] != request["control_id"], "PURGE_NOT_DUE")
        reason = "retention_expired" if expired else "authority_no_longer_active"
        audit = _audit(db, actor, "investor_purge_fx_capture", "investor_fx_capture", identifier, {"reason": reason}, at)
        db.execute("INSERT INTO investor_fx_purges VALUES(?,?,?,?,?,?)", (identifier, workspace, reason, actor, at, audit))
        if not db.execute("SELECT 1 FROM investor_fx_captures c WHERE c.workspace_id=? AND c.raw_sha256=? AND NOT EXISTS(SELECT 1 FROM investor_fx_purges p WHERE p.capture_id=c.id)",
                (workspace, doc["raw_sha256"])).fetchone():
            db.execute("DELETE FROM investor_fx_payloads WHERE workspace_id=? AND raw_sha256=?", (workspace, doc["raw_sha256"]))
        return dict(db.execute("SELECT * FROM investor_fx_purges WHERE capture_id=?", (identifier,)).fetchone())


def inspect_request(db, workspace, actor, feed_day, *, now=None):
    _owner(db, workspace, actor); at = _clock(now)
    row = db.execute("SELECT id FROM investor_fx_requests WHERE workspace_id=? AND feed_day=?", (workspace, feed_day)).fetchone()
    _check(row is not None, "OUT_OF_SCOPE")
    request, _, _, _ = _request(db, workspace, row["id"], at)
    job = db.execute("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?",
        (JOB_TYPE, workspace, request["id"], request["content_hash"])).fetchone()
    capture = db.execute("SELECT * FROM investor_fx_captures WHERE request_id=?", (request["id"],)).fetchone()
    if capture is not None:
        doc = _sealed(capture, "capture")
        _audit_binding(db, capture, "investor_finish_fx_capture", "investor_fx_capture", capture["id"])
        _check(capture["workspace_id"] == workspace and doc["request_hash"] == request["content_hash"])
    return {"request_id": request["id"], "request_hash": request["content_hash"], "feed_day": request["feed_day"],
        "job_id": job["id"] if job else None, "capture_id": capture["id"] if capture else None,
        "status": capture["status"] if capture else "indeterminate" if job and job["attempt_count"] > 0 else "queued",
        "automatic_retry_permitted": False, "market_values_output": False}
