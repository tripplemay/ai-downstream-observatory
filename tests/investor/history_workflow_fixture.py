"""Audited fictional intents for actual core workflow and atomic-boundary tests."""
import json
from unittest.mock import patch
from worker.investor import epoch_history_workflow as workflow,epoch_history_jobs as history,epoch_continuation as epochs,data_evidence as evidence
from worker.orchestration.db import WorkbenchError,canonical_json,content_hash,new_id,instant
from worker.orchestration.jobs import claim_job,complete_job
from worker.orchestration.runtime import run_pending_once
from tests.investor.epoch_history_fixture import NOW,transport,default


def intent(case,action="prepare",preview=None,key="fictional-ordinary-history-prepare",at=NOW):
    db=case.db;revision=db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
    root=db.execute("SELECT * FROM investor_model_epochs WHERE id=?",(case.epoch_id,)).fetchone();model=db.execute("SELECT content_hash FROM investor_models WHERE id=?",(root["model_id"],)).fetchone()[0]
    body={"schema_version":"investor-epoch-history-workflow-submit-v1","action":action,"model_id":root["model_id"],"expected_revision":revision,"idempotency_key":key}
    if action=="prepare":body["acknowledged_plan_only"]=True
    else:body.update(preview_id=preview["id"],expected_preview_hash=preview["content_hash"],max_calls=2,acknowledgements={k:True for k in history.ACKS})
    until=preview["doc"]["valid_until"] if preview else evidence._milliseconds(instant(at)+workflow.timedelta(minutes=5))
    identifier=new_id("history-workflow-request")
    doc={"schema_version":"investor-epoch-history-workflow-request-v1","request_id":identifier,"workspace_id":"w","model_id":root["model_id"],"model_hash":model,"epoch_id":case.epoch_id,"registration_hash":root["content_hash"],
        "actor_id":"owner","body":body,"request_hash":content_hash(body),"created_at":at,"valid_until":until,"trading_permission":False}
    workflow._validate(doc,"request");digest=content_hash(doc);audit=evidence._audit(db,"owner","investor_request_history_workflow","investor_history_workflow_request",identifier,{"content_hash":digest},at)
    db.execute("INSERT INTO investor_epoch_history_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(identifier,"w",root["model_id"],case.epoch_id,action,revision,body.get("preview_id"),key,content_hash(body),canonical_json(doc),digest,"owner",at,until,audit))
    return doc


def run(case,at=NOW,clock=None):
    clock=clock or (lambda:at)
    result=run_pending_once(case.db,"fictional-default-history-workflow",clock=clock)
    case.assertIsNotNone(result);case.assertEqual(result["job_type"],workflow.JOB_TYPE,result);case.assertEqual(result["status"],"succeeded",result)
    doc=json.loads(result["result_json"]);row,value,_,_=workflow.result_header(case.db,"w","owner",doc["result_id"],clock())
    return {**dict(row),"doc":value}


def positive(case):
    case.seed();before=case.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0];request=intent(case)
    preview=run(case);case.assertEqual(preview["outcome"],"plan_ready");case.assertEqual(preview["doc"]["plan"]["missing_date_count"],2)
    case.assertEqual(case.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0],before)
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_requests").fetchone()[0],0)
    intent(case,"confirm",preview,"fictional-ordinary-history-confirm")
    tick=[instant(NOW)]
    def advancing():
        tick[0]+=workflow.timedelta(milliseconds=1)
        return evidence._milliseconds(tick[0])
    registered=run(case,clock=advancing)
    case.assertEqual(registered["outcome"],"download_queued")
    case.assertEqual(case.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0],before+1)
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_slots").fetchone()[0],2)
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_attempts").fetchone()[0],0)
    saved,batch=history.request_header(case.db,"w","owner",registered["doc"]["history_request"]["id"],advancing())
    case.assertLessEqual(instant(saved["created_at"]),instant(registered["created_at"]))
    case.assertEqual({k:v for k,v in batch["plan"].items() if k!="checked_at"},
        {k:v for k,v in preview["doc"]["plan"].items() if k!="checked_at"})
    case.assertLessEqual(instant(preview["doc"]["plan"]["checked_at"]),instant(batch["plan"]["checked_at"]))
    case.assertEqual(workflow.discover_history_workflows(case.db,now=NOW),[])
    clock=[advancing()];prepare=evidence.prepare_prices
    def delayed_capture(*args,**kwargs):
        save=prepare(*args,**kwargs)
        def commit(connection):
            clock[0]=evidence._milliseconds(instant(clock[0])+workflow.timedelta(milliseconds=1))
            return save(connection)
        return commit
    with transport(case,clock) as (calls,sdk),patch.object(evidence,"prepare_prices",side_effect=delayed_capture):
        collected=default(case,clock)
    case.assertEqual(collected["status"],"succeeded",collected);case.assertEqual(len(calls),1);case.assertEqual(sdk.call_count,1)
    capture=case.db.execute("SELECT c.created_at capture_at,r.created_at run_at FROM investor_epoch_history_runs r JOIN investor_price_captures c ON c.id=r.capture_id").fetchone()
    case.assertIsNotNone(capture);case.assertLessEqual(instant(capture["capture_at"]),instant(capture["run_at"]))
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_attempts").fetchone()[0],1)
    for table in ("portfolios","accounts","ledger_events","postings"):case.assertEqual(case.db.execute("SELECT count(*) FROM "+table).fetchone()[0],0)


