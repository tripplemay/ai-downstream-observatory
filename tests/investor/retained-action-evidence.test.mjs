import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require=createRequire(new URL('../../web/package.json',import.meta.url));
const Ajv=require('ajv/dist/2020').default,ajv=new Ajv({strict:true,strictRequired:false});
require('ajv-formats').default(ajv);
const schema=JSON.parse(readFileSync(new URL('../../contracts/v1/investor-retained-action-evidence.schema.json',import.meta.url),'utf8'));
const accepts=ajv.compile(schema);
let cached;
function fixture() {
  if(cached)return structuredClone(cached);
  const child=spawnSync(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??'python3',['-c',`
import json,socket
from tests.investor.test_retained_action_evidence import RetainedActionEvidenceTests
def forbidden(*args,**kwargs):raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')
socket.create_connection=forbidden;socket.getaddrinfo=forbidden
case=RetainedActionEvidenceTests();case.setUp()
try:
 case.baseline();case.correction();before=case.db.total_changes
 values=[case.read()['proof'],case.read(case.base['id'])['proof']]
 assert case.db.total_changes==before;case.assert_no_finance()
 print(json.dumps(values))
finally:case.doCleanups()
`],{cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH}});
  assert.equal(child.status,0,child.stderr);cached=JSON.parse(child.stdout);return structuredClone(cached);
}

test('independent schema accepts original raw-replay and manual-only proofs without approving current source use',()=>{
  for(const value of fixture())assert.equal(accepts(value),true,JSON.stringify(accepts.errors));
  const [managed,manual]=fixture();assert.equal(managed.capture_bindings.length,6);assert.equal(manual.capture_bindings.length,0);
  assert.equal(managed.economic_correction_approved,false);assert.equal(manual.original_raw_reports_replayed,false);
});

test('closed retained-evidence protocol cannot claim permissions, expose raw material or blur manual-only and provider replay',()=>{
  const [managed,manual]=fixture();
  for(const change of [{provider_calls:1},{database_writes:1},{current_source_eligibility_restored:true},{economic_correction_approved:true},
    {monitoring_resumed:true},{checkpoint_created:true},{historical_observations_rewritten:true},{trading_permission:true},
    {distribution:'external_ai'},{facts:{}},{raw:'fictional'},{purpose:'current_source_admission'},{capture_bindings:[]},
    {publication_id:null},{original_raw_reports_replayed:false}])assert.equal(accepts({...managed,...change}),false);
  for(const change of [{original_raw_reports_replayed:true},{capture_bindings:managed.capture_bindings},{publication_id:managed.publication_id}])
    assert.equal(accepts({...manual,...change}),false);
  const altered=structuredClone(managed);altered.capture_bindings[0].endpoint='https://fictional.invalid';assert.equal(accepts(altered),false);
  for(const forbidden of ['987.1234','988.1234','gross_per_unit','tax_assumption','excerpt'])assert.equal(JSON.stringify(managed).includes(forbidden),false);
});
