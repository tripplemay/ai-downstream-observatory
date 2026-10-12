import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration 28 preserves version 27 rows and checksums while appending immutable trial registry', t => {
  const directory = mkdtempSync(join(tmpdir(), 'investor-trial-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix');
  mkdirSync(prefix);
  for (const migration of manifest.migrations.slice(0, 27)) cpSync(join(migrationDirectory, migration.file), join(prefix, migration.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 27) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  assert.equal(db.pragma('user_version', { simple: true }), 27);
  db.prepare("INSERT INTO investor_workspaces(id,owner_id,revision,created_at) VALUES('synthetic','synthetic',0,'2026-01-02T12:00:00.000Z')").run();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT * FROM ${name}`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrateWorkbench(filename); verifyWorkbenchSchema(db);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=27 ORDER BY version').all(), applied);
  for (const table of ['investor_experiments', 'investor_trial_intents', 'investor_trial_results', 'investor_candidate_freezes'])
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  const after = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(); migrateWorkbench(filename);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), after);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
