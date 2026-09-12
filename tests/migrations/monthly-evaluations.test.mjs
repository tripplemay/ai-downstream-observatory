import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMigrations, migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const Database = createRequire(join(root, 'web/package.json'))('better-sqlite3');
const now = '2026-01-01T00:00:00.000000Z', done = '2026-01-01T00:01:00.000000Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const insert = (db, table, value, prefix = 'INSERT') => db.prepare(`${prefix} INTO ${table}(${Object.keys(value).join(',')}) VALUES(${Object.keys(value).map(() => '?')})`).run(...Object.values(value));

function fixture(t, version = loadMigrations().length) {
  const directory = mkdtempSync(join(tmpdir(), 'monthly-migration-')), filename = join(directory, 'workbench.db');
  let migrations = migrationDirectory;
  if (version !== loadMigrations().length) {
    migrations = join(directory, `v${version}`); mkdirSync(migrations);
    const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'), 'utf8'));
    for (const item of manifest.migrations.slice(0, version)) cpSync(join(migrationDirectory, item.file), join(migrations, item.file));
    writeFileSync(join(migrations, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, version) }));
  }
  migrateWorkbench(filename, { directory: migrations });
  const db = new Database(filename); db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=OFF');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const portfolio of ['p', 'other']) {
    insert(db, 'portfolios', { id: portfolio, name: 'Synthetic monthly fixture', created_at: now });
    insert(db, 'policy_versions', { id: `policy-${portfolio}`, portfolio_id: portfolio, version: 1, policy_json: '{}', content_hash: sha('{}'), created_by: 'synthetic-human', created_at: now });
    insert(db, 'strategy_versions', { id: `strategy-${portfolio}`, portfolio_id: portfolio, strategy_key: 'synthetic-monthly', version: 1, parameters_json: '{}', content_hash: sha('{}'), created_by: 'synthetic-human', created_at: now });
  }
  return { db, filename };
}
function identity(id = 'schedule', portfolio = 'p') {
  return { id, portfolio_id: portfolio, environment: 'actual', strategy_key: 'synthetic-monthly', scope_key: 'portfolio', created_by: 'synthetic-human', created_at: now };
}
function version(id = 'version', scheduleId = 'schedule', n = 1, portfolio = 'p') {
  const definition_json = JSON.stringify({ schema_version: 'evaluation-schedule-v1', environment: 'actual', frequency: 'monthly', policy_version_id: `policy-${portfolio}`, strategy_version_id: `strategy-${portfolio}` });
  return { id, schedule_id: scheduleId, version: n, policy_version_id: `policy-${portfolio}`, strategy_version_id: `strategy-${portfolio}`, definition_json, content_hash: sha(definition_json), created_by: 'synthetic-human', created_at: now };
}
function audit(db, id, scheduleId = 'schedule', portfolio = 'p') {
  insert(db, 'audit_events', { id, actor_id: 'synthetic-human', action: 'save_evaluation_schedule', object_type: 'evaluation_schedule', object_id: scheduleId,
    portfolio_id: portfolio, payload_json: '{}', created_at: now });
  return id;
}
function schedule(db, enabled = true) {
  insert(db, 'evaluation_schedules', identity()); insert(db, 'evaluation_schedule_versions', version());
  insert(db, 'evaluation_schedule_heads', { schedule_id: 'schedule', current_version_id: 'version', revision: 1, status: 'paused', last_audit_id: audit(db, 'audit-create'), updated_at: now });
  if (enabled) db.prepare("UPDATE evaluation_schedule_heads SET revision=2,status='enabled',last_audit_id=? WHERE schedule_id='schedule'").run(audit(db, 'audit-enable'));
}
function cycle(id = 'cycle', period = '2026-01') {
  return { id, portfolio_id: 'p', strategy_version_id: 'strategy-p', policy_version_id: 'policy-p', scope: 'actual:portfolio', period,
    status: 'pending', outcome: null, completed_at: null, schedule_version_id: 'version', environment: 'actual', strategy_key: 'synthetic-monthly', scope_key: 'portfolio',
    scheduled_at: now, cutoff_at: now, knowledge_at: now, deadline_at: '2026-01-02T00:00:00.000000Z', created_at: now, state_revision: 1, terminal_attempt_id: null };
}
function command(db, id = 'command', cycleId = 'cycle', patch = {}) {
  const body = JSON.stringify({ cycle_id: cycleId });
  insert(db, 'command_requests', { id, portfolio_id: 'p', command_type: 'monthly_evaluation', idempotency_key: id, payload_hash: sha(body), payload_json: body, actor_id: 'system:monthly-scheduler', created_at: now, ...patch });
}
function request(cycleId = 'cycle', commandId = 'command', generation = 1) {
  return { command_request_id: commandId, cycle_id: cycleId, generation, requested_by: 'system:monthly-scheduler', reason: 'Synthetic authorized request', created_at: now };
}
function job(db, { cycleId = 'cycle', commandId = 'command', generation = 1, jobId = 'job', attemptId = 'job-attempt' } = {}) {
  command(db, commandId, cycleId); insert(db, 'evaluation_cycle_requests', request(cycleId, commandId, generation));
  insert(db, 'job_runs', { id: jobId, command_request_id: commandId, job_type: 'monthly_evaluation', scope: 'p', period: '2026-01', input_version: commandId,
    status: 'running', max_attempts: 3, not_before: now, created_at: now, updated_at: now, lease_owner: 'synthetic-worker', lease_until: '2026-01-01T00:10:00.000000Z', fencing_token: 1, attempt_count: 1 });
  insert(db, 'job_attempts', { id: attemptId, job_id: jobId, attempt: 1, fencing_token: 1, status: 'running', started_at: now });
}
function attempt(id = 'attempt', cycleId = 'cycle', jobAttemptId = 'job-attempt', n = 1, status = 'succeeded') {
  return { id, cycle_id: cycleId, attempt: n, input_manifest: '{}', status, result_json: '{}', created_at: now,
    job_attempt_id: jobAttemptId, input_hash: sha('{}'), result_hash: sha('{}'), completed_at: done };
}
function running(db, id = 'cycle') { db.prepare("UPDATE evaluation_cycles SET status='running',state_revision=state_revision+1 WHERE id=?").run(id); }
function finish(db, status = 'completed', outcome = 'unchanged', attemptId = 'attempt', cycleId = 'cycle') {
  db.prepare('UPDATE evaluation_cycles SET status=?,outcome=?,completed_at=?,terminal_attempt_id=?,state_revision=state_revision+1 WHERE id=?').run(status, outcome, done, attemptId, cycleId);
}
function ready(t) { const f = fixture(t); schedule(f.db); insert(f.db, 'evaluation_cycles', cycle()); job(f.db); return f; }

