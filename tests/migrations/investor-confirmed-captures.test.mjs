import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration 41 preserves every old row, rowid and checksum without fabricating captures or financial facts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'investor-confirmed-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix'); mkdirSync(prefix);
  for (const migration of manifest.migrations.slice(0, 40)) cpSync(join(migrationDirectory, migration.file), join(prefix, migration.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 40) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys=ON');
  db.exec("INSERT INTO portfolios(rowid,id,name,created_at) VALUES(8,'book','Fictional','2026-01-02T12:00:00.000Z'); INSERT INTO ledger_heads VALUES('book',0,'2026-01-02T12:00:00.000Z'); INSERT INTO investor_workspaces VALUES('w','fictional-owner',7,'2026-01-02T12:00:00.000Z')");
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  const result = migrateWorkbench(filename); assert.equal(result.applied, manifest.migrations.length - 40);
  assert.equal(verifyWorkbenchSchema(db).version, manifest.migrations.length); assert.deepEqual(snapshot(), before);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=40 ORDER BY version').all(), applied);
  for (const table of ['captures', 'targets', 'payloads', 'purges'])
    assert.equal(db.prepare(`SELECT count(*) n FROM investor_confirmed_${table}`).get().n, 0);
  for (const name of ['investor_confirmed_targets_rights', 'investor_confirmed_captures_retention', 'investor_confirmed_capture_insert',
    'investor_confirmed_target_insert', 'investor_confirmed_payload_insert', 'investor_confirmed_payload_delete', 'investor_confirmed_purge_insert'])
    assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
  assert.throws(() => db.prepare('INSERT INTO investor_confirmed_payloads VALUES(?,?)').run('missing-capture', Buffer.from('{}')), /investor confirmed payload cannot be replaced or incomplete/);
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(migrateWorkbench(filename).applied, 0); assert.deepEqual(snapshot(), before);
});
