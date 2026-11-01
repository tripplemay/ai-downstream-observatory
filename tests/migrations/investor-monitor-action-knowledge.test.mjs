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
  const directory = mkdtempSync(join(tmpdir(), 'fictional-action-knowledge-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json')));
  function copy(name, count) {
    const target = join(directory, name); mkdirSync(target);
    for (const entry of manifest.migrations.slice(0, count)) cpSync(join(migrationDirectory, entry.file), join(target, entry.file));
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, count) })); return target;
  }
  const prefix = copy('v53', 53), target = copy('v54', 54), filename = join(directory, 'workbench.db');
  migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); db.pragma('foreign_keys=ON'); t.after(() => db.close());
  const at = '2026-01-02T12:00:00.000Z', expiry = '2027-01-01T00:00:00.000Z', hash = 'a'.repeat(64);
  db.prepare("INSERT INTO investor_workspaces VALUES('w','fictional',7,?)").run(at);
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('a','fictional','fixture','fixture','fixture','{}',?)").run(at);
  db.prepare("INSERT INTO investor_profiles(rowid,id,workspace_id,version,document_json,content_hash,actor_id,created_at,audit_id) VALUES(9,'p','w',1,'{}',?,'fictional',?,'a')").run(hash, at);
  db.prepare("INSERT INTO investor_reference_plans VALUES('plan','w','p','{\"data_mode\":\"reconstructed\"}',?,?)").run(hash, at);
  db.prepare("INSERT INTO investor_plan_selections VALUES('selection','w','plan','fictional',?,'a')").run(at);
  const definition = { model_id: 'model', profile_id: 'p', plan_id: 'plan', scope: 'research_model', data_mode: 'reconstructed', created_at: at, live_advice_eligible: false, target_definition_hash: hash };
  db.prepare("INSERT INTO investor_models(rowid,id,workspace_id,profile_id,plan_id,selection_id,document_json,content_hash,created_at) VALUES(19,'model','w','p','plan','selection',?,?,?)").run(JSON.stringify(definition), hash, at);
  db.prepare("INSERT INTO investor_model_controls VALUES('control','w','model',1,1,'fictional','a',?)").run(at);
  // Component-only rows exercise old bytes/FKs, not economic or source admission.
  const names = ['investor_monitor_evidence_insert','investor_evidence_request_insert','investor_evidence_checkpoint_insert'];
  const guards = names.map(name => db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name).sql);
  for (const name of names) db.exec(`DROP TRIGGER ${name}`);
  for (const [version,rowid] of [[1,29],[2,31],[3,37]]) {
    const id = `input-v${version}`, audit = `audit-v${version}`;
    const doc = { schema_version: `investor-monitor-data-input-v${version}`, workspace_id: 'w', model_id: 'model', source_qualification: 'owner_reviewed_reconstructed', target_definition_hash: hash,
      created_at: at, valid_until: expiry, live_advice_eligible: false, projection_hash: hash, segments: [{ snapshot: { mode: 'reconstructed', workspace_id: 'w', created_at: at } }] };
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,'fictional','fixture','fixture','fixture','{}',?)").run(audit,at);
    db.prepare("INSERT INTO investor_monitor_evidence_inputs(rowid,id,workspace_id,model_id,source_qualification,document_json,content_hash,actor_id,created_at,valid_until,audit_id) VALUES(?,?,'w','model','owner_reviewed_reconstructed',?,?,'fictional',?,?,?)")
      .run(rowid,id,JSON.stringify(doc),String(version).repeat(64),at,expiry,audit);
  }
  db.prepare("INSERT INTO investor_evidence_monitor_requests VALUES('request','w','model','control','input-v1',NULL,'fixture-period',?,?,'{}',?)").run(hash,hash,at);
  db.prepare("INSERT INTO investor_evidence_model_checkpoints VALUES('checkpoint','w','model','input-v3',1,NULL,?,?,?,?)").run(hash,hash,at,expiry);
  for (const sql of guards) db.exec(sql);
  db.exec("CREATE TABLE fictional_knowledge_child(id TEXT PRIMARY KEY,input_id TEXT,workspace_id TEXT,model_id TEXT,FOREIGN KEY(input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id))");
  for (const version of [1,2,3]) db.prepare("INSERT INTO fictional_knowledge_child VALUES(?,?,'w','model')").run(`child-${version}`,`input-v${version}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => tables.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  return { directory, target, filename, db, snapshot, before: snapshot(), applied: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all() };
}

test('migration 54 preserves every populated old table, three input versions, rowids, dependent checkpoints and child FKs', t => {
  const f = fixture(t);
  assert.equal(migrateWorkbench(f.filename, { directory: f.target }).applied, 1); assert.equal(verifyWorkbenchSchema(f.db, f.target).version, 54);
  assert.deepEqual(f.snapshot(), f.before); assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=53 ORDER BY version').all(),f.applied);
  assert.equal(f.db.pragma('foreign_keys', { simple: true }),1); assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  assert.equal(f.db.pragma('integrity_check', { simple: true }),'ok');
  assert.match(f.db.prepare("SELECT sql FROM sqlite_master WHERE name='investor_monitor_evidence_inputs'").get().sql,/investor-monitor-data-input-v4/);
  assert.throws(() => f.db.exec("UPDATE investor_monitor_evidence_inputs SET content_hash='x'"),/immutable/);
  assert.throws(() => f.db.exec("DELETE FROM investor_monitor_evidence_inputs"),/immutable/);
  assert.throws(() => f.db.exec("INSERT INTO fictional_knowledge_child VALUES('bad','missing','w','model')"),/FOREIGN KEY/);
  assert.equal(migrateWorkbench(f.filename,{ directory:f.target }).applied,0); assert.deepEqual(f.snapshot(),f.before);
});

test('late FK corruption rolls back migration 54, all old bytes, rowids, constraints and applied checksums', t => {
  const f = fixture(t), schema = f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  const manifest = JSON.parse(readFileSync(join(f.target,'manifest.json'))), entry = manifest.migrations.at(-1);
  const sql = readFileSync(join(f.target,entry.file),'utf8') + "\nINSERT INTO fictional_knowledge_child VALUES('bad','missing','w','model');\n";
  writeFileSync(join(f.target,entry.file),sql); entry.sha256 = createHash('sha256').update(sql).digest('hex');
  writeFileSync(join(f.target,'manifest.json'),JSON.stringify(manifest));
  assert.throws(() => migrateWorkbench(f.filename,{ directory:f.target }),/WORKBENCH_FOREIGN_KEY_CHECK_FAILED/);
  assert.deepEqual(f.snapshot(),f.before); assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),f.applied);
  assert.equal(f.db.pragma('user_version',{ simple:true }),53); assert.equal(f.db.pragma('foreign_keys',{ simple:true }),1);
});
