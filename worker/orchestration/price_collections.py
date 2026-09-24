"""Fenced daily price slots from explicit human-reviewed finite schedules."""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from hashlib import sha256
import sqlite3
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.market.references import ZONES, price_collection_scope, verify_reference_version
from .collections import _identifier, _integer, _json, _time, _JS_WHITESPACE
from .db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, stamp, transaction
from .jobs import assert_lease, enqueue_notification


DISCOVERY_ACTOR = "system:price-collection-discovery"
MAX_CONTROL_HISTORY = 1024
PRICE_COLLECTION_TERMINAL_CODES = frozenset({
    "PRICE_COLLECTION_BINDING_INVALID", "PRICE_COLLECTION_AUTHORIZATION_ENDED", "PRICE_COLLECTION_NOT_DUE",
    "PRICE_COLLECTION_DEADLINE_EXPIRED", "PRICE_COLLECTION_REFERENCE_CHANGED", "STALE_PUBLICATION_REVISION",
})


@dataclass
class PriceCollectionDiscoveryState:
    after_schedule_id: str = ""


def _require(value):
    if not value:
        raise WorkbenchError("PRICE_COLLECTION_BINDING_INVALID")


def _human(value):
    return (isinstance(value, str) and 1 <= len(value) <= 160 and all(0x21 <= ord(char) <= 0x7e for char in value)
            and value.lower() != "system" and not value.lower().startswith("system:"))


def _day(value):
    parsed = date.fromisoformat(value)
    _require(parsed.isoformat() == value)
    return parsed


def scheduled_at(period, definition):
    """Reject nonexistent and ambiguous wall times, including both DST folds."""
    day = _day(period) + timedelta(days=1)
    wall = datetime.combine(day, time(definition["trigger_local"]["hour"], definition["trigger_local"]["minute"]))
    zone = ZoneInfo(definition["timezone"])
    values = {wall.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc) for fold in (0, 1)
              if wall.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None) == wall}
    _require(len(values) == 1)
    return values.pop()


def _definition(raw, digest):
    _require(isinstance(raw, str) and 1 <= len(raw.encode("utf8")) <= 65536
             and sha256(raw.encode("utf8")).hexdigest() == digest)
    value = _json(raw)
    validate_contract(value, "price-collection-schedule.schema.json")
    value = {**value, "trigger_local": {key: int(item) for key, item in value["trigger_local"].items()},
             "deadline_seconds": int(value["deadline_seconds"]), "max_attempts": int(value["max_attempts"])}
    _require(value["timezone"] == ZONES[value["market"]])
    start, end = _day(value["start_date"]), _day(value["end_date"])
    _require(0 <= (end - start).days < 3660)
    previous = None
    for offset in range((end - start).days + 1):
        due = scheduled_at((start + timedelta(days=offset)).isoformat(), value)
        _require(previous is None or previous + timedelta(seconds=value["deadline_seconds"]) <= due)
        previous = due
    return value


