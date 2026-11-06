"""One calendar-bound callback per active epoch/model/market/day, not a replay.

The old watch protocol and monitor admission remain unchanged. Full retained
epoch replay precedes I/O and finalization; the writer only checks change fences.
"""

from datetime import timedelta
import sqlite3
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.market.providers import longport, longport_confirmed as receiver
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, enqueue_job, enqueue_notification
from . import confirmed_feed as feed, confirmed_capture, epoch_continuation as epochs, managed_actions as managed
from .data_evidence import _audit, _audit_binding, _fact_validation_scope, _object, _owner
from .implementation import implementation_hash
from .model_runtime import _clock
from .monitor_admission import current_monitor_model

JOB_TYPE = "investor_epoch_confirmed_watch"
ENGINE = "investor-epoch-confirmed-market-producer-v1"
SCHEMA = "investor-epoch-confirmed-feed.schema.json"


def _check(value, code="BINDING_INVALID"):
    if not value: raise WorkbenchError("EPOCH_FEED_" + code)


def _validate(value, kind): validate_contract(value, SCHEMA, fragment="$defs/" + kind)


def _live(db, row, doc, at):
    _owner(db, row["workspace_id"], row["actor_id"])
    current = db.execute("SELECT * FROM investor_epoch_controls WHERE epoch_id=? ORDER BY version DESC LIMIT 1", (row["epoch_id"],)).fetchone()
    global_control = db.execute("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1", (row["workspace_id"], row["model_id"])).fetchone()
    model = db.execute("SELECT * FROM investor_models WHERE id=? AND workspace_id=?", (row["model_id"], row["workspace_id"])).fetchone()
    profile = db.execute("SELECT id FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1", (row["workspace_id"],)).fetchone()
    selected = db.execute("SELECT plan_id FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (row["workspace_id"],)).fetchone()
    if not (current and epochs._ref(current) == doc["activation"] and current["enabled"] == 1
            and instant(current["created_at"]) <= instant(at) < instant(current["valid_until"])
            and global_control and global_control["id"] == row["control_id"] and global_control["enabled"] == 1
            and instant(global_control["created_at"]) <= instant(at) and model and model["content_hash"] == doc["model_hash"]
            and profile and selected and profile[0] == model["profile_id"] and selected[0] == model["plan_id"]):
        raise WorkbenchError("CONFIRMED_FEED_SUPERSEDED")
    _check(instant(at) < instant(doc["valid_until"]), "EXPIRED")


def _context(db, workspace, actor, epoch_id, activation_id, at, input_id=None, stop_requested=None):
    managed._stopped(db, stop_requested)
    chain = epochs.read_epoch_continuation_chain(db, workspace, actor, epoch_id, now=at, stop_requested=stop_requested)
    activation, control = epochs._control(db, workspace, actor, activation_id)
    root = chain["root"]; definition = chain["definition"]; model_id = definition["model_id"]
    model, current_definition, _ = current_monitor_model(db, workspace, model_id, at)
    _check(current_definition == definition, "MODEL_CHANGED")
    latest = db.execute("SELECT id,content_hash FROM investor_monitor_evidence_inputs WHERE workspace_id=? AND model_id=? ORDER BY rowid DESC LIMIT 1", (workspace, model_id)).fetchone()
    head = db.execute("SELECT id,content_hash FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence DESC LIMIT 1", (workspace, model_id)).fetchone()
    _check(latest and dict(latest) == chain["head"]["input"] and head and dict(head) == chain["head"]["checkpoint"], "UNKNOWN_TAIL")
    identifier = input_id or latest["id"]
    if identifier != root["registration"]["input"]["id"]:
        prefix = db.execute("SELECT sequence FROM investor_epoch_continuations WHERE epoch_id=? AND input_id=?", (epoch_id, identifier)).fetchone()
        _check(prefix and prefix[0] <= chain["publication_count"], "INPUT_NOT_PUBLISHED")
    source = db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?", (identifier, workspace, model_id)).fetchone()
    _check(source is not None); document = _object(source["document_json"])
    _check(document["schema_version"] == "investor-monitor-data-input-v6" and document["epoch"] == root["registration"]["epoch"]
        and canonical_json(document) == source["document_json"] and content_hash(document) == source["content_hash"], "INPUT_CHANGED")
    global_control = db.execute("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1", (workspace, model_id)).fetchone()
    _check(global_control and {"id":global_control["id"],"content_hash":content_hash(dict(global_control))} == root["source"]["epoch_definition"]["model_control"], "MODEL_CONTROL_CHANGED")
    scope = {"workspace_id":workspace,"actor_id":actor,"model_id":model_id,"epoch_id":epoch_id,"control_id":global_control["id"]}
    _live(db, scope, {"activation":epochs._ref(activation),"model_hash":model["content_hash"],"valid_until":min(chain["read_valid_until"],activation["valid_until"],key=instant)}, at)
    managed._stopped(db, stop_requested)
    return chain, activation, control, model, global_control, source, document


def _plan(db, context, market, day, at):
    chain, activation, control, model, global_control, source, document = context
    _check(day == instant(at).astimezone(ZoneInfo(longport._MARKETS[market][0])).date().isoformat(), "NOT_CURRENT_SESSION")
    definition = chain["definition"]
    plan = feed.market_plan(db, model["workspace_id"], model, definition, global_control, source, document,
        {"catalog":{row["listing_id"]:row for row in definition["targets"]}}, market, day, at)
    if plan is None: return None
    expiry = min(plan["valid_until"], chain["read_valid_until"], activation["valid_until"], key=instant)
    _check(instant(plan["stop_at"]) + timedelta(seconds=receiver.STARTUP_SECONDS) < instant(expiry), "WINDOW_INVALID")
    return {**plan,"schema_version":"investor-epoch-confirmed-feed-request-v1","engine_version":ENGINE,
        "epoch":chain["root"]["registration"]["epoch"],"registration_hash":control["registration_hash"],
        "activation":epochs._ref(activation),"implementation_hash":implementation_hash(),"valid_until":expiry}


def _reserved(db, model, market, day):
    return any(db.execute("SELECT 1 FROM " + table + " WHERE model_id=? AND market=? AND session_date=? LIMIT 1", (model,market,day)).fetchone()
        for table in ("investor_epoch_feed_requests","investor_confirmed_feed_requests","investor_initial_close_requests","investor_initial_price_requests"))


def discover_epoch_watches(db, *, limit=100, now=None, stop_requested=None):
    _check(type(limit) is int and 1 <= limit <= 1000); at = _clock(now)
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investor_epoch_feed_requests'").fetchone(): return []
    _check(not db.in_transaction, "DISCOVERY_REQUIRES_AUTOCOMMIT"); assert_writable(db)
    rows = db.execute("""SELECT * FROM investor_epoch_controls c WHERE enabled=1 AND created_at<=? AND valid_until>?
      AND version=(SELECT max(version) FROM investor_epoch_controls WHERE epoch_id=c.epoch_id)
      ORDER BY COALESCE((SELECT max(created_at) FROM investor_epoch_feed_requests WHERE epoch_id=c.epoch_id),''),id LIMIT ?""", (at,at,limit)).fetchall()
    for row in rows:
        managed._stopped(db, stop_requested)
        try:
            with transaction(db, immediate=False), _fact_validation_scope():
                model = db.execute("SELECT document_json FROM investor_models WHERE id=? AND workspace_id=?", (row["model_id"],row["workspace_id"])).fetchone()
                _check(model is not None); definition = _object(model[0]); plans = []
                markets = sorted({r["market"] for r in definition["targets"]})
                days = {m:instant(at).astimezone(ZoneInfo(longport._MARKETS[m][0])).date().isoformat() for m in markets}
                needed = [m for m in markets if not _reserved(db,row["model_id"],m,days[m])]
                if not needed: continue
                context = _context(db,row["workspace_id"],row["actor_id"],row["epoch_id"],row["id"],at,stop_requested=stop_requested)
                for market in needed:
                    plan = _plan(db,context,market,days[market],at)
                    if plan is not None: _validate(plan,"request"); plans.append(plan)
                fence = epochs._fence(db,row["workspace_id"],row["actor_id"])
            with transaction(db):
                assert_writable(db); managed._stopped(db,stop_requested)
                _check(fence == epochs._fence(db,row["workspace_id"],row["actor_id"]),"SOURCE_CHANGED")
                for plan in plans:
                    _live(db,{**dict(row),"epoch_id":row["epoch_id"],"control_id":plan["control_id"]},plan,at)
                    _check(not _reserved(db,row["model_id"],plan["market"],plan["session_date"]),"SESSION_RESERVED")
                    identifier,digest = new_id("epoch-feed-request"),content_hash(plan)
                    audit = _audit(db,row["actor_id"],"investor_schedule_epoch_feed","investor_epoch_feed_request",identifier,{"content_hash":digest},at)
                    db.execute("INSERT INTO investor_epoch_feed_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(identifier,row["workspace_id"],row["model_id"],row["epoch_id"],row["id"],
                        plan["control_id"],plan["input_id"],plan["market"],plan["session_date"],plan["not_before"],plan["latest_start"],plan["stop_at"],canonical_json(plan),digest,row["actor_id"],at,audit))
        except sqlite3.OperationalError as error:
            if getattr(error,"sqlite_errorcode",None) not in (sqlite3.SQLITE_BUSY,sqlite3.SQLITE_BUSY_SNAPSHOT): raise
        except WorkbenchError as error:
            if str(error) in managed.STOP: raise
            enqueue_notification(db,"epoch-feed-gap:"+row["id"]+":"+at[:10],"investor.epoch_feed_source_gap",
                {"workspace_id":row["workspace_id"],"epoch_id":row["epoch_id"],"code":"EPOCH_FEED_SOURCE_GAP","live_advice_eligible":False},now=at)
    pending = db.execute("""SELECT r.* FROM investor_epoch_feed_requests r LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      WHERE j.id IS NULL ORDER BY r.not_before,r.created_at,r.id LIMIT ?""",(JOB_TYPE,limit)).fetchall()
    return [enqueue_job(db,JOB_TYPE,r["workspace_id"],r["id"],r["content_hash"],max_attempts=1,not_before=r["not_before"],now=at) for r in pending]


