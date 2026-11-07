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
  const directory=mkdtempSync(join(tmpdir(),'fictional-action-review-upgrade-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const manifest=JSON.parse(readFileSync(join(migrationDirectory,'manifest.json')));
  function copy(name,count) {
    const target=join(directory,name);mkdirSync(target);
    for(const entry of manifest.migrations.slice(0,count))cpSync(join(migrationDirectory,entry.file),join(target,entry.file));
    writeFileSync(join(target,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,count)}));return target;
  }
  const prefix=copy('v54',54),target=copy('v55',55),filename=join(directory,'workbench.db');migrateWorkbench(filename,{directory:prefix});
  const seeded=spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? 'python3',['-c',`
import socket,sqlite3,sys
from worker.investor.data_evidence import store_source,review_source
def forbidden(*a,**k):raise AssertionError('FICTIONAL_MIGRATION_NETWORK_FORBIDDEN')
socket.create_connection=forbidden;socket.getaddrinfo=forbidden
db=sqlite3.connect(sys.argv[1],isolation_level=None);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
try:
 db.execute("INSERT INTO investor_workspaces VALUES('w','fictional-owner',7,'2026-01-01T00:00:00.000Z')")
 source=store_source(db,'w','fictional-owner','actions',{'title':'FICTIONAL prior manual source','reference':'synthetic://prior-action-source','excerpt':'Component fixture only, not economic or provider qualification'},now='2026-01-02T00:00:00.000Z')
 review_source(db,'w','fictional-owner',source['id'],'approved',{'listing_id':'fictional-etf','range_start':'2026-01-01','range_end':'2026-01-03','coverage':'reviewed_complete','tax_assumption':'Fictional explicit assumption','events':[]},'Fictional prior manual review','2027-01-01T00:00:00.000Z',now='2026-01-03T00:00:00.000Z')
finally:db.close()
`,filename],{cwd:new URL('../../',import.meta.url),encoding:'utf8',timeout:30000});
  assert.equal(seeded.status,0,seeded.stderr);
  const db=new Database(filename);db.pragma('foreign_keys=ON');t.after(()=>db.close());
  db.exec("CREATE TABLE fictional_review_child(id TEXT PRIMARY KEY,workspace_id TEXT REFERENCES investor_workspaces(id));INSERT INTO fictional_review_child VALUES('old','w')");
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  const snapshot=()=>tables.map(name=>({name,rows:db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all()}));
  return {db,target,filename,snapshot,before:snapshot(),applied:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()};
}

test('migration 55 preserves every old row, rowid, manual source/review, audit, checksum and child reference',t=>{
  const f=fixture(t);assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,1);
  assert.equal(verifyWorkbenchSchema(f.db,f.target).version,55);assert.deepEqual(f.snapshot(),f.before);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=54 ORDER BY version').all(),f.applied);
  for(const table of ['investor_action_review_previews','investor_action_review_confirmations'])assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal(f.db.pragma('foreign_keys',{simple:true}),1);assert.deepEqual(f.db.pragma('foreign_key_check'),[]);assert.equal(f.db.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(migrateWorkbench(f.filename,{directory:f.target}).applied,0);assert.deepEqual(f.snapshot(),f.before);
});

test('a late failure rolls back both workflow tables, retirement guard, old rows and migration identity',t=>{
  const f=fixture(t),schema=f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  const manifest=JSON.parse(readFileSync(join(f.target,'manifest.json'))),entry=manifest.migrations.at(-1);
  const sql=readFileSync(join(f.target,entry.file),'utf8')+"\nINSERT INTO fictional_review_child VALUES('bad','missing');\n";
  writeFileSync(join(f.target,entry.file),sql);entry.sha256=createHash('sha256').update(sql).digest('hex');writeFileSync(join(f.target,'manifest.json'),JSON.stringify(manifest));
  assert.throws(()=>migrateWorkbench(f.filename,{directory:f.target}),/FOREIGN KEY/);
  assert.deepEqual(f.snapshot(),f.before);assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),f.applied);
  assert.equal(f.db.pragma('user_version',{simple:true}),54);assert.equal(f.db.pragma('foreign_keys',{simple:true}),1);
});
