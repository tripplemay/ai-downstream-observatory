import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
const require=createRequire(new URL('../../web/package.json',import.meta.url)),Ajv=require('ajv/dist/2020');
const ajv=new Ajv({strict:true,strictRequired:false});require('ajv-formats')(ajv);
for(const name of readdirSync(new URL('../../contracts/v1',import.meta.url)).filter(name=>name.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(readFileSync(new URL('../../contracts/v1/'+name,import.meta.url),'utf8')));
const schema='https://etf-workbench.invalid/contracts/v1/investor-correction-impact-job.schema.json';
test('closed correction result is explicitly hypothetical or a null rejection, never source or trading approval',()=>{
  const valid=ajv.getSchema(schema+'#/$defs/result'),doc={schema_version:'investor-correction-impact-job-result-v1',result_id:'r',request_id:'q',workspace_id:'w',
    request_hash:'a'.repeat(64),job_id:'j',fencing_token:1,outcome:'rejected',code:'CORRECTION_IMPACT_SOURCE_UNAVAILABLE',impact:null,change_fence:null,implementation_hash:'b'.repeat(64),created_at:'2026-11-07T06:00:04.001Z'};
  assert.equal(valid(doc),true,JSON.stringify(valid.errors));
  for(const patch of [{outcome:'preview_ready'},{impact:{}},{change_fence:'a'.repeat(64)},{code:'CORRECTION_IMPACT_READY'},{provider_calls:1},{trading_permission:true},{source_evidence_verified:true},{fencing_token:0}])assert.equal(valid({...doc,...patch}),false);
});
