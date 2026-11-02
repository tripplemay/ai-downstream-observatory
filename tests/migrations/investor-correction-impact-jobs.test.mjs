import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {migrateWorkbench,verifyWorkbenchSchema} from '../../scripts/migrate-workbench.mjs';
const require=createRequire(new URL('../../web/package.json',import.meta.url)),Database=require('better-sqlite3');
const source=new URL('../../migrations/',import.meta.url);
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'fictional-correction-upgrade-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const manifest=JSON.parse(readFileSync(new URL('manifest.json',source)));
  const copy=(name,count)=>{const target=join(directory,name);mkdirSync(target);for(const item of manifest.migrations.slice(0,count))cpSync(new URL(item.file,source),join(target,item.file));
    writeFileSync(join(target,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,count)}));return target;};
  const prefix=copy('v59',59),target=copy('v60',60),filename=join(directory,'workbench.db');migrateWorkbench(filename,{directory:prefix});
  const seeded=spawnSync(process.env.WORKBENCH_TEST_PYTHON||'python3',['-c',`
import sqlite3,socket,sys
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
 # Only the v60 discovery table is absent in the real v59 baseline.
 with patch('worker.investor.correction_impact_jobs.discover_correction_impact_requests',return_value=[]) as scan:
  case.prepare();case.admit();assert scan.call_count>0
finally:db.close()
`,filename],{cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:120000,maxBuffer:1048576});
  assert.equal(seeded.status,0,seeded.stderr);
  const db=new Database(filename);db.pragma('foreign_keys=ON');t.after(()=>db.close());
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  const snapshot=()=>tables.map(table=>({table,rows:db.prepare(`SELECT rowid _preserved_rowid,* FROM ${table} ORDER BY rowid`).all()}));
  assert.equal(db.prepare('SELECT count(*) n FROM investor_evidence_model_checkpoints').get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM investor_legacy_transition_admissions').get().n,1);
  const before=snapshot(),applied=db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  return {db,filename,target,before,applied,snapshot};
}
test('migration 60 adds only empty hypothesis job tables and preserves the actual original chain, source bytes, consents, rowids and old checksums',t=>{
  const f=fixture(t);assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,1);assert.equal(verifyWorkbenchSchema(f.db,f.target).version,60);
  assert.deepEqual(f.snapshot(),f.before);assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=59 ORDER BY version').all(),f.applied);
  for(const table of ['investor_correction_impact_requests','investor_correction_impact_results'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);assert.equal(f.db.pragma('integrity_check',{simple:true}),'ok');assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,0);
});
test('late migration 60 failure rolls back both new tables and guards with every old row, source payload and schema identity intact',t=>{
  const f=fixture(t),schema=f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),manifest=JSON.parse(readFileSync(join(f.target,'manifest.json'))),entry=manifest.migrations.at(-1);
  const sql=readFileSync(join(f.target,entry.file),'utf8')+"\nINSERT INTO investor_correction_impact_requests(id) VALUES('fictional-invalid');\n";
  writeFileSync(join(f.target,entry.file),sql);entry.sha256=createHash('sha256').update(sql).digest('hex');writeFileSync(join(f.target,'manifest.json'),JSON.stringify(manifest));
  assert.throws(()=>migrateWorkbench(f.filename,{directory:f.target}),/NOT NULL|binding differs/);
  assert.deepEqual(f.snapshot(),f.before);assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),f.applied);assert.equal(f.db.pragma('user_version',{simple:true}),59);
});
