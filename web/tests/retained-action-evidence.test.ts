import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { actionMaintenanceFixture, actionPython, LATER, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { readManagedActionReview, readRetainedActionEvidence } from "../src/server/investor/managed-action-source";
import type { ActionObject as Obj } from "../src/server/investor/action-source-parsers";
import { investorFixture } from "./investor-fixture";
import { readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { verifyActionRestatementArithmetic } from "../src/server/investor/action-restatement-kernel";

const OWNER="synthetic-investor";
// The subprocess receives only its generated fictional DB, never credentials.
function correct(f:ReturnType<typeof actionMaintenanceFixture>,decision="approved") {
  return actionPython(f.filename,`
from worker.investor import data_evidence as evidence
base=db.execute('SELECT * FROM investor_data_reviews WHERE id=?',('${f.metadata.base_review_id}',)).fetchone()
facts=json.loads(base['document_json'])['facts'];facts['events'][0]['gross_per_unit']='988.1234'
changed=evidence.review_source(db,'w','${OWNER}',base['source_id'],'${decision}',facts if '${decision}'=='approved' else None,
 'Fictional historical correction, not investment consent','2027-01-01T00:00:00.000Z',now='${LATER}')
print(json.dumps({'id':changed['id']}))
`);
}
function read(f:ReturnType<typeof actionMaintenanceFixture>,id:string,db=f.db) {
  return readRetainedActionEvidence(db,"w",OWNER,id,LATER);
}
function publication(f:ReturnType<typeof actionMaintenanceFixture>) { return (f.metadata.publications as Obj[])[1].publication_id as string; }

test("Node independently replays original reports after a real owner correction, exactly matching Python without current restoration",t=>{
  const f=actionMaintenanceFixture(t),id=publication(f),changed=correct(f),before=f.db.prepare("SELECT total_changes() n").get();
  const originalRows=f.db.prepare("SELECT rowid,* FROM investor_action_publications ORDER BY rowid").all();
  const expected=actionPython(f.filename,`
from worker.investor.retained_action_evidence import read_retained_action_evidence as read
before=db.total_changes
values=[read(db,'w','${OWNER}',identifier,now='${LATER}') for identifier in ('${id}','${f.metadata.base_review_id}')]
assert db.total_changes==before
print(json.dumps({'values':values}))
`).values as Obj[];
  for(const [index,identifier] of [id,f.metadata.base_review_id as string].entries()) {
    const value=read(f,identifier);assert.deepEqual(value,expected[index]);
    assert.equal(value.proof.latest_manual_review_id,changed.id);
    assert.equal(Object.hasOwn(value,"row"),false);assert.equal(Object.hasOwn(value,"facts"),false);
    for(const key of ["current_source_eligibility_restored","economic_correction_approved","checkpoint_created","monitoring_resumed",
      "historical_observations_rewritten","trading_permission"])assert.equal((value.proof as Obj)[key],false);
    assert.equal(value.proof.provider_calls,0);assert.equal(value.proof.database_writes,0);
  }
  assert.throws(()=>readManagedActionReview(f.db,"w",id,LATER));
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),before);
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM investor_action_publications ORDER BY rowid").all(),originalRows);
});

test("retiring maintenance does not erase readable original evidence or silently clear controls",t=>{
  const f=actionMaintenanceFixture(t),id=publication(f);correct(f);
  actionPython(f.filename,`
from worker.investor import managed_actions as m
m.set_authority_enabled(db,'w','${OWNER}','${f.metadata.authority_id}',False,now='${LATER}')
print('{}')
`);
  const before=f.db.prepare("SELECT rowid,* FROM investor_action_controls ORDER BY rowid").all();
  assert.equal(read(f,id).proof.original_raw_reports_replayed,true);
  assert.throws(()=>readManagedActionReview(f.db,"w",id,LATER));
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM investor_action_controls ORDER BY rowid").all(),before);
});

test("both actual current provider controls remain mandatory for historical raw replay",async t=>{
  for(const kind of ["issuer","eodhd"])await t.test(kind,t=>{
    const f=actionMaintenanceFixture(t),id=publication(f);correct(f);
    actionPython(f.filename,`
from worker.investor import ${kind}_sources as source
authority=db.execute('SELECT id FROM investor_${kind}_authorities ORDER BY rowid LIMIT 1').fetchone()[0]
source.set_authority_enabled(db,'w','${OWNER}',authority,False,now='${LATER}')
print('{}')
`);
    assert.throws(()=>read(f,id));
  });
});

