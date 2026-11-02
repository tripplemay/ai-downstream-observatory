import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require=createRequire(new URL('../../web/package.json',import.meta.url)),Ajv=require('ajv/dist/2020').default;
const ajv=new Ajv({strict:true,strictRequired:false});require('ajv-formats').default(ajv);
const accepts=ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/v1/investor-retained-monitor-history.schema.json',import.meta.url),'utf8')));
let cached;
function fixture() {
  if(cached)return structuredClone(cached);
  const child=spawnSync(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??'python3',['-c',`
import json,socket
from tests.investor.test_runtime import InvestorRuntimeTests
from tests.investor.test_retained_monitor_history import plain_history_case
def forbidden(*a,**k):raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')
socket.create_connection=forbidden;socket.getaddrinfo=forbidden
c=InvestorRuntimeTests();c.setUp()
try:print(json.dumps(plain_history_case(c.db,c.path,protocol='v4',fixed=True)['history']['proof']))
finally:c.doCleanups()
`],{cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH}});
  assert.equal(child.status,0,child.stderr);cached=JSON.parse(child.stdout);return structuredClone(cached);
}
test('closed recorded-history contract binds actual original states and inputs without current-source or corrected-evidence approval',()=>{
  const proof=fixture();assert.equal(accepts(proof),true,JSON.stringify(accepts.errors));
  assert.equal(proof.original_inputs_replayed,true);assert.equal(proof.original_states_replayed,true);assert.equal(proof.corrected_source_evidence_verified,false);
  for(const forbidden of ['gross_per_unit','tax_assumption','quantities','cash_by_currency','quotes','account'])assert.equal(JSON.stringify(proof).includes(forbidden),false);
});
test('a recorded-history proof cannot grant correction, recovery, current advice, database writes, calls or leak raw facts',()=>{
  const proof=fixture();
  for(const change of [{corrected_source_evidence_verified:true},{current_source_eligibility_restored:true},{economic_correction_approved:true},
    {monitoring_resumed:true},{checkpoint_created:true},{trading_permission:true},{historical_observations_rewritten:true},{provider_calls:1},{database_writes:1},
    {status:'recovered'},{distribution:'external_ai'},{quotes:[]},{facts:{}},{input_bindings:[]},{head_checkpoint_sequence:1001}])assert.equal(accepts({...proof,...change}),false);
  const altered=structuredClone(proof);altered.input_bindings[0].source_url='https://fictional.invalid';assert.equal(accepts(altered),false);
  altered.input_bindings=structuredClone(proof.input_bindings);altered.input_bindings[0].input_protocol='investor-monitor-data-input-v6';assert.equal(accepts(altered),false);
});
