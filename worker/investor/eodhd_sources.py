"""Explicit private action-draft permissions and non-resettable daily slots."""

from datetime import datetime, time, timedelta
from hashlib import sha256
import os

from worker.market.contracts import validate_contract
from worker.market.providers import eodhd_capture as receiver
from worker.market.providers.eodhd_actions import KINDS, SYMBOLS, ZONE, MAX_BYTES, PARSER_VERSION, action_url, action_window, parse_eodhd_actions
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job, enqueue_notification
from .data_evidence import _audit, _audit_binding, _object, _owner
from .model_runtime import _clock
from .runtime import _milliseconds


SCHEMA = "investor-eodhd-source.schema.json"
JOB_TYPE = "investor_eodhd_capture"
CALL_SECONDS = 20
_STOP = {"WORKER_STOP_REQUESTED", "WORKBENCH_READ_ONLY", "RESTORE_PENDING_REVIEW"}
OFFICIAL = "isolated_fixed_eodhd_https"
SYNTHETIC = "injected_test_eodhd"
_FAILURES = {
    "EODHD_CAPTURE_CALL_TIMEOUT": "EODHD_CAPTURE_TIMEOUT", "EODHD_CAPTURE_DOWNLOAD_TIMEOUT": "EODHD_CAPTURE_TIMEOUT",
    "EODHD_CAPTURE_CONNECTION_TARGET_FORBIDDEN": "EODHD_CAPTURE_ROUTE_FORBIDDEN", "EODHD_CAPTURE_NONPUBLIC_ADDRESS_FORBIDDEN": "EODHD_CAPTURE_ROUTE_FORBIDDEN",
    "EODHD_CAPTURE_HTTP_UNAUTHORIZED": "EODHD_CAPTURE_AUTH_FAILED", "EODHD_CAPTURE_HTTP_FORBIDDEN": "EODHD_CAPTURE_AUTH_FAILED",
    "EODHD_CAPTURE_HTTP_RATE_LIMITED": "EODHD_CAPTURE_RATE_LIMITED", "EODHD_CAPTURE_HTTP_UNAVAILABLE": "EODHD_CAPTURE_UNAVAILABLE",
}


def _check(value, code="INVALID"):
    if not value:
        raise WorkbenchError("INVESTOR_EODHD_" + code)


def _sealed(row, fragment):
    _check(row is not None, "OUT_OF_SCOPE")
    value = _object(row["document_json"])
    validate_contract(value, SCHEMA, fragment="$defs/" + fragment)
    _check(canonical_json(value) == row["document_json"] and content_hash(value) == row["content_hash"])
    return value


def _control(db, authority, row, at):
    value = _sealed(row, "control")
    _owner(db, authority["workspace_id"], row["actor_id"])
    _audit_binding(db, row, "investor_control_eodhd_authority", "investor_eodhd_control", row["id"])
    _check(row["workspace_id"] == authority["workspace_id"] and row["authority_id"] == value["authority_id"] == authority["id"]
        and value["authority_hash"] == authority["content_hash"] and row["actor_id"] == authority["actor_id"]
        and row["version"] == value["version"] and row["enabled"] == int(value["enabled"])
        and authority["created_at"] <= row["created_at"] == value["created_at"] <= at)
    return value


