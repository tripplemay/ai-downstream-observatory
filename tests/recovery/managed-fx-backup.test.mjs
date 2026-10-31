import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateWorkbench } from '../../scripts/migrate-workbench.mjs';
import { Database, backupWorkbench } from '../../scripts/backup-workbench.mjs';
import { restoreWorkbench } from '../../scripts/restore-workbench.mjs';

function offlinePython(filename, source) {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c',
    `import json,sys,socket\nfrom unittest.mock import patch\nfrom worker.orchestration.db import open_database,WorkbenchError\nfrom worker.orchestration.runtime import run_pending_once\nfrom worker.orchestration.jobs import claim_job\nfrom worker.investor import managed_fx as s\nfrom tests.investor.test_managed_fx import Collector,policy,AT,LATER\ndef forbidden(*a,**k): raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')\nsocket.create_connection=forbidden\nsocket.getaddrinfo=forbidden\ns.receiver.collect_current_fx_draft=forbidden\ndb=open_database(sys.argv[1])\n${source}\ndb.close()`, filename],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8', maxBuffer: 65536, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null); return JSON.parse(child.stdout);
}

test('offline encrypted FX roundtrip retains dedup bytes, heads and unknown attempt; restore cannot fetch, publish or trade', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'managed-fx-recovery-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'data'), dbPath = join(dataDir, 'workbench.db'), outputDir = join(directory, 'backups');
  mkdirSync(dataDir, { mode: 0o700 }); migrateWorkbench(dbPath);
  const ids = offlinePython(dbPath, `db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)",(AT,))
g=s.register_authority(db,'w','synthetic-investor',policy(),now=AT)
s.set_authority_enabled(db,'w','synthetic-investor',g['id'],True,now=AT)
for at in (AT,LATER):
 with patch.object(s.receiver,'collect_current_fx_draft',side_effect=Collector(at=at)):
  assert run_pending_once(db,'fictional-provider',role='longport',lease_seconds=180,clock=lambda:at)['status']=='succeeded'
 run_pending_once(db,'fictional-core',role='core',clock=lambda:at)
at='2026-01-05T12:00:03.000Z'
s.discover_current_fx(db,now=at)
assert claim_job(db,'fictional-interrupted',job_type=s.JOB_TYPE,lease_seconds=1,now=at) is not None
print(json.dumps({'authority':g['id'],'review':db.execute('SELECT usd_review_id FROM investor_fx_publications WHERE status=?',('published',)).fetchone()[0]}))`);
  const source = new Database(dbPath), names = ['authorities','controls','requests','captures','payloads','purges','publications'].map(name => `investor_fx_${name}`);
  names.push('job_runs','job_attempts','investor_data_sources','investor_data_reviews','audit_events','outbox');
  const before = names.map(name => ({ name, rows: source.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() })); source.close();
  const passphrase = 'fictional-managed-fx-backup-test-only-passphrase';
  const archive = await backupWorkbench({ dbPath, dataDir, outputDir, passphrase, appRef: 'offline-managed-fx-fixture', now: () => '2026-01-05T12:00:03.000Z' });
  assert.equal(readdirSync(outputDir).filter(name => name.endsWith('.etfbackup')).length, 1);
  const targetDir = join(directory, 'restored'), result = await restoreWorkbench({ archivePath: archive.path, targetDir, passphrase });
  assert.equal(result.pending_review, true); assert.ok(existsSync(join(targetDir, 'RESTORE_PENDING_REVIEW')));
  const db = new Database(result.database_path, { readonly: true });
  try {
    assert.deepEqual(names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() })), before);
    assert.equal(db.prepare('SELECT count(*) n FROM investor_fx_payloads').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM investor_fx_publications').get().n, 2);
    for (const name of ['ledger_events','postings','investor_models','investor_monitor_evidence_inputs','approval_events','execution_reports'])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get().n, 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
  const checked = offlinePython(result.database_path, `at='2026-01-05T12:00:03.000Z'
state=s.inspect_request(db,'w','synthetic-investor','2026-01-05',now=at)
from worker.investor.data_evidence import resolve_review
v=resolve_review(db,'w','${ids.review}','fx',now=at)
for role in ('longport','core'):
 try:run_pending_once(db,'fictional-restored-'+role,role=role,clock=lambda:at)
 except WorkbenchError as e:assert str(e)=='RESTORE_PENDING_REVIEW'
 else:raise AssertionError('restore permitted runtime work')
assert db.execute('SELECT count(*) FROM investor_fx_requests').fetchone()[0]==3
assert db.execute('SELECT count(*) FROM investor_fx_captures').fetchone()[0]==2
print(json.dumps({'status':state['status'],'retry':state['automatic_retry_permitted'],'series':v['facts']['monitor_series']['authority_id']}))`);
  assert.equal(checked.status, 'indeterminate'); assert.equal(checked.retry, false); assert.equal(checked.series, ids.authority);
});
