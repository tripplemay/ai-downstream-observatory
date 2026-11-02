import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'web/package.json'));
const Ajv = require('ajv/dist/2020'), addFormats = require('ajv-formats');
const ajv = new Ajv({ strict: true, strictRequired: false }); addFormats(ajv);
for (const name of readdirSync(path.join(root, 'contracts/v1')).filter(name => name.endsWith('.schema.json'))) {
  ajv.addSchema(JSON.parse(readFileSync(path.join(root, 'contracts/v1', name), 'utf8')));
}
const schema = 'https://etf-workbench.invalid/contracts/v1/investor-action-restatement-kernel.schema.json';
let saved;
function fixtures() {
  if (!saved) {
    const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-m', 'tests.investor.test_action_restatement_kernel', '--contract'],
      { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 4194304 });
    assert.ok(!result.error, `OFFLINE_RESTATEMENT_${result.error?.code ?? 'SPAWN_FAILURE'}`);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null); saved = JSON.parse(result.stdout);
  }
  return structuredClone(saved);
}

test('closed independent schemas accept real fictional economic replay including funding-bound and multi-window history', () => {
  const values = fixtures(); assert.equal(Object.keys(values).length, 16);
  for (const value of Object.values(values)) for (const kind of ['input', 'result']) {
    const validate = ajv.getSchema(schema + '#/$defs/' + kind);
    assert.equal(validate(value[kind]), true, JSON.stringify(validate.errors));
  }
  assert.equal(values.funded_fixed.input.head.schema_version, 'investor-evidence-model-checkpoint-v3');
  assert.equal(values.long_ledger.input.original_actions.length, 600);
  assert.equal(values.ex_entitlement_before_later_split.result.difference_cny, '48');
});

test('arithmetic results cannot confer source proof, rewrite history, resume monitoring or approve trading', () => {
  const validate = ajv.getSchema(schema + '#/$defs/result');
  for (const key of ['source_evidence_verified', 'checkpoint_created', 'state_published', 'historical_observations_rewritten',
    'historical_strategy_results_recomputed', 'monitoring_resumed', 'current_advice_certified', 'trading_permission']) {
    const value = fixtures().paid.result; value[key] = true; assert.equal(validate(value), false, key);
  }
  const value = fixtures().paid.result; value.original.initial_notional_cny = '1'; assert.equal(validate(value), false);
});
