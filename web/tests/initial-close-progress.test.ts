import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import path from "node:path";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {investorFixture,investorActor as actor} from "./investor-fixture";
import {getInvestorState} from "../src/server/investor/service";
import {parseInvestorState} from "../src/components/workbench/investor-client";
import {InvestorAcquisitionPanel} from "../src/components/workbench/investor-acquisition";

const binding="a".repeat(64);
test("first-close task progress independently reads actual single-attempt lifecycle and never promotes capture to monitoring",()=>{
  for(const mode of ["discover","claim","expired","complete","partial","empty","late","admit"] as const){
    const f=investorFixture();
    try{
      const output=JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON??"python3",["-m","tests.investor.initial_close_fixture","--db",f.filename,"--mode",mode],
        {cwd:path.resolve(process.cwd(),".."),encoding:"utf8",timeout:60000,maxBuffer:262144})) as {checked_at:string;stubbed_sdk_calls:number;real_provider_called:boolean};
      assert.equal(output.real_provider_called,false);assert.equal(output.stubbed_sdk_calls,["discover","claim","expired","late"].includes(mode)?0:1);
      const changes=f.db.prepare("SELECT total_changes() n").get(),state=getInvestorState(f.db,actor,output.checked_at);
      assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(),changes);
      assert.deepEqual(parseInvestorState({...state,session_binding:binding},binding),state);
      assert.equal(getInvestorState(f.db,{id:"other-investor"},output.checked_at).model_watch,null);
      const activity=state.model_watch!.acquisition!;assert.ok(activity);assert.notEqual(activity.status,"unavailable",mode);
      assert.equal(activity.phase,mode==="admit"?"confirmed_close":"initial_close");
      assert.equal(activity.markets[0].status,{discover:"scheduled",claim:"running",expired:"lease_expired",complete:"waiting_core",partial:"partial",empty:"no_events",late:"missed_window",admit:"not_registered"}[mode]);
      assert.equal(state.model_watch!.checkpoint_sequence,mode==="admit"?1:0);assert.equal(state.live_advice_eligible,false);
      if(mode!=="admit"){
        assert.equal(state.model_watch!.model_nav_cny,null);assert.equal(activity.markets[0].registered_count,2);
        const html=renderToStaticMarkup(createElement(InvestorAcquisitionPanel,{value:activity,nowMs:Date.parse(output.checked_at),modelValidUntil:state.model_watch!.valid_until}));
        assert.match(html,/首份监测收盘采集/);assert.match(html,/首份合格监测输入尚未建立/);assert.doesNotMatch(html,/<button|<form/);
      }
      for(const table of ["portfolios","accounts","ledger_events","postings","position_movements","approval_events","activations","reservations","execution_reports"])
        assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,0);
    }finally{f.close();}
  }
});
