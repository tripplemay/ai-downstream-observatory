import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import test from "node:test";
import {buyDigest} from "../src/server/execution-sandbox/bounded-cash";
import {declareStudy,replayJournal} from "../src/server/execution-sandbox/journal";
import {declareProgram} from "../src/server/execution-sandbox/projection";
import {comparePrograms,runProgram,verifyProgramComparison,verifyProgramRun,type ProgramComparisonInput,type ProgramComparison,type ProgramRunInput} from "../src/server/execution-sandbox/study-run";

function python(script:string,input?:unknown) {
  const result=spawnSync(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??"python3",["-c",script],
    {cwd:path.resolve(".."),encoding:"utf8",input:input===undefined?undefined:JSON.stringify(input),timeout:120000,maxBuffer:16*1024*1024});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
const fixture:{input:ProgramComparisonInput;comparison:ProgramComparison}=python("import json; from tests.execution_sandbox.run_fixtures import scenario; print(json.dumps(scenario()))");
function clone() {return structuredClone(fixture);}
function runInput(v=clone().input):ProgramRunInput {return {schema_version:"bounded-cash-run-input-v1",qualification:"synthetic_test_only",...v.candidate,frames:v.frames,decision_points:v.decision_points};}
function reseal(value:Record<string,unknown>,key:string) {const body={...value};delete body[key];value[key]=buyDigest(body);}

test("full generated decisions, journals, marked curves and executable model benchmark match independent Python",()=>{
  const f=clone(),result=comparePrograms(f.input);assert.deepEqual(result,f.comparison);verifyProgramComparison(f.input,result);
  assert.deepEqual(runProgram(runInput(f.input)),result.candidate);
  assert.deepEqual(replayJournal(result.candidate.journal).positions,{"CN:SYNTHETIC_A":"108","CN:SYNTHETIC_B":"24"});
  assert.deepEqual(replayJournal(result.benchmark.journal).positions,{"CN:SYNTHETIC_A":"50","CN:SYNTHETIC_B":"100"});
});
test("hand-computed market-relative results distinguish contributions from returns and do not invent alpha",()=>{
  const result=clone().comparison,a=result.candidate.event_valuation,b=result.benchmark.event_valuation;
  assert.equal(a.end_nav_cny,"1320");assert.equal(b.end_nav_cny,"1500");assert.equal(a.cash_flow_adjusted_return,"0.045");assert.equal(b.cash_flow_adjusted_return,"0.125");
  assert.equal(result.end_nav_difference_cny,"-180");assert.equal(result.excess_cash_flow_adjusted_return,"-0.08");
  assert.equal(result.candidate.decision_policy_compliance_verified,true);assert.equal(result.candidate.event_valuation.allocation_policy_compliance_verified,false);
  assert.equal(result.live_advice_eligible,false);assert.equal(result.parameters_independently_preregistered,false);
});
test("non-event price frames reveal missed peaks without double-subtracting locked cash",()=>{
  const result=clone().comparison;
  assert.equal(result.candidate.sampled_max_drawdown,"0.710526315789");assert.equal(result.benchmark.sampled_max_drawdown,"0.5");
  assert.equal(result.candidate.event_valuation.sampled_max_drawdown,"0.45");assert.equal(result.benchmark.event_valuation.sampled_max_drawdown,"0.25");
  assert.equal(result.candidate.curve[1].nav_cny,"1000");assert.equal(result.candidate.curve[1].reserved_cny,"1000");
});
test("future execution gaps cannot resize a frozen quantity or change an earlier decision",()=>{
  const f=clone(),input=runInput(f.input);input.frames[2].execution_observations[0].close="10.01";
  const result=runProgram(input);assert.deepEqual(result.decisions[0],f.comparison.candidate.decisions[0]);
  assert.equal(result.execution_failure_count,1);assert.equal(result.curve[2].settled_cash_cny,"900");
  const event=result.journal.events[2];assert.equal(event.kind,"buy_resolution");if(event.kind!=="buy_resolution")throw Error();
  assert.equal(event.payload.result.orders[0].reason,"PRICE_BOUND_EXCEEDED");
});
test("valuation marks are never substituted for absent execution evidence",()=>{
  const input=runInput();input.frames[2].execution_observations=[];const result=runProgram(input);
  assert.equal(result.execution_failure_count,2);assert.equal(result.curve[2].settled_cash_cny,"1000");assert.equal(result.curve[2].position_value_cny,"0");
  assert.equal(result.all_planned_batches_terminal,true);
});
test("fee-aware below-minimum rows never become execution observations for nonexistent orders",()=>{
  const input=clone().input;
  for(const side of [input.candidate,input.benchmark]) {
    const p=side.program;
    side.declaration=declareStudy(side.declaration.study_id,side.declaration.registered_at,{...side.declaration.policy,minimum_fee_cny:"2",commission_bps:"3"});
    side.program=declareProgram(side.declaration,p.targets,p.cash_target_bps,p.drift_threshold_bps,p.funding_schedule);
  }
  const result=comparePrograms(input),other=python("import json,sys; from worker.execution_sandbox.study_run import compare_programs; print(json.dumps(compare_programs(json.load(sys.stdin))))",input);
  assert.deepEqual(result,other);assert(Number(result.candidate.fees_cny)>0);assert(Number(result.benchmark.fees_cny)>0);
  const rows=result.benchmark.journal.events.filter(row=>row.kind==="buy_resolution").flatMap(row=>row.payload.result.orders);
  assert(rows.some(row=>row.status==="below_minimum"));assert.equal(result.benchmark.execution_failure_count,0);
});
test("scope, recorded cash flows and execution costs must be equal before comparing strategies",()=>{
  for(const mode of ["flow","cost","step"]) {
    const v=clone().input,side=v.benchmark,p=side.program;
    if(mode==="cost")side.declaration.policy.minimum_fee_cny="1";
    const targets=structuredClone(p.targets),schedule=structuredClone(p.funding_schedule);
    if(mode==="step")targets[0].quantity_step="2";
    if(mode==="flow")schedule[0].amount_cny="1001";
    side.program=declareProgram(side.declaration,targets,p.cash_target_bps,p.drift_threshold_bps,schedule);
    assert.throws(()=>comparePrograms(v),/COMPARISON_(EXECUTION_POLICY|CASH_FLOW|UNIVERSE_OR_STEP)_MISMATCH/);
  }
});
test("chronology, missing scheduled frames, duplicated and future execution evidence fail closed",()=>{
  const first=runInput();first.frames.reverse();assert.throws(()=>runProgram(first),/FRAME_ORDER_INVALID/);
  const missing=runInput();missing.frames.splice(2,1);assert.throws(()=>runProgram(missing),/DECISION_WINDOW_UNCOVERED/);
  const duplicate=runInput();duplicate.frames[2].execution_observations.push(structuredClone(duplicate.frames[2].execution_observations[0]));
  assert.throws(()=>runProgram(duplicate),/DUPLICATE_EXECUTION_LISTING/);
  const future=runInput();future.frames[2].execution_observations[0].known_at="2025-01-03T08:00:00.000001Z";
  assert.throws(()=>runProgram(future),/EXECUTION_EVIDENCE_UNAVAILABLE/);
});
test("rehashed false policy records or statistics fail complete generator replay",()=>{
  const f=clone();f.comparison.candidate.decisions[0].decision.status="no_eligible_underweight";reseal(f.comparison,"comparison_hash");
  assert.throws(()=>verifyProgramComparison(f.input,f.comparison),/COMPARISON_REPLAY_MISMATCH/);
  const v=clone(),result=v.comparison.candidate;result.sampled_max_drawdown="0";reseal(result,"result_hash");
  assert.throws(()=>verifyProgramRun(runInput(v.input),result),/FULL_RUN_REPLAY_MISMATCH/);
});
test("16 seeded whole-path comparisons retain independent negative results and policy lineage",()=>{
  let seed=15133;const inputs:ProgramComparisonInput[]=[];
  for(let index=0;index<16;index++) {
    seed=(seed*48271)%2147483647;const input=clone().input,cents=seed%3000+1;
    input.frames.at(-1)!.marks[0].quote.close=Math.floor(cents/100)+"."+String(cents%100).padStart(2,"0");
    inputs.push(input);
  }
  const actual=inputs.map(comparePrograms),other=python("import json,sys; from worker.execution_sandbox.study_run import compare_programs; print(json.dumps([compare_programs(v) for v in json.load(sys.stdin)]))",inputs);
  assert.deepEqual(actual,other);
  for(const result of actual) {assert.equal(result.candidate.decision_policy_compliance_verified,true);assert.equal(result.same_recorded_cash_flows,true);}
});
test("complete runs and comparisons leave caller data unchanged",()=>{
  const input=clone().input,before=structuredClone(input);comparePrograms(input);assert.deepEqual(input,before);
});