test("retained evidence rejects modified original bytes, missing payload and self-resealed false publication summaries",t=>{
  const f=actionMaintenanceFixture(t),id=publication(f);correct(f);
  const issuer=(read(f,id).proof.capture_bindings as Obj[]).find(row=>row.slot === "anchor_issuer")!;
  for(const statement of ["UPDATE investor_issuer_payloads SET payload=zeroblob(raw_bytes) WHERE raw_sha256=?",
    "DELETE FROM investor_issuer_payloads WHERE raw_sha256=?"]) {
    probeActionMutation(f.db,["investor_issuer_payloads"],()=>f.db.prepare(statement).run(issuer.raw_sha256),()=>assert.throws(()=>read(f,id)));
  }
  probeActionMutation(f.db,["investor_action_publications","audit_events"],()=>
    resealActionRow(f.db,"investor_action_publications",id,doc=>{doc.checked_input_hash="0".repeat(64);}),()=>assert.throws(()=>read(f,id)));
  assert.equal(read(f,id).proof.original_raw_reports_replayed,true);
});

test("withdrawal, including an intervening withdrawal followed by approval, is not a historical-read bypass",t=>{
  const f=actionMaintenanceFixture(t),id=publication(f);correct(f,"withdrawn");
  assert.throws(()=>read(f,id));assert.throws(()=>read(f,f.metadata.base_review_id as string));
  correct(f);assert.throws(()=>read(f,id));
});

test("foreign scope, future records, latest expiry and changed identity fail rather than substitute current facts",t=>{
  const f=actionMaintenanceFixture(t),id=publication(f);correct(f);
  assert.throws(()=>readRetainedActionEvidence(f.db,"foreign",OWNER,id,LATER));
  assert.throws(()=>readRetainedActionEvidence(f.db,"w","foreign",id,LATER));
  assert.throws(()=>readRetainedActionEvidence(f.db,"w",OWNER,id,"2026-11-01T05:00:03.000Z"));
  assert.throws(()=>readRetainedActionEvidence(f.db,"w",OWNER,id,"2027-01-01T00:00:00.000Z"));
  actionPython(f.filename,`
from worker.investor import data_evidence as evidence
base=db.execute('SELECT * FROM investor_data_reviews WHERE id=?',('${f.metadata.base_review_id}',)).fetchone()
facts=json.loads(base['document_json'])['facts'];facts['listing_id']='foreign-listing'
for event in facts['events']:event['listing_id']=facts['listing_id']
evidence.review_source(db,'w','${OWNER}',base['source_id'],'approved',facts,'Fictional changed identity','2027-01-01T00:00:00.000Z',now='${LATER}')
print('{}')
`);
  assert.throws(()=>read(f,id));
});

test("real read-only database needs no copy, persists no raw reports and never promotes private facts to the proof",t=>{
  const f=actionMaintenanceFixture(t),id=publication(f);correct(f);
  const db=new Database(f.filename,{readonly:true});t.after(()=>db.close());
  const before=db.prepare("SELECT total_changes() n").get(),value=read(f,id,db);
  assert.equal(value.proof.capture_bindings.length,6);
  const text=JSON.stringify(value.proof);
  for(const forbidden of ["987.1234","988.1234","tax_assumption","gross_per_unit","raw\"","excerpt"])
    assert.equal(text.includes(forbidden),false);
  assert.deepEqual(db.prepare("SELECT total_changes() n").get(),before);
});

test("genuine retained v3 and v5 source reviews remain independently comparable after correction while current source is blocked",t=>{
  const f=investorFixture();t.after(()=>f.close());
  const value=actionPython(f.filename,`
from tests.investor.test_retained_action_evidence import retained_v5_after_correction
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
print(json.dumps(retained_v5_after_correction(db,Path(sys.argv[1]))))
`,"legacy_transition");
  const input=value.input as Obj,before=f.db.prepare("SELECT total_changes() n").get();
  for(const expected of value.retained_evidence as Obj[]) {
    const id=(expected.original_review as Obj).id as string;
    assert.deepEqual(readRetainedActionEvidence(f.db,"w",OWNER,id,input.checked_at as string),expected);
  }
  const current=readInvestorMonitorEvidenceSource(f.db,"w",value.model_id as string,value.input_id as string,input.checked_at as string);
  assert.notEqual(current.unavailable_reason,null);assert.equal(current.projection,null);
  const result=verifyActionRestatementArithmetic(input,value.result);assert.notEqual(result.difference_cny,"0");
  assert.equal(result.source_evidence_verified,false);assert.equal(result.monitoring_resumed,false);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),before);
  for(const table of ["portfolios","accounts","ledger_events","postings","position_movements","approval_events","activations","reservations","execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,0);
});
