import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { migrateWorkbench, migrationDirectory, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require=createRequire(new URL('../../web/package.json',import.meta.url)),Database=require('better-sqlite3');
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'fictional-legacy-source-upgrade-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const manifest=JSON.parse(readFileSync(join(migrationDirectory,'manifest.json')));
  function copy(name,count) {
    const target=join(directory,name);mkdirSync(target);
    for(const entry of manifest.migrations.slice(0,count))cpSync(join(migrationDirectory,entry.file),join(target,entry.file));
    writeFileSync(join(target,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,count)}));return target;
  }
  const prefix=copy('v57',57),target=copy('v58',58),filename=join(directory,'workbench.db');migrateWorkbench(filename,{directory:prefix});
  const seeded=spawnSync(process.env.WORKBENCH_TEST_PYTHON||'python3',['-c',`
import socket,sqlite3,sys
from pathlib import Path
from unittest.mock import patch
from tests.investor.test_legacy_transition_source import LegacyTransitionSourceTests
from tests.investor.test_action_review_readmission import ActionReviewReadmissionTests
from tests.investor.test_action_review_workflow import ActionReviewWorkflowTests
def denied(*a,**k):raise AssertionError('FICTIONAL_MIGRATION_NETWORK_FORBIDDEN')
socket.create_connection=denied;socket.getaddrinfo=denied
db=sqlite3.connect(sys.argv[1],isolation_level=None);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
try:
 db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
 case=LegacyTransitionSourceTests();case.db=db;case.at='2026-11-03T06:00:04.002Z';case.case=ActionReviewReadmissionTests();case.case.db=db
 case.case.case=ActionReviewWorkflowTests();case.case.case.db=db;case.case.case.path=Path(sys.argv[1]);case.case.case.version=0
 # The predecessor schema has no v58 discovery table. Only omit that new scan;
 # actual admission, raw source checks, workers and checkpoint arithmetic remain.
 with patch('worker.investor.confirmed_feed.refresh_monitor_sources',return_value=[]) as next_version_scan:
  case.prepare()
  assert next_version_scan.call_count==2
finally:db.close()
`,filename],{cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
  assert.equal(seeded.status,0,seeded.stderr);
  const db=new Database(filename);db.pragma('foreign_keys=ON');t.after(()=>db.close());
  assert.equal(db.pragma('user_version',{simple:true}),57);
  assert.equal(db.prepare('SELECT count(*) n FROM investor_legacy_transition_confirmations').get().n,1);
  db.exec("CREATE TABLE fictional_transition_child(id TEXT PRIMARY KEY,input_id TEXT,workspace_id TEXT,model_id TEXT,FOREIGN KEY(input_id,workspace_id,model_id) REFERENCES investor_monitor_evidence_inputs(id,workspace_id,model_id))");
  db.exec("INSERT INTO fictional_transition_child SELECT 'old',id,workspace_id,model_id FROM investor_monitor_evidence_inputs ORDER BY created_at LIMIT 1");
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  const snapshot=()=>tables.map(name=>({name,rows:db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all()}));
  return {db,target,filename,snapshot,before:snapshot(),applied:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()};
}

test('migration 58 preserves actual v57 legacy sources, complete checkpoints, confirmation/witness references, all rowids and checksums',t=>{
  const f=fixture(t);assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,1);
  assert.equal(verifyWorkbenchSchema(f.db,f.target).version,58);assert.deepEqual(f.snapshot(),f.before);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=57 ORDER BY version').all(),f.applied);
  assert.equal(f.db.prepare('SELECT count(*) n FROM investor_legacy_transition_admissions').get().n,0);
  assert.equal(f.db.pragma('foreign_keys',{simple:true}),1);assert.deepEqual(f.db.pragma('foreign_key_check'),[]);assert.equal(f.db.pragma('integrity_check',{simple:true}),'ok');
  assert.throws(()=>f.db.exec("UPDATE investor_monitor_evidence_inputs SET actor_id='other'"),/immutable/);
  assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,0);assert.deepEqual(f.snapshot(),f.before);
});

test('late FK corruption restores the actual v57 input table, new immutable receipts, constraints and migration identity atomically',t=>{
  const f=fixture(t),schema=f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  const manifest=JSON.parse(readFileSync(join(f.target,'manifest.json'))),entry=manifest.migrations.at(-1);
  const sql=readFileSync(join(f.target,entry.file),'utf8')+"\nINSERT INTO fictional_transition_child VALUES('bad','missing','w','fictional-action-refresh');\n";
  writeFileSync(join(f.target,entry.file),sql);entry.sha256=createHash('sha256').update(sql).digest('hex');writeFileSync(join(f.target,'manifest.json'),JSON.stringify(manifest));
  assert.throws(()=>migrateWorkbench(f.filename,{directory:f.target}),/FOREIGN[_ ]KEY/);
  assert.deepEqual(f.snapshot(),f.before);assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),f.applied);
  assert.equal(f.db.pragma('user_version',{simple:true}),57);assert.equal(f.db.pragma('foreign_keys',{simple:true}),1);
});
