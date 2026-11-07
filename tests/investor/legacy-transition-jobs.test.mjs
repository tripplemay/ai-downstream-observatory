import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(path.join(root,'web/package.json'));
const Ajv=require('ajv/dist/2020'),addFormats=require('ajv-formats'),ajv=new Ajv({strict:true,strictRequired:false});addFormats(ajv);
for(const name of fs.readdirSync(path.join(root,'contracts/v1')).filter(name=>name.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(root,'contracts/v1',name),'utf8')));
const prefix='https://etf-workbench.invalid/contracts/v1/investor-legacy-transition-job.schema.json#/$defs/';
const request=ajv.getSchema(prefix+'request'),result=ajv.getSchema(prefix+'result');let saved;
function fixture(){
  if(!saved){const child=spawnSync(process.env.WORKBENCH_TEST_PYTHON||'python3',['-m','tests.investor.test_legacy_transition_jobs','--contract'],
    {cwd:root,encoding:'utf8',timeout:120000,maxBuffer:1048576});assert.equal(child.status,0,child.stderr);saved=JSON.parse(child.stdout);}
  return structuredClone(saved);
}
test('closed independent contracts validate actual preview and combined root-registration job resources',()=>{
  const value=fixture();for(const key of ['preview_request','confirmation_request'])assert.equal(request(value[key]),true,key);
  for(const key of ['preview_result','registered_result'])assert.equal(result(value[key]),true,key);
  assert.equal(value.registered_result.monitor_source_registered,true);assert.equal(value.registered_result.current_advice_certified,false);
});
test('unacknowledged consent, unknown payload and cosmetic success without registration cannot satisfy the job protocol',()=>{
  const value=fixture();const missing=value.confirmation_request;delete missing.body.acknowledgements.research_only_no_trading;assert.equal(request(missing),false);
  const extra=fixture().preview_request;extra.body.quotes=[];assert.equal(request(extra),false);
  for(const key of ['monitor_source_registered','current_advice_certified','monitoring_activated','trading_permission','provider_calls']){
    const doc=fixture().registered_result;doc[key]=key==='monitor_source_registered'?false:key==='provider_calls'?1:true;assert.equal(result(doc),false,key);
  }
  const falseResult=fixture().registered_result;falseResult.kind='preview';assert.equal(result(falseResult),false);
});
