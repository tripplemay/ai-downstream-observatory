"""Audited no-new-action maintenance; no provider I/O, tax changes or orders."""

from copy import deepcopy
from datetime import datetime, time, timedelta
from hashlib import sha256
import sqlite3
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, transaction
from . import action_reconciliation, eodhd_sources, issuer_sources
from .data_evidence import _audit, _audit_binding, _fact_validation_scope, _object, _owner, resolve_review, review_header, store_source, validate_facts
from .model_runtime import _clock
from .no_new_actions import check_no_new_action_extension


SCHEMA = "investor-action-maintenance.schema.json"
PREFIX = "managed-actions-review:"
ZONE = ZoneInfo("America/New_York")
BASIS = "selected_two_source_reports_not_objective_absence"
REASON = "Derived under an owner-authorized no-new-action rule; not individually human-reviewed today."
STOP = {"WORKER_STOP_REQUESTED", "WORKBENCH_READ_ONLY", "RESTORE_PENDING_REVIEW", "STALE_OR_EXPIRED_LEASE"}


def _check(value, code="INVALID"):
    if not value:
        raise WorkbenchError("INVESTOR_DATA_ACTION_MAINTENANCE_" + code)


def _sealed(row, fragment):
    _check(row is not None, "OUT_OF_SCOPE")
    value = _object(row["document_json"])
    validate_contract(value, SCHEMA, fragment="$defs/" + fragment)
    _check(canonical_json(value) == row["document_json"] and content_hash(value) == row["content_hash"])
    return value


def _control(db, authority, row, at):
    doc = _sealed(row, "control")
    _audit_binding(db, row, "investor_control_action_maintenance", "investor_action_control", row["id"])
    _check(row["workspace_id"] == authority["workspace_id"] and row["actor_id"] == authority["actor_id"]
        and row["authority_id"] == doc["authority_id"] == authority["id"] and doc["authority_hash"] == authority["content_hash"]
        and row["version"] == doc["version"] and row["enabled"] == int(doc["enabled"])
        and authority["created_at"] <= row["created_at"] == doc["created_at"] <= at)


def _authority(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_action_authorities WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    doc = _sealed(row, "authority"); _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_register_action_maintenance", "investor_action_authority", identifier)
    _check(row["created_at"] <= at and all(row[key] == doc[key] for key in ("listing_id", "base_review_id", "listing_review_id"))
        and _clock(doc["valid_from"]) == doc["valid_from"] < doc["valid_until"] == _clock(doc["valid_until"]))
    controls = db.execute("SELECT * FROM investor_action_controls WHERE authority_id=? ORDER BY version LIMIT 1001", (identifier,)).fetchall()
    _check(1 <= len(controls) <= 1000)
    previous = row["created_at"]
    for version, control in enumerate(controls, 1):
        _control(db, row, control, at)
        _check(control["version"] == version and previous <= control["created_at"] and (version != 1 or control["enabled"] == 0))
        previous = control["created_at"]
    return row, doc, controls[-1]


def _active(value, at):
    row, policy, control = value
    return row["created_at"] <= at and control["enabled"] == 1 and policy["valid_from"] <= at < policy["valid_until"]


def _refs(values):
    return {key: {"capture_id": value["capture"]["id"], "capture_hash": value["capture"]["content_hash"]} for key, value in values.items()}


def _captures(db, workspace, actor, listing_review_id, refs, at):
    validate_contract(refs, SCHEMA, fragment="$defs/capture_refs")
    report = action_reconciliation.check_action_crosscheck(db, workspace, actor, listing_review_id,
        refs["issuer"]["capture_id"], refs["dividends"]["capture_id"], refs["splits"]["capture_id"], now=at)
    values = {"issuer": issuer_sources.resolve_issuer_capture(db, workspace, actor, refs["issuer"]["capture_id"], now=at)}
    for key in ("dividends", "splits"):
        values[key] = eodhd_sources.resolve_eodhd_capture(db, workspace, actor, refs[key]["capture_id"], now=at)
    _check(_refs(values) == refs, "CAPTURE_BINDING_DIFFERS")
    limits = [instant(binding["retain_until"]) for binding in report["bindings"].values()]
    for key, binding in report["bindings"].items():
        if key == "issuer":
            _, policy, _ = issuer_sources._grant(db, workspace, binding["authority_id"], at)
        else:
            _, policy, _ = eodhd_sources._grant(db, workspace, binding["authority_id"], at)
        limits.append(instant(policy["valid_until"]))
    return values, report, limits


def _review_pin(value):
    return {"id": value["review"]["id"], "hash": value["review"]["content_hash"],
        "json_sha256": sha256(value["review"]["document_json"].encode()).hexdigest(),
        "source_id": value["source"]["id"], "source_hash": value["source"]["content_hash"],
        "source_json_sha256": sha256(value["source"]["document_json"].encode()).hexdigest()}


def _anchor(db, workspace, actor, base_review_id, listing_review_id, refs, at):
    _check(not base_review_id.startswith(PREFIX), "MANUAL_BASE_REQUIRED")
    base = resolve_review(db, workspace, base_review_id, "actions", now=at)
    listing = resolve_review(db, workspace, listing_review_id, "listing", now=at)
    asset = listing["facts"]; symbol = asset["provider_symbol"]
    _check(asset["listing_id"] == base["facts"]["listing_id"] and symbol in action_reconciliation.TARGETS
        and instant(asset["tradable_from"]) <= instant(at)
        and (asset["tradable_until"] is None or instant(at) < instant(asset["tradable_until"])), "IDENTITY_DIFFERS")
    values, report, limits = _captures(db, workspace, actor, listing_review_id, refs, at)
    snapshots = {key: value["draft"] for key, value in values.items()}
    candidate = check_no_new_action_extension(base["facts"], snapshots, snapshots, symbol=symbol, listing_id=asset["listing_id"])
    binding = content_hash({"base_review_hash": base["review"]["content_hash"], "listing_review_hash": listing["review"]["content_hash"],
        "bindings": report["bindings"]})
    limits += [instant(base["review"]["valid_until"]), instant(listing["review"]["valid_until"])]
    if asset["tradable_until"] is not None: limits.append(instant(asset["tradable_until"]))
    return {"base": base, "listing": listing, "values": values, "report": report, "binding_hash": binding,
        "snapshots": snapshots, "candidate": candidate, "limits": limits, "pins": [_review_pin(base), _review_pin(listing)]}


def preview_authority(db, workspace, actor, base_review_id, listing_review_id, refs, *, now=None):
    at = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor)
        value = _anchor(db, workspace, actor, base_review_id, listing_review_id, refs, at)
        return {"base_review_id": base_review_id, "base_review_hash": value["base"]["review"]["content_hash"],
            "listing_id": value["listing"]["facts"]["listing_id"], "provider_symbol": value["listing"]["facts"]["provider_symbol"],
            "listing_review_id": listing_review_id, "listing_review_hash": value["listing"]["review"]["content_hash"],
            "anchor_captures": refs, "anchor_binding_hash": value["binding_hash"], "maximum_valid_until": _clock(min(value["limits"])),
            "registered_nominal_difference_count": value["candidate"]["registered_nominal_difference_count"],
            "production_control_enabled": False, "market_values_output": False, "trading_permission": False}


