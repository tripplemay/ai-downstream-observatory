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
    `import json,sys,socket\nfrom unittest.mock import patch\nfrom worker.orchestration.db import open_database,WorkbenchError\nfrom worker.investor import issuer_sources as s\nfrom tests.investor.test_issuer_sources import Collector,policy,NOW,LATER,START,END\ndef forbidden(*a,**k): raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')\nsocket.create_connection=forbidden\nsocket.getaddrinfo=forbidden\ns.receiver.collect_vanguard_distribution_draft=forbidden\ndb=open_database(sys.argv[1])\n${source}\ndb.close()`, filename],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8', maxBuffer: 65536, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null); return JSON.parse(child.stdout);
}

test('offline encrypted roundtrip preserves issuer receipts, one dedup blob and unknown claim without granting replay or writes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'issuer-recovery-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'data'), dbPath = join(dataDir, 'workbench.db'), outputDir = join(directory, 'backups');
  mkdirSync(dataDir, { mode: 0o700 }); migrateWorkbench(dbPath);
  const ids = offlinePython(dbPath, `db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)",(NOW,))
g=s.register_authority(db,'w','synthetic-investor',policy(),now=NOW)
s.set_authority_enabled(db,'w','synthetic-investor',g['id'],True,now=NOW)
a=s.collect_issuer_draft(db,'w','synthetic-investor',g['id'],'a'*32,START,END,now=NOW,test_collector=Collector())
b=s.collect_issuer_draft(db,'w','synthetic-investor',g['id'],'b'*32,START,END,now=LATER,test_collector=Collector(LATER))
def crash(**k):raise KeyboardInterrupt()
try:s.collect_issuer_draft(db,'w','synthetic-investor',g['id'],'c'*32,START,END,now='2026-01-05T12:00:03.000Z',test_collector=crash)
except KeyboardInterrupt:pass
print(json.dumps({'authority':g['id'],'capture':a['capture_id']}))`);
  const source = new Database(dbPath), names = ['authorities','controls','requests','captures','payloads','purges'].map(name => `investor_issuer_${name}`);
  const before = names.map(name => ({ name, rows: source.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() })); source.close();
  const passphrase = 'fictional-issuer-backup-test-only-passphrase';
  const archive = await backupWorkbench({ dbPath, dataDir, outputDir, passphrase, appRef: 'offline-issuer-fixture', now: () => '2026-01-05T12:00:03.000Z' });
  assert.equal(readdirSync(outputDir).filter(name => name.endsWith('.etfbackup')).length, 1);
  const targetDir = join(directory, 'restored'), result = await restoreWorkbench({ archivePath: archive.path, targetDir, passphrase });
  assert.equal(result.pending_review, true); assert.ok(existsSync(join(targetDir, 'RESTORE_PENDING_REVIEW')));
  const db = new Database(result.database_path, { readonly: true });
  try {
    assert.deepEqual(names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() })), before);
    assert.equal(db.prepare('SELECT count(*) n FROM investor_issuer_payloads').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM investor_issuer_requests').get().n, 3);
    assert.equal(db.prepare('SELECT count(*) n FROM investor_issuer_captures').get().n, 2);
    for (const name of ['ledger_events','postings','investor_data_reviews','investor_monitor_evidence_inputs','job_runs','outbox'])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get().n, 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
  const checked = offlinePython(result.database_path, `at='2026-01-05T12:00:03.000Z'
state=s.request_state(db,'w','synthetic-investor','c'*32,now=at)
v=s.resolve_issuer_capture(db,'w','synthetic-investor','${ids.capture}',now=at,allow_synthetic=True)
try:s.resolve_issuer_capture(db,'w','synthetic-investor','${ids.capture}',now=at)
except WorkbenchError as e:assert str(e)=='INVESTOR_ISSUER_SYNTHETIC_CAPTURE_FORBIDDEN'
else:raise AssertionError('synthetic became official')
try:s.collect_issuer_draft(db,'w','synthetic-investor','${ids.authority}','c'*32,START,END,now=at,test_collector=forbidden)
except WorkbenchError as e:assert str(e)=='RESTORE_PENDING_REVIEW'
else:raise AssertionError('restore permitted writes')
print(json.dumps({'status':state['status'],'retry':state['automatic_retry_permitted'],'hash':v['receipt']['raw_sha256'],'research_admitted':v['receipt']['research_admitted']}))`);
  assert.equal(checked.status, 'indeterminate'); assert.equal(checked.retry, false); assert.equal(checked.research_admitted, false);
  assert.equal(checked.hash, before.find(row => row.name === 'investor_issuer_payloads').rows[0].raw_sha256);
});
