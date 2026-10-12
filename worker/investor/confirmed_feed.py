"""Calendar-bound callback jobs and core admission; no orders or history fallback."""

from datetime import timedelta
from math import ceil
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.market.providers import longport, longport_confirmed as receiver
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, new_id, stamp, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job, enqueue_notification, heartbeat
from . import confirmed_capture
from .data_evidence import _assert, _audit, _audit_binding, _object, _owner
from .model_runtime import _clock, _latest
from .monitor_admission import admit_monitor_data, current_monitor_model, latest_monitor_evidence, monitor_evidence_document
from .monitor_data import resolve_monitor_data
from .source_inputs import _snapshot_ids


JOB_TYPE = "investor_confirmed_watch"
ENGINE = "investor-confirmed-market-producer-v1"
SCHEMA = "investor-confirmed-feed.schema.json"
LEAD_SECONDS = 120
TAIL_SECONDS = 120
CODES = {"complete": "CONFIRMED_FEED_COMPLETE", "partial": "CONFIRMED_FEED_PARTIAL", "no_confirmed_events": "CONFIRMED_FEED_NO_EVENTS",
    "missed_window": "CONFIRMED_FEED_MISSED_WINDOW", "superseded": "CONFIRMED_FEED_SUPERSEDED", "transport_failed": "CONFIRMED_FEED_TRANSPORT_FAILED"}


def _seed(db, workspace, model_id, input_id, at):
    model, definition, reference = current_monitor_model(db, workspace, model_id, at)
    source, document = monitor_evidence_document(db, workspace, model_id, input_id, at)
    # Expired prices are precisely why a listener is needed. Source retention,
    # current rights and the original frozen arithmetic still must verify.
    result = resolve_monitor_data(db, workspace, definition, document, now=at, evaluated_at=document["created_at"])
    _assert(result["unavailable_reason"] is None, "CONFIRMED_FEED_SOURCE_UNAVAILABLE")
    control = _latest(db, "investor_model_controls", model_id, "version DESC")
    _assert(control is not None and control["enabled"] == 1 and control["created_at"] <= at, "CONFIRMED_FEED_MODEL_DISABLED")
    return model, definition, reference, control, source, document, result


def _specs(db, workspace, document, catalog):
    chosen = {}
    for segment in document["segments"]:
        snapshot = segment["snapshot"]
        for ref in snapshot["capture_refs"]:
            if ref.get("kind") == "confirmed_sdk":
                capture = db.execute("SELECT created_at FROM investor_confirmed_captures WHERE id=? AND workspace_id=?", (ref["capture_id"], workspace)).fetchone()
                targets = db.execute("SELECT * FROM investor_confirmed_targets WHERE capture_id=? AND workspace_id=?", (ref["capture_id"], workspace)).fetchall()
            else:
                capture = db.execute("SELECT * FROM investor_price_captures WHERE id=? AND workspace_id=?", (ref["capture_id"], workspace)).fetchone()
                _assert(capture is not None)
                listing = db.execute("SELECT document_json FROM investor_data_reviews WHERE id=? AND workspace_id=?", (capture["listing_review_id"], workspace)).fetchone()
                _assert(listing is not None)
                targets = [{"listing_id": _object(listing[0])["facts"]["listing_id"], **{kind + "_review_id": capture[kind + "_review_id"] for kind in ("rights", "listing", "calendar")}}]
            _assert(capture is not None)
            for target in targets:
                identity = target["listing_id"]; _assert(identity in catalog)
                rank = (instant(capture["created_at"]), ref["capture_id"])
                if identity not in chosen or chosen[identity][0] < rank:
                    chosen[identity] = rank, {kind + "_review_id": target[kind + "_review_id"] for kind in ("rights", "listing", "calendar")}
    _assert(set(chosen) == set(catalog))
    return {identity: value[1] for identity, value in sorted(chosen.items())}