test('v14 to v15 retains legacy cycle/attempt bytes and all original facts without seeding an authorized schedule', t => {
  const f = fixture(t, 14);
  const oldCycle = { id: 'legacy-cycle', portfolio_id: 'p', strategy_version_id: 'strategy-p', policy_version_id: 'policy-p', scope: 'legacy-scope', period: 'old-period', status: 'completed', outcome: 'unchanged', completed_at: now };
  const oldAttempt = { id: 'legacy-attempt', cycle_id: 'legacy-cycle', attempt: 1, input_manifest: ' {"synthetic": true} ', status: 'succeeded', result_json: '{"legacy":true}', created_at: now };
  insert(f.db, 'evaluation_cycles', oldCycle); insert(f.db, 'evaluation_attempts', oldAttempt);
  const before = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'schema_migrations'").all().map(({ name }) => ({ name,
    columns: f.db.pragma(`table_info(${name})`).map(row => row.name), rows: f.db.prepare(`SELECT * FROM ${name}`).all() }));
  assert.equal(migrateWorkbench(f.filename).applied, loadMigrations().length - 14);
  for (const { name, columns, rows } of before) assert.deepEqual(f.db.prepare(`SELECT ${columns.join(',')} FROM ${name}`).all(), rows, name);
  for (const table of ['evaluation_schedules', 'evaluation_schedule_heads', 'evaluation_schedule_versions', 'evaluation_cycle_requests']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.equal(f.db.prepare('SELECT schedule_version_id FROM evaluation_cycles').get().schedule_version_id, null);
  assert.equal(f.db.prepare('SELECT job_attempt_id FROM evaluation_attempts').get().job_attempt_id, null);
  assert.throws(() => f.db.exec("UPDATE evaluation_cycles SET status='pending'"), /immutable/);
  assert.equal(migrateWorkbench(f.filename).applied, 0); assert.equal(verifyWorkbenchSchema(f.db).version, loadMigrations().length);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('quick_check', { simple: true }), 'ok');
});

