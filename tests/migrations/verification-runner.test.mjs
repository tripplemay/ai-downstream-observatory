import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const Database = createRequire(join(root, 'web/package.json'))('better-sqlite3');
const T = '2026-01-05T09:00:00.000000Z', START = '2026-01-05T09:00:01.000000Z';
const END = '2026-01-05T09:00:02.000000Z', STORED = '2026-01-05T09:00:02.000001Z', FINISHED = '2026-01-05T09:00:02.000002Z';
const CHECK = 'E-02.cash-contribution-neutrality.v1', TYPE = 'governance_verification_v2';
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) && !Buffer.isBuffer(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const insert = (db, table, value, prefix = 'INSERT') => db.prepare(`${prefix} INTO ${table}(${Object.keys(value).join(',')}) VALUES(${Object.keys(value).map(() => '?')})`).run(...Object.values(value));

function fixture(t, version = 21) {
  const directory = mkdtempSync(join(tmpdir(), 'verification-runner-migration-')), path = join(directory, 'workbench.db');
  let migrations = migrationDirectory;
  if (version !== 21) {
    migrations = join(directory, `v${version}`); mkdirSync(migrations);
    const original = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), rows = original.migrations.slice(0, version);
    for (const row of rows) cpSync(join(migrationDirectory, row.file), join(migrations, row.file));
    writeFileSync(join(migrations, 'manifest.json'), JSON.stringify({ ...original, migrations: rows }));
  }
  migrateWorkbench(path, { directory: migrations });
  const db = new Database(path); db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=OFF');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const id of ['p', 'other']) insert(db, 'portfolios', { id, name: 'Synthetic DDL fixture only - no acceptance claim', created_at: T });
  return { db, path, directory };
}
function snapshot(db, names) {
  names ??= db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  return names.map(name => {
    const columns = db.pragma(`table_info(${name})`).map(row => row.name);
    const bytes = columns.map((column, n) => `typeof("${column}") AS t${n},hex(CAST("${column}" AS BLOB)) AS b${n}`).join(',');
    return { name, columns, rows: db.prepare(`SELECT ${bytes} FROM "${name}" ORDER BY rowid`).all() };
  });
}
function requestMaterial(id = 'request', portfolio = 'p') {
  const source_manifest = { schema_version: 'verification-source-v2', files: { 'SYNTHETIC-DDL-FIXTURE-NOT-EXECUTION': sha('synthetic source') } };
  const context = { schema_version: 'verification-context-v2', portfolio_id: portfolio, check_id: CHECK, suite_version: 'cash-contribution-neutrality-v1', source_manifest, source_manifest_hash: sha(canonical(source_manifest)) };
  const request = { id, portfolio_id: portfolio, check_id: CHECK, context_json: canonical(context), context_hash: sha(canonical(context)), requested_by: 'synthetic-human', audit_id: `${id}:audit`, requested_at: T };
  const body = { schema_version: 'verification-request-v2', verification_request_id: id, portfolio_id: portfolio, check_id: CHECK, context_hash: request.context_hash };
  const command = { id, portfolio_id: portfolio, command_type: TYPE, idempotency_key: id, payload_hash: sha(canonical(body)), payload_json: canonical(body), actor_id: 'system:governance-verifier-v2', created_at: T };
  const auditBody = { actor_kind: 'human', input: { portfolio_id: portfolio, check_id: CHECK, expected_context_hash: request.context_hash, reason: 'Synthetic SQL constraint test only', idempotency_key: id },
    result: { request_id: id, check_id: CHECK, context_hash: request.context_hash, status: 'queued' } };
  const audit = { id: request.audit_id, portfolio_id: portfolio, actor_id: request.requested_by, action: 'request_verification', object_type: 'verification_request', object_id: id,
    ledger_revision: null, payload_json: canonical(auditBody), created_at: T };
  return { request, command, audit, context, body, auditBody };
}
function storeRequest(db, material = requestMaterial()) {
  db.transaction(() => { insert(db, 'command_requests', material.command); insert(db, 'audit_events', material.audit); insert(db, 'verification_requests', material.request); }).immediate();
  return material;
}
const runtime = `
import json, sys
from dataclasses import asdict
from unittest.mock import patch
from worker.orchestration.db import open_database
from worker.orchestration.jobs import enqueue_job, claim_job, complete_job, fail_job, heartbeat, Lease
db=open_database(sys.argv[1]); action=sys.argv[2]; data=json.loads(sys.argv[3])
if action=='claim':
 r=db.execute('SELECT r.*,c.payload_hash FROM verification_requests r JOIN command_requests c ON c.id=r.id WHERE r.id=?',(data['request'],)).fetchone()
 job=enqueue_job(db,'governance_verification_v2',r['portfolio_id'],r['requested_at'][:10],r['id']+':'+r['payload_hash'],command_request_id=r['id'],now=data['now'])
 lease=claim_job(db,'synthetic-ddl-test',job_type='governance_verification_v2',now=data['now'])
 print(json.dumps({'job':job,'lease':asdict(lease) if lease else None}))
elif action=='finish':
 lease=Lease(**data['lease'])
 def effect(connection):
  for table,row in data.get('rows',[]):
   if 'body_hex' in row: row['body']=bytes.fromhex(row.pop('body_hex'))
   connection.execute('INSERT INTO '+table+'('+','.join(row)+') VALUES('+','.join('?' for _ in row)+')',tuple(row.values()))
 # This migration test isolates SQL with deliberately non-authoritative artifact bytes.
 # The real semantic verifier is exercised separately by the normal runner tests.
 with patch('worker.governance_verification.runner.assert_finalization', return_value=None):
  complete_job(db,lease,data['result'],outcome=data['outcome'],effect=effect,now=data['now'],clock=lambda:data['finished'])
 print(json.dumps(dict(db.execute('SELECT * FROM job_runs WHERE id=?',(lease.job_id,)).fetchone())))
elif action=='fail':
 print(json.dumps({'status':fail_job(db,Lease(**data['lease']),{'code':'SYNTHETIC_INFRASTRUCTURE_FAILURE'},retryable=data['retry'],retry_delay_seconds=0,now=data['now'])}))
elif action=='heartbeat':
 print(json.dumps(asdict(heartbeat(db,Lease(**data['lease']),now=data['now']))))
elif action=='ordinary':
 job=enqueue_job(db,'synthetic_ordinary_job','p','synthetic-period','synthetic-input',now=data['now'])
 lease=claim_job(db,'synthetic-ordinary-worker',job_type='synthetic_ordinary_job',now=data['now'])
 complete_job(db,lease,{'synthetic':True},now=data['now'])
 print(json.dumps(dict(db.execute('SELECT * FROM job_runs WHERE id=?',(job['id'],)).fetchone())))
db.close()
`;
function python(f, action, data, success = true) {
  const process = spawnSync(globalThis.process.env.WORKBENCH_TEST_PYTHON ?? globalThis.process.env.WORKBENCH_PYTHON ?? 'python3', ['-c', runtime, f.path, action, JSON.stringify(data)],
    { cwd: root, encoding: 'utf8', timeout: 15000 });
  if (success) { assert.equal(process.status, 0, process.stderr || process.error?.message); return JSON.parse(process.stdout); }
  assert.notEqual(process.status, 0); return process.stderr;
}
function ready(t) {
  const f = fixture(t), material = storeRequest(f.db), { lease } = python(f, 'claim', { request: material.request.id, now: START });
  assert.ok(lease); return { ...f, material, lease };
}
function domain(f, status = 'pass') {
  const attempt = f.db.prepare('SELECT * FROM job_attempts WHERE job_id=? AND attempt=?').get(f.lease.job_id, f.lease.attempt);
  const result = { schema_version: 'verification-check-result-v2', check_id: CHECK, status,
    issues: status === 'pass' ? [] : ['SYNTHETIC_CONSTRAINT_CASE'], assertions: [{ id: 'synthetic-ddl-only', status: status === 'fail' ? 'fail' : 'pass' }], gate_eligible: false, completed_requirements: [] };
  const body = Buffer.from('{"synthetic":"DDL fixture, not execution evidence"}\n');
  const artifact = { id: 'artifact', request_id: f.material.request.id, job_id: f.lease.job_id, attempt: f.lease.attempt, fencing_token: f.lease.fencing_token,
    kind: 'execution', body, body_sha256: sha(body), created_at: STORED };
  const execution = { id: 'execution', request_id: artifact.request_id, job_id: artifact.job_id, attempt_id: attempt.id, attempt: artifact.attempt,
    fencing_token: artifact.fencing_token, context_hash: f.material.request.context_hash, artifact_id: artifact.id, artifact_sha256: artifact.body_sha256,
    result_json: canonical(result), result_hash: sha(canonical(result)), status, execution_authority: 'controlled_runner', data_provenance: 'synthetic',
    acceptance_scope: 'engineering_subcheck', started_at: START, finished_at: END, recorded_at: STORED };
  const jobResult = { schema_version: 'verification-job-result-v2', request_id: execution.request_id, execution_id: execution.id,
    context_hash: execution.context_hash, result_hash: execution.result_hash, status };
  return { artifact, execution, result, jobResult, outcome: { pass: 'succeeded', fail: 'failed', blocked: 'skipped' }[status] };
}
function finish(f, value = domain(f), changes = {}, success = true) {
  const { body, ...artifact } = value.artifact;
  return python(f, 'finish', { lease: f.lease, result: value.jobResult, outcome: value.outcome, now: STORED, finished: FINISHED,
    rows: [['verification_artifacts', { ...artifact, body_hex: body.toString('hex') }], ['verification_executions', value.execution]], ...changes }, success);
}
function insertDomain(db, value, prefix = 'INSERT') {
  insert(db, 'verification_artifacts', value.artifact, prefix); insert(db, 'verification_executions', value.execution, prefix);
}
function finalizeSql(db, f, value) {
  db.prepare('UPDATE job_attempts SET status=?,finished_at=? WHERE id=?').run(value.outcome, FINISHED, value.execution.attempt_id);
  db.prepare('UPDATE job_runs SET status=?,result_json=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?').run(value.outcome, canonical(value.jobResult), FINISHED, f.lease.job_id);
}

