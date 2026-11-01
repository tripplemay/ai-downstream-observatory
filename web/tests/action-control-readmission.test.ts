import assert from "node:assert/strict";
import test,{type TestContext} from "node:test";
import Database from "better-sqlite3";
import {actionPython} from "./action-maintenance-fixture";
import {investorActor,investorFixture} from "./investor-fixture";
import {readInvestorMonitorEvidenceSource} from "../src/server/investor/monitor-source";
import {readEvidenceCheckpoint} from "../src/server/investor/evidence-monitor";
import {checkpointActionReview,readCheckpointMonitorSource} from "../src/server/investor/action-checkpoint-replay";
import {getInvestorState} from "../src/server/investor/service";
import {parseInvestorState} from "../src/components/workbench/investor-client";

type Obj=Record<string,unknown>;
const at="2026-11-03T06:00:03.001Z";
function fixture(t:TestContext) {
  const f=investorFixture();t.after(()=>f.close());
  const value=actionPython(f.filename,`
from tests.investor.test_action_control_readmission import ActionControlReadmissionTests,AT
from tests.investor.test_action_refresh import ActionRefreshTests
from worker.investor import monitor_admission,monitor_data
from worker.orchestration.db import canonical_json
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=ActionControlReadmissionTests();case.db=db;case.case=ActionRefreshTests();case.case.db=db;case.case.path=Path(sys.argv[1]);case.case.version=0
case.test_default_core_advances_an_existing_v4_checkpoint_after_explicit_pause_resume_and_qualified_new_publication()
latest=monitor_admission.latest_monitor_evidence(db,'w',case.definition['model_id']);doc=json.loads(latest['document_json'])
projection=monitor_data.resolve_monitor_data(db,'w',case.definition,doc,now=AT)['projection']
states=[json.loads(row[0]) for row in db.execute('SELECT p.payload FROM investor_evidence_model_checkpoints c JOIN investor_evidence_checkpoint_payloads p ON p.checkpoint_id=c.id ORDER BY c.sequence')]
print(canonical_json({'definition':case.definition,'old_id':case.seed['id'],'old_review':case.old,'current':case.current,'authority':case.case.authority['id'],'id':latest['id'],'projection':projection,'states':states}))
`,"core_readmission");
  const model=f.db.prepare("SELECT * FROM investor_models").get() as Obj,headers=f.db.prepare("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence").all() as Obj[];
  return {...f,value,model,headers,definition:value.definition as Obj};
}
function denied(operation:()=>{checkpoint:unknown;unavailable_reason:unknown}) {
  let result:ReturnType<typeof operation>;
  try {result=operation();}catch{return;}
  assert.equal(result.checkpoint,null);assert.ok(result.unavailable_reason);
}

test("same-rule pause/resume advances real core checkpoints and independently replays ordinary state without reviving old current input",t=>{
  const f=fixture(t),before=f.db.prepare("SELECT total_changes() n").get();
  assert.equal(f.headers.length,2);
  assert.equal(readInvestorMonitorEvidenceSource(f.db,"w",f.model.id as string,f.value.old_id as string,at).unavailable_reason,"REFERENCE_SOURCE_NO_LONGER_CURRENT");
  assert.deepEqual(readInvestorMonitorEvidenceSource(f.db,"w",f.model.id as string,f.value.id as string,at).projection,f.value.projection);
  const checked=readEvidenceCheckpoint(f.db,"w",f.model,f.definition,f.headers[1].id,at);
  assert.equal(checked.unavailable_reason,null);assert.deepEqual(checked.checkpoint,(f.value.states as Obj[])[1]);
  const readonly=new Database(f.filename,{readonly:true,fileMustExist:true});
  try {assert.deepEqual(readEvidenceCheckpoint(readonly,"w",f.model,f.definition,f.headers[1].id,at),checked);
    assert.equal((readonly.prepare("SELECT total_changes() n").get() as Obj).n,0);
  }finally{readonly.close();}
  const state=getInvestorState(f.db,investorActor,at,{includeActionMaintenanceProgress:true});
  const observation=f.db.prepare("SELECT id FROM investor_observations ORDER BY created_at DESC,rowid DESC LIMIT 1").get() as Obj;
  assert.equal(state.latest?.id,observation.id);assert.equal(state.live_advice_eligible,false);
  assert.deepEqual(parseInvestorState({...state,session_binding:"a".repeat(64)},"a".repeat(64)),state);
  assert.equal(checkpointActionReview(f.db,"w",f.value.old_review,at),null);
  assert.equal(readInvestorMonitorEvidenceSource(f.db,"w",f.model.id as string,f.value.old_id as string,at).projection,null);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),before);
});

test("exact checkpoint binding and a later maintenance stop cannot be bypassed by historical replay",t=>{
  const f=fixture(t),before=f.db.prepare("SELECT rowid,* FROM investor_evidence_model_checkpoints").all();
  assert.throws(()=>readCheckpointMonitorSource(f.db,"w",f.model,{...f.headers[0],projection_hash:"0".repeat(64)},at));
  actionPython(f.filename,`
from worker.investor import managed_actions
managed_actions.set_authority_enabled(db,'w','synthetic-investor','${f.value.authority}',False,now='${at}')
print('{}')
`);
  denied(()=>readEvidenceCheckpoint(f.db,"w",f.model,f.definition,f.headers[1].id,at));
  actionPython(f.filename,`
from worker.investor import managed_actions
managed_actions.set_authority_enabled(db,'w','synthetic-investor','${f.value.authority}',True,now='${at}')
print('{}')
`);
  denied(()=>readEvidenceCheckpoint(f.db,"w",f.model,f.definition,f.headers[1].id,at));
  assert.equal(checkpointActionReview(f.db,"w",f.value.old_review,at),null);
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM investor_evidence_model_checkpoints").all(),before);
});

test("same-rule replay preserves unrelated overlap ambiguity",t=>{
  const f=fixture(t);
  actionPython(f.filename,`
from worker.investor.data_evidence import store_source,review_source,resolve_review
facts=resolve_review(db,'w','${f.value.current}','actions',now='${at}')['facts']
source=store_source(db,'w','synthetic-investor','actions',{'title':'Fictional overlap','reference':'synthetic://unrelated-control','excerpt':'No successor relation and no market evidence'},now='${at}')
review_source(db,'w','synthetic-investor',source['id'],'approved',facts,'Fictional overlap','2026-11-10T00:00:00.000Z',now='${at}')
print('{}')
`);
  denied(()=>readEvidenceCheckpoint(f.db,"w",f.model,f.definition,f.headers[1].id,at));
  assert.equal(checkpointActionReview(f.db,"w",f.value.old_review,at),null);
});

test("upstream withdrawal independently prevents same-rule replay",t=>{
  const f=fixture(t);
  actionPython(f.filename,`
from worker.investor import eodhd_sources
grant=db.execute("SELECT authority_id FROM investor_eodhd_requests WHERE symbol='VT.US' LIMIT 1").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${at}')
print('{}')
`);
  denied(()=>readEvidenceCheckpoint(f.db,"w",f.model,f.definition,f.headers[1].id,at));
  assert.equal(checkpointActionReview(f.db,"w",f.value.old_review,at),null);
});
