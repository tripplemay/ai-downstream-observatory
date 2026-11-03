import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../../', import.meta.url), require = createRequire(new URL('../../web/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020'), ajv = new Ajv({ strict: true, strictRequired: false }); require('ajv-formats')(ajv);
for (const name of readdirSync(new URL('contracts/v1/', root)).filter(name => name.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(readFileSync(new URL('contracts/v1/' + name, root), 'utf8')));
const schema = 'https://etf-workbench.invalid/contracts/v1/investor-model-epoch-transition.schema.json';
let saved;
function fixtures() {
  if (!saved) {
    const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c', `
from tests.investor.test_model_epoch_transition import epoch_cases
from worker.investor.model_epoch_transition import advance_corrected_model_epoch
from worker.orchestration.db import canonical_json
print(canonical_json({key:{'input':value,'result':advance_corrected_model_epoch(value)} for key,value in epoch_cases().items()}))
`], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 2097152 });
    assert.ok(!result.error, result.error?.code); assert.equal(result.status, 0, result.stderr); saved = JSON.parse(result.stdout);
  }
  return structuredClone(saved);
}
test('continuation has its own closed protocol, immutable epoch and source-unverified v4 results', () => {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c', `
from tests.investor.test_model_epoch_transition import continuation_cases
from worker.investor.model_epoch_transition import continue_corrected_model_epoch
from worker.orchestration.db import canonical_json
print(canonical_json({key:{'input':value,'result':continue_corrected_model_epoch(value)} for key,value in continuation_cases().items()}))
`], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 2097152 });
  assert.ok(!child.error, child.error?.code); assert.equal(child.status, 0, child.stderr);
  for (const value of Object.values(JSON.parse(child.stdout))) {
    const input = ajv.getSchema(schema + '#/$defs/continuation_input'), result = ajv.getSchema(schema + '#/$defs/result');
    assert.equal(input(value.input), true, JSON.stringify(input.errors));
    assert.equal(result(value.result), true, JSON.stringify(result.errors));
    assert.deepEqual(value.result.epoch_binding, value.input.previous.epoch_binding);
    assert.equal(value.result.registered_bindings_verified, false);
    assert.equal(ajv.getSchema(schema)(value.input), false);
  }
});
test('closed epoch arithmetic and v4 candidate schemas bind original history without certifying sources or registration', () => {
  for (const value of Object.values(fixtures())) for (const kind of ['input', 'result']) {
    const validate = ajv.getSchema(schema + '#/$defs/' + kind);
    assert.equal(validate(value[kind]), true, JSON.stringify(validate.errors));
  }
  const value = fixtures().multi_listing.result;
  assert.equal(value.epoch_binding.corrections.length, 2); assert.equal(value.registered_bindings_verified, false);
  assert.equal(value.checkpoint.schema_version, 'investor-evidence-model-checkpoint-v4');
  assert.equal(ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-evidence-model-checkpoint-v3.schema.json')(value.checkpoint), false);
});
test('epoch arithmetic cannot grant monitoring, write rows, expose a stale candidate or bypass immutable protocol shape', () => {
  const validate = ajv.getSchema(schema + '#/$defs/result'), value = fixtures().paid.result;
  for (const key of ['registered_bindings_verified', 'source_evidence_verified', 'checkpoint_created', 'state_published',
    'monitoring_resumed', 'historical_observations_rewritten', 'historical_strategy_results_recomputed', 'trading_permission'])
    assert.equal(validate({ ...value, [key]: true }), false, key);
  assert.equal(validate({ ...value, database_writes: 1 }), false);
  assert.equal(validate({ ...value, provider_calls: 1 }), false);
  const stale = fixtures().stale.result;
  assert.equal(stale.checkpoint, null); assert.equal(stale.monitor_request, null);
  assert.equal(validate({ ...stale, checkpoint: value.checkpoint }), false);
  assert.equal(validate({ ...value, checkpoint: null }), false);
  const request = fixtures().paid.input;
  assert.equal(ajv.getSchema(schema)({ ...request, force: true }), false);
});
