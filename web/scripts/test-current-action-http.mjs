import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateWorkbench } from '../../scripts/migrate-workbench.mjs';
import { runHttpFixture } from './http-fixture-process.mjs';

const web = fileURLToPath(new URL('../', import.meta.url)), root = path.dirname(web.replace(/\/$/, ''));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 1 && ['--serve', '--serve-pending', '--recovery', '--serve-recovery'].includes(args[0]), 'Only fixed fixture modes are accepted; database, origin and clocks are never caller inputs.');
const pending = args[0] === '--serve-pending', serve = args[0]?.startsWith('--serve'), recovery = args[0]?.includes('recovery') ?? false;
const output = path.join(root, 'artifacts/verification/current-action-http', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true });
const report = { status: 'RUNNING', started_at: new Date().toISOString(), actual_application_clock: true, fictional_sources: true,
  mode: recovery ? 'unchanged-recovery' : 'new-actions',
  current_report_fixture_collected: false,
  build_performed: false, build_id: readFileSync(path.join(web, '.next/BUILD_ID'), 'utf8').trim(), cases: [],
  limitations: ['Uses retained fictional issuer/EODHD transports and explicit fictional tax assumptions, not real-source certification.',
    'Historical fixture transport clocks are confined to source construction. HTTP handlers and default core use the real system clock.',
    'This exercises ordinary action review, not a legacy compatibility migration, current model prices, full v2 or trading.',
    'Reuses an existing production build and a locally generated pinned TLS certificate, not production TLS or native-browser acceptance.'] };