def _grant(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_eodhd_authorities WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    value = _sealed(row, "policy")
    _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_register_eodhd_authority", "investor_eodhd_authority", identifier)
    _check(row["created_at"] <= at and value["valid_from"] < value["valid_until"]
        and all(_milliseconds(value[key]) == value[key] for key in ("valid_from", "valid_until")))
    controls = db.execute("SELECT * FROM investor_eodhd_controls WHERE authority_id=? ORDER BY version LIMIT 1001", (identifier,)).fetchall()
    _check(len(controls) <= 1000, "CONTROL_LIMIT")
    previous = row["created_at"]
    for version, control in enumerate(controls, 1):
        _control(db, row, control, at)
        _check(control["version"] == version and previous <= control["created_at"])
        _check(version != 1 or control["enabled"] == 0)
        previous = control["created_at"]
    return row, value, controls[-1] if controls else None


def _enabled_rules(db, workspace, at):
    rows = db.execute("""SELECT a.id FROM investor_eodhd_authorities a JOIN investor_eodhd_controls c ON c.authority_id=a.id
      WHERE a.workspace_id=? AND c.enabled=1 AND c.version=(SELECT max(version) FROM investor_eodhd_controls WHERE authority_id=a.id)
      ORDER BY a.id LIMIT 1001""", (workspace,)).fetchall()
    _check(len(rows) <= 1000, "AUTHORITY_LIMIT")
    return [_grant(db, workspace, row["id"], at) for row in rows]


def _active(value, at):
    _, policy, control = value
    return control is not None and control["enabled"] == 1 and policy["valid_from"] <= at < policy["valid_until"]


def register_authority(db, workspace, actor, policy, *, now=None):
    policy = _object(canonical_json(policy)); at = _milliseconds(now)
    validate_contract(policy, SCHEMA, fragment="$defs/policy")
    for key in ("valid_from", "valid_until"):
        policy[key] = _milliseconds(policy[key])
    _check(policy["valid_from"] < policy["valid_until"] and len(canonical_json(policy).encode()) <= 16384)
    with transaction(db):
        _owner(db, workspace, actor)
        digest = content_hash(policy)
        old = db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id=? AND content_hash=?", (workspace, digest)).fetchone()
        if old:
            return dict(_grant(db, workspace, old["id"], at)[0])
        identifier = new_id("eodhd-authority")
        audit = _audit(db, actor, "investor_register_eodhd_authority", "investor_eodhd_authority", identifier, {"content_hash": digest}, at)
        db.execute("INSERT INTO investor_eodhd_authorities VALUES(?,?,?,?,?,?,?)", (identifier, workspace, canonical_json(policy), digest, actor, at, audit))
        set_authority_enabled(db, workspace, actor, identifier, False, now=at)
        return dict(db.execute("SELECT * FROM investor_eodhd_authorities WHERE id=?", (identifier,)).fetchone())


def set_authority_enabled(db, workspace, actor, identifier, enabled, *, now=None):
    _check(type(enabled) is bool); at = _milliseconds(now)
    with transaction(db):
        _owner(db, workspace, actor)
        row, policy, old = _grant(db, workspace, identifier, at)
        _check(not enabled or at < policy["valid_until"], "AUTHORITY_EXPIRED")
        if enabled:
            for other, other_policy, _ in _enabled_rules(db, workspace, at):
                _check(other["id"] == identifier or not (policy["valid_from"] < other_policy["valid_until"]
                    and other_policy["valid_from"] < policy["valid_until"]), "AMBIGUOUS")
        if old is not None and old["enabled"] == int(enabled):
            return dict(old)
        version = old["version"] + 1 if old else 1
        _check(version <= 1000, "CONTROL_LIMIT")
        _check(old is not None or not enabled)
        identifier_value = new_id("eodhd-control")
        value = {"schema_version": "investor-eodhd-control-v1", "authority_id": identifier, "authority_hash": row["content_hash"],
            "version": version, "enabled": enabled, "created_at": at}
        validate_contract(value, SCHEMA, fragment="$defs/control"); digest = content_hash(value)
        audit = _audit(db, actor, "investor_control_eodhd_authority", "investor_eodhd_control", identifier_value, {"content_hash": digest}, at)
        db.execute("INSERT INTO investor_eodhd_controls VALUES(?,?,?,?,?,?,?,?,?,?)", (identifier_value, workspace, identifier, version,
            int(enabled), canonical_json(value), digest, actor, at, audit))
        return dict(db.execute("SELECT * FROM investor_eodhd_controls WHERE id=?", (identifier_value,)).fetchone())


def _deadline(at, policy):
    day = instant(at).astimezone(ZONE).date()
    return _milliseconds(min(instant(policy["valid_until"]), datetime.combine(day + timedelta(days=1), time(), tzinfo=ZONE)))


def _stopped(db, stop_requested):
    if stop_requested and stop_requested():
        raise WorkbenchError("WORKER_STOP_REQUESTED")
    assert_writable(db)


def discover_eodhd_requests(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000, "DISCOVERY_LIMIT")
    _stopped(db, stop_requested)
    flag = os.environ.get("WORKBENCH_EODHD_ENABLED", "0")
    _check(flag in ("0", "1"), "PROVIDER_FLAG_INVALID")
    if flag == "0":
        return []
    at = _clock(now); local = instant(at).astimezone(ZONE)
    if local.hour < 1:
        return []
    rows = db.execute("""SELECT a.id,a.workspace_id FROM investor_eodhd_authorities a JOIN investor_eodhd_controls c ON c.authority_id=a.id
      WHERE c.enabled=1 AND c.version=(SELECT max(version) FROM investor_eodhd_controls WHERE authority_id=a.id)
        AND json_extract(a.document_json,'$.valid_from')<=? AND json_extract(a.document_json,'$.valid_until')>?
        AND (SELECT count(*) FROM investor_eodhd_requests r WHERE r.source_day=?)<4
      ORDER BY a.created_at,a.id LIMIT ?""", (at, at, local.date().isoformat(), limit)).fetchall()
    jobs = []
    for header in rows:
        _stopped(db, stop_requested)
        prepared = []
        try:
            with transaction(db):
                value = _grant(db, header["workspace_id"], header["id"], at)
                row, policy, control = value
                if not _active(value, at):
                    continue
                _check([item[0]["id"] for item in _enabled_rules(db, row["workspace_id"], at) if _active(item, at)] == [row["id"]], "AMBIGUOUS")
                until = _deadline(at, policy)
                if instant(at) + timedelta(seconds=CALL_SECONDS + 1) >= instant(until):
                    continue
                start, end = action_window(at)
                for symbol in SYMBOLS:
                    for kind in KINDS:
                        _stopped(db, stop_requested)
                        old = db.execute("SELECT id FROM investor_eodhd_requests WHERE symbol=? AND kind=? AND source_day=?",
                            (symbol, kind, local.date().isoformat())).fetchone()
                        if old:
                            continue
                        identifier = new_id("eodhd-request")
                        request = {"schema_version": "investor-eodhd-request-v1", "authority_id": row["id"], "authority_hash": row["content_hash"],
                            "control_id": control["id"], "control_hash": control["content_hash"], "source_day": local.date().isoformat(),
                            "parameters": {"kind": kind, "symbol": symbol, "start_date": start, "end_date": end}, "created_at": at,
                            "valid_until": until, "collection_scope": "private_unapproved_action_drafts_only"}
                        validate_contract(request, SCHEMA, fragment="$defs/request"); digest = content_hash(request)
                        audit = _audit(db, row["actor_id"], "investor_schedule_eodhd_capture", "investor_eodhd_request", identifier, {"content_hash": digest}, at)
                        db.execute("INSERT INTO investor_eodhd_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["workspace_id"], row["id"],
                            control["id"], symbol, kind, local.date().isoformat(), canonical_json(request), digest, row["actor_id"], at, until, audit))
                        prepared.append(enqueue_job(db, JOB_TYPE, row["workspace_id"], identifier, digest, max_attempts=1, now=at))
            jobs.extend(prepared)
        except WorkbenchError as error:
            if str(error) in _STOP:
                raise
            enqueue_notification(db, "eodhd-source-gap:" + header["id"], "investor.eodhd_source_gap",
                {"workspace_id": header["workspace_id"], "authority_id": header["id"], "code": "EODHD_SOURCE_UNAVAILABLE"}, now=at)
    return jobs