def request_header(db, workspace, identifier, at):
    row = db.execute("SELECT * FROM investor_epoch_feed_requests WHERE id=? AND workspace_id=?",(identifier,workspace)).fetchone()
    _check(row is not None); _owner(db,workspace,row["actor_id"]); doc = _object(row["document_json"]); _validate(doc,"request")
    _audit_binding(db,row,"investor_schedule_epoch_feed","investor_epoch_feed_request",identifier)
    _check(canonical_json(doc)==row["document_json"] and content_hash(doc)==row["content_hash"]
        and all(doc[k]==row[k] for k in ("workspace_id","model_id","control_id","input_id","market","session_date","not_before","latest_start","stop_at"))
        and doc["epoch"]["id"]==row["epoch_id"] and doc["activation"]["id"]==row["activation_id"]
        and instant(row["created_at"]) <= instant(at) and instant(row["created_at"]) < instant(doc["valid_until"])
        and instant(doc["not_before"]) <= instant(doc["latest_start"]) < instant(doc["stop_at"]) < instant(doc["valid_until"])
        and all(t["session_date"]==row["session_date"] for t in doc["targets"]))
    activation,control = epochs._control(db,workspace,row["actor_id"],row["activation_id"])
    _check(epochs._ref(activation)==doc["activation"] and control["epoch"]==doc["epoch"] and control["registration_hash"]==doc["registration_hash"]
        and activation["enabled"]==1 and instant(activation["created_at"]) <= instant(row["created_at"])
        and instant(doc["valid_until"]) <= instant(activation["valid_until"]))
    for table,key in (("investor_models","model"),("investor_monitor_evidence_inputs","input")):
        saved = db.execute("SELECT content_hash FROM "+table+" WHERE id=? AND workspace_id=?",(row[key+"_id"],workspace)).fetchone()
        _check(saved and saved[0]==doc[key+"_hash"])
    return row,doc


