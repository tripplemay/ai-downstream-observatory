import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {readdirSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const require = createRequire(new URL('../../web/package.json',import.meta.url));
const Ajv = require('ajv/dist/2020').default, formats = require('ajv-formats').default;
const ajv = new Ajv({strict:true,strictRequired:false,allErrors:true}); formats(ajv);
const directory = new URL('../../contracts/v1/',import.meta.url);
const schemas = readdirSync(directory).filter(name => name.endsWith('.schema.json')).map(name => JSON.parse(readFileSync(new URL(name,directory),'utf8')));
schemas.forEach(schema => ajv.addSchema(schema));
const id = 'https://etf-workbench.invalid/contracts/v1/bounded-cash-buy.schema.json';
const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3',['-c',
  "import json; from tests.execution_sandbox.fixtures import buy_input,buy_outcome; from worker.execution_sandbox.bounded_cash import plan_buys,execute_buys; v=buy_input(); p=plan_buys(v); o=buy_outcome(v); print(json.dumps({'input':v,'plan':p,'outcomeInput':o,'result':execute_buys(v,p,o)}))"],
  {cwd:new URL('../../',import.meta.url),encoding:'utf8',maxBuffer:262144,timeout:30000});
assert.equal(child.status,0,child.stderr);
const documents = JSON.parse(child.stdout);

test('new sandbox documents and the unchanged legacy kernel union strictly compile together', () => {
  for (const fragment of ['', '#/$defs/input', '#/$defs/plan', '#/$defs/outcomeInput', '#/$defs/result']) assert(ajv.getSchema(id+fragment));
  assert(ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-kernel-request.schema.json'));
});

test('all four sandbox documents validate shared contracts without gaining live or trading grants', () => {
  for (const [kind,document] of Object.entries(documents)) {
    assert.equal(ajv.getSchema(id)(document),true);
    const validate = ajv.getSchema(id+'#/$defs/'+kind);
    assert.equal(validate(document),true);
    for (const extra of [{live_advice_eligible:true},{execution_authorized:true},{actual_holdings_linked:true},{provider_certified:true}]) {
      assert.equal(validate({...document,...extra}),false);
    }
    assert.equal(validate({...document,qualification:'owner_reviewed_reconstructed'}),false);
  }
});

test('legacy kernel request union cannot dispatch or reinterpret sandbox buy input', () => {
  const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-kernel-request.schema.json');
  for (const action of ['bounded_cash_buy','research','monitor']) assert.equal(validate({action,...documents.input}),false);
  assert.equal(ajv.getSchema('https://etf-workbench.invalid/contracts/v1/research-plan.schema.json')(documents.plan),false);
});

test('FX, money floats, alternate quanta, excessive batches and claimed partial quantities are structurally rejected', () => {
  const input = documents.input, validate = ajv.getSchema(id+'#/$defs/input');
  for (const change of [{orders:[{...input.orders[0],currency:'USD'}]}, {orders:[{...input.orders[0],market:'HK'}]},
    {settled_cash_cny:1202},{expected_contribution_cny:'5000'},{orders:Array(21).fill(input.orders[0])},
    {policy:{...input.policy,cash_quantum:'0.001'}}, {orders:[{...input.orders[0],allocated_budget_cny:'1e3'}]}])
    assert.equal(validate({...input,...change}),false);
  assert.equal(ajv.getSchema(id+'#/$defs/outcomeInput')({...documents.outcomeInput,
    observations:[{...documents.outcomeInput.observations[0],filled_quantity:'80'}]}),false);
});
