"""Explicit bounded historical downloads; durable reservation precedes any SDK I/O.

Unknown calls are never resent, including after a worker crash or lost result.
These journals do not resume observation or certify current source eligibility.
"""

from datetime import timedelta

from worker.market.contracts import validate_contract
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job
from . import data_evidence as evidence, epoch_continuation as epochs, epoch_confirmed_feed as feed, managed_actions as managed
from .data_evidence import _audit, _audit_binding, _object, _owner
from .epoch_history_plan import plan_epoch_history
from .implementation import implementation_hash
from .model_runtime import _clock

JOB_TYPE = "investor_epoch_history"
SCHEMA = "investor-epoch-history-jobs.schema.json"
ACKS = ("historical_not_live","old_attempts_unchanged","bounded_download_only","no_trading")
CODES = {k:"EPOCH_HISTORY_"+k.upper() for k in ("collected","already_available","superseded","blocked_predecessor","transport_unknown")}
FRAME = ("workspace_id","actor_id","model_id","model_hash","epoch","registration_hash","activation","model_control","input","checkpoint","implementation_hash","planned_at","valid_until")


def _check(value,code="INVALID"):
    if not value:raise WorkbenchError("EPOCH_HISTORY_"+code)


def _validate(value,kind):validate_contract(value,SCHEMA,fragment="$defs/"+kind)


def request_header(db,workspace,actor,identifier,at):
    _owner(db,workspace,actor)
    row=db.execute("SELECT * FROM investor_epoch_history_requests WHERE id=? AND workspace_id=?",(identifier,workspace)).fetchone()
    _check(row is not None and row["actor_id"]==actor,"OUT_OF_SCOPE")
    doc=_object(row["document_json"]);_validate(doc,"request");body,plan=doc["body"],doc["plan"]
    _audit_binding(db,row,"investor_confirm_epoch_history","investor_epoch_history_request",identifier)
    _check(canonical_json(doc)==row["document_json"] and content_hash(doc)==row["content_hash"] and content_hash(body)==row["request_hash"]
        and all(doc[k]==row[k] for k in ("workspace_id","model_id","actor_id","created_at","valid_until","request_hash","authorized_calls"))
        and doc["request_id"]==identifier and body["idempotency_key"]==row["idempotency_key"] and body["expected_revision"]==row["expected_revision"]
        and plan["workspace_revision"]==row["expected_revision"] and plan["workspace_id"]==workspace and plan["actor_id"]==actor and plan["model_id"]==row["model_id"]
        and plan["epoch"]["id"]==body["epoch_id"]==row["epoch_id"] and plan["activation"]["id"]==row["activation_id"] and plan["model_control"]["id"]==row["control_id"]
        and plan["plan_hash"]==body["expected_plan_hash"] and plan["planned_at"]==body["planned_at"] and plan["valid_until"]==row["valid_until"]
        and plan["status"]=="download_confirmation_required" and row["authorized_calls"]==min(body["max_calls"],len(plan["tiles"]))
        and instant(plan["planned_at"])<=instant(plan["checked_at"])<=instant(row["created_at"])<instant(row["valid_until"]) and instant(row["created_at"])<=instant(at),"HEADER_CHANGED")
    design={k:v for k,v in plan.items() if k not in ("checked_at","plan_hash")};_check(content_hash(design)==plan["plan_hash"],"PLAN_CHANGED")
    return row,doc


def _slot_doc(row,parent):
    return {"schema_version":"investor-epoch-history-slot-v1","slot_id":row["id"],"request":epochs._ref(parent),"index":row["slot_index"],
        "tile":_object(parent["document_json"])["plan"]["tiles"][row["slot_index"]]}


def slot_header(db,workspace,identifier,at):
    row=db.execute("SELECT * FROM investor_epoch_history_slots WHERE id=? AND workspace_id=?",(identifier,workspace)).fetchone();_check(row is not None,"OUT_OF_SCOPE")
    parent,doc=request_header(db,workspace,row["actor_id"],row["request_id"],at);_check(0<=row["slot_index"]<parent["authorized_calls"])
    slot=_slot_doc(row,parent);tile=slot["tile"]
    _audit_binding(db,row,"investor_queue_epoch_history","investor_epoch_history_slot",identifier)
    _check(content_hash(slot)==row["content_hash"] and row["model_id"]==parent["model_id"] and row["actor_id"]==parent["actor_id"]
        and row["created_at"]==parent["created_at"] and all(row[k]==tile[k] for k in ("listing_id","start_date","end_date")),"SLOT_CHANGED")
    return row,parent,doc,tile


