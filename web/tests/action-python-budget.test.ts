import assert from "node:assert/strict";
import test from "node:test";
import {actionPython} from "./action-maintenance-fixture";
import {investorFixture} from "./investor-fixture";

test("named offline fixture budgets reject unknown values before spawning",()=>{
  assert.throws(()=>actionPython("must-not-open.db","raise AssertionError('MUST_NOT_RUN')","unbounded" as never),/UNKNOWN_ACTION_FIXTURE_BUDGET/);
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
