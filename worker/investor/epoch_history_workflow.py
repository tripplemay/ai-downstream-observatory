"""Async owner preparation/confirmation; only the separate history role uses I/O."""

from datetime import timedelta

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError,assert_writable,canonical_json,content_hash,instant,new_id,transaction
from worker.orchestration.jobs import JobCommit,assert_lease,enqueue_job
from . import epoch_history_jobs as history,epoch_continuation as epochs,managed_actions as managed
from .data_evidence import _audit,_audit_binding,_object,_owner
from .epoch_history_plan import plan_epoch_history
from .implementation import implementation_hash
from .model_runtime import _clock

JOB_TYPE="investor_epoch_history_workflow"
SCHEMA="investor-epoch-history-workflow.schema.json"


def _check(value,code="INVALID"):
    if not value:raise WorkbenchError("HISTORY_WORKFLOW_"+code)


def _validate(value,kind):validate_contract(value,SCHEMA,fragment="$defs/"+kind)


def request_header(db,workspace,actor,identifier,at):
    _owner(db,workspace,actor)
    row=db.execute("SELECT * FROM investor_epoch_history_intents WHERE workspace_id=? AND id=?",(workspace,identifier)).fetchone();_check(row is not None and row["actor_id"]==actor,"OUT_OF_SCOPE")
    doc=_object(row["document_json"]);_validate(doc,"request");body=doc["body"]
    _audit_binding(db,row,"investor_request_history_workflow","investor_history_workflow_request",identifier)
    _check(canonical_json(doc)==row["document_json"] and content_hash(doc)==row["content_hash"] and doc["request_id"]==identifier and content_hash(body)==row["request_hash"]
        and all(doc[k]==row[k] for k in ("workspace_id","model_id","epoch_id","actor_id","request_hash","created_at","valid_until"))
        and body["model_id"]==row["model_id"] and body["action"]==row["action"] and body["expected_revision"]==row["expected_revision"] and body["idempotency_key"]==row["idempotency_key"]
        and body.get("preview_id")==row["preview_id"] and instant(row["created_at"])<=instant(at) and 0<(instant(row["valid_until"])-instant(row["created_at"])).total_seconds()<=300,"HEADER_CHANGED")
    model=db.execute("SELECT content_hash FROM investor_models WHERE id=? AND workspace_id=?",(row["model_id"],workspace)).fetchone()
    root=db.execute("SELECT content_hash,created_at,valid_until FROM investor_model_epochs WHERE id=? AND workspace_id=? AND model_id=?",(row["epoch_id"],workspace,row["model_id"])).fetchone()
    _check(model and root and doc["model_hash"]==model[0] and doc["registration_hash"]==root[0] and instant(root["created_at"])<=instant(row["created_at"])
        and instant(row["valid_until"])<=instant(root["valid_until"]),"HEADER_CHANGED")
    return row,doc


def job_result(doc):return {k:doc[k] for k in ("request_id","result_id","outcome","code","history_request","provider_calls","trading_permission")}


def result_header(db,workspace,actor,identifier,at):
    row=db.execute("SELECT * FROM investor_epoch_history_results WHERE id=? AND workspace_id=?",(identifier,workspace)).fetchone();_check(row is not None,"OUT_OF_SCOPE")
    request,original=request_header(db,workspace,actor,row["request_id"],at);doc=_object(row["document_json"]);_validate(doc,"result")
    _audit_binding(db,row,"investor_finish_history_workflow","investor_history_workflow_result",row["id"])
    job=db.execute("SELECT * FROM job_runs WHERE id=?",(row["job_id"],)).fetchone()
    attempt=db.execute("SELECT * FROM job_attempts WHERE job_id=? AND attempt=1",(row["job_id"],)).fetchone()
    _check(canonical_json(doc)==row["document_json"] and content_hash(doc)==row["content_hash"] and doc["result_id"]==row["id"] and doc["request_hash"]==request["content_hash"]
        and all(doc[k]==row[k] for k in ("request_id","workspace_id","model_id","epoch_id","actor_id","job_id","fencing_token","outcome","code","created_at"))
        and row["actor_id"]==actor and job and job["job_type"]==JOB_TYPE and job["scope"]==workspace and job["period"]==request["id"] and job["input_version"]==request["content_hash"]
        and job["command_request_id"] is None and job["status"]=="succeeded" and job["max_attempts"]==job["attempt_count"]==1 and job["lease_owner"] is None and job["lease_until"] is None
        and job["fencing_token"]==row["fencing_token"] and _object(job["result_json"])==job_result(doc)
        and attempt and attempt["status"]=="succeeded" and attempt["error_json"] is None and attempt["fencing_token"]==job["fencing_token"]
        and instant(request["created_at"])<=instant(attempt["started_at"]) and epochs._job_started_by_millisecond(attempt["started_at"],row["created_at"])
        and instant(row["created_at"])<=instant(attempt["finished_at"])<=instant(at) and attempt["finished_at"]==job["updated_at"]
        and instant(doc["valid_until"])<=instant(request["valid_until"]),"RESULT_CHANGED")
    _check(doc["code"]=="HISTORY_WORKFLOW_"+doc["outcome"].upper() if doc["outcome"]!="rejected" else doc["code"] not in ("HISTORY_WORKFLOW_PLAN_READY","HISTORY_WORKFLOW_DOWNLOAD_QUEUED"),"RESULT_CHANGED")
    if doc["outcome"]!="rejected":_check(instant(attempt["finished_at"])<instant(doc["valid_until"]),"RESULT_CHANGED")
    if doc["outcome"]=="plan_ready":
        plan=doc["plan"];_check(plan and doc["history_request"] is None and request["action"]=="prepare" and plan["workspace_revision"]==request["expected_revision"]
            and plan["workspace_id"]==workspace and plan["actor_id"]==actor and plan["model_id"]==request["model_id"] and plan["epoch"]["id"]==request["epoch_id"]
            and plan["registration_hash"]==original["registration_hash"] and plan["planned_at"]==request["created_at"] and plan["valid_until"]==doc["valid_until"]
            and plan["source_fence"]==doc["source_fence"] and content_hash({k:v for k,v in plan.items() if k not in ("checked_at","plan_hash")})==plan["plan_hash"],"PLAN_CHANGED")
    return row,doc,request,original


