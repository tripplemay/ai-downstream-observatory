import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateWorkbench } from '../../scripts/migrate-workbench.mjs';
import { Database, backupWorkbench } from '../../scripts/backup-workbench.mjs';
import { restoreWorkbench } from '../../scripts/restore-workbench.mjs';

function python(filename, code) {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? 'python3', ['-c', `import json,sys,socket\nfrom datetime import date,timedelta\nfrom unittest.mock import patch\nfrom worker.orchestration.db import open_database,WorkbenchError\nfrom worker.investor.data_evidence import review_source\nfrom worker.investor.calendar_continuation import current_calendar_review\nfrom worker.market.providers import longport\nfrom tests.investor.confirmed_capture_fixture import sources,NOW,EXPIRY\ndef forbidden(*a,**k):raise AssertionError('REAL_NETWORK_OR_CREDENTIALS_FORBIDDEN')\nsocket.create_connection=forbidden\nsocket.getaddrinfo=forbidden\nlongport.read_private_credentials_file=forbidden\ndb=open_database(sys.argv[1])\n${code}\ndb.close()`, filename],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null); return JSON.parse(child.stdout);
}

test('encrypted roundtrip preserves a nonempty calendar lineage and read-only restoration cannot approve an extension', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-continuation-recovery-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'data'), dbPath = join(dataDir, 'workbench.db'); mkdirSync(dataDir, { mode: 0o700 }); migrateWorkbench(dbPath);
  const ids = python(dbPath, `db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)",(NOW,))
refs=sources(db)
old=refs[2];facts=json.loads(old['document_json'])['facts'];previous=old['id']
for unused in range(2):
 day=(date.fromisoformat(facts['range_end'])+timedelta(days=1)).isoformat()
 facts={**facts,'range_end':day,'days':[*facts['days'],{'date':day,'kind':'closed','close_at':None,'available_at':None,'settled_at':None,'settlement_rule_known_at':None}]}
 row=review_source(db,'w','synthetic-investor',old['source_id'],'approved',facts,'Fictional explicit continuation',EXPIRY,now=NOW,continues_calendar_review_id=previous)
 previous=row['id']
assert current_calendar_review(db,'w',old['id'],NOW)['review']['id']==previous
print(json.dumps({'origin':old['id'],'head':previous,'source':old['source_id']}))`);
  const names = ['investor_workspaces','investor_data_sources','investor_data_reviews','investor_calendar_continuations','audit_events'];
  const snapshot = db => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const source = new Database(dbPath), before = snapshot(source); source.close();
  const passphrase = 'fictional-calendar-lineage-backup-only-passphrase';
  const backup = await backupWorkbench({ dbPath, dataDir, outputDir: join(directory, 'backups'), passphrase, appRef: 'fictional-calendar-continuation', now: () => '2026-01-03T12:00:03.000Z' });
  const restored = await restoreWorkbench({ archivePath: backup.path, targetDir: join(directory, 'restored'), passphrase });
  assert.equal(restored.pending_review, true); assert.ok(existsSync(join(directory, 'restored', 'RESTORE_PENDING_REVIEW')));
  const db = new Database(restored.database_path, { readonly: true });
  try {
    assert.deepEqual(snapshot(db), before); assert.equal(db.prepare('SELECT count(*) n FROM investor_calendar_continuations').get().n, 2);
    for (const name of ['ledger_events','postings','investor_models','investor_monitor_evidence_inputs','approval_events','execution_reports']) assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get().n, 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
  const result = python(restored.database_path, `value=current_calendar_review(db,'w','${ids.origin}',NOW)
assert value['review']['id']=='${ids.head}'
facts=value['facts'];day=(date.fromisoformat(facts['range_end'])+timedelta(days=1)).isoformat()
facts={**facts,'range_end':day,'days':[*facts['days'],{'date':day,'kind':'closed','close_at':None,'available_at':None,'settled_at':None,'settlement_rule_known_at':None}]}
try:review_source(db,'w','synthetic-investor','${ids.source}','approved',facts,'Fictional denied restored approval',EXPIRY,now=NOW,continues_calendar_review_id='${ids.head}')
except WorkbenchError as error:assert str(error)=='RESTORE_PENDING_REVIEW'
else:raise AssertionError('restored database approved a new calendar')
assert db.execute('SELECT count(*) FROM investor_calendar_continuations').fetchone()[0]==2
print(json.dumps({'head':value['review']['id'],'new_approval_blocked':True,'real_provider_called':False}))`);
  assert.equal(result.head, ids.head); assert.equal(result.new_approval_blocked, true); assert.equal(result.real_provider_called, false);
});
