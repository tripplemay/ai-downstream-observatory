import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
const tables = ['investor_confirmed_feed_requests', 'investor_confirmed_feed_runs', 'investor_confirmed_feed_admissions'];

test('migration 43 appends metadata only and preserves version 42 objects, rowids and checksums', t => {
  const directory = mkdtempSync(join(tmpdir(), 'confirmed-feed-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix'); mkdirSync(prefix);
  for (const entry of manifest.migrations.slice(0, 42)) cpSync(join(migrationDirectory, entry.file), join(prefix, entry.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 42) }));
  const target = join(directory, 'version-43'); mkdirSync(target);
  for (const entry of manifest.migrations.slice(0, 43)) cpSync(join(migrationDirectory, entry.file), join(target, entry.file));
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 43) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  const at = '2026-01-02T12:00:00.000Z';
  db.prepare("INSERT INTO investor_workspaces VALUES('w','fictional',7,?)").run(at);
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('a','fictional','fixture','fixture','fixture','{}',?)").run(at);
  db.prepare("INSERT INTO investor_profiles(rowid,id,workspace_id,version,document_json,content_hash,actor_id,created_at,audit_id) VALUES(29,'p','w',1,'{}',?,'fictional',?,'a')").run('a'.repeat(64), at);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  assert.equal(migrateWorkbench(filename, { directory: target }).applied, 1); verifyWorkbenchSchema(db, target);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=42 ORDER BY version').all(), applied);
  const after = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  for (const object of objects) assert.deepEqual(after.find(row => row.name === object.name && row.type === object.type), object);
  for (const table of tables) {
    assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0);
    for (const suffix of ['insert', 'update', 'delete']) {
      const root = table === tables[0] ? 'request' : table === tables[1] ? 'run' : 'admission';
      assert.ok(db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('trigger', `investor_confirmed_feed_${root}_${suffix}`));
    }
  }
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1); assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(migrateWorkbench(filename, { directory: target }).applied, 0); assert.deepEqual(snapshot(), before);
});

test('new feed tables never accept naked caller metadata without reviewed parents and owner audit', t => {
  const directory = mkdtempSync(join(tmpdir(), 'confirmed-feed-guard-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename);
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys=ON');
  const spec = { schema_version: 'investor-confirmed-feed-request-v1', engine_version: 'investor-confirmed-market-producer-v1', workspace_id: 'w', model_id: 'm', control_id: 'c', input_id: 'i',
    market: 'CN', session_date: '2026-01-04', not_before: '2026-01-04T06:58:00.000000Z', latest_start: '2026-01-04T06:59:30.000000Z',
    stop_at: '2026-01-04T07:03:00.000000Z', live_advice_eligible: false };
  assert.throws(() => db.prepare('INSERT INTO investor_confirmed_feed_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('r','w','m','c','i','CN',
    spec.session_date,spec.not_before,spec.latest_start,spec.stop_at,JSON.stringify(spec),'a'.repeat(64),'fictional','2026-01-04T06:55:00.000000Z','missing'), /binding differs|FOREIGN KEY/);
  for (const table of tables) assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0);
});
