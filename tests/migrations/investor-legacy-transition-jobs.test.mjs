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
  const directory=mkdtempSync(join(tmpdir(),'fictional-legacy-job-upgrade-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const manifest=JSON.parse(readFileSync(join(migrationDirectory,'manifest.json')));
  function copy(name,count) {
    const target=join(directory,name);mkdirSync(target);
    for(const entry of manifest.migrations.slice(0,count))cpSync(join(migrationDirectory,entry.file),join(target,entry.file));
    writeFileSync(join(target,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,count)}));return target;
  }
  const prefix=copy('v58',58),target=copy('v59',59),filename=join(directory,'workbench.db');migrateWorkbench(filename,{directory:prefix});
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
 # Only the newly introduced v59 scan is absent from the real v58 baseline.
 with patch('worker.investor.legacy_transition_jobs.discover_legacy_transition_requests',return_value=[]) as scan:
  case.prepare();case.admit();assert scan.call_count==2
finally:db.close()
`,filename],{cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
  assert.equal(seeded.status,0,seeded.stderr);
  const db=new Database(filename);db.pragma('foreign_keys=ON');t.after(()=>db.close());
  assert.equal(db.prepare('SELECT count(*) n FROM investor_legacy_transition_admissions').get().n,1);
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  const snapshot=()=>tables.map(name=>({name,rows:db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all()}));
  return {db,target,filename,snapshot,before:snapshot(),applied:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()};
}
test('migration 59 adds only empty explicit job tables and preserves actual consent/source/checkpoints, all rowids and prior checksums',t=>{
  const f=fixture(t);assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,1);
  assert.equal(verifyWorkbenchSchema(f.db,f.target).version,59);assert.deepEqual(f.snapshot(),f.before);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=58 ORDER BY version').all(),f.applied);
  for(const name of ['investor_legacy_transition_job_requests','investor_legacy_transition_job_results'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${name}`).get().n,0);
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);assert.equal(f.db.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,0);assert.deepEqual(f.snapshot(),f.before);
});
test('late migration failure atomically removes both new tables and guards without changing existing source/consent or schema identity',t=>{
  const f=fixture(t),schema=f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  const manifest=JSON.parse(readFileSync(join(f.target,'manifest.json'))),entry=manifest.migrations.at(-1);
  const sql=readFileSync(join(f.target,entry.file),'utf8')+"\nINSERT INTO investor_legacy_transition_job_requests(id) VALUES('fictional-invalid');\n";
  writeFileSync(join(f.target,entry.file),sql);entry.sha256=createHash('sha256').update(sql).digest('hex');writeFileSync(join(f.target,'manifest.json'),JSON.stringify(manifest));
  assert.throws(()=>migrateWorkbench(f.filename,{directory:f.target}),/NOT NULL|binding differs/);
  assert.deepEqual(f.snapshot(),f.before);assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),f.applied);
  assert.equal(f.db.pragma('user_version',{simple:true}),58);assert.equal(f.db.pragma('foreign_keys',{simple:true}),1);
});
