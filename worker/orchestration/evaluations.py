"""Discover authorized monthly slots; financial evaluation stays in the Node publisher."""

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import sqlite3
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from worker.accounting.decimal_math import fact_decimal
from worker.market.contracts import validate_contract
from .db import WorkbenchError, canonical_json, content_hash, instant, new_id, stamp, transaction


DISCOVERY_ACTOR = "system:monthly-discovery"


@dataclass
class DiscoveryState:
    """Bounded scan hints only; durable cycle uniqueness survives losing these."""
    after_schedule_id: str = ""
    months: dict = field(default_factory=dict)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise WorkbenchError("EVALUATION_JSON_DUPLICATE_KEY")
        result[key] = value
    return result


def _json(value):
    return json.loads(value, object_pairs_hook=_unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(WorkbenchError("EVALUATION_JSON_INVALID")))


def _validate_definition(definition):
    validate_contract(definition, "evaluation-schedule.schema.json")
    try:
        ZoneInfo(definition["timezone"])
        if (definition["start_month"].startswith("0000-")
                or (definition["end_month"] is not None and definition["end_month"] < definition["start_month"])):
            raise ValueError("month range")
        targets = definition["targets"]
        identifiers = [definition[name] for name in ("policy_version_id", "strategy_version_id", "activation_id")]
        identifiers.extend(row[name] for row in targets["rows"] for name in ("account_id", "listing_id"))
        if any(not value.strip() or value != value.strip() for value in identifiers):
            raise ValueError("identifier")
        keys = [(row["account_id"], row["listing_id"]) for row in targets["rows"]]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate target")
        if fact_decimal(targets["absolute_tolerance_cny"]) < 0:
            raise ValueError("negative tolerance")
        for value in [targets["weight_tolerance"], *(row["weight"] for row in targets["rows"])]:
            if not 0 <= fact_decimal(value) <= 1:
                raise ValueError("weight")
    except (ValueError, ZoneInfoNotFoundError) as error:
        raise WorkbenchError("EVALUATION_SCHEDULE_INVALID") from error
    # JSON 3.0 is an integer under the shared schema and JavaScript; converting
    # calendar fields does not reserialize or change the raw definition hash.
    return {**definition, "trigger": {key: int(value) for key, value in definition["trigger"].items()},
            "max_attempts": int(definition["max_attempts"]), "deadline_seconds": int(definition["deadline_seconds"])}


def scheduled_instant(period, definition):
    """Reject nonexistent and ambiguous wall-clock triggers, including DST folds."""
    try:
        year, month = map(int, period.split("-"))
        trigger = definition["trigger"]
        zone = ZoneInfo(definition["timezone"])
        naive = datetime(year, month, trigger["day"], trigger["hour"], trigger["minute"])
        candidates = set()
        for fold in (0, 1):
            candidate = naive.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc)
            if candidate.astimezone(zone).replace(tzinfo=None) == naive:
                candidates.add(candidate)
        if len(candidates) != 1:
            raise WorkbenchError("EVALUATION_TRIGGER_NOT_UNIQUE")
        return next(iter(candidates))
    except (ValueError, KeyError, TypeError, ZoneInfoNotFoundError) as error:
        if isinstance(error, WorkbenchError):
            raise
        raise WorkbenchError("EVALUATION_TRIGGER_INVALID") from error


def _month(value):
    return f"{value.year:04d}-{value.month:02d}"


def _next_month(value):
    year, month = map(int, value.split("-"))
    return f"{year + (month == 12):04d}-{1 if month == 12 else month + 1:02d}"


def _authorized_definition(connection, row, current):
    raw = row["definition_json"]
    if sha256(raw.encode("utf8")).hexdigest() != row["content_hash"]:
        raise WorkbenchError("EVALUATION_SCHEDULE_HASH_MISMATCH")
    definition = _validate_definition(_json(raw))
    if (definition["policy_version_id"] != row["policy_version_id"]
            or definition["strategy_version_id"] != row["strategy_version_id"]
            or definition["environment"] != row["environment"]):
        raise WorkbenchError("EVALUATION_SCHEDULE_SCOPE_MISMATCH")
    audit = connection.execute("SELECT * FROM audit_events WHERE id=?", (row["last_audit_id"],)).fetchone()
    try:
        body = _json(audit["payload_json"]) if audit else {}
        command, result = body["input"], body["result"]
        if (audit["action"] != "set_evaluation_schedule_status" or audit["object_type"] != "evaluation_schedule"
                or audit["object_id"] != row["schedule_id"] or audit["portfolio_id"] != row["portfolio_id"]
                or not audit["actor_id"].strip() or body["actor_kind"] != "human"
                or instant(audit["created_at"]) != instant(row["updated_at"])
                or instant(audit["created_at"]) > current
                or command["portfolio_id"] != row["portfolio_id"] or command["schedule_id"] != row["schedule_id"]
                or command["status"] != "enabled" or result["status"] != "enabled"
                or result["schedule_id"] != row["schedule_id"] or result["version_id"] != row["current_version_id"]
                or result["schedule_revision"] != row["revision"]):
            raise ValueError("authorization")
    except (ValueError, TypeError, KeyError) as error:
        raise WorkbenchError("EVALUATION_ENABLE_EVIDENCE_INVALID") from error
    return definition, instant(audit["created_at"])


