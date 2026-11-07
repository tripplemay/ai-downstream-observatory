import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {migrateWorkbench,verifyWorkbenchSchema} from '../../scripts/migrate-workbench.mjs';
const require=createRequire(new URL('../../web/package.json',import.meta.url)),Database=require('better-sqlite3'),source=new URL('../../migrations/',import.meta.url);
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'fictional-unchanged-recovery-upgrade-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const manifest=JSON.parse(readFileSync(new URL('manifest.json',source))),copy=(name,count)=>{const target=join(directory,name);mkdirSync(target);
  for(const item of manifest.migrations.slice(0,count))cpSync(new URL(item.file,source),join(target,item.file));
  writeFileSync(join(target,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,count)}));return target;};
 const prefix=copy('v61',61),target=copy('v62',62),filename=join(directory,'workbench.db');migrateWorkbench(filename,{directory:prefix});
 const seeded=spawnSync(process.env.WORKBENCH_TEST_PYTHON||'python3',['-c',`
import sqlite3,socket,sys
from pathlib import Path
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
 case.prepare();case.admit()
 from worker.investor import action_review_jobs as jobs
 latest=db.execute("SELECT document_json FROM investor_action_review_confirmations ORDER BY rowid DESC LIMIT 1").fetchone()[0]
 import json
 authority=json.loads(latest)['new_authority_id'];revision=db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
 jobs.enqueue_action_review_request(db,'w','synthetic-investor','preview',{'authority_id':authority,'expected_revision':revision,'idempotency_key':'fictional-retained-v1-request'},now=case.at)
finally:db.close()
`,filename],{cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:120000,maxBuffer:1048576});
 assert.equal(seeded.status,0,seeded.stderr);
 const db=new Database(filename);db.pragma('foreign_keys=ON');t.after(()=>db.close());db.exec("CREATE TABLE fictional_recovery_fk(id TEXT PRIMARY KEY,workspace TEXT REFERENCES investor_workspaces(id));INSERT INTO fictional_recovery_fk VALUES('old','w')");
 db.exec("CREATE TABLE fictional_recovery_links(id TEXT PRIMARY KEY,confirmation_id TEXT,request_id TEXT,workspace_id TEXT,FOREIGN KEY(confirmation_id,workspace_id) REFERENCES investor_action_review_confirmations(id,workspace_id),FOREIGN KEY(request_id,workspace_id) REFERENCES investor_action_review_job_requests(id,workspace_id));INSERT INTO fictional_recovery_links SELECT 'old',c.id,r.id,'w' FROM investor_action_review_confirmations c,investor_action_review_job_requests r LIMIT 1");
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
 const snapshot=()=>tables.map(table=>({table,rows:db.prepare(`SELECT rowid _preserved_rowid,* FROM ${table} ORDER BY rowid`).all()}));
 assert.equal(db.prepare('SELECT count(*) n FROM investor_evidence_model_checkpoints').get().n,1);
 assert.equal(db.prepare('SELECT count(*) n FROM investor_legacy_transition_admissions').get().n,1);
 return {db,filename,target,snapshot,before:snapshot(),applied:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()};
}
test('migration62 preserves old v1 confirmation, pending v1 intent, source bytes, checkpoints, rowids and checksums',t=>{
 const f=fixture(t);assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,1);assert.equal(verifyWorkbenchSchema(f.db,f.target).version,62);
 assert.deepEqual(f.snapshot(),f.before);assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=61 ORDER BY version').all(),f.applied);
 assert.equal(f.db.prepare("SELECT count(*) n FROM investor_action_review_confirmations WHERE json_extract(document_json,'$.schema_version')='investor-action-review-confirmation-v1'").get().n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM investor_action_review_job_requests WHERE json_extract(document_json,'$.schema_version')='investor-action-review-job-request-v1'").get().n,1);
 assert.deepEqual(f.db.pragma('foreign_key_check'),[]);assert.equal(f.db.pragma('integrity_check',{simple:true}),'ok');assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,0);
});
test('late migration62 failure rolls back both rebuilt tables, original v1 requests, rows and immutable guards',t=>{
 const f=fixture(t),schema=f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),manifest=JSON.parse(readFileSync(join(f.target,'manifest.json'))),entry=manifest.migrations.at(-1);
 const sql=readFileSync(join(f.target,entry.file),'utf8')+"\nINSERT INTO fictional_recovery_fk VALUES('bad','missing');\n";
 writeFileSync(join(f.target,entry.file),sql);entry.sha256=createHash('sha256').update(sql).digest('hex');writeFileSync(join(f.target,'manifest.json'),JSON.stringify(manifest));
 assert.throws(()=>migrateWorkbench(f.filename,{directory:f.target}),/WORKBENCH_FOREIGN_KEY_CHECK_FAILED/);
 assert.deepEqual(f.snapshot(),f.before);assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema);
 assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),f.applied);assert.equal(f.db.pragma('user_version',{simple:true}),61);
});