def prepare_epoch_watch(db, job, lease, *, clock=None, lease_seconds=300, stop_requested=None):
    _check(not db.in_transaction,"PREPARATION_REQUIRES_AUTOCOMMIT"); sealed = {}
    def replay(connection,row,doc,at):
        with transaction(connection,immediate=False), _fact_validation_scope():
            _live(connection,row,doc,at); _check(doc["implementation_hash"]==implementation_hash(),"IMPLEMENTATION_CHANGED")
            context = _context(connection,row["workspace_id"],row["actor_id"],row["epoch_id"],row["activation_id"],at,row["input_id"],stop_requested)
            _check(_plan(connection,context,row["market"],row["session_date"],at)==doc,"SOURCE_CHANGED")
            sealed["fence"] = epochs._fence(connection,row["workspace_id"],row["actor_id"])
    def final_current(connection,row,doc,at):
        _live(connection,row,doc,at); managed._stopped(connection,stop_requested)
        _check(sealed.get("fence")==epochs._fence(connection,row["workspace_id"],row["actor_id"]),"SOURCE_CHANGED")
    return feed._prepare_watch(db,job,lease,request_header=request_header,current=replay,publish_run=_run,job_type=JOB_TYPE,
        clock=clock,lease_seconds=lease_seconds,stop_requested=stop_requested,during_watch=_live,before_commit=replay,commit_current=final_current)


