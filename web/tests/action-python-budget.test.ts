import assert from "node:assert/strict";
import test from "node:test";
import {actionPython} from "./action-maintenance-fixture";
import {investorFixture} from "./investor-fixture";

test("named offline fixture budgets reject unknown values before spawning",()=>{
  assert.throws(()=>actionPython("must-not-open.db","raise AssertionError('MUST_NOT_RUN')","unbounded" as never),/UNKNOWN_ACTION_FIXTURE_BUDGET/);
});
test("a shared preparation deadline can only shorten a named budget and rejects invalid or exhausted clocks before spawning",t=>{
  for(const value of [NaN,Infinity,-Infinity,"120000",null])
    assert.throws(()=>actionPython("must-not-open.db","raise AssertionError('MUST_NOT_RUN')","core_readmission",value as number),/INVALID_ACTION_FIXTURE_DEADLINE/);
  assert.throws(()=>actionPython("must-not-open.db","raise AssertionError('MUST_NOT_RUN')","core_readmission",performance.now()-1),/DEADLINE_EXPIRED/);
  const f=investorFixture();t.after(f.close);const lines:string[]=[];
  t.mock.method(process.stderr,"write",(line:unknown)=>{lines.push(String(line));return true;});
  assert.deepEqual(actionPython(f.filename,"print('{}')","core_readmission",performance.now()+999999),{});
  const capped=JSON.parse(lines.at(-1)!.slice("OFFLINE_ACTION_FIXTURE_TIMING ".length));
  assert.equal(capped.deadline_ms,120000);assert.equal(capped.timed_out,false);
  assert.throws(()=>actionPython(f.filename,"import time;time.sleep(2);print('{}')","core_readmission",performance.now()+150),/OFFLINE_ACTION_FIXTURE_ETIMEDOUT/);
  const limited=JSON.parse(lines.at(-1)!.slice("OFFLINE_ACTION_FIXTURE_TIMING ".length));
  assert.ok(limited.deadline_ms>0&&limited.deadline_ms<=150);assert.equal(limited.timed_out,true);
});

test("all bounded fixture modes preserve the offline network guard and normal exit checks",t=>{
  const f=investorFixture();t.after(()=>f.close());
  const code=`
try:socket.create_connection(('invalid.example.test',443))
except AssertionError as error:
 assert str(error)=='OFFLINE_FIXTURE_NETWORK_FORBIDDEN'
else:raise AssertionError('NETWORK_GUARD_MISSING')
print(json.dumps({'offline':True}))
`;
  assert.deepEqual(actionPython(f.filename,code),{offline:true});
  assert.deepEqual(actionPython(f.filename,code,"core_readmission"),{offline:true});
  assert.deepEqual(actionPython(f.filename,code,"legacy_transition"),{offline:true});
  assert.throws(()=>actionPython(f.filename,"raise AssertionError('FICTIONAL_FAILURE')","core_readmission"),/FICTIONAL_FAILURE/);
});
