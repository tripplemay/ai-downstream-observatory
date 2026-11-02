import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { investorFixture } from "./investor-fixture";
import { actionPython, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { readRetainedMonitorHistory } from "../src/server/investor/retained-monitor-history";

type Obj=Record<string,unknown>;
function noFinance(db:Database.Database) {
  for(const table of ["portfolios","accounts","ledger_events","postings","position_movements","approval_events","activations","reservations","execution_reports"])
    assert.equal((db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,0);
}
test("independent complete original v3/v5 history survives a hypothetical correction without restoring current qualification or writing",t=>{
  const f=investorFixture();t.after(()=>f.close());
  const value=actionPython(f.filename,`
from tests.investor.test_retained_action_evidence import retained_v5_after_correction
from worker.investor.retained_monitor_history import read_retained_monitor_history
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
v=retained_v5_after_correction(db,Path(sys.argv[1]));at=v['input']['checked_at'];before=db.total_changes
result=read_retained_monitor_history(db,'w','synthetic-investor',v['model_id'],now=at)
assert db.total_changes==before
print(json.dumps({'expected':result,'model_id':v['model_id'],'checked_at':at}))
`,"legacy_transition");
  const before=f.db.prepare("SELECT total_changes() n").get();
  const actual=readRetainedMonitorHistory(f.db,"w",{id:"synthetic-investor"},value.model_id as string,value.checked_at as string);
  assert.deepEqual(actual,value.expected);
  assert.equal((actual.head as Obj).sequence,2);assert.equal(actual.proof.monitoring_resumed,false);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),before);
  const read=()=>readRetainedMonitorHistory(f.db,"w",{id:"synthetic-investor"},value.model_id as string,value.checked_at as string);
  probeActionMutation(f.db,["investor_issuer_payloads"],()=>f.db.prepare("UPDATE investor_issuer_payloads SET payload=zeroblob(raw_bytes)").run(),()=>assert.throws(read));
  const receipt=f.db.prepare("SELECT id FROM investor_legacy_transition_confirmations LIMIT 1").get() as {id:string};
  probeActionMutation(f.db,["investor_legacy_transition_confirmations","audit_events"],()=>
    resealActionRow(f.db,"investor_legacy_transition_confirmations",receipt.id,doc=>{doc.carry_hash="0".repeat(64);}),()=>assert.throws(read));
  assert.deepEqual(read(),actual);
  actionPython(f.filename,`
from worker.investor import issuer_sources
authority=db.execute('SELECT id FROM investor_issuer_authorities ORDER BY rowid LIMIT 1').fetchone()[0]
issuer_sources.set_authority_enabled(db,'w','synthetic-investor',authority,False,now='${value.checked_at}')
print('{}')
`);
  assert.throws(read);noFinance(f.db);
});

test("qualified CN HK US original inputs v1 v2 v4 and real funding-bound checkpoint independently retain exact local dates and model economics",async t=>{
  for(const [market,protocol,fixed,funded] of [["CN","v1",false,false],["HK","v2",false,false],["US","v4",true,false],
    ["CN","v4",true,false],["HK","v4",true,false],["CN","v1",true,true]] as const)
    await t.test(`${market}-${protocol}-funded-${funded}`,t=>{
      const f=investorFixture();t.after(()=>f.close());
      const value=actionPython(f.filename,`
from tests.investor.test_retained_monitor_history import plain_history_case
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-01-01T00:00:00.000Z')")
print(json.dumps(plain_history_case(db,Path(sys.argv[1]),market='${market}',protocol='${protocol}',fixed=${fixed?"True":"False"},funded=${funded?"True":"False"})))
`);
      const statements:string[]=[],db=new Database(f.filename,{readonly:true,verbose:sql=>statements.push(String(sql))});t.after(()=>db.close());
      const before=db.prepare("SELECT total_changes() n").get();
      const result=readRetainedMonitorHistory(db,"w",{id:"synthetic-investor"},value.model_id as string,value.checked_at as string);
      assert.deepEqual(result,value.history);assert.equal(result.proof.input_bindings[0].input_protocol,`investor-monitor-data-input-${protocol}`);
      if(funded)assert.equal(result.head.schema_version,"investor-evidence-model-checkpoint-v3");
      assert.equal(result.proof.corrected_source_evidence_verified,false);assert.equal(result.proof.checkpoint_created,false);
      assert.deepEqual(db.prepare("SELECT total_changes() n").get(),before);noFinance(db);
      assert.ok(statements.some(sql=>/^BEGIN/.test(sql)));assert.ok(statements.some(sql=>/^COMMIT/.test(sql)));
      assert.equal(statements.some(sql=>/^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP)\b/i.test(sql)),false);
      if(protocol==="v4") {
        const correction=actionPython(f.filename,`
from datetime import timedelta
from worker.investor import data_evidence
from worker.investor.model_runtime import _clock
from worker.investor.source_inputs import _snapshot_ids
from worker.investor.retained_monitor_history import read_retained_monitor_history
from worker.orchestration.db import instant
document=json.loads(db.execute('SELECT document_json FROM investor_monitor_evidence_inputs WHERE id=?',('${value.input_id}',)).fetchone()[0])
identifier=_snapshot_ids(db,'w',document['segments'][0]['snapshot'],'actions')[0]
original=db.execute('SELECT * FROM investor_data_reviews WHERE id=?',(identifier,)).fetchone()
facts=json.loads(original['document_json'])['facts'];facts['events'][0]['gross_per_unit']='1.2'
at=_clock(instant('${value.checked_at}')+timedelta(milliseconds=1));expiry=_clock(instant(at)+timedelta(seconds=60))
data_evidence.review_source(db,'w','synthetic-investor',original['source_id'],'approved',facts,'Hypothetical correction, no recovery consent',expiry,now=at)
expected=read_retained_monitor_history(db,'w','synthetic-investor','${value.model_id}',now=at)
print(json.dumps({'expected':expected,'checked_at':at,'expiry':expiry}))
`);
        const changed=readRetainedMonitorHistory(db,"w",{id:"synthetic-investor"},value.model_id as string,correction.checked_at as string);
        assert.deepEqual(changed,correction.expected);assert.deepEqual(changed.head,result.head);
        assert.equal(changed.proof.source_valid_until,correction.expiry);
        assert.throws(()=>readRetainedMonitorHistory(db,"w",{id:"synthetic-investor"},value.model_id as string,correction.expiry as string));
      }
      statements.length=0;
      assert.throws(()=>readRetainedMonitorHistory(db,"w",{id:"foreign"},value.model_id as string,value.checked_at as string));
      assert.equal(statements.some(sql=>/payloads|investor_data_reviews/.test(sql)),false);
      assert.throws(()=>readRetainedMonitorHistory(db,"w",{id:"synthetic-investor"},value.model_id as string,result.proof.source_valid_until));
    });
});
