import assert from "node:assert/strict";
import type {TestContext} from "node:test";
import {writeFileSync,unlinkSync} from "node:fs";
import path from "node:path";
import {investorFixture} from "./investor-fixture";
import {actionPython} from "./action-maintenance-fixture";
import {canonical,hash} from "../src/server/ledger/service";
import {readHistoryWorkflowResponse,readHistoryResolutionResponse,submitHistoryWorkflow} from "../src/server/investor/epoch-history-workflow";
import {acknowledgeHistoryUnknown,readHistoryResolutionHeader} from "../src/server/investor/epoch-history-resolution";
import {historyWorkflowReviewResponseSchema} from "../src/server/investor/epoch-history-schemas";
import {historyResolutionAcknowledgements} from "../src/server/investor/epoch-history-resolution-schemas";
const NOW="2026-10-21T10:00:03.000Z",actor={id:"owner"},binding="0".repeat(64);
export function verifyHistoryResolutionService(t:TestContext){for(const expired of [false,true]){
 const f=investorFixture();t.after(f.close);
 const seeded=actionPython(f.filename,`
from unittest.mock import patch
from datetime import timedelta
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.test_history_collection import EpochHistoryPlanTests
from tests.investor.epoch_history_fixture import body,confirm,transport,default,NOW
from worker.investor import epoch_history_jobs as history,data_evidence
from worker.orchestration.jobs import claim_job
from worker.orchestration.db import instant
with offline_protocol_fixture():
 case=EpochHistoryPlanTests();case.db=db;case.path=Path(sys.argv[1]);case.seed();parent=confirm(case,body(case,calls=${expired?1:2}));clock=[NOW]
 with transport(case,clock,fail_on=${expired?"None":"1"}) as (calls,sdk):
  if ${expired?"True":"False"}:
   lease=claim_job(db,'fictional-crashed-history',job_type=history.JOB_TYPE,lease_seconds=60,now=NOW)
   job=dict(db.execute('SELECT * FROM job_runs WHERE id=?',(lease.job_id,)).fetchone())
   history.prepare_epoch_history_job(db,job,lease,clock=lambda:clock[0])
  else:
   result=default(case,clock);assert result['status']=='failed',result
  assert len(calls)==sdk.call_count==1
 if ${expired?"True":"False"}:
  end=data_evidence._milliseconds(instant(parent['valid_until'])+timedelta(seconds=1))
  assert claim_job(db,'fictional-expire-crash',job_type=history.JOB_TYPE,now=end) is None
 else:end=parent['valid_until']
 at=data_evidence._milliseconds(instant(end)+timedelta(seconds=31))
 slot=db.execute('SELECT id FROM investor_epoch_history_slots WHERE slot_index=0').fetchone()[0]
 print(json.dumps({'model':parent['model_id'],'slot':slot,'at':at,'calls':len(calls),'expired':${expired?"True":"False"}}))
`,"core_readmission");
 const model=seeded.model as string;let at=seeded.at as string;
 const read=(now=at)=>historyWorkflowReviewResponseSchema.parse(readHistoryWorkflowResponse(f.db,actor,binding,{model},now,true));
 if(!expired){const pending=read();assert.equal(pending.download!.slots[0].review!.eligible,false,"a queued sibling still blocks acknowledgement after the original batch deadline");
  const drained=actionPython(f.filename,`
from worker.investor import epoch_history_jobs as history,data_evidence
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import command_handler
from worker.orchestration.db import instant
from datetime import timedelta
value=run_one(db,'fictional-drain-stopped-sibling',command_handler(db,clock=lambda:'${at}',role='longport'),job_type=history.JOB_TYPE,clock=lambda:'${at}')
assert value['status']=='skipped',value
print(json.dumps({'at':data_evidence._milliseconds(instant('${at}')+timedelta(seconds=31))}))
`,"core_readmission");at=drained.at as string;}
 const v=read(),review=v.download!.slots[0].review!;assert.equal(v.download!.slots[0].status,"unknown");assert.equal(review.eligible,true);
 if(!expired)assert.throws(()=>read(NOW),/CHANGED/,"a clock before the now-completed sibling must not hide its recorded finish");
 const input={schema_version:"investor-epoch-history-resolution-submit-v1",action:"acknowledge_unknown",model_id:model,expected_revision:v.workspace_revision,idempotency_key:"fictional-resolution-"+(expired?"expired":"unknown"),
  batch:review.batch,slot:review.slot,attempt:review.attempt,state_hash:review.state_hash,reviewed_at:review.reviewed_at,valid_until:review.valid_until,acknowledgements:Object.fromEntries(historyResolutionAcknowledgements.map(k=>[k,true]))};
 const tables=["investor_epoch_history_requests","investor_epoch_history_slots","investor_epoch_history_attempts","investor_epoch_history_runs","job_runs","job_attempts"];
 const old=()=>canonical(Object.fromEntries(tables.map(name=>[name,f.db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()]))),unchanged=old();
 const snapshot=()=>canonical(Object.fromEntries([...tables,"investor_epoch_history_resolutions","audit_events","investor_workspaces"].map(name=>[name,f.db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()])));
 const before=snapshot();for(const patch of [{state_hash:"9".repeat(64)},{model_id:"foreign"},{expected_revision:v.workspace_revision+1},{acknowledgements:{}},{valid_until:at},{reviewed_at:new Date(Date.parse(at)+1).toISOString()},{valid_until:new Date(Date.parse(at)+600000).toISOString()},{reviewed_at:NOW}])assert.throws(()=>acknowledgeHistoryUnknown(f.db,actor,{...input,...patch},at));
 assert.throws(()=>acknowledgeHistoryUnknown(f.db,{id:"foreign"},input,at));assert.equal(snapshot(),before);
 f.db.exec("CREATE TEMP TRIGGER fictional_late_resolution BEFORE UPDATE ON investor_workspaces BEGIN SELECT RAISE(ABORT,'FICTIONAL_LATE_RESOLUTION'); END;");
 try{assert.throws(()=>acknowledgeHistoryUnknown(f.db,actor,input,at),/FICTIONAL_LATE_RESOLUTION/);}finally{f.db.exec("DROP TRIGGER fictional_late_resolution");}
 assert.equal(snapshot(),before);
 let ticks=0;assert.throws(()=>acknowledgeHistoryUnknown(f.db,actor,input,at,()=>++ticks===1?at:input.valid_until),/EXPIRED/);assert.equal(ticks,2);assert.equal(snapshot(),before,"the final clock fence rolls back consent, audit and revision together");
 const doc=acknowledgeHistoryUnknown(f.db,actor,input,at),saved=snapshot();assert.equal(doc.old_outcome_known,false);assert.equal(doc.new_download_authorized,false);assert.equal(old(),unchanged);
 assert.equal(read().workspace_revision,v.workspace_revision+1);assert.equal(read().download!.slots[0].status,"acknowledged_unknown");
 assert.equal(readHistoryWorkflowResponse(f.db,actor,binding,{model},at).download!.slots[0].status,"unknown","old unnegotiated clients keep the original protocol");
 assert.deepEqual(acknowledgeHistoryUnknown(f.db,actor,input,at),doc);assert.equal(snapshot(),saved);
 assert.deepEqual(acknowledgeHistoryUnknown(f.db,actor,input,new Date(Date.parse(at)+600000).toISOString()),doc);assert.equal(snapshot(),saved,"late exact nonce reads do not renew the original review or enqueue work");
 assert.throws(()=>acknowledgeHistoryUnknown(f.db,actor,{...input,idempotency_key:"fictional-other-resolution"},at));
 assert.throws(()=>submitHistoryWorkflow(f.db,actor,{schema_version:"investor-epoch-history-workflow-submit-v1",action:"prepare",model_id:model,expected_revision:v.workspace_revision+1,idempotency_key:input.idempotency_key,acknowledged_plan_only:true},at),/DUPLICATE_CONFLICT/);
 const response=readHistoryResolutionResponse(f.db,actor,binding,input.idempotency_key,at);assert.equal(response.lookup_nonce,input.idempotency_key);assert.equal(response.resolution_result!.intent_hash,hash(input));assert.equal(response.provider_calls,0);
 const marker=path.join(path.dirname(f.filename),"RESTORE_PENDING_REVIEW");writeFileSync(marker,"FICTIONAL RESOLUTION RECOVERY LOCK\n");
 try{assert.equal(read().read_only,true);assert.throws(()=>acknowledgeHistoryUnknown(f.db,actor,input,at),/WORKBENCH_READ_ONLY/);}finally{unlinkSync(marker);}
 const proof=actionPython(f.filename,`
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.test_history_collection import EpochHistoryPlanTests
from tests.investor.epoch_history_fixture import body,confirm
from worker.investor import epoch_history_resolution as resolution,epoch_history_jobs as history
with offline_protocol_fixture():
 row,record=resolution.read_resolution(db,'w','owner','${seeded.slot}','${at}')
 assert record['old_outcome_known'] is record['new_download_authorized'] is False
 case=EpochHistoryPlanTests();case.db=db;case.path=Path(sys.argv[1]);case.epoch_id=db.execute('SELECT epoch_id FROM investor_epoch_history_requests LIMIT 1').fetchone()[0]
 request=body(case,'${at}',calls=1,key='fictional-separate-after-acknowledgement')
 before=db.execute('SELECT count(*) FROM job_runs').fetchone()[0]
 fresh=confirm(case,request,'${at}')
 assert db.execute('SELECT count(*) FROM job_runs').fetchone()[0]==before+1
 assert db.execute('SELECT count(*) FROM investor_epoch_history_attempts').fetchone()[0]==1
 assert db.execute("SELECT count(*) FROM investor_epoch_history_runs WHERE status='collected'").fetchone()[0]==0
 assert history._unresolved(db,'w',fresh['plan']['tiles'][0],'${at}') is True
 print(json.dumps({'record':record,'fresh_calls':fresh['authorized_calls'],'new_jobs':1}))
`,"core_readmission");
 assert.deepEqual(proof.record,doc);assert.equal(proof.fresh_calls,1);assert.equal(proof.new_jobs,1);
 const job=f.db.prepare("SELECT j.id,j.result_json FROM job_runs j JOIN investor_epoch_history_attempts a ON a.job_id=j.id").get() as {id:string;result_json:string};
 f.db.prepare("UPDATE job_runs SET result_json='{}' WHERE id=?").run(job.id);assert.throws(()=>readHistoryResolutionHeader(f.db,actor,doc.resolution_id,at));f.db.prepare("UPDATE job_runs SET result_json=? WHERE id=?").run(job.result_json,job.id);
 for(const sql of ["UPDATE investor_epoch_history_resolutions SET actor_id=actor_id","DELETE FROM investor_epoch_history_resolutions"])assert.throws(()=>f.db.exec(sql),/immutable/);
 for(const table of ["portfolios","accounts","ledger_events","postings"])assert.equal((f.db.prepare("SELECT count(*) n FROM "+table).get() as {n:number}).n,0);
 assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(),[]);assert.equal((f.db.prepare("PRAGMA integrity_check").get() as {integrity_check:string}).integrity_check,"ok");
}}
