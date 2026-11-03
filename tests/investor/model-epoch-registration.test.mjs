import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../../', import.meta.url), require = createRequire(new URL('../../web/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020'), ajv = new Ajv({ strict: true, strictRequired: false }); require('ajv-formats')(ajv);
for (const name of readdirSync(new URL('contracts/v1/', root)).filter(name => name.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(readFileSync(new URL('contracts/v1/' + name, root), 'utf8')));
const schema = 'https://etf-workbench.invalid/contracts/v1/investor-model-epoch-registration.schema.json';
let saved;
function fixture() {
  if (!saved) {
    const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? 'python3', ['-c', `
from pathlib import Path
from tempfile import TemporaryDirectory
import subprocess
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.epoch_registration_fixture import create
from worker.orchestration.db import open_database,canonical_json
with TemporaryDirectory(prefix='etf-epoch-registration-contract-') as directory,offline_protocol_fixture():
 path=Path(directory)/'workbench.db'
 run=subprocess.run(['node','scripts/migrate-workbench.mjs','--db',str(path)],capture_output=True,text=True,timeout=30)
 assert run.returncode==0,run.stderr
 db=open_database(path)
 try:print(canonical_json(create(db,path)))
 finally:db.close()
`], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 2097152, env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
    assert.ok(!child.error, child.error?.code); assert.equal(child.status, 0, child.stderr); saved = JSON.parse(child.stdout);
  }
  return structuredClone(saved);
}
test('real fictional source registration binds separate preview/owner request and first state, never source-maintenance consent alone', () => {
  const value = fixture();
  for (const kind of ['preview', 'request', 'registration']) {
    const validate = ajv.getSchema(schema + '#/$defs/' + kind);
    assert.equal(validate(value[kind]), true, JSON.stringify(validate.errors));
  }
  const validate = ajv.getSchema(schema + '#/$defs/submit');
  assert.equal(validate(value.request.body), true, JSON.stringify(validate.errors));
  for (const key of Object.keys(value.request.body.acknowledgements)) {
    const body = structuredClone(value.request.body); delete body.acknowledgements[key]; assert.equal(validate(body), false);
    body.acknowledgements[key] = false; assert.equal(validate(body), false);
  }
  assert.equal(value.checkpoint.schema_version, 'investor-evidence-model-checkpoint-v4');
});
test('first publication cannot claim resumed monitoring, rewrite history, trade, fetch providers or smuggle raw quotes into registry metadata', () => {
  const value = fixture().registration, validate = ajv.getSchema(schema + '#/$defs/registration');
  for (const change of [{ source_registered: false }, { first_state_published: false }, { monitoring_resumed: true }, { trading_permission: true },
    { historical_observations_rewritten: true }, { provider_calls: 1 }, { quotes: [] }, { quantities: {} }, { tax_assumption: 'inferred' }])
    assert.equal(validate({ ...value, ...change }), false);
  assert.doesNotMatch(JSON.stringify(value), /"(?:quotes|gross_per_unit|tax_per_unit|quantities|cash_by_currency|tax_assumption)":/);
});