function inventory() {
  const names = ['tests/investor/current_action_fixture.py', 'web/scripts/test-current-action-http.mjs'];
  function scan(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory() && entry.name !== '__pycache__') scan(name);
      else if (entry.isFile() && /\.(?:py|ts|tsx|json|sql)$/.test(name)) names.push(name);
    }
  }
  for (const name of ['worker/investor', 'web/src', 'migrations', 'contracts']) scan(name);
  return Object.fromEntries(names.sort().map(name => [name, createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex')]));
}
report.source_files = inventory();
async function check(name, action) { const evidence = await action(); report.cases.push({ name, status: 'PASS', evidence: evidence ?? null }); console.log('PASS ' + name); }
let directory, server, proxy, logs = '', password, tick, ticking = false, tickWork = Promise.resolve();
try {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  assert.ok(pending || Number(parts.find(part => part.type === 'hour').value) >= 1, 'ACCEPTANCE_WAITING_FOR_NY_01: no early report or clock override.');
  directory = mkdtempSync(path.join(tmpdir(), 'etf-action-review-http-'));
  const filename = path.join(directory, 'workbench.db'); migrateWorkbench(filename);
  const Database = createRequire(path.join(web, 'package.json'))('better-sqlite3');
  const read = operation => { const db = new Database(filename, { readonly: true }); try { return operation(db); } finally { db.close(); } };
  const financial = () => read(db => Object.fromEntries(['portfolios', 'accounts', 'ledger_events', 'postings', 'position_movements', 'approval_events', 'activations', 'reservations', 'execution_reports']
    .map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n])));
  async function fixture(stage) {
    const value = await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3',
      ['-m', 'tests.investor.current_action_fixture', '--db', filename, '--stage', stage],
      { cwd: root, timeout: 120000, encoding: 'utf8', maxBuffer: 65536,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } });
    assert.equal(value.status, 0, `Fixture ${stage} failed: ${value.stderr}`); return JSON.parse(value.stdout);
  }
  await fixture('prepare'); const current = pending ? null : await fixture(recovery ? 'recovery' : 'reports');
  report.current_report_fixture_collected = !pending;
  password = randomBytes(24).toString('base64url'); const salt = randomBytes(16);
  const passwordHash = `scrypt$32768$8$1$${salt.toString('base64url')}$${scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url')}`;
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const keyPath = path.join(directory, 'tls.key'), certPath = path.join(directory, 'tls.crt');
  const tls = await runHttpFixture('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  assert.equal(tls.status, 0, 'Local TLS certificate generation failed.'); chmodSync(keyPath, 0o600);
  const certificate = readFileSync(certPath);
  proxy = https.createServer({ key: readFileSync(keyPath), cert: certificate }, (incoming, outgoing) => {
    const upstream = http.request({ hostname: '127.0.0.1', port, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, 'x-forwarded-proto': 'https' } }, response => {
      outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
    });
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); incoming.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = `https://127.0.0.1:${proxy.address().port}`, origin = address;
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: web, env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', WORKBENCH_DB_PATH: filename,
      WORKBENCH_DATA_DIR: path.join(directory, 'auth'), WORKBENCH_PASSWORD_HASH: passwordHash,
      WORKBENCH_SESSION_SECRET: randomBytes(48).toString('base64url'), WORKBENCH_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-16000); }); server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
  const request = (url, init = {}) => new Promise((resolve, reject) => {
    const outgoing = https.request(address + url, { ca: certificate, rejectUnauthorized: true,
      method: init.method ?? 'GET', headers: init.headers ?? {} }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 4194304) outgoing.destroy(new Error('LOCAL_RESPONSE_LIMIT')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    outgoing.on('error', reject); outgoing.setTimeout(30000, () => outgoing.destroy(new Error('LOCAL_TLS_TIMEOUT'))); outgoing.end(init.body);
  });
  let ready = false;
  for (let index = 0; index < 200; index++) {
    assert.equal(server.exitCode, null, 'Server exited before readiness.');
    try { if ((await request('/api/health')).ok) { ready = true; break; } } catch { /* Listener not ready. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Server readiness timeout.');
  let cookie, binding;
  const jsonRequest = async (url, init = {}) => { const response = await request(url, init); return { status: response.status, json: await response.json(), headers: response.headers }; };
  const login = await request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });
  assert.equal(login.status, 303); cookie = login.headers.get('set-cookie').split(';')[0];
  const session = await jsonRequest('/api/auth/session', { headers: { Cookie: cookie } }); assert.equal(session.status, 200); binding = session.json.session_binding;
  const headers = { Cookie: cookie, 'X-Workbench-Session-Binding': binding };
  const post = (url, body, extra = {}) => jsonRequest(url, { method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const profile = { schema_version: 'investor-profile-v1', horizon_years: 12, loss_tolerance: '0.30', liquidity_need: 'none_in_horizon', markets: ['US'],
    product_scope: 'unleveraged_long_only_etfs', research_direction: 'system_design', exclusions: [], illustrative_budget_cny: null, planned_annual_contribution_cny: null };
  const saved = await post('/api/workbench/investor', { action: 'save_profile', expected_revision: 0, idempotency_key: 'fictional-current-http-profile', profile });
  assert.equal(saved.status, 200); await fixture('work');
  const route = '/api/workbench/investor/' + (recovery ? 'action-recovery' : 'action-review');
  const get = query => jsonRequest(route + (query ?? ''), { headers });
  const unwrap = value => recovery ? value.review : value;
  if (serve) {
    const info = path.join(directory, 'browser.json');
    writeFileSync(info, JSON.stringify({ address, origin, password, db: filename, current, pid: process.pid }), { mode: 0o600 });
    tick = setInterval(() => {
      if (ticking) return; ticking = true;
      tickWork = fixture('tick').catch(error => { report.background_error = error.message; }).finally(() => { ticking = false; });
    }, 3000);
    console.log('PRIVATE_BROWSER_FIXTURE: ' + info);
    await new Promise(resolve => { const timeout = setTimeout(resolve, 25 * 60 * 1000); const stop = () => { clearTimeout(timeout); resolve(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
    clearInterval(tick); await tickWork;
    assert.equal(report.background_error, undefined); report.status = 'SERVED_NOT_NATIVE_ACCEPTED';
  } else {
    const baseline = financial(); let previewBody, confirmationBody, previewId, confirmationId;
    await check('ordinary_preview_actual_clock', async () => {
      const initial = await get(); assert.equal(initial.status, 200); assert.deepEqual(unwrap(initial.json).symbols, ['VT.US']);
      previewBody = { kind: 'preview', symbol: 'VT.US', expected_revision: unwrap(initial.json).workspace_revision, idempotency_key: 'fictional-current-http-preview' };
      const queued = await post(route, previewBody); assert.equal(queued.status, 202); previewId = unwrap(queued.json).request.id;
      assert.equal(unwrap(queued.json).view, null); await fixture('work');
      const ready = await get('?request=' + encodeURIComponent(previewId)); assert.equal(ready.status, 200);
      const recoveryView = recovery ? ready.json.recovery : null; ready.json = unwrap(ready.json);
      assert.equal(ready.json.request.status, 'preview_ready'); assert.equal(ready.json.view.confirmation_supported, !recovery);
      assert.equal(ready.json.view.changes.length, recovery ? 0 : 1); assert.equal(ready.json.view.visibility, 'private_owner_only_not_ai');
      if (!recovery) { assert.equal(ready.json.view.changes[0].tax_per_unit, null); assert.equal(ready.json.view.changes[0].effective_at, null); }
      assert.equal(ready.headers.get('cache-control'), 'private, no-store');
      assert.ok(Date.parse(ready.json.checked_at) <= Date.now() && Date.parse(ready.json.view.preview.valid_until) > Date.now());
      confirmationBody = { kind: 'confirmation', body: { schema_version: 'investor-action-review-submit-v1', preview_id: ready.json.view.preview.preview_id,
        expected_revision: ready.json.workspace_revision, idempotency_key: 'fictional-current-http-confirmation', enable_rule: false,
        new_events: [{ type: 'dividend', date: current.new_event_date, at: current.effective_at, pay_at: current.payment_at, tax_per_unit: '0.432109' }],
        acknowledgements: Object.fromEntries(['issuer_amount_unit_and_currency', 'reported_differences_seen', 'explicit_research_instants', 'explicit_tax_amounts',
          'unchanged_tax_assumption_applies', 'reported_coverage_not_objective_absence', 'no_historical_restatement', 'register_new_default_off_rule'].map(key => [key, true])) } };
      if (recovery) {
        assert.equal(recoveryView.failure_code, 'SOURCE_CAPTURE_TERMINAL_FAILURE');
        confirmationBody = { kind: 'confirmation', body: { schema_version: 'investor-unchanged-action-recovery-submit-v1', preview_id: recoveryView.preview_id,
          expected_revision: ready.json.workspace_revision, idempotency_key: 'fictional-current-http-confirmation', enable_rule: false,
          failed_publication_id: recoveryView.failed_publication_id, failed_publication_hash: recoveryView.failed_publication_hash,
          acknowledgements: Object.fromEntries(['unchanged_economic_events_and_tax', 'source_overlap_and_old_differences_unchanged', 'reported_coverage_not_objective_absence',
            'original_failure_and_history_retained', 'separate_current_data_readmission', 'register_new_default_off_rule'].map(key => [key, true])) } };
      }
      return { actual_clock: true, caller_clock_override: false, source_transport_calls: 0, financial: financial() };
    });
    await check('explicit_confirmation_and_exact_recovery', async () => {
      const bad = structuredClone(confirmationBody); bad.body.acknowledgements[recovery ? 'original_failure_and_history_retained' : 'explicit_tax_amounts'] = false;
      assert.equal((await post(route, bad)).status, 400);
      const queued = await post(route, confirmationBody); assert.equal(queued.status, 202); confirmationId = unwrap(queued.json).request.id;
      const lookup = await get('?nonce=fictional-current-http-confirmation'); assert.equal(unwrap(lookup.json).request.id, confirmationId);
      await fixture('work');
      const done = await get('?request=' + encodeURIComponent(confirmationId)); assert.equal(done.status, 200); done.json = unwrap(done.json); assert.equal(done.json.request.status, 'confirmed');
      assert.equal(done.json.research_admitted, false); assert.equal(done.json.trading_permission, false);
      const duplicate = await post(route, confirmationBody); assert.equal(duplicate.status, 200); assert.equal(unwrap(duplicate.json).request.id, confirmationId);
      assert.equal(read(db => db.prepare('SELECT count(*) n FROM investor_action_review_confirmations').get().n), 1);
      assert.equal(read(db => db.prepare('SELECT enabled FROM investor_action_controls ORDER BY rowid DESC LIMIT 1').get().enabled), 0);
      if (recovery) {
        assert.deepEqual(read(db => db.prepare('SELECT status,attempt_count,max_attempts FROM job_runs WHERE id=?').get(current.failed_job_id)), { status: 'failed', attempt_count: 1, max_attempts: 1 });
        assert.equal(read(db => db.prepare('SELECT status FROM investor_action_publications WHERE id=?').get(current.failed_publication_id).status), 'blocked');
      }
      assert.deepEqual(financial(), baseline);
      return { confirmations: 1, default_off_preserved: true, duplicate_reapproved: false, financial_writes: false };
    });
    await check('withdrawal_stops_fresh_preview_without_erasing_historical_registration', async () => {
      await fixture('withdraw'); const historical = await get('?request=' + encodeURIComponent(confirmationId));
      historical.json = unwrap(historical.json);
      assert.equal(historical.status, 200); assert.equal(historical.json.request.status, 'confirmed'); assert.equal(historical.json.research_admitted, false);
      const next = await post(route, { kind: 'preview', symbol: 'VT.US', expected_revision: historical.json.workspace_revision, idempotency_key: 'fictional-current-http-withdrawn' });
      assert.equal(next.status, 202); await fixture('work');
      const rejected = await get('?request=' + encodeURIComponent(unwrap(next.json).request.id)); rejected.json = unwrap(rejected.json); assert.equal(rejected.json.request.status, 'rejected');
      assert.equal(rejected.json.request.code, 'ACTION_REVIEW_SOURCE_UNAVAILABLE'); assert.equal(rejected.json.view, null);
      assert.deepEqual(financial(), baseline); return { new_approval: false, historical_registration_retained: true };
    });
    const logout = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } }); assert.equal(logout.status, 303);
    report.status = 'PASS';
  }
} catch (error) {
  report.status = error.message.startsWith('ACCEPTANCE_WAITING_FOR_NY_01') ? 'WAITING_WINDOW' : 'FAIL';
  report.error = error.message; process.exitCode = report.status === 'WAITING_WINDOW' ? 2 : 1; console.error(error.message);
}
finally {
  if (tick) clearInterval(tick);
  await tickWork;
  if (server && server.exitCode === null && server.signalCode === null) await new Promise(resolve => { server.once('exit', resolve); server.kill('SIGTERM'); });
  if (proxy) await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
  if (directory) { writeFileSync(path.join(output, 'server.log'), logs.replaceAll(directory, '[temporary-fixture]').replaceAll(password ?? 'unlikely-empty-marker', '[redacted]')); rmSync(directory, { recursive: true, force: true }); }
  report.source_end_files = inventory(); report.source_changed = Object.keys({ ...report.source_files, ...report.source_end_files }).filter(name => report.source_files[name] !== report.source_end_files[name]);
  if (report.source_changed.length) { report.status = 'STALE'; process.exitCode = 1; }
  report.completed_at = new Date().toISOString(); writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Evidence: ' + path.relative(root, output));
}
