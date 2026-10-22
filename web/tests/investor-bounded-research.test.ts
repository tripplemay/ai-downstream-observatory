import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import test from "node:test";
import {hash} from "../src/server/ledger/service";
import {replayBoundedComparison,type BoundedResearchPlan} from "../src/server/investor/bounded-research";
import {verifyInvestorKernelResult} from "../src/server/investor/kernel-contracts";
import type {ContinuousDataset} from "../src/server/investor/continuous-market";
import type {ContinuousParameters} from "../src/server/investor/continuous-economics";
import {investorActor as actor,investorFixture,saveSyntheticProfile,syntheticProfile} from "./investor-fixture";
import {executeInvestorCommand,getInvestorState} from "../src/server/investor/service";
import {parseInvestorState} from "../src/components/workbench/investor-client";

function python(script:string,input?:unknown) {
  const child=spawnSync(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??"python3",["-c",script],{cwd:path.resolve(".."),encoding:"utf8",input:input===undefined?undefined:JSON.stringify(input),timeout:60000,maxBuffer:16*1024*1024});
  assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
}
type Vector={input:{dataset:ContinuousDataset;plan:BoundedResearchPlan;parameters:ContinuousParameters;phase:"train"|"validation"|"holdout"};result:unknown};
const vectors:Vector[]=python("import json; from tests.research.bounded_fixtures import vectors; print(json.dumps(vectors()))");

test("production v3 full economics independently match Python across phases, HK/US FX, costs, actions and contributions",()=>{
  for(const {input,result} of vectors) assert.deepEqual(replayBoundedComparison(input.dataset,input.plan,input.parameters,input.phase),result);
});
test("kernel read verification recomputes v3 training summaries instead of trusting coherent hashes",()=>{
  const f=python("import json; from tests.research.bounded_fixtures import case; from tests.investor.fixtures import profile; from worker.investor.strategy import research_reference; d,p,s=case(); pref=profile(); request={'action':'research','dataset':d,'plan':p,'policy':s,'profile':pref}; print(json.dumps({'request':request,'result':research_reference(d,p,s,pref,allow_synthetic=True)}))");
  assert.equal(verifyInvestorKernelResult(f.request,f.result).status,"risk_options_ready");
  f.result.candidates[0].train.profit_cny="999";
  const {result_hash:ignored,...body}=f.result;void ignored;f.result.result_hash=hash(body);
  assert.throws(()=>verifyInvestorKernelResult(f.request,f.result),/INVESTOR_KERNEL_RESULT_INVALID|INVESTOR_BOUNDED_RESEARCH_REPLAY_MISMATCH/);
});
test("completed v3 selection and all three phase receipts are independently replayable",()=>{
  const f=python("import json; from tests.research.bounded_fixtures import case; from tests.investor.fixtures import profile; from worker.investor.strategy import research_reference; d,p,s=case(); pref=profile('0.30'); print(json.dumps({'request':{'action':'research','dataset':d,'plan':p,'policy':s,'profile':pref},'result':research_reference(d,p,s,pref,allow_synthetic=True)}))");
  assert.equal(f.result.status,"reference_ready");assert.equal(verifyInvestorKernelResult(f.request,f.result).status,"reference_ready");
});
test("admitted v3 source reaches current reference, save, monitoring, human review and stale-state guards through actual services",()=>{
  for(const funding of [false,true]) {
    const f=investorFixture();
    try {
      saveSyntheticProfile(f,actor,{...syntheticProfile,loss_tolerance:"0.30"});
      const helper=(module:string,args:string[]=[])=>{
        const result=spawnSync(process.env.WORKBENCH_TEST_PYTHON??"python3",["-m",module,"--db",f.filename,...args],{cwd:path.resolve(".."),encoding:"utf8",timeout:60000,maxBuffer:65536});
        assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
      };
      helper("tests.investor.evidence_fixture",["--fixed-policy-v2","--bounded-execution-v3"]);
      helper("tests.investor.queue_fixture",["--mode","core"]);
      let state=getInvestorState(f.db,actor,"2026-01-02T12:00:04.000Z");
      assert(state.plan);assert(state.plan.document.strategy_version.includes("+bounded-close-v1+fixed-policy-v2"));
      assert(state.plan.document.estimated_cost.includes("2%"));
      executeInvestorCommand(f.db,actor,{action:"save_plan",plan_id:state.plan.id,expected_revision:state.revision,idempotency_key:"bounded-save"},"2026-01-02T12:00:04.000Z");
      state=getInvestorState(f.db,actor,"2026-01-02T12:00:04.000Z");assert.equal(state.model_watch?.status,"awaiting_inputs");
      helper("tests.investor.monitor_data_fixture",["--admit","--monitor","--later",...(funding?["--funding"]:[])]);
      const now="2026-01-03T12:15:04.000Z";state=getInvestorState(f.db,actor,now);
      assert.equal(state.model_watch?.status,funding?"research_decision":"research_observe");
      assert.equal(state.effective_outcome,funding?"decision_required":"observe");
      const binding="a".repeat(64);assert.deepEqual(parseInvestorState({...state,session_binding:binding},binding),state);
      if(funding) {
        executeInvestorCommand(f.db,actor,{action:"review",observation_id:state.latest!.id,decision:"accept_idea",note:"Invented review, not execution",expected_revision:state.revision,idempotency_key:"bounded-review"},now);
        const reviewed=getInvestorState(f.db,actor,now);
        assert.equal(reviewed.decisions[0]?.decision,"accept_idea");
        assert.equal(reviewed.decisions[0]?.observation_id,state.latest!.id);
      }
      const due=state.latest!.document.next_review_at;assert(due);
      assert.equal(getInvestorState(f.db,actor,due).effective_outcome,"insufficient_evidence");
      for(const table of ["portfolios","accounts","ledger_events","postings","position_movements","approval_events","activations","reservations","execution_reports"])
        assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,0,table);
    } finally {f.close();}
  }
});
