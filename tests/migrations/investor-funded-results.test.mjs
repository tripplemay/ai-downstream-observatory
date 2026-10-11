import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration 37 preserves populated version 36 and checksum history without inventing result payloads or financial facts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'investor-funded-result-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix'); mkdirSync(prefix);
  for (const migration of manifest.migrations.slice(0, 36)) cpSync(join(migrationDirectory, migration.file), join(prefix, migration.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 36) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  db.exec("INSERT INTO portfolios(rowid,id,name,created_at) VALUES(8,'book','Fictional','2026-01-02T12:00:00.000Z'); INSERT INTO ledger_heads VALUES('book',0,'2026-01-02T12:00:00.000Z'); INSERT INTO investor_workspaces VALUES('w','fictional-owner',0,'2026-01-02T12:00:00.000Z')");
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrateWorkbench(filename); verifyWorkbenchSchema(db);
  assert.deepEqual(snapshot(), before); assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=36 ORDER BY version').all(), applied);
  for (const table of ['investor_funded_result_headers', 'investor_funded_result_payloads', 'investor_funded_result_purges']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  migrateWorkbench(filename); assert.deepEqual(snapshot(), before);
});
