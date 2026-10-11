import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
const triggers = ['investor_evidence_funding_request_insert', 'investor_evidence_funding_checkpoint_payload_insert', 'investor_evidence_funding_run_insert'];
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'planned-funding-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  function version(count, name) {
    const target = join(directory, name); mkdirSync(target);
    for (const entry of manifest.migrations.slice(0, count)) cpSync(join(migrationDirectory, entry.file), join(target, entry.file));
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, count) }));
    return target;
  }
  const prefix = version(44, 'version-44'), target = version(45, 'version-45'), filename = join(directory, 'workbench.db');
  migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  const at = '2026-01-02T12:00:00.000Z', digest = 'a'.repeat(64);
  db.prepare("INSERT INTO investor_workspaces VALUES('w','fictional',7,?)").run(at);
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('a','fictional','fixture','fixture','fixture','{}',?)").run(at);
  db.prepare("INSERT INTO investor_profiles(rowid,id,workspace_id,version,document_json,content_hash,actor_id,created_at,audit_id) VALUES(29,'p','w',1,'{}',?,'fictional',?,'a')").run(digest, at);
  db.prepare("INSERT INTO investor_reference_plans VALUES('plan','w','p','{\"data_mode\":\"synthetic\"}',?,?)").run(digest, at);
  db.prepare("INSERT INTO investor_plan_selections VALUES('selection','w','plan','fictional',?,'a')").run(at);
  const definition = { model_id: 'model', profile_id: 'p', plan_id: 'plan', scope: 'research_model', data_mode: 'synthetic',
    created_at: at, live_advice_eligible: false, target_definition_hash: digest };
  db.prepare("INSERT INTO investor_models(rowid,id,workspace_id,profile_id,plan_id,selection_id,document_json,content_hash,created_at) VALUES(19,'model','w','p','plan','selection',?,?,?)").run(JSON.stringify(definition), digest, at);
  db.prepare("INSERT INTO investor_model_controls VALUES('control','w','model',1,1,'fictional','a',?)").run(at);
  const plan = { schema_version: 'investor-funding-plan-v1', start_date: '2026-01-02', horizon_years: 1, evaluation_timezone: 'Asia/Shanghai',
    initial_capital_cny: '100.01', annual_contribution_cny: '10.01', first_annual_date: '2026-01-04', entry_method: 'three_tranches_60_days',
    actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false };
  db.prepare("INSERT INTO investor_funding_plans(rowid,id,workspace_id,profile_id,version,profile_hash,document_json,content_hash,actor_id,created_at,audit_id) VALUES(37,'funding','w','p',1,?,?,?,'fictional',?,'a')")
    .run(digest, JSON.stringify(plan), digest, at);
  db.exec("CREATE TABLE fictional_profile_child(id TEXT PRIMARY KEY,profile_id TEXT REFERENCES investor_profiles(id)); INSERT INTO fictional_profile_child VALUES('child','p')");
  const names = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names().map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const objects = () => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return { directory, target, filename, db, snapshot, objects, before: snapshot(), schema: objects(), applied: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all() };
}

test('migration 45 appends only three guards, preserving populated version 44 plans/models, all rows, rowids, child FKs and checksums', t => {
  const f = fixture(t);
  assert.equal(migrateWorkbench(f.filename, { directory: f.target }).applied, 1); verifyWorkbenchSchema(f.db, f.target);
  assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=44 ORDER BY version').all(), f.applied);
  const after = f.objects(); assert.equal(after.length, f.schema.length + triggers.length);
  for (const object of f.schema) assert.deepEqual(after.find(row => row.type === object.type && row.name === object.name), object);
  for (const name of triggers) assert.equal(after.find(row => row.name === name)?.type, 'trigger');
  for (const name of ['portfolios', 'accounts', 'ledger_events', 'postings', 'investor_evidence_model_checkpoints', 'investor_evidence_monitor_requests', 'outbox'])
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${name}`).get().n, 0);
  assert.equal(f.db.pragma('user_version', { simple: true }), 45); assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(migrateWorkbench(f.filename, { directory: f.target }).applied, 0); assert.deepEqual(f.snapshot(), f.before);
});

test('late FK failure rolls back all migration 45 guards, schema history, rows and user version', t => {
  const f = fixture(t), manifest = JSON.parse(readFileSync(join(f.target, 'manifest.json'))), entry = manifest.migrations[44];
  const sql = readFileSync(join(f.target, entry.file), 'utf8') + "\nINSERT INTO fictional_profile_child VALUES('invalid','missing');\n";
  writeFileSync(join(f.target, entry.file), sql); entry.sha256 = createHash('sha256').update(sql).digest('hex');
  writeFileSync(join(f.target, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => migrateWorkbench(f.filename, { directory: f.target }), /FOREIGN KEY/);
  assert.deepEqual(f.objects(), f.schema); assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), f.applied);
  assert.equal(f.db.pragma('user_version', { simple: true }), 44); assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []); assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
});