def _check_review_pins(db, workspace, pins, at):
    for pin in pins:
        row = db.execute("SELECT * FROM investor_data_reviews WHERE id=? AND workspace_id=?", (pin["id"], workspace)).fetchone()
        source = db.execute("SELECT * FROM investor_data_sources WHERE id=? AND workspace_id=?", (pin["source_id"], workspace)).fetchone()
        _check(row is not None and source is not None and row["content_hash"] == pin["hash"] and row["decision"] == "approved"
            and row["created_at"] <= at < row["valid_until"] and source["content_hash"] == pin["source_hash"]
            and sha256(row["document_json"].encode()).hexdigest() == pin["json_sha256"]
            and sha256(source["document_json"].encode()).hexdigest() == pin["source_json_sha256"], "AUTHORITY_INPUTS_CHANGED")
        latest = db.execute("SELECT id FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1", (source["id"],)).fetchone()
        _check(latest and latest[0] == row["id"], "AUTHORITY_INPUTS_CHANGED")
        _audit_binding(db, row, "investor_review_data_source", "investor_data_review", row["id"])
        _audit_binding(db, source, "investor_store_data_source", "investor_data_source", source["id"])


def _check_capture_headers(db, workspace, reports, at):
    for report in reports:
        for key, binding in report["bindings"].items():
            prefix = "investor_issuer" if key == "issuer" else "investor_eodhd"
            row = (issuer_sources if key == "issuer" else eodhd_sources)._capture_header(db, workspace, binding["capture_id"], at)[0]
            _check(row is not None and row["status"] == "captured" and row["content_hash"] == binding["capture_hash"]
                and row["qualification"] == binding["qualification"] and row["raw_sha256"] == binding["raw_sha256"]
                and row["raw_bytes"] == binding["raw_bytes"] and row["retain_until"] == binding["retain_until"]
                and row["created_at"] <= at < row["retain_until"], "AUTHORITY_INPUTS_CHANGED")
            _check(not db.execute("SELECT 1 FROM " + prefix + "_purges WHERE capture_id=? AND workspace_id=?", (row["id"], workspace)).fetchone(), "AUTHORITY_INPUTS_CHANGED")
            payload = db.execute("SELECT payload FROM " + prefix + "_payloads WHERE workspace_id=? AND raw_sha256=?", (workspace, binding["raw_sha256"])).fetchone()
            _check(payload is not None and len(payload[0]) == binding["raw_bytes"]
                and sha256(payload[0]).hexdigest() == binding["raw_sha256"], "AUTHORITY_INPUTS_CHANGED")
            if key == "issuer":
                _, policy, control = issuer_sources._grant(db, workspace, binding["authority_id"], at)
                active = issuer_sources._active(policy, control, at)
            else:
                grant = eodhd_sources._grant(db, workspace, binding["authority_id"], at)
                _, _, control = grant; active = eodhd_sources._active(grant, at)
            _check(active and control["id"] == binding["control_id"] and control["content_hash"] == binding["control_hash"], "AUTHORITY_INPUTS_CHANGED")


def register_authority(db, workspace, actor, policy, *, now=None):
    policy = _object(canonical_json(policy)); validate_contract(policy, SCHEMA, fragment="$defs/authority")
    at = _clock(now)
    for field in ("valid_from", "valid_until"): policy[field] = _clock(policy[field])
    _check(policy["valid_from"] < policy["valid_until"] and at < policy["valid_until"])
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor)
        value = _anchor(db, workspace, actor, policy["base_review_id"], policy["listing_review_id"], policy["anchor_captures"], at)
        _check(policy["base_review_hash"] == value["base"]["review"]["content_hash"]
            and policy["listing_review_hash"] == value["listing"]["review"]["content_hash"]
            and policy["listing_id"] == value["listing"]["facts"]["listing_id"]
            and policy["provider_symbol"] == value["listing"]["facts"]["provider_symbol"]
            and policy["anchor_binding_hash"] == value["binding_hash"]
            and instant(policy["valid_until"]) <= min(value["limits"]), "AUTHORITY_INPUTS_CHANGED")
    digest = content_hash(policy)
    with transaction(db):
        _owner(db, workspace, actor)
        old = db.execute("SELECT id FROM investor_action_authorities WHERE workspace_id=? AND content_hash=?", (workspace, digest)).fetchone()
        if old: return dict(_authority(db, workspace, old[0], at)[0])
        _check_review_pins(db, workspace, value["pins"], at)
        _check_capture_headers(db, workspace, [value["report"]], at)
        identifier = new_id("actions-authority")
        audit = _audit(db, actor, "investor_register_action_maintenance", "investor_action_authority", identifier, {"content_hash": digest}, at)
        db.execute("INSERT INTO investor_action_authorities VALUES(?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, policy["listing_id"],
            policy["base_review_id"], policy["listing_review_id"], canonical_json(policy), digest, actor, at, audit))
        _insert_control(db, workspace, actor, dict(db.execute("SELECT * FROM investor_action_authorities WHERE id=?", (identifier,)).fetchone()), None, False, at)
        return dict(_authority(db, workspace, identifier, at)[0])


