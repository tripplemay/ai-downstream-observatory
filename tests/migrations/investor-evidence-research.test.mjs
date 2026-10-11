import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration 30 preserves populated registry rowid gaps, historical request columns and exposure watermark', t => {
  const directory = mkdtempSync(join(tmpdir(), 'investor-evidence-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(migrationDirectory, 'manifest.json'))), prefix = join(directory, 'prefix');
  mkdirSync(prefix);
  for (const migration of manifest.migrations.slice(0, 29)) cpSync(join(migrationDirectory, migration.file), join(prefix, migration.file));
  writeFileSync(join(prefix, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 29) }));
  const filename = join(directory, 'workbench.db'); migrateWorkbench(filename, { directory: prefix });
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  const now = '2026-01-02T12:00:00.000Z', digest = 'a'.repeat(64), parameters = 'b'.repeat(64);
  db.prepare("INSERT INTO investor_workspaces VALUES('w','fictional',0,?)").run(now);
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('a','fictional','investor_save_profile','investor_workspace','w','{}',?)").run(now);
  db.prepare("INSERT INTO investor_profiles VALUES('p','w',1,'{}',?,'fictional',?,'a')").run(digest, now);
  db.prepare("INSERT INTO investor_research_inputs VALUES('i','w','synthetic_test_only','{}',?,?)").run(digest, now);
  db.prepare("INSERT INTO investor_research_requests VALUES('q','w','p','i',?,'{}',?)").run(digest, now);
  db.prepare("INSERT INTO job_runs(id,job_type,scope,period,input_version,status,fencing_token,not_before,created_at,updated_at) VALUES('j','investor_research','w','q',?,'running',1,?,?,?)").run(digest, now, now, now);
  const experiment = { experiment_id: 'e', request_id: 'q', workspace_id: 'w', input_version: digest,
    implementation_hash: digest, created_at: now, source_qualification: 'synthetic_test_only', live_advice_eligible: false,
    candidate_hashes: [parameters], trial_budgets: { train: 1, validation: 1, holdout: 1 } };
  db.prepare("INSERT INTO investor_experiments(rowid,id,workspace_id,request_id,implementation_hash,document_json,content_hash,created_at) VALUES(31,'e','w','q',?,?,?,?)").run(digest, JSON.stringify(experiment), digest, now);
  for (const [index, phase] of ['train', 'validation', 'holdout'].entries()) {
    db.prepare("INSERT INTO investor_trial_intents(rowid,id,experiment_id,phase,parameters_hash,window_start_us,window_end_us,job_id,fencing_token,created_at) VALUES(?,?,'e',?,?,1,2,'j',1,?)").run([3, 9, 17][index], phase, phase, parameters, now);
    db.prepare("INSERT INTO investor_trial_results(rowid,trial_id,document_json,content_hash,job_id,fencing_token,created_at) VALUES(?,?,?,?, 'j',1,?)").run([7, 19, 37][index], phase, JSON.stringify({ phase }), digest, now);
    if (phase === 'train') {
      db.prepare("INSERT INTO investor_candidate_freezes(rowid,experiment_id,parameters_hash,evidence_json,content_hash,job_id,fencing_token,created_at) VALUES(43,'e',?,?,?,'j',1,?)")
        .run(parameters, JSON.stringify({ experiment_id: 'e', parameters_hash: parameters, selection_basis: 'train_only' }), digest, now);
    }
  }
  db.prepare("INSERT INTO investor_observations VALUES('o','w','p',NULL,'insufficient_evidence','{\"outcome\":\"insufficient_evidence\"}',?,?,?)").run(digest, digest, now);
  db.prepare("INSERT INTO investor_research_runs VALUES('r','w','q','j','o','calculated',?,?,?)")
    .run(JSON.stringify({ status: 'calculated', request_id: 'q', created_at: now, registry: { exposure_watermark: 17 } }), digest, now);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => ({ name: row.name, columns: db.prepare(`PRAGMA table_info(${row.name})`).all().map(value => value.name) }));
  const snapshot = () => tables.map(({ name, columns }) => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,${columns.join(',')} FROM ${name} ORDER BY rowid`).all() }));
  const before = snapshot(), applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  migrateWorkbench(filename); verifyWorkbenchSchema(db);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=29 ORDER BY version').all(), applied);
  assert.deepEqual(db.prepare('SELECT rowid FROM investor_trial_intents ORDER BY rowid').all(), [{ rowid: 3 }, { rowid: 9 }, { rowid: 17 }]);
  assert.equal(JSON.parse(db.prepare('SELECT document_json FROM investor_research_runs').get().document_json).registry.exposure_watermark, 17);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  for (const table of ['investor_experiments', 'investor_trial_intents', 'investor_trial_results', 'investor_candidate_freezes']) {
    assert.throws(() => db.prepare(`UPDATE ${table} SET created_at=?`).run(now), /immutable/);
    assert.throws(() => db.prepare(`DELETE FROM ${table}`).run(), /immutable/);
  }
  migrateWorkbench(filename); assert.deepEqual(snapshot(), before);
});