def reference_binding(connection, portfolio, definition, known_at, *, require_current=False):
    mappings = [verify_reference_version(connection, identity, portfolio, known_at, require_current=require_current)
                for identity in definition["mapping_version_ids"]]
    calendars = [verify_reference_version(connection, identity, portfolio, known_at, require_current=require_current)
                 for identity in definition["calendar_version_ids"]]
    _require(all(row["version"]["kind"] == "mapping" for row in mappings)
             and all(row["version"]["kind"] == "calendar" for row in calendars))
    _require({row["document"]["facts"]["market"] for row in [*mappings, *calendars]} == {definition["market"]})
    by_exchange = {row["document"]["facts"]["exchange"]: row for row in calendars}
    _require(len(by_exchange) == len(calendars))
    proofs, used, identities = [], set(), set()
    for row in sorted(mappings, key=lambda row: row["document"]["facts"]["listing_id"]):
        facts = row["document"]["facts"]
        identity = facts["listing_id"]
        _require(identity not in identities and facts["valid_from"] <= definition["start_date"]
                 and (facts["valid_to"] is None or definition["end_date"] < facts["valid_to"]))
        identities.add(identity)
        listing = connection.execute("SELECT id,market,exchange,currency,created_at FROM listings WHERE id=?", (identity,)).fetchone()
        entry = connection.execute("SELECT * FROM catalog_entries WHERE portfolio_id=? AND listing_id=?", (portfolio, identity)).fetchone()
        _require(listing is not None and entry is not None and instant(listing["created_at"]) <= instant(known_at)
                 and instant(entry["created_at"]) <= instant(known_at)
                 and all(listing[key] == facts[key] for key in ("market", "exchange", "currency")))
        calendar = by_exchange.get(facts["exchange"])
        _require(calendar is not None)
        days = calendar["document"]["facts"]
        _require(days["timezone"] == definition["timezone"] and days["range_start"] <= definition["start_date"]
                 and definition["end_date"] <= days["range_end"])
        used.add(calendar["version"]["id"])
        proofs.append({**row["proof"], "listing_id": identity, "listing_identity_hash": content_hash(dict(listing)),
                       "catalog_entry_hash": content_hash(dict(entry)), "calendar_version_id": calendar["version"]["id"]})
    _require(used == {row["version"]["id"] for row in calendars})
    return {"schema_version": "price-schedule-reference-binding-v1", "portfolio_id": portfolio,
            "market": definition["market"], "timezone": definition["timezone"],
            "start_date": definition["start_date"], "end_date": definition["end_date"], "known_at": stamp(known_at),
            "mappings": proofs, "calendars": sorted((row["proof"] for row in calendars), key=lambda row: row["version_id"]),
            "heads": sorted((row["head"] for row in [*mappings, *calendars]), key=lambda row: (row["kind"], row["scope_key"]))}


def _audit(connection, identity, schedule):
    row = connection.execute("SELECT * FROM audit_events WHERE id=?", (identity,)).fetchone()
    _require(row is not None)
    audit, body = dict(row), _json(row["payload_json"])
    _require(audit["object_type"] == "price_collection_schedule" and audit["object_id"] == schedule["id"]
             and audit["portfolio_id"] == schedule["portfolio_id"] and audit["ledger_revision"] is None
             and _human(audit["actor_id"])
             and isinstance(body, dict) and set(body) == {"actor_kind", "input", "result"}
             and body["actor_kind"] == "human" and isinstance(body["input"], dict) and isinstance(body["result"], dict))
    command, result = body["input"], body["result"]
    base = {"portfolio_id", "idempotency_key", "reason", "acknowledgement", "expected_schedule_revision"}
    if audit["action"] == "save_price_collection_schedule":
        _require(set(command) == base | {"expected_schedule_id", "definition_json"}
                 and (command["expected_schedule_id"] is None or _identifier(command["expected_schedule_id"]))
                 and isinstance(command["definition_json"], str) and 1 <= len(command["definition_json"].encode("utf8")) <= 65536
                 and _integer(command["expected_schedule_revision"]))
    elif audit["action"] == "set_price_collection_schedule_status":
        _require(set(command) == base | {"schedule_id", "status"} and _identifier(command["schedule_id"])
                 and command["status"] in ("enabled", "paused") and _integer(command["expected_schedule_revision"], 1))
    else:
        _require(False)
    _require(command["portfolio_id"] == schedule["portfolio_id"] and command["acknowledgement"] is True
             and _identifier(command["portfolio_id"]) and _identifier(command["idempotency_key"])
             and isinstance(command["reason"], str) and 1 <= len(command["reason"]) <= 1000
             and bool(command["reason"].strip(_JS_WHITESPACE))
             and not any(ord(char) == 0 or 0x1c <= ord(char) <= 0x1f or ord(char) == 0x85 or 0xd800 <= ord(char) <= 0xdfff for char in command["reason"])
             and set(result) == {"schedule_id", "version_id", "version", "schedule_revision", "status", "scope_key", "content_hash"}
             and _integer(result["version"], 1) and _integer(result["schedule_revision"], 1))
    _time(audit["created_at"])
    return audit, command, result


