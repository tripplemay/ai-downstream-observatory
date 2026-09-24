import assert from 'node:assert/strict';
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
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const hash = value => sha(canonical(value));
const insert = (db, table, row, mode = 'INSERT') => db.prepare(`${mode} INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?')})`).run(...Object.values(row));
const stamp = '2026-09-25T00:00:00.000Z';
function copyMigrations(directory, version) {
  const target = join(directory, `v${version}`); mkdirSync(target);
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  const migrations = manifest.migrations.slice(0, version);
  for (const row of migrations) cpSync(join(migrationDirectory, row.file), join(target, row.file));
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations }));
  return target;
}
function snapshot(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'csv-background-ddl-')), filename = join(directory, 'workbench.db');
  migrateWorkbench(filename);
  const db = new Database(filename); db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=OFF');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  insert(db, 'portfolios', { id: 'synthetic', name: 'Synthetic DDL only', created_at: stamp });
  insert(db, 'ledger_heads', { portfolio_id: 'synthetic', revision: 0, updated_at: stamp });
  insert(db, 'accounts', { id: 'account', portfolio_id: 'synthetic', name: 'A', broker: 'Synthetic', base_currency: 'CNY', status: 'reconciliation_required', created_at: stamp });
  const input = { filename: 'synthetic.csv', mapping: '{}', csv_sha256: sha(Buffer.from('date,amount\n')) };
  const row = { id: 'request', portfolio_id: 'synthetic', account_id: 'account', actor_id: 'owner', session_hash: 'a'.repeat(64),
    operation: 'preview', idempotency_key: 'key', expected_revision: 0, input_json: canonical(input),
    input_hash: hash({ operation: 'preview', portfolio_id: 'synthetic', account_id: 'account', expected_revision: 0, input }),
    csv_bytes: Buffer.from('date,amount\n'), confirmation_attempt_id: null, batch_id: null,
    command_request_id: 'request', approval_audit_id: 'approval', created_at: stamp, expires_at: '2026-09-25T00:15:00.000Z' };
  const payload = { schema_version: 'csv-background-command-v1', request_id: row.id, input_hash: row.input_hash };
  const command = { id: row.id, portfolio_id: row.portfolio_id, command_type: 'csv_import_preview_v1', idempotency_key: row.id,
    payload_hash: hash(payload), payload_json: canonical(payload), actor_id: 'system:csv-background', created_at: stamp };
  const audit = { id: 'approval', actor_id: 'owner', action: 'request_csv_background', object_type: 'csv_background_request', object_id: 'request',
    portfolio_id: 'synthetic', ledger_revision: 0, created_at: stamp,
    payload_json: canonical({ actor_kind: 'human', input: { portfolio_id: row.portfolio_id, account_id: row.account_id, operation: row.operation,
      idempotency_key: row.idempotency_key, expected_revision: 0, input_hash: row.input_hash, session_hash: row.session_hash,
      acknowledge_background_execution: true }, result: { request_id: 'request', operation: 'preview', input_hash: row.input_hash, status: 'queued' } }) };
  insert(db, 'command_requests', command); insert(db, 'audit_events', audit);
  const job = { id: 'job', command_request_id: row.id, job_type: command.command_type, scope: 'synthetic', period: '2026-09-25',
    input_version: `${row.id}:${command.payload_hash}`, status: 'queued', lease_owner: null, lease_until: null,
    fencing_token: 0, heartbeat_at: null, attempt_count: 0, max_attempts: 3, not_before: stamp, result_json: null, created_at: stamp, updated_at: stamp };
  return { db, row, command, audit, job };
}

