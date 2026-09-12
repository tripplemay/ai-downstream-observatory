"""Discover authorized ECB polling slots without backdating provider knowledge."""

from copy import deepcopy
from bisect import bisect_left
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
import json
import re
import sqlite3

from worker.market.contracts import validate_contract
from .db import (WorkbenchError, assert_writable, canonical_json, content_hash,
                 instant, new_id, stamp, transaction)
from .jobs import assert_lease, enqueue_notification


DISCOVERY_ACTOR = "system:collection-discovery"
MAX_CONTROL_HISTORY = 1024
COLLECTION_TERMINAL_CODES = frozenset({
    "COLLECTION_BINDING_INVALID", "COLLECTION_AUTHORIZATION_ENDED", "COLLECTION_NOT_DUE",
    "COLLECTION_DEADLINE_EXPIRED", "STALE_PUBLICATION_REVISION",
})
_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_JS_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


@dataclass
class CollectionDiscoveryState:
    """Disposable bounded-scan cursors. Slots and requests, never these hints, are durable."""

    after_schedule_id: str = ""
    history: dict = field(default_factory=dict)


def _fail():
    raise WorkbenchError("COLLECTION_BINDING_INVALID")


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            _fail()
        value[key] = item
    return value


def _json(raw):
    return json.loads(raw, object_pairs_hook=_object, parse_constant=lambda _: _fail())


def _time(value):
    if not isinstance(value, str) or not _UTC.fullmatch(value):
        _fail()
    return instant(value)


def _day(value):
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        _fail()
    return date.fromisoformat(value)


def _definition(raw, digest):
    if not isinstance(raw, str) or not 1 <= len(raw.encode("utf8")) <= 65536:
        _fail()
    if sha256(raw.encode("utf8")).hexdigest() != digest:
        _fail()
    value = _json(raw)
    validate_contract(value, "collection-schedule.schema.json")
    start = _day(value["start_date"])
    end = None if value["end_date"] is None else _day(value["end_date"])
    if end is not None and end < start:
        _fail()
    return {**value, "trigger": {key: int(item) for key, item in value["trigger"].items()},
            "deadline_seconds": int(value["deadline_seconds"]), "max_attempts": int(value["max_attempts"])}


def _scope(definition):
    return "provider:ecb:fx:daily:" + "-".join(sorted(definition["currencies"]))


def _payload(definition, revision):
    return {"provider": "ecb", "feed": "daily", "currencies": definition["currencies"],
            "expected_publication_revision": revision, "publish": True}


def _due(period, definition):
    day = _day(period)
    return datetime(day.year, day.month, day.day, definition["trigger"]["hour"],
                    definition["trigger"]["minute"], tzinfo=timezone.utc)