def _insert_control(db, workspace, actor, authority, previous, enabled, at):
    doc = {"schema_version": "investor-action-maintenance-control-v1", "authority_id": authority["id"], "authority_hash": authority["content_hash"],
        "version": previous["version"] + 1 if previous else 1, "enabled": enabled, "created_at": at}
    validate_contract(doc, SCHEMA, fragment="$defs/control")
    identifier = new_id("actions-control"); digest = content_hash(doc)
    audit = _audit(db, actor, "investor_control_action_maintenance", "investor_action_control", identifier, {"content_hash": digest}, at)
    db.execute("INSERT INTO investor_action_controls VALUES(?,?,?,?,?,?,?,?,?,?)", (identifier, workspace, authority["id"], doc["version"], int(enabled),
        canonical_json(doc), digest, actor, at, audit))
    return dict(db.execute("SELECT * FROM investor_action_controls WHERE id=?", (identifier,)).fetchone())


def _quarantined(db, workspace, authority_id, at):
    row = db.execute("SELECT id FROM investor_action_publications WHERE authority_id=? AND workspace_id=? AND status='blocked' ORDER BY sequence DESC LIMIT 1",
        (authority_id, workspace)).fetchone()
    if not row: return False
    _check(_publication_header(db, workspace, row[0], at)[0]["status"] == "blocked")
    return True


def set_authority_enabled(db, workspace, actor, identifier, enabled, *, now=None):
    _check(type(enabled) is bool); at = _clock(now)
    with transaction(db):
        _owner(db, workspace, actor)
        authority, policy, old = _authority(db, workspace, identifier, at)
        if enabled:
            _check(not db.execute("SELECT 1 FROM investor_action_review_confirmations WHERE workspace_id=? AND previous_authority_id=?", (workspace, identifier)).fetchone(), "AUTHORITY_RETIRED")
            _check(policy["valid_from"] <= at < policy["valid_until"], "AUTHORITY_EXPIRED")
            _check(not _quarantined(db, workspace, identifier, at), "SOURCE_QUARANTINED")
        if old["enabled"] == int(enabled): return dict(old)
        return _insert_control(db, workspace, actor, authority, old, enabled, at)


def _deadline(at, policy):
    day = instant(at).astimezone(ZONE).date()
    return _clock(min(instant(policy["valid_until"]), datetime.combine(day + timedelta(days=1), time(), tzinfo=ZONE)))


