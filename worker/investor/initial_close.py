"""First confirmed close from the selected reference; no synthetic monitor seed."""

from datetime import timedelta
from math import ceil
import sqlite3
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.market.providers import longport, longport_confirmed as receiver
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, stamp, transaction
from worker.orchestration.jobs import JobCommit, enqueue_job, enqueue_notification
from . import confirmed_capture, confirmed_feed, initial_prices
from .data_evidence import _assert, _audit, _audit_binding, _fact_validation_scope, _object, _owner, resolve_review
from .model_runtime import _clock

JOB_TYPE = "investor_initial_close"
ENGINE = "investor-initial-close-producer-v1"
SCHEMA = "investor-initial-close.schema.json"


def session_reserved(db, model, market, day):
    return any(db.execute("SELECT 1 FROM " + table + " WHERE model_id=? AND market=? AND session_date=? LIMIT 1",
        (model, market, day)).fetchone() is not None for table in
        ("investor_initial_close_requests", "investor_confirmed_feed_requests", "investor_initial_price_requests"))


def market_plan(db, workspace, context, market, day, at):
    model, definition, control, source, authorities = context
    local_day = instant(at).astimezone(ZoneInfo(longport._MARKETS[market][0])).date().isoformat()
    _assert(day == local_day, "INITIAL_CLOSE_NOT_CURRENT_SESSION")
    selected = [row for row in definition["targets"] if row["market"] == market]
    _assert(selected)
    targets = [{**authorities[row["listing_id"]], "session_date": day} for row in selected]
    sessions = []
    for target in targets:
        calendar = resolve_review(db, workspace, target["calendar_review_id"], "calendar", now=at)["facts"]
        _assert(calendar["market"] == market and calendar["range_start"] <= day <= calendar["range_end"], "INITIAL_CLOSE_CALENDAR_GAP")
        session = next((row for row in calendar["days"] if row["date"] == day), None)
        _assert(session is not None, "INITIAL_CLOSE_CALENDAR_GAP")
        sessions.append(session)
    if all(row["kind"] == "closed" for row in sessions): return None
    _assert(all(row["kind"] != "closed" for row in sessions), "INITIAL_CLOSE_CALENDAR_CONFLICT")
    bindings, reviews = confirmed_capture._bindings(db, workspace, targets, at)
    expected = {row["listing_id"]: row for row in selected}
    _assert({row["target"]["mapping"]["listing_id"] for row in bindings} == set(expected))
    for row in bindings:
        asset = row["target"]["mapping"]; target = expected[asset["listing_id"]]
        _assert(all(asset[key] == target[key] for key in ("market", "currency")))
    _assert(len({(row["target"]["close_at"], row["target"]["available_at"]) for row in bindings}) == 1, "INITIAL_CLOSE_CALENDAR_CONFLICT")
    close, available = (instant(bindings[0]["target"][key]) for key in ("close_at", "available_at"))
    start, latest, stop = close - timedelta(seconds=confirmed_feed.LEAD_SECONDS), close - timedelta(seconds=receiver.STARTUP_SECONDS), available + timedelta(seconds=confirmed_feed.TAIL_SECONDS)
    _assert(1 <= ceil((stop - start).total_seconds()) <= receiver.MAX_WATCH_SECONDS)
    expiry = min([instant(definition["valid_until"]), instant(source["document"]["valid_until"])] +
        [instant(value[kind]["review"]["valid_until"]) for value in reviews for kind in ("rights", "listing", "calendar")] +
        [instant(value["rights"]["facts"]["valid_until"]) for value in reviews])
    _assert(stop + timedelta(seconds=receiver.STARTUP_SECONDS) < expiry, "INITIAL_CLOSE_WINDOW_INVALID")
    value = {"schema_version": "investor-initial-close-request-v1", "engine_version": ENGINE, "workspace_id": workspace,
        "model_id": model["id"], "model_hash": model["content_hash"], "control_id": control["id"],
        "reference_input_id": source["row"]["id"], "reference_input_hash": source["row"]["content_hash"],
        "market": market, "session_date": day, "targets": sorted(targets, key=lambda row: row["listing_review_id"]),
        "binding_hash": content_hash(bindings), "not_before": stamp(start), "latest_start": stamp(latest), "stop_at": stamp(stop),
        "valid_until": stamp(expiry), "live_advice_eligible": False}
    validate_contract(value, SCHEMA, fragment="$defs/request")
    return value


