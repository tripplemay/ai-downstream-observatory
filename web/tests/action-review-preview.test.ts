import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { investorFixture } from "./investor-fixture";
import { actionPython, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { readActionReviewPreview } from "../src/server/investor/action-review-lineage";
import { readActionReviewResponse } from "../src/server/investor/action-review-read";
import { actionReviewSymbols, enqueueActionReviewJob, findActionReviewRequest } from "../src/server/investor/action-review-jobs";
import { hash } from "../src/server/ledger/service";
import { actionReviewAttempt,parseActionReviewResponse } from "../src/components/workbench/investor-action-review-client";

type Obj=Record<string,unknown>;
const AT="2026-11-03T06:00:03.001Z",actor={id:"synthetic-investor"},binding="a".repeat(64);
function fixture(t:TestContext,mode="new") {
  const f=investorFixture();t.after(()=>f.close());
  const metadata=actionPython(f.filename,`
from tests.investor.test_action_review_workflow import ActionReviewWorkflowTests,AT
from worker.investor import action_review_jobs as jobs,action_review_workflow as workflow
from worker.orchestration.runtime import run_pending_once
from worker.orchestration.db import canonical_json
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=ActionReviewWorkflowTests();case.db=db;case.path=Path(sys.argv[1]);case.retained_reports(new_event=${mode === "none" ? "False":"True"},correction=${mode === "correction" ? "True":"False"})
request=jobs.enqueue_action_review_request(db,'w','synthetic-investor','preview',{'authority_id':case.authority['id'],'expected_revision':0,'idempotency_key':'fictional-view'},now=AT)
job=run_pending_once(db,'fictional-view-core',clock=lambda:AT);assert job['status']=='succeeded',job
result=json.loads(db.execute('SELECT document_json FROM investor_action_review_job_results').fetchone()[0])
view=workflow.resolve_action_review_preview(db,'w','synthetic-investor',result['resource_id'],now=AT)
print(canonical_json({'id':result['resource_id'],'expected':view,'authority_id':case.authority['id']}))
`);
  const read=(at=AT)=>readActionReviewPreview(f.db,"w",actor.id,metadata.id,at);
  return {...f,metadata,read};
}
test("independent private preview reproduces exact unapproved Python changes and old tax text without extending its witness",t=>{
  const f=fixture(t),before=f.db.prepare("SELECT total_changes() n").get(),value=f.read(),expected=f.metadata.expected as Obj;
  assert.deepEqual(value.preview,expected.preview);assert.deepEqual(value.changes,(expected.draft as Obj).changes);
  assert.equal(value.unchanged_tax_assumption,expected.unchanged_tax_assumption);assert.equal(value.confirmation_supported,true);
  assert.equal(f.read("2026-11-03T06:05:03.001Z").preview.valid_until,value.preview.valid_until);
  assert.equal(value.visibility,"private_owner_only_not_ai");assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),before);
  const response=readActionReviewResponse(f.db,actor,binding,null,AT);assert.deepEqual(response.view,value);assert.deepEqual(response.symbols,["VT.US"]);
});
test("actual private response and original client intent agree on nonce recovery without latest-request fallback or read mutations",async t=>{
  const f=fixture(t),intent={kind:"preview",symbol:"VT.US",expected_revision:0,idempotency_key:"fictional-view"},attempt=actionReviewAttempt(intent,binding,"w");
  const id=findActionReviewRequest(f.db,actor,attempt.nonce),before=f.db.prepare("SELECT total_changes() n").get();assert.ok(id);
  const response=readActionReviewResponse(f.db,actor,binding,id!,AT,{lookupNonce:attempt.nonce});
  assert.equal(response.request!.intent_hash,hash(intent));assert.deepEqual(await parseActionReviewResponse(response,binding,"w",Date.parse(AT),attempt),response);
  assert.equal(findActionReviewRequest(f.db,actor,"fictional-missing"),undefined);
  assert.equal(readActionReviewResponse(f.db,actor,binding,null,AT,{latest:false,lookupNonce:"fictional-missing"}).request,null);
  assert.throws(()=>findActionReviewRequest(f.db,{id:"foreign"},attempt.nonce));assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),before);
});
test("historical corrections and no-change batches remain visible but cannot use ordinary append confirmation",t=>{
  for(const [mode,status] of [["correction","historical_correction_required"],["none","no_reported_changes"]]) {
    const f=fixture(t,mode),value=f.read();assert.equal(value.status,status);assert.equal(value.confirmation_supported,false);
  }
});
test("expiry, owner and workspace-version changes never fall back to an earlier view",t=>{
  const f=fixture(t);assert.throws(()=>f.read("2026-11-03T06:16:03.001Z"),/VIEW_CHANGED/);
  assert.throws(()=>readActionReviewPreview(f.db,"w","foreign",f.metadata.id,AT));
  f.db.prepare("UPDATE investor_workspaces SET revision=revision+1 WHERE id='w'").run();
  assert.throws(()=>f.read(),/VIEW_CHANGED/);assert.equal(readActionReviewResponse(f.db,actor,binding,null,AT).view,null);
});
test("a self-resealed dependency hash or corrupted raw bytes cannot become a current private form",t=>{
  const f=fixture(t);
  probeActionMutation(f.db,["investor_action_review_previews","audit_events"],()=>{
    resealActionRow(f.db,"investor_action_review_previews",f.metadata.id as string,doc=>{doc.draft_basis_hash="0".repeat(64);});
  },()=>assert.throws(()=>f.read(),/VIEW_CHANGED/));
  probeActionMutation(f.db,["investor_issuer_payloads"],()=>{
    const row=f.db.prepare("SELECT rowid,payload FROM investor_issuer_payloads LIMIT 1").get() as {rowid:number;payload:Buffer};
    const data=Buffer.from(row.payload);data[0]^=1;f.db.prepare("UPDATE investor_issuer_payloads SET payload=? WHERE rowid=?").run(data,row.rowid);
  },()=>{assert.throws(()=>f.read());assert.equal(readActionReviewResponse(f.db,actor,binding,null,AT).preview_error,"ACTION_REVIEW_VIEW_UNAVAILABLE");});
});
test("current source withdrawal withholds every private preview fact while preserving the registered witness metadata",t=>{
  const f=fixture(t),witness=f.read().preview;
  actionPython(f.filename,`
from worker.investor import eodhd_sources
grant=db.execute("SELECT authority_id FROM investor_eodhd_requests WHERE symbol='VT.US' LIMIT 1").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${AT}')
print('{}')
`);
  assert.throws(()=>f.read());const response=readActionReviewResponse(f.db,actor,binding,null,AT);
  assert.equal(response.view,null);assert.equal(response.request!.resource_id,witness.preview_id);assert.equal(response.preview_error,"ACTION_REVIEW_VIEW_UNAVAILABLE");
});
test("an unrelated unretired rule is never resolved by newest-wins, even when it is disabled",t=>{
  const f=fixture(t);
  actionPython(f.filename,`
from worker.investor import managed_actions
policy=json.loads(db.execute("SELECT document_json FROM investor_action_authorities WHERE id=?",(${JSON.stringify(f.metadata.authority_id)},)).fetchone()[0])
policy['valid_until']='2026-11-09T00:00:00.000Z'
managed_actions.register_authority(db,'w','synthetic-investor',policy,now='${AT}')
print('{}')
`);
  assert.deepEqual(actionReviewSymbols(f.db,actor,AT),[]);assert.throws(()=>f.read(),/VIEW_CHANGED/);
  assert.equal(readActionReviewResponse(f.db,actor,binding,null,AT).view,null);
  assert.throws(()=>enqueueActionReviewJob(f.db,actor,{kind:"preview",symbol:"VT.US",expected_revision:1,idempotency_key:"fictional-ambiguous"},AT),/RULE_UNAVAILABLE/);
});