def _request(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_action_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    doc = _sealed(row, "request"); authority, policy, _ = _authority(db, workspace, row["authority_id"], at)
    _audit_binding(db, row, "investor_request_action_maintenance", "investor_action_request", identifier)
    control = db.execute("SELECT * FROM investor_action_controls WHERE id=? AND workspace_id=?", (row["control_id"], workspace)).fetchone()
    _control(db, authority, control, at)
    local = instant(row["created_at"]).astimezone(ZONE)
    _check(all(doc[key] == row[key] for key in ("workspace_id", "authority_id", "control_id", "source_day", "created_at", "valid_until"))
        and row["actor_id"] == authority["actor_id"] and doc["authority_hash"] == authority["content_hash"] and doc["control_hash"] == control["content_hash"]
        and control["enabled"] == 1 and policy["valid_from"] <= row["created_at"] < policy["valid_until"]
        and row["created_at"] <= at and local.hour >= 1 and row["source_day"] == local.date().isoformat()
        and row["valid_until"] == _deadline(row["created_at"], policy))
    return row, doc, authority, policy, control


def discover_requests(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000); at = _clock(now)
    if instant(at).astimezone(ZONE).hour < 1: return []
    day = instant(at).astimezone(ZONE).date().isoformat()
    rows = db.execute("""SELECT a.id,a.workspace_id FROM investor_action_authorities a JOIN investor_action_controls c ON c.authority_id=a.id
      WHERE c.enabled=1 AND c.version=(SELECT max(version) FROM investor_action_controls WHERE authority_id=a.id)
      AND json_extract(a.document_json,'$.valid_from')<=? AND json_extract(a.document_json,'$.valid_until')>?
      AND NOT EXISTS(SELECT 1 FROM investor_action_requests r WHERE r.authority_id=a.id AND r.source_day=?)
      ORDER BY a.created_at,a.id LIMIT ?""", (at, at, day, limit)).fetchall()
    results = []
    for selected in rows:
        _stopped(db, stop_requested)
        with transaction(db):
            value = _authority(db, selected["workspace_id"], selected["id"], at)
            authority, policy, control = value
            if not _active(value, at) or _quarantined(db, authority["workspace_id"], authority["id"], at): continue
            if db.execute("SELECT 1 FROM investor_action_requests WHERE authority_id=? AND source_day=?", (authority["id"], day)).fetchone(): continue
            until = _deadline(at, policy)
            if instant(until) - instant(at) < timedelta(seconds=1): continue
            doc = {"schema_version": "investor-action-maintenance-request-v1", "workspace_id": authority["workspace_id"],
                "authority_id": authority["id"], "authority_hash": authority["content_hash"], "control_id": control["id"],
                "control_hash": control["content_hash"], "source_day": day, "created_at": at, "valid_until": until}
            validate_contract(doc, SCHEMA, fragment="$defs/request")
            identifier = new_id("actions-request"); digest = content_hash(doc)
            audit = _audit(db, authority["actor_id"], "investor_request_action_maintenance", "investor_action_request", identifier, {"content_hash": digest}, at)
            db.execute("INSERT INTO investor_action_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)", (identifier, authority["workspace_id"], authority["id"], control["id"],
                day, canonical_json(doc), digest, authority["actor_id"], at, until, audit))
            results.append(identifier)
    return results


def _stopped(db, stop_requested):
    if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
    assert_writable(db)


def _current_refs(db, workspace, policy, day, at):
    """A missing/queued normal batch waits; failed terminal slots never retry."""
    symbol = policy["provider_symbol"]; refs = {}
    issuer = db.execute("SELECT * FROM investor_issuer_requests WHERE workspace_id=? AND issuer_day=? AND fund_id=?",
        (workspace, day, action_reconciliation.TARGETS[symbol])).fetchall()
    _check(len(issuer) <= 1)
    pending = not issuer
    requests = [("issuer", issuer[0])] if issuer else []
    for key, kind in (("dividends", "div"), ("splits", "splits")):
        row = db.execute("SELECT * FROM investor_eodhd_requests WHERE workspace_id=? AND source_day=? AND symbol=? AND kind=?", (workspace, day, symbol, kind)).fetchone()
        if row is None: pending = True
        else: requests.append((key, row))
    for key, request in requests:
        prefix = "investor_issuer" if key == "issuer" else "investor_eodhd"
        capture = db.execute("SELECT * FROM " + prefix + "_captures WHERE workspace_id=? AND request_id=?", (workspace, request["id"])).fetchone()
        if capture:
            capture = (issuer_sources if key == "issuer" else eodhd_sources)._capture_header(db, workspace, capture["id"], at)[0]
            if capture["status"] != "captured": return None, "SOURCE_CAPTURE_TERMINAL_FAILURE"
            refs[key] = {"capture_id": capture["id"], "capture_hash": capture["content_hash"]}
            continue
        if key == "issuer":
            scheduled = db.execute("SELECT id FROM investor_issuer_schedule_requests WHERE issuer_request_id=? AND workspace_id=?", (request["id"], workspace)).fetchone()
            job = db.execute("SELECT status,attempt_count FROM job_runs WHERE job_type='investor_issuer_capture' AND scope=? AND period=?",
                (workspace, scheduled[0])).fetchone() if scheduled else None
            if not scheduled and instant(at) > instant(request["created_at"]) + timedelta(seconds=31): return None, "SOURCE_CAPTURE_TERMINAL_FAILURE"
        else:
            job = db.execute("SELECT status,attempt_count FROM job_runs WHERE job_type='investor_eodhd_capture' AND scope=? AND period=?",
                (workspace, request["id"])).fetchone()
        if job and job["status"] in ("failed", "cancelled", "skipped", "succeeded") and job["attempt_count"]:
            return None, "SOURCE_CAPTURE_TERMINAL_FAILURE"
        pending = True
    return (None if pending else refs), None


def _inputs(db, workspace, actor, policy, refs, at):
    anchor = _anchor(db, workspace, actor, policy["base_review_id"], policy["listing_review_id"], policy["anchor_captures"], at)
    _check(anchor["binding_hash"] == policy["anchor_binding_hash"] and anchor["base"]["review"]["content_hash"] == policy["base_review_hash"]
        and anchor["listing"]["review"]["content_hash"] == policy["listing_review_hash"]
        and anchor["listing"]["facts"]["listing_id"] == policy["listing_id"]
        and anchor["listing"]["facts"]["provider_symbol"] == policy["provider_symbol"], "AUTHORITY_INPUTS_CHANGED")
    values, report, limits = _captures(db, workspace, actor, policy["listing_review_id"], refs, at)
    _check(all(report["bindings"][key][field] == anchor["report"]["bindings"][key][field]
        for key in report["bindings"] for field in ("authority_id", "authority_hash", "control_id", "control_hash")), "AUTHORITY_INPUTS_CHANGED")
    candidate = check_no_new_action_extension(anchor["base"]["facts"], anchor["snapshots"],
        {key: value["draft"] for key, value in values.items()}, symbol=policy["provider_symbol"], listing_id=policy["listing_id"])
    digest = content_hash({"authority_input": policy, "anchor_binding_hash": anchor["binding_hash"],
        "current_bindings": report["bindings"], "candidate": candidate})
    return {"anchor": anchor, "report": report, "candidate": candidate, "checked_hash": digest,
        "valid_until": _clock(min([instant(policy["valid_until"]), *anchor["limits"], *limits])),
        "current_capture_created_at": max((value["capture"]["created_at"] for value in values.values()), key=instant)}


def _virtual_document(policy, base_facts, source, coverage_end, valid_until):
    facts = deepcopy(base_facts); facts["range_end"] = coverage_end
    return {"schema_version": "investor-data-review-v2", "source_id": source["id"], "source_hash": source["content_hash"],
        "kind": "actions", "version": 1, "decision": "approved", "facts": facts, "reason": REASON,
        "valid_until": valid_until, "review_basis": "owner_standing_no_new_actions_rule"}


def _publication_header(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_action_publications WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    doc = _sealed(row, "publication")
    request, _, authority, policy, control = _request(db, workspace, row["request_id"], at)
    _audit_binding(db, row, "investor_publish_action_maintenance", "investor_action_publication", identifier)
    _check(identifier.startswith(PREFIX) and doc["publication_id"] == identifier
        and all(doc[key] == row[key] for key in ("workspace_id", "authority_id", "request_id", "sequence", "previous_id", "source_day", "status",
            "source_id", "review_hash", "coverage_end", "valid_until", "created_at"))
        and row["actor_id"] == authority["actor_id"] and request["authority_id"] == authority["id"] == row["authority_id"]
        and doc["authority_hash"] == authority["content_hash"] and doc["control_id"] == control["id"]
        and doc["control_hash"] == control["content_hash"] and doc["request_hash"] == request["content_hash"]
        and row["source_day"] == request["source_day"] and request["created_at"] <= row["created_at"] <= at)
    if row["status"] == "published":
        _check(instant(row["created_at"]) < instant(request["valid_until"])
            and instant(policy["valid_from"]) <= instant(row["created_at"]) < instant(policy["valid_until"]))
    if row["previous_id"]:
        previous = db.execute("SELECT * FROM investor_action_publications WHERE id=? AND workspace_id=?", (row["previous_id"], workspace)).fetchone()
        prior = _sealed(previous, "publication")
        _audit_binding(db, previous, "investor_publish_action_maintenance", "investor_action_publication", previous["id"])
        _check(previous["authority_id"] == row["authority_id"] and previous["sequence"] + 1 == row["sequence"]
            and prior["publication_id"] == previous["id"] and previous["content_hash"] == doc["previous_hash"]
            and previous["created_at"] <= row["created_at"] and previous["source_day"] < row["source_day"])
    else: _check(row["sequence"] == 1 and doc["previous_hash"] is None)
    return row, doc


def publish_current_actions(db, *, limit=100, now=None, clock=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000)
    clock = clock or (lambda: now); at = _clock(clock())
    _stopped(db, stop_requested); discover_requests(db, limit=limit, now=at, stop_requested=stop_requested)
    pending = db.execute("""SELECT r.id,r.workspace_id FROM investor_action_requests r WHERE NOT EXISTS
      (SELECT 1 FROM investor_action_publications p WHERE p.request_id=r.id) ORDER BY r.created_at,r.id LIMIT ?""", (limit,)).fetchall()
    results = []
    for selected in pending:
        _stopped(db, stop_requested)
        try:
            with transaction(db, immediate=False), _fact_validation_scope():
                request, _, authority, policy, original_control = _request(db, selected["workspace_id"], selected["id"], at)
                current = _authority(db, request["workspace_id"], authority["id"], at)
                status, failure, prepared, refs = "published", None, None, None
                if not _active(current, at) or current[2]["id"] != original_control["id"]:
                    status = "superseded"
                elif _quarantined(db, request["workspace_id"], authority["id"], at):
                    status = "superseded"
                elif at >= request["valid_until"]:
                    status, failure = "blocked", "MAINTENANCE_WINDOW_MISSED"
                else:
                    refs, failure = _current_refs(db, request["workspace_id"], policy, request["source_day"], at)
                    if failure: status = "blocked"
                    elif refs is None: continue
                    else:
                        try: prepared = _inputs(db, request["workspace_id"], authority["actor_id"], policy, refs, at)
                        except WorkbenchError as error:
                            if str(error) in STOP: raise
                            suffix = str(error).removeprefix("INVESTOR_DATA_ACTION_MAINTENANCE_")
                            failure = suffix if suffix in ("NEW_REPORTED_ACTION", "HISTORICAL_RECORDS_CHANGED", "AUTHORITY_INPUTS_CHANGED") else "RULE_INPUTS_REJECTED"
                            status = "blocked"
                previous = db.execute("SELECT * FROM investor_action_publications WHERE authority_id=? ORDER BY sequence DESC LIMIT 1", (authority["id"],)).fetchone()
                latest = db.execute("SELECT * FROM investor_action_publications WHERE authority_id=? AND status='published' ORDER BY sequence DESC LIMIT 1", (authority["id"],)).fetchone()
                previous_end = latest["coverage_end"] if latest else _object(db.execute("SELECT document_json FROM investor_data_reviews WHERE id=?", (policy["base_review_id"],)).fetchone()[0])["facts"]["range_end"]
                if prepared and prepared["candidate"]["candidate_range_end"] <= previous_end: status = "unchanged"
            with transaction(db):
                _stopped(db, stop_requested)
                if db.execute("SELECT 1 FROM investor_action_publications WHERE request_id=?", (request["id"],)).fetchone(): continue
                checked = _clock(clock())
                refreshed = _authority(db, request["workspace_id"], authority["id"], checked)
                head = db.execute("SELECT id FROM investor_action_publications WHERE authority_id=? ORDER BY sequence DESC LIMIT 1", (authority["id"],)).fetchone()
                if (head[0] if head else None) != (previous["id"] if previous else None): continue
                if status in ("published", "unchanged"):
                    if not _active(refreshed, checked) or refreshed[2]["id"] != original_control["id"] or checked >= request["valid_until"]:
                        continue
                    _check(not _quarantined(db, request["workspace_id"], authority["id"], checked), "SOURCE_QUARANTINED")
                    _check_review_pins(db, request["workspace_id"], prepared["anchor"]["pins"], checked)
                    _check_capture_headers(db, request["workspace_id"], [prepared["anchor"]["report"], prepared["report"]], checked)
                    _check(checked < prepared["valid_until"])
                value = _commit_publication(db, request, authority, policy, original_control, previous, status, failure, refs, prepared, checked)
                results.append(value)
        except sqlite3.OperationalError as error:
            if getattr(error, "sqlite_errorcode", None) not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_BUSY_SNAPSHOT): raise
        except WorkbenchError as error:
            if str(error) in STOP: raise
            enqueue_gap(db, selected["workspace_id"], selected["id"], at)
    return results


def enqueue_gap(db, workspace, identifier, at):
    from worker.orchestration.jobs import enqueue_notification
    enqueue_notification(db, "action-maintenance-gap:" + identifier, "investor.action_maintenance_gap",
        {"workspace_id": workspace, "request_id": identifier, "code": "ACTION_MAINTENANCE_UNAVAILABLE"}, now=at)


def _commit_publication(db, request, authority, policy, control, previous, status, failure, refs, prepared, at):
    identifier = new_id("managed-actions-review")
    source = None; review_hash = None; coverage_end = None
    expiry = prepared["valid_until"] if prepared else policy["valid_until"]
    if status == "published":
        coverage_end = prepared["candidate"]["candidate_range_end"]
        source = store_source(db, authority["workspace_id"], authority["actor_id"], "actions", {
            "title": "Standing no-new-action coverage",
            "reference": "investor-action-rule:" + authority["id"] + ":" + request["source_day"],
            "excerpt": REASON}, now=at)
        _check(source["created_at"] == at and not db.execute("SELECT 1 FROM investor_data_reviews WHERE source_id=?", (source["id"],)).fetchone(),
            "AUTHORITY_INPUTS_CHANGED")
        review = _virtual_document(policy, prepared["anchor"]["base"]["facts"], source, coverage_end, expiry)
        _check(content_hash(review["facts"]) == prepared["candidate"]["candidate_facts_hash"])
        review_hash = content_hash(review)
    doc = {"schema_version": "investor-action-maintenance-publication-v1", "publication_id": identifier,
        "workspace_id": authority["workspace_id"], "authority_id": authority["id"], "authority_hash": authority["content_hash"],
        "control_id": control["id"], "control_hash": control["content_hash"], "request_id": request["id"], "request_hash": request["content_hash"],
        "sequence": previous["sequence"] + 1 if previous else 1, "previous_id": previous["id"] if previous else None,
        "previous_hash": previous["content_hash"] if previous else None, "source_day": request["source_day"], "status": status,
        "reason_code": {"published": "ACTION_COVERAGE_EXTENDED", "blocked": "ACTION_MAINTENANCE_NEEDS_REVIEW",
            "unchanged": "ACTION_COVERAGE_UNCHANGED", "superseded": "ACTION_RULE_SUPERSEDED"}[status],
        "failure_code": failure, "capture_refs": refs, "checked_input_hash": prepared["checked_hash"] if prepared else None,
        "candidate_facts_hash": prepared["candidate"]["candidate_facts_hash"] if prepared else None,
        "source_id": source["id"] if source else None, "source_hash": source["content_hash"] if source else None,
        "review_hash": review_hash, "coverage_end": coverage_end, "created_at": at, "valid_until": expiry,
        "coverage_basis": BASIS, "human_review_performed": False, "additional_source_requests": 0, "trading_permission": False}
    validate_contract(doc, SCHEMA, fragment="$defs/publication")
    digest = content_hash(doc)
    audit = _audit(db, authority["actor_id"], "investor_publish_action_maintenance", "investor_action_publication", identifier, {"content_hash": digest}, at)
    db.execute("INSERT INTO investor_action_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, authority["workspace_id"], authority["id"], request["id"],
        doc["sequence"], doc["previous_id"], request["source_day"], status, doc["source_id"], review_hash, coverage_end, expiry,
        canonical_json(doc), digest, authority["actor_id"], at, audit))
    return {"publication_id": identifier, "status": status, "reason_code": doc["reason_code"], "failure_code": failure,
        "human_review_performed": False, "additional_source_requests": 0, "trading_permission": False}


