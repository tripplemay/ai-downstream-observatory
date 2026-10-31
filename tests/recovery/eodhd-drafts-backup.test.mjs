import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateWorkbench } from '../../scripts/migrate-workbench.mjs';
import { Database, backupWorkbench } from '../../scripts/backup-workbench.mjs';
import { restoreWorkbench } from '../../scripts/restore-workbench.mjs';

function offline(filename, body) {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? 'python3', ['-c', `
import json,os,socket,sys
from worker.orchestration.db import open_database,WorkbenchError
from worker.orchestration.runtime import run_pending_once
from worker.orchestration.jobs import claim_job,run_one
from worker.investor import eodhd_sources as s
from tests.investor.test_eodhd_sources import policy,Collector,REGISTER,AT
def forbidden(*a,**k):raise AssertionError('OFFLINE_FIXTURE_NETWORK_FORBIDDEN')
socket.getaddrinfo=forbidden;socket.create_connection=forbidden
s.receiver.collect_eodhd_action_draft=forbidden
os.environ['WORKBENCH_EODHD_ENABLED']='1'
db=open_database(sys.argv[1])
${body}
db.close()
`, filename], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 30000, maxBuffer: 65536, env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null); return JSON.parse(child.stdout);
}

test('one encrypted roundtrip preserves EODHD four-slot budgets, dedup bytes, unknown attempts and immutable receipts without auto-resume', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'eodhd-recovery-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'data'), dbPath = join(dataDir, 'workbench.db'), outputDir = join(directory, 'backups');
  mkdirSync(dataDir, { mode: 0o700 }); migrateWorkbench(dbPath);
  const ids = offline(dbPath, `db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,?)",(REGISTER,))
g=s.register_authority(db,'w','synthetic-investor',policy(),now=REGISTER)
s.set_authority_enabled(db,'w','synthetic-investor',g['id'],True,now=REGISTER)
assert len(s.discover_eodhd_requests(db,now=AT))==4
for unused in range(4):
 assert run_one(db,'fictional-eodhd',lambda j,l:s.prepare_eodhd_capture(db,j,l,clock=lambda:AT,test_collector=Collector()),job_type=s.JOB_TYPE,lease_seconds=180,clock=lambda:AT)['status']=='succeeded'
first=db.execute('SELECT request_id FROM investor_eodhd_captures ORDER BY rowid LIMIT 1').fetchone()[0]
at='2026-11-02T06:00:03.000Z'
assert len(s.discover_eodhd_requests(db,now=at))==4
lease=claim_job(db,'fictional-interrupted',job_type=s.JOB_TYPE,lease_seconds=180,now=at)
last=db.execute('SELECT period FROM job_runs WHERE id=?',(lease.job_id,)).fetchone()[0]
print(json.dumps({'first':first,'last':last}))`);
  const names = ['investor_eodhd_authorities', 'investor_eodhd_controls', 'investor_eodhd_requests', 'investor_eodhd_captures',
    'investor_eodhd_payloads', 'investor_eodhd_purges', 'job_runs', 'job_attempts', 'audit_events', 'outbox'];
  const snapshot = db => names.map(name => ({ name, rows: db.prepare(`SELECT rowid _preserved_rowid,* FROM ${name} ORDER BY rowid`).all() }));
  const source = new Database(dbPath), before = snapshot(source); source.close();
  const passphrase = 'fictional-eodhd-recovery-test-only-passphrase';
  const archive = await backupWorkbench({ dbPath, dataDir, outputDir, passphrase, appRef: 'offline-eodhd', now: () => '2026-11-02T06:00:03.000Z' });
  assert.equal(readdirSync(outputDir).filter(name => name.endsWith('.etfbackup')).length, 1);
  const targetDir = join(directory, 'restored'), result = await restoreWorkbench({ archivePath: archive.path, targetDir, passphrase });
  assert.equal(result.pending_review, true); assert.ok(existsSync(join(targetDir, 'RESTORE_PENDING_REVIEW')));
  const db = new Database(result.database_path); db.pragma('foreign_keys=ON');
  try {
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare('SELECT count(*) n FROM investor_eodhd_payloads').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM investor_eodhd_captures').get().n, 4);
    assert.equal(db.prepare('SELECT count(*) n FROM investor_eodhd_requests').get().n, 8);
    const payload = db.prepare('SELECT * FROM investor_eodhd_payloads').get();
    assert.equal(createHash('sha256').update(payload.payload).digest('hex'), payload.raw_sha256);
    for (const table of ['authorities', 'controls', 'requests', 'captures'])
      for (const row of db.prepare(`SELECT document_json,content_hash FROM investor_eodhd_${table}`).all())
        assert.equal(createHash('sha256').update(row.document_json).digest('hex'), row.content_hash);
    const job = db.prepare("SELECT id FROM job_runs WHERE status='succeeded' LIMIT 1").get();
    assert.throws(() => db.prepare("UPDATE job_runs SET status='queued',attempt_count=0 WHERE id=?").run(job.id), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM job_attempts').run(), /cannot be deleted/);
    const replay = offline(result.database_path, `at='2026-11-02T06:00:03.000Z'
a=s.inspect_request(db,'w','synthetic-investor','${ids.first}',now=at)
b=s.inspect_request(db,'w','synthetic-investor','${ids.last}',now=at)
assert a['status']=='captured' and b['status']=='indeterminate_no_retry' and b['automatic_retry_permitted'] is False
v=s.resolve_eodhd_capture(db,'w','synthetic-investor',a['capture_id'],now=at,allow_synthetic=True)
assert v['raw']==b'[]' and v['draft']['corporate_actions_complete'] is False
for role in ('core','longport'):
 try:run_pending_once(db,'fictional-restored-'+role,role=role,clock=lambda:at)
 except WorkbenchError as e:assert str(e)=='RESTORE_PENDING_REVIEW'
 else:raise AssertionError('restore permitted work')
print(json.dumps({'status':b['status'],'raw_bytes':len(v['raw']),'research_admitted':False}))`);
    assert.equal(replay.status, 'indeterminate_no_retry'); assert.equal(replay.research_admitted, false); assert.equal(replay.raw_bytes, 2);
    assert.deepEqual(snapshot(db), before); assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    for (const name of ['ledger_events', 'postings', 'investor_models', 'investor_data_reviews', 'investor_monitor_evidence_inputs', 'approval_events', 'execution_reports'])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get().n, 0);
  } finally { db.close(); }
});