def _diagnostic(connection, row, code, current, period=None):
    from .jobs import enqueue_notification
    payload = {"schedule_id": row["schedule_id"], "schedule_version_id": row["current_version_id"],
               "period": period, "code": code}
    enqueue_notification(connection, "monthly-discovery:" + content_hash(payload),
                         "monthly_evaluation.discovery_blocked", payload, now=current)


def discover_due_cycles(connection, limit=100, now=None, state=None, scan_limit=100):
    """Atomically fill stable slots; enabling never backdates human authorization."""
    if (isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000
            or isinstance(scan_limit, bool) or not isinstance(scan_limit, int) or not 1 <= scan_limit <= 1000):
        raise WorkbenchError("INVALID_EVALUATION_DISCOVERY_LIMIT")
    state = DiscoveryState() if state is None else state
    next_state = DiscoveryState(state.after_schedule_id, dict(state.months))
    current, created = instant(now), stamp(now)
    cycles = []
    with transaction(connection):
        query = """SELECT h.*,s.portfolio_id,s.environment,s.strategy_key,s.scope_key,
            v.policy_version_id,v.strategy_version_id,v.definition_json,v.content_hash
            FROM evaluation_schedule_heads h JOIN evaluation_schedules s ON s.id=h.schedule_id
            JOIN evaluation_schedule_versions v ON v.id=h.current_version_id AND v.schedule_id=s.id
            WHERE h.status='enabled' AND s.id>? ORDER BY s.id LIMIT ?"""
        rows = connection.execute(query, (state.after_schedule_id, scan_limit)).fetchall()
        if not rows and state.after_schedule_id:
            rows = connection.execute(query, ("", scan_limit)).fetchall()
        quota = max(1, scan_limit // max(1, len(rows)))
        for row in rows:
            if len(cycles) >= limit:
                break
            next_state.after_schedule_id = row["schedule_id"]
            try:
                definition, approved_at = _authorized_definition(connection, row, current)
            except (ValueError, TypeError, KeyError):
                _diagnostic(connection, row, "EVALUATION_SCHEDULE_AUTHORIZATION_INVALID", current)
                continue
            zone = ZoneInfo(definition["timezone"])
            base = max(definition["start_month"], _month(approved_at.astimezone(zone)))
            key = (row["schedule_id"], row["current_version_id"], row["revision"])
            period = max(base, next_state.months.get(key, base))
            last = min(definition["end_month"] or "9999-12", _month(current.astimezone(zone)))
            for _ in range(quota):
                if period > last or len(cycles) >= limit:
                    break
                try:
                    due = scheduled_instant(period, definition)
                except WorkbenchError:
                    _diagnostic(connection, row, "EVALUATION_TRIGGER_NOT_UNIQUE", current, period)
                    period = _next_month(period)
                    next_state.months[key] = period
                    continue
                if due > current:
                    break
                if approved_at <= due <= current:
                    existing = connection.execute("""SELECT id FROM evaluation_cycles
                        WHERE portfolio_id=? AND environment=? AND strategy_key=? AND scope_key=? AND period=?""",
                                                  (row["portfolio_id"], row["environment"], row["strategy_key"],
                                                   row["scope_key"], period)).fetchone()
                    if existing is None:
                        cycle_id, request_id = new_id("cycle"), new_id("request")
                        scheduled = stamp(due)
                        deadline = stamp(due + timedelta(seconds=definition["deadline_seconds"]))
                        try:
                            with transaction(connection):
                                connection.execute("""INSERT INTO evaluation_cycles
                            (id,portfolio_id,strategy_version_id,policy_version_id,scope,period,status,
                             schedule_version_id,environment,strategy_key,scope_key,scheduled_at,cutoff_at,
                             knowledge_at,deadline_at,created_at,state_revision)
                            VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,1)""",
                                                   (cycle_id, row["portfolio_id"], row["strategy_version_id"], row["policy_version_id"],
                                            "actual:portfolio", period, row["current_version_id"], row["environment"],
                                            row["strategy_key"], row["scope_key"], scheduled, scheduled, scheduled,
                                            deadline, created))
                                payload = {"cycle_id": cycle_id}
                                connection.execute("""INSERT INTO command_requests
                            (id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at)
                            VALUES(?,?,'monthly_evaluation',?,?,?,?,?)""",
                                                   (request_id, row["portfolio_id"], "monthly:" + cycle_id + ":1",
                                            content_hash(payload), canonical_json(payload), DISCOVERY_ACTOR, created))
                                connection.execute("""INSERT INTO evaluation_cycle_requests
                            (command_request_id,cycle_id,generation,requested_by,reason,created_at)
                            VALUES(?,?,1,?,?,?)""",
                                                   (request_id, cycle_id, DISCOVERY_ACTOR, "Authorized monthly trigger", created))
                            cycles.append(cycle_id)
                        except sqlite3.IntegrityError:
                            _diagnostic(connection, row, "EVALUATION_DISCOVERY_STORAGE_CONFLICT", current, period)
                            break
                if period == "9999-12":
                    break
                period = _next_month(period)
                next_state.months[key] = period
        if len(next_state.months) > 1000:
            next_state.months = {key: value for key, value in next_state.months.items()
                                 if key[0] in {row["schedule_id"] for row in rows}}
    state.after_schedule_id, state.months = next_state.after_schedule_id, next_state.months
    return cycles


def monthly_request_binding(connection, request):
    payload = _json(request["payload_json"])
    if (not isinstance(payload, dict) or set(payload) != {"cycle_id"}
            or not isinstance(payload["cycle_id"], str)
            or content_hash(payload) != request["payload_hash"]):
        raise WorkbenchError("INVALID_MONTHLY_EVALUATION_COMMAND")
    row = connection.execute("""SELECT c.*,r.generation,r.requested_by,v.definition_json,v.content_hash
        FROM evaluation_cycle_requests r JOIN evaluation_cycles c ON c.id=r.cycle_id
        JOIN evaluation_schedule_versions v ON v.id=c.schedule_version_id
        WHERE r.command_request_id=? AND r.cycle_id=?""", (request["id"], payload["cycle_id"])).fetchone()
    if (row is None or row["portfolio_id"] != request["portfolio_id"]
            or row["requested_by"] != request["actor_id"]):
        raise WorkbenchError("MONTHLY_EVALUATION_REQUEST_OUT_OF_SCOPE")
    if sha256(row["definition_json"].encode("utf8")).hexdigest() != row["content_hash"]:
        raise WorkbenchError("EVALUATION_SCHEDULE_HASH_MISMATCH")
    definition = _validate_definition(_json(row["definition_json"]))
    return row, definition


def _job_cycle(connection, job_id):
    return connection.execute("""SELECT c.*,j.status AS job_status,j.attempt_count,j.max_attempts,r.generation,
        j.updated_at AS job_updated_at FROM job_runs j
        JOIN evaluation_cycle_requests r ON r.command_request_id=j.command_request_id
        JOIN evaluation_cycles c ON c.id=r.cycle_id
        WHERE j.id=? AND j.job_type='monthly_evaluation'
        AND r.generation=(SELECT MAX(n.generation) FROM evaluation_cycle_requests n WHERE n.cycle_id=c.id)""",
                              (job_id,)).fetchone()


def start_cycle(connection, job_id, now=None):
    row = _job_cycle(connection, job_id)
    if row is None or row["job_status"] != "running" or row["status"] not in ("pending", "running"):
        raise WorkbenchError("EVALUATION_CYCLE_NOT_CLAIMABLE")
    if row["status"] == "pending":
        connection.execute("UPDATE evaluation_cycles SET status='running',state_revision=state_revision+1 WHERE id=?",
                           (row["id"],))


def fail_exhausted_cycle(connection, job_id, now=None):
    row = _job_cycle(connection, job_id)
    if row is None or row["job_status"] != "failed" or row["status"] not in ("pending", "running"):
        raise WorkbenchError("EVALUATION_CYCLE_FAILURE_NOT_AUTHORIZED")
    connection.execute("""UPDATE evaluation_cycles SET status='failed',outcome=NULL,completed_at=?,
        terminal_attempt_id=NULL,state_revision=state_revision+1 WHERE id=?""", (stamp(now), row["id"]))