test('schedule identity/version constraints enforce scope, JSON binding, consecutive versions and append-only replacement guards', t => {
  const { db } = fixture(t); insert(db, 'evaluation_schedules', identity());
  for (const patch of [{ policy_version_id: 'policy-other' }, { strategy_version_id: 'strategy-other' }, { version: 2 }, { definition_json: '[]' },
    { definition_json: '{bad' }, { definition_json: '{}' }, { content_hash: 'A'.repeat(64) }, { content_hash: Buffer.alloc(64, 'a') }, { created_at: 'invalid' }])
    assert.throws(() => insert(db, 'evaluation_schedule_versions', { ...version(), ...patch }));
  insert(db, 'evaluation_schedule_versions', version());
  assert.throws(() => insert(db, 'evaluation_schedules', identity('replacement'), 'INSERT OR REPLACE'), /immutable/);
  assert.throws(() => insert(db, 'evaluation_schedule_versions', { ...version(), definition_json: '{}', content_hash: sha('{}') }, 'INSERT OR REPLACE'), /append-only/);
  assert.throws(() => insert(db, 'evaluation_schedule_versions', version('other-id'), 'INSERT OR REPLACE'), /append-only/);
  for (const table of ['evaluation_schedules', 'evaluation_schedule_versions']) {
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable|append-only/);
    assert.throws(() => db.exec(`UPDATE ${table} SET created_by='changed'`), /immutable|append-only/);
  }
});

