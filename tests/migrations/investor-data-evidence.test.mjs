import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration 29 preserves version 28 rows and checksums; retained quote payloads remain separate from immutable receipts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'investor-data-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix');
  mkdirSync(prefix);
  for (const migration of manifest.migrations.slice(0, 28)) cpSync(join(migrationDirectory, migration.file), join(prefix, migration.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 28) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  assert.equal(db.pragma('user_version', { simple: true }), 28);
  db.prepare("INSERT INTO investor_workspaces(id,owner_id,revision,created_at) VALUES('synthetic','synthetic',0,'2026-01-02T12:00:00.000Z')").run();
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('old-audit','synthetic','test','synthetic','synthetic','{}','2026-01-02T12:00:00.000Z')").run();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT * FROM ${name}`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrateWorkbench(filename); verifyWorkbenchSchema(db);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=28 ORDER BY version').all(), applied);
  for (const table of ['investor_data_sources', 'investor_data_reviews', 'investor_price_captures', 'investor_price_payloads', 'investor_price_purges'])
    assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='investor_price_payload_delete'").get().sql, /purge record/);
  assert.throws(() => db.prepare("INSERT INTO investor_price_payloads(capture_id,projection) VALUES('missing',?)").run(Buffer.from('{}')), /FOREIGN KEY/);
  const after = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(); migrateWorkbench(filename);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), after);
  assert.deepEqual(snapshot(), before); assert.deepEqual(db.pragma('foreign_key_check'), []);
});
