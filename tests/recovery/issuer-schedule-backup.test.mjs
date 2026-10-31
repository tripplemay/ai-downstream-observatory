import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateWorkbench } from '../../scripts/migrate-workbench.mjs';
import { Database, backupWorkbench } from '../../scripts/backup-workbench.mjs';
import { restoreWorkbench } from '../../scripts/restore-workbench.mjs';

function offline(filename, body) {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? 'python3', ['-c', `
import json,socket,sys
from unittest.mock import patch
from worker.orchestration.db import open_database,WorkbenchError
from worker.orchestration.runtime import run_pending_once
from worker.orchestration.jobs import claim_job
from worker.investor import issuer_sources as sources,issuer_schedule as s
from tests.investor.test_issuer_sources import policy,Collector,NOW,LATER
from tests.investor.test_issuer_schedule import scheduled
def forbidden(*a,**k):raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')
socket.getaddrinfo=forbidden
socket.create_connection=forbidden
sources.receiver.collect_vanguard_distribution_draft=forbidden
db=open_database(sys.argv[1])
${body}
db.close()
`, filename], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
    env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null); return JSON.parse(child.stdout);
}

test('one temporary encrypted issuer-schedule roundtrip retains job fences, shared bytes and unknown attempt; restore remains inert', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'issuer-schedule-recovery-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'data'), dbPath = join(dataDir, 'workbench.db'), outputDir = join(directory, 'backups');
  mkdirSync(dataDir, { mode: 0o700 }); migrateWorkbench(dbPath);
  const ids = offline(dbPath, `db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)",(NOW,))
g=sources.register_authority(db,'w','synthetic-investor',policy(),now=NOW)
sources.set_authority_enabled(db,'w','synthetic-investor',g['id'],True,now=NOW)
r=s.register_schedule(db,'w','synthetic-investor',scheduled(g),now=NOW)
s.set_schedule_enabled(db,'w','synthetic-investor',r['id'],True,now=NOW)
for at in (NOW,LATER):
 with patch.object(sources.receiver,'collect_vanguard_distribution_draft',side_effect=Collector(at)):
  assert run_pending_once(db,'fictional-issuer-provider',role='longport',lease_seconds=180,clock=lambda:at)['status']=='succeeded'
first=db.execute('SELECT id FROM investor_issuer_schedule_requests ORDER BY rowid LIMIT 1').fetchone()[0]
assert s.inspect_scheduled_request(db,'w','synthetic-investor',first,now=LATER)['status']=='captured'
at='2026-01-05T12:00:03.000Z'
s.discover_issuer_requests(db,now=at)
assert claim_job(db,'fictional-interrupted',job_type=s.JOB_TYPE,lease_seconds=1,now=at) is not None
last=db.execute('SELECT id FROM investor_issuer_schedule_requests ORDER BY rowid DESC LIMIT 1').fetchone()[0]
print(json.dumps({'first':first,'last':last}))`);
  const names = ['investor_issuer_authorities','investor_issuer_controls','investor_issuer_requests','investor_issuer_captures','investor_issuer_payloads',
    'investor_issuer_schedules','investor_issuer_schedule_controls','investor_issuer_schedule_requests','investor_issuer_schedule_results','job_runs','job_attempts','audit_events','outbox'];
  const snapshot = db => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const source = new Database(dbPath), before = snapshot(source); source.close();
  const passphrase = 'fictional-issuer-schedule-recovery-test-only-passphrase';
  const archive = await backupWorkbench({ dbPath, dataDir, outputDir, passphrase, appRef: 'offline-issuer-schedule', now: () => '2026-01-05T12:00:03.000Z' });
  assert.equal(readdirSync(outputDir).filter(name => name.endsWith('.etfbackup')).length, 1);
  const targetDir = join(directory, 'restored'), result = await restoreWorkbench({ archivePath: archive.path, targetDir, passphrase });
  assert.equal(result.pending_review, true); assert.ok(existsSync(join(targetDir, 'RESTORE_PENDING_REVIEW')));
  const db = new Database(result.database_path, { readonly: true });
  try {
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare('SELECT count(*) n FROM investor_issuer_payloads').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM investor_issuer_schedule_results').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM investor_issuer_schedule_requests').get().n, 3);
    const replay = offline(result.database_path, `at='2026-01-05T12:00:03.000Z'
a=s.inspect_scheduled_request(db,'w','synthetic-investor','${ids.first}',now=at)
b=s.inspect_scheduled_request(db,'w','synthetic-investor','${ids.last}',now=at)
assert a['status']=='captured' and b['status']=='indeterminate' and b['automatic_retry_permitted'] is False
v=sources.resolve_issuer_capture(db,'w','synthetic-investor',a['capture_id'],now=at)
assert v['draft']['corporate_actions_complete'] is False
for role in ('core','longport'):
 try:run_pending_once(db,'fictional-restored-'+role,role=role,clock=lambda:at)
 except WorkbenchError as e:assert str(e)=='RESTORE_PENDING_REVIEW'
 else:raise AssertionError('restore permitted work')
print(json.dumps({'status':b['status'],'raw_bytes':len(v['raw']),'research_admitted':False}))`);
    assert.equal(replay.status, 'indeterminate'); assert.equal(replay.research_admitted, false); assert.ok(replay.raw_bytes > 0);
    assert.deepEqual(snapshot(db), before); assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    for (const name of ['ledger_events','postings','investor_models','investor_data_reviews','investor_monitor_evidence_inputs','approval_events','execution_reports'])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get().n, 0);
  } finally { db.close(); }
});