def discover_initial_closes(db, *, limit=100, now=None, stop_requested=None):
    _assert(type(limit) is int and 1 <= limit <= 1000); at = _clock(now)
    _assert(not db.in_transaction, "INITIAL_CLOSE_DISCOVERY_REQUIRES_AUTOCOMMIT"); assert_writable(db)
    _assert(db.execute("PRAGMA query_only").fetchone()[0] == 0, "WORKBENCH_READ_ONLY")
    models = db.execute("""SELECT m.* FROM investor_models m JOIN investor_model_controls c ON c.model_id=m.id AND c.workspace_id=m.workspace_id
      WHERE c.version=(SELECT max(version) FROM investor_model_controls WHERE model_id=m.id) AND c.enabled=1 AND c.created_at<=?
      AND json_extract(m.document_json,'$.data_mode')='reconstructed' AND json_extract(m.document_json,'$.valid_until')>?
      AND m.profile_id=(SELECT id FROM investor_profiles WHERE workspace_id=m.workspace_id ORDER BY version DESC LIMIT 1)
      AND m.plan_id=(SELECT plan_id FROM investor_plan_selections WHERE workspace_id=m.workspace_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs WHERE model_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM investor_evidence_model_checkpoints WHERE model_id=m.id)
      ORDER BY m.created_at,m.id LIMIT ?""", (at, at, limit)).fetchall()
    for model in models:
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        try:
            with transaction(db, immediate=False), _fact_validation_scope():
                markets = sorted({row["market"] for row in _object(model["document_json"])["targets"]})
                days = {market: instant(at).astimezone(ZoneInfo(longport._MARKETS[market][0])).date().isoformat() for market in markets}
                needed = [market for market in markets if not session_reserved(db, model["id"], market, days[market])]
                if not needed: continue
                context = initial_prices._context(db, model["workspace_id"], model["id"], at)
                plans = [market_plan(db, model["workspace_id"], context, market, days[market], at) for market in needed]
                if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
                assert_writable(db)
                actor = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (model["workspace_id"],)).fetchone()[0]
                for plan in plans:
                    if plan is None: continue
                    identifier, digest = new_id("initial-close-request"), content_hash(plan)
                    audit = _audit(db, actor, "investor_schedule_initial_close", "investor_initial_close_request", identifier, {"content_hash": digest}, at)
                    db.execute("INSERT INTO investor_initial_close_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (identifier, model["workspace_id"], model["id"], plan["control_id"], plan["reference_input_id"], plan["market"], plan["session_date"],
                         plan["not_before"], plan["latest_start"], plan["stop_at"], canonical_json(plan), digest, actor, at, audit))
                if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        except sqlite3.OperationalError as error:
            if getattr(error, "sqlite_errorcode", None) not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_BUSY_SNAPSHOT): raise
        except WorkbenchError as error:
            if str(error) in ("WORKER_STOP_REQUESTED", "WORKBENCH_READ_ONLY", "RESTORE_PENDING_REVIEW"): raise
            enqueue_notification(db, "initial-close-gap:" + model["id"], "investor.initial_close_gap",
                {"workspace_id": model["workspace_id"], "model_id": model["id"], "code": "INITIAL_CLOSE_SOURCE_GAP"}, now=at)
    rows = db.execute("""SELECT r.* FROM investor_initial_close_requests r LEFT JOIN job_runs j
      ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      WHERE j.id IS NULL ORDER BY r.not_before,r.created_at,r.id LIMIT ?""", (JOB_TYPE, limit)).fetchall()
    return [enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["content_hash"], max_attempts=1, not_before=row["not_before"], now=at) for row in rows]


