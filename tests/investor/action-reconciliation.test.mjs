import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020').default;
const ajv = new Ajv({ strict: true, strictRequired: false });
require('ajv-formats').default(ajv);
for (const name of ['common', 'investor-action-crosscheck']) {
  ajv.addSchema(JSON.parse(fs.readFileSync(new URL(`../../contracts/v1/${name}.schema.json`, import.meta.url), 'utf8')));
}
const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-action-crosscheck.schema.json');
let document;
function fixture() {
  if (document) return structuredClone(document);
  const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3',
    ['-m', 'tests.investor.action_reconciliation_fixture'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  document = JSON.parse(result.stdout);
  return structuredClone(document);
}

test('independent schema accepts a replayed fictional comparison without giving it economic approval', () => {
  const value = fixture();
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(value.evidence_mode, 'synthetic_test_only');
  assert.equal(value.comparison.counts.matched_dates, 1);
  assert.equal(value.comparison.counts.nominal_amount_matches, 0);
  assert.equal(value.comparison.counts.nominal_amount_differences, 1);
  assert.equal(value.comparison.precision.acceptance_tolerance_applied, false);
  assert.equal(JSON.stringify(value).includes('987.123'), false);
});

test('comparison contract rejects economic grants, raw fields and hidden numeric tolerance', () => {
  const value = fixture();
  for (const key of ['owner_reviewed', 'corporate_actions_complete', 'research_admitted', 'live_advice_eligible',
    'trading_permission', 'market_values_output', 'empty_split_list_is_absence_proof']) {
    assert.equal(validate({ ...value, [key]: true }), false, key);
  }
  for (const change of [{ records: [] }, { tax_per_unit: '0' }, { source_calls: 1 }, { database_writes: 1 }]) {
    assert.equal(validate({ ...value, ...change }), false);
  }
  for (const change of [{ acceptance_tolerance_applied: true }, { supplier_precision_contract_verified: true },
    { tolerance: '0.001' }, { distribution_amount: '987.1234' }]) {
    const changed = structuredClone(value);
    Object.assign(changed.comparison.precision, change);
    assert.equal(validate(changed), false);
  }
});

test('contract binds fixed requested identities and cannot relabel injected captures as official', () => {
  const value = fixture();
  assert.equal(validate({ ...value, requested_fund_id: '0928' }), false);
  assert.equal(validate({ ...value, provider_symbol: 'OTHER.US' }), false);
  assert.equal(validate({ ...value, evidence_mode: 'official_capture_replay' }), false);
  for (const binding of Object.values(value.bindings)) {
    assert.equal(typeof binding.raw_sha256, 'string');
    assert.equal(typeof binding.control_hash, 'string');
    assert.equal('payload' in binding, false);
  }
});