def _unresolved(db,workspace,tile,at,exclude=None):
    return db.execute("""SELECT 1 FROM investor_epoch_history_slots s JOIN investor_epoch_history_requests r ON r.id=s.request_id
      LEFT JOIN investor_epoch_history_attempts a ON a.slot_id=s.id LEFT JOIN investor_epoch_history_runs u ON u.slot_id=s.id
      WHERE s.workspace_id=? AND s.listing_id=? AND s.start_date<=? AND s.end_date>=? AND (? IS NULL OR r.id!=?)
        AND ((a.id IS NOT NULL AND (u.id IS NULL OR u.status!='collected')) OR
          (r.valid_until>? AND u.id IS NULL AND NOT EXISTS(SELECT 1 FROM job_runs j WHERE j.job_type=? AND j.scope=s.workspace_id AND j.period=s.id AND j.status IN ('failed','skipped','cancelled')))) LIMIT 1""",
        (workspace,tile["listing_id"],tile["end_date"],tile["start_date"],exclude,exclude,at,JOB_TYPE)).fetchone() is not None


def prepare_epoch_history_confirmation(db,workspace,actor,body,*,owner_interaction=False,now=None,clock=None,stop_requested=None):
    _check(not db.in_transaction,"PREPARATION_REQUIRES_AUTOCOMMIT");_check(owner_interaction is True,"OWNER_INTERACTION_REQUIRED")
    assert_writable(db);_owner(db,workspace,actor);_validate(body,"submit");body=_object(canonical_json(body));at=_clock(now);hashed=content_hash(body)
    old=db.execute("SELECT id,request_hash FROM investor_epoch_history_requests WHERE workspace_id=? AND idempotency_key=?",(workspace,body["idempotency_key"])).fetchone()
    if old:
        _check(old["request_hash"]==hashed,"DUPLICATE_CONFLICT")
        request_header(db,workspace,actor,old["id"],at)
        def replay(connection):
            _check(connection is db,"CONNECTION_CHANGED");assert_writable(db);_owner(db,workspace,actor)
            return request_header(db,workspace,actor,old["id"],_clock(clock() if clock else now))[1]
        return replay
    planned=plan_epoch_history(db,workspace,actor,body["epoch_id"],now=at,planned_at=body["planned_at"],stop_requested=stop_requested)
    _check(planned["plan_hash"]==body["expected_plan_hash"] and planned["workspace_revision"]==body["expected_revision"],"PLAN_CHANGED")
    _check(planned["status"]=="download_confirmation_required" and planned["tiles"],"NO_DOWNLOAD_PLAN")
    count=min(body["max_calls"],len(planned["tiles"]));selected=planned["tiles"][:count]
    def commit(connection):
        _check(connection is db,"CONNECTION_CHANGED");checked=_clock(clock() if clock else now)
        with transaction(connection):
            assert_writable(db);managed._stopped(db,stop_requested);_owner(db,workspace,actor)
            prior=db.execute("SELECT id,request_hash FROM investor_epoch_history_requests WHERE workspace_id=? AND idempotency_key=?",(workspace,body["idempotency_key"])).fetchone()
            if prior:
                _check(prior["request_hash"]==hashed,"DUPLICATE_CONFLICT");return request_header(db,workspace,actor,prior["id"],checked)[1]
            epochs._revision(db,workspace,actor,body["expected_revision"])
            _check(instant(at)<=instant(checked)<instant(planned["valid_until"]),"EXPIRED")
            _check(implementation_hash()==planned["implementation_hash"] and epochs._fence(db,workspace,actor)==planned["source_fence"],"SOURCE_CHANGED")
            _check(not any(_unresolved(db,workspace,t,checked) for t in selected),"PRIOR_DOWNLOAD_UNRESOLVED")
            identifier=new_id("epoch-history-request")
            doc={"schema_version":"investor-epoch-history-request-v1","request_id":identifier,"workspace_id":workspace,"model_id":planned["model_id"],"actor_id":actor,
                "body":body,"request_hash":hashed,"plan":planned,"authorized_calls":count,"created_at":checked,"valid_until":planned["valid_until"],"trading_permission":False}
            _validate(doc,"request");digest=content_hash(doc)
            audit=_audit(db,actor,"investor_confirm_epoch_history","investor_epoch_history_request",identifier,{"content_hash":digest},checked)
            db.execute("INSERT INTO investor_epoch_history_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(identifier,workspace,planned["model_id"],body["epoch_id"],planned["activation"]["id"],
                planned["model_control"]["id"],body["expected_revision"],body["idempotency_key"],hashed,count,canonical_json(doc),digest,actor,checked,planned["valid_until"],audit))
            parent=db.execute("SELECT * FROM investor_epoch_history_requests WHERE id=?",(identifier,)).fetchone()
            for index,tile in enumerate(selected):
                sid=new_id("epoch-history-slot");fields={"id":sid,"slot_index":index};sd=content_hash(_slot_doc(fields,parent))
                sa=_audit(db,actor,"investor_queue_epoch_history","investor_epoch_history_slot",sid,{"content_hash":sd},checked)
                db.execute("INSERT INTO investor_epoch_history_slots VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(sid,identifier,workspace,planned["model_id"],index,tile["listing_id"],tile["start_date"],tile["end_date"],sd,actor,checked,sa))
                enqueue_job(db,JOB_TYPE,workspace,sid,sd,max_attempts=1,now=checked)
            db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?",(workspace,));managed._stopped(db,stop_requested)
            return doc
    return commit


def _live(db,parent,doc,at):
    plan=doc["plan"]
    feed._live(db,{"workspace_id":parent["workspace_id"],"actor_id":parent["actor_id"],"epoch_id":parent["epoch_id"],"model_id":parent["model_id"],"control_id":parent["control_id"]},
        {"activation":plan["activation"],"model_hash":plan["model_hash"],"valid_until":parent["valid_until"]},at)
    epochs._revision(db,parent["workspace_id"],parent["actor_id"],parent["expected_revision"]+1)
    _check(plan["implementation_hash"]==implementation_hash(),"IMPLEMENTATION_CHANGED")


def _predecessors(db,slot,at):
    rows=db.execute("SELECT * FROM investor_epoch_history_slots WHERE request_id=? AND slot_index<? ORDER BY slot_index",(slot["request_id"],slot["slot_index"])).fetchall()
    _check(len(rows)==slot["slot_index"],"SLOT_CHANGED")
    for row in rows:
        job=db.execute("SELECT * FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?",(JOB_TYPE,row["workspace_id"],row["id"],row["content_hash"])).fetchone()
        run=db.execute("SELECT * FROM investor_epoch_history_runs WHERE slot_id=?",(row["id"],)).fetchone()
        if not (job and job["status"]=="succeeded" and run and run["status"] in ("collected","already_available")):return False
        result=_run_header(db,run,at)
        attempt=db.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=? AND fencing_token=?",(job["id"],job["attempt_count"],job["fencing_token"])).fetchone()
        _check(run["job_id"]==job["id"] and job["max_attempts"]==job["attempt_count"]==1 and job["command_request_id"] is None
            and attempt and attempt["status"]=="succeeded" and attempt["finished_at"]==job["updated_at"] and result["fencing_token"]==job["fencing_token"]
            and _object(job["result_json"])=={"run_id":run["id"],"code":result["code"],"trading_permission":False},"PREDECESSOR_CHANGED")
        _check(instant(job["updated_at"])+timedelta(seconds=1)<=instant(at),"CALL_SPACING_REQUIRED")
    return True


def _current(db,parent,doc,tile,at,stop_requested):
    _live(db,parent,doc,at)
    current=plan_epoch_history(db,parent["workspace_id"],parent["actor_id"],parent["epoch_id"],now=at,planned_at=doc["plan"]["planned_at"],stop_requested=stop_requested)
    _check(all(current[k]==doc["plan"][k] for k in FRAME) and current["workspace_revision"]==parent["expected_revision"]+1
        and current["status"]!="overlap_review_required","SOURCE_CHANGED")
    if tile in current["tiles"]:return current,False
    missing={d for t in current["tiles"] if t["listing_id"]==tile["listing_id"] for d in t["expected_dates"]}
    _check(not (missing & set(tile["expected_dates"])),"TILE_PARTIALLY_CHANGED")
    return current,True


def _attempt_header(db,row,at):
    doc=_object(row["document_json"]);_validate(doc,"attempt");_audit_binding(db,row,"investor_reserve_epoch_history","investor_epoch_history_attempt",row["id"])
    _check(canonical_json(doc)==row["document_json"] and content_hash(doc)==row["content_hash"] and doc["attempt_id"]==row["id"] and doc["slot"]["id"]==row["slot_id"]
        and doc["job_id"]==row["job_id"] and doc["fencing_token"]==row["fencing_token"] and doc["created_at"]==row["created_at"] and instant(row["created_at"])<=instant(at),"ATTEMPT_CHANGED")
    return doc


def _run_header(db,row,at):
    doc=_object(row["document_json"]);_validate(doc,"run");_audit_binding(db,row,"investor_finish_epoch_history","investor_epoch_history_run",row["id"])
    _check(canonical_json(doc)==row["document_json"] and content_hash(doc)==row["content_hash"] and doc["run_id"]==row["id"]
        and all(doc[k]==row[k] for k in ("job_id","attempt_id","capture_id","status","created_at")) and doc["slot"]["id"]==row["slot_id"]
        and doc["code"]==CODES[row["status"]] and instant(row["created_at"])<=instant(at),"RUN_CHANGED")
    return doc


def prepare_epoch_history_job(db,job,lease,*,clock=None,stop_requested=None):
    _check(not db.in_transaction,"PREPARATION_REQUIRES_AUTOCOMMIT");clock=clock or (lambda:None)
    def guard():
        at=_clock(clock());assert_writable(db);managed._stopped(db,stop_requested);live=assert_lease(db,lease,at)
        _check(all(live[k]==job[k] for k in ("id","scope","period","job_type","input_version","attempt_count","max_attempts","command_request_id")),"JOB_CHANGED")
        return at
    at=guard();slot,parent,doc,tile=slot_header(db,job["scope"],job["period"],at)
    _check(job["job_type"]==JOB_TYPE and job["input_version"]==slot["content_hash"] and job["max_attempts"]==job["attempt_count"]==1 and job["command_request_id"] is None,"JOB_CHANGED")
    _check(not db.execute("SELECT 1 FROM investor_epoch_history_attempts WHERE slot_id=?",(slot["id"],)).fetchone(),"ATTEMPT_ALREADY_RESERVED")
    status,prepared,sealed,attempt=None,None,{},None
    try:
        if not _predecessors(db,slot,at):status="blocked_predecessor"
        else:
            current,available=_current(db,parent,doc,tile,at,stop_requested);sealed["fence"]=current["source_fence"]
            if available:status="already_available"
    except WorkbenchError as error:
        if str(error) in managed.STOP or str(error)=="STALE_OR_EXPIRED_LEASE":raise
        status="superseded"
    def reserve():
        nonlocal attempt
        checked=guard()
        with transaction(db):
            _live(db,parent,doc,checked)
            _check(sealed["fence"]==epochs._fence(db,parent["workspace_id"],parent["actor_id"]),"SOURCE_CHANGED")
            _check(_predecessors(db,slot,checked),"PREDECESSOR_CHANGED")
            _check(not _unresolved(db,parent["workspace_id"],tile,checked,exclude=parent["id"]),"PRIOR_DOWNLOAD_UNRESOLVED")
            _check(instant(checked)+timedelta(seconds=longport.CALL_TIMEOUT_SECONDS+1)<min(instant(parent["valid_until"]),instant(lease.lease_until)),"INSUFFICIENT_CALL_WINDOW")
            identifier=new_id("epoch-history-attempt")
            value={"schema_version":"investor-epoch-history-attempt-v1","attempt_id":identifier,"slot":epochs._ref(slot),"request":epochs._ref(parent),"job_id":job["id"],"fencing_token":lease.fencing_token,
                "created_at":checked,"valid_until":parent["valid_until"],"source_fence":sealed["fence"],"implementation_hash":implementation_hash(),"network_outcome_known":False,"trading_permission":False}
            _validate(value,"attempt");digest=content_hash(value);audit=_audit(db,parent["actor_id"],"investor_reserve_epoch_history","investor_epoch_history_attempt",identifier,{"content_hash":digest},checked)
            db.execute("INSERT INTO investor_epoch_history_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)",(identifier,slot["id"],parent["workspace_id"],parent["model_id"],job["id"],lease.fencing_token,canonical_json(value),digest,parent["actor_id"],checked,audit))
        attempt=identifier
    if status is None:
        try:
            prepared=evidence.prepare_prices(db,parent["workspace_id"],parent["actor_id"],*(tile[k+"_review_id"] for k in ("rights","listing","calendar")),tile["start_date"],tile["end_date"],prevent_retained_overlap=True,before_collect=reserve)
            guard()
            current,available=_current(db,parent,doc,tile,guard(),stop_requested)
            _check(not available,"SOURCE_CHANGED");sealed["fence"]=current["source_fence"]
        except Exception as error:
            if isinstance(error,WorkbenchError) and (str(error) in managed.STOP or str(error)=="STALE_OR_EXPIRED_LEASE"):raise
            status="transport_unknown" if attempt else "superseded"
    def commit(connection):
        _check(connection is db,"CONNECTION_CHANGED");checked=guard()
        marker=db.execute("SELECT id FROM investor_epoch_history_attempts WHERE slot_id=?",(slot["id"],)).fetchone()
        _check(attempt==(marker[0] if marker else None),"ATTEMPT_CHANGED")
        capture=None
        if (prepared and status is None) or status=="already_available":
            _live(db,parent,doc,checked)
            _check(sealed["fence"]==epochs._fence(db,parent["workspace_id"],parent["actor_id"]),"SOURCE_CHANGED")
            if prepared and status is None:
                capture=prepared(connection);_check(capture["qualification"]=="isolated_official_sdk","CAPTURE_CHANGED")
        state=status or "collected";identifier=new_id("epoch-history-run")
        value={"schema_version":"investor-epoch-history-run-v1","run_id":identifier,"slot":epochs._ref(slot),"request":epochs._ref(parent),"job_id":job["id"],"fencing_token":lease.fencing_token,
            "attempt_id":attempt,"capture_id":capture["id"] if capture else None,"receipt_hash":capture["receipt_hash"] if capture else None,"status":state,"code":CODES[state],
            "created_at":checked,"valid_until":parent["valid_until"],"source_fence":epochs._fence(db,parent["workspace_id"],parent["actor_id"]) if state in ("collected","already_available") else None,"trading_permission":False}
        _validate(value,"run");digest=content_hash(value);audit=_audit(db,parent["actor_id"],"investor_finish_epoch_history","investor_epoch_history_run",identifier,{"content_hash":digest},checked)
        db.execute("INSERT INTO investor_epoch_history_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",(identifier,slot["id"],parent["workspace_id"],parent["model_id"],job["id"],attempt,value["capture_id"],state,canonical_json(value),digest,parent["actor_id"],checked,audit))
        return JobCommit({"run_id":identifier,"code":CODES[state],"trading_permission":False},"succeeded" if state in ("collected","already_available") else "failed" if state=="transport_unknown" else "skipped")
    return {"effect":commit}


def assert_epoch_history_finalization(db,job,lease,result,outcome,finished):
    row=db.execute("SELECT * FROM investor_epoch_history_runs WHERE job_id=? AND slot_id=?",(job["id"],job["period"])).fetchone();_check(row is not None,"FINALIZATION_CHANGED")
    doc=_run_header(db,row,finished);slot,parent,request,tile=slot_header(db,job["scope"],job["period"],finished)
    expected="succeeded" if row["status"] in ("collected","already_available") else "failed" if row["status"]=="transport_unknown" else "skipped"
    _check(outcome==expected and doc["fencing_token"]==lease.fencing_token and doc["slot"]==epochs._ref(slot) and doc["request"]==epochs._ref(parent)
        and result=={"run_id":row["id"],"code":doc["code"],"trading_permission":False},"FINALIZATION_CHANGED")
    if row["attempt_id"]:
        marker=db.execute("SELECT * FROM investor_epoch_history_attempts WHERE id=?",(row["attempt_id"],)).fetchone();_check(marker is not None,"ATTEMPT_CHANGED")
        reserved=_attempt_header(db,marker,finished)
        _check(reserved["slot"]==doc["slot"] and reserved["request"]==doc["request"] and reserved["job_id"]==job["id"] and reserved["fencing_token"]==lease.fencing_token,"ATTEMPT_CHANGED")
    if expected=="succeeded":
        _live(db,parent,request,finished)
        _check(doc["source_fence"]==epochs._fence(db,parent["workspace_id"],parent["actor_id"]),"SOURCE_CHANGED")
        if row["capture_id"]:
            capture=db.execute("SELECT * FROM investor_price_captures WHERE id=? AND workspace_id=?",(row["capture_id"],parent["workspace_id"])).fetchone();_check(capture is not None,"CAPTURE_CHANGED")
            receipt=_object(capture["receipt_json"]);call=receipt["source"]
            _check(capture["receipt_hash"]==doc["receipt_hash"] and capture["qualification"]=="isolated_official_sdk"
                and instant(reserved["created_at"])<=instant(call["call_started_at"])<=instant(call["call_returned_at"])<instant(capture["created_at"])+timedelta(milliseconds=1),"CAPTURE_CHANGED")