def _run(db,row,doc,job,status,at,capture=None):
    identifier = new_id("epoch-feed-run")
    value = {"schema_version":"investor-epoch-confirmed-feed-run-v1","request_id":row["id"],"request_hash":row["content_hash"],"job_id":job["id"],"fencing_token":job["fencing_token"],
        "capture_id":capture["id"] if capture else None,"receipt_hash":capture["receipt_hash"] if capture else None,"status":status,"reason_code":feed.CODES[status],
        "created_at":at,"valid_until":doc["valid_until"],"source_fence":epochs._fence(db,row["workspace_id"],row["actor_id"]) if capture else None,"live_advice_eligible":False}
    _validate(value,"run"); digest = content_hash(value)
    audit = _audit(db,row["actor_id"],"investor_complete_epoch_feed","investor_epoch_feed_run",identifier,{"content_hash":digest},at)
    db.execute("INSERT INTO investor_epoch_feed_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(identifier,row["workspace_id"],row["model_id"],row["id"],job["id"],value["capture_id"],status,canonical_json(value),digest,row["actor_id"],at,audit))
    enqueue_notification(db,"epoch-feed-run:"+identifier,"investor.epoch_feed_completed",{"workspace_id":row["workspace_id"],"epoch_id":row["epoch_id"],"run_id":identifier,"status":status,"code":feed.CODES[status]},now=at)
    outcome = "succeeded" if status=="complete" else "partial" if status in ("partial","no_confirmed_events") else "skipped" if status in ("missed_window","superseded") else "failed"
    return JobCommit({"run_id":identifier,"code":feed.CODES[status],"live_advice_eligible":False},outcome)


def assert_epoch_watch_finalization(db,job,lease,result,outcome,finished):
    row = db.execute("SELECT * FROM investor_epoch_feed_runs WHERE job_id=? AND request_id=?",(job["id"],job["period"])).fetchone()
    _check(row is not None); doc = _object(row["document_json"]); _validate(doc,"run")
    request,spec = request_header(db,job["scope"],job["period"],finished)
    expected = "succeeded" if doc["status"]=="complete" else "partial" if doc["status"] in ("partial","no_confirmed_events") else "skipped" if doc["status"] in ("missed_window","superseded") else "failed"
    _check(doc["fencing_token"]==lease.fencing_token and outcome==expected
        and result=={"run_id":row["id"],"code":doc["reason_code"],"live_advice_eligible":False}
        and instant(doc["created_at"]) <= instant(finished),"FINALIZATION_CHANGED")
    if doc["capture_id"] is not None:
        _live(db,request,spec,finished)
        _check(spec["implementation_hash"]==implementation_hash() and instant(finished)<instant(doc["valid_until"])
            and doc["source_fence"]==epochs._fence(db,row["workspace_id"],row["actor_id"]),"FINALIZATION_CHANGED")
