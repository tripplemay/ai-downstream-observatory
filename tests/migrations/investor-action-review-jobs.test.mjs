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
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'fictional-action-job-upgrade-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const manifest=JSON.parse(readFileSync(join(migrationDirectory,'manifest.json'),'utf8'));
  function copy(name,count){const target=join(directory,name);mkdirSync(target);
    for(const entry of manifest.migrations.slice(0,count))cpSync(join(migrationDirectory,entry.file),join(target,entry.file));
    writeFileSync(join(target,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,count)}));return target;}
  const prefix=copy('v55',55),target=copy('v56',56),filename=join(directory,'workbench.db');migrateWorkbench(filename,{directory:prefix});
  const child=spawnSync(process.env.WORKBENCH_TEST_PYTHON??'python3',['-c',`
import socket,sqlite3,sys
from pathlib import Path
from tests.investor.test_action_review_workflow import ActionReviewWorkflowTests
def forbidden(*a,**k):raise AssertionError('FICTIONAL_UPGRADE_NETWORK_FORBIDDEN')
socket.create_connection=forbidden;socket.getaddrinfo=forbidden
db=sqlite3.connect(sys.argv[1],isolation_level=None);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
try:
 db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
 case=ActionReviewWorkflowTests();case.db=db;case.path=Path(sys.argv[1]);case.retained_reports();case.witness();case.confirm()
finally:db.close()
`,filename],{cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:30000});assert.equal(child.status,0,child.stderr);
  const db=new Database(filename);db.pragma('foreign_keys=ON');t.after(()=>db.close());
  db.exec("CREATE TABLE fictional_job_child(id TEXT PRIMARY KEY,confirmation_id TEXT REFERENCES investor_action_review_confirmations(id));INSERT INTO fictional_job_child SELECT 'old',id FROM investor_action_review_confirmations");
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  const snapshot=()=>tables.map(name=>({name,rows:db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all()}));
  return {db,target,filename,snapshot,before:snapshot(),applied:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()};
}
test('migration56 preserves real fictional confirmed lineage, all prior rows/rowids/checksums and foreign references',t=>{
  const f=fixture(t);assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,1);assert.equal(verifyWorkbenchSchema(f.db,f.target).version,56);
  assert.deepEqual(f.snapshot(),f.before);assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=55 ORDER BY version').all(),f.applied);
  for(const table of ['investor_action_review_job_requests','investor_action_review_job_results'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);assert.equal(f.db.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,0);
});
test('late migration failure removes job tables and triggers without changing existing confirmations or migration identity',t=>{
  const f=fixture(t),schema=f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  const manifest=JSON.parse(readFileSync(join(f.target,'manifest.json'),'utf8')),entry=manifest.migrations.at(-1);
  const sql=readFileSync(join(f.target,entry.file),'utf8')+"\nINSERT INTO fictional_job_child VALUES('bad','missing');\n";
  writeFileSync(join(f.target,entry.file),sql);entry.sha256=createHash('sha256').update(sql).digest('hex');writeFileSync(join(f.target,'manifest.json'),JSON.stringify(manifest));
  assert.throws(()=>migrateWorkbench(f.filename,{directory:f.target}),/FOREIGN KEY/);
  assert.deepEqual(f.snapshot(),f.before);assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),f.applied);
  assert.equal(f.db.pragma('user_version',{simple:true}),55);assert.equal(f.db.pragma('foreign_keys',{simple:true}),1);
});