def managed_review_header(db, workspace, identifier, at):
    """Reconstruct a sealed virtual header, including after permission expiry."""
    row, doc = _publication_header(db, workspace, identifier, at)
    authority, policy, _ = _authority(db, workspace, row["authority_id"], at)
    _check(row["status"] == "published" and not policy["base_review_id"].startswith(PREFIX)
        and not policy["listing_review_id"].startswith(PREFIX))
    base = review_header(db, workspace, policy["base_review_id"], now=at)
    listing = review_header(db, workspace, policy["listing_review_id"], now=at)
    _check(base["source"]["kind"] == "actions" and listing["source"]["kind"] == "listing"
        and base["review"]["decision"] == listing["review"]["decision"] == "approved"
        and base["review"]["content_hash"] == policy["base_review_hash"]
        and listing["review"]["content_hash"] == policy["listing_review_hash"]
        and base["facts"]["listing_id"] == listing["facts"]["listing_id"] == policy["listing_id"]
        and listing["facts"]["provider_symbol"] == policy["provider_symbol"]
        and base["review"]["created_at"] <= authority["created_at"]
        and listing["review"]["created_at"] <= authority["created_at"]
        and base["facts"]["range_end"] < row["coverage_end"] < row["source_day"]
        and row["created_at"] < row["valid_until"] <= min(policy["valid_until"], base["review"]["valid_until"], listing["review"]["valid_until"]))
    previous = db.execute("SELECT id FROM investor_action_publications WHERE authority_id=? AND workspace_id=? AND status='published' AND sequence<? ORDER BY sequence DESC LIMIT 1",
        (row["authority_id"], workspace, row["sequence"])).fetchone()
    if previous:
        _check(_publication_header(db, workspace, previous[0], at)[0]["coverage_end"] < row["coverage_end"])
    source = db.execute("SELECT * FROM investor_data_sources WHERE id=? AND workspace_id=?", (row["source_id"], workspace)).fetchone()
    _check(source is not None and source["kind"] == "actions" and source["actor_id"] == authority["actor_id"]
        and source["created_at"] == row["created_at"] and source["content_hash"] == doc["source_hash"]
        and content_hash(_object(source["document_json"])) == source["content_hash"])
    _audit_binding(db, source, "investor_store_data_source", "investor_data_source", source["id"])
    document = _virtual_document(policy, base["facts"], source, row["coverage_end"], row["valid_until"])
    validate_facts("actions", document["facts"])
    _check(content_hash(document["facts"]) == doc["candidate_facts_hash"]
        and content_hash(document) == row["review_hash"] == doc["review_hash"])
    review = {"id": row["id"], "workspace_id": workspace, "source_id": source["id"], "version": 1, "decision": "approved",
        "document_json": canonical_json(document), "content_hash": row["review_hash"], "actor_id": authority["actor_id"],
        "created_at": row["created_at"], "valid_until": row["valid_until"], "audit_id": row["audit_id"]}
    return {"review": review, "source": dict(source), "facts": document["facts"]}


