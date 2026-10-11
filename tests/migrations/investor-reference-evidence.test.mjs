import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration 31 preserves populated legacy research, selections and rowids without granting them reconstructed provenance', t => {
  const directory = mkdtempSync(join(tmpdir(), 'investor-reference-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix'); mkdirSync(prefix);
  for (const migration of manifest.migrations.slice(0, 30)) cpSync(join(migrationDirectory, migration.file), join(prefix, migration.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 30) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  const now = '2026-01-02T12:00:00.000Z', digest = 'a'.repeat(64);
  db.prepare("INSERT INTO investor_workspaces VALUES('w','fictional',0,?)").run(now);
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('a','fictional','investor_save_profile','investor_workspace','w','{}',?)").run(now);
  db.prepare("INSERT INTO investor_profiles VALUES('p','w',1,'{}',?,'fictional',?,'a')").run(digest, now);
  db.prepare("INSERT INTO investor_reference_plans VALUES('plan','w','p','{\"data_mode\":\"synthetic\"}',?,?)").run(digest, now);
  db.prepare("INSERT INTO investor_plan_selections VALUES('selection','w','plan','fictional',?,'a')").run(now);
  db.prepare("INSERT INTO investor_research_requests(id,workspace_id,profile_id,input_version,document_json,created_at) VALUES('q','w','p',?,'{}',?)").run(digest, now);
  db.prepare("INSERT INTO job_runs(id,job_type,scope,period,input_version,status,fencing_token,not_before,created_at,updated_at) VALUES('j','investor_research','w','q',?,'running',1,?,?,?)").run(digest, now, now, now);
  db.prepare("INSERT INTO investor_observations VALUES('o','w','p',NULL,'insufficient_evidence','{\"outcome\":\"insufficient_evidence\"}',?,?,?)").run(digest, digest, now);
  db.prepare("INSERT INTO investor_research_runs(rowid,id,workspace_id,request_id,job_id,observation_id,status,document_json,content_hash,created_at) VALUES(19,'r','w','q','j','o','blocked',?,?,?)")
    .run(JSON.stringify({ status: 'blocked', request_id: 'q', created_at: now }), digest, now);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => tables.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrateWorkbench(filename); verifyWorkbenchSchema(db);
  assert.deepEqual(snapshot(), before); assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=30 ORDER BY version').all(), applied);
  assert.equal(db.prepare('SELECT count(*) n FROM investor_reference_evidence').get().n, 0);
  assert.throws(() => db.prepare("INSERT INTO investor_reference_evidence VALUES('plan','w','q','r','invented',?,?)").run(digest, now), /binding differs/);
  migrateWorkbench(filename); assert.deepEqual(snapshot(), before);
});
