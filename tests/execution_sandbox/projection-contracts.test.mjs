import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const require=createRequire(new URL('../../web/package.json',import.meta.url));
const Ajv=require('ajv/dist/2020').default,formats=require('ajv-formats').default,ajv=new Ajv({strict:true,strictRequired:false});formats(ajv);
const dir=new URL('../../contracts/v1/',import.meta.url);
for(const name of readdirSync(dir).filter(name=>name.endsWith('.schema.json')))ajv.addSchema(JSON.parse(readFileSync(new URL(name,dir),'utf8')));
const id='https://etf-workbench.invalid/contracts/v1/bounded-cash-projection.schema.json';
const child=spawnSync(process.env.WORKBENCH_TEST_PYTHON??process.env.WORKBENCH_PYTHON??'python3',['-c',
 "import json; from tests.execution_sandbox.projection_fixtures import scenario; f=scenario(); print(json.dumps({'program':f['program'],'decisionInput':f['decision_inputs'][0],'decision':f['decisions'][0],'valuationInput':f['valuation_input'],'report':f['report']}))"],
 {cwd:new URL('../../',import.meta.url),encoding:'utf8',maxBuffer:2*1024*1024,timeout:30000});
assert.equal(child.status,0,child.stderr);const documents=JSON.parse(child.stdout);

test('program, decision, causal valuation inputs and reports share closed cross-language contracts',()=>{
 for(const [kind,value] of Object.entries(documents)) {
  const validate=ajv.getSchema(id+'#/$defs/'+kind);assert.equal(validate(value),true,kind);assert.equal(ajv.getSchema(id)(value),true,kind);
  assert.equal(validate({...value,execution_authorized:true}),false);assert.equal(validate({...value,actual_holdings_linked:true}),false);
 }
});
test('synthetic qualification and no independent preregistration/live advice cannot be escalated',()=>{
 const p=documents.program,validate=ajv.getSchema(id+'#/$defs/program');
 for(const change of [{qualification:'real_data'},{parameters_independently_preregistered:true},{live_advice_eligible:true},
  {cash_target_bps:10000},{targets:[{...p.targets[0],weight_bps:1.5}]}]) assert.equal(validate({...p,...change}),false);
 const report=ajv.getSchema(id+'#/$defs/report');
 assert.equal(report({...documents.report,valuation_basis:'actual_execution_settlement'}),false);
 assert.equal(report({...documents.report,cash_reference:{...documents.report.cash_reference,investable_market_benchmark:true}}),false);
});
test('numeric money, unsupported actions, missing frames and unbounded histories are rejected structurally',()=>{
 const v=structuredClone(documents.decisionInput);v.marks[0].corporate_action_unaccounted=true;
 assert.equal(ajv.getSchema(id+'#/$defs/decisionInput')(v),false);
 const p=structuredClone(documents.program);p.funding_schedule[0].amount_cny=1000;
 assert.equal(ajv.getSchema(id+'#/$defs/program')(p),false);
 const r=documents.valuationInput;
 assert.equal(ajv.getSchema(id+'#/$defs/valuationInput')({...r,event_frames:Array(513).fill(r.final_frame)}),false);
});
test('the production investor request union does not route this offline projection engine',()=>{
 const validate=ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-kernel-request.schema.json');
 for(const value of Object.values(documents))assert.equal(validate({action:'research',...value}),false);
});
