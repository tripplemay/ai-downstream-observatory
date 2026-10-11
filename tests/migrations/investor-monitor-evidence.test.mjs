import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration 32 preserves populated version 31 model history and rowids without promoting synthetic inputs', t => {
  const directory = mkdtempSync(join(tmpdir(), 'investor-monitor-evidence-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix'); mkdirSync(prefix);
  for (const migration of manifest.migrations.slice(0, 31)) cpSync(join(migrationDirectory, migration.file), join(prefix, migration.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 31) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  const now = '2026-01-02T12:00:00.000Z', digest = 'a'.repeat(64);
  db.prepare("INSERT INTO investor_workspaces VALUES('w','fictional',0,?)").run(now);
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('a','fictional','investor_save_profile','investor_workspace','w','{}',?)").run(now);
  db.prepare("INSERT INTO investor_profiles VALUES('p','w',1,'{}',?,'fictional',?,'a')").run(digest, now);
  db.prepare("INSERT INTO investor_reference_plans VALUES('plan','w','p','{\"data_mode\":\"synthetic\"}',?,?)").run(digest, now);
  db.prepare("INSERT INTO investor_plan_selections VALUES('selection','w','plan','fictional',?,'a')").run(now);
  const definition = { model_id: 'model', profile_id: 'p', plan_id: 'plan', scope: 'research_model', data_mode: 'synthetic', created_at: now, live_advice_eligible: false, target_definition_hash: digest };
  db.prepare("INSERT INTO investor_models(rowid,id,workspace_id,profile_id,plan_id,selection_id,document_json,content_hash,created_at) VALUES(19,'model','w','p','plan','selection',?,?,?)").run(JSON.stringify(definition), digest, now);
  db.prepare("INSERT INTO investor_model_controls VALUES('control','w','model',1,1,'fictional','a',?)").run(now);
  db.prepare("INSERT INTO investor_model_inputs VALUES('input','w','model','synthetic_test_only',?,?,?)").run(JSON.stringify({ model_id: 'model', source_qualification: 'synthetic_test_only' }), digest, now);
  const checkpoint = { model_id: 'model', sequence: 1, previous_hash: null, input_hash: digest, created_at: now, data_mode: 'synthetic', live_advice_eligible: false };
  db.prepare("INSERT INTO investor_model_checkpoints(rowid,id,workspace_id,model_id,input_id,sequence,previous_hash,document_json,content_hash,created_at) VALUES(37,'checkpoint','w','model','input',1,NULL,?,?,?)").run(JSON.stringify(checkpoint), digest, now);
  db.prepare("INSERT INTO investor_monitor_requests VALUES('request','w','model','control','input','checkpoint','fictional-period',?,?,'{}',?)").run(digest, digest, now);
  db.prepare("INSERT INTO job_runs(id,job_type,scope,period,input_version,status,fencing_token,not_before,created_at,updated_at) VALUES('j','investor_monitor','w','request',?,'running',1,?,?,?)").run(digest, now, now, now);
  db.prepare("INSERT INTO investor_observations VALUES('o','w','p',NULL,'insufficient_evidence','{\"outcome\":\"insufficient_evidence\"}',?,?,?)").run(digest, digest, now);
  db.prepare("INSERT INTO investor_monitor_runs(rowid,id,workspace_id,model_id,request_id,job_id,observation_id,checkpoint_id,status,document_json,content_hash,created_at) VALUES(51,'run','w','model','request','j','o','checkpoint','synthetic_preview',?,?,?)")
    .run(JSON.stringify({ request_id: 'request', status: 'synthetic_preview', created_at: now }), digest, now);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrateWorkbench(filename); verifyWorkbenchSchema(db);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=31 ORDER BY version').all(), applied);
  assert.equal(db.prepare('SELECT count(*) n FROM investor_monitor_evidence_inputs').get().n, 0);
  const document = { schema_version: 'investor-monitor-data-input-v1', workspace_id: 'w', model_id: 'model', source_qualification: 'owner_reviewed_reconstructed',
    target_definition_hash: digest, segments: [{ snapshot: { mode: 'reconstructed', workspace_id: 'w', created_at: now } }], created_at: now, valid_until: '2027-01-01T00:00:00.000Z', live_advice_eligible: false };
  assert.throws(() => db.transaction(() => {
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('admit-audit','fictional','investor_admit_monitor_source','investor_monitor_evidence_input','admission',?,?)").run(JSON.stringify({ content_hash: digest }), now);
    db.prepare("INSERT INTO investor_monitor_evidence_inputs VALUES('admission','w','model','owner_reviewed_reconstructed',?,?,'fictional',?,?,'admit-audit')")
      .run(JSON.stringify(document), digest, now, document.valid_until);
  }).immediate(), /binding differs/);
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  const after = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(); migrateWorkbench(filename);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), after);
  assert.deepEqual(snapshot(), before);
});