def _version(connection, schedule, identity):
    row = connection.execute("SELECT * FROM price_collection_schedule_versions WHERE id=?", (identity,)).fetchone()
    _require(row is not None)
    version = dict(row)
    definition = _definition(version["definition_json"], version["content_hash"])
    references = _json(version["reference_binding_json"])
    # Missing or superseded live references must produce a blocked slot, not erase its authorization.
    _require(isinstance(references, dict) and set(references) == {"schema_version", "portfolio_id", "market", "timezone",
             "start_date", "end_date", "known_at", "mappings", "calendars", "heads"}
             and references["schema_version"] == "price-schedule-reference-binding-v1"
             and references["portfolio_id"] == schedule["portfolio_id"] and references["known_at"] == version["created_at"]
             and all(references[key] == definition[key] for key in ("market", "timezone", "start_date", "end_date"))
             and content_hash(references) == version["reference_binding_hash"]
             and version["schedule_id"] == schedule["id"] and schedule["provider"] == "longport"
             and schedule["market"] == definition["market"] and _integer(version["version"], 1, 1023)
             and schedule["scope_key"] == price_collection_scope(schedule["portfolio_id"], references)
             and _time(version["created_at"]) >= _time(schedule["created_at"]))
    audit, command, result = _audit(connection, version["audit_id"], schedule)
    _require(audit["action"] == "save_price_collection_schedule" and audit["actor_id"] == version["created_by"]
             and audit["created_at"] == version["created_at"] and command["definition_json"] == version["definition_json"]
             and command["expected_schedule_id"] == (None if version["version"] == 1 else schedule["id"])
             and result == {"schedule_id": schedule["id"], "version_id": version["id"], "version": version["version"],
                            "schedule_revision": command["expected_schedule_revision"] + 1, "status": "paused",
                            "scope_key": schedule["scope_key"], "content_hash": version["content_hash"]})
    if version["version"] == 1:
        _require(command["expected_schedule_revision"] == 0 and version["created_at"] == schedule["created_at"]
                 and version["created_by"] == schedule["created_by"])
    return version, definition


def _history(connection, schedule, through=9007199254740991):
    rows = connection.execute("SELECT * FROM price_collection_schedule_controls WHERE schedule_id=? AND revision<=? ORDER BY revision LIMIT ?",
                              (schedule["id"], through, MAX_CONTROL_HISTORY + 1)).fetchall()
    _require(rows and len(rows) <= MAX_CONTROL_HISTORY)
    proofs, versions, version_number = [], {}, 0
    for expected, row in enumerate(rows, 1):
        control = dict(row)
        _require(control["revision"] == expected and control["schedule_id"] == schedule["id"])
        if control["version_id"] not in versions:
            versions[control["version_id"]] = _version(connection, schedule, control["version_id"])
        version, definition = versions[control["version_id"]]
        audit, command, result = _audit(connection, control["audit_id"], schedule)
        _require(audit["created_at"] == control["created_at"] and _time(control["created_at"]) >= _time(version["created_at"])
                 and command["expected_schedule_revision"] == expected - 1
                 and result == {"schedule_id": schedule["id"], "version_id": version["id"], "version": version["version"],
                                "schedule_revision": expected, "status": control["status"], "scope_key": schedule["scope_key"],
                                "content_hash": version["content_hash"]})
        previous = rows[expected - 2] if expected > 1 else None
        _require(previous is None or _time(previous["created_at"]) <= _time(control["created_at"]))
        if audit["action"] == "save_price_collection_schedule":
            _require(control["status"] == "paused" and control["audit_id"] == version["audit_id"]
                     and version["version"] == version_number + 1)
            version_number += 1
        else:
            _require(previous is not None and previous["version_id"] == version["id"] and version["version"] == version_number
                     and command["schedule_id"] == schedule["id"] and command["status"] == control["status"])
        if expected == MAX_CONTROL_HISTORY:
            _require(audit["action"] == "set_price_collection_schedule_status" and previous["status"] == "enabled" and control["status"] == "paused")
        proofs.append({"schedule": schedule, "version": version, "definition": definition,
                       "authorization": {**control, "ended_at": rows[expected]["created_at"] if expected < len(rows) else None}})
    return proofs


