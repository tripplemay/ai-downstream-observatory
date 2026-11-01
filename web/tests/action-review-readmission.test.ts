import assert from "node:assert/strict";
import test,{type TestContext} from "node:test";
import Database from "better-sqlite3";
import {actionPython,probeActionMutation,resealActionRow} from "./action-maintenance-fixture";
import {investorActor,investorFixture} from "./investor-fixture";
import {readInvestorMonitorEvidenceSource} from "../src/server/investor/monitor-source";
import {readEvidenceCheckpoint} from "../src/server/investor/evidence-monitor";
import {actionReviewSourceRetired} from "../src/server/investor/action-review-selection";
import {checkpointActionReview,readCheckpointMonitorSource} from "../src/server/investor/action-checkpoint-replay";
import {getInvestorState} from "../src/server/investor/service";
import {parseInvestorState} from "../src/components/workbench/investor-client";

type Obj=Record<string,unknown>;
const at="2026-11-03T06:00:04.001Z";
function fixture(t:TestContext) {
  const f=investorFixture();t.after(()=>f.close());
  const value=actionPython(f.filename,`
from tests.investor.test_action_review_readmission import ActionReviewReadmissionTests
from tests.investor.test_action_review_workflow import ActionReviewWorkflowTests,CONFIRM
from worker.investor import monitor_admission,monitor_data
from worker.orchestration.db import canonical_json
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=ActionReviewReadmissionTests();case.db=db;case.case=ActionReviewWorkflowTests();case.case.db=db;case.case.path=Path(sys.argv[1]);case.case.version=0
case.test_default_core_rebuilds_v4_from_completed_prices_and_explicit_review_preserving_old_inputs_checkpoints_and_attempts()
latest=monitor_admission.latest_monitor_evidence(db,'w',case.definition['model_id']);doc=json.loads(latest['document_json'])
projection=monitor_data.resolve_monitor_data(db,'w',case.definition,doc,now=CONFIRM)['projection']
states=[json.loads(row[0]) for row in db.execute('SELECT p.payload FROM investor_evidence_model_checkpoints c JOIN investor_evidence_checkpoint_payloads p ON p.checkpoint_id=c.id ORDER BY c.sequence')]
print(canonical_json({'definition':case.definition,'old_id':case.seed['id'],'id':latest['id'],'projection':projection,'confirmation':case.confirmed,'states':states}))
`);
  const model=f.db.prepare("SELECT * FROM investor_models").get() as Obj,headers=f.db.prepare("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence").all() as Obj[];
  return {...f,value,model,headers,definition:value.definition as Obj,confirmed:value.confirmation as Obj};
}

test("actual default-core succession is independently replayed through both old and new checkpoints and the ordinary state without current-source fallback",t=>{
  const f=fixture(t),before=f.db.prepare("SELECT total_changes() n").get();
  assert.equal(readInvestorMonitorEvidenceSource(f.db,"w",f.model.id as string,f.value.old_id as string,at).unavailable_reason,"REFERENCE_SOURCE_NO_LONGER_CURRENT");
  const current=readInvestorMonitorEvidenceSource(f.db,"w",f.model.id as string,f.value.id as string,at);
  assert.equal(current.unavailable_reason,null);assert.deepEqual(current.projection,f.value.projection);
  const checked=readEvidenceCheckpoint(f.db,"w",f.model,f.definition,f.headers[1].id,at);
  assert.equal(checked.unavailable_reason,null);assert.deepEqual(checked.checkpoint,(f.value.states as Obj[])[1]);
  const readonly=new Database(f.filename,{readonly:true,fileMustExist:true});
  try {assert.deepEqual(readEvidenceCheckpoint(readonly,"w",f.model,f.definition,f.headers[1].id,at),checked);
    assert.equal((readonly.prepare("SELECT total_changes() n").get() as Obj).n,0);
  } finally {readonly.close();}
  assert.equal(checkpointActionReview(f.db,"w",f.confirmed.previous_review_id,at),null);
  const state=getInvestorState(f.db,investorActor,at,{includeActionMaintenanceProgress:true});
  assert.ok(state.latest);assert.equal(state.model_watch?.id,f.model.id);assert.equal(state.live_advice_eligible,false);assert.equal(state.actual_holdings_status,"not_linked");
  const observation=f.db.prepare("SELECT id,outcome FROM investor_observations ORDER BY created_at DESC,rowid DESC LIMIT 1").get() as Obj;
  assert.equal(state.latest.id,observation.id);assert.equal(state.latest.document.outcome,observation.outcome);
  assert.deepEqual(parseInvestorState({...state,session_binding:"a".repeat(64)},"a".repeat(64)),state);
  assert.equal(readInvestorMonitorEvidenceSource(f.db,"w",f.model.id as string,f.value.old_id as string,at).projection,null);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),before);
  for(const table of ["portfolios","accounts","ledger_events","postings","approval_events","execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as Obj).n,0);
});

