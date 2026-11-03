import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../../', import.meta.url), require = createRequire(new URL('../../web/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020'), ajv = new Ajv({ strict: true, strictRequired: false }); require('ajv-formats')(ajv);
for (const name of readdirSync(new URL('contracts/v1/', root)).filter(name => name.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(readFileSync(new URL('contracts/v1/' + name, root), 'utf8')));
const schema = 'https://etf-workbench.invalid/contracts/v1/investor-model-epoch-source.schema.json';
let saved;
function fixture() {
  if (!saved) {
    const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c', `
from pathlib import Path
from tempfile import TemporaryDirectory
import subprocess
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.epoch_source_fixture import create,NOW
from worker.investor.model_epoch_source import prepare_model_epoch_source
from worker.orchestration.db import open_database,canonical_json
with TemporaryDirectory(prefix='etf-epoch-source-contract-') as directory,offline_protocol_fixture():
 path=Path(directory)/'workbench.db'
 run=subprocess.run(['node','scripts/migrate-workbench.mjs','--db',str(path)],capture_output=True,text=True,timeout=30)
 assert run.returncode==0,run.stderr
 db=open_database(path)
 try:
  value=create(db,path);before=db.total_changes
  result=prepare_model_epoch_source(db,'w','owner',**value,now=NOW)
  assert db.total_changes==before
  print(canonical_json(result))
 finally:db.close()
`], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 2097152, env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
    assert.ok(!child.error, child.error?.code); assert.equal(child.status, 0, child.stderr); saved = JSON.parse(child.stdout);
  }
  return structuredClone(saved);
}
test('distinct closed v6 metadata and v4 projection require a qualified source derivation, not ordinary input relabelling', () => {
  const value = fixture();
  for (const [kind, field] of [['definition', 'epoch_definition'], ['input', 'input'], ['projection', 'projection'], ['proof', 'proof']]) {
    const validate = ajv.getSchema(schema + '#/$defs/' + kind);
    assert.equal(validate(value[field]), true, JSON.stringify(validate.errors));
  }
  assert.equal(value.input.schema_version, 'investor-monitor-data-input-v6');
  assert.equal(value.proof.source_evidence_verified, true); assert.equal(value.proof.epoch_registered, false);
  const old = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-monitor-data-input-v4.schema.json');
  assert.equal(old(value.input), false);
});
test('prepared source proof cannot register epochs, resume monitoring, add writes/calls or leak raw prices/amounts', () => {
  const { proof } = fixture(), validate = ajv.getSchema(schema + '#/$defs/proof');
  for (const change of [{ epoch_registered: true }, { current_source_eligibility_restored: true }, { checkpoint_created: true }, { monitoring_resumed: true },
    { trading_permission: true }, { provider_calls: 1 }, { database_writes: 1 }, { facts: {} }, { quotes: [] }, { tax_assumption: 'invented' }])
    assert.equal(validate({ ...proof, ...change }), false);
  assert.doesNotMatch(JSON.stringify(proof), /"(?:quotes|gross_per_unit|tax_per_unit|quantities|cash_by_currency|tax_assumption)":/);
});
test('continuation proof is a separate closed structural contract, not registration, admission or resumed monitoring', () => {
  const ref = { id: 'fictional-only-reference', content_hash: 'a'.repeat(64) };
  const proof = { schema_version: 'investor-model-epoch-continuation-source-proof-v1', workspace_id: 'fictional-workspace', actor_id: 'fictional-owner', model_id: 'fictional-model',
    epoch: ref, registration_hash: 'b'.repeat(64), previous_input: ref, previous_checkpoint: ref, model_control: ref,
    input_hash: 'c'.repeat(64), projection_hash: 'd'.repeat(64), checked_at: '2026-10-21T10:00:03.000Z', valid_until: '2026-10-21T20:00:00.000Z',
    status: 'qualified_continuation_prepared_not_admitted', epoch_registration_verified: true, previous_state_verified: true, source_evidence_verified: true,
    continuation_admitted: false, current_source_eligibility_restored: false, checkpoint_created: false, monitoring_resumed: false, trading_permission: false,
    provider_calls: 0, database_writes: 0, distribution: 'private_owner_only_not_ai' };
  const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-model-epoch-continuation-source.schema.json#/$defs/proof');
  assert.equal(validate(proof), true, JSON.stringify(validate.errors));
  for (const change of [{ continuation_admitted: true }, { monitoring_resumed: true }, { current_source_eligibility_restored: true }, { checkpoint_created: true },
    { trading_permission: true }, { provider_calls: 1 }, { database_writes: 1 }, { quantities: {} }, { quotes: [] }, { epoch_registration_verified: false }])
    assert.equal(validate({ ...proof, ...change }), false);
});
