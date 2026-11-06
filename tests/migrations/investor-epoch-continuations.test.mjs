import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateWorkbench, verifyWorkbenchSchema } from '../../scripts/migrate-workbench.mjs';

const require = createRequire(new URL('../../web/package.json', import.meta.url)), Database = require('better-sqlite3');
test('migration66 rolls back late failure, then preserves a real v65 epoch and every old row/checksum without manufacturing activation or continuation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-epoch-continuation-upgrade-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = new URL('../../migrations/', import.meta.url), manifest = JSON.parse(readFileSync(new URL('manifest.json', source)));
  function copy(name, count) {
    const target = join(directory, name); mkdirSync(target);
    for (const entry of manifest.migrations.slice(0, count)) cpSync(new URL(entry.file, source), join(target, entry.file));
    writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, count) })); return target;
  }
  const prefix = copy('v65', 65), target = copy('v66', 66), filename = join(directory, 'workbench.db');
  migrateWorkbench(filename, { directory: prefix });
  const seeded = spawnSync(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-c', `
import sqlite3,sys,json
from pathlib import Path
from unittest.mock import patch
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.epoch_registration_fixture import create
from worker.orchestration.db import ROOT
def original_readonly(path,*,read_only=False):
 assert read_only is True
 reader=sqlite3.connect(Path(path).as_uri()+'?mode=ro',uri=True,isolation_level=None);reader.row_factory=sqlite3.Row
 reader.execute('PRAGMA foreign_keys=ON');reader.execute('PRAGMA query_only=ON')
 expected=json.loads((ROOT/'migrations/manifest.json').read_text())['migrations'][:65]
 assert reader.execute('PRAGMA user_version').fetchone()[0]==65
 assert [tuple(r) for r in reader.execute('SELECT version,checksum FROM schema_migrations ORDER BY version')]==[(r['version'],r['sha256']) for r in expected]
 return reader
db=sqlite3.connect(sys.argv[1],isolation_level=None);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
try:
 with offline_protocol_fixture(),patch('tests.investor.test_legacy_protocol_matrix.open_database',side_effect=original_readonly):create(db,Path(sys.argv[1]))
 assert db.execute('SELECT COUNT(*) FROM investor_model_epochs').fetchone()[0]==1
 assert db.execute('SELECT COUNT(*) FROM investor_evidence_model_checkpoints').fetchone()[0]==3
finally:db.close()
`, filename], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 120000, maxBuffer: 1048576 });
  assert.ok(!seeded.error, seeded.error?.code); assert.equal(seeded.status, 0, seeded.stderr);
  const db = new Database(filename); t.after(() => db.close()); db.pragma('foreign_keys=ON');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const snapshot = () => tables.map(table => ({ table, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${table} ORDER BY rowid`).all() }));
  const before = snapshot(), schema = db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  const original = readFileSync(join(target, manifest.migrations[65].file), 'utf8'), entry = { ...manifest.migrations[65] };
  const invalid = original + "\nINSERT INTO investor_epoch_controls(id) VALUES('fictional-late-invalid');\n";
  writeFileSync(join(target, entry.file), invalid); entry.sha256 = createHash('sha256').update(invalid).digest('hex');
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: [...manifest.migrations.slice(0, 65), entry] }));
  assert.throws(() => migrateWorkbench(filename, { directory: target }), /NOT NULL|binding differs/);
  assert.deepEqual(snapshot(), before); assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(), schema);
  assert.equal(db.pragma('user_version', { simple: true }), 65);
  writeFileSync(join(target, entry.file), original); writeFileSync(join(target, 'manifest.json'), JSON.stringify({ ...manifest, migrations: manifest.migrations.slice(0, 66) }));
  assert.equal(migrateWorkbench(filename, { directory: target }).applied, 1);
  assert.equal(verifyWorkbenchSchema(db, target).version, 66);
  assert.deepEqual(snapshot().filter(row => row.table !== 'schema_migrations'), before.filter(row => row.table !== 'schema_migrations'));
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=65 ORDER BY version').all(), before.find(row => row.table === 'schema_migrations').rows.map(({ _preserved_rowid, ...row }) => row));
  for (const table of ['investor_epoch_controls', 'investor_epoch_continuation_requests', 'investor_epoch_continuations'])
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ' + table).get().n, 0);
  const input = db.prepare("SELECT * FROM investor_monitor_evidence_inputs WHERE json_extract(document_json,'$.schema_version')='investor-monitor-data-input-v6'").get();
  const current = snapshot();
  for (const version of ['investor-monitor-data-input-v6', 'investor-monitor-data-input-v4']) {
    const document = JSON.parse(input.document_json), at = '2026-10-20T10:00:03.001Z';
    document.schema_version = version; document.created_at = at;
    for (const segment of document.segments) segment.snapshot.created_at = at;
    if (version.endsWith('v4')) {
      document.projection_hash = document.audited_projection_hash; document.valid_until = document.audited_valid_until;
      for (const key of ['epoch', 'audited_projection_hash', 'audited_valid_until', 'carry_hash', 'carry_count', 'funding_binding', 'funding_context_hash']) delete document[key];
    }
    const raw = JSON.stringify(document), hash = createHash('sha256').update(raw).digest('hex');
    const attempt = db.transaction(() => {
      db.prepare(`INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at)
        VALUES('fictional-unregistered-epoch-audit',?,'investor_admit_monitor_source','investor_monitor_evidence_input','fictional-unregistered-epoch-input',?,?)`)
        .run(input.actor_id, JSON.stringify({ content_hash: hash }), at);
      db.prepare(`INSERT INTO investor_monitor_evidence_inputs VALUES('fictional-unregistered-epoch-input',?,?,'owner_reviewed_reconstructed',?,?,?,?,?,'fictional-unregistered-epoch-audit')`)
        .run(input.workspace_id, input.model_id, raw, hash, input.actor_id, at, document.valid_until);
    });
    assert.throws(attempt, /registered epoch requires its own continuation protocol/);
    assert.deepEqual(snapshot(), current);
  }
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(migrateWorkbench(filename, { directory: target }).applied, 0);
  const v67=copy('v67',67),next={...manifest.migrations[66]},original67=readFileSync(join(v67,next.file),'utf8');
  const oldRows=snapshot(),oldSchema=db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  const invalid67=original67+"\nINSERT INTO investor_epoch_control_requests(id) VALUES('fictional-late-owner-failure');\n";
  writeFileSync(join(v67,next.file),invalid67);next.sha256=createHash('sha256').update(invalid67).digest('hex');
  writeFileSync(join(v67,'manifest.json'),JSON.stringify({...manifest,migrations:[...manifest.migrations.slice(0,66),next]}));
  assert.throws(()=>migrateWorkbench(filename,{directory:v67}),/NOT NULL|binding differs/);
  assert.deepEqual(snapshot(),oldRows);assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),oldSchema);
  writeFileSync(join(v67,next.file),original67);writeFileSync(join(v67,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,67)}));
  assert.equal(migrateWorkbench(filename,{directory:v67}).applied,1);assert.equal(verifyWorkbenchSchema(db,v67).version,67);
  assert.deepEqual(snapshot().filter(row=>row.table!=='schema_migrations'),oldRows.filter(row=>row.table!=='schema_migrations'));
  for(const name of ['investor_epoch_control_requests','investor_epoch_control_results'])assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get().n,0);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  const notice=db.prepare(`SELECT o.id,r.id publication_id,r.workspace_id,r.model_id,r.observation_id,r.created_at published_at,r.status,w.owner_id
    FROM investor_evidence_monitor_runs r JOIN outbox o ON o.dedup_key='investor-monitor:' || r.id JOIN investor_workspaces w ON w.id=r.workspace_id
    ORDER BY r.created_at,r.id LIMIT 1`).get();assert.ok(notice);
  const identity={id:notice.id,publication_id:notice.publication_id,workspace_id:notice.workspace_id,model_id:notice.model_id,
    observation_id:notice.observation_id,recorded_outcome:notice.status==='blocked'?'insufficient_evidence':notice.status,published_at:notice.published_at};
  const noticeHash=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(identity).sort(([a],[b])=>a<b?-1:a>b?1:0)))).digest('hex');
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('fictional-existing-notice-read',?,'investor_notification_read','investor_notification',?,?,?)")
    .run(notice.owner_id,notice.id,JSON.stringify({workspace_id:notice.workspace_id,publication_hash:noticeHash}),notice.published_at);
  const allTables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  const fullSnapshot=()=>allTables.map(table=>({table,rows:db.prepare(`SELECT rowid _preserved_rowid,* FROM ${table} ORDER BY rowid`).all()}));
  const before68=fullSnapshot(),schema67=db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),v68=copy('v68',68);
  const entry68={...manifest.migrations[67]},sql68=readFileSync(join(v68,entry68.file),'utf8');
  const bad68=sql68+"\nINSERT INTO audit_events(id) VALUES('fictional-late-notification-upgrade');\n";
  writeFileSync(join(v68,entry68.file),bad68);entry68.sha256=createHash('sha256').update(bad68).digest('hex');
  writeFileSync(join(v68,'manifest.json'),JSON.stringify({...manifest,migrations:[...manifest.migrations.slice(0,67),entry68]}));
  assert.throws(()=>migrateWorkbench(filename,{directory:v68}),/NOT NULL/);
  assert.deepEqual(fullSnapshot(),before68);assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema67);
  assert.equal(db.pragma('user_version',{simple:true}),67);
  writeFileSync(join(v68,entry68.file),sql68);writeFileSync(join(v68,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,68)}));
  assert.equal(migrateWorkbench(filename,{directory:v68}).applied,1);assert.equal(verifyWorkbenchSchema(db,v68).version,68);
  assert.deepEqual(fullSnapshot().filter(row=>row.table!=='schema_migrations'),before68.filter(row=>row.table!=='schema_migrations'));
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=67 ORDER BY version').all(),before68.find(row=>row.table==='schema_migrations').rows.map(({_preserved_rowid,...row})=>row));
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name),allTables);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(migrateWorkbench(filename,{directory:v68}).applied,0);assert.deepEqual(fullSnapshot().filter(row=>row.table!=='schema_migrations'),before68.filter(row=>row.table!=='schema_migrations'));
  const before69=fullSnapshot(),schema68=db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),v69=copy('v69',69);
  const entry69={...manifest.migrations[68]},sql69=readFileSync(join(v69,entry69.file),'utf8');
  const bad69=sql69+"\nINSERT INTO investor_epoch_preview_requests(id) VALUES('fictional-late-preview-upgrade');\n";
  writeFileSync(join(v69,entry69.file),bad69);entry69.sha256=createHash('sha256').update(bad69).digest('hex');
  writeFileSync(join(v69,'manifest.json'),JSON.stringify({...manifest,migrations:[...manifest.migrations.slice(0,68),entry69]}));
  assert.throws(()=>migrateWorkbench(filename,{directory:v69}),/NOT NULL|binding differs/);
  assert.deepEqual(fullSnapshot(),before69);assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema68);
  assert.equal(db.pragma('user_version',{simple:true}),68);
  writeFileSync(join(v69,entry69.file),sql69);writeFileSync(join(v69,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,69)}));
  assert.equal(migrateWorkbench(filename,{directory:v69}).applied,1);assert.equal(verifyWorkbenchSchema(db,v69).version,69);
  assert.deepEqual(fullSnapshot().filter(row=>row.table!=='schema_migrations'),before69.filter(row=>row.table!=='schema_migrations'));
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=68 ORDER BY version').all(),before69.find(row=>row.table==='schema_migrations').rows.map(({_preserved_rowid,...row})=>row));
  for(const name of ['investor_epoch_preview_requests','investor_epoch_preview_results'])assert.equal(db.prepare('SELECT count(*) n FROM '+name).get().n,0);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(migrateWorkbench(filename,{directory:v69}).applied,0);
  const before70=fullSnapshot(),schema69=db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),v70=copy('v70',70);
  const entry70={...manifest.migrations[69]},sql70=readFileSync(join(v70,entry70.file),'utf8');
  const bad70=sql70+"\nINSERT INTO investor_epoch_feed_requests(id) VALUES('fictional-late-epoch-feed-upgrade');\n";
  writeFileSync(join(v70,entry70.file),bad70);entry70.sha256=createHash('sha256').update(bad70).digest('hex');
  writeFileSync(join(v70,'manifest.json'),JSON.stringify({...manifest,migrations:[...manifest.migrations.slice(0,69),entry70]}));
  assert.throws(()=>migrateWorkbench(filename,{directory:v70}),/NOT NULL|binding differs/);
  assert.deepEqual(fullSnapshot(),before70);assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema69);
  assert.equal(db.pragma('user_version',{simple:true}),69);
  writeFileSync(join(v70,entry70.file),sql70);writeFileSync(join(v70,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,70)}));
  assert.equal(migrateWorkbench(filename,{directory:v70}).applied,1);assert.equal(verifyWorkbenchSchema(db,v70).version,70);
  assert.deepEqual(fullSnapshot().filter(row=>row.table!=='schema_migrations'),before70.filter(row=>row.table!=='schema_migrations'));
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=69 ORDER BY version').all(),before70.find(row=>row.table==='schema_migrations').rows.map(({_preserved_rowid,...row})=>row));
  for(const name of ['investor_epoch_feed_requests','investor_epoch_feed_runs'])assert.equal(db.prepare('SELECT count(*) n FROM '+name).get().n,0);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(migrateWorkbench(filename,{directory:v70}).applied,0);
  const before71=fullSnapshot(),schema70=db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),v71=copy('v71',71);
  const entry71={...manifest.migrations[70]},sql71=readFileSync(join(v71,entry71.file),'utf8');
  const bad71=sql71+"\nINSERT INTO investor_epoch_history_requests(id) VALUES('fictional-late-history-upgrade');\n";
  writeFileSync(join(v71,entry71.file),bad71);entry71.sha256=createHash('sha256').update(bad71).digest('hex');
  writeFileSync(join(v71,'manifest.json'),JSON.stringify({...manifest,migrations:[...manifest.migrations.slice(0,70),entry71]}));
  assert.throws(()=>migrateWorkbench(filename,{directory:v71}),/NOT NULL|binding differs/);
  assert.deepEqual(fullSnapshot(),before71);assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema70);
  assert.equal(db.pragma('user_version',{simple:true}),70);
  writeFileSync(join(v71,entry71.file),sql71);writeFileSync(join(v71,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,71)}));
  assert.equal(migrateWorkbench(filename,{directory:v71}).applied,1);assert.equal(verifyWorkbenchSchema(db,v71).version,71);
  assert.deepEqual(fullSnapshot().filter(row=>row.table!=='schema_migrations'),before71.filter(row=>row.table!=='schema_migrations'));
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=70 ORDER BY version').all(),before71.find(row=>row.table==='schema_migrations').rows.map(({_preserved_rowid,...row})=>row));
  for(const name of ['requests','slots','attempts','runs'])assert.equal(db.prepare('SELECT count(*) n FROM investor_epoch_history_'+name).get().n,0);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(migrateWorkbench(filename,{directory:v71}).applied,0);
  const before72=fullSnapshot(),schema71=db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),v72=copy('v72',72);
  const entry72={...manifest.migrations[71]},sql72=readFileSync(join(v72,entry72.file),'utf8');
  const bad72=sql72+"\nINSERT INTO investor_epoch_history_intents(id) VALUES('fictional-late-history-workflow-upgrade');\n";
  writeFileSync(join(v72,entry72.file),bad72);entry72.sha256=createHash('sha256').update(bad72).digest('hex');
  writeFileSync(join(v72,'manifest.json'),JSON.stringify({...manifest,migrations:[...manifest.migrations.slice(0,71),entry72]}));
  assert.throws(()=>migrateWorkbench(filename,{directory:v72}),/NOT NULL|binding differs/);
  assert.deepEqual(fullSnapshot(),before72);assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema71);
  assert.equal(db.pragma('user_version',{simple:true}),71);
  writeFileSync(join(v72,entry72.file),sql72);writeFileSync(join(v72,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,72)}));
  assert.equal(migrateWorkbench(filename,{directory:v72}).applied,1);assert.equal(verifyWorkbenchSchema(db,v72).version,72);
  assert.deepEqual(fullSnapshot().filter(row=>row.table!=='schema_migrations'),before72.filter(row=>row.table!=='schema_migrations'));
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=71 ORDER BY version').all(),before72.find(row=>row.table==='schema_migrations').rows.map(({_preserved_rowid,...row})=>row));
  for(const name of ['investor_epoch_history_intents','investor_epoch_history_results'])assert.equal(db.prepare('SELECT count(*) n FROM '+name).get().n,0);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  assert.equal(migrateWorkbench(filename,{directory:v72}).applied,0);
  const tables72=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  const snapshot72=()=>tables72.map(table=>({table,rows:db.prepare(`SELECT rowid _preserved_rowid,* FROM ${table} ORDER BY rowid`).all()}));
  const before73=snapshot72(),schema72=db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),v73=copy('v73',73);
  const entry73={...manifest.migrations[72]},sql73=readFileSync(join(v73,entry73.file),'utf8'),bad73=sql73+"\nINSERT INTO investor_epoch_history_resolutions(id) VALUES('fictional-late-resolution-upgrade');\n";
  writeFileSync(join(v73,entry73.file),bad73);entry73.sha256=createHash('sha256').update(bad73).digest('hex');
  writeFileSync(join(v73,'manifest.json'),JSON.stringify({...manifest,migrations:[...manifest.migrations.slice(0,72),entry73]}));
  assert.throws(()=>migrateWorkbench(filename,{directory:v73}),/NOT NULL|binding differs/);
  assert.deepEqual(snapshot72(),before73);assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all(),schema72);assert.equal(db.pragma('user_version',{simple:true}),72);
  writeFileSync(join(v73,entry73.file),sql73);writeFileSync(join(v73,'manifest.json'),JSON.stringify({...manifest,migrations:manifest.migrations.slice(0,73)}));
  assert.equal(migrateWorkbench(filename,{directory:v73}).applied,1);assert.equal(verifyWorkbenchSchema(db,v73).version,73);
  assert.deepEqual(snapshot72().filter(row=>row.table!=='schema_migrations'),before73.filter(row=>row.table!=='schema_migrations'));
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=72 ORDER BY version').all(),before73.find(row=>row.table==='schema_migrations').rows.map(({_preserved_rowid,...row})=>row));
  assert.equal(db.prepare('SELECT count(*) n FROM investor_epoch_history_resolutions').get().n,0);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.equal(migrateWorkbench(filename,{directory:v73}).applied,0);
});
