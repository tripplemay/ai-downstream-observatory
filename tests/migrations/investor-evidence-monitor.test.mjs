import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration 33 preserves populated version 32 legacy research state, rowids and checksums without fabricating qualified runs', t => {
  const directory = mkdtempSync(join(tmpdir(), 'investor-evidence-monitor-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix'); mkdirSync(prefix);
  for (const migration of manifest.migrations.slice(0, 32)) cpSync(join(migrationDirectory, migration.file), join(prefix, migration.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 32) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  const now = '2026-01-02T12:00:00.000Z', digest = 'a'.repeat(64);
  db.prepare("INSERT INTO investor_workspaces VALUES('w','fictional',0,?)").run(now);
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('a','fictional','investor_save_profile','investor_workspace','w','{}',?)").run(now);
  db.prepare("INSERT INTO investor_profiles(rowid,id,workspace_id,version,document_json,content_hash,actor_id,created_at,audit_id) VALUES(9,'p','w',1,'{}',?,'fictional',?,'a')").run(digest, now);
  db.prepare("INSERT INTO investor_reference_plans VALUES('plan','w','p','{\"data_mode\":\"synthetic\"}',?,?)").run(digest, now);
  db.prepare("INSERT INTO investor_plan_selections VALUES('selection','w','plan','fictional',?,'a')").run(now);
  const definition = { model_id: 'model', profile_id: 'p', plan_id: 'plan', scope: 'research_model', data_mode: 'synthetic', created_at: now, live_advice_eligible: false, target_definition_hash: digest };
  db.prepare("INSERT INTO investor_models(rowid,id,workspace_id,profile_id,plan_id,selection_id,document_json,content_hash,created_at) VALUES(19,'model','w','p','plan','selection',?,?,?)").run(JSON.stringify(definition), digest, now);
  db.prepare("INSERT INTO investor_model_controls VALUES('control','w','model',1,1,'fictional','a',?)").run(now);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrateWorkbench(filename); verifyWorkbenchSchema(db);
  assert.deepEqual(snapshot(), before); assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=32 ORDER BY version').all(), applied);
  for (const name of ['investor_evidence_model_checkpoints', 'investor_evidence_checkpoint_payloads', 'investor_evidence_monitor_requests', 'investor_evidence_monitor_runs', 'investor_evidence_run_payloads', 'investor_monitor_payload_purges'])
    assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get().n, 0);
  assert.throws(() => db.prepare("INSERT INTO investor_evidence_checkpoint_payloads VALUES('foreign',x'7b7d')").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO investor_monitor_payload_purges VALUES('run','foreign','w','model','retention_expired','foreign',?,'a')").run(now), /binding differs/);
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  migrateWorkbench(filename); assert.deepEqual(snapshot(), before);
});
