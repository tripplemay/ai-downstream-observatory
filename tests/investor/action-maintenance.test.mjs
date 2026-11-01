import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020').default, ajv = new Ajv({ strict: true, strictRequired: false });
require('ajv-formats').default(ajv);
for (const name of ['common', 'investor-action-maintenance'])
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../../contracts/v1/${name}.schema.json`, import.meta.url), 'utf8')));
const validate = fragment => ajv.getSchema(`https://etf-workbench.invalid/contracts/v1/investor-action-maintenance.schema.json#/$defs/${fragment}`);
let documents;
function fixture() {
  if (documents) return structuredClone(documents);
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c', `
import json,socket
from unittest.mock import patch
from tests.investor.test_managed_actions import ManagedActionTests,AT,LATER
from worker.investor import managed_actions as m
def forbidden(*a,**k):raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')
socket.create_connection=forbidden;socket.getaddrinfo=forbidden
case=ManagedActionTests();case.setUp()
try:
 case.prepare();case.grant();result=m.publish_current_actions(case.db,now=AT)
 assert result[0]['status']=='published'
 with patch.object(m,'_current_refs',return_value=(None,'SOURCE_CAPTURE_TERMINAL_FAILURE')):
  assert m.publish_current_actions(case.db,now=LATER)[0]['status']=='blocked'
 values={key:json.loads(case.db.execute('SELECT document_json FROM '+table+' ORDER BY rowid DESC LIMIT 1').fetchone()[0])
  for key,table in (('authority','investor_action_authorities'),('control','investor_action_controls'),('request','investor_action_requests'))}
 values['publications']=[json.loads(row[0]) for row in case.db.execute('SELECT document_json FROM investor_action_publications ORDER BY sequence')]
 print(json.dumps(values))
finally:case.doCleanups()
`], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr); documents = JSON.parse(child.stdout);
  return structuredClone(documents);
}

test('shared structural contract accepts fictional audited maintenance documents without claiming runtime verification', () => {
  const value = fixture();
  for (const key of ['authority', 'control', 'request']) assert.equal(validate(key)(value[key]), true, JSON.stringify(validate(key).errors));
  for (const publication of value.publications) assert.equal(validate('publication')(publication), true, JSON.stringify(validate('publication').errors));
  assert.equal(value.publications[0].human_review_performed, false); assert.equal(value.publications[1].status, 'blocked');
  for (const forbidden of ['987.1234', '98.71234', 'tax_assumption', 'gross_per_unit', '"events"'])
    assert.equal(JSON.stringify(value).includes(forbidden), false);
});

test('maintenance policy cannot add provider calls, unknown targets, tolerance, tax, AI or trade grants', () => {
  const value = fixture().authority, accepts = validate('authority');
  for (const change of [{ additional_source_requests: 1 }, { provider_symbol: 'OTHER.US' }, { tolerance: '0.001' },
    { tax_changes_permitted: true }, { trading_permission: true }, { raw_ai_sharing: true }, { standing_rule_authorized: false },
    { registered_nominal_differences_accepted: false }, { coverage_basis: 'objective_absence_verified' }, { timezone: 'UTC' },
    { run_after_hour: 0 }, { app_secret: 'fictional' }, { events: [] }]) assert.equal(accepts({ ...value, ...change }), false);
  const changed = structuredClone(value); changed.anchor_captures.issuer.endpoint = 'https://fictional.invalid';
  assert.equal(accepts(changed), false);
});

test('publication dispositions stay closed and cannot turn a blocked or derived record into human review', () => {
  const { control, publications } = fixture(), accepts = validate('publication'), value = publications[0];
  for (const change of [{ human_review_performed: true }, { trading_permission: true }, { additional_source_requests: 1 },
    { corporate_actions_complete: true }, { facts: {} }, { capture_refs: null }, { source_id: null }, { review_hash: null },
    { failure_code: 'NEW_REPORTED_ACTION' }, { status: 'blocked' }, { sequence: 0 }])
    assert.equal(accepts({ ...value, ...change }), false);
  assert.equal(accepts({ ...publications[1], source_id: value.source_id }), false);
  for (const change of [{ enabled: 1 }, { version: 0 }, { version: 1001 }, { version: 1.5 }, { force: true }])
    assert.equal(validate('control')({ ...control, ...change }), false);
});
