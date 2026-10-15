import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const require=createRequire(new URL('../../web/package.json',import.meta.url));
const Ajv=require('ajv/dist/2020').default,formats=require('ajv-formats').default,ajv=new Ajv({strict:true,strictRequired:false});formats(ajv);
const dir=new URL('../../contracts/v1/',import.meta.url);
for(const name of readdirSync(dir).filter(name=>name.endsWith('.schema.json')))ajv.addSchema(JSON.parse(readFileSync(new URL(name,dir),'utf8')));
const prefix='https://etf-workbench.invalid/contracts/v1/';
const child=spawnSync(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??'python3',['-c',
 "import json; from tests.research.bounded_fixtures import case; from tests.investor.fixtures import profile; from tests.research.rotation_fixtures import plan; d,p,s=case(); print(json.dumps({'plan':p,'legacy':plan(),'request':{'action':'research','dataset':d,'plan':p,'policy':s,'profile':profile()}}))"],
 {cwd:new URL('../../',import.meta.url),encoding:'utf8',maxBuffer:2*1024*1024,timeout:30000});
assert.equal(child.status,0,child.stderr);const f=JSON.parse(child.stdout);

test('v3 is explicit and the old plan/execution JSON pointers stay closed',()=>{
 const legacy=ajv.getSchema(prefix+'research-plan.schema.json'),v3=ajv.getSchema(prefix+'research-plan-v3.schema.json'),input=ajv.getSchema(prefix+'research-plan-input.schema.json');
 assert.equal(legacy(f.legacy),true);assert.equal(legacy(f.plan),false);assert.equal(v3(f.plan),true);assert.equal(v3(f.legacy),false);
 assert.equal(input(f.plan),true);assert.equal(input(f.legacy),true);
 assert.equal(ajv.getSchema(prefix+'research-plan.schema.json#/properties/execution')(f.plan.execution),false);
});
test('the actual production investor research request explicitly accepts the new execution plan',()=>{
 assert.equal(ajv.getSchema(prefix+'investor-kernel-request.schema.json')(f.request),true);
});
test('bounds cannot be omitted, floated, disguised as legacy, or augmented with trade authority',()=>{
 const validate=ajv.getSchema(prefix+'research-plan-v3.schema.json');
 for(const change of [{...f.plan,execution:{...f.plan.execution,buy_price_buffer_bps:200}},
  {...f.plan,execution:{...f.plan.execution,buy_fx_buffer_bps:undefined}},
  {...f.plan,execution:{...f.plan.execution,model:'next_session_close_fixed_quantity'}},
  {...f.plan,execution_authorized:true}])assert.equal(validate(change),false);
});
test('v3 does not silently upgrade continuous planned-funding execution contracts',()=>{
 const validate=ajv.getSchema(prefix+'investor-long-horizon-input.schema.json');
 assert.equal(validate({schema_version:'investor-long-horizon-input-v1',plan:f.plan,dataset:f.request.dataset}),false);
});