test('schedule heads start paused, require audited CAS, and every next version starts paused', t => {
  const { db } = fixture(t); schedule(db, false);
  audit(db, 'audit-status'); audit(db, 'audit-wrong', 'wrong-schedule');
  assert.throws(() => db.exec("UPDATE evaluation_schedule_heads SET status='enabled'"), /CAS/);
  assert.throws(() => db.exec("UPDATE evaluation_schedule_heads SET revision=2,status='enabled',last_audit_id='audit-wrong'"), /audit scope/);
  db.exec("UPDATE evaluation_schedule_heads SET revision=2,status='enabled',last_audit_id='audit-status'");
  insert(db, 'evaluation_schedule_versions', version('version-2', 'schedule', 2)); audit(db, 'audit-version');
  assert.throws(() => db.exec("UPDATE evaluation_schedule_heads SET current_version_id='version-2',revision=3,last_audit_id='audit-version'"), /require pause/);
  db.exec("UPDATE evaluation_schedule_heads SET current_version_id='version-2',status='paused',revision=3,last_audit_id='audit-version'");
  audit(db, 'audit-backwards');
  assert.throws(() => db.exec("UPDATE evaluation_schedule_heads SET current_version_id='version',revision=4,last_audit_id='audit-backwards'"), /require pause/);
  const head = db.prepare('SELECT * FROM evaluation_schedule_heads').get();
  assert.throws(() => insert(db, 'evaluation_schedule_heads', head, 'INSERT OR REPLACE'), /cannot be replaced/);
  assert.throws(() => db.exec('DELETE FROM evaluation_schedule_heads'), /cannot be deleted/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('new cycles require exact bindings and stable month slot survives changed policy/strategy versions and conflict modes', t => {
  const { db } = fixture(t); schedule(db, false);
  assert.throws(() => insert(db, 'evaluation_cycles', cycle()), /schedule scope/);
  db.prepare("UPDATE evaluation_schedule_heads SET revision=2,status='enabled',last_audit_id=?").run(audit(db, 'audit-enable'));
  for (const patch of [{ schedule_version_id: null }, { portfolio_id: 'other' }, { strategy_key: 'another' }, { scope: 'arbitrary' }, { environment: 'research' },
    { period: '2026-13' }, { period: '2026-1' }, { period: '0000-01' }, { state_revision: 0 }, { state_revision: 1.5 }, { status: 'completed' },
    { scheduled_at: null }, { knowledge_at: done }, { cutoff_at: done }, { deadline_at: now }, { deadline_at: '2026-01-09T00:00:00Z' }, { created_at: '2025-12-31T00:00:00Z' }])
    assert.throws(() => insert(db, 'evaluation_cycles', { ...cycle(), ...patch }), /evaluation|portfolio mismatch/);
  insert(db, 'evaluation_cycles', cycle());
  insert(db, 'strategy_versions', { id: 'strategy-new', portfolio_id: 'p', strategy_key: 'synthetic-monthly', version: 2, parameters_json: '{}', content_hash: sha('{}'), created_by: 'synthetic-human', created_at: now });
  const next = version('version-2', 'schedule', 2); next.strategy_version_id = 'strategy-new'; next.definition_json = JSON.stringify({ ...JSON.parse(next.definition_json), strategy_version_id: 'strategy-new' }); next.content_hash = sha(next.definition_json);
  insert(db, 'evaluation_schedule_versions', next);
  db.prepare("UPDATE evaluation_schedule_heads SET current_version_id='version-2',revision=3,status='paused',last_audit_id=?").run(audit(db, 'audit-version'));
  db.prepare("UPDATE evaluation_schedule_heads SET revision=4,status='enabled',last_audit_id=?").run(audit(db, 'audit-enable-again'));
  const other = { ...cycle('other-cycle'), schedule_version_id: 'version-2', strategy_version_id: 'strategy-new' };
  assert.throws(() => insert(db, 'evaluation_cycles', other), /monthly slot/);
  assert.throws(() => insert(db, 'evaluation_cycles', other, 'INSERT OR REPLACE'), /monthly slot/);
  assert.throws(() => insert(db, 'evaluation_cycles', { ...other, id: 'cycle', period: '2026-02' }, 'INSERT OR REPLACE'), /monthly slot/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM evaluation_cycles').get().n, 1);
});

test('cycle requests enforce current pending scope, exact command payload, principal and consecutive generation', t => {
  const { db } = fixture(t); schedule(db); insert(db, 'evaluation_cycles', cycle());
  for (const [n, patch] of [{ portfolio_id: 'other' }, { command_type: 'valuation' }, { payload_json: '{"cycle_id":"wrong"}' },
    { payload_json: '{"cycle_id":"cycle","result":"unchanged"}' }, { payload_json: '{"cycle_id":"cycle","cycle_id":"cycle"}' }, { actor_id: 'other' }].entries()) {
    command(db, `wrong-${n}`, 'cycle', patch);
    assert.throws(() => insert(db, 'evaluation_cycle_requests', request('cycle', `wrong-${n}`)), /scope mismatch/);
  }
  command(db); assert.throws(() => insert(db, 'evaluation_cycle_requests', request('cycle', 'command', 2)), /generation/);
  insert(db, 'evaluation_cycle_requests', request());
  assert.throws(() => insert(db, 'evaluation_cycle_requests', request(), 'INSERT OR REPLACE'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM evaluation_cycle_requests'), /append-only/);
  assert.throws(() => db.exec("UPDATE evaluation_cycle_requests SET reason='changed'"), /append-only/);
});

test('attempt results require real current fenced job, bound cycle, valid JSON hashes and append-only identities', t => {
  const { db } = ready(t); running(db);
  for (const patch of [{ job_attempt_id: 'missing' }, { cycle_id: 'missing' }, { attempt: 2 }, { attempt: 1.5 }, { input_manifest: '[]' }, { result_json: '{bad' },
    { input_hash: null }, { input_hash: 'A'.repeat(64) }, { result_hash: Buffer.alloc(64, 'a') }, { completed_at: null }, { completed_at: '2025-01-01T00:00:00Z' }])
    assert.throws(() => insert(db, 'evaluation_attempts', { ...attempt(), ...patch }));
  db.exec("UPDATE job_runs SET fencing_token=2 WHERE id='job'");
  assert.throws(() => insert(db, 'evaluation_attempts', attempt()), /job scope/);
  assert.throws(() => running(db), /current job attempt/);
  db.exec("UPDATE job_runs SET fencing_token=1 WHERE id='job'");
  db.exec("UPDATE job_runs SET period='2026-02' WHERE id='job'");
  assert.throws(() => insert(db, 'evaluation_attempts', attempt()), /job scope/);
  db.exec("UPDATE job_runs SET period='2026-01' WHERE id='job'");
  insert(db, 'evaluation_attempts', attempt());
  assert.throws(() => insert(db, 'evaluation_attempts', attempt(), 'INSERT OR REPLACE'), /append-only/);
  assert.throws(() => insert(db, 'evaluation_attempts', attempt('replacement'), 'INSERT OR REPLACE'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM evaluation_attempts'), /append-only/);
  assert.throws(() => db.exec("UPDATE evaluation_attempts SET result_json='{}'"), /append-only/);
});

test('an unprocessed or running request cannot be superseded by a second generation', t => {
  const { db } = ready(t);
  command(db, 'command-2');
  assert.throws(() => insert(db, 'evaluation_cycle_requests', request('cycle', 'command-2', 2)), /prior request is not terminal/);
  db.exec("UPDATE job_runs SET status='retry_queued' WHERE id='job'");
  assert.throws(() => insert(db, 'evaluation_cycle_requests', request('cycle', 'command-2', 2)), /prior request is not terminal/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM evaluation_cycle_requests').get().n, 1);
});

test('completed unchanged/proposed cycles require matching terminal attempt and can never reopen or change identity', t => {
  for (const outcome of ['unchanged', 'proposed']) {
    const { db } = ready(t);
    assert.throws(() => finish(db, 'completed', outcome), /transition|matching attempt/);
    running(db); assert.throws(() => finish(db, 'completed', outcome), /matching attempt/);
    insert(db, 'evaluation_attempts', attempt());
    assert.throws(() => finish(db, 'completed', null), /matching attempt/);
    assert.throws(() => finish(db, 'blocked', 'blocked'), /matching attempt/);
    finish(db, 'completed', outcome);
    const frozen = db.prepare('SELECT * FROM evaluation_cycles').get();
    assert.throws(() => db.exec("UPDATE evaluation_cycles SET status='pending',outcome=NULL,completed_at=NULL,terminal_attempt_id=NULL,state_revision=state_revision+1"), /immutable/);
    assert.throws(() => db.exec("UPDATE evaluation_cycles SET outcome='blocked'"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM evaluation_cycles'), /cannot be deleted/);
    assert.deepEqual(db.prepare('SELECT * FROM evaluation_cycles').get(), frozen);
  }
});

test('blocked retry preserves all monthly inputs, clears terminal state, and appends a new request and attempt', t => {
  const { db } = ready(t); running(db); insert(db, 'evaluation_attempts', attempt('attempt', 'cycle', 'job-attempt', 1, 'blocked')); finish(db, 'blocked', 'blocked');
  db.prepare("UPDATE job_attempts SET status='succeeded',finished_at=? WHERE id='job-attempt'").run(done);
  db.prepare("UPDATE job_runs SET status='succeeded',updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id='job'").run(done);
  assert.throws(() => db.exec("UPDATE evaluation_cycles SET status='pending',state_revision=state_revision+1"), /clear result/);
  assert.throws(() => db.exec("UPDATE evaluation_cycles SET period='2026-02',state_revision=state_revision+1"), /identity/);
  db.exec("UPDATE evaluation_cycles SET status='pending',outcome=NULL,completed_at=NULL,terminal_attempt_id=NULL,state_revision=state_revision+1");
  assert.throws(() => running(db), /current job attempt/);
  job(db, { commandId: 'command-2', generation: 2, jobId: 'job-2', attemptId: 'job-attempt-2' }); running(db);
  insert(db, 'evaluation_attempts', attempt('attempt-2', 'cycle', 'job-attempt-2', 2)); finish(db, 'completed', 'unchanged', 'attempt-2');
  const saved = db.prepare('SELECT * FROM evaluation_cycles').get();
  for (const key of ['period', 'scope', 'schedule_version_id', 'cutoff_at', 'knowledge_at', 'deadline_at']) assert.equal(saved[key], cycle()[key]);
  assert.deepEqual(db.prepare('SELECT generation FROM evaluation_cycle_requests ORDER BY generation').all(), [{ generation: 1 }, { generation: 2 }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM evaluation_attempts').get().n, 2);
});

test('exhausted infrastructure jobs can fail a cycle without inventing a domain result, but only with matching latest terminal job evidence', t => {
  for (const status of ['failed', 'lease_expired']) {
    const { db } = ready(t); running(db);
    assert.throws(() => finish(db, 'failed', null, null), /matching attempt/);
    db.prepare('UPDATE job_attempts SET status=?,finished_at=? WHERE id=?').run(status, done, 'job-attempt');
    assert.throws(() => finish(db, 'failed', null, null), /matching attempt/);
    db.prepare("UPDATE job_runs SET status='failed',updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id='job'").run(done);
    assert.throws(() => db.prepare("UPDATE evaluation_cycles SET status='failed',outcome=NULL,completed_at=?,terminal_attempt_id=NULL,state_revision=state_revision+1").run(now), /matching attempt/);
    finish(db, 'failed', null, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM evaluation_attempts').get().n, 0);
    db.exec("UPDATE evaluation_cycles SET status='pending',outcome=NULL,completed_at=NULL,terminal_attempt_id=NULL,state_revision=state_revision+1");
    assert.equal(db.prepare('SELECT status FROM evaluation_cycles').get().status, 'pending');
  }
});

test('failed atomic publication rolls back domain result and cycle completion without changing facts or approvals', t => {
  const { db } = ready(t); running(db);
  assert.throws(() => db.transaction(() => {
    insert(db, 'evaluation_attempts', attempt()); finish(db);
    insert(db, 'evaluation_attempts', attempt('duplicate'));
  }).immediate(), /append-only/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM evaluation_attempts').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM evaluation_cycles').get().status, 'running');
  for (const table of ['ledger_events', 'postings', 'reservations', 'approval_events', 'proposals']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