def market_plan(db, workspace, model, definition, control, source, document, result, market, day, at):
    specs = _specs(db, workspace, document, result["catalog"])
    targets = [{**specs[row["listing_id"]], "session_date": day} for row in definition["targets"] if row["market"] == market]
    _assert(targets)
    calendar = _object(db.execute("SELECT document_json FROM investor_data_reviews WHERE id=? AND workspace_id=?", (targets[0]["calendar_review_id"], workspace)).fetchone()[0])["facts"]
    session = next((row for row in calendar["days"] if row["date"] == day), None)
    _assert(session is not None, "CONFIRMED_FEED_CALENDAR_GAP")
    if session["kind"] == "closed": return None
    bindings, reviews = confirmed_capture._bindings(db, workspace, targets, at)
    _assert({row["target"]["mapping"]["market"] for row in bindings} == {market})
    _assert(len({(row["target"]["close_at"], row["target"]["available_at"]) for row in bindings}) == 1)
    close, available = instant(session["close_at"]), instant(session["available_at"])
    start, latest, stop = close - timedelta(seconds=LEAD_SECONDS), close - timedelta(seconds=receiver.STARTUP_SECONDS), available + timedelta(seconds=TAIL_SECONDS)
    _assert(1 <= ceil((stop - start).total_seconds()) <= receiver.MAX_WATCH_SECONDS, "CONFIRMED_FEED_WINDOW_INVALID")
    expiry = min([instant(definition["valid_until"]), instant(document["valid_until"])] +
        [instant(value[kind]["review"]["valid_until"]) for value in reviews for kind in ("rights", "listing", "calendar")] +
        [instant(value["rights"]["facts"]["valid_until"]) for value in reviews])
    _assert(stop + timedelta(seconds=receiver.STARTUP_SECONDS) < expiry, "CONFIRMED_FEED_WINDOW_INVALID")
    planned = {"schema_version": "investor-confirmed-feed-request-v1", "engine_version": ENGINE,
        "workspace_id": workspace, "model_id": model["id"], "model_hash": model["content_hash"], "control_id": control["id"],
        "input_id": source["id"], "input_hash": source["content_hash"], "market": market, "session_date": day,
        "targets": sorted(targets, key=lambda row: row["listing_review_id"]), "binding_hash": content_hash(bindings),
        "not_before": stamp(start), "latest_start": stamp(latest), "stop_at": stamp(stop), "valid_until": stamp(expiry), "live_advice_eligible": False}
    validate_contract(planned, SCHEMA, fragment="$defs/request")
    return planned


def discover_confirmed_watches(db, *, limit=100, now=None, stop_requested=None):
    _assert(type(limit) is int and 1 <= limit <= 1000)
    at = _clock(now)
    with transaction(db):
        models = db.execute("""SELECT m.* FROM investor_models m JOIN investor_model_controls c ON c.model_id=m.id
          WHERE c.version=(SELECT max(version) FROM investor_model_controls WHERE model_id=m.id) AND c.enabled=1
          AND m.profile_id=(SELECT id FROM investor_profiles WHERE workspace_id=m.workspace_id ORDER BY version DESC LIMIT 1)
          AND m.plan_id=(SELECT plan_id FROM investor_plan_selections WHERE workspace_id=m.workspace_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
          AND json_extract(m.document_json,'$.data_mode')='reconstructed' AND json_extract(m.document_json,'$.valid_until')>?
          AND EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs WHERE model_id=m.id)
          ORDER BY COALESCE((SELECT max(created_at) FROM investor_confirmed_feed_requests WHERE model_id=m.id),''),m.id LIMIT ?""", (at, limit)).fetchall()
        for model in models:
            if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            source = latest_monitor_evidence(db, model["workspace_id"], model["id"])
            try:
                context = _seed(db, model["workspace_id"], model["id"], source["id"], at)
                _, definition, _, control, source, document, result = context
                plans = []
                for market in sorted({target["market"] for target in definition["targets"]}):
                    day = instant(at).astimezone(ZoneInfo(longport._MARKETS[market][0])).date().isoformat()
                    if db.execute("SELECT 1 FROM investor_confirmed_feed_requests WHERE model_id=? AND market=? AND session_date=?", (model["id"], market, day)).fetchone(): continue
                    if any(target["market"] == market and instant(target["observed_at"]).astimezone(ZoneInfo(longport._MARKETS[market][0])).date().isoformat() >= day for target in result["projection"]["quotes"]): continue
                    planned = market_plan(db, model["workspace_id"], model, definition, control, source, document, result, market, day, at)
                    if planned is None: continue
                    plans.append(planned)
                for planned in plans:
                    identifier, digest = new_id("confirmed-feed-request"), content_hash(planned)
                    actor = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (model["workspace_id"],)).fetchone()[0]
                    audit = _audit(db, actor, "investor_schedule_confirmed_feed", "investor_confirmed_feed_request", identifier, {"content_hash": digest}, at)
                    db.execute("INSERT INTO investor_confirmed_feed_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (identifier, model["workspace_id"], model["id"], control["id"], source["id"], planned["market"], planned["session_date"],
                        planned["not_before"], planned["latest_start"], planned["stop_at"], canonical_json(planned), digest, actor, at, audit))
            except WorkbenchError:
                enqueue_notification(db, "confirmed-feed-source-gap:" + model["id"] + ":" + source["id"], "investor.confirmed_feed_source_gap",
                    {"workspace_id": model["workspace_id"], "model_id": model["id"], "code": "CONFIRMED_FEED_SOURCE_GAP"}, now=at)
        pending = db.execute("""SELECT r.* FROM investor_confirmed_feed_requests r LEFT JOIN job_runs j
          ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
          WHERE j.id IS NULL ORDER BY r.not_before,r.created_at,r.id LIMIT ?""", (JOB_TYPE, limit)).fetchall()
        return [enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["content_hash"], max_attempts=1, not_before=row["not_before"], now=at) for row in pending]


