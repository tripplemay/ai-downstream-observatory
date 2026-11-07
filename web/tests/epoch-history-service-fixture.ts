import assert from "node:assert/strict";
import type {TestContext} from "node:test";
import {writeFileSync,unlinkSync} from "node:fs";
import path from "node:path";
import {epochPrerequisiteFixture,epochPrerequisitePython,epochPrerequisiteValue} from "./epoch-prerequisite-fixture";
import {actionPython} from "./action-maintenance-fixture";
import {submitHistoryWorkflow,readHistoryWorkflowResponse} from "../src/server/investor/epoch-history-workflow";
import {historyAcknowledgements} from "../src/server/investor/epoch-history-schemas";
import {readEpochContinuationChain} from "../src/server/investor/epoch-continuation";
const NOW="2026-10-21T10:00:03.000Z",actor={id:"owner"},binding="0".repeat(64);
export function verifyHistoryService(t:TestContext){
 const f=epochPrerequisiteFixture();t.after(f.close);
 const seed=epochPrerequisitePython(f,`
from unittest.mock import patch
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.test_history_collection import EpochHistoryPlanTests
from tests.investor import epoch_continuation_source_fixture as sources
from tests.investor.epoch_source_fixture import current
from worker.investor import epoch_continuation as epochs
with offline_protocol_fixture():
 case=EpochHistoryPlanTests();case.db=db;case.path=Path(sys.argv[1]);case.saved=${epochPrerequisiteValue(f)};case.epoch_id=case.saved['registration']['epoch']['id']
 epochs.set_epoch_continuation_control(db,'w','owner',case.body(True),owner_interaction=True,now='2026-10-20T10:00:03.000Z')
 with patch.object(current,'prices',return_value=None):sources.next_sources(db,case.saved)
 print(json.dumps({'epoch':case.epoch_id,'model':case.saved['preview']['epoch_definition']['model_id']}))
`,"core_readmission");
 const model=seed.model as string,read=(at=NOW,nonce?:string)=>readHistoryWorkflowResponse(f.db,actor,binding,nonce?{nonce}:{model},at);
 const original=read();assert.equal(original.request,null);assert.equal(original.epoch!.enabled,true);
 const body={schema_version:"investor-epoch-history-workflow-submit-v1",action:"prepare",model_id:model,expected_revision:original.workspace_revision,idempotency_key:"fictional-node-history-prepare",acknowledged_plan_only:true};
 submitHistoryWorkflow(f.db,actor,body,NOW);const queued=read(NOW,body.idempotency_key);assert.equal(queued.request!.status,"queued");assert.equal(queued.preview,null);
 const before=f.db.prepare("SELECT count(*) n FROM investor_epoch_history_intents").get();submitHistoryWorkflow(f.db,actor,body,NOW);assert.deepEqual(f.db.prepare("SELECT count(*) n FROM investor_epoch_history_intents").get(),before);
 assert.throws(()=>submitHistoryWorkflow(f.db,actor,{...body,acknowledged_plan_only:false},NOW));
 const run=()=>actionPython(f.filename,`
from worker.orchestration.runtime import run_pending_once
value=run_pending_once(db,'fictional-node-history-core',clock=lambda:'${NOW}')
assert value['job_type']=='investor_epoch_history_workflow' and value['status']=='succeeded',value
print('{}')
`,"core_readmission");
 run();const ready=read();assert.equal(ready.request!.status,"plan_ready");assert.equal(ready.preview!.missing_date_count,2);assert.equal(ready.preview!.total_tiles,2);
 assert.equal(ready.workspace_revision,original.workspace_revision);assert.equal(ready.provider_calls,0);assert.equal(ready.trading_permission,false);
 const confirm={schema_version:body.schema_version,action:"confirm",model_id:model,expected_revision:ready.workspace_revision,idempotency_key:"fictional-node-history-confirm",preview_id:ready.preview!.id,
  expected_preview_hash:ready.preview!.content_hash,max_calls:2,acknowledgements:Object.fromEntries(historyAcknowledgements.map(k=>[k,true]))};
 for(const patch of [{expected_preview_hash:"f".repeat(64)},{expected_revision:ready.workspace_revision+1},{max_calls:5},{acknowledgements:{}}])assert.throws(()=>submitHistoryWorkflow(f.db,actor,{...confirm,...patch},NOW));
 submitHistoryWorkflow(f.db,actor,confirm,NOW);assert.equal(read().request!.status,"queued");run();const accepted=read();assert.equal(accepted.request!.status,"download_queued");
 assert.equal(accepted.workspace_revision,original.workspace_revision+1);assert.deepEqual(accepted.download!.slots.map(s=>s.status),["queued","queued"]);
 const saved=JSON.stringify(accepted.download);submitHistoryWorkflow(f.db,actor,confirm,NOW);assert.equal(JSON.stringify(read().download),saved);
 const marker=path.join(path.dirname(f.filename),"RESTORE_PENDING_REVIEW");writeFileSync(marker,"FICTIONAL HISTORY RECOVERY LOCK\n");
 try{assert.equal(read().read_only,true);assert.throws(()=>submitHistoryWorkflow(f.db,actor,confirm,NOW),/WORKBENCH_READ_ONLY/);}finally{unlinkSync(marker);}
 const done=actionPython(f.filename,`
from unittest.mock import patch
from tests.investor.test_history_collection import EpochHistoryPlanTests
from tests.investor.epoch_history_fixture import transport,default
from worker.investor import data_evidence,epoch_continuation as epochs
from worker.orchestration.db import instant
from datetime import timedelta
from worker.orchestration.runtime import run_pending_once
case=EpochHistoryPlanTests();case.db=db;case.path=Path(sys.argv[1]);clock=['${NOW}']
with transport(case,clock) as (calls,sdk):
 for index in range(2):
  if index:clock[0]=data_evidence._milliseconds(instant(clock[0])+timedelta(seconds=1))
  value=default(case,clock);assert value['status']=='succeeded',value
 assert len(calls)==sdk.call_count==2
value=run_pending_once(db,'fictional-history-post-download-core',clock=lambda:clock[0]);assert value['status']=='succeeded',value
chain=epochs.read_epoch_continuation_chain(db,'w','owner','${seed.epoch}',now=clock[0])
print(json.dumps({'at':clock[0],'chain':chain}))
`,"core_readmission");
 const finished=read(done.at as string);assert.deepEqual(finished.download!.slots.map(s=>s.status),["collected","collected"]);assert.ok(finished.download!.slots.every(s=>s.reserved));
 assert.deepEqual(readEpochContinuationChain(f.db,"w",actor,seed.epoch as string,done.at as string),done.chain);
 const job=f.db.prepare("SELECT id,result_json FROM job_runs WHERE job_type='investor_epoch_history_workflow' ORDER BY rowid DESC LIMIT 1").get() as {id:string;result_json:string};
 f.db.prepare("UPDATE job_runs SET result_json='{}' WHERE id=?").run(job.id);assert.throws(()=>read(done.at as string));f.db.prepare("UPDATE job_runs SET result_json=? WHERE id=?").run(job.result_json,job.id);
 assert.throws(()=>readHistoryWorkflowResponse(f.db,{id:"foreign"},binding,{model},done.at as string));
 for(const table of ["portfolios","accounts","ledger_events","postings"])assert.equal((f.db.prepare("SELECT count(*) n FROM "+table).get() as {n:number}).n,0);
}