def discover_history_workflows(db,*,limit=100,now=None,stop_requested=None):
    at=_clock(now);_check(type(limit) is int and 1<=limit<=1000)
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investor_epoch_history_intents'").fetchone():return []
    assert_writable(db);managed._stopped(db,stop_requested);result=[]
    for row in db.execute("""SELECT r.* FROM investor_epoch_history_intents r LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.content_hash
      WHERE j.id IS NULL ORDER BY r.created_at,r.id LIMIT ?""",(JOB_TYPE,limit)).fetchall():
        request_header(db,row["workspace_id"],row["actor_id"],row["id"],at)
        result.append(enqueue_job(db,JOB_TYPE,row["workspace_id"],row["id"],row["content_hash"],max_attempts=1,now=at))
    return result


def _code(error):
    if str(error) in managed.STOP or str(error)=="STALE_OR_EXPIRED_LEASE":raise error
    if "EXPIRED" in str(error):return "HISTORY_WORKFLOW_EXPIRED"
    if "UNRESOLVED" in str(error) or "NO_DOWNLOAD_PLAN" in str(error):return "HISTORY_WORKFLOW_REVIEW_REQUIRED"
    if any(k in str(error) for k in ("CHANGED","VERSION","CONFLICT")):return "HISTORY_WORKFLOW_CHANGED"
    return "HISTORY_WORKFLOW_SOURCE_UNAVAILABLE"