def _string(value, maximum=None, nonblank=False):
    # Zod string limits count UTF-16 units; JS trim differs from Python strip.
    return (isinstance(value, str)
            and (maximum is None or 1 <= len(value.encode("utf-16-le", errors="surrogatepass")) // 2 <= maximum)
            and (not nonblank or bool(value.strip(_JS_WHITESPACE))))


def _integer(value, minimum=0, maximum=9007199254740991):
    return type(value) in (int, float) and minimum <= value <= maximum and int(value) == value


def _identifier(value):
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _audit(connection, identity, schedule):
    row = connection.execute("SELECT * FROM audit_events WHERE id=?", (identity,)).fetchone()
    if row is None:
        _fail()
    audit = dict(row)
    body = _json(audit["payload_json"])
    if (audit["object_type"] != "collection_schedule" or audit["object_id"] != schedule["id"]
            or audit["portfolio_id"] != schedule["portfolio_id"] or audit["ledger_revision"] is not None
            or not _string(audit["actor_id"], nonblank=True) or audit["actor_id"].startswith("system:")
            or not isinstance(body, dict) or set(body) != {"actor_kind", "input", "result"}
            or body.get("actor_kind") != "human" or not isinstance(body.get("input"), dict)
            or not isinstance(body.get("result"), dict)):
        _fail()
    command, result = body["input"], body["result"]
    base = {"portfolio_id", "idempotency_key", "reason", "acknowledgement", "expected_schedule_revision"}
    if audit["action"] == "save_collection_schedule":
        if (set(command) != base | {"expected_schedule_id", "definition_json"}
                or (command["expected_schedule_id"] is not None and not _identifier(command["expected_schedule_id"]))
                or not _string(command["definition_json"], 65536)
                or len(command["definition_json"].encode("utf8")) > 65536
                or not _integer(command["expected_schedule_revision"])):
            _fail()
    elif audit["action"] == "set_collection_schedule_status":
        if (set(command) != base | {"schedule_id", "status"} or not _identifier(command["schedule_id"])
                or command["status"] not in ("enabled", "paused") or not _integer(command["expected_schedule_revision"], 1)):
            _fail()
    else:
        _fail()
    if (command.get("portfolio_id") != schedule["portfolio_id"] or command.get("acknowledgement") is not True
            or not _identifier(command["portfolio_id"]) or not _identifier(command["idempotency_key"])
            or not _string(command["reason"], 2000, nonblank=True)
            or set(result) != {"schedule_id", "version_id", "version", "schedule_revision", "status", "scope_key", "content_hash"}
            or not _integer(result["version"], 1) or not _integer(result["schedule_revision"], 1)):
        _fail()
    _time(audit["created_at"])
    return audit, body


def _version(connection, schedule, identity):
    row = connection.execute("SELECT * FROM collection_schedule_versions WHERE id=?", (identity,)).fetchone()
    if row is None:
        _fail()
    version = dict(row)
    definition = _definition(version["definition_json"], version["content_hash"])
    if (version["schedule_id"] != schedule["id"] or schedule["provider"] != "ecb"
            or schedule["scope_key"] != _scope(definition) or not _integer(version["version"], 1, 1023)
            or _time(version["created_at"]) < _time(schedule["created_at"])):
        _fail()
    audit, body = _audit(connection, version["audit_id"], schedule)
    command, result = body["input"], body["result"]
    if (audit["action"] != "save_collection_schedule" or audit["actor_id"] != version["created_by"]
            or audit["created_at"] != version["created_at"]
            or command.get("definition_json") != version["definition_json"]
            or command.get("expected_schedule_id") != (None if version["version"] == 1 else schedule["id"])
            or result != {"schedule_id": schedule["id"], "version_id": version["id"],
                          "version": version["version"], "schedule_revision": command.get("expected_schedule_revision", -1) + 1,
                          "status": "paused", "scope_key": schedule["scope_key"], "content_hash": version["content_hash"]}):
        _fail()
    if version["version"] == 1 and (command["expected_schedule_revision"] != 0
            or version["created_at"] != schedule["created_at"] or version["created_by"] != schedule["created_by"]):
        _fail()
    return version, definition


def _control(connection, schedule, row):
    control = dict(row)
    if control["schedule_id"] != schedule["id"] or not _integer(control["revision"], 1, 1024):
        _fail()
    version, definition = _version(connection, schedule, control["version_id"])
    audit, body = _audit(connection, control["audit_id"], schedule)
    command, result = body["input"], body["result"]
    if (audit["created_at"] != control["created_at"]
            or _time(control["created_at"]) < _time(version["created_at"])
            or command.get("expected_schedule_revision") != control["revision"] - 1
            or result != {"schedule_id": schedule["id"], "version_id": version["id"],
                          "version": version["version"], "schedule_revision": control["revision"],
                          "status": control["status"], "scope_key": schedule["scope_key"],
                          "content_hash": version["content_hash"]}):
        _fail()
    previous = connection.execute("SELECT * FROM collection_schedule_controls WHERE schedule_id=? AND revision=?",
                                  (schedule["id"], control["revision"] - 1)).fetchone()
    if control["revision"] > 1 and (previous is None or _time(previous["created_at"]) > _time(control["created_at"])):
        _fail()
    if audit["action"] == "save_collection_schedule":
        if control["status"] != "paused" or control["audit_id"] != version["audit_id"]:
            _fail()
    elif audit["action"] == "set_collection_schedule_status":
        if (previous is None or command.get("schedule_id") != schedule["id"]
                or command.get("status") != control["status"] or control["status"] not in ("enabled", "paused")
                or previous["version_id"] != version["id"]):
            _fail()
    else:
        _fail()
    if control["revision"] == 1024 and (audit["action"] != "set_collection_schedule_status"
            or previous is None or previous["status"] != "enabled" or control["status"] != "paused"):
        _fail()
    return {"schedule": schedule, "version": version, "definition": definition, "authorization": control}


def _history(connection, schedule, through=None):
    rows = connection.execute("""SELECT * FROM collection_schedule_controls WHERE schedule_id=?
        AND revision<=? ORDER BY revision LIMIT ?""",
                              (schedule["id"], through or 9007199254740991, MAX_CONTROL_HISTORY + 1)).fetchall()
    if len(rows) > MAX_CONTROL_HISTORY:
        raise WorkbenchError("COLLECTION_CONTROL_HISTORY_LIMIT")
    proofs, version_number = [], 0
    for expected, row in enumerate(rows, 1):
        if row["revision"] != expected:
            _fail()
        proof = _control(connection, schedule, row)
        version = proof["version"]
        if row["audit_id"] == version["audit_id"]:
            if version["version"] != version_number + 1:
                _fail()
            version_number += 1
        elif version["version"] != version_number:
            _fail()
        proof["authorization"] = {**proof["authorization"],
                                  "ended_at": rows[expected]["created_at"] if expected < len(rows) else None}
        proofs.append(proof)
    if not proofs:
        _fail()
    return proofs


def _interval(connection, schedule, row):
    # Only the original prefix and its closing control are relevant to a historical receipt.
    proofs = _history(connection, schedule, row["revision"] + 1)
    if len(proofs) < row["revision"]:
        _fail()
    return proofs[row["revision"] - 1]


def _head(connection, schedule, current):
    head = connection.execute("SELECT * FROM collection_schedule_heads WHERE schedule_id=?", (schedule["id"],)).fetchone()
    if head is None:
        _fail()
    history = _history(connection, schedule)
    proof = history[-1]
    row = proof["authorization"]
    if (head["scope_key"] != schedule["scope_key"] or head["current_version_id"] != row["version_id"]
            or head["revision"] != row["revision"] or head["status"] != row["status"]
            or head["last_audit_id"] != row["audit_id"] or head["updated_at"] != row["created_at"]
            or _time(row["created_at"]) > current):
        _fail()
    return {**proof, "history": history}


def _request_binding(connection, request):
    request = dict(request)
    row = connection.execute("SELECT * FROM collection_schedule_slots WHERE command_request_id=?", (request["id"],)).fetchone()
    if row is None:
        if not isinstance(request["actor_id"], str) or request["actor_id"].startswith("system:"):
            _fail()
        return None
    slot = dict(row)
    stored = connection.execute("SELECT * FROM command_requests WHERE id=?", (request["id"],)).fetchone()
    if stored is None or dict(stored) != request:
        _fail()
    schedule = connection.execute("SELECT * FROM collection_schedules WHERE id=?", (slot["schedule_id"],)).fetchone()
    control = connection.execute("SELECT * FROM collection_schedule_controls WHERE schedule_id=? AND revision=?",
                                 (slot["schedule_id"], slot["authorization_revision"])).fetchone()
    if schedule is None or control is None:
        _fail()
    proof = _interval(connection, dict(schedule), control)
    auth, definition = proof["authorization"], proof["definition"]
    due = _due(slot["period"], definition)
    deadline = due + timedelta(seconds=definition["deadline_seconds"])
    payload = _json(request["payload_json"])
    if (request["command_type"] != "market_collect" or request["actor_id"] != DISCOVERY_ACTOR
            or request["portfolio_id"] != schedule["portfolio_id"] or slot["portfolio_id"] != schedule["portfolio_id"]
            or slot["scope_key"] != schedule["scope_key"] or slot["schedule_version_id"] != auth["version_id"]
            or slot["authorization_audit_id"] != auth["audit_id"] or auth["status"] != "enabled"
            or slot["disposition"] != "requested" or slot["reason_code"] is not None
            or slot["expected_publication_revision"] is None
            or slot["expected_publication_revision"] < 0
            or slot["scheduled_at"] != stamp(due) or slot["deadline_at"] != stamp(deadline)
            or not definition["start_date"] <= slot["period"] <= (definition["end_date"] or "9999-12-31")
            or _time(auth["created_at"]) > due
            or not due <= _time(slot["created_at"]) < deadline
            or (auth["ended_at"] is not None and _time(slot["created_at"]) >= _time(auth["ended_at"]))
            or request["created_at"] != slot["created_at"]
            or payload != _payload(definition, slot["expected_publication_revision"])
            or content_hash(payload) != request["payload_hash"]):
        _fail()
    return {"slot": slot, "definition": definition, "schedule": dict(schedule), "authorization": auth}


def collection_request_binding(connection, request):
    """Validate historical authorization only; later pauses do not erase lawful captures."""
    try:
        with transaction(connection, immediate=False):
            return _request_binding(connection, request)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError):
        raise WorkbenchError("COLLECTION_BINDING_INVALID") from None


