import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const require=createRequire(new URL('../../web/package.json',import.meta.url));
const Ajv=require('ajv/dist/2020').default,formats=require('ajv-formats').default,ajv=new Ajv({strict:true,strictRequired:false});formats(ajv);
const dir=new URL('../../contracts/v1/',import.meta.url);
for(const name of readdirSync(dir).filter(name=>name.endsWith('.schema.json')))ajv.addSchema(JSON.parse(readFileSync(new URL(name,dir),'utf8')));
const id='https://etf-workbench.invalid/contracts/v1/bounded-cash-run.schema.json';
const child=spawnSync(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??'python3',['-c',
 "import json; from tests.execution_sandbox.run_fixtures import scenario,run_input; f=scenario(); print(json.dumps({'input':run_input(f['input']),'result':f['comparison']['candidate'],'comparisonInput':f['input'],'comparison':f['comparison']}))"],
 {cwd:new URL('../../',import.meta.url),encoding:'utf8',maxBuffer:4*1024*1024,timeout:30000});
assert.equal(child.status,0,child.stderr);const documents=JSON.parse(child.stdout);

test('whole runs, decision lineage and market comparator share closed contracts',()=>{
 for(const [kind,value] of Object.entries(documents)) {
  const validate=ajv.getSchema(id+'#/$defs/'+kind);assert.equal(validate(value),true,kind);assert.equal(ajv.getSchema(id)(value),true,kind);
  assert.equal(validate({...value,execution_authorized:true}),false);
 }
});
test('real-data qualification, live authority and independent registration cannot be fabricated',()=>{
 for(const [kind,value] of Object.entries(documents)) {
  assert.equal(ajv.getSchema(id+'#/$defs/'+kind)({...value,qualification:'owner_reviewed_reconstructed'}),false);
 }
 const validate=ajv.getSchema(id+'#/$defs/comparison');
 assert.equal(validate({...documents.comparison,live_advice_eligible:true}),false);
 assert.equal(validate({...documents.comparison,parameters_independently_preregistered:true}),false);
 assert.equal(validate({...documents.comparison,benchmark_kind:'actual_investable_index'}),false);
});
test('run sizes are bounded and manually supplied journal or decisions cannot bypass generation',()=>{
 const input=documents.input,validate=ajv.getSchema(id+'#/$defs/input');
 assert.equal(validate({...input,journal:documents.result.journal}),false);
 assert.equal(validate({...input,decision_points:Array(129).fill(input.decision_points[0])}),false);
 assert.equal(validate({...input,frames:Array(30001).fill(input.frames[0])}),false);
});
test('new run protocol is not silently accepted by the old production investor kernel union',()=>{
 const validate=ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-kernel-request.schema.json');
 for(const value of Object.values(documents))assert.equal(validate({action:'research',...value}),false);
});