def prepare_history_workflow_job(db,job,lease,*,clock=None,stop_requested=None):
    _check(not db.in_transaction,"PREPARATION_REQUIRES_AUTOCOMMIT");clock=clock or (lambda:None)
    def guard():
        at=_clock(clock());assert_writable(db);managed._stopped(db,stop_requested);live=assert_lease(db,lease,at)
        _check(all(live[k]==job[k] for k in ("id","job_type","scope","period","input_version","command_request_id","attempt_count","max_attempts")),"JOB_CHANGED")
        return at
    at=guard();raw=db.execute("SELECT actor_id FROM investor_epoch_history_intents WHERE id=? AND workspace_id=?",(job["period"],job["scope"])).fetchone();_check(raw is not None,"OUT_OF_SCOPE")
    row,doc=request_header(db,job["scope"],raw[0],job["period"],at);body=doc["body"]
    _check(job["job_type"]==JOB_TYPE and job["input_version"]==row["content_hash"] and job["command_request_id"] is None and job["max_attempts"]==job["attempt_count"]==1,"JOB_CHANGED")
    planned,prepared,failure=None,None,None
    try:
        _check(instant(at)<instant(row["valid_until"]),"EXPIRED");epochs._revision(db,row["workspace_id"],row["actor_id"],row["expected_revision"])
        if row["action"]=="prepare":
            planned=plan_epoch_history(db,row["workspace_id"],row["actor_id"],row["epoch_id"],now=at,planned_at=row["created_at"],stop_requested=stop_requested)
            _check(planned["model_hash"]==doc["model_hash"] and planned["registration_hash"]==doc["registration_hash"],"CHANGED")
        else:
            preview,value,prior,_=result_header(db,row["workspace_id"],row["actor_id"],body["preview_id"],at)
            _check(value["outcome"]=="plan_ready" and preview["content_hash"]==body["expected_preview_hash"] and prior["expected_revision"]==row["expected_revision"]
                and prior["epoch_id"]==row["epoch_id"] and prior["model_id"]==row["model_id"] and instant(at)<instant(value["valid_until"]),"PREVIEW_CHANGED")
            plan=value["plan"]
            submit={"schema_version":"investor-epoch-history-submit-v1","epoch_id":row["epoch_id"],"planned_at":plan["planned_at"],"expected_plan_hash":plan["plan_hash"],
                "expected_revision":row["expected_revision"],"max_calls":body["max_calls"],"idempotency_key":body["idempotency_key"],"acknowledgements":body["acknowledgements"]}
            prepared=history.prepare_epoch_history_confirmation(db,row["workspace_id"],row["actor_id"],submit,owner_interaction=True,now=at,clock=clock,stop_requested=stop_requested)
    except WorkbenchError as error:failure=_code(error)
    guard()
    def commit(connection):
        _check(connection is db,"CONNECTION_CHANGED");checked=guard();current,original=request_header(db,row["workspace_id"],row["actor_id"],row["id"],checked)
        _check(current["content_hash"]==row["content_hash"] and original==doc,"CHANGED")
        plan,download,code,deadline=None,None,failure,row["valid_until"]
        try:
            if planned:
                epochs._revision(db,row["workspace_id"],row["actor_id"],row["expected_revision"])
                _check(instant(at)<=instant(checked)<instant(planned["valid_until"]),"EXPIRED")
                _check(planned["source_fence"]==epochs._fence(db,row["workspace_id"],row["actor_id"]) and planned["implementation_hash"]==implementation_hash(),"CHANGED")
                plan=planned;deadline=min(deadline,plan["valid_until"],key=instant)
            if prepared:
                with transaction(db):download=prepared(db)
                deadline=min(deadline,download["valid_until"],key=instant)
        except WorkbenchError as error:plan,download,code=None,None,_code(error)
        # Nested history registration has its own clock; publish after it, never before it.
        checked=guard()
        outcome="plan_ready" if plan else "download_queued" if download else "rejected"
        identifier=new_id("history-workflow-result")
        value={"schema_version":"investor-epoch-history-workflow-result-v1","result_id":identifier,"request_id":row["id"],"workspace_id":row["workspace_id"],"model_id":row["model_id"],"epoch_id":row["epoch_id"],"actor_id":row["actor_id"],
            "request_hash":row["content_hash"],"job_id":job["id"],"fencing_token":lease.fencing_token,"outcome":outcome,"code":"HISTORY_WORKFLOW_"+outcome.upper() if outcome!="rejected" else code,
            "plan":plan,"history_request":{"id":download["request_id"],"content_hash":content_hash(download)} if download else None,
            "source_fence":epochs._fence(db,row["workspace_id"],row["actor_id"]) if outcome!="rejected" else None,"created_at":checked,"valid_until":deadline,"provider_calls":0,"monitoring_resumed":False,"trading_permission":False}
        _validate(value,"result");digest=content_hash(value);audit=_audit(db,row["actor_id"],"investor_finish_history_workflow","investor_history_workflow_result",identifier,{"content_hash":digest},checked)
        db.execute("INSERT INTO investor_epoch_history_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(identifier,row["id"],row["workspace_id"],row["model_id"],row["epoch_id"],job["id"],lease.fencing_token,outcome,value["code"],canonical_json(value),digest,row["actor_id"],checked,audit))
        return JobCommit(job_result(value))
    return {"effect":commit}


def assert_history_workflow_finalization(db,job,lease,result,outcome,finished):
    row=db.execute("SELECT * FROM investor_epoch_history_results WHERE job_id=? AND request_id=?",(job["id"],job["period"])).fetchone();_check(row is not None and outcome=="succeeded","FINALIZATION_CHANGED")
    doc=_object(row["document_json"]);_validate(doc,"result");request,original=request_header(db,job["scope"],row["actor_id"],job["period"],finished)
    _check(doc["fencing_token"]==lease.fencing_token and result==job_result(doc) and instant(row["created_at"])<=instant(finished),"FINALIZATION_CHANGED")
    if doc["outcome"]!="rejected":
        _check(instant(finished)<instant(doc["valid_until"]) and doc["source_fence"]==epochs._fence(db,row["workspace_id"],row["actor_id"]),"FINALIZATION_EXPIRED")
        if doc["plan"]:
            epochs._revision(db,row["workspace_id"],row["actor_id"],request["expected_revision"])
            _check(doc["plan"]["implementation_hash"]==implementation_hash(),"IMPLEMENTATION_CHANGED")
        if doc["history_request"]:
            saved,value=history.request_header(db,row["workspace_id"],row["actor_id"],doc["history_request"]["id"],finished)
            _check(epochs._ref(saved)==doc["history_request"] and value["body"]["idempotency_key"]==original["body"]["idempotency_key"],"FINALIZATION_CHANGED")
            history._live(db,saved,value,finished)
