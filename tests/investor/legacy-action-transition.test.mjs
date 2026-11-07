import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'web/package.json'));
const Ajv = require('ajv/dist/2020'), addFormats = require('ajv-formats');
const ajv = new Ajv({ strict: true, strictRequired: false }); addFormats(ajv);
for (const name of fs.readdirSync(path.join(root, 'contracts/v1')).filter(name => name.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(root, 'contracts/v1', name), 'utf8')));
const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-legacy-action-transition-preview.schema.json');
let saved;
function fixture() {
  if (!saved) {
    const value = spawnSync(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-m', 'tests.investor.test_legacy_action_transition', '--contract'],
      { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.equal(value.status, 0, value.stderr); saved = JSON.parse(value.stdout);
  }
  return structuredClone(saved);
}

test('closed independent schema accepts actual retained-source legacy comparison, not a monitoring input', () => {
  const value = fixture(); assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.ok(value.carry_forward.length > 0); assert.equal(value.checkpoint.sequence, 1);
  assert.equal(value.admission_performed, false); assert.equal(value.live_advice_eligible, false);
});

test('comparison cannot claim approval, current prices, normalized wealth or order permission', () => {
  for (const [key, value] of [['status', 'approved'], ['admission_performed', true], ['live_advice_eligible', true],
    ['model_nav_cny', '10000'], ['quotes', []], ['trading_permission', true]]) {
    const doc = fixture(); doc[key] = value; assert.equal(validate(doc), false, key);
  }
});

test('original checkpoint, input and per-event knowledge bindings remain closed and mandatory', () => {
  for (const key of ['chain_hash', 'processed_actions_hash']) {
    const doc = fixture(); delete doc.checkpoint[key]; assert.equal(validate(doc), false, key);
  }
  for (const key of ['original_input_hash', 'original_action_hash', 'audited_action_hash', 'recorded_known_at', 'audited_known_at']) {
    const doc = fixture(); delete doc.carry_forward[0][key]; assert.equal(validate(doc), false, key);
  }
  const doc = fixture(); doc.carry_forward[0].amount = '1'; assert.equal(validate(doc), false);
});

test('a well-shaped hash is not evidence or confirmation authority', () => {
  const doc = fixture(); doc.checkpoint.chain_hash = '0'.repeat(64);
  assert.equal(validate(doc), true); assert.equal(doc.status, 'awaiting_explicit_protocol_confirmation');
  assert.equal(doc.admission_performed, false);
});
