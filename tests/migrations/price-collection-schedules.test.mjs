import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), require = createRequire(join(root, 'web/package.json'));
const Database = require('better-sqlite3'), Ajv = require('ajv/dist/2020'), addFormats = require('ajv-formats');
const sha = value => createHash('sha256').update(value).digest('hex');
const tables = ['price_collection_schedules', 'price_collection_schedule_versions', 'price_collection_schedule_controls', 'price_collection_schedule_heads', 'price_collection_schedule_slots'];
const insert = (db, table, row, prefix = 'INSERT') => db.prepare(`${prefix} INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?')})`).run(...Object.values(row));
function snapshot(db, names) {
  names ??= db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  return names.map(name => ({ name, rows: db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() }));
}
function copyMigrations(directory, version) {
  const target = join(directory, `v${version}`); mkdirSync(target);
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), migrations = manifest.migrations.slice(0, version);
  for (const row of migrations) cpSync(join(migrationDirectory, row.file), join(target, row.file));
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations }));
  return target;
}
let baseline;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'price-schedule-ddl-')), filename = join(directory, 'workbench.db');
  if (!baseline) {
    execFileSync(join(root, 'web/node_modules/.bin/tsx'), ['-e', "import {priceScheduleFixture} from './tests/price-schedule-service-fixture.ts';const f=priceScheduleFixture(process.argv[1]);f.enable();f.close();", filename], { cwd: join(root, 'web'), encoding: 'utf8', timeout: 30000 });
    execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.PYTHON ?? 'python3', ['-c', "import sys\nfrom worker.orchestration.db import open_database\nfrom worker.orchestration.price_collections import discover_due_price_collections\nfrom worker.orchestration.runtime import sync_requests\ndb=open_database(sys.argv[1]);discover_due_price_collections(db,now='2026-01-02T16:00:00.000000Z');sync_requests(db,command_types=('market_collect_prices',),now='2026-01-02T16:00:00.000000Z');db.execute('PRAGMA wal_checkpoint(TRUNCATE)');db.close()", filename], { cwd: root, encoding: 'utf8', timeout: 30000 });
    baseline = readFileSync(filename);
  } else writeFileSync(filename, baseline);
  const db = new Database(filename); db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=OFF');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, directory, filename };
}
test('v22 manifest appends only; v21 database value bytes and previous schema remain unchanged with no seed or repeat writes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'price-schedule-upgrade-')), filename = join(directory, 'workbench.db');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const current = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  // Frozen v21 manifest entries from 8e427375; independent of shallow CI checkout history.
  const previous = current.migrations.slice(0, 21);
  assert.equal(sha(JSON.stringify(previous)), 'c2d79e03a3137cde090edbc1314a382ca40190ae9e4d0be2e1257384b2738926');
  for (const row of previous) assert.equal(sha(readFileSync(join(migrationDirectory, row.file))), row.sha256);
  migrateWorkbench(filename, { directory: copyMigrations(directory, 21) });
  const db = new Database(filename); t.after(() => db.close());
  insert(db, 'portfolios', { id: 'synthetic-old', name: 'Retain exact previous bytes', created_at: '2026-01-01T00:00:00.000000Z' });
  const before = snapshot(db).filter(row => row.name !== 'schema_migrations');
  const schema = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const migrations = copyMigrations(directory, 22);
  assert.equal(migrateWorkbench(filename, { directory: migrations }).applied, 1);
  assert.deepEqual(snapshot(db, before.map(row => row.name)), before);
  for (const row of schema) assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master WHERE name=?').get(row.name), row);
  for (const table of tables) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  db.pragma('wal_checkpoint(TRUNCATE)'); const bytes = sha(readFileSync(filename)), state = snapshot(db);
  assert.equal(migrateWorkbench(filename, { directory: migrations }).applied, 0);
  assert.equal(sha(readFileSync(filename)), bytes); assert.deepEqual(snapshot(db), state);
  assert.equal(verifyWorkbenchSchema(db, migrations).version, 22); assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('strict finite price contract accepts no defaults hidden authority or duplicate reviewed references', t => {
  const { db } = fixture(t), doc = JSON.parse(db.prepare('SELECT definition_json FROM price_collection_schedule_versions').get().definition_json);
  const ajv = new Ajv({ strict: true }); addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(join(root, 'contracts/v1/price-collection-schedule.schema.json'))));
  assert.equal(validate(doc), true);
  for (const patch of [{ end_date: null }, { frequency: 'hourly' }, { publish: false }, { max_attempts: 6 }, { deadline_seconds: 59 }, { provider: 'other' }, { allow_investment: true }, { mapping_version_ids: [doc.mapping_version_ids[0], doc.mapping_version_ids[0]] }]) assert.equal(validate({ ...doc, ...patch }), false, JSON.stringify(patch));
});
test('schedule identity versions controls slots and their audit command evidence reject update delete replace and ignore bypass', t => {
  const { db } = fixture(t), before = snapshot(db);
  const schedule = db.prepare('SELECT * FROM price_collection_schedules').get();
  const version = db.prepare('SELECT * FROM price_collection_schedule_versions').get();
  const slot = db.prepare('SELECT * FROM price_collection_schedule_slots').get();
  const immutable = [...tables.filter(name => name !== 'price_collection_schedule_heads'), 'command_requests'];
  for (const table of immutable) {
    const row = db.prepare(`SELECT * FROM ${table}`).get(), key = Object.keys(row)[0];
    assert.throws(() => db.prepare(`UPDATE ${table} SET ${key}=${key}`).run(), table);
    assert.throws(() => db.prepare(`DELETE FROM ${table}`).run(), table);
    for (const mode of ['INSERT OR REPLACE', 'INSERT OR IGNORE']) assert.throws(() => insert(db, table, row, mode), `${mode} ${table}`);
    assert.deepEqual(snapshot(db), before);
  }
  const audit = db.prepare('SELECT * FROM audit_events WHERE id=?').get(version.audit_id);
  for (const mode of ['INSERT OR REPLACE', 'INSERT OR IGNORE']) assert.throws(() => insert(db, 'audit_events', { ...audit, object_type: 'unrelated', action: 'unrelated' }, mode));
  assert.throws(() => db.prepare('UPDATE audit_events SET actor_id=actor_id WHERE id=?').run(audit.id));
  assert.throws(() => db.prepare('DELETE FROM audit_events WHERE id=?').run(audit.id));
  for (const mode of ['INSERT OR REPLACE', 'INSERT OR IGNORE']) assert.throws(() => insert(db, 'price_collection_schedule_slots', { ...slot, id: 'duplicate-period' }, mode));
  assert.throws(() => insert(db, 'price_collection_schedules', { ...schedule, id: 'alias' }, 'INSERT OR REPLACE'));
  assert.deepEqual(snapshot(db), before);
});
test('head cannot rewind replace delete or advance without matching new immutable control', t => {
  const { db } = fixture(t), before = snapshot(db), head = db.prepare('SELECT * FROM price_collection_schedule_heads').get();
  for (const mode of ['INSERT OR REPLACE', 'INSERT OR IGNORE']) assert.throws(() => insert(db, 'price_collection_schedule_heads', head, mode));
  for (const mode of ['UPDATE', 'UPDATE OR REPLACE', 'UPDATE OR IGNORE']) {
    assert.throws(() => db.prepare(`${mode} price_collection_schedule_heads SET revision=1`).run());
    assert.throws(() => db.prepare(`${mode} price_collection_schedule_heads SET revision=3`).run());
  }
  assert.throws(() => db.prepare('DELETE FROM price_collection_schedule_heads').run()); assert.deepEqual(snapshot(db), before);
});
test('closed and mixed dispositions are bound to the complete reviewed calendar set and no request can be smuggled', t => {
  const { db } = fixture(t), original = db.prepare('SELECT * FROM price_collection_schedule_slots').get();
  const closed = { ...original, id: 'closed', period: '2026-01-03', scheduled_at: '2026-01-03T16:00:00.000000Z', deadline_at: '2026-01-03T17:00:00.000000Z', created_at: '2026-01-03T16:00:00.000000Z', disposition: 'skipped', reason_code: 'MARKET_CLOSED', command_request_id: null, expected_publication_revision: null };
  insert(db, 'price_collection_schedule_slots', closed);
  const before = snapshot(db);
  const half = { ...closed, id: 'half-forged', period: '2026-01-04', scheduled_at: '2026-01-04T16:00:00.000000Z', deadline_at: '2026-01-04T17:00:00.000000Z', created_at: '2026-01-04T16:00:00.000000Z' };
  for (const patch of [{}, { disposition: 'blocked', reason_code: 'MIXED_CALENDAR_SESSION' }, { disposition: 'blocked', reason_code: 'REFERENCE_CHANGED' }, { command_request_id: original.command_request_id }]) {
    for (const mode of ['INSERT', 'INSERT OR IGNORE']) assert.throws(() => insert(db, 'price_collection_schedule_slots', { ...half, ...patch }, mode));
    assert.deepEqual(snapshot(db), before);
  }
});
test('scheduled jobs preserve the original target request retry bound and input version while ordinary jobs remain unaffected', t => {
  const { db } = fixture(t), job = db.prepare('SELECT * FROM job_runs').get(), before = snapshot(db);
  for (const mode of ['INSERT OR REPLACE', 'INSERT OR IGNORE']) assert.throws(() => insert(db, 'job_runs', job, mode));
  for (const [key, value] of Object.entries({ period: 'other', scope: 'other', input_version: 'other', max_attempts: 5, command_request_id: null })) {
    assert.throws(() => db.prepare(`UPDATE job_runs SET ${key}=? WHERE id=?`).run(value, job.id));
    assert.throws(() => insert(db, 'job_runs', { ...job, id: 'forged-job', [key]: value }, 'INSERT OR IGNORE'));
    assert.deepEqual(snapshot(db), before);
  }
  assert.throws(() => db.prepare('DELETE FROM job_runs WHERE id=?').run(job.id));
  insert(db, 'job_runs', { ...job, id: 'ordinary', command_request_id: null, job_type: 'ordinary', input_version: 'ordinary', period: 'ordinary' });
  db.prepare("UPDATE job_runs SET max_attempts=4 WHERE id='ordinary'").run();
  db.prepare("DELETE FROM job_runs WHERE id='ordinary'").run(); assert.deepEqual(snapshot(db), before);
});
test('a rejected proof write rolls back its preceding independent domain write', t => {
  const { db } = fixture(t), row = db.prepare('SELECT * FROM price_collection_schedule_slots').get(), before = snapshot(db);
  assert.throws(() => db.transaction(() => {
    insert(db, 'portfolios', { id: 'rolled-back', name: 'Must not survive', created_at: '2026-01-01T00:00:00.000000Z' });
    insert(db, 'price_collection_schedule_slots', { ...row, id: 'alias' }, 'INSERT OR IGNORE');
  }).immediate());
  assert.deepEqual(snapshot(db), before);
});
