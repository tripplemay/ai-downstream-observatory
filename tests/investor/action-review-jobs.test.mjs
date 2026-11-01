import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(path.join(root,'web/package.json'));
const Ajv=require('ajv/dist/2020'),formats=require('ajv-formats'),ajv=new Ajv({strict:true,strictRequired:false});formats(ajv);
for(const name of fs.readdirSync(path.join(root,'contracts/v1')).filter(name=>name.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(root,'contracts/v1',name),'utf8')));
const base='https://etf-workbench.invalid/contracts/v1/investor-action-review-job.schema.json#/$defs/';
const validRequest=ajv.getSchema(base+'request'),validResult=ajv.getSchema(base+'result');let saved;
function fixture(){
  if(!saved){const result=spawnSync(process.env.WORKBENCH_TEST_PYTHON??'python3',['-m','tests.investor.test_action_review_jobs','--contract'],{cwd:root,encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr);saved=JSON.parse(result.stdout);}
  return structuredClone(saved);
}
test('independent closed job contracts accept actual fictional queued intent, fenced results and owner witness',()=>{
  const value=fixture();for(const row of value.requests)assert.equal(validRequest(row),true,JSON.stringify(validRequest.errors));
  for(const row of value.results)assert.equal(validResult(row),true,JSON.stringify(validResult.errors));
  assert.equal(value.witness.validity_policy,'owner_review_15m');
});
test('intent cannot choose provider calls, extend witness policy or omit separate enable choice and consent',()=>{
  const extra=fixture().requests[0];extra.body.validity_policy='owner_review_15m';assert.equal(validRequest(extra),false);
  const missing=fixture().requests[1];delete missing.body.enable_rule;assert.equal(validRequest(missing),false);
  const consent=fixture().requests[1];consent.body.acknowledgements.explicit_tax_amounts=false;assert.equal(validRequest(consent),false);
  const provider=fixture().requests[0];provider.provider_calls=1;assert.equal(validRequest(provider),false);
});
test('job result cannot pretend admission, trading, a mismatched kind, or success without its immutable resource',()=>{
  for(const key of ['research_admitted','trading_permission']){const row=fixture().results[0];row[key]=true;assert.equal(validResult(row),false,key);}
  const kind=fixture().results[0];kind.kind='confirmation';assert.equal(validResult(kind),false);
  const missing=fixture().results[1];missing.resource_id=null;assert.equal(validResult(missing),false);
  const budget=fixture().results[0];budget.provider_calls=1;assert.equal(validResult(budget),false);
});