test('v23 appends without changing the v22 schema or data; empty tables and byte-idempotent repeat', t => {
  const directory = mkdtempSync(join(tmpdir(), 'csv-background-upgrade-')), filename = join(directory, 'workbench.db');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  assert.equal(sha(JSON.stringify(manifest.migrations.slice(0, 22))), 'e6b2664e0694b2f48b6a06c40569b8d2ae919a31f36911be7ad93254a8936914');
  for (const row of manifest.migrations.slice(0, 22)) assert.equal(sha(readFileSync(join(migrationDirectory, row.file))), row.sha256);
  migrateWorkbench(filename, { directory: copyMigrations(directory, 22) });
  const db = new Database(filename); t.after(() => db.close());
  insert(db, 'portfolios', { id: 'retain', name: 'Exact previous data', created_at: stamp });
  const before = snapshot(db).filter(row => row.name !== 'schema_migrations');
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const target = copyMigrations(directory, 23);
  assert.equal(migrateWorkbench(filename, { directory: target }).applied, 1);
  for (const row of before) assert.deepEqual(db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all(), row.rows);
  for (const row of schema) assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(row.name), row);
  for (const table of ['csv_background_requests', 'csv_background_cancellations', 'csv_background_results']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  db.pragma('wal_checkpoint(TRUNCATE)'); const bytes = sha(readFileSync(filename));
  assert.equal(migrateWorkbench(filename, { directory: target }).applied, 0);
  assert.equal(sha(readFileSync(filename)), bytes);
  assert.equal(verifyWorkbenchSchema(db, target).version, 23); assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('request must bind explicit human audit, exact command and finite original input', t => {
  const { db, row } = fixture(t), before = snapshot(db);
  for (const patch of [{ actor_id: 'another' }, { session_hash: 'b'.repeat(64) }, { account_id: 'missing' }, { expected_revision: 1 },
    { input_hash: 'c'.repeat(64) }, { command_request_id: 'missing' }, { approval_audit_id: 'missing' },
    { expires_at: '2026-09-25T00:30:00.000Z' }, { csv_bytes: null }, { operation: 'confirm' }]) {
    assert.throws(() => insert(db, 'csv_background_requests', { ...row, ...patch }));
    assert.deepEqual(snapshot(db), before);
  }
  insert(db, 'csv_background_requests', row);
});

test('request, authorization, command, cancellation reject update delete replace and ignore bypass', t => {
  const { db, row, command, audit } = fixture(t); insert(db, 'csv_background_requests', row);
  const cancel = { request_id: row.id, actor_id: 'owner', session_hash: 'b'.repeat(64), reason: 'Explicit new-session cancel', created_at: stamp };
  insert(db, 'csv_background_cancellations', cancel);
  const before = snapshot(db);
  for (const [table, original] of [['csv_background_requests', row], ['csv_background_cancellations', cancel], ['command_requests', command], ['audit_events', audit]]) {
    const key = Object.keys(original)[0];
    assert.throws(() => db.prepare(`UPDATE ${table} SET ${key}=${key}`).run());
    assert.throws(() => db.prepare(`DELETE FROM ${table}`).run());
    for (const mode of ['INSERT OR REPLACE', 'INSERT OR IGNORE']) assert.throws(() => insert(db, table, original, mode));
    assert.deepEqual(snapshot(db), before);
  }
});

test('jobs and attempts cannot forge, replace, re-scope or manufacture success', t => {
  const { db, row, job } = fixture(t); insert(db, 'csv_background_requests', row);
  for (const patch of [{ scope: 'elsewhere' }, { period: 'other' }, { max_attempts: 4 }, { input_version: 'wrong' },
    { command_request_id: null }, { job_type: 'ordinary' }, { status: 'succeeded' }, { status: 'running', attempt_count: 1 }]) {
    assert.throws(() => insert(db, 'job_runs', { ...job, ...patch }));
  }
  insert(db, 'job_runs', job);
  for (const mode of ['INSERT OR REPLACE', 'INSERT OR IGNORE']) assert.throws(() => insert(db, 'job_runs', job, mode));
  for (const [field, value] of Object.entries({ job_type: 'ordinary', command_request_id: null, scope: 'wrong', period: 'other', input_version: 'wrong', max_attempts: 4 })) {
    assert.throws(() => db.prepare(`UPDATE job_runs SET ${field}=? WHERE id=?`).run(value, job.id));
  }
  assert.throws(() => db.prepare('DELETE FROM job_runs').run());
  db.prepare("UPDATE job_runs SET status='running',lease_owner='worker',lease_until='2026-09-25T00:05:00.000Z',attempt_count=1,fencing_token=1 WHERE id=?").run(job.id);
  const attempt = { id: 'attempt', job_id: job.id, attempt: 1, fencing_token: 1, status: 'running', started_at: stamp, finished_at: null, error_json: null };
  insert(db, 'job_attempts', attempt);
  for (const mode of ['INSERT OR REPLACE', 'INSERT OR IGNORE']) assert.throws(() => insert(db, 'job_attempts', attempt, mode));
  assert.throws(() => db.prepare('DELETE FROM job_attempts').run());
  assert.throws(() => db.prepare("UPDATE job_attempts SET status='succeeded',finished_at=?").run(stamp));
  assert.throws(() => db.prepare("UPDATE job_runs SET status='succeeded',lease_owner=NULL,lease_until=NULL,result_json='{}'").run());
  db.prepare("UPDATE job_attempts SET status='failed',finished_at=?").run(stamp);
  db.prepare("UPDATE job_runs SET status='failed',lease_owner=NULL,lease_until=NULL").run();
  assert.throws(() => db.prepare("UPDATE job_runs SET status='queued'").run());
  assert.throws(() => db.prepare("UPDATE job_attempts SET status='running'").run());
});