def _request_header(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_eodhd_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    value = _sealed(row, "request"); _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_schedule_eodhd_capture", "investor_eodhd_request", identifier)
    authority, policy, _ = _grant(db, workspace, row["authority_id"], at)
    control = db.execute("SELECT * FROM investor_eodhd_controls WHERE id=?", (row["control_id"],)).fetchone()
    _control(db, authority, control, at)
    _check(all(row[key] == value[key] for key in ("authority_id", "control_id", "source_day", "created_at", "valid_until"))
        and row["symbol"] == value["parameters"]["symbol"] and row["kind"] == value["parameters"]["kind"]
        and value["authority_hash"] == authority["content_hash"] and value["control_hash"] == control["content_hash"]
        and row["actor_id"] == authority["actor_id"] == control["actor_id"] and authority["created_at"] <= control["created_at"] <= row["created_at"] <= at
        and control["enabled"] == 1 and policy["valid_from"] <= row["created_at"] < policy["valid_until"])
    local = instant(row["created_at"]).astimezone(ZONE)
    _check(row["source_day"] == local.date().isoformat() and local.hour >= 1 and row["valid_until"] == _deadline(row["created_at"], policy)
        and action_window(row["created_at"]) == (value["parameters"]["start_date"], value["parameters"]["end_date"]))
    return row, value, authority, policy


def _eligible(db, row, at):
    if os.environ.get("WORKBENCH_EODHD_ENABLED", "0") != "1" or at >= row["valid_until"]:
        return False
    value = _grant(db, row["workspace_id"], row["authority_id"], at)
    if not _active(value, at) or value[2]["id"] != row["control_id"]:
        return False
    local = instant(at).astimezone(ZONE)
    if row["source_day"] != local.date().isoformat() or local.hour < 1:
        return False
    active = [item[0]["id"] for item in _enabled_rules(db, row["workspace_id"], at) if _active(item, at)]
    if active != [row["authority_id"]]:
        return False
    failed = db.execute("""SELECT 1 FROM investor_eodhd_requests r JOIN job_runs j ON j.job_type='investor_eodhd_capture'
        AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      WHERE r.workspace_id=? AND r.source_day=? AND (EXISTS(SELECT 1 FROM investor_eodhd_captures c WHERE c.request_id=r.id AND c.status='transport_failed')
        OR (j.attempt_count>=1 AND j.status IN ('failed','cancelled') AND NOT EXISTS(SELECT 1 FROM investor_eodhd_captures c WHERE c.request_id=r.id))) LIMIT 1""",
        (row["workspace_id"], row["source_day"])).fetchone()
    return failed is None


def _retention_until(at):
    value = instant(at)
    try:
        future = value.replace(year=value.year + 10)
    except ValueError:
        future = value.replace(year=value.year + 10, day=28)
    return _milliseconds(future)


def _validated_result(value, requested, before, after):
    _check(type(value) is dict and set(value) == {"schema_version", "raw", "receipt", "draft"} and value["schema_version"] == receiver.VERSION)
    raw, receipt = value["raw"], value["receipt"]
    _check(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES)
    validate_contract(receipt, SCHEMA, fragment="$defs/transport")
    parameters = requested["parameters"]
    _check(receipt["request"] == parameters and receipt["url_without_credentials"] == action_url(**parameters)
        and type(receipt["http_status"]) is int and type(receipt["raw_bytes"]) is int and type(receipt["redirects_followed"]) is int
        and receipt["raw_bytes"] == len(raw) and receipt["raw_sha256"] == sha256(raw).hexdigest()
        and instant(before) <= instant(receipt["started_at"]) <= instant(receipt["completed_at"]) <= instant(after)
        and receipt["retrieved_at"] == receipt["completed_at"])
    draft = parse_eodhd_actions(raw, **parameters, retrieved_at=receipt["retrieved_at"])
    _check(draft == value["draft"])
    return raw, receipt, content_hash(draft)


def prepare_eodhd_capture(db, job, lease, *, clock=None, stop_requested=None, test_collector=None):
    _check(test_collector is None or callable(test_collector)); _check(not db.in_transaction, "IO_TRANSACTION_FORBIDDEN")
    clock = clock or (lambda: None)
    at = _clock(clock()); _stopped(db, stop_requested); assert_lease(db, lease, now=at)
    request, requested, _, _ = _request_header(db, job["scope"], job["period"], at)
    _check(job["id"] == lease.job_id and job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["input_version"] == request["content_hash"]
        and job["max_attempts"] == job["attempt_count"] == lease.attempt == 1)
    _check(db.execute("SELECT 1 FROM investor_eodhd_captures WHERE request_id=?", (request["id"],)).fetchone() is None, "ALREADY_FINISHED")

    def guard(connection):
        _stopped(connection, stop_requested); checked = _clock(clock())
        live = assert_lease(connection, lease, now=checked)
        _check(all(live[key] == job[key] for key in ("id", "job_type", "scope", "period", "input_version", "command_request_id", "max_attempts", "attempt_count")),
            "JOB_IDENTITY_CHANGED")
        return checked

    raw = transport = draft_hash = None
    status, code = "superseded", "EODHD_SLOT_NO_LONGER_CURRENT"
    eligible = _eligible(db, request, guard(db))
    before = guard(db)
    eligible = eligible and _eligible(db, request, before)
    ready = instant(before) + timedelta(seconds=CALL_SECONDS + 1) < min(instant(request["valid_until"]), instant(lease.lease_until))
    if eligible and ready:
        value = None
        try:
            collector = test_collector or receiver.collect_eodhd_action_draft
            value = collector(**requested["parameters"], credentials_file=os.environ.get("EODHD_CREDENTIALS_FILE", ""), timeout_seconds=CALL_SECONDS)
        except Exception as error:
            if isinstance(error, WorkbenchError) and str(error) in _STOP:
                raise
            status = "transport_failed"
            code = _FAILURES.get(str(error), "EODHD_CAPTURE_TRANSPORT_FAILED") if isinstance(error, WorkbenchError) else "EODHD_CAPTURE_TRANSPORT_FAILED"
        after = guard(db)
        if not _eligible(db, request, after):
            status, code = "superseded", "EODHD_SLOT_NO_LONGER_CURRENT"
        elif value is not None:
            try:
                raw, transport, draft_hash = _validated_result(value, requested, before, after)
                status, code = "captured", "EODHD_ACTION_DRAFT_CAPTURED"
            except Exception:
                raw = transport = draft_hash = None
                status, code = "transport_failed", "EODHD_CAPTURE_RESPONSE_INVALID"
        elif status != "transport_failed":
            status, code = "transport_failed", "EODHD_CAPTURE_RESPONSE_INVALID"

    def effect(connection):
        created = guard(connection)
        current, _, _, _ = _request_header(connection, request["workspace_id"], request["id"], created)
        _check(current["content_hash"] == request["content_hash"])
        data, headers, draft, final, reason = raw, transport, draft_hash, status, code
        if not _eligible(connection, current, created):
            data = headers = draft = None
            final, reason = "superseded", "EODHD_SLOT_NO_LONGER_CURRENT"
        identifier = new_id("eodhd-capture")
        expiry = _retention_until(created) if final == "captured" else None
        value = {"schema_version": "investor-eodhd-capture-v1", "capture_id": identifier, "workspace_id": request["workspace_id"],
            "request_id": request["id"], "request_hash": request["content_hash"], "job_id": job["id"], "fencing_token": lease.fencing_token,
            "qualification": OFFICIAL if test_collector is None else SYNTHETIC, "status": final, "reason_code": reason,
            "raw_sha256": sha256(data).hexdigest() if data is not None else None, "raw_bytes": len(data) if data is not None else None,
            "draft_hash": draft, "parser_version": PARSER_VERSION if data is not None else None, "transport": headers, "created_at": created,
            "retain_until": expiry, "owner_reviewed": False, "research_admitted": False, "corporate_actions_complete": False, "live_advice_eligible": False}
        validate_contract(value, SCHEMA, fragment="$defs/capture"); digest = content_hash(value)
        audit = _audit(connection, request["actor_id"], "investor_finish_eodhd_capture", "investor_eodhd_capture", identifier, {"content_hash": digest}, created)
        connection.execute("INSERT INTO investor_eodhd_captures VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, request["workspace_id"], request["id"], job["id"],
            lease.fencing_token, value["qualification"], final, value["raw_sha256"], value["raw_bytes"], canonical_json(value), digest,
            request["actor_id"], created, expiry, audit))
        if data is not None:
            old = connection.execute("SELECT payload FROM investor_eodhd_payloads WHERE workspace_id=? AND raw_sha256=?", (request["workspace_id"], value["raw_sha256"])).fetchone()
            if old is None:
                connection.execute("INSERT INTO investor_eodhd_payloads VALUES(?,?,?,?,?)", (request["workspace_id"], value["raw_sha256"], len(data), data, created))
            else:
                _check(bytes(old[0]) == data, "PAYLOAD_CONFLICT")
        guard(connection)
        return JobCommit({"capture_id": identifier, "code": reason, "research_admitted": False},
            "succeeded" if final == "captured" else "failed" if final == "transport_failed" else "skipped")
    return {"effect": effect}