def managed_review_unavailable(db, workspace, identifier, at):
    """Metadata-only gate; unavailable metadata never qualifies raw evidence."""
    return _managed_review_unavailable(db, workspace, identifier, at, current_rule_required=True)


def managed_review_storage_unavailable(db, workspace, identifier, at):
    """Pausing computation is not withdrawal of source storage permission."""
    return _managed_review_unavailable(db, workspace, identifier, at, current_rule_required=False)


def _managed_review_unavailable(db, workspace, identifier, at, *, current_rule_required):
    if not identifier.startswith(PREFIX): return None
    value = managed_review_header(db, workspace, identifier, at)
    row, doc = _publication_header(db, workspace, identifier, at)
    authority = _authority(db, workspace, row["authority_id"], at)
    _, policy, control = authority
    reason = None
    if at >= value["review"]["valid_until"] or at >= policy["valid_until"]:
        reason = "REFERENCE_SOURCE_EXPIRED"
    elif current_rule_required and (not _active(authority, at) or control["id"] != doc["control_id"] or _quarantined(db, workspace, authority[0]["id"], at)):
        reason = "REFERENCE_SOURCE_NO_LONGER_CURRENT"
    for identifier in (policy["base_review_id"], policy["listing_review_id"]):
        header = review_header(db, workspace, identifier, now=at)
        latest = db.execute("SELECT id FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1", (header["source"]["id"],)).fetchone()
        if header["review"]["valid_until"] <= at:
            reason = reason or "REFERENCE_SOURCE_EXPIRED"
        elif latest[0] != identifier:
            reason = reason or "REFERENCE_SOURCE_NO_LONGER_CURRENT"
    anchor_bindings = {}
    for refs in (policy["anchor_captures"], doc["capture_refs"]):
        for key, ref in refs.items():
            module = issuer_sources if key == "issuer" else eodhd_sources
            capture, _, request, *_ = module._capture_header(db, workspace, ref["capture_id"], at)
            _check(capture["status"] == "captured" and capture["qualification"] == module.OFFICIAL
                and capture["content_hash"] == ref["capture_hash"] and capture["retain_until"] >= row["valid_until"])
            binding = request["authority_id"], request["control_id"]
            if key in anchor_bindings: _check(binding == anchor_bindings[key])
            anchor_bindings[key] = binding
            grant = module._grant(db, workspace, request["authority_id"], at)
            active = module._active(grant[1], grant[2], at) if key == "issuer" else module._active(grant, at)
            purged = module._purge_header(db, workspace, capture["id"], at)
            if capture["retain_until"] <= at or grant[1]["valid_until"] <= at:
                reason = reason or "REFERENCE_SOURCE_EXPIRED"
            elif not active or grant[2]["id"] != request["control_id"]:
                reason = reason or "REFERENCE_SOURCE_NO_LONGER_CURRENT"
            elif purged:
                reason = reason or "REFERENCE_SOURCE_PAYLOAD_PURGED"
            if not purged:
                prefix = "investor_issuer" if key == "issuer" else "investor_eodhd"
                _check(db.execute("SELECT 1 FROM " + prefix + "_payloads WHERE workspace_id=? AND raw_sha256=?",
                    (workspace, capture["raw_sha256"])).fetchone() is not None, "PAYLOAD_UNAVAILABLE")
    return reason