def request_header(db, workspace, identifier, at):
    try:
        row = db.execute("SELECT * FROM investor_initial_close_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
        _assert(row is not None); _owner(db, workspace, row["actor_id"])
        _audit_binding(db, row, "investor_schedule_initial_close", "investor_initial_close_request", identifier)
        value = _object(row["document_json"]); validate_contract(value, SCHEMA, fragment="$defs/request")
        _assert(canonical_json(value) == row["document_json"] and content_hash(value) == row["content_hash"])
        _assert(all(value[key] == row[key] for key in ("workspace_id", "model_id", "control_id", "reference_input_id", "market", "session_date", "not_before", "latest_start", "stop_at")))
        _assert(all(value[key] == stamp(instant(value[key])) for key in ("not_before", "latest_start", "stop_at", "valid_until")))
        _assert(instant(row["created_at"]) <= instant(at) and instant(row["created_at"]) < instant(value["valid_until"])
            and instant(value["not_before"]) <= instant(value["latest_start"]) < instant(value["stop_at"]) < instant(value["valid_until"])
            and all(target["session_date"] == row["session_date"] for target in value["targets"]))
        model = db.execute("SELECT content_hash FROM investor_models WHERE id=? AND workspace_id=?", (row["model_id"], workspace)).fetchone()
        source = db.execute("SELECT content_hash FROM investor_evidence_inputs WHERE id=? AND workspace_id=?", (row["reference_input_id"], workspace)).fetchone()
        _assert(model and source and model[0] == value["model_hash"] and source[0] == value["reference_input_hash"])
        return row, value
    except Exception: raise WorkbenchError("INITIAL_CLOSE_BINDING_INVALID") from None


def _current(db, row, document, at):
    with transaction(db, immediate=False):
        context = initial_prices._context(db, row["workspace_id"], row["model_id"], at)
        _assert(context[2]["id"] == row["control_id"] and not db.execute("SELECT 1 FROM investor_evidence_model_checkpoints WHERE model_id=?", (row["model_id"],)).fetchone())
        _assert(market_plan(db, row["workspace_id"], context, row["market"], row["session_date"], at) == document)


def _run(db, row, document, job, status, at, capture=None):
    identifier = new_id("initial-close-run")
    value = {"schema_version": "investor-confirmed-feed-run-v1", "request_id": row["id"], "request_hash": row["content_hash"], "job_id": job["id"],
        "capture_id": capture["id"] if capture else None, "receipt_hash": capture["receipt_hash"] if capture else None,
        "status": status, "reason_code": confirmed_feed.CODES[status], "created_at": at, "live_advice_eligible": False}
    validate_contract(value, SCHEMA, fragment="$defs/run"); digest = content_hash(value)
    audit = _audit(db, row["actor_id"], "investor_complete_initial_close", "investor_initial_close_run", identifier, {"content_hash": digest}, at)
    db.execute("INSERT INTO investor_initial_close_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (identifier, row["workspace_id"], row["model_id"], row["id"], job["id"], value["capture_id"], status, canonical_json(value), digest, row["actor_id"], at, audit))
    enqueue_notification(db, "initial-close-run:" + identifier, "investor.initial_close_completed",
        {"workspace_id": row["workspace_id"], "model_id": row["model_id"], "run_id": identifier, "status": status, "code": value["reason_code"]}, now=at)
    terminal = "succeeded" if status == "complete" else "partial" if status in ("partial", "no_confirmed_events") else "skipped" if status in ("missed_window", "superseded") else "failed"
    return JobCommit({"run_id": identifier, "code": value["reason_code"], "live_advice_eligible": False}, terminal)


def prepare_initial_close(db, job, lease, *, clock=None, lease_seconds=300, stop_requested=None):
    return confirmed_feed._prepare_watch(db, job, lease, request_header=request_header, current=_current, publish_run=_run,
        job_type=JOB_TYPE, clock=clock, lease_seconds=lease_seconds, stop_requested=stop_requested)