def _capture_header(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_eodhd_captures WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    value = _sealed(row, "capture"); _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_finish_eodhd_capture", "investor_eodhd_capture", identifier)
    request, requested, _, _ = _request_header(db, workspace, row["request_id"], at)
    _check(all(row[column] == value[field] for column, field in (("id", "capture_id"), ("workspace_id", "workspace_id"),
        ("request_id", "request_id"), ("job_id", "job_id"), ("fencing_token", "fencing_token"), ("qualification", "qualification"),
        ("status", "status"), ("raw_sha256", "raw_sha256"), ("raw_bytes", "raw_bytes"), ("created_at", "created_at"), ("retain_until", "retain_until")))
        and value["request_hash"] == request["content_hash"] and row["actor_id"] == request["actor_id"]
        and request["created_at"] <= row["created_at"] <= at)
    job = db.execute("SELECT * FROM job_runs WHERE id=?", (row["job_id"],)).fetchone()
    attempt = db.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1", (row["job_id"],)).fetchone()
    expected = {"captured": "succeeded", "transport_failed": "failed", "superseded": "skipped"}[row["status"]]
    _check(job is not None and attempt is not None and job["job_type"] == JOB_TYPE and job["scope"] == workspace
        and job["period"] == request["id"] and job["input_version"] == request["content_hash"] and job["command_request_id"] is None
        and job["attempt_count"] == job["max_attempts"] == attempt["attempt"] == 1 and job["status"] == attempt["status"] == expected
        and job["fencing_token"] == attempt["fencing_token"] == row["fencing_token"]
        and type(attempt["started_at"]) is str and type(attempt["finished_at"]) is str)
    # Job and capture wall clocks use different publication precision, not different source times.
    _check(_clock(instant(attempt["started_at"])) <= row["created_at"] <= _clock(instant(attempt["finished_at"])) <= at)
    result = _object(job["result_json"])
    _check(result == {"capture_id": row["id"], "code": value["reason_code"], "research_admitted": False})
    if row["status"] == "captured":
        _check(row["retain_until"] == _retention_until(row["created_at"]) and value["parser_version"] == PARSER_VERSION)
    return row, value, request, requested, attempt


def _purge_header(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_eodhd_purges WHERE capture_id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    if row is None:
        return None
    _owner(db, workspace, row["actor_id"])
    _check(row["created_at"] <= at and row["reason"] == "retention_expired")
    audit = db.execute("SELECT * FROM audit_events WHERE id=?", (row["audit_id"],)).fetchone()
    _check(audit is not None and audit["actor_id"] == row["actor_id"] and audit["action"] == "investor_purge_eodhd_capture"
        and audit["object_type"] == "investor_eodhd_capture" and audit["object_id"] == identifier and audit["created_at"] == row["created_at"]
        and _object(audit["payload_json"]) == {"reason": row["reason"]})
    return row


def resolve_eodhd_capture(db, workspace, actor, identifier, *, now=None, allow_synthetic=False):
    _check(type(allow_synthetic) is bool); _owner(db, workspace, actor); at = _clock(now)
    row, document, _, requested, attempt = _capture_header(db, workspace, identifier, at)
    _check(row["status"] == "captured", "CAPTURE_NOT_COMPLETE")
    _check(allow_synthetic or row["qualification"] == OFFICIAL, "SYNTHETIC_CAPTURE_FORBIDDEN")
    _check(_purge_header(db, workspace, identifier, at) is None, "PAYLOAD_PURGED")
    _check(at < row["retain_until"], "RETENTION_EXPIRED")
    payload = db.execute("SELECT payload FROM investor_eodhd_payloads WHERE workspace_id=? AND raw_sha256=?", (workspace, row["raw_sha256"])).fetchone()
    _check(payload is not None, "PAYLOAD_UNAVAILABLE"); raw = bytes(payload[0])
    value = {"schema_version": receiver.VERSION, "raw": raw, "receipt": document["transport"],
        "draft": parse_eodhd_actions(raw, **requested["parameters"], retrieved_at=document["transport"]["retrieved_at"])}
    _, _, digest = _validated_result(value, requested, attempt["started_at"], _milliseconds(instant(row["created_at"]) + timedelta(milliseconds=1)))
    _check(digest == document["draft_hash"] and sha256(raw).hexdigest() == row["raw_sha256"] and len(raw) == row["raw_bytes"])
    return {"capture": dict(row), "receipt": document, "raw": raw, "draft": value["draft"]}


def inspect_request(db, workspace, actor, identifier, *, now=None):
    _owner(db, workspace, actor); at = _clock(now)
    request = _request_header(db, workspace, identifier, at)[0]
    job = db.execute("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?",
        (JOB_TYPE, workspace, identifier, request["content_hash"])).fetchone()
    row = db.execute("SELECT id FROM investor_eodhd_captures WHERE request_id=?", (identifier,)).fetchone()
    capture = _capture_header(db, workspace, row["id"], at)[0] if row else None
    if job:
        _check(job["max_attempts"] == 1 and job["command_request_id"] is None and job["created_at"] <= at)
    status = (capture["status"] if capture else "indeterminate_no_retry" if job and job["attempt_count"]
        else "closed_without_capture" if job and job["status"] == "cancelled" else "queued" if job else "job_missing_no_retry")
    return {"request_id": identifier, "source_day": request["source_day"], "status": status,
        "job_id": job["id"] if job else None, "job_status": job["status"] if job else None,
        "capture_id": capture["id"] if capture else None, "automatic_retry_permitted": False, "research_admitted": False}


def purge_eodhd_capture(db, workspace, actor, identifier, *, now=None):
    at = _clock(now)
    with transaction(db):
        _owner(db, workspace, actor)
        row = _capture_header(db, workspace, identifier, at)[0]
        _check(row["status"] == "captured", "CAPTURE_NOT_COMPLETE")
        old = _purge_header(db, workspace, identifier, at)
        if old:
            return dict(old)
        _check(row["retain_until"] <= at, "PURGE_NOT_DUE")
        audit = _audit(db, actor, "investor_purge_eodhd_capture", "investor_eodhd_capture", identifier, {"reason": "retention_expired"}, at)
        db.execute("INSERT INTO investor_eodhd_purges VALUES(?,?,?,?,?,?)", (identifier, workspace, "retention_expired", actor, at, audit))
        remaining = db.execute("SELECT 1 FROM investor_eodhd_captures c WHERE c.workspace_id=? AND c.raw_sha256=? AND NOT EXISTS(SELECT 1 FROM investor_eodhd_purges p WHERE p.capture_id=c.id) LIMIT 1",
            (workspace, row["raw_sha256"])).fetchone()
        if not remaining:
            db.execute("DELETE FROM investor_eodhd_payloads WHERE workspace_id=? AND raw_sha256=?", (workspace, row["raw_sha256"]))
        return dict(db.execute("SELECT * FROM investor_eodhd_purges WHERE capture_id=?", (identifier,)).fetchone())