test('v20 to v21 preserves old data and schema bytes, adds no fake execution, and repeat migration is a no-op', t => {
  const f = fixture(t, 20), before = snapshot(f.db).filter(row => row.name !== 'schema_migrations');
  const schema = f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.equal(migrateWorkbench(f.path).applied, 1); assert.deepEqual(snapshot(f.db, before.map(row => row.name)), before);
  for (const row of schema) assert.deepEqual(f.db.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(row.name), row);
  for (const table of ['verification_requests', 'verification_artifacts', 'verification_executions', 'governance_verification_runs', 'ledger_events', 'activations'])
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  const state = snapshot(f.db); f.db.pragma('wal_checkpoint(TRUNCATE)'); const bytes = sha(readFileSync(f.path));
  assert.equal(migrateWorkbench(f.path).applied, 0); assert.equal(sha(readFileSync(f.path)), bytes); assert.deepEqual(snapshot(f.db), state);
  assert.equal(verifyWorkbenchSchema(f.db).version, 21); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('requests require exact human audit, scoped internal command and fixed context without claimed acceptance', t => {
  const { db } = fixture(t), before = snapshot(db);
  for (const change of [m => { m.request.requested_by = 'system:forged'; }, m => { m.request.requested_by = 'SYSTEM:forged'; }, m => { m.request.requested_by = 'system'; },
    m => { m.command.actor_id = 'human'; }, m => { m.command.portfolio_id = 'other'; }, m => { m.command.idempotency_key = 'other'; },
    m => { m.command.payload_json = canonical({ ...m.body, context_hash: sha('other') }); }, m => { m.command.payload_json = canonical({ ...m.body, pass: true }); },
    m => { m.audit.action = 'other'; }, m => { m.audit.actor_id = 'other'; }, m => { m.audit.object_id = 'other'; }, m => { m.audit.ledger_revision = 0; },
    m => { m.audit.payload_json = canonical({ ...m.auditBody, actor_kind: 'system' }); },
    m => { m.audit.payload_json = canonical({ ...m.auditBody, input: { ...m.auditBody.input, expected_context_hash: sha('other') } }); },
    m => { m.audit.payload_json = canonical({ ...m.auditBody, input: { ...m.auditBody.input, reason: 'x'.repeat(1001) } }); },
    m => { m.command.idempotency_key = 'invalid/key'; m.audit.payload_json = canonical({ ...m.auditBody, input: { ...m.auditBody.input, idempotency_key: 'invalid/key' } }); },
    m => { m.audit.payload_json = canonical({ ...m.auditBody, result: { ...m.auditBody.result, status: 'pass' } }); },
    m => { m.request.context_json = canonical({ ...m.context, portfolio_id: 'other' }); }, m => { m.request.context_json = canonical({ ...m.context, gate_eligible: true }); },
    m => { m.request.context_json = canonical({ ...m.context, suite_version: 'other' }); },
    m => { m.request.context_json = m.request.context_json.replace('"schema_version":"verification-context-v2"', '"schema_version":"verification-context-v2","schema_version":"verification-context-v2"'); }]) {
    const material = requestMaterial(); change(material); assert.throws(() => storeRequest(db, material)); assert.deepEqual(snapshot(db), before);
  }
  const material = storeRequest(db); assert.deepEqual(db.prepare('SELECT * FROM verification_requests').get(), material.request);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_runs').get().n, 0);
});

test('real enqueue and claim produce fixed scoped initial job; heartbeat and failed retry preserve runtime protocol', t => {
  const f = ready(t), original = f.db.prepare('SELECT * FROM job_runs WHERE id=?').get(f.lease.job_id);
  assert.equal(original.period, T.slice(0, 10)); assert.equal(original.input_version, `request:${f.material.command.payload_hash}`); assert.equal(original.max_attempts, 3);
  python(f, 'heartbeat', { lease: f.lease, now: END });
  assert.equal(python(f, 'fail', { lease: f.lease, retry: true, now: STORED }).status, 'retry_queued');
  const next = python(f, 'claim', { request: 'request', now: FINISHED });
  assert.equal(next.lease.job_id, f.lease.job_id); assert.equal(next.lease.attempt, 2); assert.equal(next.lease.fencing_token, 2);
  assert.equal(python(f, 'fail', { lease: next.lease, retry: false, now: '2026-01-05T09:00:03.000000Z' }).status, 'failed');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM verification_executions').get().n, 0);
});

test('v2 jobs cannot be seeded successful or change the fixed request, scope, period, input identity or attempt budget', t => {
  const f = fixture(t), material = storeRequest(f.db), before = snapshot(f.db);
  const job = { id: 'synthetic-job', command_request_id: 'request', job_type: TYPE, scope: 'p', period: T.slice(0, 10),
    input_version: `request:${material.command.payload_hash}`, status: 'queued', max_attempts: 3, not_before: START, created_at: START, updated_at: START };
  for (const patch of [{ status: 'succeeded' }, { status: 'running' }, { job_type: 'ordinary' }, { scope: 'other' }, { period: 'other' },
    { input_version: 'arbitrary' }, { command_request_id: 'missing' }, { max_attempts: 4 }, { attempt_count: 1 }, { fencing_token: 1 }, { result_json: '{}' }]) {
    assert.throws(() => insert(f.db, 'job_runs', { ...job, ...patch }, 'INSERT OR IGNORE'), /queued scoped request/); assert.deepEqual(snapshot(f.db), before);
  }
});

test('actual lease expiry retries and exhaustion remain honest infrastructure failures with no execution record', t => {
  const f = ready(t);
  const second = python(f, 'claim', { request: 'request', now: '2026-01-05T09:01:02.000000Z' });
  assert.equal(second.lease.attempt, 2); assert.equal(second.lease.fencing_token, 3);
  const third = python(f, 'claim', { request: 'request', now: '2026-01-05T09:02:03.000000Z' });
  assert.equal(third.lease.attempt, 3); assert.equal(third.lease.fencing_token, 5);
  const exhausted = python(f, 'claim', { request: 'request', now: '2026-01-05T09:03:04.000000Z' });
  assert.equal(exhausted.lease, null); assert.equal(f.db.prepare('SELECT status FROM job_runs').get().status, 'failed');
  assert.deepEqual(f.db.prepare('SELECT status FROM job_attempts ORDER BY attempt').all(), Array.from({ length: 3 }, () => ({ status: 'lease_expired' })));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM verification_executions').get().n, 0);
});

test('ordinary real jobs retain their pre-v21 enqueue, claim and completion behavior', t => {
  const f = fixture(t), job = python(f, 'ordinary', { now: START });
  assert.equal(job.status, 'succeeded'); assert.deepEqual(JSON.parse(job.result_json), { synthetic: true });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM verification_requests').get().n, 0);
});

for (const status of ['pass', 'fail', 'blocked']) test(`SQL-only completion isolates semantic verification and atomically binds ${status} execution, BLOB and current terminal attempt`, t => {
  const f = ready(t), value = domain(f, status), job = finish(f, value);
  assert.equal(job.status, value.outcome); assert.deepEqual(JSON.parse(job.result_json), value.jobResult);
  assert.deepEqual(f.db.prepare('SELECT * FROM verification_executions').get(), value.execution);
  assert.deepEqual(f.db.prepare('SELECT * FROM verification_artifacts').get(), value.artifact);
  const attempt = f.db.prepare('SELECT * FROM job_attempts WHERE id=?').get(value.execution.attempt_id);
  assert.equal(attempt.status, value.outcome); assert.equal(attempt.finished_at, FINISHED); assert.ok(value.execution.finished_at < attempt.finished_at);
  assert.equal(JSON.parse(value.execution.result_json).gate_eligible, false); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM governance_verification_runs').get().n, 0);
});

test('success or skipped completion without execution fails and rolls back attempt state; honest infrastructure failure is separate', t => {
  const f = ready(t), before = snapshot(f.db);
  for (const outcome of ['succeeded', 'skipped']) {
    python(f, 'finish', { lease: f.lease, rows: [], outcome, result: {}, now: STORED, finished: FINISHED }, false);
    assert.deepEqual(snapshot(f.db), before);
  }
  for (const result of [{ status: 'pass' }, { schema_version: 'verification-job-result-v2' }, { execution_id: 'missing' }]) {
    python(f, 'finish', { lease: f.lease, rows: [], outcome: 'failed', result, now: STORED, finished: FINISHED }, false);
    assert.deepEqual(snapshot(f.db), before);
  }
  assert.equal(python(f, 'fail', { lease: f.lease, retry: false, now: FINISHED }).status, 'failed');
});

test('artifact requires BLOB bounds, exact UTC microseconds and matching scoped live attempt/fence', t => {
  const f = ready(t), value = domain(f), before = snapshot(f.db); storeRequest(f.db, requestMaterial('foreign', 'other'));
  const stable = snapshot(f.db);
  for (const patch of [{ request_id: 'foreign' }, { job_id: 'missing' }, { attempt: 0 }, { attempt: 2 }, { fencing_token: 2 }, { kind: 'pass' },
    { body: '' }, { body: Buffer.alloc(0) }, { body: Buffer.alloc(1048577) }, { body_sha256: 'A'.repeat(64) },
    { created_at: '2026-01-05T09:00:00.999999Z' }, { created_at: f.lease.lease_until }, { created_at: '2026-02-30T09:00:02.000000Z' }, { created_at: '2026-01-05T09:00:02.000Z' }]) {
    assert.throws(() => insert(f.db, 'verification_artifacts', { ...value.artifact, ...patch })); assert.deepEqual(snapshot(f.db), stable);
  }
  assert.notDeepEqual(stable, before);
});

test('execution rejects wrong scope/fence/context/artifact/time and false authority, including claimed completed E requirements', t => {
  const f = ready(t), value = domain(f); insert(f.db, 'verification_artifacts', value.artifact); const before = snapshot(f.db);
  for (const patch of [{ request_id: 'other' }, { job_id: 'missing' }, { attempt_id: 'missing' }, { attempt: 2 }, { fencing_token: 2 }, { context_hash: sha('other') },
    { artifact_id: 'missing' }, { artifact_sha256: sha('other') }, { execution_authority: 'human' }, { data_provenance: 'authoritative' }, { acceptance_scope: 'gate' },
    { started_at: T }, { finished_at: '2026-01-05T09:00:03.000000Z' }, { recorded_at: END }, { recorded_at: f.lease.lease_until }]) {
    assert.throws(() => insert(f.db, 'verification_executions', { ...value.execution, ...patch })); assert.deepEqual(snapshot(f.db), before);
  }
  for (const result of [{ ...value.result, gate_eligible: true }, { ...value.result, completed_requirements: ['E-02'] }, { ...value.result, status: 'fail' },
    { ...value.result, check_id: 'E-02' }, { ...value.result, extra: true }, { ...value.result, assertions: [] },
    { ...value.result, assertions: [{ id: 'one', status: null }] }, { ...value.result, assertions: [{ id: 'one', status: 'pass', note: 'extra' }] },
    { ...value.result, assertions: [{ id: 'one', status: 'pass' }, { id: 'one', status: 'pass' }] }, { ...value.result, issues: ['has issue'] }]) {
    assert.throws(() => insert(f.db, 'verification_executions', { ...value.execution, result_json: canonical(result) })); assert.deepEqual(snapshot(f.db), before);
  }
});

test('wrong terminal receipt or status rolls domain and attempt writes back; finishing after lease expiry also cannot commit', t => {
  const f = ready(t), value = domain(f), before = snapshot(f.db);
  for (const change of [{ result: { ...value.jobResult, result_hash: sha('other') } }, { result: { ...value.jobResult, context_hash: sha('other') } },
    { result: { ...value.jobResult, execution_id: 'other' } }, { result: { ...value.jobResult, extra: true } }, { outcome: 'failed' }, { finished: f.lease.lease_until }]) {
    finish(f, value, change, false); assert.deepEqual(snapshot(f.db), before);
  }
  assert.equal(finish(f).status, 'succeeded');
});

test('outer INSERT OR IGNORE cannot lose the required artifact and still commit an execution or successful job', t => {
  const f = ready(t), value = domain(f), before = snapshot(f.db);
  assert.throws(() => f.db.transaction(() => {
    insert(f.db, 'verification_artifacts', { ...value.artifact, body: Buffer.alloc(0) }, 'INSERT OR IGNORE');
    insert(f.db, 'verification_executions', value.execution, 'INSERT OR IGNORE'); finalizeSql(f.db, f, value);
  }).immediate());
  assert.deepEqual(snapshot(f.db), before);
});

test('append-only tables and every unique replacement alias survive recursive_triggers OFF', t => {
  const f = ready(t), value = domain(f); finish(f, value); const before = snapshot(f.db);
  for (const table of ['verification_requests', 'verification_artifacts', 'verification_executions']) {
    assert.throws(() => f.db.exec(`UPDATE ${table} SET id='changed'`), /append-only/);
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /append-only/); assert.deepEqual(snapshot(f.db), before);
  }
  for (const patch of [{}, { id: 'alias' }]) assert.throws(() => insert(f.db, 'verification_requests', { ...f.material.request, ...patch }, 'INSERT OR REPLACE'), /cannot be replaced/);
  for (const patch of [{}, { id: 'alias' }]) assert.throws(() => insert(f.db, 'verification_artifacts', { ...value.artifact, ...patch }, 'INSERT OR REPLACE'), /cannot be replaced/);
  for (const patch of [{}, { id: 'alias' }, { id: 'alias', job_id: 'other' }, { id: 'alias', job_id: 'other', attempt_id: 'other' }])
    assert.throws(() => insert(f.db, 'verification_executions', { ...value.execution, ...patch }, 'INSERT OR REPLACE'), /cannot be replaced/);
  assert.deepEqual(snapshot(f.db), before);
});

test('request command and human audit anchors cannot mutate or be replaced with recursive_triggers OFF', t => {
  const f = ready(t), before = snapshot(f.db);
  for (const sql of ["UPDATE command_requests SET payload_hash='forged'", "UPDATE command_requests SET command_type='ordinary'", 'DELETE FROM command_requests'])
    assert.throws(() => f.db.exec(sql), /append-only/);
  for (const patch of [{}, { id: 'alias' }, { command_type: 'ordinary', idempotency_key: 'other' }])
    assert.throws(() => insert(f.db, 'command_requests', { ...f.material.command, ...patch }, 'INSERT OR REPLACE'), /cannot be replaced/);
  assert.throws(() => insert(f.db, 'audit_events', { ...f.material.audit, payload_json: '{}' }, 'INSERT OR REPLACE'), /cannot be replaced/);
  assert.deepEqual(snapshot(f.db), before);
});

test('an inserted execution cannot be converted to an infrastructure failure or returned to a live queue', t => {
  const f = ready(t), value = domain(f); insertDomain(f.db, value); const before = snapshot(f.db);
  for (const status of ['failed', 'partial', 'lease_expired', 'cancelled'])
    assert.throws(() => f.db.prepare('UPDATE job_attempts SET status=?,finished_at=? WHERE id=?').run(status, FINISHED, value.execution.attempt_id), /matching execution/);
  for (const status of ['queued', 'retry_queued', 'running'])
    assert.throws(() => f.db.prepare('UPDATE job_runs SET status=? WHERE id=?').run(status, f.lease.job_id), /terminal job finalization/);
  assert.deepEqual(snapshot(f.db), before); finalizeSql(f.db, f, value);
  assert.equal(f.db.prepare('SELECT status FROM job_runs').get().status, 'succeeded');
});

test('job and attempt cannot escape terminal immutability through changed type, identity or replacement into ordinary jobs', t => {
  const f = ready(t), value = domain(f); finish(f, value);
  const job = f.db.prepare('SELECT * FROM job_runs WHERE id=?').get(f.lease.job_id), attempt = f.db.prepare('SELECT * FROM job_attempts WHERE id=?').get(value.execution.attempt_id);
  const before = snapshot(f.db);
  for (const sql of ["UPDATE job_runs SET job_type='ordinary'", "UPDATE job_runs SET status='queued'", "UPDATE job_runs SET result_json='{}'",
    "UPDATE job_attempts SET status='running'", 'DELETE FROM job_attempts', 'DELETE FROM job_runs']) assert.throws(() => f.db.exec(sql));
  assert.throws(() => insert(f.db, 'job_runs', { ...job, job_type: 'ordinary', command_request_id: null }, 'INSERT OR REPLACE'), /cannot be replaced/);
  assert.throws(() => insert(f.db, 'job_runs', { ...job, id: 'alias' }, 'INSERT OR REPLACE'), /cannot be replaced/);
  assert.throws(() => insert(f.db, 'job_attempts', { ...attempt, id: 'alias' }, 'INSERT OR REPLACE'), /cannot be replaced/);
  assert.deepEqual(snapshot(f.db), before);
});

test('two live SQLite connections cannot replace an uncommitted completion, then observe one immutable result', t => {
  const f = ready(t), value = domain(f), peer = new Database(f.path); peer.pragma('foreign_keys=ON'); peer.pragma('busy_timeout=5'); t.after(() => peer.close());
  f.db.exec('BEGIN IMMEDIATE'); insertDomain(f.db, value);
  assert.throws(() => insert(peer, 'verification_artifacts', value.artifact), error => error.code === 'SQLITE_BUSY');
  assert.equal(peer.prepare('SELECT COUNT(*) n FROM verification_executions').get().n, 0);
  finalizeSql(f.db, f, value); f.db.exec('COMMIT');
  assert.equal(peer.prepare('SELECT COUNT(*) n FROM verification_executions').get().n, 1);
  assert.throws(() => insert(peer, 'verification_executions', value.execution, 'INSERT OR REPLACE'), /cannot be replaced/);
  assert.equal(peer.prepare('SELECT status FROM job_runs WHERE id=?').get(f.lease.job_id).status, 'succeeded');
});
