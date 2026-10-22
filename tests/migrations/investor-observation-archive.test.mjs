import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';
const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'observation-archive-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  function version(count) {
    const target = join(directory, 'v' + count); mkdirSync(target);
    for (const entry of manifest.migrations.slice(0, count)) cpSync(join(migrationDirectory, entry.file), join(target, entry.file));
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, count) })); return target;
  }
  const filename = join(directory, 'workbench.db'), prefix = version(45), target = version(46); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  const at = '2026-01-02T12:00:00.000Z', digest = 'a'.repeat(64);
  db.prepare("INSERT INTO investor_workspaces VALUES('w','fictional',7,?)").run(at);
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('a','fictional','fixture','fixture','fixture','{}',?)").run(at);
  db.prepare("INSERT INTO investor_profiles(rowid,id,workspace_id,version,document_json,content_hash,actor_id,created_at,audit_id) VALUES(29,'p','w',1,'{}',?,'fictional',?,'a')").run(digest, at);
  db.prepare("INSERT INTO investor_observations(rowid,id,workspace_id,profile_id,outcome,document_json,content_hash,input_version,created_at) VALUES(37,'o','w','p','insufficient_evidence','{\"outcome\":\"insufficient_evidence\"}',?,?,?)").run(digest, digest, at);
  db.prepare("INSERT INTO investor_decisions(rowid,id,workspace_id,observation_id,decision,note,actor_id,created_at,audit_id) VALUES(41,'d','w','o','defer','Fictional only','fictional',?,'a')").run(at);
  const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => ({ name, rows: db.prepare(`SELECT rowid preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const objects = () => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return { db, filename, target, snapshot, objects, rows: snapshot(), schema: objects(), applied: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all() };
}
test('migration 46 adds only archive lookup indexes and preserves all populated rows, rowids, objects and previous checksums', t => {
  const f = fixture(t); assert.equal(migrateWorkbench(f.filename, { directory: f.target }).applied, 1); verifyWorkbenchSchema(f.db, f.target);
  assert.deepEqual(f.snapshot(), f.rows); assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=45 ORDER BY version').all(), f.applied);
  const objects = f.objects(); assert.equal(objects.length, f.schema.length + 4);
  for (const object of f.schema) assert.deepEqual(objects.find(row => row.name === object.name && row.type === object.type), object);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(f.db.pragma('user_version', { simple: true }), 46); assert.equal(migrateWorkbench(f.filename, { directory: f.target }).applied, 0);
});
test('late archive migration failure rolls back all new indexes, schema history and user version without replacing data', t => {
  const f = fixture(t), manifest = JSON.parse(readFileSync(join(f.target, 'manifest.json'))), entry = manifest.migrations[45];
  const sql = readFileSync(join(f.target, entry.file), 'utf8') + '\nSELECT fictional_migration_failure();\n';
  writeFileSync(join(f.target, entry.file), sql); entry.sha256 = createHash('sha256').update(sql).digest('hex');
  writeFileSync(join(f.target, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => migrateWorkbench(f.filename, { directory: f.target }), /fictional_migration_failure/);
  assert.deepEqual(f.snapshot(), f.rows); assert.deepEqual(f.objects(), f.schema);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), f.applied); assert.equal(f.db.pragma('user_version', { simple: true }), 45);
});
