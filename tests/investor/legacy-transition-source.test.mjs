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
const prefix='https://etf-workbench.invalid/contracts/v1/';
const validate={input:ajv.getSchema(prefix+'investor-monitor-data-input-v5.schema.json'),projection:ajv.getSchema(prefix+'investor-monitor-data-projection-v3.schema.json'),
  admission:ajv.getSchema(prefix+'investor-legacy-transition-source.schema.json#/$defs/admission')};
let saved;
function fixture(){
  if(!saved){const result=spawnSync(process.env.WORKBENCH_TEST_PYTHON||'python3',['-m','tests.investor.test_legacy_transition_source','--contract'],
    {cwd:root,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr);saved=JSON.parse(result.stdout);}
  return structuredClone(saved);
}

test('independent contracts validate actual distinct admitted bridge output without rewriting old schema versions',()=>{
  const value=fixture();for(const kind of ['input','projection','admission'])assert.equal(validate[kind](value[kind]),true,kind);
  assert.equal(value.input.schema_version,'investor-monitor-data-input-v5');assert.equal(value.projection.schema_version,'investor-monitor-data-projection-v3');
  assert.equal(value.projection.knowledge_protocol,'owner_confirmed_legacy_accounting_carry_v1');assert.equal(value.admission.monitoring_activated,false);
});

test('raw audited projection, retention and exact consent references are mandatory and cannot accept caller prices',()=>{
  for(const key of ['transition','audited_projection_hash','audited_valid_until']){const value=fixture().input;delete value[key];assert.equal(validate.input(value),false,key);}
  for(const [key,value] of [['quotes',[]],['fx',[]],['live_advice_eligible',true]]){const doc=fixture().input;doc[key]=value;assert.equal(validate.input(doc),false,key);}
  const doc=fixture().input;doc.transition.approved=true;assert.equal(validate.input(doc),false);
});

test('conservative original knowledge cannot masquerade as pure audited v2 or trading activation',()=>{
  const value=fixture().projection;value.schema_version='investor-monitor-data-projection-v2';assert.equal(validate.projection(value),false);
  for(const key of ['transition','knowledge_protocol']){const doc=fixture().projection;delete doc[key];assert.equal(validate.projection(doc),false,key);}
  for(const key of ['monitoring_activated','trading_permission','raw_ai_sharing']){const doc=fixture().admission;doc[key]=true;assert.equal(validate.admission(doc),false,key);}
});