test("retirement denial is header-only; corrupt or resealed proofs cannot admit a historical checkpoint, and replay scopes never leak",t=>{
  const f=fixture(t),old=f.confirmed.previous_publication_id;
  const guarded={transaction:f.db.transaction.bind(f.db),prepare(sql:string){assert.doesNotMatch(sql,/SELECT\s+(?:payload|projection)\s+FROM\s+investor_(?:issuer|eodhd|price|confirmed)_payloads/i);return f.db.prepare(sql);}} as Database.Database;
  assert.equal(actionReviewSourceRetired(guarded,"w",old,at),true);
  assert.equal(actionReviewSourceRetired(f.db,"w",f.confirmed.new_review_id,at),false);
  assert.throws(()=>readCheckpointMonitorSource(f.db,"w",f.model,{...f.headers[0],projection_hash:"0".repeat(64)},at));
  probeActionMutation(f.db,["investor_action_review_confirmations","audit_events"],()=>{
    resealActionRow(f.db,"investor_action_review_confirmations",f.confirmed.confirmation_id as string,doc=>{(doc.append_proof as Obj).previous_snapshot_hash="0".repeat(64);});
  },()=>{
    assert.equal(actionReviewSourceRetired(f.db,"w",old,at),true);
    assert.throws(()=>readEvidenceCheckpoint(f.db,"w",f.model,f.definition,f.headers[1].id,at));
    assert.equal(checkpointActionReview(f.db,"w",old,at),null);
    assert.equal(readInvestorMonitorEvidenceSource(f.db,"w",f.model.id as string,f.value.old_id as string,at).projection,null);
  });
});

test("withdrawn upstream rights prevent historical replay without resurrecting old payloads or modifying immutable rows",t=>{
  const f=fixture(t),before=f.db.prepare("SELECT rowid,* FROM investor_evidence_model_checkpoints").all();
  actionPython(f.filename,`
from worker.investor import eodhd_sources
grant=db.execute("SELECT authority_id FROM investor_eodhd_requests WHERE symbol='VT.US' LIMIT 1").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${at}')
print('{}')
`);
  assert.throws(()=>readEvidenceCheckpoint(f.db,"w",f.model,f.definition,f.headers[1].id,at));
  assert.equal(checkpointActionReview(f.db,"w",f.confirmed.previous_review_id,at),null);
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM investor_evidence_model_checkpoints").all(),before);
});

test("an unrelated equal manual source cannot be silently shadowed by checkpoint succession",t=>{
  const f=fixture(t);
  actionPython(f.filename,`
from worker.investor.data_evidence import store_source,review_source
facts=json.loads(db.execute('SELECT document_json FROM investor_data_reviews WHERE id=?',('${f.confirmed.new_review_id}',)).fetchone()[0])['facts']
source=store_source(db,'w','synthetic-investor','actions',{'title':'Fictional unrelated overlap','reference':'synthetic://not-a-successor','excerpt':'Independent unrelated assertion, not verified market data'},now='${at}')
review_source(db,'w','synthetic-investor',source['id'],'approved',facts,'Fictional ambiguous overlap','2026-11-10T00:00:00.000Z',now='${at}')
print('{}')
`);
  assert.throws(()=>readEvidenceCheckpoint(f.db,"w",f.model,f.definition,f.headers[1].id,at));
  assert.equal(checkpointActionReview(f.db,"w",f.confirmed.previous_review_id,at),null);
  assert.equal(readInvestorMonitorEvidenceSource(f.db,"w",f.model.id as string,f.value.old_id as string,at).projection,null);
});
