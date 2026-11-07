import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test, { type TestContext } from "node:test";
import { investorFixture } from "./investor-fixture";
import { actionPython } from "./action-maintenance-fixture";
import { correctionChangeFence } from "../src/server/investor/correction-change-fence";
import { enqueueCorrectionImpact, readCorrectionImpactResponse } from "../src/server/investor/correction-impact-jobs";

const actor={id:"synthetic-investor"},binding="a".repeat(64);
type Obj=Record<string,unknown>;
function fixture(t:TestContext){const f=investorFixture();t.after(()=>f.close());
  const value=actionPython(f.filename,`
from tests.investor.test_correction_impact_jobs import settled_correction_case
from worker.investor.correction_change_fence import correction_change_fence
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
value=settled_correction_case(db,Path(sys.argv[1]));value['fence']=correction_change_fence(db,'w','synthetic-investor')
print(json.dumps(value))
`,"legacy_transition");
  const now=value.checked_at as string,body=value.request as Obj;
  const read=(selection:{request?:string;nonce?:string;preview?:string}={},at=now,db=f.db)=>readCorrectionImpactResponse(db,actor,binding,selection,at);
  function work(){return actionPython(f.filename,`
from worker.orchestration.runtime import run_pending_once
for unused in range(12):
 result=run_pending_once(db,'fictional-node-correction-core',clock=lambda:'${now}')
 if db.execute('SELECT 1 FROM investor_correction_impact_results').fetchone():break
 assert result is not None
row=db.execute('SELECT document_json FROM investor_correction_impact_results').fetchone()
assert row is not None
print(row[0])
`,"legacy_transition");}
  const noFinance=()=>{for(const table of ["portfolios","accounts","ledger_events","postings","position_movements","approval_events","activations","reservations","execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,0);};
  return {...f,body,now,value,read,work,noFinance};
}

test("ordinary Node intent, default core and bounded cached GET expose a private hypothesis without replaying history or changing the plan",t=>{
  const f=fixture(t);assert.equal(correctionChangeFence(f.db,"w",actor),f.value.fence);
  assert.equal(f.read({preview:f.body.preview_id as string}).request,null);
  const before=f.read().workspace_revision,intent=enqueueCorrectionImpact(f.db,actor,f.body,f.now);
  assert.equal(f.read({nonce:f.body.idempotency_key as string}).request?.status,"queued");assert.equal(f.read().workspace_revision,before);
  assert.deepEqual(enqueueCorrectionImpact(f.db,actor,f.body,f.now),intent);
  const output=f.work();assert.equal(output.outcome,"preview_ready");
  const queries:string[]=[],reader=new Database(f.filename,{readonly:true,verbose:sql=>queries.push(String(sql))});t.after(()=>reader.close());
  const total=reader.prepare("SELECT total_changes() n").get(),result=f.read({request:intent.request_id as string},f.now,reader);
  assert.equal(result.request?.status,"preview_ready");assert.ok(result.summary);assert.equal(result.workspace_revision,before);
  assert.equal(result.summary.difference_cny,((output.impact as Obj).comparison as Obj).difference_cny);
  assert.equal(result.summary.basis,"stored_hypothetical_result_at_original_prices_not_current_nav");assert.equal(result.economic_correction_approved,false);
  assert.deepEqual(reader.prepare("SELECT total_changes() n").get(),total);
  assert.equal(queries.some(sql=>/^(INSERT|UPDATE|DELETE|CREATE|DROP)\b/i.test(sql)),false);
  assert.equal(queries.some(sql=>/^SELECT.*\b(projection|payload)\b.*FROM "?investor_(price|confirmed|issuer|eodhd|fx|evidence_checkpoint)_payloads/i.test(sql)),false);
  assert.doesNotMatch(JSON.stringify(result),/gross_per_unit|tax_per_unit|source_evidence|hypothetical_events|acknowledgements|receipt_json/);
  assert.equal(f.read({nonce:"fictional-missing"}).request,null);assert.equal(f.read({nonce:"fictional-missing"}).summary,null);
  assert.equal(f.read({request:intent.request_id as string},result.summary.valid_until).summary,null);
  assert.deepEqual(enqueueCorrectionImpact(f.db,actor,f.body,"2026-11-07T07:00:00.000Z"),intent);f.noFinance();
});

test("foreign scope, changed nonce and concurrent intent leave no extra request; committed source withdrawal hides cached impact",t=>{
  const f=fixture(t),intent=enqueueCorrectionImpact(f.db,actor,f.body,f.now),count=f.db.prepare("SELECT count(*) n FROM audit_events").get();
  assert.throws(()=>enqueueCorrectionImpact(f.db,actor,{...f.body,idempotency_key:"fictional-busy"},f.now),/BUSY/);
  assert.throws(()=>enqueueCorrectionImpact(f.db,actor,{...f.body,model_id:"different"},f.now),/DUPLICATE_CONFLICT/);
  assert.throws(()=>enqueueCorrectionImpact(f.db,{id:"foreign"},f.body,f.now),/WORKSPACE_REQUIRED/);
  assert.deepEqual(f.db.prepare("SELECT count(*) n FROM audit_events").get(),count);
  const output=f.work();assert.equal(output.outcome,"preview_ready",JSON.stringify(output));assert.ok(f.read({request:intent.request_id as string}).summary);
  actionPython(f.filename,`
from worker.investor import eodhd_sources
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor','${(f.value.member as Obj).eodhd_authority_id}',False,now='${f.now}')
print('{}')
`);
  const hidden=f.read({request:intent.request_id as string});assert.equal(hidden.summary,null);assert.equal(hidden.request?.status,"outdated");
  f.noFinance();
});