def _assert_current(connection, request, job, lease, current, check_publication):
    assert_writable(connection)
    with transaction(connection, immediate=False):
        binding = collection_request_binding(connection, request)
        if binding is None:
            return None
        fresh = assert_lease(connection, lease, now=current)
        slot, auth, definition = binding["slot"], binding["authorization"], binding["definition"]
        if (job["id"] != fresh["id"] or fresh["command_request_id"] != request["id"]
                or job["command_request_id"] != request["id"] or fresh["scope"] != slot["portfolio_id"]
                or job["scope"] != fresh["scope"]
                or fresh["job_type"] != "market_collect" or job["job_type"] != "market_collect"
                or fresh["period"] != slot["period"] or job["period"] != fresh["period"]
                or fresh["input_version"] != request["id"] + ":" + request["payload_hash"]
                or job["input_version"] != fresh["input_version"]
                or fresh["max_attempts"] != definition["max_attempts"] or job["max_attempts"] != fresh["max_attempts"]):
            _fail()
        try:
            head = _head(connection, binding["schedule"], current)["authorization"]
        except (ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError):
            raise WorkbenchError("COLLECTION_BINDING_INVALID") from None
        if (head["status"] != "enabled" or head["revision"] != auth["revision"]
                or head["version_id"] != auth["version_id"] or head["audit_id"] != auth["audit_id"]):
            raise WorkbenchError("COLLECTION_AUTHORIZATION_ENDED")
        if current < _time(slot["scheduled_at"]):
            raise WorkbenchError("COLLECTION_NOT_DUE")
        if current >= _time(slot["deadline_at"]):
            raise WorkbenchError("COLLECTION_DEADLINE_EXPIRED")
        if check_publication:
            publication = connection.execute("SELECT revision FROM market_publications WHERE scope=?",
                                             (slot["scope_key"],)).fetchone()
            if (publication["revision"] if publication else 0) != slot["expected_publication_revision"]:
                raise WorkbenchError("STALE_PUBLICATION_REVISION")
        return binding


