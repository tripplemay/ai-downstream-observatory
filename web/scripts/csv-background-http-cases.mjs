import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { probeEarlyRejection } from './http-early-rejection.mjs';

const endpoint = '/api/workbench/csv/jobs';
const sha = value => createHash('sha256').update(value).digest('hex');

export async function csvBackgroundHttpCases({ check, request, jsonRequest, filename, directory, root, origin, address, password, Database }) {
  let cookie, binding, portfolio, account, foreign, foreignAccount, mapping, csv, previewRequest, preview, confirmation, rawPayload, recoveryId;
  const headers = extra => ({ Cookie: cookie, 'X-Workbench-Session-Binding': binding, ...extra });
  const post = (url, body, extra = {}) => jsonRequest(url, { method: 'POST', headers: headers({ Origin: origin, 'Content-Type': 'application/json', ...extra }), body: JSON.stringify(body) });
  const get = (query = {}, extra = {}) => jsonRequest(`${endpoint}?${new URLSearchParams({ portfolio, ...query })}`, { headers: headers(extra) });
  const read = operation => { const db = new Database(filename, { readonly: true }); try { return operation(db); } finally { db.close(); } };
  const counts = () => read(db => ({ requests: db.prepare('SELECT count(*) n FROM csv_background_requests WHERE portfolio_id=?').get(portfolio).n,
    jobs: db.prepare('SELECT count(*) n FROM job_runs WHERE scope=? AND job_type IN (?,?)').get(portfolio, 'csv_import_preview_v1', 'csv_import_confirm_v1').n,
    batches: db.prepare('SELECT count(*) n FROM import_batches WHERE portfolio_id=?').get(portfolio).n,
    facts: db.prepare('SELECT count(*) n FROM ledger_events WHERE portfolio_id=?').get(portfolio).n,
    results: db.prepare('SELECT count(*) n FROM csv_background_results s JOIN csv_background_requests q ON q.id=s.request_id WHERE q.portfolio_id=?').get(portfolio).n }));
  const login = async () => {
    const response = await request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });
    assert.equal(response.status, 303); cookie = response.headers.get('set-cookie').split(';')[0];
    const session = await jsonRequest('/api/auth/session', { headers: { Cookie: cookie } }); assert.equal(session.status, 200); binding = session.json.session_binding;
  };
  const upload = (key, fields = {}, extra = {}) => {
    const form = new FormData();
    for (const [name, value] of Object.entries({ portfolio_id: portfolio, account_id: account, expected_revision: '0', mapping, ...fields })) if (name !== 'bytes' && name !== 'filename') form.append(name, String(value));
    form.append('file', new Blob([fields.bytes ?? csv], { type: 'text/csv' }), fields.filename ?? 'synthetic-background.csv');
    return jsonRequest(endpoint, { method: 'POST', headers: headers({ Origin: origin, 'X-CSV-Idempotency-Key': key, 'X-CSV-Background-Acknowledged': 'true', ...extra }), body: form });
  };
  // Dispatch only CSV command types. Other HTTP suites may deliberately retain unrelated queued jobs.
  const worker = expectedRequest => {
    const script = `import json,sys
from worker.orchestration.db import open_database
from worker.orchestration.csv_imports import CSV_COMMANDS
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import sync_requests,command_handler
db=open_database(sys.argv[1])
try:
    sync_requests(db,command_types=CSV_COMMANDS)
    job=run_one(db,'synthetic-http-csv',command_handler(db,lease_seconds=300),job_type=CSV_COMMANDS,lease_seconds=300)
    if job is None or job['command_request_id']!=sys.argv[2]: raise RuntimeError('HTTP_CSV_UNEXPECTED_JOB')
    print(json.dumps({'id':job['id'],'request_id':job['command_request_id'],'status':job['status'],'attempt_count':job['attempt_count'],'result':json.loads(job['result_json'])}))
finally: db.close()
`;
    const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON || process.env.WORKBENCH_PYTHON || 'python3', ['-c', script, filename, expectedRequest], {
      cwd: root, env: { PATH: process.env.PATH, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: '1', TZ: 'UTC', WORKBENCH_DB_PATH: filename,
        WORKBENCH_DATA_DIR: path.join(directory, 'auth'), WORKBENCH_MODE: 'ledger' }, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error)); const job = JSON.parse(result.stdout);
    assert.equal(job.status, 'succeeded'); assert.equal(job.attempt_count, 1); return job;
  };
  try {
    await check('HTTP-CB01', 'CSV background authenticates before parsing, binds the current session and bounds multipart input', async () => {
      assert.equal((await jsonRequest(`${endpoint}?portfolio=a&portfolio=b`)).status, 401);
      assert.equal((await jsonRequest(endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' })).status, 401);
      await login();
      const portfolios = [];
      for (const name of ['Synthetic background CSV HTTP', 'Synthetic background CSV other scope']) {
        const created = await post('/api/workbench', { action: 'create_portfolio', name }); assert.equal(created.status, 200); portfolios.push(created.json.id);
      }
      [portfolio, foreign] = portfolios;
      const accounts = [];
      for (const selected of portfolios) {
        const created = await post('/api/workbench', { action: 'create_account', portfolio_id: selected, name: 'Synthetic CSV account', broker: 'Synthetic', currency: 'CNY' });
        assert.equal(created.status, 200); accounts.push(created.json.id);
      }
      [account, foreignAccount] = accounts;
      mapping = JSON.stringify({ schema_version: 'csv-import-mapping-v1', mapping_id: 'SYNTHETIC-HTTP-BACKGROUND', version: 1, title: 'Synthetic only',
        dialect: { encoding: 'utf-8', delimiter: ',', record_separator: 'either' }, expected_headers: ['date', 'amount', 'note'], ignored_columns: [],
        account: { kind: 'constant', value: account }, event_type: { kind: 'constant', value: 'deposit' }, source_id: 'synthetic-http-background', source_event_id: null,
        reason: { kind: 'column', column: 'note', trim: false, empty: 'reject' }, effective_at: { column: 'date', format: 'YYYY-MM-DD', trim: false, source_timezone: 'Asia/Shanghai' },
        rules: [{ event_type: 'deposit', fields: { currency: { kind: 'constant', value: 'CNY' }, amount: { kind: 'decimal', column: 'amount', empty: 'reject',
          format: { decimal_separator: '.', grouping_separator: 'none', negative_style: 'minus', allow_leading_plus: false, trim: false } } } }] });
      csv = Buffer.from('\ufeffdate,amount,note\r\n2026-01-01,1,Synthetic one\r\n2026-01-01,1,Synthetic two\r\n2026-01-01,1,Synthetic three\r\n');
      const before = counts();
      const empty = await get(); assert.equal(empty.status, 200); assert.deepEqual(empty.json.items, []); assert.equal(empty.json.session_binding, binding);
      assert.equal((await jsonRequest(`${endpoint}?portfolio=${portfolio}&portfolio=${foreign}`, { headers: headers() })).status, 400);
      assert.equal((await get({ unknown: 'rejected' })).status, 400);
      for (const value of ['', '0'.repeat(64)]) assert.equal((await get({}, { 'X-Workbench-Session-Binding': value })).status, 401);
      assert.equal((await upload('denied-origin', {}, { Origin: 'https://wrong.example.test' })).status, 403);
      assert.equal((await upload('denied-binding', {}, { 'X-Workbench-Session-Binding': '' })).status, 401);
      assert.equal((await upload('denied-ack', {}, { 'X-CSV-Background-Acknowledged': 'false' })).status, 400);
      assert.equal((await upload('denied-key', {}, { 'X-CSV-Idempotency-Key': '' })).status, 400);
      assert.equal((await jsonRequest(endpoint, { method: 'POST', headers: headers({ Origin: origin, 'Content-Type': 'application/json' }), body: '{"action":"cancel","action":"confirm"}' })).status, 400);
      assert.equal((await jsonRequest(endpoint, { method: 'POST', headers: headers({ Origin: origin, 'Content-Type': 'application/json' }), body: Buffer.from([0x7b, 0xff, 0x7d]) })).status, 400);
      const rejected = await probeEarlyRejection(address + endpoint, headers({ Origin: origin, 'Content-Type': 'multipart/form-data; boundary=synthetic', 'X-CSV-Idempotency-Key': 'oversize', 'X-CSV-Background-Acknowledged': 'true' }));
      assert.equal(rejected.status, 413); assert.equal(rejected.request_ended, false); assert.equal(rejected.response_complete, true); assert.deepEqual(counts(), before);
      return { multipart_limit_bytes: 5 * 1024 * 1024, auth_before_parsing: true, session_bound: true, implicit_jobs: 0 };
    });
    await check('HTTP-CB02', 'explicit multipart delegation freezes raw bytes, exact retries and query-only queued state', async () => {
      const accepted = await upload('http-preview'); assert.equal(accepted.status, 200, JSON.stringify(accepted.json)); previewRequest = accepted.json.request_id;
      assert.equal(accepted.json.status, 'queued'); assert.deepEqual((await upload('http-preview')).json, accepted.json);
      assert.equal((await upload('http-preview', { filename: 'changed.csv' })).status, 409);
      assert.equal((await upload('cross-account', { account_id: foreignAccount })).status, 403);
      const before = counts(), status = await get({ request: previewRequest }); assert.equal(status.status, 200); assert.equal(status.json.item.status, 'queued'); assert.equal(status.json.item.job, null); assert.equal(status.json.item.result, null);
      assert.equal((await get({ request: previewRequest, view: 'rows' })).status, 409);
      assert.equal((await get({ portfolio: foreign, request: previewRequest })).status, 404); assert.deepEqual(counts(), before);
      read(db => {
        const stored = db.prepare('SELECT * FROM csv_background_requests WHERE id=?').get(previewRequest);
        assert.deepEqual(stored.csv_bytes, csv); assert.equal(JSON.parse(stored.input_json).mapping, mapping); assert.equal(JSON.parse(stored.input_json).csv_sha256, sha(csv));
        assert.equal(db.prepare('SELECT count(*) n FROM csv_confirmation_attempts WHERE portfolio_id=?').get(portfolio).n, 0);
      });
      assert.deepEqual(before, { requests: 1, jobs: 0, batches: 0, facts: 0, results: 0 });
      return { request_id: previewRequest, original_csv_sha256: sha(csv), identical_retry_same_request: true, GET_dispatches: false };
    });
    await check('HTTP-CB03', 'real CSV-only Python dispatcher and fixed Node preview yield scoped row and candidate pages', async () => {
      const job = worker(previewRequest), status = await get({ request: previewRequest }); assert.equal(status.status, 200, JSON.stringify(status.json)); preview = status.json.item.result;
      assert.equal(status.json.item.status, 'succeeded'); assert.equal(preview.row_count, 3); assert.equal(preview.required_review_count, 3); assert.equal(counts().facts, 0);
      const metadata = await get({ request: previewRequest, view: 'preview' }); assert.equal(metadata.status, 200);
      assert.equal(metadata.json.preview.batch_status, 'preview'); assert.equal(metadata.json.preview.current_revision, 0); assert.equal(metadata.json.preview.confirmed_revision, null);
      const first = await get({ request: previewRequest, view: 'rows', limit: '1' }); assert.equal(first.status, 200); assert.equal(first.json.items.length, 1); assert.equal(first.json.items[0].row, 1); assert.ok(first.json.next_cursor);
      const second = await get({ request: previewRequest, view: 'rows', limit: '1', cursor: first.json.next_cursor }); assert.equal(second.status, 200); assert.equal(second.json.items[0].row, 2);
      assert.equal((await get({ request: previewRequest, view: 'candidates', row: '3', kind: 'exact_prior_rows', cursor: first.json.next_cursor })).status, 400);
      const candidates = await get({ request: previewRequest, view: 'candidates', row: '3', kind: 'exact_prior_rows', limit: '1' });
      assert.equal(candidates.status, 200); assert.equal(candidates.json.total, 2); assert.deepEqual(candidates.json.items, [1]); assert.ok(candidates.json.next_cursor);
      const next = await get({ request: previewRequest, view: 'candidates', row: '3', kind: 'exact_prior_rows', limit: '1', cursor: candidates.json.next_cursor }); assert.deepEqual(next.json.items, [2]);
      assert.equal((await get({ portfolio: foreign, request: previewRequest, view: 'rows', cursor: first.json.next_cursor })).status, 404);
      assert.equal((await get({ request: previewRequest, view: 'receipts' })).status, 409);
      assert.equal(first.headers.get('cache-control'), 'private, no-store'); assert.equal(first.json.result_hash, status.json.item.result_hash);
      return { job_id: job.id, actual_fixed_publisher: true, source_rows: 3, preview_facts: 0, row_page_size: 1, candidate_page_size: 1 };
    });
    await check('HTTP-CB04', 'explicit original confirmation and fixed worker atomically publish three facts with paged actual receipts', async () => {
      const review = { acknowledge_unverified_mapping: true, review_hash: preview.review_hash, rows: [1, 2, 3].map(row => ({ row, action: 'record_distinct', reason: 'Synthetic independent deposits explicitly reviewed' })) };
      const payload = { action: 'confirm_import', portfolio_id: portfolio, batch_id: preview.batch_id, preview_hash: preview.preview_hash, expected_revision: 0, csv_review: review };
      assert.equal((await post('/api/workbench', payload)).status, 409);
      assert.equal((await post('/api/workbench', { ...payload, portfolio_id: foreign })).status, 404);
      rawPayload = '\ufeff' + JSON.stringify(payload, null, 2) + '\n';
      const command = { portfolio_id: portfolio, account_id: account, idempotency_key: 'http-confirm', payload_text: rawPayload, acknowledge_background_execution: true };
      const accepted = await post(endpoint, { action: 'confirm', command }); assert.equal(accepted.status, 200, JSON.stringify(accepted.json)); confirmation = accepted.json.request_id;
      assert.deepEqual((await post(endpoint, { action: 'confirm', command })).json, accepted.json);
      assert.equal((await post(endpoint, { action: 'confirm', command: { ...command, payload_text: rawPayload + ' ' } })).status, 409); assert.equal(counts().facts, 0);
      recoveryId = read(db => db.prepare('SELECT confirmation_attempt_id FROM csv_background_requests WHERE id=?').get(confirmation).confirmation_attempt_id);
      const recovered = await jsonRequest(`/api/workbench/csv/recovery?id=${recoveryId}`, { headers: headers() }); assert.equal(recovered.status, 200); assert.equal(recovered.json.payload_text, rawPayload);
      const job = worker(confirmation), status = await get({ request: confirmation }); assert.equal(status.status, 200, JSON.stringify(status.json)); assert.equal(status.json.item.result.confirmed_revision, 3);
      const receipts = [], cursors = []; let cursor;
      do {
        const page = await get({ request: confirmation, view: 'receipts', limit: '1', ...(cursor ? { cursor } : {}) }); assert.equal(page.status, 200); assert.equal(page.json.items.length, 1);
        receipts.push(...page.json.items.map(item => item.receipt)); cursor = page.json.next_cursor; if (cursor) cursors.push(cursor);
      } while (cursor);
      assert.equal(receipts.length, 3); assert.equal(new Set(receipts.map(value => value.event_id)).size, 3); assert.equal(counts().facts, 3);
      assert.equal((await get({ request: previewRequest, view: 'rows', cursor: cursors[0] })).status, 400);
      assert.equal((await post(endpoint, { action: 'cancel', command: { portfolio_id: portfolio, request_id: confirmation, reason: 'Too late synthetic cancel' } })).status, 409);
      read(db => { assert.equal(db.prepare('SELECT count(*) n FROM csv_import_outcomes WHERE batch_id=?').get(preview.batch_id).n, 3); assert.equal(db.prepare('SELECT revision FROM ledger_heads WHERE portfolio_id=?').get(portfolio).revision, 3); });
      return { job_id: job.id, original_payload_sha256: sha(rawPayload), actual_receipts: 3, actual_facts: 3, atomic_revision: 3, receipts_hash: status.json.item.result.receipts_hash };
    });
    await check('HTTP-CB05', 'logout does not revoke accepted delegation; a new session gets limited history and cancellation, not raw recovery', async () => {
      const queued = await upload('durable-after-logout', { expected_revision: '3', bytes: Buffer.from('date,amount,note\n2026-01-02,2,Synthetic durable\n') }); assert.equal(queued.status, 200);
      const pending = await upload('cancel-across-session', { expected_revision: '3', bytes: Buffer.from('date,amount,note\n2026-01-03,3,Synthetic cancelled\n') }); assert.equal(pending.status, 200);
      const oldCookie = cookie, oldBinding = binding;
      assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status, 303);
      assert.equal((await get({ request: confirmation })).status, 401);
      const completed = worker(queued.json.request_id); assert.equal(completed.status, 'succeeded'); assert.equal(counts().facts, 3);
      await login(); assert.notEqual(binding, oldBinding);
      const history = await get({ request: confirmation }); assert.equal(history.status, 200); assert.equal(history.json.item.status, 'succeeded');
      assert.equal(JSON.stringify(history.json).includes('payload_text'), false); assert.equal(JSON.stringify(history.json).includes('csv_bytes'), false);
      assert.equal((await jsonRequest(`/api/workbench/csv/recovery?id=${recoveryId}`, { headers: headers() })).status, 404);
      assert.equal((await get({}, { Cookie: oldCookie, 'X-Workbench-Session-Binding': oldBinding })).status, 401);
      assert.equal((await get({}, { 'X-Workbench-Session-Binding': oldBinding })).status, 401);
      const cancelled = await post(endpoint, { action: 'cancel', command: { portfolio_id: portfolio, request_id: pending.json.request_id, reason: 'Explicit cancellation from a new session' } }); assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
      const status = await get({ request: pending.json.request_id }); assert.equal(status.json.item.status, 'cancelled'); assert.equal(status.json.item.result, null);
      assert.equal((await get({ request: queued.json.request_id })).json.item.status, 'succeeded');
      return { durable_completed_after_logout: true, new_session_private_status: true, original_payload_cross_session: 404, old_session: 401, cancelled_request: pending.json.request_id };
    });
    await check('HTTP-CB06', 'recovery mode preserves verified private pages but forbids new authorization and scoped cancellation', async () => {
      const before = counts(), marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic CSV HTTP readonly check\n');
      try {
        const list = await get(); assert.equal(list.status, 200); assert.equal(list.json.read_only, true);
        const status = await get({ request: confirmation }); assert.equal(status.status, 200); assert.equal(status.json.read_only, true);
        const receipts = await get({ request: confirmation, view: 'receipts', limit: '1' }); assert.equal(receipts.status, 200); assert.equal(receipts.json.read_only, true);
        const metadata = await get({ request: previewRequest, view: 'preview' }); assert.equal(metadata.status, 200); assert.equal(metadata.json.read_only, true);
        assert.equal((await upload('readonly', { expected_revision: '3' })).status, 423);
        assert.equal((await post(endpoint, { action: 'cancel', command: { portfolio_id: portfolio, request_id: previewRequest, reason: 'No recovery writes' } })).status, 423);
        assert.equal((await get({ portfolio: foreign, request: confirmation })).status, 404);
        assert.deepEqual(counts(), before);
      } finally { rmSync(marker); }
      const list = await get({ limit: '1' }); assert.equal(list.status, 200); assert.equal(list.json.items.length, 1); assert.ok(list.json.next_cursor);
      assert.equal((await get({ portfolio: foreign, cursor: list.json.next_cursor })).status, 400);
      read(db => { assert.equal(db.pragma('quick_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []); });
      return { readonly_private_reads: true, readonly_write_status: 423, cross_portfolio_detail: 404, cursor_cross_scope: 400, quick_check: 'ok' };
    });
    await check('HTTP-CB07', 'proved preview metadata distinguishes current batch from immutable result and review-only keysets stay filter bound', async () => {
      const before = counts(), metadata = await get({ request: previewRequest, view: 'preview' });
      assert.equal(metadata.status, 200); assert.equal(metadata.json.session_binding, binding); assert.equal(metadata.json.view, 'preview');
      assert.equal(metadata.json.preview.batch_status, 'confirmed'); assert.equal(metadata.json.preview.confirmed_revision, 3); assert.equal(metadata.json.preview.current_revision, 3);
      assert.equal(metadata.json.preview.expected_revision, 0); assert.equal(metadata.json.preview.content_hash, sha(csv)); assert.equal(metadata.json.preview.mapping_attachment_hash, sha(mapping));
      assert.deepEqual(metadata.json.preview.headers, ['date', 'amount', 'note']); assert.equal(metadata.json.preview.broker_format_verified, false);
      assert.equal(metadata.json.preview.required_review_count, 3); assert.equal(metadata.json.preview.error_count, 0);
      assert.equal((await get({ request: previewRequest })).json.item.result.batch_status, 'preview');
      assert.doesNotMatch(JSON.stringify(metadata.json), /required_review_rows|"candidates"|payload_text|csv_bytes|input_json|session_hash/);
      const first = await get({ request: previewRequest, view: 'rows', review_only: 'true', limit: '1' });
      assert.equal(first.status, 200); assert.equal(first.json.review_only, true); assert.equal(first.json.total, 3); assert.equal(first.json.items[0].missing_source_id, true);
      assert.deepEqual(first.json.items[0].candidate_counts, { exact_event_ids: 0, possible_event_ids: 0, exact_prior_rows: 0, possible_prior_rows: 0 });
      const second = await get({ request: previewRequest, view: 'rows', review_only: 'true', limit: '1', cursor: first.json.next_cursor });
      assert.equal(second.status, 200); assert.equal(second.json.items[0].row, 2); assert.equal(second.json.items[0].candidate_counts.exact_prior_rows, 1);
      assert.equal(second.json.items[0].requires_review, true); assert.equal(second.json.result_hash, first.json.result_hash);
      assert.equal((await get({ request: previewRequest, view: 'rows', review_only: 'false', cursor: first.json.next_cursor })).status, 400);
      assert.equal((await get({ request: previewRequest, view: 'rows', cursor: first.json.next_cursor })).status, 400);
      for (const query of [{ view: 'preview', limit: '1' }, { view: 'preview', review_only: 'false' }, { view: 'rows', review_only: '1' }]) assert.equal((await get({ request: previewRequest, ...query })).status, 400);
      assert.equal((await get({ portfolio: foreign, request: previewRequest, view: 'preview' })).status, 404);
      assert.deepEqual(counts(), before);
      return { metadata_proof_required: true, current_batch_status: 'confirmed', immutable_preview_result_status: 'preview', current_revision: 3,
        review_only_total: 3, bounded_row_count: 1, filter_cursor_mismatch: 400, cross_portfolio: 404, GET_dispatches: false };
    });
  } finally {
    if (cookie) await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
  }
}
