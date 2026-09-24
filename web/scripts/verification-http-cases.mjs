import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const endpoint = '/api/workbench/verifications';
const checkId = 'E-02.cash-contribution-neutrality.v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verificationHttpCases({ check, request, jsonRequest, filename, directory, root, output, origin, password, Database }) {
  let cookie, binding, portfolio, otherPortfolio, command, receipt, execution, workerJob, downloaded;
  const sessions = [];
  const headers = (extra = {}) => ({ Cookie: cookie, 'X-Workbench-Session-Binding': binding, ...extra });
  const state = (query = `portfolio=${portfolio}`, extra = {}) => jsonRequest(`${endpoint}?${query}`, { headers: headers(extra) });
  const post = (value = command, extra = {}, query = '') => jsonRequest(endpoint + query, {
    method: 'POST', headers: headers({ Origin: origin, 'Content-Type': 'application/json', ...extra }), body: JSON.stringify({ command: value }),
  });
  const artifact = (selected = portfolio, extra = {}) => request(`${endpoint}?portfolio=${selected}&artifact=${execution.artifact_id}`, { headers: headers(extra) });
  const read = operation => {
    const db = new Database(filename, { readonly: true });
    try { return operation(db); } finally { db.close(); }
  };
  const snapshot = (only = null) => read(db => {
    db.defaultSafeIntegers(true);
    return db.transaction(() => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const content = tables.filter(({ name }) => only === null || only.includes(name)).map(({ name }) => {
        const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).raw().all().map(row => JSON.stringify(row.map(value =>
          typeof value === 'bigint' ? ['integer', value.toString()] : Buffer.isBuffer(value) ? ['blob', value.toString('base64')] : [typeof value, value]))).sort();
        return { name, rows };
      });
      return { sha256: sha(JSON.stringify(content)), counts: Object.fromEntries(content.map(({ name, rows }) => [name, rows.length])) };
    }).deferred();
  });
  const financial = () => snapshot(['ledger_events', 'postings', 'ledger_heads', 'valuation_runs', 'valuation_items', 'performance_runs',
    'policy_versions', 'strategy_versions', 'activations', 'proposals', 'proposal_items']);
  const privateHeaders = response => {
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('vary')?.toLowerCase().split(',').map(value => value.trim()).includes('cookie'));
  };
  const login = async () => {
    const response = await request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password }).toString() });
    assert.equal(response.status, 303);
    const value = (response.headers.get('set-cookie') ?? '').split(';')[0]; assert.ok(value); sessions.push(value);
    const probe = await jsonRequest('/api/auth/session', { headers: { Cookie: value } });
    assert.equal(probe.status, 200); assert.equal(probe.json.authenticated, true); assert.match(probe.json.session_binding, /^[a-f0-9]{64}$/);
    return { cookie: value, binding: probe.json.session_binding };
  };
  try {
    await check('HTTP-VF01', 'verification authenticates before parsing and exposes only a fixed synthetic engineering subcheck', async () => {
      assert.equal((await request('/workbench/verifications')).headers.get('location'), '/login');
      assert.equal((await jsonRequest(`${endpoint}?portfolio=a&portfolio=b`)).status, 401);
      const denied = await jsonRequest(endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' });
      assert.equal(denied.status, 401); assert.deepEqual(denied.json, { error: 'UNAUTHENTICATED' });
      ({ cookie, binding } = await login());
      const created = [];
      for (const name of ['Synthetic controlled verification HTTP only', 'Synthetic verification cross-scope HTTP only']) {
        const result = await jsonRequest('/api/workbench', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create_portfolio', name }) });
        assert.equal(result.status, 200, JSON.stringify(result.json)); created.push(result.json.id);
      }
      [portfolio, otherPortfolio] = created;
      const initial = await jsonRequest(`${endpoint}?portfolio=${portfolio}`, { headers: { Cookie: cookie } });
      assert.equal(initial.status, 200); privateHeaders(initial);
      assert.equal(initial.json.session_binding, binding); assert.equal(initial.json.selected_portfolio_id, portfolio);
      assert.equal(initial.json.check.id, checkId); assert.equal(initial.json.check.available, true, JSON.stringify(initial.json.check));
      assert.equal(initial.json.check.data_provenance, 'synthetic'); assert.equal(initial.json.check.acceptance_scope, 'engineering_subcheck');
      assert.equal(initial.json.check.gate_eligible, false); assert.deepEqual(initial.json.requests, []);
      const page = await request('/workbench/verifications', { headers: { Cookie: cookie } }); assert.equal(page.status, 200);
      assert.match(await page.text(), /验证|verification/i);
      command = { portfolio_id: portfolio, check_id: checkId, expected_context_hash: initial.json.check.context_hash,
        reason: 'Synthetic controlled HTTP fixture; not investment authorization', idempotency_key: 'http-controlled-verification-v2' };
      return { check_id: checkId, source_available: true, gate_eligible: false, acceptance_scope: 'engineering_subcheck' };
    });
    await check('HTTP-VF02', 'missing or stale session binding, Origin, query and claimed authority fail without database writes', async () => {
      const before = snapshot();
      for (const value of ['', '0'.repeat(64)]) {
        const denied = await post(command, { 'X-Workbench-Session-Binding': value });
        assert.equal(denied.status, 401); assert.equal(denied.json.error, 'SESSION_CHANGED');
      }
      const foreignOrigin = await post(command, { Origin: 'https://evil.example.test' }); assert.equal(foreignOrigin.status, 403);
      const queryWrite = await post(command, {}, '?portfolio=ignored'); assert.equal(queryWrite.status, 400);
      for (const claimed of [{ actor_id: 'system:forged' }, { status: 'pass' }, { execution_authority: 'controlled_runner' }]) {
        assert.equal((await post({ ...command, ...claimed })).status, 400);
      }
      assert.equal((await post({ ...command, check_id: 'E-02' })).status, 400);
      assert.equal((await post({ ...command, expected_context_hash: '0'.repeat(64) })).status, 409);
      for (const query of [`portfolio=${portfolio}&portfolio=${otherPortfolio}`, `portfolio=${portfolio}&limit=51`, `portfolio=${portfolio}&artifact=missing&request=missing`]) {
        assert.equal((await state(query)).status, 400);
      }
      assert.deepEqual(snapshot(), before);
      return { missing_binding: 401, stale_binding: 401, foreign_origin: 403, client_pass_rejected: true, database_unchanged: true };
    });
    await check('HTTP-VF03', 'normal human HTTP request dispatches the dedicated real verifier without writing financial results into the request database', async () => {
      const response = await post(); assert.equal(response.status, 200, JSON.stringify(response.json)); privateHeaders(response);
      receipt = response.json; assert.equal(receipt.status, 'queued'); assert.equal(receipt.session_binding, binding);
      const replay = await post(); assert.equal(replay.status, 200); assert.deepEqual(replay.json, receipt);
      const authority = read(db => db.prepare(`SELECT r.requested_by,r.context_json,c.actor_id,c.command_type,a.payload_json,a.ledger_revision
        FROM verification_requests r JOIN command_requests c ON c.id=r.id JOIN audit_events a ON a.id=r.audit_id WHERE r.id=?`).get(receipt.request_id));
      assert.equal(authority.requested_by, 'owner'); assert.equal(authority.actor_id, 'system:governance-verifier-v2');
      assert.equal(authority.command_type, 'governance_verification_v2'); assert.equal(authority.ledger_revision, null);
      assert.equal(JSON.parse(authority.payload_json).actor_kind, 'human'); assert.equal(JSON.parse(authority.context_json).schema_version, 'verification-context-v2');
      assert.equal(read(db => db.prepare('SELECT count(*) n FROM verification_executions WHERE request_id=?').get(receipt.request_id).n), 0);
      const before = financial();
      const worker = spawnSync(process.env.WORKBENCH_TEST_PYTHON || process.env.WORKBENCH_PYTHON || 'python3',
        ['-m', 'worker.orchestration', '--db', filename, '--once', '--role', 'verifier'], {
          cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, TMPDIR: directory, TMP: directory, TEMP: directory,
            LANG: 'C.UTF-8', TZ: 'UTC', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', WORKBENCH_MODE: 'ledger', WORKBENCH_DATA_DIR: path.join(directory, 'auth') },
          encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
        });
      assert.equal(worker.status, 0, worker.error?.message ?? worker.stderr); assert.equal(worker.signal, null);
      const workerReceipt = JSON.parse(worker.stdout);
      assert.deepEqual(Object.keys(workerReceipt).sort(), ['job_id', 'status']);
      assert.equal(typeof workerReceipt.job_id, 'string'); assert.ok(workerReceipt.job_id.length > 0);
      assert.equal(workerReceipt.status, 'succeeded');
      workerJob = read(db => db.prepare('SELECT * FROM job_runs WHERE id=?').get(workerReceipt.job_id));
      assert.ok(workerJob, 'The CLI receipt must identify the persisted controlled job.');
      assert.equal(workerJob.id, workerReceipt.job_id); assert.equal(workerJob.job_type, 'governance_verification_v2');
      assert.equal(workerJob.command_request_id, receipt.request_id); assert.equal(workerJob.scope, portfolio);
      assert.equal(workerJob.status, workerReceipt.status); assert.equal(workerJob.lease_owner, null); assert.equal(workerJob.lease_until, null);
      const attempt = read(db => db.prepare('SELECT * FROM job_attempts WHERE job_id=? AND attempt=? AND fencing_token=?')
        .get(workerJob.id, workerJob.attempt_count, workerJob.fencing_token));
      assert.ok(attempt); assert.equal(attempt.status, 'succeeded'); assert.equal(attempt.finished_at, workerJob.updated_at);
      assert.deepEqual(financial(), before);
      return { command_type: workerJob.job_type, dedicated_role: 'verifier', human_actor: authority.requested_by,
        status: workerJob.status, financial_tables_unchanged: true, injected_pass: false };
    });
    await check('HTTP-VF04', 'HTTP independently verifies retained execution and downloads exactly the immutable bounded artifact bytes', async () => {
      const result = await state(`portfolio=${portfolio}&request=${receipt.request_id}`); assert.equal(result.status, 200, JSON.stringify(result.json));
      assert.equal(result.json.requests.length, 1);
      const item = result.json.requests[0]; assert.deepEqual(item.evidence_issues, []); assert.equal(item.job_status, 'succeeded');
      execution = item.execution; assert.equal(execution.status, 'pass'); assert.equal(execution.current_runtime_match, true);
      assert.equal(execution.execution_authority, 'controlled_runner'); assert.equal(execution.data_provenance, 'synthetic');
      assert.equal(execution.acceptance_scope, 'engineering_subcheck'); assert.equal(execution.result.gate_eligible, false);
      assert.deepEqual(execution.result.completed_requirements, []); assert.deepEqual(execution.result.issues, []);
      assert.equal(execution.result.assertions.length, 6); assert.ok(execution.result.assertions.every(row => row.status === 'pass'));
      const response = await artifact(); assert.equal(response.status, 200); privateHeaders(response);
      assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.equal(response.headers.get('content-disposition'), 'attachment; filename="verification-artifact.json"');
      assert.equal(response.headers.get('x-workbench-session-binding'), binding);
      downloaded = Buffer.from(await response.arrayBuffer()); assert.ok(downloaded.length > 0 && downloaded.length <= 1048576);
      assert.equal(sha(downloaded), execution.artifact_sha256); assert.equal(response.headers.get('x-artifact-sha256'), execution.artifact_sha256);
      const retained = read(db => db.prepare('SELECT body,body_sha256 FROM verification_artifacts WHERE id=?').get(execution.artifact_id));
      assert.deepEqual(downloaded, retained.body); assert.equal(retained.body_sha256, sha(downloaded));
      const body = JSON.parse(downloaded.toString('utf8'));
      assert.equal(body.check_id, checkId); assert.equal(body.data_provenance, 'synthetic'); assert.notEqual(body.fixture.portfolio_id, portfolio);
      assert.equal(body.binding.request_id, receipt.request_id); assert.equal(body.binding.job_id, workerJob.id);
      assert.deepEqual(body.ledger.events.map(row => row.event_type), ['opening_cash', 'deposit']);
      assert.deepEqual(body.valuations.map(row => row.run.nav_cny), ['100.25', '150.375']);
      assert.equal(JSON.parse(body.performance.run.result_json).net_profit_cny, '0');
      writeFileSync(path.join(output, 'controlled-verification-artifact.json'), downloaded);
      return { artifact_sha256: sha(downloaded), artifact_bytes: downloaded.length, independent_http_proof: true,
        exact_database_bytes: true, gate_eligible: false, completed_requirements: [] };
    });
    await check('HTTP-VF05', 'cross-scope detail and artifact downloads, stale hashes and conflicting retries cannot disclose or mutate evidence', async () => {
      const before = snapshot();
      assert.equal((await state(`portfolio=${otherPortfolio}&request=${receipt.request_id}`)).status, 404);
      const wrongScope = await artifact(otherPortfolio); assert.equal(wrongScope.status, 404);
      assert.doesNotMatch(await wrongScope.text(), new RegExp(execution.artifact_sha256));
      for (const supplied of ['', '0'.repeat(64)]) {
        const denied = await artifact(portfolio, { 'X-Workbench-Session-Binding': supplied }); assert.equal(denied.status, 401);
        assert.equal(denied.headers.get('x-artifact-sha256'), null);
      }
      assert.equal((await state(undefined, { 'X-Workbench-Session-Binding': '0'.repeat(64) })).status, 401);
      assert.equal((await post({ ...command, reason: 'Conflicting synthetic retry' })).status, 409);
      assert.equal((await post({ ...command, expected_context_hash: '0'.repeat(64), idempotency_key: 'http-verification-stale-context' })).status, 409);
      const replay = await post(); assert.equal(replay.status, 200); assert.equal(replay.json.request_id, receipt.request_id);
      assert.deepEqual(snapshot(), before);
      return { cross_scope_detail: 404, cross_scope_artifact: 404, stale_session_artifact: 401, idempotency_conflict: 409, exact_retry: true, database_unchanged: true };
    });
    await check('HTTP-VF06', 'session replacement rejects old bindings and revoked cookies without exposing or recreating controlled evidence', async () => {
      const before = snapshot(), oldCookie = cookie, oldBinding = binding;
      ({ cookie, binding } = await login()); assert.notEqual(binding, oldBinding);
      assert.equal((await post(command, { 'X-Workbench-Session-Binding': oldBinding })).status, 401);
      assert.equal((await artifact(portfolio, { 'X-Workbench-Session-Binding': oldBinding })).status, 401);
      const current = await state(); assert.equal(current.status, 200); assert.equal(current.json.session_binding, binding);
      const replay = await post(); assert.equal(replay.status, 200); assert.equal(replay.json.request_id, receipt.request_id);
      assert.equal(replay.json.session_binding, binding);
      const logout = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: oldCookie, Origin: origin } }); assert.equal(logout.status, 303);
      for (const query of [`portfolio=${portfolio}`, `portfolio=${portfolio}&artifact=${execution.artifact_id}`]) {
        const denied = await jsonRequest(`${endpoint}?${query}`, { headers: { Cookie: oldCookie, 'X-Workbench-Session-Binding': oldBinding } });
        assert.equal(denied.status, 401); assert.deepEqual(denied.json, { error: 'UNAUTHENTICATED' });
      }
      assert.equal((await post(command, { Cookie: oldCookie, 'X-Workbench-Session-Binding': oldBinding })).status, 401);
      assert.equal((await state()).status, 200);
      assert.deepEqual(snapshot(), before);
      return { replacement_binding_rejected: 401, revoked_cookie_rejected: 401, new_session_exact_retry: true, database_unchanged: true };
    });
    await check('HTTP-VF07', 'recovery preserves verified private reads and exact downloads while preventing new verification requests', async () => {
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'), before = snapshot(); assert.equal(existsSync(marker), false);
      writeFileSync(marker, 'Synthetic controlled verification recovery check\n');
      try {
        const readonly = await state(); assert.equal(readonly.status, 200); assert.equal(readonly.json.read_only, true);
        assert.equal(readonly.json.requests[0].execution.status, 'pass');
        const response = await artifact(); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), downloaded);
        const denied = await post({ ...command, idempotency_key: 'http-verification-readonly-denied' });
        assert.equal(denied.status, 423); assert.equal(denied.json.error, 'WORKBENCH_READ_ONLY');
      } finally { rmSync(marker, { force: true }); }
      assert.deepEqual(snapshot(), before);
      assert.equal(read(db => db.prepare('SELECT count(*) n FROM verification_requests WHERE portfolio_id=?').get(portfolio).n), 1);
      assert.equal(read(db => db.prepare('SELECT count(*) n FROM verification_executions WHERE request_id=?').get(receipt.request_id).n), 1);
      return { recovery_write_denied: 423, private_read_allowed: true, exact_artifact_retained: true, requests: 1, executions: 1 };
    });
  } finally {
    for (const value of sessions) {
      await request('/api/auth/logout', { method: 'POST', headers: { Cookie: value, Origin: origin } }).catch(() => {});
    }
  }
}
