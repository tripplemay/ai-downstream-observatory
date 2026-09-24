import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const endpoint = '/api/workbench/price-schedules';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function priceScheduleHttpCases({ check, request, jsonRequest, filename, directory, root, output, origin, address, password, Database }) {
  let cookie, binding, portfolio, foreign, due, target, definition, receipts = [], winner, loser;
  const headers = extra => ({ Cookie: cookie, 'X-Workbench-Session-Binding': binding, ...extra });
  const post = (url, body, extra = {}) => jsonRequest(url, { method: 'POST', headers: headers({ Origin: origin, 'Content-Type': 'application/json', ...extra }), body: JSON.stringify(body) });
  const get = (query = `portfolio=${portfolio}`, extra = {}) => jsonRequest(`${endpoint}?${query}`, { headers: headers(extra) });
  const save = (value, key, selected = portfolio) => ({ portfolio_id: selected, expected_schedule_id: null, expected_schedule_revision: 0,
    definition_json: JSON.stringify(value), reason: 'Synthetic recurring price HTTP fixture only', acknowledgement: true, idempotency_key: key });
  const status = (receipt, value, key, selected = portfolio) => ({ portfolio_id: selected, schedule_id: receipt.schedule_id,
    expected_schedule_revision: receipt.schedule_revision, status: value, reason: 'Synthetic explicit schedule control', acknowledgement: true, idempotency_key: key });
  const read = operation => { const db = new Database(filename, { readonly: true }); try { return operation(db); } finally { db.close(); } };
  const fingerprint = names => read(db => {
    db.defaultSafeIntegers(true);
    return db.transaction(() => sha(JSON.stringify(names.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).raw().all().map(row =>
      JSON.stringify(row.map(value => typeof value === 'bigint' ? ['integer', value.toString()] : Buffer.isBuffer(value) ? ['blob', value.toString('base64')] : [typeof value, value]))).sort()])))).deferred();
  });
  const allTables = () => read(db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name));
  const financial = () => fingerprint(['ledger_events', 'ledger_heads', 'postings', 'valuation_runs', 'performance_runs', 'policy_versions', 'strategy_versions', 'activations', 'proposals']);
  const worker = (pause = null) => {
    const script = `import json,sys,urllib.request
from unittest.mock import patch
from worker.orchestration.db import open_database
from worker.orchestration.runtime import run_pending_once
from worker.market.collection import verify_provider_capture
from tests.market.test_price_collection import fake_collect
db=open_database(sys.argv[1]); pause=json.load(sys.stdin); calls=[]; paused=[]
def transport(**kwargs):
    calls.append(kwargs['mapping']['listing_id'])
    result=fake_collect(**kwargs)
    if pause is not None and len(calls)==1:
        command=urllib.request.Request(pause['url'],data=json.dumps(pause['body']).encode(),headers=pause['headers'],method='POST')
        with urllib.request.urlopen(command,timeout=10) as response: paused.append(response.status)
    return result
try:
    with patch('worker.market.providers.longport.collect_longport_candles',transport):
        job=run_pending_once(db,'synthetic-http-price-schedule',role='longport',lease_seconds=300)
    result=None if job is None else json.loads(job['result_json'])
    slot=None if job is None else dict(db.execute('SELECT * FROM price_collection_schedule_slots WHERE command_request_id=?',(job['command_request_id'],)).fetchone())
    proof=verify_provider_capture(db,result['batch_id']) if job is not None and job['status']=='succeeded' else None
    print(json.dumps({'status':None if job is None else job['status'],'slot':slot,'result':result,'proof':proof,'calls':calls,'pause_statuses':paused}))
finally: db.close()
`;
    const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON || process.env.WORKBENCH_PYTHON || 'python3', ['-c', script, filename], {
      cwd: root, env: { PATH: process.env.PATH, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: '1', TZ: 'UTC',
        WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: path.join(directory, 'auth'), WORKBENCH_MODE: 'ledger' },
      input: JSON.stringify(pause), encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1048576,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error)); return JSON.parse(result.stdout);
  };
  try {
    await check('HTTP-PS01', 'price schedules require login and expose neither defaults nor implicit collection', async () => {
      assert.equal((await request('/workbench/price-schedules')).headers.get('location'), '/login');
      assert.equal((await jsonRequest(`${endpoint}?portfolio=a&portfolio=b`)).status, 401);
      assert.equal((await jsonRequest(endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' })).status, 401);
      const login = await request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });
      assert.equal(login.status, 303); cookie = login.headers.get('set-cookie').split(';')[0];
      binding = (await jsonRequest('/api/auth/session', { headers: { Cookie: cookie } })).json.session_binding;
      const created = [];
      for (const name of ['Synthetic price schedule HTTP', 'Synthetic price schedule other scope']) {
        const result = await post('/api/workbench', { action: 'create_portfolio', name }); assert.equal(result.status, 200); created.push(result.json.id);
      }
      [portfolio, foreign] = created;
      const empty = await get(); assert.equal(empty.status, 200); assert.deepEqual(empty.json.schedules, []); assert.deepEqual(empty.json.slots, []);
      assert.deepEqual(empty.json.reference_candidates, []); assert.equal(empty.json.session_binding, binding);
      assert.equal(empty.headers.get('cache-control'), 'private, no-store');
      assert.equal((await request('/workbench/price-schedules', { headers: { Cookie: cookie } })).status, 200);
      return { empty_schedules: true, empty_slots: true, defaults_created: false };
    });
    await check('HTTP-PS02', 'normal registration and reviewed references save paused finite local-date schedules without jobs', async () => {
      const listingIds = [];
      for (let index = 0; index < 4; index++) {
        const registered = await post('/api/workbench', { action: 'register_listing', command: { portfolio_id: portfolio, expected_revision: 0,
          idempotency_key: `http-price-schedule-listing:${index}`, name: `Synthetic scheduled ETF ${index}`, market: 'CN', exchange: 'SYNTHETIC-PS', ticker: `PS${index}`,
          currency: 'CNY', asset_class: 'etf', quantity_step: '1', price_step: '0.01', source_evidence: 'Synthetic HTTP registration, not a real instrument' } });
        assert.equal(registered.status, 200, JSON.stringify(registered.json)); listingIds.push(registered.json.listing_id);
        const member = await post('/api/workbench/catalog', { action: 'add_entry', command: { portfolio_id: portfolio, expected_catalog_revision: index,
          idempotency_key: `http-price-schedule-member:${index}`, listing_id: registered.json.listing_id } });
        assert.equal(member.status, 200, JSON.stringify(member.json));
      }
      due = new Date(Math.ceil((Date.now() + 30000) / 60000) * 60000);
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(due).map(part => [part.type, part.value]));
      const localDay = `${parts.year}-${parts.month}-${parts.day}`;
      target = new Date(Date.parse(localDay + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
      const documents = listingIds.map((listing_id, index) => ({ kind: 'mapping', facts: { provider: 'longport', listing_id,
        provider_symbol: `99999${index}.SH`, market: 'CN', exchange: 'SYNTHETIC-PS', currency: 'CNY', valid_from: target, valid_to: null } }));
      documents.push({ kind: 'calendar', facts: { market: 'CN', exchange: 'SYNTHETIC-PS', timezone: 'Asia/Shanghai', range_start: target, range_end: localDay,
        days: [{ date: target, kind: 'half', close_at: `${target}T03:00:00.000000Z` }, { date: localDay, kind: 'full', close_at: `${localDay}T07:00:00.000000Z` }] } });
      const references = [];
      for (const [index, document] of documents.entries()) {
        const stored = await post('/api/workbench/market', { action: 'store_source', command: { portfolio_id: portfolio, idempotency_key: `http-price-schedule-source:${index}`,
          reference: 'Synthetic date-specific calendar or mapping; not issuer/provider verification', content_text: JSON.stringify(document) } });
        assert.equal(stored.status, 200, JSON.stringify(stored.json));
        const reviewed = await post('/api/workbench/market', { action: 'publish_reference', command: { portfolio_id: portfolio, idempotency_key: `http-price-schedule-review:${index}`,
          expected_version: 0, source_id: stored.json.id, source_hash: stored.json.content_hash, review_reason: 'Synthetic explicit review', acknowledgement: true, document } });
        assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json)); references.push(reviewed.json.id);
      }
      definition = { schema_version: 'price-collection-schedule-v1', provider: 'longport', frequency: 'daily', publish: true,
        market: 'CN', timezone: 'Asia/Shanghai', mapping_version_ids: references.slice(0, 2), calendar_version_ids: references.slice(4),
        start_date: target, end_date: localDay, trigger_local: { hour: Number(parts.hour), minute: Number(parts.minute) }, deadline_seconds: 180,
        max_attempts: 2, missed_policy: 'record_no_backfill' };
      const before = financial();
      for (let index = 0; index < 2; index++) {
        const command = save({ ...definition, mapping_version_ids: references.slice(index * 2, index * 2 + 2) }, `http-price-schedule-save:${index}`);
        const saved = await post(endpoint, { action: 'save_schedule', command }); assert.equal(saved.status, 200, JSON.stringify(saved.json));
        assert.equal(saved.json.status, 'paused'); assert.equal(saved.json.content_hash, sha(command.definition_json)); receipts.push(saved.json);
        assert.deepEqual((await post(endpoint, { action: 'save_schedule', command })).json, saved.json);
      }
      const state = await get(); assert.equal(state.status, 200, JSON.stringify(state.json)); assert.equal(state.json.schedules.length, 2);
      assert.equal(state.json.slots.length, 0); assert.ok(state.json.schedules.every(row => row.status === 'paused'));
      assert.equal(financial(), before);
      return { schedules: 2, status: 'paused', target_date: target, actual_trigger: due.toISOString(), references_human_reviewed: true, financial_tables_unchanged: true };
    });
    await check('HTTP-PS03', 'explicit schedule enabling rejects forged sessions, stale CAS, cross-scope and recovery writes', async () => {
      const command = status(receipts[0], 'enabled', 'http-price-schedule-invalid'), before = fingerprint(allTables());
      for (const value of ['', '0'.repeat(64)]) assert.equal((await post(endpoint, { action: 'set_status', command }, { 'X-Workbench-Session-Binding': value })).status, 401);
      assert.equal((await post(endpoint, { action: 'set_status', command }, { Origin: 'https://wrong-origin.example.test' })).status, 403);
      assert.equal((await post(endpoint, { action: 'set_status', command: { ...command, actor_id: 'system:forged' } })).status, 400);
      assert.equal((await post(endpoint, { action: 'set_status', command: { ...command, expected_schedule_revision: 7 } })).status, 409);
      assert.equal((await post(endpoint, { action: 'set_status', command: { ...command, portfolio_id: foreign } })).status, 403);
      assert.equal((await get(`portfolio=${portfolio}&portfolio=${foreign}`)).status, 400);
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic price schedule readonly check\n');
      try { assert.equal((await get()).json.read_only, true); assert.equal((await post(endpoint, { action: 'set_status', command })).status, 423); }
      finally { rmSync(marker); }
      assert.equal(fingerprint(allTables()), before);
      for (let index = 0; index < receipts.length; index++) {
        const enabled = await post(endpoint, { action: 'set_status', command: status(receipts[index], 'enabled', `http-price-schedule-enable:${index}`) });
        assert.equal(enabled.status, 200, JSON.stringify(enabled.json)); receipts[index] = enabled.json;
      }
      assert.ok(Date.now() < due.getTime(), 'Human HTTP setup must finish before the actual authorized trigger.');
      return { rejections_zero_write: true, explicit_enable: true, trigger_in_future: true };
    });
    await check('HTTP-PS04', 'actual next-local-date trigger publishes one full price set and an in-flight HTTP pause rejects the other', async () => {
      const before = financial();
      await new Promise(resolve => setTimeout(resolve, Math.max(0, due.getTime() - Date.now() + 50)));
      winner = worker(); assert.equal(winner.status, 'succeeded', JSON.stringify(winner)); assert.equal(winner.calls.length, 2);
      assert.equal(winner.slot.period, target); assert.equal(winner.slot.scheduled_at, due.toISOString().replace('.000Z', '.000000Z'));
      assert.equal(winner.slot.disposition, 'requested'); assert.equal(winner.result.live_advice_eligible, false);
      const state = await get(); assert.equal(state.status, 200, JSON.stringify(state.json));
      const pending = state.json.slots.find(slot => slot.job?.status === 'queued'); assert.ok(pending);
      const receipt = receipts.find(value => value.schedule_id === pending.schedule_id); assert.ok(receipt);
      loser = worker({ url: new URL(endpoint, address).toString(), headers: headers({ Origin: origin, 'Content-Type': 'application/json' }),
        body: { action: 'set_status', command: status(receipt, 'paused', 'http-price-schedule-pause-inflight') } });
      assert.equal(loser.status, 'skipped', JSON.stringify(loser)); assert.deepEqual(loser.pause_statuses, [200]);
      assert.equal(loser.calls.length, 1); assert.equal(loser.slot.id, pending.id);
      const result = await get(); assert.equal(result.status, 200, JSON.stringify(result.json));
      const success = result.json.slots.find(slot => slot.id === winner.slot.id), stopped = result.json.slots.find(slot => slot.id === loser.slot.id);
      assert.equal(success.job.status, 'succeeded'); assert.ok(success.capture); assert.equal(stopped.capture, null); assert.equal(stopped.job.status, 'skipped');
      read(db => {
        assert.equal(db.prepare('SELECT count(*) n FROM market_sdk_captures WHERE command_request_id=?').get(loser.slot.command_request_id).n, 0);
        assert.equal(db.prepare('SELECT count(*) n FROM market_publications WHERE scope=?').get(loser.slot.scope_key).n, 0);
        const capture = db.prepare('SELECT * FROM market_sdk_captures WHERE command_request_id=?').get(winner.slot.command_request_id);
        writeFileSync(path.join(output, 'scheduled-price-sdk-projection.json'), capture.raw_body);
        assert.equal(sha(capture.raw_body), winner.proof.raw_sha256);
      });
      assert.equal(financial(), before);
      return { actual_trigger: true, target_date: target, synthetic_sdk_calls: 3, captures: 1, inflight_pause_atomic: true, financial_tables_unchanged: true, live_advice_eligible: false };
    });
    await check('HTTP-PS05', 'pause and resume retain independently proven history without replaying a completed target date', async () => {
      const receipt = receipts.find(value => value.schedule_id === winner.slot.schedule_id);
      const paused = await post(endpoint, { action: 'set_status', command: status(receipt, 'paused', 'http-price-schedule-pause-history') });
      assert.equal(paused.status, 200);
      const resumed = await post(endpoint, { action: 'set_status', command: status(paused.json, 'enabled', 'http-price-schedule-resume-history') });
      assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
      const before = fingerprint(allTables()), idle = worker(); assert.equal(idle.status, null); assert.deepEqual(idle.calls, []);
      assert.equal(fingerprint(allTables()), before);
      const detail = await get(`portfolio=${portfolio}&slot=${winner.slot.id}`); assert.equal(detail.status, 200, JSON.stringify(detail.json));
      assert.equal(detail.json.slot.job.status, 'succeeded'); assert.equal(detail.json.attempts.length, 1);
      assert.equal((await get(`portfolio=${foreign}&slot=${winner.slot.id}`)).status, 403);
      assert.equal((await get(`portfolio=${portfolio}&slot=${winner.slot.id}`, { 'X-Workbench-Session-Binding': '' })).status, 401);
      assert.doesNotMatch(JSON.stringify(detail.json), /raw_body|normalized_json|LONGPORT_APP_SECRET/);
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic schedule history recovery\n');
      try { const readonly = await get(`portfolio=${portfolio}&slot=${winner.slot.id}`); assert.equal(readonly.status, 200); assert.equal(readonly.json.read_only, true); }
      finally { rmSync(marker); }
      return { requests_not_replayed: true, historical_capture_visible: true, cross_scope_denied: true, readonly_history: true };
    });
  } finally {
    if (cookie) await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } }).catch(() => {});
  }
}
