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
for (const name of ['common.schema.json', 'investor-action-successor.schema.json']) {
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(root, 'contracts/v1', name), 'utf8')));
}
const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-action-successor.schema.json#/$defs/append_proof');
const validatePreview = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-action-successor.schema.json#/$defs/preview');
const values = new Map();
function fixture(kind = 'append') {
  if (!values.has(kind)) {
    const module = kind === 'append' ? 'tests.investor.test_reviewed_action_append' : 'tests.investor.test_reviewed_action_successor';
    const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-m', module, '--contract'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); values.set(kind, JSON.parse(result.stdout));
  }
  return structuredClone(values.get(kind));
}

test('reviewed-action preparation contract independently accepts only the non-admitted Python proof', () => {
  const doc = fixture(); assert.equal(validate(doc), true, JSON.stringify(validate.errors));
  assert.equal(doc.research_admitted, false); assert.equal(doc.handover_registered, false);
});

test('a prepared action proof cannot be promoted by flipping owner, source, admission or trading booleans', () => {
  for (const key of ['owner_approval_verified','source_authority_verified','handover_registered','research_admitted','trading_permission']) {
    const doc = fixture(); doc[key] = true; assert.equal(validate(doc), false, key);
  }
});

test('the action proof contract rejects unknown source text and missing or negative append counts', () => {
  const text = fixture(); text.raw_source = 'FICTIONAL raw data must not enter this proof'; assert.equal(validate(text), false);
  const missing = fixture(); delete missing.added_event_count; assert.equal(validate(missing), false);
  const negative = fixture(); negative.new_nominal_difference_count = -1; assert.equal(validate(negative), false);
});

test('the actual fictional readonly resolver preview has a separate closed non-enabling contract', () => {
  const doc = fixture('preview'); assert.equal(validatePreview(doc), true, JSON.stringify(validatePreview.errors));
  assert.equal(doc.next_manual_review_record_verified, true); assert.equal(doc.approval_performed_by_preview, false);
});

test('existing manual review verification cannot be promoted into quarantine clearing or new rule activation', () => {
  for (const key of ['handover_registered','next_rule_enabled','quarantine_cleared','research_admitted','trading_permission']) {
    const doc = fixture('preview'); doc[key] = true; assert.equal(validatePreview(doc), false, key);
  }
  const doc = fixture('preview'); doc.unverified_raw_source = 'FICTIONAL'; assert.equal(validatePreview(doc), false);
});

test('late receipt knowledge cannot be relabelled as timing-ready normal continuation', () => {
  const proof=fixture(); assert.equal(proof.late_knowledge_event_count,1); assert.equal(proof.continuation_timing_ready,false);
  proof.continuation_timing_ready=true; assert.equal(validate(proof),false);
  const preview=fixture('preview'); preview.requires_separate_knowledge_or_start=false; assert.equal(validatePreview(preview),false);
});

test('self-consistent schema fields are not independent timing or source evidence', () => {
  const doc=fixture(); doc.late_knowledge_event_count=0; doc.continuation_timing_ready=true; doc.requires_separate_knowledge_or_start=false;
  assert.equal(validate(doc),true); assert.equal(doc.source_authority_verified,false); assert.equal(doc.research_admitted,false);
});
