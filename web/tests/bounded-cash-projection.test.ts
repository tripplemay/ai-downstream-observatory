import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import test from "node:test";
import {buyDigest,executeBuys} from "../src/server/execution-sandbox/bounded-cash";
import {appendJournalCommand,newJournal,replayJournal} from "../src/server/execution-sandbox/journal";
import {declareProgram,decideCash,fundingCommands,valueJournal,verifyCashDecision,verifyValuationReport,
  type CashProgram,type CashDecisionInput,type CashDecision,type CashValuationInput,type CashValuationReport} from "../src/server/execution-sandbox/projection";

function python(script:string,input?:unknown) {
  const result=spawnSync(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??"python3",["-c",script],
    {cwd:path.resolve(".."),encoding:"utf8",input:input===undefined?undefined:JSON.stringify(input),timeout:60000,maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
type Fixture={program:CashProgram;decision_inputs:CashDecisionInput[];decisions:CashDecision[];valuation_input:CashValuationInput;report:CashValuationReport};
const fixture:Fixture=python("import json; from tests.execution_sandbox.projection_fixtures import scenario; print(json.dumps(scenario()))");
function clone():Fixture {return structuredClone(fixture);}
function reseal(value:Record<string,unknown>,key:string) {const body={...value};delete body[key];value[key]=buyDigest(body);}

test("independent programs, funding schedules, deterministic decisions and every journal event match Python",()=>{
  const f=clone(),p=f.program;
  assert.deepEqual(declareProgram(f.valuation_input.journal.declaration,p.targets,p.cash_target_bps,p.drift_threshold_bps,p.funding_schedule),p);
  const funds=fundingCommands(p);let journal=newJournal(f.valuation_input.journal.declaration);
  for(let index=0;index<2;index++) {
    journal=appendJournalCommand(journal,funds[index]);
    const input={...f.decision_inputs[index],journal},result=decideCash(input);
    assert.deepEqual(result,f.decisions[index]);verifyCashDecision(input,result);
    assert(result.command?.kind==="buy_plan");journal=appendJournalCommand(journal,result.command);
    const saved=f.valuation_input.journal.events[index*3+2];assert.equal(saved.kind,"buy_resolution");
    if(saved.kind!=="buy_resolution")throw Error();
    const batch=result.command.payload;
    assert.deepEqual(executeBuys(batch.input,batch.plan,saved.payload.outcome),saved.payload.result);
    journal=appendJournalCommand(journal,{command_id:saved.command_id,at:saved.at,kind:saved.kind,payload:saved.payload});
  }
  assert.deepEqual(journal,f.valuation_input.journal);assert.deepEqual(replayJournal(journal).positions,{"CN:SYNTHETIC_A":"125"});
});

test("hand-computed cash-flow-adjusted return, profit and sampled drawdown are distinct",()=>{
  const f=clone(),report=valueJournal(f.valuation_input);assert.deepEqual(report,f.report);verifyValuationReport(f.valuation_input,report);
  assert.deepEqual(report.samples.map(row=>row.nav_cny),["1000","1000","1000","2500","2500","2500","1250"]);
  assert.deepEqual(report.samples.map(row=>row.unit_nav),["1","1","1","2","2","2","1"]);
  assert.equal(report.samples[3].pre_flow_nav_cny,"2000");assert.equal(report.samples[3].units,"1250");
  assert.equal(report.net_profit_cny,"-250");assert.equal(report.cash_flow_adjusted_return,"0");assert.equal(report.sampled_max_drawdown,"0.5");
  assert.equal(report.cash_reference.nav_cny,"1500");assert.equal(report.cash_reference.investable_market_benchmark,false);
  assert.equal(report.valuation_basis,"terminal_processing_not_execution_settlement");assert.equal(report.live_advice_eligible,false);
});

test("pending orders remain cash in NAV, prevent new plans and never double-subtract reservations",()=>{
  const f=clone(),input=f.decision_inputs[0];assert(f.decisions[0].command);
  input.journal=appendJournalCommand(input.journal,f.decisions[0].command);input.decision_id="pending";
  const decision=decideCash(input);assert.equal(decision.status,"waiting_for_pending_batches");assert.equal(decision.nav_cny,"1000");assert.equal(decision.command,null);
  assert.equal(f.report.samples[1].reserved_cny,"1000");assert.equal(f.report.samples[1].nav_cny,"1000");
});

test("empty capital produces undefined performance, not a fabricated zero-percent investing record",()=>{
  const f=clone(),v=f.valuation_input;v.journal=newJournal(v.journal.declaration);v.event_frames=[];
  const result=valueJournal(v);assert.equal(result.end_nav_cny,"0");assert.equal(result.cash_flow_adjusted_return,null);
  assert.equal(result.sampled_max_drawdown,null);assert.equal(result.return_status,"no_contributed_capital");
  assert.equal(result.samples[0].unit_nav,null);assert.equal(result.cash_reference.total_return,null);
  const input=f.decision_inputs[0];input.journal=v.journal;
  assert.equal(decideCash(input).status,"no_deployable_cash");assert.equal(decideCash(input).command,null);
});

test("quote causality, universe, validity and unsupported corporate actions fail closed",()=>{
  const mutations=[
    (v:CashDecisionInput)=>{v.marks.push(structuredClone(v.marks[0]));},
    (v:CashDecisionInput)=>{v.marks[0].quote.known_at="2025-01-02T08:00:00.000001Z";},
    (v:CashDecisionInput)=>{v.marks[0].quote.observed_at="2025-01-02T06:59:59.999999Z";},
    (v:CashDecisionInput)=>{v.marks[0].quote.valid_until=v.at;},
    (v:CashDecisionInput)=>{v.marks[0].quote.close="0";},
    (v:CashDecisionInput)=>{(v.marks[0] as {corporate_action_unaccounted:boolean}).corporate_action_unaccounted=true;}
  ];
  for(const mutate of mutations) {const v=clone().decision_inputs[0];mutate(v);assert.throws(()=>decideCash(v),/CASH_PROJECTION_/);}
});

test("every cash-flow event requires a causal same-instant valuation frame; final time cannot go backward",()=>{
  const f=clone();f.valuation_input.event_frames.pop();assert.throws(()=>valueJournal(f.valuation_input),/EVENT_FRAME_COUNT_MISMATCH/);
  const other=clone();other.valuation_input.event_frames[0].at="2025-01-02T07:00:00.000001Z";
  assert.throws(()=>valueJournal(other.valuation_input),/EVENT_FRAME_TIME_MISMATCH/);
  const backward=clone();backward.valuation_input.final_frame.at="2025-01-02T07:00:00.000000Z";
  assert.throws(()=>valueJournal(backward.valuation_input),/TIME_REVERSED/);
  const rebound=clone().valuation_input;rebound.final_frame=structuredClone(rebound.event_frames.at(-1)!);
  rebound.final_frame.marks[0].quote.close="10";assert.throws(()=>valueJournal(rebound),/QUOTE_ID_REBOUND/);
});

test("coherently resealed output lies and source/program mismatches fail full economic replay",()=>{
  const f=clone();f.report.cash_flow_adjusted_return="100";reseal(f.report,"report_hash");
  assert.throws(()=>verifyValuationReport(f.valuation_input,f.report),/REPORT_REPLAY_MISMATCH/);
  const d=clone();d.decisions[0].allocations[0].allocated_budget_cny="999";reseal(d.decisions[0],"decision_hash");
  assert.throws(()=>verifyCashDecision(d.decision_inputs[0],d.decisions[0]),/DECISION_REPLAY_MISMATCH/);
  const v=clone().decision_inputs[0];v.program.implementation_hash="a".repeat(64);reseal(v.program,"program_hash");
  assert.throws(()=>decideCash(v),/IMPLEMENTATION_CHANGED/);
});

test("prototype-like listing identifiers are own data and outputs do not mutate input",()=>{
  const input=clone().decision_inputs[0],p=input.program;
  input.program=declareProgram(input.journal.declaration,[{...p.targets[0],listing_id:"constructor"}],0,0,p.funding_schedule);
  input.marks[0].listing_id="constructor";const before=structuredClone(input),result=decideCash(input);
  const other=python("import json,sys; from worker.execution_sandbox.projection import decide_cash; print(json.dumps(decide_cash(json.load(sys.stdin))))",input);
  assert.deepEqual(result,other);assert.deepEqual(input,before);assert.equal(result.allocations[0].market_value_cny,"0");
});

test("32 seeded synthetic final prices independently reproduce exact return and drawdown identities",()=>{
  let seed=15101;const inputs:CashValuationInput[]=[],expected:{returnValue:string;drawdown:string}[]=[];
  for(let index=0;index<32;index++) {
    seed=(seed*48271)%2147483647;const cents=seed%3000+1,whole=Math.floor(cents/100),decimal=String(cents%100).padStart(2,"0");
    const input=clone().valuation_input;input.final_frame.marks[0].quote.close=whole+"."+decimal;inputs.push(input);
    const fractional=(cents-1000)/1000,drawdown=cents>=2000?0:(2000-cents)/2000;
    expected.push({returnValue:String(fractional),drawdown:String(drawdown)});
  }
  const actual=inputs.map(valueJournal),other=python("import json,sys; from worker.execution_sandbox.projection import value_journal; print(json.dumps([value_journal(v) for v in json.load(sys.stdin)]))",inputs);
  assert.deepEqual(actual,other);
  for(const [index,result] of actual.entries()) {
    assert.equal(result.cash_flow_adjusted_return,expected[index].returnValue);assert.equal(result.sampled_max_drawdown,expected[index].drawdown);
  }
});