def _head(connection, schedule, current):
    head = connection.execute("SELECT * FROM price_collection_schedule_heads WHERE schedule_id=?", (schedule["id"],)).fetchone()
    _require(head is not None)
    history = _history(connection, schedule)
    proof, row = history[-1], history[-1]["authorization"]
    _require(head["scope_key"] == schedule["scope_key"] and head["current_version_id"] == row["version_id"]
             and head["revision"] == row["revision"] and head["status"] == row["status"]
             and head["last_audit_id"] == row["audit_id"] and head["updated_at"] == row["created_at"]
             and _time(row["created_at"]) <= current)
    return proof, history


def _payload(definition, period, revision):
    return {"schema_version": "market-price-collect-v1", "provider": "longport",
            "mapping_version_ids": definition["mapping_version_ids"], "calendar_version_ids": definition["calendar_version_ids"],
            "start_date": period, "end_date": period, "expected_publication_revision": revision, "publish": True}


def _current_references(connection, proof, current, *, require_current=True):
    expected = _json(proof["version"]["reference_binding_json"])
    try:
        original = reference_binding(connection, proof["schedule"]["portfolio_id"], proof["definition"], proof["version"]["created_at"])
        _require(original == expected)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError):
        raise WorkbenchError("PRICE_COLLECTION_REFERENCE_INVALID") from None
    actual = reference_binding(connection, proof["schedule"]["portfolio_id"], proof["definition"], current, require_current=require_current)
    _require({**actual, "known_at": expected["known_at"]} == expected)


def _session(connection, proof, period):
    binding = _json(proof["version"]["reference_binding_json"])
    closed = []
    for mapping in binding["mappings"]:
        row = connection.execute("SELECT document_json FROM market_reference_versions WHERE id=?", (mapping["calendar_version_id"],)).fetchone()
        days = _json(row["document_json"])["facts"]["days"]
        matches = [day for day in days if day["date"] == period]
        _require(len(matches) == 1)
        closed.append(matches[0]["kind"] == "closed")
    return "closed" if all(closed) else "mixed" if any(closed) else "open"


