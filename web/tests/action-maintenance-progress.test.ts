import assert from "node:assert/strict";
import test from "node:test";
import type Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { actionMaintenanceFixture, actionPython, LATER, probeActionMutation } from "./action-maintenance-fixture";
import { investorFixture, investorActor, saveSyntheticProfile } from "./investor-fixture";
import { readActionMaintenanceProgress, unavailableActionMaintenanceProgress } from "../src/server/investor/action-maintenance-progress";
import { actionMaintenanceProgressSchema } from "../src/server/investor/action-maintenance-progress-schemas";
import { getInvestorState } from "../src/server/investor/service";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { InvestorActionMaintenance } from "../src/components/workbench/investor-action-maintenance";

const owner="synthetic-investor",third="2026-11-03T06:00:03.000Z",fourth="2026-11-04T06:00:03.000Z";
test("unpublished fixed rules distinguish disabled, future and enabled waiting states",()=>{
  for(const mode of ["disabled","future","waiting"]) {
    const f=investorFixture();
    try {
      actionPython(f.filename,`
from tests.investor.test_managed_actions import ManagedActionTests,AT
from worker.investor import managed_actions as m
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)",(AT,))
case=ManagedActionTests();case.db=db;case.path=Path(sys.argv[1]);case.prepare()
policy=case.policy(**({'valid_from':'2026-11-03T06:00:00.000Z'} if '${mode}'=='future' else {}))
grant=m.register_authority(db,'w','synthetic-investor',policy,now=AT)
if '${mode}'=='waiting':m.set_authority_enabled(db,'w','synthetic-investor',grant['id'],True,now=AT)
print('{}')`);
      const value=readActionMaintenanceProgress(f.db,"w",owner,LATER),row=value.entries[0];
      assert.equal(row.state,mode === "waiting" ? "waiting_sources":mode);assert.equal(row.coverage_end,null);
    } finally {f.close();}
  }
});

test("audited standing-rule status reads only metadata, never facts, raw payloads or financial writes",t=>{
  const f=actionMaintenanceFixture(t),queries:string[]=[];
  const guarded={transaction:f.db.transaction.bind(f.db),prepare(sql:string) {
    queries.push(sql);assert.doesNotMatch(sql,/investor_(?:issuer|eodhd)_payloads|(?:SELECT\s+\*|SELECT[^;]*document_json)[^;]*FROM\s+investor_data_reviews/i);
    return f.db.prepare(sql);
  }} as Database.Database;
  const before=f.db.prepare("SELECT total_changes() n").get(),value=readActionMaintenanceProgress(guarded,"w",owner,LATER);
  assert.equal(value.status,"visible");assert.equal(value.entries.length,1);
  const row=value.entries[0];assert.equal(row.state,"coverage_recorded");assert.equal(row.coverage_end,"2026-11-01");
  assert.equal(row.coverage_source_day,"2026-11-02");assert.equal(value.research_admitted_by_this_view,false);
  assert.equal(value.raw_evidence_replayed_by_this_view,false);assert.ok(queries.length<300);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),before);
  assert.doesNotMatch(JSON.stringify(value),/fictional-dividend|987\.1234|98\.71234|synthetic-3141|capture_id|authority_id|raw_sha256|tax_assumption/);
  assert.throws(()=>readActionMaintenanceProgress(f.db,"w","foreign",LATER));
});

test("permission withdrawal and own pause/resume do not make old publications current",t=>{
  const f=actionMaintenanceFixture(t);
  actionPython(f.filename,`
from worker.investor import managed_actions as m
grant=db.execute('SELECT id FROM investor_action_authorities').fetchone()[0]
m.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${LATER}')
print('{}')`);
  let row=readActionMaintenanceProgress(f.db,"w",owner,LATER).entries[0];assert.equal(row.state,"disabled");assert.equal(row.coverage_end,"2026-11-01");
  actionPython(f.filename,`
from worker.investor import managed_actions as m
grant=db.execute('SELECT id FROM investor_action_authorities').fetchone()[0]
m.set_authority_enabled(db,'w','synthetic-investor',grant,True,now='${LATER}')
print('{}')`);
  row=readActionMaintenanceProgress(f.db,"w",owner,LATER).entries[0];assert.equal(row.state,"source_unavailable");assert.equal(row.reason_code,"RULE_CONTROL_CHANGED");
  actionPython(f.filename,`
from worker.investor import eodhd_sources as e
grant=db.execute('SELECT id FROM investor_eodhd_authorities').fetchone()[0]
e.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${LATER}')
print('{}')`);
  row=readActionMaintenanceProgress(f.db,"w",owner,LATER).entries[0];assert.equal(row.state,"source_unavailable");assert.equal(row.reason_code,"SOURCE_PERMISSION_CHANGED");
});

