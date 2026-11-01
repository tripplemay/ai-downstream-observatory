import assert from "node:assert/strict";
import test from "node:test";
import { actionPython } from "./action-maintenance-fixture";
import { investorFixture, investorActor } from "./investor-fixture";
import { readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { getInvestorState } from "../src/server/investor/service";
import { parseInvestorState } from "../src/components/workbench/investor-client";

const at="2026-11-02T06:00:03.000Z";
test("Node independently admits the recovered input, keeps the old control unavailable and preserves the saved reference",()=>{
  const f=investorFixture();
  try {
    const value=actionPython(f.filename,`
from tests.investor.test_action_refresh import ActionRefreshTests
from tests.investor.test_managed_actions import LATER
from worker.investor import confirmed_feed,monitor_data
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-01-02T12:00:00.000Z')")
case=ActionRefreshTests();case.db=db;case.path=Path(sys.argv[1]);case.version=0
definition,seed,old,current=case.paused_model()
assert len(confirmed_feed.refresh_monitor_sources(db,now=LATER))==1
head=db.execute('SELECT * FROM investor_monitor_evidence_inputs ORDER BY created_at DESC,rowid DESC LIMIT 1').fetchone()
document=json.loads(head['document_json'])
result=monitor_data.resolve_monitor_data(db,'w',definition,document,now=LATER)
reference=json.loads(db.execute('SELECT document_json FROM investor_reference_plans WHERE id=?',(definition['plan_id'],)).fetchone()[0])
case.assert_no_finance()
print(json.dumps({'old_input_id':seed['id'],'input_id':head['id'],'model_id':definition['model_id'],
 'projection':result['projection'],'document':document,'plan_hash':definition['plan_hash'],
 'reference_targets':reference['targets'],'real_provider_called':False,'real_gateway_called':False}))`);
    assert.equal(value.real_provider_called,false);assert.equal(value.real_gateway_called,false);
    const before=f.db.prepare("SELECT total_changes() n").get();
    const previous=readInvestorMonitorEvidenceSource(f.db,"w",value.model_id as string,value.old_input_id as string,at);
    assert.equal(previous.unavailable_reason,"REFERENCE_SOURCE_NO_LONGER_CURRENT");assert.equal(previous.projection,null);
    const current=readInvestorMonitorEvidenceSource(f.db,"w",value.model_id as string,value.input_id as string,at);
    assert.equal(current.unavailable_reason,null);assert.deepEqual(current.projection,value.projection);assert.deepEqual(current.document,value.document);
    const state=getInvestorState(f.db,investorActor,at,{includeActionMaintenanceProgress:true});
    assert.equal(state.plan?.content_hash,value.plan_hash);assert.equal(state.action_maintenance?.entries[0].state,"coverage_recorded");
    assert.equal(state.live_advice_eligible,false);assert.equal(state.actual_holdings_status,"not_linked");
    assert.deepEqual(parseInvestorState({...state,session_binding:"a".repeat(64)},"a".repeat(64)),state);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),before);
    for(const table of ["portfolios","accounts","ledger_events","postings","approval_events","execution_reports"])
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,0);
    actionPython(f.filename,`
from worker.investor import managed_actions
authority=db.execute('SELECT id FROM investor_action_authorities').fetchone()[0]
managed_actions.set_authority_enabled(db,'w','synthetic-investor',authority,False,now='${at}')
print('{}')`);
    const hidden=readInvestorMonitorEvidenceSource(f.db,"w",value.model_id as string,value.input_id as string,at);
    assert.equal(hidden.unavailable_reason,"REFERENCE_SOURCE_NO_LONGER_CURRENT");assert.equal(hidden.projection,null);
    assert.equal(getInvestorState(f.db,investorActor,at).plan?.content_hash,value.plan_hash);
  } finally {f.close();}
});
