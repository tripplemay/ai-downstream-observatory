import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
const tables = ['investor_initial_price_requests', 'investor_initial_price_runs'];
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'initial-price-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix'); mkdirSync(prefix);
  for (const entry of manifest.migrations.slice(0, 43)) cpSync(join(migrationDirectory, entry.file), join(prefix, entry.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 43) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  const at = '2026-01-02T12:00:00.000Z';
  db.prepare("INSERT INTO investor_workspaces VALUES('w','fictional',7,?)").run(at);
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('a','fictional','fixture','fixture','fixture','{}',?)").run(at);
  db.prepare("INSERT INTO investor_profiles(rowid,id,workspace_id,version,document_json,content_hash,actor_id,created_at,audit_id) VALUES(29,'p','w',1,'{}',?,'fictional',?,'a')").run('a'.repeat(64), at);
  db.exec("CREATE TABLE fictional_profile_child(id TEXT PRIMARY KEY,profile_id TEXT REFERENCES investor_profiles(id)); INSERT INTO fictional_profile_child VALUES('child','p')");
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  return { directory, manifest, filename, db, snapshot, before: snapshot(), applied: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all() };
}

test('migration 44 preserves all version 43 objects, rows, rowids, child FKs and checksums', t => {
  const f = fixture(t), objects = f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const target = join(f.directory, 'version-44'); mkdirSync(target);
  for (const entry of f.manifest.migrations.slice(0, 44)) cpSync(join(migrationDirectory, entry.file), join(target, entry.file));
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...f.manifest, migrations: f.manifest.migrations.slice(0, 44) }));
  assert.equal(migrateWorkbench(f.filename, { directory: target }).applied, 1); verifyWorkbenchSchema(f.db, target);
  assert.deepEqual(f.snapshot(), f.before); assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=43 ORDER BY version').all(), f.applied);
  const after = f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  for (const object of objects) assert.deepEqual(after.find(row => row.name === object.name && row.type === object.type), object);
  for (const table of tables) {
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    for (const suffix of ['insert', 'update', 'delete']) {
      const kind = table === tables[0] ? 'request' : 'run';
      assert.ok(f.db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('trigger', `investor_initial_price_${kind}_${suffix}`));
    }
  }
  assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(migrateWorkbench(f.filename, { directory: target }).applied, 0); assert.deepEqual(f.snapshot(), f.before);
});

test('initial price metadata cannot invent an owner, model, reviewed authority or running job', t => {
  const f = fixture(t); migrateWorkbench(f.filename);
  const spec = { schema_version: 'investor-initial-price-request-v1', engine_version: 'investor-initial-price-producer-v1', workspace_id: 'w', model_id: 'm',
    model_hash: 'a'.repeat(64), control_id: 'c', reference_input_id: 'i', reference_input_hash: 'a'.repeat(64), listing_id: 'fictional', market: 'CN',
    session_date: '2026-01-02', rights_review_id: 'rights', listing_review_id: 'listing', calendar_review_id: 'calendar', binding_hash: 'a'.repeat(64),
    valid_until: '2026-01-09T07:00:00.000000Z', live_advice_eligible: false };
  assert.throws(() => f.db.prepare('INSERT INTO investor_initial_price_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('r','w','m','c','i',spec.listing_id,'CN',spec.session_date,
    'rights','listing','calendar',JSON.stringify(spec),'a'.repeat(64),'fictional','2026-01-03T12:00:00.000Z','missing'), /binding differs|FOREIGN KEY/);
  assert.throws(() => f.db.prepare('INSERT INTO investor_initial_price_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('run','w','m','r','job',null,'transport_failed',
    JSON.stringify({ schema_version: 'investor-initial-price-run-v1', request_id: 'r', job_id: 'job', capture_id: null, receipt_hash: null, status: 'transport_failed',
      reason_code: 'INITIAL_PRICE_TRANSPORT_FAILED', created_at: '2026-01-03T12:00:00.000Z', live_advice_eligible: false }), 'a'.repeat(64),'fictional','2026-01-03T12:00:00.000Z','missing'), /binding differs|FOREIGN KEY/);
  for (const table of tables) assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
});

test('late FK failure rolls back migration 44 metadata, user version and applied state', t => {
  const f = fixture(t), altered = join(f.directory, 'altered'); mkdirSync(altered);
  const entries = f.manifest.migrations.slice(0, 44).map(entry => ({ ...entry }));
  for (const entry of entries) cpSync(join(migrationDirectory, entry.file), join(altered, entry.file));
  const entry = entries[43], sql = readFileSync(join(altered, entry.file), 'utf8') + "\nINSERT INTO fictional_profile_child VALUES('invalid','missing');\n";
  writeFileSync(join(altered, entry.file), sql); entry.sha256 = createHash('sha256').update(sql).digest('hex');
  writeFileSync(join(altered, 'manifest.json'), JSON.stringify({ ...f.manifest, migrations: entries }));
  const schema = f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  assert.throws(() => migrateWorkbench(f.filename, { directory: altered }), /FOREIGN KEY/);
  assert.deepEqual(f.snapshot(), f.before); assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), f.applied);
  assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(), schema);
  assert.equal(f.db.pragma('user_version', { simple: true }), 43); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});