test("normal windows, pending inputs, missed intents and sticky quarantine remain distinct without a source request",t=>{
  const f=actionMaintenanceFixture(t);
  assert.equal(readActionMaintenanceProgress(f.db,"w",owner,"2026-11-03T05:00:00.000Z").entries[0].state,"waiting_next_window");
  assert.equal(readActionMaintenanceProgress(f.db,"w",owner,third).entries[0].state,"waiting_sources");
  actionPython(f.filename,`
from worker.investor import managed_actions as m
assert m.publish_current_actions(db,now='${third}')==[]
print('{}')`);
  let row=readActionMaintenanceProgress(f.db,"w",owner,third).entries[0];assert.equal(row.state,"waiting_sources");assert.equal(row.last_source_day,"2026-11-03");
  row=readActionMaintenanceProgress(f.db,"w",owner,fourth).entries[0];assert.equal(row.state,"needs_review");assert.equal(row.reason_code,"MAINTENANCE_WINDOW_MISSED");
  actionPython(f.filename,`
from worker.investor import managed_actions as m
assert m.publish_current_actions(db,now='${fourth}')[0]['status']=='blocked'
grant=db.execute('SELECT id FROM investor_action_authorities').fetchone()[0]
m.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${fourth}')
try:m.set_authority_enabled(db,'w','synthetic-investor',grant,True,now='${fourth}')
except Exception as error:assert str(error)=='INVESTOR_DATA_ACTION_MAINTENANCE_SOURCE_QUARANTINED'
else:raise AssertionError('Quarantine must not be cleared by resume')
print('{}')`);
  row=readActionMaintenanceProgress(f.db,"w",owner,fourth).entries[0];assert.equal(row.state,"needs_review");assert.equal(row.reason_code,"MAINTENANCE_WINDOW_MISSED");
  assert.equal(readActionMaintenanceProgress(f.db,"w",owner,"2026-11-11T06:00:03.000Z").entries[0].state,"needs_review");
});

test("recorded coverage survives expiry as history; corrupted audit metadata is not a positive status",t=>{
  const f=actionMaintenanceFixture(t);
  const expired=readActionMaintenanceProgress(f.db,"w",owner,"2026-11-11T06:00:03.000Z").entries[0];
  assert.equal(expired.state,"expired");assert.equal(expired.coverage_end,"2026-11-01");
  probeActionMutation(f.db,["audit_events"],()=>{
    f.db.prepare("UPDATE audit_events SET payload_json='{}' WHERE id=(SELECT audit_id FROM investor_action_authorities LIMIT 1)").run();
  },()=>assert.throws(()=>readActionMaintenanceProgress(f.db,"w",owner,LATER)));
});

test("maintenance is explicitly opt-in and corrupt optional metadata does not hide independent research",()=>{
  const f=investorFixture();
  try {
    saveSyntheticProfile(f);const binding="a".repeat(64),now="2026-01-02T12:00:01.000Z";
    const legacy=getInvestorState(f.db,investorActor,now);
    assert.equal(Object.hasOwn(legacy,"action_maintenance"),false);
    const state=getInvestorState(f.db,investorActor,now,{includeActionMaintenanceProgress:true});
    assert.equal(state.action_maintenance!.status,"not_configured");
    assert.deepEqual(parseInvestorState({...state,session_binding:binding},binding),state);
    assert.deepEqual(parseInvestorState({...legacy,session_binding:binding},binding),legacy);
    assert.throws(()=>parseInvestorState({...state,session_binding:binding,action_maintenance:{...state.action_maintenance,checked_at:"2026-01-02T12:00:02.000Z"}},binding));
    f.db.exec("DROP TABLE investor_action_publications; DROP TABLE investor_action_requests; DROP TABLE investor_action_controls; DROP TABLE investor_action_authorities");
    const unavailable=getInvestorState(f.db,investorActor,now,{includeActionMaintenanceProgress:true});
    assert.equal(unavailable.action_maintenance!.status,"unavailable");assert.deepEqual(unavailable.effective_gaps,legacy.effective_gaps);
    assert.equal(unavailable.effective_outcome,legacy.effective_outcome);
  } finally {f.close();}
});

test("closed client contract rejects status promotion, impossible coverage, extra data and duplicate rules",t=>{
  const f=actionMaintenanceFixture(t),value=readActionMaintenanceProgress(f.db,"w",owner,LATER),row=value.entries[0];
  for(const changed of [
    {...value,research_admitted_by_this_view:true},{...value,provider_online_verified:true},{...value,human_review_performed_today:true},
    {...value,raw_evidence_replayed_by_this_view:true},{...value,trading_permission:true},{...value,raw:"private"},
    {...value,refresh_after:value.checked_at},{...value,refresh_after:"2027-01-01T00:00:00.000Z"},
    {...value,entries:[row,row]},{...value,entries:[{...row,coverage_end:row.coverage_source_day}]},
    {...value,entries:[{...row,coverage_recorded_at:null}]},{...value,entries:[{...row,reason_code:"RULE_INPUTS_REJECTED"}]},
    {...value,entries:[{...row,state:"needs_review"}]},{...value,entries:[{...row,enabled:false}]},
    {...value,entries:[{...row,last_source_day:"2026-02-30"}]},{...value,status:"unavailable"},
  ])assert.equal(actionMaintenanceProgressSchema.safeParse(changed).success,false,JSON.stringify(changed));
});

test("ordinary semantic panel labels coverage as historical, collapses details and hides stale status",t=>{
  const f=actionMaintenanceFixture(t),value=readActionMaintenanceProgress(f.db,"w",owner,LATER);
  const render=(at=LATER)=>renderToStaticMarkup(createElement(InvestorActionMaintenance,{value,nowMs:Date.parse(at)},createElement("p",null,"fictional-task-detail")));
  const html=render();assert.match(html,/研究资料自动维护/);assert.match(html,/历史登记覆盖至 2026-11-01/);
  assert.match(html,/不是当前行情日期/);assert.match(html,/不保证客观不存在其他事件/);assert.match(html,/<details[^>]*><summary/);
  assert.doesNotMatch(html,/<details[^>]*open|<button|<form|<pre/);
  const stale=render(value.refresh_after);assert.match(stale,/状态快照已到复核时间/);assert.doesNotMatch(stale,/历史登记覆盖至|已登记覆盖续接/);
  assert.match(renderToStaticMarkup(createElement(InvestorActionMaintenance,{value:unavailableActionMaintenanceProgress(LATER),nowMs:Date.parse(LATER)})),/维护记录暂未通过核对/);
});
