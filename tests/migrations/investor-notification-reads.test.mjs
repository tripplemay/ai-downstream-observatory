import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration 40 preserves all version-39 rows and transport attempts, adds only read guards/indexes and remains idempotent', t => {
  const directory = mkdtempSync(join(tmpdir(), 'investor-notification-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix'); mkdirSync(prefix);
  for (const migration of manifest.migrations.slice(0, 39)) cpSync(join(migrationDirectory, migration.file), join(prefix, migration.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 39) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys=ON');
  const at = '2026-01-03T12:00:00.000Z', hash = createHash('sha256').update('{}').digest('hex');
  db.prepare('INSERT INTO investor_workspaces VALUES(?,?,?,?)').run('fictional-workspace', 'fictional-owner', 7, at);
  db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?,?)').run('fictional-audit', 'fictional-owner', 'fictional_fixture', 'profile', 'fictional-profile', null, null, '{}', at);
  db.prepare('INSERT INTO investor_profiles VALUES(?,?,?,?,?,?,?,?)').run('fictional-profile', 'fictional-workspace', 1, '{}', hash, 'fictional-owner', at, 'fictional-audit');
  db.prepare('INSERT INTO investor_observations VALUES(?,?,?,?,?,?,?,?,?)').run('fictional-observation', 'fictional-workspace', 'fictional-profile', null,
    'insufficient_evidence', '{"outcome":"insufficient_evidence"}', hash, hash, at);
  db.prepare('INSERT INTO job_runs(id,job_type,scope,period,input_version,status,not_before,created_at,updated_at,result_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('fictional-job', 'fictional-test', 'fictional-workspace', 'fictional-period', hash, 'succeeded', at, at, at, '{"fixture":true}');
  // Component rows do not claim a source-qualified monitor publication.
  db.prepare('INSERT INTO outbox(id,dedup_key,topic,payload_json,status,attempt_count,not_before,last_error,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('fictional-notice', 'fictional-dedup', 'investor.observation.changed', '{"fixture":true}', 'uncertain', 1, at, 'FICTIONAL_TRANSPORT_ERROR', at);
  db.prepare('INSERT INTO notification_attempts VALUES(?,?,?,?,?,?)').run('fictional-attempt', 'fictional-notice', 1, 'uncertain', '{"fixture":true}', at);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  const result = migrateWorkbench(filename); assert.equal(result.applied, manifest.migrations.length - 39);
  assert.equal(verifyWorkbenchSchema(db).version, manifest.migrations.length); assert.deepEqual(snapshot(), before);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=39 ORDER BY version').all(), applied);
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%'").all())
    if (!names.includes(name)) assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get().n, 0);
  for (const name of ['investor_evidence_notifications_by_workspace', 'investor_notification_read_once', 'investor_notification_read_guard'])
    assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.throws(() => db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?,?)').run('invalid-read', 'fictional-owner', 'investor_notification_read',
    'investor_notification', 'fictional-notice', null, null, JSON.stringify({ workspace_id: 'fictional-workspace', publication_hash: hash }), at), /binding is invalid/);
  assert.deepEqual(snapshot(), before); assert.equal(migrateWorkbench(filename).applied, 0); assert.deepEqual(snapshot(), before);
});