def current_action_reviews(db, workspace, listing_ids, at, *, limit=128, header_only=False):
    """Shadow only an explicitly bound baseline, never unrelated action facts."""
    with transaction(db, immediate=False), _fact_validation_scope():
        return _current_action_reviews(db, workspace, listing_ids, at, limit=limit, header_only=header_only)


def _current_action_reviews(db, workspace, listing_ids, at, *, limit, header_only):
    from .action_review_selection import verified_action_successions
    listing_ids = sorted(set(listing_ids))
    _check(0 < len(listing_ids) <= 20 and type(limit) is int and 1 <= limit <= 128 and type(header_only) is bool)
    links = verified_action_successions(db, workspace, listing_ids, at)
    placeholders = ",".join("?" for _ in listing_ids)
    manual = db.execute("""SELECT r.id FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id
      WHERE r.workspace_id=? AND s.workspace_id=r.workspace_id AND s.kind='actions' AND r.decision='approved'
        AND r.created_at<=? AND r.valid_until>? AND r.version=(SELECT max(version) FROM investor_data_reviews WHERE source_id=r.source_id)
        AND json_extract(r.document_json,'$.facts.listing_id') IN (""" + placeholders + ") ORDER BY r.created_at DESC,r.id LIMIT ?",
        (workspace, at, at, *listing_ids, limit + len(links["shadowed"]) + 1)).fetchall()
    manual = [row for row in manual if row["id"] not in links["shadowed"]]
    rules = db.execute("""SELECT a.id FROM investor_action_authorities a JOIN investor_action_controls c ON c.authority_id=a.id
      WHERE a.workspace_id=? AND a.created_at<=? AND c.enabled=1
        AND c.version=(SELECT max(version) FROM investor_action_controls WHERE authority_id=a.id)
        AND json_extract(a.document_json,'$.valid_from')<=? AND a.listing_id IN (""" + placeholders + ") ORDER BY a.created_at,a.id LIMIT ?",
        (workspace, at, at, *listing_ids, limit + 1)).fetchall()
    _check(len(manual) <= limit and len(rules) <= limit, "SOURCE_LIMIT")
    shadowed, derived, identities = set(), [], set()
    for rule in rules:
        value = _authority(db, workspace, rule["id"], at)
        authority, policy, _ = value
        _check(policy["listing_id"] not in identities, "SOURCE_AMBIGUOUS")
        identities.add(policy["listing_id"])
        _check(_active(value, at) and not _quarantined(db, workspace, authority["id"], at), "SOURCE_UNAVAILABLE")
        head = db.execute("SELECT id FROM investor_action_publications WHERE authority_id=? AND status='published' ORDER BY sequence DESC LIMIT 1",
            (authority["id"],)).fetchone()
        if head is None and authority["id"] in links["terminals"]:
            # Explicitly approved facts can cover a window without inventing a
            # successful maintenance publication or enabling a default-off rule.
            continue
        _check(head is not None, "SOURCE_UNAVAILABLE"); shadowed.add(policy["base_review_id"])
        if header_only:
            _check(managed_review_unavailable(db, workspace, head["id"], at) is None, "SOURCE_UNAVAILABLE")
            derived.append(managed_review_header(db, workspace, head["id"], at))
        else:
            derived.append(resolve_managed_review(db, workspace, head["id"], now=at))
    return [resolve_review(db, workspace, row["id"], "actions", now=at) for row in manual if row["id"] not in shadowed] + derived


