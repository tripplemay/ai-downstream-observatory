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
 const directory=mkdtempSync(join(tmpdir(),'fictional-corrected-handover-upgrade-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const manifest=JSON.parse(readFileSync(new URL('manifest.json',source))),copy=(name,count)=>{const target=join(directory,name);mkdirSync(target);
  for(const item of manifest.migrations.slice(0,count))cpSync(new URL(item.file,source),join(target,item.file));
  writeFileSync(join(target,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,count)}));return target;};
 const prefix=copy('v63',63),target=copy('v64',64),filename=join(directory,'workbench.db');migrateWorkbench(filename,{directory:prefix});
 const seeded=spawnSync(process.env.WORKBENCH_TEST_PYTHON||'python3',['-c',`
import sqlite3,sys,json
from pathlib import Path
from unittest.mock import patch
from tests.investor.test_corrected_action_handover import CorrectedActionHandoverTests
from worker.orchestration.db import ROOT
db=sqlite3.connect(sys.argv[1],isolation_level=None);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
case=CorrectedActionHandoverTests();case.db=db;case.path=Path(sys.argv[1])
def original_readonly(path,*,read_only=False):
 assert read_only is True
 reader=sqlite3.connect(Path(path).as_uri()+'?mode=ro',uri=True,isolation_level=None);reader.row_factory=sqlite3.Row
 reader.execute('PRAGMA foreign_keys=ON');reader.execute('PRAGMA query_only=ON')
 expected=json.loads((ROOT/'migrations/manifest.json').read_text())['migrations'][:63]
 assert reader.execute('PRAGMA user_version').fetchone()[0]==63
 assert [tuple(r) for r in reader.execute('SELECT version,checksum FROM schema_migrations ORDER BY version')]==[(r['version'],r['sha256']) for r in expected]
 return reader
try:
 db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
 with patch('tests.investor.test_legacy_protocol_matrix.open_database',side_effect=original_readonly):case.prepared()
 assert db.execute('SELECT count(*) FROM investor_correction_consents').fetchone()[0]==1
finally:case.doCleanups();db.close()
`,filename],{cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:120000,maxBuffer:1048576});
 assert.equal(seeded.status,0,seeded.stderr);
 const db=new Database(filename);db.pragma('foreign_keys=ON');t.after(()=>db.close());
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
 const snapshot=()=>tables.map(table=>({table,rows:db.prepare(`SELECT rowid _preserved_rowid,* FROM ${table} ORDER BY rowid`).all()}));
 return {db,filename,target,snapshot,before:snapshot(),applied:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()};
}
test('migration64 preserves a real fictional confirmed correction, all old jobs/source lineages/checkpoints and rowids without manufacturing handover',t=>{
 const f=fixture(t);assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,1);assert.equal(verifyWorkbenchSchema(f.db,f.target).version,64);
 assert.deepEqual(f.snapshot(),f.before);assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=63 ORDER BY version').all(),f.applied);
 assert.deepEqual(f.db.pragma('foreign_key_check'),[]);assert.equal(f.db.pragma('integrity_check',{simple:true}),'ok');assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,0);
});
test('late migration64 failure restores every old table/guard, rowid, consent, source lineage, job and checksum',t=>{
 const f=fixture(t),schema=f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),manifest=JSON.parse(readFileSync(join(f.target,'manifest.json'))),entry=manifest.migrations.at(-1);
 const sql=readFileSync(join(f.target,entry.file),'utf8')+"\nINSERT INTO investor_action_review_confirmations(id) VALUES('fictional-invalid');\n";
 writeFileSync(join(f.target,entry.file),sql);entry.sha256=createHash('sha256').update(sql).digest('hex');writeFileSync(join(f.target,'manifest.json'),JSON.stringify(manifest));
 assert.throws(()=>migrateWorkbench(f.filename,{directory:f.target}),/NOT NULL|binding differs/);
 assert.deepEqual(f.snapshot(),f.before);assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema);
 assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),f.applied);assert.equal(f.db.pragma('user_version',{simple:true}),63);
});