def final_fences(case):
    case.seed();intent(case);preview=run(case);request=intent(case,"confirm",preview,"fictional-workflow-final-boundary")
    workflow.discover_history_workflows(case.db,now=NOW)
    lease=claim_job(case.db,"fictional-workflow-manual-lease",job_type=workflow.JOB_TYPE,lease_seconds=1200,now=NOW)
    case.assertIsNotNone(lease);job=dict(case.db.execute("SELECT * FROM job_runs WHERE id=?",(lease.job_id,)).fetchone());prepared=workflow.prepare_history_workflow_job(case.db,job,lease,clock=lambda:NOW)
    before=list(case.db.iterdump());audit=workflow._audit
    def late(*args,**kwargs):
        if args[2]=="investor_finish_history_workflow":raise WorkbenchError("FICTIONAL_LATE_HISTORY_WORKFLOW")
        return audit(*args,**kwargs)
    with patch.object(workflow,"_audit",side_effect=late):
        with case.assertRaisesRegex(WorkbenchError,"FICTIONAL_LATE_HISTORY_WORKFLOW"):complete_job(case.db,lease,{},effect=prepared["effect"],now=NOW,clock=lambda:NOW)
    case.assertEqual(before,list(case.db.iterdump()))
    with case.assertRaises(WorkbenchError):complete_job(case.db,lease,{},effect=prepared["effect"],now=NOW,clock=lambda:request["valid_until"])
    case.assertEqual(before,list(case.db.iterdump()))
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_requests").fetchone()[0],0)


def cancelled(case):
    case.seed();intent(case);workflow.discover_history_workflows(case.db,now=NOW)
    lease=claim_job(case.db,"fictional-workflow-stop",job_type=workflow.JOB_TYPE,now=NOW);job=dict(case.db.execute("SELECT * FROM job_runs WHERE id=?",(lease.job_id,)).fetchone())
    with patch.object(workflow,"plan_epoch_history",side_effect=AssertionError("NO_STOPPED_HISTORY_REPLAY")) as replay:
        with case.assertRaisesRegex(WorkbenchError,"WORKER_STOP_REQUESTED"):workflow.prepare_history_workflow_job(case.db,job,lease,clock=lambda:NOW,stop_requested=lambda:True)
    replay.assert_not_called()
    epochs.set_epoch_continuation_control(case.db,"w","owner",case.body(False),owner_interaction=True,now=NOW)
    prepared=workflow.prepare_history_workflow_job(case.db,job,lease,clock=lambda:NOW);complete_job(case.db,lease,{},effect=prepared["effect"],now=NOW,clock=lambda:NOW)
    result=case.db.execute("SELECT * FROM investor_epoch_history_results").fetchone();case.assertEqual(result["outcome"],"rejected")
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_attempts").fetchone()[0],0)