def check_same_rule_extension(db, workspace, previous, current, at):
    """Only the bound manual baseline or a prior publication of this exact rule."""
    identifier = current["review"]["id"]
    _check(identifier.startswith(PREFIX), "AUTHORITY_REVIEW_REQUIRED")
    publication, _ = _publication_header(db, workspace, identifier, at)
    _, policy, _ = _authority(db, workspace, publication["authority_id"], at)
    old_id = previous["review"]["id"]
    if old_id.startswith(PREFIX):
        older, _ = _publication_header(db, workspace, old_id, at)
        _check(older["authority_id"] == publication["authority_id"] and older["sequence"] < publication["sequence"], "AUTHORITY_REVIEW_REQUIRED")
    else:
        _check(old_id == policy["base_review_id"] and previous["review"]["content_hash"] == policy["base_review_hash"], "AUTHORITY_REVIEW_REQUIRED")
    _check(previous["facts"]["range_end"] <= current["facts"]["range_end"]
        and {key: value for key, value in previous["facts"].items() if key != "range_end"}
            == {key: value for key, value in current["facts"].items() if key != "range_end"}, "HISTORICAL_RECORDS_CHANGED")


def action_refresh_basis(db, workspace, identifier, at):
    """Historical comparison only; never admit an old control as current evidence."""
    return managed_review_header(db, workspace, identifier, at) if identifier.startswith(PREFIX) else resolve_review(
        db, workspace, identifier, "actions", now=at)


def paused_control_successor(db, workspace, identifier, at):
    """Require a new fully replayed head under the same rule's current control."""
    previous = managed_review_header(db, workspace, identifier, at)
    row, doc = _publication_header(db, workspace, identifier, at)
    authority, policy, control = _authority(db, workspace, row["authority_id"], at)
    _check(_active((authority, policy, control), at) and not _quarantined(db, workspace, authority["id"], at)
        and doc["control_id"] != control["id"] and at < row["valid_until"], "SOURCE_UNAVAILABLE")
    head = db.execute("SELECT id FROM investor_action_publications WHERE authority_id=? AND workspace_id=? AND status='published' ORDER BY sequence DESC LIMIT 1",
        (authority["id"], workspace)).fetchone()
    _check(head is not None, "SOURCE_UNAVAILABLE")
    current = resolve_managed_review(db, workspace, head["id"], now=at)
    check_same_rule_extension(db, workspace, previous, current, at)
    return current


def inspect_authority(db, workspace, actor, identifier, *, now=None):
    at = _clock(now)
    with transaction(db, immediate=False):
        _owner(db, workspace, actor)
        value = _authority(db, workspace, identifier, at)
        authority, policy, control = value
        head = db.execute("SELECT id FROM investor_action_publications WHERE authority_id=? ORDER BY sequence DESC LIMIT 1", (identifier,)).fetchone()
        publication, document = _publication_header(db, workspace, head[0], at) if head else (None, None)
        blocked = _quarantined(db, workspace, identifier, at)
        state = "needs_review" if blocked else "disabled" if not control["enabled"] else "expired" if at >= policy["valid_until"] \
            else "not_yet_active" if at < policy["valid_from"] else "published" if publication and publication["status"] == "published" else "waiting_for_sources"
        return {"authority_id": identifier, "authority_hash": authority["content_hash"], "listing_id": policy["listing_id"],
            "provider_symbol": policy["provider_symbol"], "control_id": control["id"], "enabled": bool(control["enabled"]), "state": state,
            "valid_from": policy["valid_from"], "valid_until": policy["valid_until"],
            "latest_publication_id": publication["id"] if publication else None,
            "latest_publication_status": publication["status"] if publication else None,
            "latest_source_day": publication["source_day"] if publication else None,
            "failure_code": document["failure_code"] if document else None,
            "coverage_basis": BASIS, "human_review_performed_today": False, "additional_source_requests": 0,
            "raw_evidence_qualified_by_this_inspection": False, "market_values_output": False, "trading_permission": False}


def resolve_managed_review(db, workspace, identifier, *, now=None):
    at = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        row, doc = _publication_header(db, workspace, identifier, at)
        value = _authority(db, workspace, row["authority_id"], at); authority, policy, current = value
        request = _request(db, workspace, row["request_id"], at)[0]
        _check(row["status"] == "published" and _active(value, at) and current["id"] == doc["control_id"]
            and not _quarantined(db, workspace, authority["id"], at), "SOURCE_UNAVAILABLE")
        _check(row["created_at"] < row["valid_until"] and at < row["valid_until"], "RETENTION_EXPIRED")
        inputs = _inputs(db, workspace, authority["actor_id"], policy, doc["capture_refs"], at)
        _check(all(instant(value["capture"]["created_at"]) <= instant(authority["created_at"]) for value in inputs["anchor"]["values"].values())
            and instant(inputs["current_capture_created_at"]) <= instant(row["created_at"]))
        _check(inputs["report"]["source_day"] == request["source_day"]
            and inputs["checked_hash"] == doc["checked_input_hash"] and inputs["valid_until"] == row["valid_until"]
            and inputs["candidate"]["candidate_range_end"] == row["coverage_end"]
            and inputs["candidate"]["candidate_facts_hash"] == doc["candidate_facts_hash"])
        return managed_review_header(db, workspace, identifier, at)