def _request_header(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_confirmed_feed_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
    _assert(row is not None and row["created_at"] <= at, "CONFIRMED_FEED_BINDING_INVALID")
    _owner(db, workspace, row["actor_id"]); _audit_binding(db, row, "investor_schedule_confirmed_feed", "investor_confirmed_feed_request", row["id"])
    document = _object(row["document_json"]); validate_contract(document, SCHEMA, fragment="$defs/request")
    _assert(canonical_json(document) == row["document_json"] and content_hash(document) == row["content_hash"])
    _assert(all(document[key] == row[key] for key in ("workspace_id", "model_id", "control_id", "input_id", "market", "session_date", "not_before", "latest_start", "stop_at")))
    _assert(all(document[key] == stamp(instant(document[key])) for key in ("not_before", "latest_start", "stop_at", "valid_until"))
        and instant(row["created_at"]) <= instant(at) and instant(row["created_at"]) < instant(document["valid_until"])
        and instant(document["not_before"]) <= instant(document["latest_start"]) < instant(document["stop_at"]) < instant(document["valid_until"])
        and all(target["session_date"] == row["session_date"] for target in document["targets"]))
    model = db.execute("SELECT content_hash FROM investor_models WHERE id=? AND workspace_id=?", (row["model_id"], workspace)).fetchone()
    source = db.execute("SELECT content_hash FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?", (row["input_id"], workspace, row["model_id"])).fetchone()
    _assert(model and source and model[0] == document["model_hash"] and source[0] == document["input_hash"])
    return row, document


def request_header(db, workspace, identifier, at):
    try: return _request_header(db, workspace, identifier, at)
    except Exception: raise WorkbenchError("CONFIRMED_FEED_BINDING_INVALID") from None


def _run_header(db, row, at):
    _assert(instant(row["created_at"]) <= instant(at))
    _owner(db, row["workspace_id"], row["actor_id"])
    _audit_binding(db, row, "investor_complete_confirmed_feed", "investor_confirmed_feed_run", row["id"])
    value = _object(row["document_json"]); validate_contract(value, SCHEMA, fragment="$defs/run")
    _assert(canonical_json(value) == row["document_json"] and content_hash(value) == row["content_hash"]
        and all(value[key] == row[key] for key in ("request_id", "job_id", "capture_id", "status", "created_at"))
        and value["reason_code"] == CODES[row["status"]])
    request, spec = request_header(db, row["workspace_id"], row["request_id"], at)
    job = db.execute("SELECT * FROM job_runs WHERE id=?", (row["job_id"],)).fetchone()
    expected = "succeeded" if row["status"] == "complete" else "partial" if row["status"] in ("partial", "no_confirmed_events") else "skipped" if row["status"] in ("missed_window", "superseded") else "failed"
    _assert(request["model_id"] == row["model_id"] and request["actor_id"] == row["actor_id"] and value["request_hash"] == request["content_hash"]
        and job and job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["scope"] == row["workspace_id"]
        and job["period"] == row["request_id"] and job["input_version"] == request["content_hash"] and job["max_attempts"] == 1
        and job["status"] == expected and instant(job["created_at"]) <= instant(row["created_at"]) <= instant(job["updated_at"]) <= instant(at))
    if row["capture_id"] is not None:
        capture, receipt = confirmed_capture._header(db, row["workspace_id"], row["capture_id"], at)
        targets = [{**{kind + "_review_id": binding["reviews"][kind]["review_id"] for kind in ("rights", "listing", "calendar")},
            "session_date": binding["target"]["session_date"]} for binding in receipt["bindings"]]
        _assert(capture["status"] == row["status"] and capture["qualification"] == confirmed_capture.OFFICIAL and capture["receipt_hash"] == value["receipt_hash"]
            and content_hash(receipt["bindings"]) == spec["binding_hash"] and sorted(targets, key=lambda target: target["listing_review_id"]) == spec["targets"]
            and instant(spec["not_before"]) <= instant(receipt["call_started_at"]) <= instant(spec["latest_start"]) + timedelta(seconds=receiver.STARTUP_SECONDS)
            and instant(receipt["call_returned_at"]) <= instant(spec["stop_at"]) + timedelta(seconds=receiver.STARTUP_SECONDS)
            and instant(capture["created_at"]) <= instant(row["created_at"]))
    else: _assert(value["receipt_hash"] is None)
    return value, request, spec


def run_header(db, row, at):
    try: return _run_header(db, row, at)
    except Exception: raise WorkbenchError("CONFIRMED_FEED_BINDING_INVALID") from None


def _current(db, row, document, at):
    with transaction(db, immediate=False):
        context = _seed(db, row["workspace_id"], row["model_id"], row["input_id"], at)
        model, definition, _, control, source, stored, result = context
        _assert(control["id"] == row["control_id"], "CONFIRMED_FEED_SUPERSEDED")
        replay = market_plan(db, row["workspace_id"], model, definition, control, source, stored, result, row["market"], row["session_date"], at)
        _assert(replay == document, "CONFIRMED_FEED_BINDING_INVALID")
        return context


def _run(db, row, document, job, status, at, capture=None):
    identifier = new_id("confirmed-feed-run")
    value = {"schema_version": "investor-confirmed-feed-run-v1", "request_id": row["id"], "request_hash": row["content_hash"], "job_id": job["id"],
        "capture_id": capture["id"] if capture else None, "receipt_hash": capture["receipt_hash"] if capture else None,
        "status": status, "reason_code": CODES[status], "created_at": at, "live_advice_eligible": False}
    validate_contract(value, SCHEMA, fragment="$defs/run"); digest = content_hash(value)
    audit = _audit(db, row["actor_id"], "investor_complete_confirmed_feed", "investor_confirmed_feed_run", identifier, {"content_hash": digest}, at)
    db.execute("INSERT INTO investor_confirmed_feed_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (identifier, row["workspace_id"], row["model_id"], row["id"], job["id"], value["capture_id"], status, canonical_json(value), digest, row["actor_id"], at, audit))
    enqueue_notification(db, "confirmed-feed-run:" + identifier, "investor.confirmed_feed_completed",
        {"workspace_id": row["workspace_id"], "model_id": row["model_id"], "run_id": identifier, "status": status, "code": CODES[status]}, now=at)
    return JobCommit({"run_id": identifier, "code": CODES[status], "live_advice_eligible": False}, "succeeded" if status == "complete" else "partial" if status in ("partial", "no_confirmed_events") else "skipped" if status in ("missed_window", "superseded") else "failed")


def prepare_confirmed_watch(db, job, lease, *, clock=None, lease_seconds=300, stop_requested=None):
    clock = clock or (lambda: None); at = _clock(clock())
    row, document = request_header(db, job["scope"], job["period"], at)
    _assert(job["job_type"] == JOB_TYPE and job["command_request_id"] is None and job["input_version"] == row["content_hash"] and job["max_attempts"] == 1)
    if instant(at) < instant(document["not_before"]): raise WorkbenchError("CONFIRMED_FEED_NOT_DUE")
    status, prepared = None, None
    if instant(at) > instant(document["latest_start"]): status = "missed_window"
    else:
        try: _current(db, row, document, at)
        except WorkbenchError: status = "superseded"
    live_lease, last_beat = lease, instant(at)
    def guard():
        nonlocal live_lease, last_beat
        now = _clock(clock())
        if stop_requested and stop_requested(): return True
        assert_lease(db, live_lease, now=now)
        current = _latest(db, "investor_model_controls", row["model_id"], "version DESC")
        profile = db.execute("SELECT id FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1", (row["workspace_id"],)).fetchone()
        selected = db.execute("SELECT plan_id FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (row["workspace_id"],)).fetchone()
        model = db.execute("SELECT profile_id,plan_id FROM investor_models WHERE id=?", (row["model_id"],)).fetchone()
        _assert(current and current["id"] == row["control_id"] and current["enabled"] == 1 and profile and selected
            and profile[0] == model["profile_id"] and selected[0] == model["plan_id"], "CONFIRMED_FEED_SUPERSEDED")
        _assert(instant(now) < instant(document["valid_until"]) and instant(now) <= instant(document["stop_at"]) + timedelta(seconds=receiver.STARTUP_SECONDS), "CONFIRMED_FEED_WINDOW_ENDED")
        if instant(now) - last_beat >= timedelta(seconds=max(1, lease_seconds // 3)):
            live_lease = heartbeat(db, live_lease, lease_seconds=lease_seconds, now=now); last_beat = instant(now)
        return False
    if status is None:
        try:
            if guard(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            duration = ceil((instant(document["stop_at"]) - instant(_clock(clock()))).total_seconds())
            _assert(1 <= duration <= receiver.MAX_WATCH_SECONDS)
            prepared = confirmed_capture.prepare_confirmed_prices(db, row["workspace_id"], row["actor_id"], document["targets"],
                watch_seconds=duration, stop_requested=guard)
        except Exception:
            if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED") from None
            assert_lease(db, live_lease, now=_clock(clock()))
            status = "transport_failed"
    def commit_effect(connection):
        now = _clock(clock())
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        assert_lease(connection, live_lease, now=now)
        if status is not None: return _run(connection, row, document, job, status, now)
        try: _current(connection, row, document, now)
        except WorkbenchError: return _run(connection, row, document, job, "superseded", now)
        capture = prepared(connection)
        _assert(capture["qualification"] == confirmed_capture.OFFICIAL)
        return _run(connection, row, document, job, capture["status"], _clock(clock()), capture)
    def commit(connection):
        try: return commit_effect(connection)
        except WorkbenchError as error:
            if str(error) in ("WORKER_STOP_REQUESTED", "STALE_OR_EXPIRED_LEASE"): raise
            raise WorkbenchError("CONFIRMED_FEED_COMMIT_FAILED") from None
        except Exception: raise WorkbenchError("CONFIRMED_FEED_COMMIT_FAILED") from None
    return {"effect": commit}


def _windows(db, workspace, document):
    values = []
    for segment in document["segments"]:
        snapshot = segment["snapshot"]; confirmed = snapshot["schema_version"] == "investor-monitor-price-snapshot-v1"
        window = {"capture_ids": [ref["capture_id"] for ref in snapshot["capture_refs"] if not confirmed or ref["kind"] == "historical_sdk"],
            "action_review_ids": _snapshot_ids(db, workspace, snapshot, "actions"), "fx_review_ids": _snapshot_ids(db, workspace, snapshot, "fx"),
            "start_date": snapshot["range_start"], "end_date": snapshot["range_end"]}
        if confirmed: window["confirmed_capture_ids"] = [ref["capture_id"] for ref in snapshot["capture_refs"] if ref["kind"] == "confirmed_sdk"]
        markets = {_object(db.execute("SELECT document_json FROM investor_data_reviews WHERE id=? AND workspace_id=?", (identity, workspace)).fetchone()[0])["facts"]["market"]
            for identity in _snapshot_ids(db, workspace, snapshot, "listing")}
        _assert(len(markets) == 1)
        values.append((markets.pop(), window))
    return values


def _merge_completed(db, workspace, model, windows, at):
    rows = db.execute("""SELECT r.*,q.market,q.session_date FROM investor_confirmed_feed_runs r
        JOIN investor_confirmed_feed_requests q ON q.id=r.request_id AND q.workspace_id=r.workspace_id AND q.model_id=r.model_id
        JOIN job_runs j ON j.id=r.job_id WHERE r.workspace_id=? AND r.model_id=? AND r.status='complete' AND j.status='succeeded'
        AND r.created_at<=? ORDER BY q.market,q.session_date,r.id LIMIT 1001""", (workspace, model, at)).fetchall()
    _assert(len(rows) <= 1000, "CONFIRMED_FEED_CAPTURE_LIMIT")
    for row in rows:
        for market, window in windows:
            if market != row["market"] or row["session_date"] <= window["end_date"]: continue
            _, request, spec = run_header(db, row, at)
            _assert(request["market"] == market and request["session_date"] == row["session_date"])
            _current(db, request, spec, at)
            confirmed_capture.resolve_confirmed_capture(db, workspace, row["capture_id"], now=at)
            window.setdefault("confirmed_capture_ids", []).append(row["capture_id"]); window["end_date"] = row["session_date"]


def admit_completed_feeds(db, *, limit=100, now=None, stop_requested=None):
    _assert(type(limit) is int and 1 <= limit <= 1000); at = _clock(now)
    with transaction(db):
        rows = db.execute("""SELECT r.* FROM investor_confirmed_feed_runs r JOIN job_runs j ON j.id=r.job_id
          LEFT JOIN investor_confirmed_feed_admissions a ON a.run_id=r.id WHERE a.run_id IS NULL AND r.status='complete' AND j.status='succeeded'
          ORDER BY r.created_at,r.id LIMIT ?""", (limit,)).fetchall()
        for run in rows:
            if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            _, request, spec = run_header(db, run, at)
            status, admitted = "blocked", None
            try:
                _current(db, request, spec, at)
                confirmed_capture.resolve_confirmed_capture(db, run["workspace_id"], run["capture_id"], now=at)
                source = latest_monitor_evidence(db, run["workspace_id"], run["model_id"])
                context = _seed(db, run["workspace_id"], run["model_id"], source["id"], at)
                windows = _windows(db, run["workspace_id"], context[5])
                _merge_completed(db, run["workspace_id"], run["model_id"], windows, at)
                _assert(any(run["capture_id"] in window.get("confirmed_capture_ids", []) for _, window in windows), "CONFIRMED_FEED_INPUT_ALREADY_COVERED")
                admitted = admit_monitor_data(db, run["workspace_id"], run["actor_id"], run["model_id"], [window for _, window in windows], context[5]["settings"], now=at)
                status = "admitted"
            except WorkbenchError:
                control = _latest(db, "investor_model_controls", run["model_id"], "version DESC")
                if not control or control["id"] != request["control_id"]: status = "superseded"
            reason = {"admitted": "CONFIRMED_FEED_ADMITTED", "blocked": "CONFIRMED_FEED_INPUT_GAP", "superseded": "CONFIRMED_FEED_SUPERSEDED"}[status]
            value = {"schema_version": "investor-confirmed-feed-admission-v1", "run_id": run["id"], "run_hash": run["content_hash"],
                "input_id": admitted["id"] if admitted else None, "input_hash": admitted["content_hash"] if admitted else None,
                "status": status, "reason_code": reason, "created_at": at, "live_advice_eligible": False}
            validate_contract(value, SCHEMA, fragment="$defs/admission"); digest = content_hash(value)
            audit = _audit(db, run["actor_id"], "investor_admit_confirmed_feed", "investor_confirmed_feed_run", run["id"], {"content_hash": digest}, at)
            db.execute("INSERT INTO investor_confirmed_feed_admissions VALUES(?,?,?,?,?,?,?,?,?,?)",
                (run["id"], run["workspace_id"], run["model_id"], value["input_id"], status, canonical_json(value), digest, run["actor_id"], at, audit))
        return len(rows)
