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
for (const name of ['common.schema.json', 'investor-action-crosscheck.schema.json', 'investor-action-review-draft.schema.json']) {
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(root, 'contracts/v1', name), 'utf8')));
}
const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-action-review-draft.schema.json');
let saved;
function fixture() {
  if (!saved) {
    const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-m', 'tests.investor.test_action_review_draft', '--contract'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); saved = JSON.parse(result.stdout);
  }
  return structuredClone(saved);
}

test('strict independent contract accepts an actual unapproved fictional retained-source preview', () => {
  const doc = fixture(); assert.equal(validate(doc), true, JSON.stringify(validate.errors));
  assert.equal(doc.status, 'new_reported_actions'); assert.equal(doc.changes[0].tax_per_unit, null);
});

test('a preview cannot default tax to zero or invent event and payment instants', () => {
  for (const [key, value] of [['tax_per_unit','0'], ['effective_at','2026-11-02T14:30:00Z'], ['payment_at','2026-11-09T21:00:00Z']]) {
    const doc = fixture(); doc.changes[0][key] = value; assert.equal(validate(doc), false, key);
  }
});

test('preview cannot approve, enable, clear quarantine, share to AI or claim economic admission', () => {
  for (const key of ['confirmation_supported', 'approval_performed', 'new_review_created', 'new_rule_enabled', 'quarantine_cleared', 'research_admitted', 'live_advice_eligible', 'trading_permission']) {
    const doc = fixture(); doc[key] = true; assert.equal(validate(doc), false, key);
  }
  const doc = fixture(); doc.visibility = 'external_ai'; assert.equal(validate(doc), false);
  const injected = fixture(); injected.source_report.evidence_mode = 'synthetic_test_only'; assert.equal(validate(injected), false);
});

test('unapproved source discrepancies cannot be relabelled as no changes or hidden historical corrections', () => {
  const empty = fixture(); empty.status = 'no_reported_changes'; assert.equal(validate(empty), false);
  const hidden = fixture(); hidden.changes[0].disposition = 'historical_correction'; assert.equal(validate(hidden), false);
  hidden.status = 'historical_correction_required'; assert.equal(validate(hidden), true, JSON.stringify(validate.errors));
});

test('source values and original-record hashes stay exact strings with closed field sets', () => {
  const doc = fixture(); const row = doc.changes[0].current.issuer[0];
  assert.equal(row.distribution_amount, '4.32109'); assert.equal(doc.changes[0].current.dividends[0].unadjusted_value, '4.321');
  row.distribution_amount = 4.32109; assert.equal(validate(doc), false);
  const unknown = fixture(); unknown.changes[0].current.issuer[0].html = '<script>FICTIONAL</script>'; assert.equal(validate(unknown), false);
  const missing = fixture(); delete missing.changes[0].current.issuer[0].record_hash; assert.equal(validate(missing), false);
});

test('schema shape alone does not prove an economic value or authorize using a draft', () => {
  const doc = fixture(); doc.changes[0].current.issuer[0].distribution_amount = '5.12345';
  assert.equal(validate(doc), true); assert.equal(doc.confirmation_supported, false); assert.equal(doc.research_admitted, false);
});
