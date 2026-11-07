import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'web/package.json'));
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const ajv = new Ajv({ strict: true, strictRequired: false }); addFormats(ajv);
for (const name of fs.readdirSync(path.join(root,'contracts/v1')).filter(name=>name.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(root,'contracts/v1',name),'utf8')));
const base = 'https://etf-workbench.invalid/contracts/v1/investor-action-review-workflow.schema.json#/$defs/';
const preview = ajv.getSchema(base+'preview'), confirmation = ajv.getSchema(base+'confirmation'), submit = ajv.getSchema(base+'submit');
let saved;
function fixture() {
  if (!saved) {
    const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON || 'python3',['-m','tests.investor.test_action_review_workflow','--contract'],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr); saved=JSON.parse(result.stdout);
  }
  return structuredClone(saved);
}

test('closed contracts distinguish an unapproved server witness from an actual fictional registered owner confirmation',()=>{
  const value=fixture(); assert.equal(preview(value.preview),true,JSON.stringify(preview.errors));
  assert.equal(confirmation(value.confirmation),true,JSON.stringify(confirmation.errors));
  assert.equal(value.preview.approval_performed,false); assert.equal(value.confirmation.monitor_data_readmission_required,true);
  assert.equal(value.confirmation.research_admitted,false); assert.equal(value.confirmation.request.enable_rule,false);
});

test('tax, exact assumptions and separate maintenance consent cannot be missing, guessed or silently enabled',()=>{
  for (const key of Object.keys(fixture().confirmation.request.acknowledgements)) {
    const request=fixture().confirmation.request; request.acknowledgements[key]=false; assert.equal(submit(request),false,key);
  }
  const tax=fixture().confirmation.request; tax.new_events[0].tax_per_unit=null; assert.equal(submit(tax),false);
  const enabled=fixture().confirmation.request; delete enabled.enable_rule; assert.equal(submit(enabled),false);
  const gross=fixture().confirmation.request; gross.new_events[0].gross_per_unit='9999'; assert.equal(submit(gross),false);
  const expiry=fixture().confirmation.request; expiry.valid_until='2027-01-01T00:00:00Z'; assert.equal(submit(expiry),false);
});

test('a confirmation cannot confer admission, trading, raw AI sharing, quarantine clearing or provider retries',()=>{
  for (const key of ['research_admitted','trading_permission','raw_ai_sharing','quarantine_cleared']) {
    const value=fixture().confirmation; value[key]=true; assert.equal(confirmation(value),false,key);
  }
  const request=fixture().confirmation; request.provider_calls=1; assert.equal(confirmation(request),false);
  const bad=fixture().preview; bad.approval_performed=true; assert.equal(preview(bad),false);
});
