import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import test from "node:test";
import {buyDigest,executeBuys,planBuys} from "../src/server/execution-sandbox/bounded-cash";
import {appendJournalCommand,declareStudy,journalReservations,newJournal,replayJournal,type CashJournal,type JournalCommand,type StudyDeclaration} from "../src/server/execution-sandbox/journal";

function python(script:string,input?:unknown) {
  const result=spawnSync(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??"python3",["-c",script],
    {cwd:path.resolve(".."),encoding:"utf8",input:input===undefined?undefined:JSON.stringify(input),timeout:30000,maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
type Fixture={declaration:StudyDeclaration;commands:JournalCommand[];journal:CashJournal;prefixes:CashJournal[]};
const fixture:Fixture=python("import json; from tests.execution_sandbox.journal_fixtures import scenario; print(json.dumps(scenario()))");
function clone():Fixture {return structuredClone(fixture);}
function rebuild(value:Fixture) {
  let journal=newJournal(value.declaration);const prefixes=[journal];
  for (const command of value.commands) {journal=appendJournalCommand(journal,command);prefixes.push(journal);}
  return {journal,prefixes};
}
function reseal(value:Record<string,unknown>,field:string) {const body={...value};delete body[field];value[field]=buyDigest(body);}
function resealLast(journal:CashJournal) {const event=journal.events.at(-1)!;reseal(event,"event_hash");journal.head_hash=event.event_hash;reseal(journal,"journal_hash");}

test("Python and Web independently replay every continuous cash, reservation and holding prefix",()=>{
  const value=clone(),result=rebuild(value);
  assert.deepEqual(declareStudy(value.declaration.study_id,value.declaration.registered_at,value.declaration.policy),value.declaration);
  assert.deepEqual(result,{journal:value.journal,prefixes:value.prefixes});
  const states=result.prefixes.map(replayJournal);
  const other=python("import json,sys; from worker.execution_sandbox.journal import replay_journal; print(json.dumps([replay_journal(j) for j in json.load(sys.stdin)]))",result.prefixes);
  assert.deepEqual(states,other);
  assert.deepEqual(states.map(row=>row.settled_cash_cny),["0","2204","2204","2204","2304","1391.2","471.2"]);
  assert.deepEqual(states.map(row=>row.reserved_cny),["0","0","1002","2004","2004","1002","0"]);
  assert.deepEqual(states.at(-1)!.positions,{"CN:SYNTHETIC_A":"180"});
  assert.equal(states.at(-1)!.total_contributions_cny,"2304");
  assert.equal(value.declaration.parameters_independently_preregistered,false);
});

test("a batch's obsolete cash snapshot never overwrites later deposits or another batch's executions",()=>{
  const value=clone(),state=replayJournal(value.journal),resolved=value.commands[5];
  assert.equal(resolved.kind,"buy_resolution");if(resolved.kind!=="buy_resolution")throw Error();
  assert.equal(resolved.payload.result.cash_after_cny,"1284");
  assert.equal(state.settled_cash_cny,"471.2");assert.equal(state.free_cash_cny,"471.2");
  assert.equal(Object.keys(state.open_batches).length,0);assert.equal(Object.keys(state.closed_batches).length,2);
});

test("missing execution preserves cumulative holdings, cash and a counted failure",()=>{
  const value:Fixture=python("import json; from tests.execution_sandbox.journal_fixtures import scenario; print(json.dumps(scenario(second_missing=True)))");
  assert.deepEqual(rebuild(value).journal,value.journal);
  const state=replayJournal(value.journal);
  assert.equal(state.execution_failure_count,1);assert.equal(state.settled_cash_cny,"1391.2");
  assert.deepEqual(state.positions,{"CN:SYNTHETIC_A":"90"});assert.equal(state.reserved_cny,"0");
});

test("next decisions bind actual journal cash, all existing locks and the frozen policy",()=>{
  const value=clone(),journal=value.prefixes[2],source=value.commands[2];
  assert.equal(source.kind,"buy_plan");if(source.kind!=="buy_plan")throw Error();
  const mutations=[
    (command:typeof source)=>{command.payload.input.settled_cash_cny="9999";},
    (command:typeof source)=>{command.payload.input.existing_reservations=[];},
    (command:typeof source)=>{command.payload.input.unsettled_receivable_cny="100";},
    (command:typeof source)=>{command.payload.input.policy.price_buffer_bps="300";}
  ];
  for(const mutate of mutations) {const command=structuredClone(source);mutate(command);command.payload.plan=planBuys(command.payload.input);
    assert.throws(()=>appendJournalCommand(journal,command),/CASH_JOURNAL_(CASH_SNAPSHOT_MISMATCH|RESERVATION_SNAPSHOT_MISMATCH|FROZEN_POLICY_MISMATCH)/);}
  assert.deepEqual(journalReservations(replayJournal(journal)),[{order_id:"order:1",budget_cny:"1002"}]);
});

test("overdue batches, duplicate contribution/order/batch IDs and clock reversal block without state mutation",()=>{
  const value=clone(),at=value.prefixes[4],before=structuredClone(at);
  assert.throws(()=>appendJournalCommand(at,value.commands[5]),/RESOLVE_DUE_BATCH_FIRST/);
  const cash=structuredClone(value.commands[3]);cash.at="2025-01-03T08:00:00.000000Z";cash.command_id="cash:late";
  assert.throws(()=>appendJournalCommand(at,cash),/RESOLVE_DUE_BATCH_FIRST/);
  const reused=structuredClone(value.commands[0]);reused.command_id="cash:duplicate";
  assert.throws(()=>appendJournalCommand(value.prefixes[1],reused),/CONTRIBUTION_ALREADY_USED/);
  reused.at="2025-01-02T07:01:59.999999Z";assert.throws(()=>appendJournalCommand(value.prefixes[1],reused),/TIME_REVERSED/);
  const planned=structuredClone(value.commands[2]);if(planned.kind!=="buy_plan")throw Error();
  planned.payload.input.batch_id="batch:1";assert.throws(()=>appendJournalCommand(value.prefixes[2],planned),/BATCH_ALREADY_USED/);
  planned.payload.input.batch_id="batch:2";planned.payload.input.orders[0].order_id="order:1";
  assert.throws(()=>appendJournalCommand(value.prefixes[2],planned),/ORDER_ALREADY_USED/);
  assert.deepEqual(at,before);
});

test("rehashed events cannot forge states, cash, quantities or sever the verified chain",()=>{
  for(const field of ["after_state_hash","before_state_hash","previous_hash"] as const) {
    const journal=clone().prefixes[1];journal.events[0][field]="a".repeat(64);resealLast(journal);
    assert.throws(()=>replayJournal(journal),/CASH_JOURNAL_/);
  }
  const journal=clone().prefixes[5],event=journal.events.at(-1)!;if(event.kind!=="buy_resolution")throw Error();
  event.payload.result.orders[0].quantity="80";reseal(event.payload.result,"result_hash");resealLast(journal);
  assert.throws(()=>replayJournal(journal),/RESULT_REPLAY_MISMATCH/);
  const capital=clone().prefixes[1];const first=capital.events[0];if(first.kind!=="cash_contribution")throw Error();
  first.payload.amount_cny="2205";resealLast(capital);assert.throws(()=>replayJournal(capital),/STATE_REPLAY_MISMATCH/);
});

test("policy version drift, mismatched event times and source identities cannot continue an old study",()=>{
  const value=clone();value.declaration.implementation_hash="a".repeat(64);
  assert.throws(()=>newJournal(value.declaration),/IMPLEMENTATION_CHANGED/);
  const original=clone(),planned=structuredClone(original.commands[1]);planned.at="2025-01-02T08:00:00.000001Z";
  assert.throws(()=>appendJournalCommand(original.prefixes[1],planned),/DECISION_TIME_MISMATCH/);
  const resolution=structuredClone(original.commands[4]);resolution.at="2025-01-03T08:00:00.000001Z";
  assert.throws(()=>appendJournalCommand(original.prefixes[4],resolution),/EVALUATION_TIME_MISMATCH/);
});

test("actual SQLite registration, append, close/reopen and Web replay produce the same complete journal",()=>{
  const value=python("import json,tempfile; from pathlib import Path; from tests.execution_sandbox.journal_fixtures import scenario; from worker.execution_sandbox.journal_store import open_store,register_study,append_to_store,read_journal\nf=scenario()\nwith tempfile.TemporaryDirectory() as d:\n p=Path(d).resolve()/'events.sandbox.sqlite'; c=open_store(p); j=register_study(c,f['declaration'])\n for command in f['commands']: j=append_to_store(c,f['declaration']['study_id'],command,expected_head_hash=j['head_hash'])['journal']\n c.close(); c=open_store(p); j=read_journal(c,f['declaration']['study_id'],expected_head_hash=j['head_hash']); c.close(); print(json.dumps(j))");
  assert.deepEqual(value,fixture.journal);assert.equal(replayJournal(value).settled_cash_cny,"471.2");
});

test("prototype-like identifiers are own data properties, not inherited cash or position values",()=>{
  const value=clone();value.declaration.study_id="constructor";
  for(const command of value.commands) {
    if(command.kind==="buy_plan") {
      command.payload.input.orders[0].listing_id="constructor";
      if(command.payload.input.batch_id==="batch:1")command.payload.input.batch_id="constructor";
      command.payload.plan=planBuys(command.payload.input);
    } else if(command.kind==="buy_resolution") {
      if(command.payload.batch_id==="batch:1")command.payload.batch_id="constructor";
      const planned=value.commands.find(item=>item.kind==="buy_plan"&&item.payload.input.batch_id===command.payload.batch_id);
      if(!planned||planned.kind!=="buy_plan")throw Error();
      command.payload.result=executeBuys(planned.payload.input,planned.payload.plan,command.payload.outcome);
    }
  }
  const journal=rebuild(value).journal,state=replayJournal(journal);
  assert.equal(state.positions.constructor,"180");assert(Object.hasOwn(state.closed_batches,"constructor"));
  const other=python("import json,sys; from worker.execution_sandbox.journal import new_journal,append_command,replay_journal; v=json.load(sys.stdin); j=new_journal(v['declaration'])\nfor c in v['commands']: j=append_command(j,c)\nprint(json.dumps({'journal':j,'state':replay_journal(j)}))",value);
  assert.deepEqual({journal,state},other);
});

test("projection does not mutate commands, previous states or the original journal",()=>{
  const value=clone(),before=structuredClone(value),generated=rebuild(value);
  replayJournal(generated.journal);assert.deepEqual(value,before);
  assert.deepEqual(generated.journal,fixture.journal);
  const cash=value.commands[0];cash.command_id="test:zero";if(cash.kind!=="cash_contribution")throw Error();cash.payload.amount_cny="0";
  assert.throws(()=>appendJournalCommand(value.prefixes[0],cash),/CONTRIBUTION_NOT_POSITIVE/);
});

test("seeded overlapping batch histories independently retain cash, quantities and every execution gap",()=>{
  const vectors:Fixture[]=[];let seed=15041;
  const next=()=>{seed=(seed*48271)%2147483647;return seed;};
  for(let index=0;index<32;index++) {
    const value=clone();
    for(const command of value.commands) if(command.kind==="buy_resolution") {
      const plan=value.commands.find(row=>row.kind==="buy_plan"&&row.payload.input.batch_id===command.payload.batch_id);
      if(!plan||plan.kind!=="buy_plan")throw Error();
      const mode=next()%4;
      if(mode===0)command.payload.outcome.observations=[];
      else {command.payload.outcome.observations[0].close=["9.8","10.12","10.21"][mode-1];}
      command.payload.result=executeBuys(plan.payload.input,plan.payload.plan,command.payload.outcome);
    }
    vectors.push(value);
  }
  const actual=vectors.map(value=>{const journal=rebuild(value).journal;return {journal,state:replayJournal(journal)};});
  const other=python("import json,sys; from worker.execution_sandbox.journal import new_journal,append_command,replay_journal; rows=[]\nfor v in json.load(sys.stdin):\n j=new_journal(v['declaration'])\n for c in v['commands']: j=append_command(j,c)\n rows.append({'journal':j,'state':replay_journal(j)})\nprint(json.dumps(rows))",vectors.map(value=>({declaration:value.declaration,commands:value.commands})));
  assert.deepEqual(actual,other);
  for(const [index,{state}] of actual.entries()) {
    const resolutions=vectors[index].commands.filter(command=>command.kind==="buy_resolution");
    assert.equal(state.execution_failure_count,resolutions.reduce((count,c)=>count+c.payload.result.execution_failure_count,0));
    assert.equal(state.reserved_cny,"0");assert.equal(state.total_contributions_cny,"2304");
    const quantity=resolutions.flatMap(c=>c.payload.result.orders).filter(order=>order.status==="simulated_filled")
      .reduce((sum,order)=>sum+Number(order.quantity),0);
    assert.equal(state.positions["CN:SYNTHETIC_A"]??"0",String(quantity));
  }
});