def price_collection_request_binding(connection, request):
    """Historical proof: a later pause never erases a previously lawful receipt."""
    try:
        with transaction(connection, immediate=False):
            request = dict(request)
            row = connection.execute("SELECT * FROM price_collection_schedule_slots WHERE command_request_id=?", (request["id"],)).fetchone()
            if row is None:
                _require(isinstance(request["actor_id"], str) and request["actor_id"].strip()
                         and request["actor_id"].lower() != "system" and not request["actor_id"].lower().startswith("system:"))
                return None
            slot = dict(row)
            stored = connection.execute("SELECT * FROM command_requests WHERE id=?", (request["id"],)).fetchone()
            schedule = connection.execute("SELECT * FROM price_collection_schedules WHERE id=?", (slot["schedule_id"],)).fetchone()
            _require(stored is not None and dict(stored) == request and schedule is not None)
            schedule = dict(schedule)
            history = _history(connection, schedule, slot["authorization_revision"] + 1)
            _require(1 <= slot["authorization_revision"] <= len(history))
            proof = history[slot["authorization_revision"] - 1]
            auth, version, definition = proof["authorization"], proof["version"], proof["definition"]
            due = scheduled_at(slot["period"], definition)
            deadline = due + timedelta(seconds=definition["deadline_seconds"])
            payload = _json(request["payload_json"])
            _require(request["command_type"] == "market_collect_prices" and request["actor_id"] == DISCOVERY_ACTOR
                     and request["idempotency_key"] == "price-collection:" + slot["id"]
                     and request["portfolio_id"] == schedule["portfolio_id"] == slot["portfolio_id"]
                     and slot["scope_key"] == schedule["scope_key"] and slot["schedule_version_id"] == auth["version_id"]
                     and slot["authorization_audit_id"] == auth["audit_id"] and auth["status"] == "enabled"
                     and slot["reference_binding_json"] == version["reference_binding_json"]
                     and slot["reference_binding_hash"] == version["reference_binding_hash"]
                     and slot["disposition"] == "requested" and slot["reason_code"] is None
                     and _integer(slot["expected_publication_revision"])
                     and slot["scheduled_at"] == stamp(due) and slot["deadline_at"] == stamp(deadline)
                     and definition["start_date"] <= slot["period"] <= definition["end_date"]
                     and _time(auth["created_at"]) <= due <= _time(slot["created_at"]) < deadline
                     and (auth["ended_at"] is None or _time(slot["created_at"]) < _time(auth["ended_at"]))
                     and request["created_at"] == slot["created_at"]
                     and payload == _payload(definition, slot["period"], slot["expected_publication_revision"])
                     and content_hash(payload) == request["payload_hash"] and _session(connection, proof, slot["period"]) == "open")
            _current_references(connection, proof, slot["created_at"], require_current=False)
            return {**proof, "slot": slot}
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError, UnicodeError):
        raise WorkbenchError("PRICE_COLLECTION_BINDING_INVALID") from None


def _assert_current(connection, request, job, lease, current, check_publication):
    assert_writable(connection)
    with transaction(connection, immediate=False):
        proof = price_collection_request_binding(connection, request)
        if proof is None:
            return None
        fresh = assert_lease(connection, lease, now=current)
        slot, auth, definition = proof["slot"], proof["authorization"], proof["definition"]
        _require(job["id"] == fresh["id"] and fresh["command_request_id"] == request["id"] == job["command_request_id"]
                 and fresh["scope"] == slot["portfolio_id"] == job["scope"]
                 and fresh["job_type"] == "market_collect_prices" == job["job_type"]
                 and fresh["period"] == slot["period"] == job["period"]
                 and fresh["input_version"] == request["id"] + ":" + request["payload_hash"] == job["input_version"]
                 and fresh["max_attempts"] == definition["max_attempts"] == job["max_attempts"])
        try:
            head, _ = _head(connection, proof["schedule"], current)
        except (ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError, UnicodeError):
            raise WorkbenchError("PRICE_COLLECTION_BINDING_INVALID") from None
        latest = head["authorization"]
        if latest["status"] != "enabled" or any(latest[key] != auth[key] for key in ("revision", "version_id", "audit_id")):
            raise WorkbenchError("PRICE_COLLECTION_AUTHORIZATION_ENDED")
        if current < _time(slot["scheduled_at"]):
            raise WorkbenchError("PRICE_COLLECTION_NOT_DUE")
        if current >= _time(slot["deadline_at"]):
            raise WorkbenchError("PRICE_COLLECTION_DEADLINE_EXPIRED")
        try:
            _current_references(connection, proof, current)
        except (ValueError, TypeError, KeyError, IndexError, AttributeError):
            raise WorkbenchError("PRICE_COLLECTION_REFERENCE_CHANGED") from None
        if check_publication:
            publication = connection.execute("SELECT revision FROM market_publications WHERE scope=?", (slot["scope_key"],)).fetchone()
            if (publication["revision"] if publication else 0) != slot["expected_publication_revision"]:
                raise WorkbenchError("STALE_PUBLICATION_REVISION")
        return proof


def assert_price_collection_authorized(connection, request, job, lease, *, now=None):
    return _assert_current(connection, request, job, lease, instant(now), True)


def assert_price_collection_finalization(connection, request, job, lease, *, now=None):
    return _assert_current(connection, request, job, lease, instant(now), False)