def assert_collection_authorized(connection, request, job, lease, *, now=None):
    """Recheck inside the fenced publication transaction as well as before network work."""
    return _assert_current(connection, request, job, lease, instant(now), True)


def assert_collection_finalization(connection, request, job, lease, *, now=None):
    """Recheck the deadline at job completion, after the atomic publication advanced its CAS."""
    return _assert_current(connection, request, job, lease, instant(now), False)


def _diagnostic(connection, schedule, current, code, period=None, revision=None):
    payload = {"schedule_id": schedule["id"], "scope_key": schedule["scope_key"],
               "period": period, "authorization_revision": revision, "code": code}
    enqueue_notification(connection, "collection-discovery:" + content_hash(payload),
                         "market_collection.discovery_blocked", payload, now=current)


def _fill_slot(connection, proof, period, current):
    schedule, definition, auth = proof["schedule"], proof["definition"], proof["authorization"]
    if not definition["start_date"] <= period <= (definition["end_date"] or "9999-12-31"):
        return None
    due = _due(period, definition)
    ended = None if auth["ended_at"] is None else _time(auth["ended_at"])
    if auth["status"] != "enabled" or due < _time(auth["created_at"]) or due > current or (ended is not None and due >= ended):
        return None
    # A slot owned by another portfolio is only an exclusion, never evidence we reuse or return.
    if connection.execute("SELECT 1 FROM collection_schedule_slots WHERE scope_key=? AND period=?",
                          (schedule["scope_key"], period)).fetchone():
        return None
    deadline = due + timedelta(seconds=definition["deadline_seconds"])
    reason = None
    if ended is not None and ended <= current and ended < deadline:
        reason = "AUTHORIZATION_ENDED"
    elif current >= deadline:
        reason = "DEADLINE_EXPIRED"
    disposition = "missed" if reason else "requested"
    slot_id = new_id("collection-slot")
    request_id, revision = None, None
    with transaction(connection):
        if disposition == "requested":
            request_id = new_id("request")
            head = connection.execute("SELECT revision FROM market_publications WHERE scope=?",
                                      (schedule["scope_key"],)).fetchone()
            revision = head["revision"] if head else 0
            payload = _payload(definition, revision)
            connection.execute("""INSERT INTO command_requests
                (id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at)
                VALUES(?,?,'market_collect',?,?,?,?,?)""",
                               (request_id, schedule["portfolio_id"], "collection:" + slot_id,
                                content_hash(payload), canonical_json(payload), DISCOVERY_ACTOR, stamp(current)))
        connection.execute("""INSERT INTO collection_schedule_slots
            (id,portfolio_id,scope_key,period,schedule_id,schedule_version_id,authorization_audit_id,
             authorization_revision,scheduled_at,deadline_at,created_at,disposition,reason_code,
             command_request_id,expected_publication_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                           (slot_id, schedule["portfolio_id"], schedule["scope_key"], period, schedule["id"],
                            auth["version_id"], auth["audit_id"], auth["revision"], stamp(due), stamp(deadline),
                            stamp(current), disposition, reason, request_id, revision))
        if disposition == "missed":
            enqueue_notification(connection, "collection-missed:" + slot_id, "market_collection.missed",
                                 {"slot_id": slot_id, "period": period, "reason_code": reason}, now=current)
    return slot_id


def discover_due_collections(connection, *, limit=100, scan_limit=100, now=None, state=None):
    """Current windows first, then bounded historical controls; never backfill network observations."""
    if any(type(value) is not int or not 1 <= value <= 1000 for value in (limit, scan_limit)):
        raise WorkbenchError("INVALID_COLLECTION_DISCOVERY_LIMIT")
    if state is not None and not isinstance(state, CollectionDiscoveryState):
        raise WorkbenchError("INVALID_COLLECTION_DISCOVERY_STATE")
    state = CollectionDiscoveryState() if state is None else state
    next_state = deepcopy(state)
    current, created = instant(now), []
    with transaction(connection):
        query = "SELECT * FROM collection_schedules WHERE id>? ORDER BY id LIMIT ?"
        schedules = connection.execute(query, (state.after_schedule_id, scan_limit)).fetchall()
        if not schedules and state.after_schedule_id:
            schedules = connection.execute(query, ("", scan_limit)).fetchall()
        quota = max(1, scan_limit // max(1, len(schedules)))
        histories = []
        # Across scopes, current network windows take precedence over old missed bookkeeping.
        for row in schedules:
            if len(created) >= limit:
                break
            schedule = dict(row)
            next_state.after_schedule_id = schedule["id"]
            try:
                head = _head(connection, schedule, current)
                histories.append(schedule)
                if head["authorization"]["status"] == "enabled":
                    for day in (current.date() - timedelta(days=1), current.date()):
                        if len(created) >= limit:
                            break
                        due = _due(day.isoformat(), head["definition"])
                        if not due <= current < due + timedelta(seconds=head["definition"]["deadline_seconds"]):
                            continue
                        identity = _fill_slot(connection, head, day.isoformat(), current)
                        if identity is not None:
                            created.append(identity)
            except (ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError, sqlite3.IntegrityError) as error:
                code = "COLLECTION_CONTROL_HISTORY_LIMIT" if str(error) == "COLLECTION_CONTROL_HISTORY_LIMIT" else "COLLECTION_SCHEDULE_INVALID"
                _diagnostic(connection, schedule, current, code)
        for schedule in histories:
            if len(created) >= limit:
                break
            next_state.after_schedule_id = schedule["id"]
            try:
                # Do not retain every schedule's potentially large version history in memory.
                history = _history(connection, schedule)
                enabled = [proof for proof in history if proof["authorization"]["status"] == "enabled"]
                revisions = [proof["authorization"]["revision"] for proof in enabled]
                cursor = next_state.history.setdefault(schedule["id"], {"revision": 1, "period": None})
                for _ in range(quota):
                    if len(created) >= limit:
                        break
                    index = bisect_left(revisions, cursor["revision"])
                    if index == len(enabled):
                        break
                    proof = enabled[index]
                    auth, definition = proof["authorization"], proof["definition"]
                    base = max(definition["start_date"], _time(auth["created_at"]).date().isoformat())
                    period = max(base, cursor["period"] or base) if cursor["revision"] == auth["revision"] else base
                    cursor.update(revision=auth["revision"], period=period)
                    last = min(definition["end_date"] or "9999-12-31", current.date().isoformat(),
                               _time(auth["ended_at"]).date().isoformat() if auth["ended_at"] else "9999-12-31")
                    if period > last:
                        if auth["ended_at"] is None:
                            break
                        cursor.update(revision=auth["revision"] + 1, period=None)
                        continue
                    if _due(period, definition) > current:
                        break
                    identity = _fill_slot(connection, proof, period, current)
                    if identity is not None:
                        created.append(identity)
                    if period == "9999-12-31":
                        cursor.update(revision=auth["revision"] + 1, period=None)
                    else:
                        cursor["period"] = (_day(period) + timedelta(days=1)).isoformat()
            except (ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError, sqlite3.IntegrityError):
                _diagnostic(connection, schedule, current, "COLLECTION_SCHEDULE_INVALID")
        if len(next_state.history) > 1000:
            next_state.history = {key: value for key, value in next_state.history.items()
                                  if key in {row["id"] for row in schedules}}
    state.after_schedule_id, state.history = next_state.after_schedule_id, next_state.history
    return created
