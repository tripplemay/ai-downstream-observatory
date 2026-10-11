import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration 27 appends independent model state and preserves all version 26 rows and checksums', t => {
  const directory = mkdtempSync(join(tmpdir(), 'investor-monitor-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix');
  mkdirSync(prefix);
  for (const migration of manifest.migrations.slice(0, 26)) cpSync(join(migrationDirectory, migration.file), join(prefix, migration.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 26) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  assert.equal(db.pragma('user_version', { simple: true }), 26);
  db.prepare("INSERT INTO investor_workspaces(id,owner_id,revision,created_at) VALUES('synthetic','synthetic',0,'2026-01-02T12:00:00.000Z')").run();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT * FROM ${name}`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrateWorkbench(filename); verifyWorkbenchSchema(db);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=26 ORDER BY version').all(), applied);
  for (const table of ['investor_models', 'investor_model_controls', 'investor_model_inputs', 'investor_model_checkpoints', 'investor_monitor_requests', 'investor_monitor_runs'])
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  const after = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(); migrateWorkbench(filename);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), after);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