def _fill_slot(connection, proof, period, current):
    schedule, version, definition, auth = proof["schedule"], proof["version"], proof["definition"], proof["authorization"]
    if not definition["start_date"] <= period <= definition["end_date"]:
        return None
    due = scheduled_at(period, definition)
    ended = _time(auth["ended_at"]) if auth["ended_at"] else None
    if auth["status"] != "enabled" or due < _time(auth["created_at"]) or due > current or (ended is not None and due >= ended):
        return None
    if connection.execute("SELECT 1 FROM price_collection_schedule_slots WHERE scope_key=? AND period=?", (schedule["scope_key"], period)).fetchone():
        return None
    deadline = due + timedelta(seconds=definition["deadline_seconds"])
    disposition, reason = "requested", None
    if ended is not None and ended <= current and ended < deadline:
        disposition, reason = "missed", "AUTHORIZATION_ENDED"
    elif current >= deadline:
        disposition, reason = "missed", "DEADLINE_EXPIRED"
    else:
        try:
            _current_references(connection, proof, current)
            session = _session(connection, proof, period)
            if session == "closed":
                disposition, reason = "skipped", "MARKET_CLOSED"
            elif session == "mixed":
                disposition, reason = "blocked", "MIXED_CALENDAR_SESSION"
        except (ValueError, TypeError, KeyError, IndexError, AttributeError) as error:
            disposition, reason = "blocked", "REFERENCE_INVALID" if str(error) == "PRICE_COLLECTION_REFERENCE_INVALID" else "REFERENCE_CHANGED"
    slot_id, request_id, revision = new_id("price-slot"), None, None
    with transaction(connection):
        if disposition == "requested":
            request_id = new_id("request")
            head = connection.execute("SELECT revision FROM market_publications WHERE scope=?", (schedule["scope_key"],)).fetchone()
            revision = head["revision"] if head else 0
            payload = _payload(definition, period, revision)
            connection.execute("""INSERT INTO command_requests
                (id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at)
                VALUES(?,?,'market_collect_prices',?,?,?,?,?)""",
                               (request_id, schedule["portfolio_id"], "price-collection:" + slot_id,
                                content_hash(payload), canonical_json(payload), DISCOVERY_ACTOR, stamp(current)))
        connection.execute("""INSERT INTO price_collection_schedule_slots
            (id,portfolio_id,scope_key,period,schedule_id,schedule_version_id,authorization_audit_id,
             authorization_revision,scheduled_at,deadline_at,created_at,disposition,reason_code,
             command_request_id,expected_publication_revision,reference_binding_json,reference_binding_hash)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                           (slot_id, schedule["portfolio_id"], schedule["scope_key"], period, schedule["id"], version["id"],
                            auth["audit_id"], auth["revision"], stamp(due), stamp(deadline), stamp(current), disposition, reason,
                            request_id, revision, version["reference_binding_json"], version["reference_binding_hash"]))
    return slot_id


def _authorized_ranges(history, current):
    ranges = []
    for proof in history:
        auth, definition = proof["authorization"], proof["definition"]
        if auth["status"] != "enabled":
            continue
        zone = ZoneInfo(definition["timezone"])
        started = _time(auth["created_at"])
        ended = _time(auth["ended_at"]) if auth["ended_at"] else None
        first = max(definition["start_date"], (started.astimezone(zone).date() - timedelta(days=1)).isoformat())
        last = min(definition["end_date"], (current.astimezone(zone).date() - timedelta(days=1)).isoformat(),
                   (ended.astimezone(zone).date() - timedelta(days=1)).isoformat() if ended else "9999-12-31")
        if first > last:
            continue
        if scheduled_at(first, definition) < started:
            first = (_day(first) + timedelta(days=1)).isoformat()
        last_due = scheduled_at(last, definition)
        if last_due > current or (ended is not None and last_due >= ended):
            last = (_day(last) - timedelta(days=1)).isoformat()
        if first <= last:
            ranges.append({"revision": auth["revision"], "first": first, "last": last})
    return canonical_json(ranges)


def _first_missing_period(connection, scope, ranges):
    # Every gap starts at an interval boundary or immediately after a durable slot.
    # JSON keeps the bounded control history below SQLite's parameter/UNION limits.
    return connection.execute("""WITH authorized AS (
        SELECT json_extract(value,'$.revision') AS revision,
               json_extract(value,'$.first') AS first, json_extract(value,'$.last') AS last
        FROM json_each(?)
    ), candidates AS (
        SELECT revision, first AS period FROM authorized
        UNION ALL
        SELECT authorized.revision, date(slot.period,'+1 day') AS period
        FROM authorized JOIN price_collection_schedule_slots slot
          ON slot.scope_key=? AND slot.period>=authorized.first AND slot.period<authorized.last
    )
    SELECT revision, period FROM candidates
    WHERE NOT EXISTS (SELECT 1 FROM price_collection_schedule_slots present WHERE present.scope_key=? AND present.period=candidates.period)
    ORDER BY revision, period LIMIT 1""", (ranges, scope, scope)).fetchone()


def discover_due_price_collections(connection, *, limit=100, scan_limit=100, now=None, state=None):
    """Bound current windows and durable missed bookkeeping independently of restart hints."""
    if any(type(value) is not int or not 1 <= value <= 1000 for value in (limit, scan_limit)):
        raise WorkbenchError("INVALID_PRICE_COLLECTION_DISCOVERY_LIMIT")
    if state is not None and not isinstance(state, PriceCollectionDiscoveryState):
        raise WorkbenchError("INVALID_PRICE_COLLECTION_DISCOVERY_STATE")
    state = PriceCollectionDiscoveryState() if state is None else state
    next_state, current, created = PriceCollectionDiscoveryState(state.after_schedule_id), instant(now), []
    with transaction(connection):
        schedules = connection.execute("SELECT * FROM price_collection_schedules WHERE id>? ORDER BY id LIMIT ?",
                                       (state.after_schedule_id, scan_limit)).fetchall()
        if not schedules and state.after_schedule_id:
            schedules = connection.execute("SELECT * FROM price_collection_schedules ORDER BY id LIMIT ?", (scan_limit,)).fetchall()
        quota, histories = max(1, scan_limit // max(1, len(schedules))), []
        for row in schedules:
            if len(created) >= limit:
                break
            schedule = dict(row)
            next_state.after_schedule_id = schedule["id"]
            try:
                head, _ = _head(connection, schedule, current)
                histories.append(schedule)
                local_day = current.astimezone(ZoneInfo(head["definition"]["timezone"])).date()
                for offset in (2, 1):
                    if len(created) >= limit:
                        break
                    period = (local_day - timedelta(days=offset)).isoformat()
                    due = scheduled_at(period, head["definition"])
                    if due <= current < due + timedelta(seconds=head["definition"]["deadline_seconds"]):
                        identity = _fill_slot(connection, head, period, current)
                        if identity is not None:
                            created.append(identity)
            except (ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError, sqlite3.IntegrityError):
                enqueue_notification(connection, "price-schedule-invalid:" + schedule["id"], "price_collection_schedule.discovery_blocked",
                                     {"schedule_id": schedule["id"], "code": "PRICE_COLLECTION_SCHEDULE_INVALID"}, now=current)
        for schedule in histories:
            if len(created) >= limit:
                break
            history = _history(connection, schedule)
            next_state.after_schedule_id = schedule["id"]
            ranges = _authorized_ranges(history, current)
            for _ in range(quota):
                if len(created) >= limit:
                    break
                missing = _first_missing_period(connection, schedule["scope_key"], ranges)
                if missing is None:
                    break
                proof = history[missing["revision"] - 1]
                identity = _fill_slot(connection, proof, missing["period"], current)
                _require(identity is not None)
                created.append(identity)
    state.after_schedule_id = next_state.after_schedule_id
    return created
