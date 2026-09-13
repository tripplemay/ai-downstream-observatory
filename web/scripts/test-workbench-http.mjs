import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateWorkbench } from '../../scripts/migrate-workbench.mjs';
import { probeEarlyRejection } from './http-early-rejection.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(web);
const require = createRequire(path.join(web, 'package.json'));
const Database = require('better-sqlite3');
const now = new Date().toISOString();
const output = path.join(root, 'artifacts', 'verification', 'workbench-http', now.replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true });
const report = {
  suite: 'workbench-http', version: 1, started_at: now, completed_at: null,
  status: 'RUNNING', build_id: null, build_performed: !process.argv.includes('--no-build'),
  fixture: 'temporary migrated database and random credentials; no production or real accounts',
  cases: [], source_sha256: {}, limitations: [
    'HTTP client validates rendered HTML but is not browser interaction or TLS/proxy validation.',
    'This suite covers account creation and supported ledger/import API commands, not investment-strategy eligibility.',
    'Monthly HTTP cases prove negative authorization, immutable empty state and recovery boundaries; authorized proposal publication is covered separately by service and Python-to-Node integration tests.',
    'Rotation HTTP cases use a real authenticated network session and Python worker with synthetic research data; they do not certify G/S gates, real forward performance or broker execution.',
    'Collection HTTP cases patch only the independent test Python transport with synthetic XML; no app request can provide a URL, body, credential or provider clock, and no CI provider network request is made.',
    'Recurring collection cases use an actual UTC trigger and loopback HTTP pause, but do not certify production uptime, real provider freshness or native browser behavior.',
    'Price collection cases use human-reviewed synthetic references and SDK projections in an independent test transport; they do not verify exchange calendars, subscriptions, real market data or broker buyability.',
    'Listing reviews use synthetic private human assertions, not issuer verification, live trading authority or weighted holdings look-through; HTTP page output is not native browser interaction acceptance.',
  ],
};
const sha = (value) => createHash('sha256').update(value).digest('hex');
function sourceFiles(relative) {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = `${relative}/${entry.name}`;
    return entry.isDirectory() && entry.name !== '__pycache__' ? sourceFiles(name) : entry.isFile() && /\.(?:ts|tsx|py|json|sql|mjs|sh)$/.test(entry.name) ? [name] : [];
  });
}
const inventory = () => [...['contracts', 'migrations', 'web/src', 'web/tests', 'web/scripts', 'tests', 'scripts', 'worker/accounting', 'worker/market', 'worker/orchestration', 'worker/performance', 'worker/research'].flatMap(sourceFiles), 'web/package.json', 'web/package-lock.json', 'web/next.config.ts', 'web/tailwind.config.ts', 'requirements-workbench.txt'].sort();
for (const relative of inventory()) {
  report.source_sha256[relative] = sha(readFileSync(path.join(root, relative)));
}
async function check(id, description, operation) {
  const started = performance.now();
  try {
    const evidence = await operation();
    report.cases.push({ id, description, status: 'PASS', duration_ms: Math.round(performance.now() - started), evidence: evidence ?? null });
    process.stdout.write(`PASS ${id}: ${description}\n`);
  } catch (error) {
    report.cases.push({ id, description, status: 'FAIL', duration_ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'etf-workbench-http-'));
  const filename = path.join(directory, 'workbench.db');
  const legacy = path.join(directory, 'legacy-must-not-be-opened.db');
  let server;
  let logs = '';
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(16);
  const passwordHash = `scrypt$32768$8$1$${salt.toString('base64url')}$${scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url')}`;
  const origin = 'https://workbench.example.test';
  let address;
  let cookie = '';
  let portfolio, account, otherPortfolio, foreignAccount, revision = 0;
  let sourceSequence = 0;
  const request = (url, init = {}) => fetch(address + url, { ...init, redirect: 'manual' });
  const jsonRequest = async (url, init = {}) => {
    let response, text;
    const transport = init.duplex === 'half' ? 'stream' : 'buffered';
    const failure = (error, phase) => {
      const code = error?.cause?.code;
      return new Error(`HTTP_TRANSPORT_FAILED ${init.method ?? 'GET'} ${url.split('?')[0]} ${transport} ${phase} ${typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'UNKNOWN'}`);
    };
    try { response = await request(url, init); } catch (error) { throw failure(error, 'headers'); }
    try { text = await response.text(); } catch (error) { throw failure(error, 'body'); }
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`Expected JSON, received HTTP ${response.status}: ${text.slice(0, 100)}`); }
    return { status: response.status, json, headers: response.headers };
  };
  const post = (body, extraHeaders = {}) => jsonRequest('/api/workbench', {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body),
  });
  const state = async (selected = portfolio) => {
    const response = await jsonRequest(`/api/workbench${selected ? `?portfolio=${selected}` : ''}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.json;
  };
  const cash = (snapshot) => snapshot.balances.find(row => row.account_id === account && row.currency === 'CNY' && row.ledger_account === 'cash_settled')?.balance ?? '0';
  const command = (fact, overrides = {}) => ({
    portfolio_id: portfolio, expected_revision: revision, idempotency_key: `http:${++sourceSequence}`,
    source_id: 'synthetic-http', source_event_id: `source:${sourceSequence}`, effective_at: '2026-01-01',
    time_precision: 'date', source_timezone: 'Asia/Shanghai', reason: 'Synthetic integration fixture',
    fact: { account_id: account, currency: 'CNY', ...fact }, ...overrides,
  });
  const record = async (fact, overrides = {}) => {
    const response = await post({ action: 'record_fact', command: command(fact, overrides) });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    revision = response.json.revision;
    return response.json;
  };
  const importRow = (amount) => {
    const { portfolio_id: _, expected_revision: __, idempotency_key: ___, ...row } = command({ type: 'deposit', amount });
    return row;
  };
  const preview = async (raw) => {
    const result = await post({ action: 'preview_import', portfolio_id: portfolio, account_id: account, raw });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    return result.json;
  };
  const confirm = (batch, overrides = {}) => post({ action: 'confirm_import', portfolio_id: portfolio, batch_id: batch.id,
    preview_hash: batch.preview_hash, expected_revision: batch.expected_revision, ...overrides });
  try {
    await check('HTTP-00', 'fresh migration and current production build', async () => {
      const migration = migrateWorkbench(filename);
      const db = new Database(filename);
      db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('http-instrument','Synthetic ETF','2026-01-01T00:00:00.000000Z')").run();
      db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('http-listing','http-instrument','CN','SSE','TEST01','CNY','2026-01-01T00:00:00.000000Z')").run();
      db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('http-listing-2','http-instrument','US','SYNTHETIC','TEST02','USD','2026-01-01T00:00:00.000000Z')").run();
      db.close();
      if (report.build_performed) {
        const build = spawnSync(process.execPath, ['node_modules/next/dist/bin/next', 'build'], {
          cwd: web, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', WORKBENCH_DB_PATH: path.join(directory, 'must-not-open-during-build.db'),
            WORKBENCH_PASSWORD_HASH: '', WORKBENCH_SESSION_SECRET: '', WORKBENCH_ORIGIN: '', WORKBENCH_DATA_DIR: '', DB_PATH: legacy },
          encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
        });
        writeFileSync(path.join(output, 'build.log'), (build.stdout ?? '') + (build.stderr ?? ''));
        assert.equal(build.status, 0, 'Production build failed; see build.log.');
        assert.equal(existsSync(path.join(directory, 'must-not-open-during-build.db')), false);
      }
      assert.ok(existsSync(path.join(web, '.next/BUILD_ID')), 'Build is required.');
      report.build_id = readFileSync(path.join(web, '.next/BUILD_ID'), 'utf8').trim();
      const listener = net.createServer();
      await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
      const port = listener.address().port;
      await new Promise(resolve => listener.close(resolve));
      address = `http://127.0.0.1:${port}`;
      server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: web, env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', DB_PATH: legacy,
          WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: path.join(directory, 'auth'),
          WORKBENCH_PASSWORD_HASH: passwordHash, WORKBENCH_SESSION_SECRET: randomBytes(48).toString('base64url'), WORKBENCH_ORIGIN: origin },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
      server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
      let ready = false;
      for (let i = 0; i < 200; i++) {
        if (server.exitCode !== null) throw new Error('Server exited before readiness.');
        try { if ((await request('/api/health')).ok) { ready = true; break; } } catch { /* Listener may not be ready. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(ready, 'Server readiness timeout.');
      return { schema_version: migration.version, build_id: report.build_id };
    });
    await check('HTTP-01', 'anonymous page, API reads and mutation fail before database access', async () => {
      assert.equal((await request('/workbench')).headers.get('location'), '/login');
      assert.equal((await request('/workbench/research')).headers.get('location'), '/login');
      assert.equal((await request('/workbench/governance')).headers.get('location'), '/login');
      assert.equal((await request('/workbench/funding')).headers.get('location'), '/login');
      assert.equal((await request('/workbench/catalog')).headers.get('location'), '/login');
      assert.equal((await request('/workbench/market')).headers.get('location'), '/login');
      assert.equal((await jsonRequest('/api/workbench/catalog')).status, 401);
      assert.equal((await jsonRequest('/api/workbench')).status, 401);
      assert.equal((await post({ action: 'create_portfolio', name: 'Forbidden' })).status, 401);
      const db = new Database(filename, { readonly: true });
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM portfolios').get().n, 0);
      db.close();
    });
    await check('HTTP-02', 'single-user login creates secure session', async () => {
      const response = await request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });
      assert.equal(response.status, 303);
      const header = response.headers.get('set-cookie');
      assert.match(header, /HttpOnly/i); assert.match(header, /Secure/i); assert.match(header, /SameSite=Strict/i);
      cookie = header.split(';')[0];
      assert.deepEqual((await state()).portfolios, []);
      assert.equal((await request('/workbench', { headers: { Cookie: cookie } })).status, 200);
    });
    await check('HTTP-03', 'Origin, query schema and request format are enforced', async () => {
      assert.equal((await post({ action: 'create_portfolio', name: 'Forbidden' }, { Origin: 'https://evil.example.test' })).status, 403);
      assert.equal((await post({ action: 'create_portfolio', name: 'Forbidden' }, { Origin: '' })).status, 403);
      assert.equal((await post({ action: 'create_portfolio', name: 'Forbidden' }, { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await jsonRequest('/api/workbench?portfolio=a&portfolio=b', { headers: { Cookie: cookie } })).status, 400);
      assert.equal((await jsonRequest('/api/workbench?batch=missing', { headers: { Cookie: cookie } })).status, 400);
      assert.equal((await post({ action: 'create_portfolio', name: 'Forbidden', actor_id: 'admin' })).status, 400);
      assert.equal((await post({ action: 'record_fact', command: null })).status, 400);
      const malformed = await jsonRequest('/api/workbench', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: Buffer.from([0x7b, 0xff, 0x7d]) });
      assert.equal(malformed.status, 400); assert.equal(malformed.json.error, 'INVALID_UTF8');
    });
    await check('HTTP-04', 'chunked request is rejected during streaming at 5 MiB', async () => {
      const result = await probeEarlyRejection(address + '/api/workbench', { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' });
      assert.equal(result.status, 413); assert.equal(result.json.error, 'REQUEST_TOO_LARGE');
      assert.equal(result.bytes_sent, 5242881); assert.equal(result.request_ended, false); assert.equal(result.response_complete, true);
      return { declared_content_length: false, limit_bytes: 5242880, bytes_sent: result.bytes_sent, request_ended: false, response_complete: true };
    });
    await check('HTTP-05', 'new portfolios and accounts contain no personal funding defaults, cash or ledger facts', async () => {
      const p = await post({ action: 'create_portfolio', name: 'Synthetic main portfolio' }); assert.equal(p.status, 200); portfolio = p.json.id;
      const other = await post({ action: 'create_portfolio', name: 'Synthetic other portfolio' }); assert.equal(other.status, 200); otherPortfolio = other.json.id;
      const a = await post({ action: 'create_account', portfolio_id: portfolio, name: 'Domestic fixture', broker: 'Synthetic broker', currency: 'CNY' }); assert.equal(a.status, 200); account = a.json.id;
      const foreign = await post({ action: 'create_account', portfolio_id: otherPortfolio, name: 'Other fixture', broker: 'Synthetic broker', currency: 'CNY' }); assert.equal(foreign.status, 200); foreignAccount = foreign.json.id;
      const current = await state();
      assert.equal(current.revision, 0); assert.equal(current.events.length, 0); assert.deepEqual(current.balances, []);
      assert.equal(current.plan, null); assert.equal(current.funding_summary.status, 'not_configured');
      const db = new Database(filename, { readonly: true });
      try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM funding_plan_versions WHERE portfolio_id=?').get(portfolio).n, 0); } finally { db.close(); }
      assert.equal(current.advice_status, 'blocked'); assert.equal(current.valuation_status, 'not_ready');
      return { personal_funding_defaults: false, funding_plan_versions: 0, cash_cny: '0' };
    });
    const evaluationPath = '/api/workbench/evaluations';
    const evaluationPost = (body, extraHeaders = {}) => jsonRequest(evaluationPath, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body),
    });
    const evaluationDatabase = () => {
      const db = new Database(filename, { readonly: true });
      try {
        db.defaultSafeIntegers(true);
        return db.transaction(() => {
          const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
          const logical = tables.map(({ name, sql }) => {
            const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).raw().all().map(row => JSON.stringify(row.map(value =>
              typeof value === 'bigint' ? ['integer', value.toString()] : Buffer.isBuffer(value) ? ['blob', value.toString('base64')] : [typeof value, value]))).sort();
            return { name, sql, rows };
          });
          return { logical_sha256: sha(JSON.stringify(logical)), row_counts: Object.fromEntries(logical.map(table => [table.name, table.rows.length])) };
        }).deferred();
      } finally { db.close(); }
    };
    const evaluationBaseline = evaluationDatabase();
    const evaluationSave = {
      action: 'save_schedule', command: { portfolio_id: portfolio, expected_revision: 0, expected_schedule_id: null, expected_schedule_revision: 0,
        idempotency_key: 'synthetic-http-monthly-unapproved', reason: 'Synthetic negative admission fixture; no investment authorization',
        definition_json: JSON.stringify({ schema_version: 'evaluation-schedule-v1', frequency: 'monthly', environment: 'actual',
          policy_version_id: 'synthetic-absent-policy', strategy_version_id: 'synthetic-absent-strategy', activation_id: 'synthetic-absent-activation',
          timezone: 'UTC', start_month: new Date().toISOString().slice(0, 7), end_month: null,
          trigger: { day: 15, hour: 12, minute: 0 }, deadline_seconds: 3600, max_attempts: 2,
          targets: { method: 'manual_weight_targets_v1', weight_basis: 'portfolio_nav',
            rows: [{ account_id: account, listing_id: 'http-listing', currency: 'CNY', weight: '0.25' }],
            absolute_tolerance_cny: '0', weight_tolerance: '0.01', tolerance_rule: 'max_absolute_or_weight',
            unlisted_strategy_positions: 'block', pending_activity: 'block', price_rule: 'close_rounded_to_step', quantity_rule: 'floor_to_step' },
        }),
      },
    };
    await check('HTTP-EV01', 'monthly pages and API authenticate before parsing; authenticated state has no schedule or funding defaults', async () => {
      assert.equal((await request('/workbench/evaluations')).headers.get('location'), '/login');
      const anonymousRead = await jsonRequest(`${evaluationPath}?portfolio=a&portfolio=b`);
      assert.equal(anonymousRead.status, 401); assert.deepEqual(anonymousRead.json, { error: 'UNAUTHENTICATED' });
      const anonymousWrite = await jsonRequest(evaluationPath, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' });
      assert.equal(anonymousWrite.status, 401); assert.deepEqual(anonymousWrite.json, { error: 'UNAUTHENTICATED' });
      for (const selected of [portfolio, otherPortfolio]) {
        const result = await jsonRequest(`${evaluationPath}?portfolio=${selected}`, { headers: { Cookie: cookie } });
        assert.equal(result.status, 200); assert.equal(result.json.schema_version, 'monthly-evaluations-v1');
        assert.equal(result.json.selected_portfolio_id, selected); assert.equal(result.json.ledger_revision, 0); assert.equal(result.json.read_only, false);
        assert.deepEqual(result.json.schedules, []); assert.deepEqual(result.json.cycles, []);
        assert.equal(result.json.detail, null); assert.equal(result.json.next_cursor, null); assert.equal(result.json.schedules_truncated, false);
        assert.equal(result.headers.get('cache-control'), 'private, no-store'); assert.ok(result.headers.get('vary')?.toLowerCase().split(',').map(value => value.trim()).includes('cookie'));
        assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
      }
      const page = await request('/workbench/evaluations', { headers: { Cookie: cookie } });
      assert.equal(page.status, 200); const html = await page.text(); assert.match(html, /月度策略评估/);
      assert.doesNotMatch(html, /<select\b[^>]*aria-label="当前组合"/);
      assert.deepEqual(evaluationDatabase(), evaluationBaseline);
      assert.equal(evaluationBaseline.row_counts.evaluation_schedules, 0); assert.equal(evaluationBaseline.row_counts.evaluation_cycles, 0);
      assert.equal(evaluationBaseline.row_counts.funding_plan_versions, 0); assert.equal(evaluationBaseline.row_counts.ledger_events, 0);
      return { monthly_defaults: false, schedules: 0, cycles: 0, ledger_events: 0, logical_database_unchanged: true, browser_interaction: false };
    });
    await check('HTTP-EV02', 'monthly API rejects malformed Origin, UTF-8, JSON, 1 MiB streams and ambiguous queries without writes', async () => {
      for (const supplied of ['', 'https://evil.example.test']) {
        const denied = await evaluationPost(evaluationSave, { Origin: supplied });
        assert.equal(denied.status, 403); assert.equal(denied.json.error, 'INVALID_ORIGIN');
      }
      const plain = await evaluationPost(evaluationSave, { 'Content-Type': 'text/plain' });
      assert.equal(plain.status, 415); assert.equal(plain.json.error, 'JSON_REQUIRED');
      for (const [body, error] of [[Buffer.from([0x7b, 0xff, 0x7d]), 'INVALID_UTF8'], ['{', 'INVALID_JSON'], ['{"action":"save_schedule","action":"retry_evaluation","command":{}}', 'INVALID_JSON']]) {
        const result = await jsonRequest(evaluationPath, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body });
        assert.equal(result.status, 400); assert.equal(result.json.error, error);
      }
      async function* oversizedEvaluation() { for (let i = 0; i < 17; i++) yield Buffer.alloc(65536, 32); }
      const tooLarge = await jsonRequest(evaluationPath, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: oversizedEvaluation(), duplex: 'half' });
      assert.equal(tooLarge.status, 413); assert.equal(tooLarge.json.error, 'REQUEST_TOO_LARGE');
      for (const query of [`portfolio=${portfolio}&portfolio=${otherPortfolio}`, `portfolio=${portfolio}&limit=51`, `portfolio=${portfolio}&unknown=1`, `portfolio=${portfolio}&attempt_cursor=abc`]) {
        const invalid = await jsonRequest(`${evaluationPath}?${query}`, { headers: { Cookie: cookie } });
        assert.equal(invalid.status, 400); assert.equal(invalid.json.error, 'EVALUATION_QUERY_INVALID');
      }
      for (const cursor of ['not-canonical!', Buffer.from(JSON.stringify({ portfolio_id: otherPortfolio, period: '2026-01', id: 'synthetic-cycle' })).toString('base64url')]) {
        const invalid = await jsonRequest(`${evaluationPath}?portfolio=${portfolio}&cursor=${encodeURIComponent(cursor)}`, { headers: { Cookie: cookie } });
        assert.equal(invalid.status, 400); assert.equal(invalid.json.error, 'EVALUATION_CURSOR_INVALID');
      }
      assert.deepEqual(evaluationDatabase(), evaluationBaseline);
      return { limit_bytes: 1048576, streaming_limit_enforced: true, strict_json_and_query: true, logical_database_unchanged: true };
    });
    await check('HTTP-EV03', 'monthly HTTP accepts no caller-authored PASS or actor and requires real activation for an otherwise complete schedule', async () => {
      for (const body of [{ action: 'publish_monthly_evaluation', command: { outcome: 'unchanged', status: 'pass' } },
        { action: 'complete_evaluation', command: { result: 'PASS' } }, { ...evaluationSave, actor_id: 'synthetic-admin' },
        { ...evaluationSave, command: { ...evaluationSave.command, actor: { id: 'synthetic-admin', kind: 'human' } } },
        { ...evaluationSave, command: { ...evaluationSave.command, expected_revision: 0.5 } }]) {
        const invalid = await evaluationPost(body); assert.equal(invalid.status, 400); assert.equal(invalid.json.error, 'EVALUATION_COMMAND_INVALID');
      }
      const absent = await evaluationPost(evaluationSave); assert.equal(absent.status, 400); assert.equal(absent.json.error, 'EVALUATION_ACTIVATION_REQUIRED');
      const replay = await evaluationPost(evaluationSave); assert.equal(replay.status, 400); assert.deepEqual(replay.json, absent.json);
      const stale = await evaluationPost({ ...evaluationSave, command: { ...evaluationSave.command, expected_revision: 1 } });
      assert.equal(stale.status, 409); assert.equal(stale.json.error, 'EVALUATION_LEDGER_CONFLICT');
      const envelope = { portfolio_id: portfolio, expected_revision: 0, idempotency_key: 'synthetic-http-monthly-missing', reason: 'Synthetic absent schedule/cycle' };
      const status = await evaluationPost({ action: 'set_schedule_status', command: { ...envelope, schedule_id: 'synthetic-absent-schedule', expected_schedule_revision: 1, status: 'enabled' } });
      assert.equal(status.status, 404); assert.equal(status.json.error, 'EVALUATION_SCHEDULE_NOT_FOUND');
      const retry = await evaluationPost({ action: 'retry_evaluation', command: { ...envelope, cycle_id: 'synthetic-absent-cycle', expected_state_revision: 1 } });
      assert.equal(retry.status, 404); assert.equal(retry.json.error, 'EVALUATION_CYCLE_NOT_FOUND');
      assert.deepEqual(evaluationDatabase(), evaluationBaseline);
      return { activation_fabricated: false, caller_results_accepted: false, domain_publications: 0, logical_database_unchanged: true, authorized_positive_flow_tested_here: false };
    });
    await check('HTTP-EV04', 'monthly reads remain available under recovery while writes lock and stale session bindings fail before body parsing', async () => {
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic monthly recovery guard\n', { mode: 0o600, flag: 'wx' });
      try {
        const read = await jsonRequest(`${evaluationPath}?portfolio=${portfolio}`, { headers: { Cookie: cookie } });
        assert.equal(read.status, 200); assert.equal(read.json.read_only, true); assert.deepEqual(read.json.schedules, []); assert.deepEqual(read.json.cycles, []);
        const blocked = await evaluationPost(evaluationSave); assert.equal(blocked.status, 423); assert.equal(blocked.json.error, 'WORKBENCH_READ_ONLY');
      } finally { rmSync(marker); }
      const originalProbe = await jsonRequest('/api/auth/session', { headers: { Cookie: cookie } });
      assert.equal(originalProbe.status, 200); assert.match(originalProbe.json.session_binding, /^[a-f0-9]{64}$/);
      const secondLogin = await request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });
      assert.equal(secondLogin.status, 303); const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
      try {
        const secondProbe = await jsonRequest('/api/auth/session', { headers: { Cookie: secondCookie } }); assert.equal(secondProbe.status, 200);
        assert.notEqual(secondProbe.json.session_binding, originalProbe.json.session_binding);
        const invalidBody = Buffer.from([0x7b, 0xff, 0x7d]);
        const stale = await jsonRequest(evaluationPath, { method: 'POST', headers: { Cookie: secondCookie, Origin: origin, 'Content-Type': 'application/json', 'X-Workbench-Session-Binding': originalProbe.json.session_binding }, body: invalidBody });
        assert.equal(stale.status, 401); assert.equal(stale.json.error, 'SESSION_CHANGED');
        const current = await jsonRequest(evaluationPath, { method: 'POST', headers: { Cookie: secondCookie, Origin: origin, 'Content-Type': 'application/json', 'X-Workbench-Session-Binding': secondProbe.json.session_binding }, body: invalidBody });
        assert.equal(current.status, 400); assert.equal(current.json.error, 'INVALID_UTF8');
      } finally {
        assert.equal((await request('/api/auth/logout', { method: 'POST', headers: { Cookie: secondCookie, Origin: origin } })).status, 303);
      }
      const read = await jsonRequest(`${evaluationPath}?portfolio=${portfolio}`, { headers: { Cookie: cookie } });
      assert.equal(read.status, 200); assert.equal(read.json.read_only, false);
      assert.deepEqual(evaluationDatabase(), evaluationBaseline);
      return { restore_read_only: true, restore_write_status: 423, stale_session_before_parse_status: 401, correct_binding_invalid_utf8_status: 400, logical_database_unchanged: true };
    });
    let opening;
    await check('HTTP-06', 'actual opening and contribution produce exact decimal cash', async () => {
      opening = command({ type: 'opening_cash', amount: '640000' });
      const result = await post({ action: 'record_fact', command: opening }); assert.equal(result.status, 200); revision = result.json.revision;
      await record({ type: 'deposit', amount: '160000' });
      const current = await state(); assert.equal(current.revision, 2); assert.equal(cash(current), '800000');
      return { revision, cash_cny: cash(current) };
    });
    await check('HTTP-07', 'idempotency replay is stable and conflicting payload is rejected', async () => {
      const replay = await post({ action: 'record_fact', command: opening }); assert.equal(replay.status, 200); assert.equal(replay.json.duplicate, true);
      const conflict = await post({ action: 'record_fact', command: { ...opening, fact: { ...opening.fact, amount: '1' } } });
      assert.equal(conflict.status, 409); assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '800000');
    });
    await check('HTTP-08', 'stale revisions, forged account scope and numeric money fail atomically', async () => {
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'deposit', amount: '1' }, { expected_revision: 0 }) })).status, 409);
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'deposit', account_id: foreignAccount, amount: '1' }) })).status, 403);
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'deposit', amount: 100 }) })).status, 400);
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'transfer_out', target_account_id: foreignAccount, amount: '1' }) })).status, 403);
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'deposit', amount: '1' }, { effective_at: '2099-01-01' }) })).status, 400);
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'buy', listing_id: 'http-listing', quantity: '100', price: '-1', consideration: '100', fee: '0' }) })).status, 400);
      assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '800000');
    });
    let goodPreview, rawImport;
    await check('HTTP-09', 'import preview validates without publishing any facts', async () => {
      rawImport = JSON.stringify([importRow('100'), importRow('50')]);
      goodPreview = await preview(rawImport); assert.equal(goodPreview.status, 'preview'); assert.equal(goodPreview.rows.length, 2);
      assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '800000');
      const read = await jsonRequest(`/api/workbench?portfolio=${portfolio}&batch=${goodPreview.id}`, { headers: { Cookie: cookie } });
      assert.equal(read.status, 200); assert.equal(read.json.preview_hash, goodPreview.preview_hash);
      assert.equal((await jsonRequest(`/api/workbench?portfolio=${otherPortfolio}&batch=${goodPreview.id}`, { headers: { Cookie: cookie } })).status, 404);
    });
    await check('HTTP-10', 'import hash check, atomic confirmation and duplicate confirmation', async () => {
      assert.equal((await confirm(goodPreview, { preview_hash: 'tampered' })).status, 409);
      const confirmed = await confirm(goodPreview); assert.equal(confirmed.status, 200); revision = confirmed.json.revision;
      assert.equal(revision, 4); assert.equal(cash(await state()), '800150');
      const replay = await confirm(goodPreview); assert.equal(replay.status, 200); assert.equal(replay.json.duplicate, true);
      const repeatedPreview = await preview(rawImport); assert.equal(repeatedPreview.id, goodPreview.id); assert.equal(repeatedPreview.duplicate, true);
      assert.equal((await state()).revision, revision);
    });
    await check('HTTP-11', 'an invalid row quarantines the entire import', async () => {
      const invalid = await preview(JSON.stringify([importRow('100'), importRow('-50')]));
      assert.equal(invalid.status, 'invalid'); assert.ok(invalid.rows[1].errors.length);
      assert.equal((await confirm(invalid)).status, 400); assert.equal((await state()).revision, revision);
      assert.equal(cash(await state()), '800150');
    });
    await check('HTTP-12', 'stale preview rejects confirmation and same file can be re-previewed', async () => {
      const raw = JSON.stringify([importRow('100')]);
      const stale = await preview(raw);
      await record({ type: 'fee', amount: '10' });
      assert.equal((await confirm(stale)).status, 409);
      const refreshed = await preview(raw);
      assert.notEqual(refreshed.id, stale.id, 'A stale same-file preview must be refreshable.');
      assert.equal(refreshed.expected_revision, revision);
      const accepted = await confirm(refreshed); assert.equal(accepted.status, 200); revision = accepted.json.revision;
      assert.equal(cash(await state()), '800240');
    });
    await check('HTTP-13', 'buy recognition and separate settlement cannot double-count cash', async () => {
      const buy = await record({ type: 'buy', listing_id: 'http-listing', quantity: '1000', price: '10', fee: '10' });
      const before = await state();
      assert.equal(cash(before), '800240'); assert.equal(before.positions[0].quantity, '1000');
      assert.equal(before.balances.find(row => row.ledger_account === 'trade_payable').balance, '-10010');
      await record({ type: 'settlement', direction: 'buy', related_event_id: buy.event_id, amount: '10010' });
      assert.equal(cash(await state()), '790230');
      const excess = await post({ action: 'record_fact', command: command({ type: 'settlement', direction: 'buy', related_event_id: buy.event_id, amount: '1' }) });
      assert.equal(excess.status, 400); assert.equal((await state()).revision, revision);
    });
    await check('HTTP-14', 'two concurrent stale-state commands cannot both commit', async () => {
      const first = command({ type: 'deposit', amount: '1' });
      const second = command({ type: 'deposit', amount: '1' });
      const results = await Promise.all([post({ action: 'record_fact', command: first }), post({ action: 'record_fact', command: second })]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      revision += 1; assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '790231');
    });
    await check('HTTP-15', 'private workbench renders account facts; response is not cacheable', async () => {
      const response = await request('/workbench', { headers: { Cookie: cookie } });
      assert.equal(response.status, 200); const html = await response.text();
      assert.match(html, /ETF 投资工作台/); assert.match(html, /Domestic fixture/);
      const api = await jsonRequest(`/api/workbench?portfolio=${portfolio}`, { headers: { Cookie: cookie } });
      assert.match(api.headers.get('cache-control'), /no-store/);
      assert.equal(existsSync(legacy), false);
    });
    let statementAttachment;
    await check('HTTP-18', 'original attachment bytes are retained, scoped and downloadable', async () => {
      const statement = { schema_version: 1, portfolio_id: portfolio, account_id: account, cutoff_at: '2026-01-02T00:00:00Z',
        coverage: { currencies: ['CNY'], ledger_accounts: ['cash_settled', 'trade_receivable', 'trade_payable', 'dividend_receivable', 'transfer_in_transit', 'other_liability', 'cash_hold'], positions_complete: true, balances_complete: true },
        balances: ['cash_settled', 'trade_receivable', 'trade_payable', 'dividend_receivable', 'transfer_in_transit', 'other_liability', 'cash_hold'].map(ledger_account => ({ currency: 'CNY', ledger_account, balance: ledger_account === 'cash_settled' ? '790231' : '0' })),
        positions: [{ listing_id: 'http-listing', currency: 'CNY', quantity: '1000' }] };
      const raw = JSON.stringify(statement, null, 2) + '\n';
      const stored = await post({ action: 'store_attachment', portfolio_id: portfolio, account_id: account, raw });
      assert.equal(stored.status, 200, JSON.stringify(stored.json)); statementAttachment = stored.json;
      assert.equal(statementAttachment.content_hash, sha(raw));
      const url = `/api/workbench/attachments/${statementAttachment.id}?portfolio=${portfolio}`;
      const download = await request(url, { headers: { Cookie: cookie } });
      assert.equal(download.status, 200); assert.equal(await download.text(), raw);
      assert.match(download.headers.get('cache-control'), /no-store/);
      assert.equal((await request(url)).status, 401);
      assert.equal((await request(`/api/workbench/attachments/${statementAttachment.id}?portfolio=${otherPortfolio}`, { headers: { Cookie: cookie } })).status, 403);
      assert.equal((await state()).revision, revision);
    });
    await check('HTTP-19', 'scoped exact reconciliation uses original evidence and preserves ledger revision', async () => {
      const input = { portfolio_id: portfolio, account_id: account, expected_revision: revision, attachment_id: statementAttachment.id };
      assert.equal((await post({ action: 'reconcile_account', command: { ...input, expected_revision: 0 } })).status, 409);
      assert.equal((await post({ action: 'reconcile_account', command: { ...input, account_id: foreignAccount } })).status, 403);
      const matched = await post({ action: 'reconcile_account', command: input });
      assert.equal(matched.status, 200, JSON.stringify(matched.json)); assert.equal(matched.json.status, 'matched');
      assert.equal(matched.json.account_activated, true); assert.equal((await state()).revision, revision);
      assert.equal((await state()).accounts.find(row => row.id === account).status, 'active');
    });
    await check('HTTP-20', 'securities registration remains unverified and cannot inject actor or policy', async () => {
      const input = { portfolio_id: portfolio, expected_revision: revision, idempotency_key: 'listing-http', name: 'Synthetic global fund', market: 'US', exchange: 'TEST', ticker: 'SYNTH', currency: 'USD', asset_class: 'equity', source_evidence: 'Synthetic test only' };
      const created = await post({ action: 'register_listing', command: input });
      assert.equal(created.status, 200, JSON.stringify(created.json)); assert.equal(created.json.status, 'unverified');
      assert.deepEqual((await post({ action: 'register_listing', command: input })).json, created.json);
      assert.equal((await post({ action: 'register_listing', command: { ...input, approved_by: 'AI' } })).status, 400);
      assert.equal((await state()).revision, revision);
    });
    await check('HTTP-21', 'authenticated Web request runs in Python and publishes blocked and complete snapshots honestly', async () => {
      const cutoff = new Date().toISOString();
      const rules = { schema_version: 'valuation-rules-v1', approved: false, price_scope_by_market: {}, expected_sessions: {}, corporate_actions_complete: {}, max_fx_age_seconds: 0 };
      const input = { portfolio_id: portfolio, expected_revision: revision, idempotency_key: 'valuation-http', command_type: 'valuation', payload: { cutoff_at: cutoff, rules } };
      const queued = await post({ action: 'enqueue_task', command: input });
      assert.equal(queued.status, 200, JSON.stringify(queued.json)); assert.equal(queued.json.status, 'queued');
      assert.deepEqual((await post({ action: 'enqueue_task', command: input })).json, queued.json);
      assert.equal((await post({ action: 'enqueue_task', command: { ...input, command_type: 'place_order' } })).status, 400);
      const runWorker = () => {
        const worker = spawnSync(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-m', 'worker.orchestration', '--db', filename, '--once'], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: path.join(directory, 'auth'), WORKBENCH_MODE: 'ledger' }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
        assert.equal(worker.status, 0, `Worker failed: ${worker.stderr || worker.error || worker.stdout}`);
      };
      runWorker();
      let current = await state();
      assert.equal(current.tasks.find(row => row.id === queued.json.request_id).status, 'succeeded');
      assert.equal(current.valuations[0].quality, 'blocked'); assert.equal(current.valuations[0].nav_cny, null);
      assert.equal(current.advice_status, 'blocked');
      const cashOnly = await post({ action: 'record_fact', command: command({ type: 'deposit', account_id: foreignAccount, amount: '1000' }, { portfolio_id: otherPortfolio, expected_revision: 0 }) });
      assert.equal(cashOnly.status, 200, JSON.stringify(cashOnly.json));
      const cashTask = await post({ action: 'enqueue_task', command: { portfolio_id: otherPortfolio, expected_revision: 1, idempotency_key: 'cash-only-valuation', command_type: 'valuation', payload: { cutoff_at: new Date().toISOString(), rules: { ...rules, approved: true, approval_evidence: 'Synthetic cash-only integration fixture, not investment approval' } } } });
      assert.equal(cashTask.status, 200, JSON.stringify(cashTask.json));
      runWorker(); current = await state(otherPortfolio);
      assert.equal(current.valuations[0].quality, 'complete'); assert.equal(current.valuations[0].nav_cny, '1000');
      assert.equal(current.tasks.length, 1); assert.equal((await state()).tasks.length, 1);
      assert.equal((await state()).revision, revision);
      return { blocked_snapshot_keeps_nav_null: true, cash_only_nav_cny: '1000', broker_orders: 0 };
    });
    await check('HTTP-22', 'recovery lock permits reads and attachment downloads but prevents all actual writes', async () => {
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW');
      writeFileSync(marker, 'Synthetic recovery fixture\n');
      try {
        assert.equal((await state()).revision, revision);
        assert.equal((await post({ action: 'record_fact', command: command({ type: 'deposit', amount: '1' }) })).status, 423);
        assert.equal((await post({ action: 'create_portfolio', name: 'Forbidden recovery write' })).status, 423);
        assert.equal((await request(`/api/workbench/attachments/${statementAttachment.id}?portfolio=${portfolio}`, { headers: { Cookie: cookie } })).status, 200);
      } finally { rmSync(marker); }
    });
    await check('HTTP-23', 'performance job separates unavailable same-day XIRR from exact zero return', async () => {
      const first = (await state(otherPortfolio)).valuations[0];
      const rules = { schema_version: 'valuation-rules-v1', approved: true, approval_evidence: 'Synthetic cash-only fixture', price_scope_by_market: {}, expected_sessions: {}, corporate_actions_complete: {}, max_fx_age_seconds: 0 };
      const queued = await post({ action: 'enqueue_task', command: { portfolio_id: otherPortfolio, expected_revision: 1, idempotency_key: 'cash-second', command_type: 'valuation', payload: { cutoff_at: new Date().toISOString(), rules } } });
      assert.equal(queued.status, 200, JSON.stringify(queued.json));
      const runWorker = () => {
        const worker = spawnSync(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-m', 'worker.orchestration', '--db', filename, '--once'], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: path.join(directory, 'auth'), WORKBENCH_MODE: 'ledger' }, encoding: 'utf8', timeout: 30000 });
        assert.equal(worker.status, 0, worker.stderr || worker.stdout);
      };
      runWorker();
      const second = (await state(otherPortfolio)).valuations[0];
      assert.notEqual(first.id, second.id);
      const performance = await post({ action: 'enqueue_task', command: { portfolio_id: otherPortfolio, expected_revision: 1, idempotency_key: 'cash-performance', command_type: 'performance', payload: { valuation_ids: [first.id, second.id], evaluation_timezone: 'Asia/Shanghai' } } });
      assert.equal(performance.status, 200, JSON.stringify(performance.json));
      runWorker();
      const snapshot = (await state(otherPortfolio)).performance[0];
      assert.equal(snapshot.quality, 'complete'); assert.equal(snapshot.method, 'exact_twr');
      const result = JSON.parse(snapshot.result_json);
      assert.equal(result.net_profit_cny, '0'); assert.equal(result.return.value, '0');
      assert.equal(result.xirr.status, 'same_day_flows'); assert.equal(result.xirr.rate, null);
      assert.deepEqual((await state()).performance, []);
    });
    await check('HTTP-24', 'append-only correction preserves original facts and invalidates old snapshots', async () => {
      const prior = await state(otherPortfolio), original = prior.events[0];
      const evidence = await post({ action: 'store_attachment', portfolio_id: otherPortfolio, account_id: foreignAccount, raw: '{"reason":"Synthetic corrected bank record: 900, not 1000"}' });
      assert.equal(evidence.status, 200);
      const old = JSON.parse(original.payload_json);
      const command = { portfolio_id: otherPortfolio, expected_revision: prior.revision, idempotency_key: 'correction-http', attachment_id: evidence.json.id, reason: 'Synthetic amount correction', changes: [{ action: 'replace', event_id: original.id, replacement: { fact: { ...old.fact, amount: '900' }, effective_at: original.effective_at, time_precision: old.time_precision, source_timezone: old.source_timezone } }] };
      const corrected = await post({ action: 'correct_ledger', command });
      assert.equal(corrected.status, 200, JSON.stringify(corrected.json)); assert.equal(corrected.json.reversals.length, 1);
      assert.equal((await post({ action: 'correct_ledger', command })).json.duplicate, true);
      const current = await state(otherPortfolio);
      assert.equal(current.balances.find(row => row.account_id === foreignAccount && row.ledger_account === 'cash_settled').balance, '900');
      assert.equal(current.events.find(row => row.id === original.id).payload_json, original.payload_json);
      assert.equal(current.valuation_status, 'stale'); assert.equal(current.performance[0].ledger_revision, 1);
      assert.equal((await state()).revision, revision);
    });
    await check('HTTP-25', 'research and governance views are authenticated, scoped and remain unapproved', async () => {
      for (const view of ['research', 'governance']) {
        const page = await request(`/workbench/${view}`, { headers: { Cookie: cookie } });
        assert.equal(page.status, 200);
        const result = await jsonRequest(`/api/workbench?portfolio=${portfolio}&view=${view}`, { headers: { Cookie: cookie } });
        assert.equal(result.status, 200, JSON.stringify(result.json));
        assert.match(result.headers.get('cache-control'), /no-store/);
      }
      const research = await jsonRequest(`/api/workbench?portfolio=${portfolio}&view=research`, { headers: { Cookie: cookie } });
      assert.deepEqual(research.json.experiments, []); assert.equal(research.json.live_advice_eligible, false);
      assert.equal((await jsonRequest('/api/workbench?view=research', { headers: { Cookie: cookie } })).status, 400);
      assert.equal((await post({ action: 'governance', command: { operation: 'create_policy', command: {}, actor: { kind: 'human' } } })).status, 400);
      assert.equal((await post({ action: 'governance', command: { operation: 'place_order', command: {} } })).status, 400);
    });
    await check('HTTP-26', 'Web-to-worker research freezes its own implementation and never creates actual facts', async () => {
      const python = process.env.WORKBENCH_TEST_PYTHON || 'python3';
      const fixture = spawnSync(python, ['-c', 'import json; from tests.research.fixtures import dataset,plan,parameters; print(json.dumps({"dataset":dataset(),"plan":plan(),"parameters":parameters()}))'], { cwd: root, encoding: 'utf8', timeout: 10000 });
      assert.equal(fixture.status, 0, fixture.stderr);
      const prepared = JSON.parse(fixture.stdout), experiment_id = 'http-synthetic-experiment';
      const queue = async (command_type, payload, id) => {
        const response = await post({ action: 'enqueue_task', command: { portfolio_id: portfolio, expected_revision: revision, idempotency_key: id, command_type, payload } });
        assert.equal(response.status, 200, JSON.stringify(response.json));
        const worker = spawnSync(python, ['-m', 'worker.orchestration', '--db', filename, '--once'], { cwd: root, env: { ...process.env, WORKBENCH_DATA_DIR: path.join(directory, 'auth'), WORKBENCH_MODE: 'ledger' }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
        assert.equal(worker.status, 0, worker.stderr || worker.stdout);
        const task = (await state()).tasks.find(task => task.id === response.json.request_id);
        assert.equal(task.status, 'succeeded', task.result_json);
        return JSON.parse(task.result_json);
      };
      const registered = await queue('research_register', { experiment_id, dataset: prepared.dataset, plan: prepared.plan }, 'research-http-register');
      assert.equal(registered.experiment_id, experiment_id);
      const trial = await queue('research_register_trial', { experiment_id, phase: 'train', parameters: prepared.parameters }, 'research-http-trial');
      assert.ok(trial.trial_id);
      const result = await queue('research_trial', { trial_id: trial.trial_id }, 'research-http-run');
      assert.equal(result.live_advice_eligible, false);
      const context = await queue('research_ai_context', { run_id: trial.research_run_id }, 'research-http-context');
      assert.equal(context.schema_version, 'ai-research-input-v1');
      assert.equal((await post({ action: 'enqueue_task', command: { portfolio_id: otherPortfolio, expected_revision: (await state(otherPortfolio)).revision, idempotency_key: 'research-cross-scope', command_type: 'research_trial', payload: { trial_id: trial.trial_id } } })).status, 403);
      const research = await jsonRequest(`/api/workbench?portfolio=${portfolio}&view=research`, { headers: { Cookie: cookie } });
      assert.equal(research.json.trials[0].status, 'succeeded'); assert.equal(research.json.trials[0].data_mode, 'synthetic');
      assert.equal(research.json.live_advice_eligible, false); assert.equal((await state()).revision, revision);
      assert.equal(cash(await state()), '790231');
      return { research_trial_id: trial.trial_id, real_ledger_unchanged: true, live_advice_eligible: false };
    });
    let rotationPortfolio, rotationPrepared, rotationBinding;
    const rotationPython = process.env.WORKBENCH_TEST_PYTHON || 'python3';
    const rotationEnv = { PATH: process.env.PATH, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: '1', TZ: 'UTC',
      WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: path.join(directory, 'auth'), WORKBENCH_MODE: 'ledger' };
    const rotationSnapshot = () => {
      const db = new Database(filename, { readonly: true });
      try {
        return db.transaction(() => sha(JSON.stringify(['portfolios', 'accounts', 'ledger_heads', 'ledger_events', 'postings', 'position_movements',
          'security_transit_movements', 'account_projections', 'position_projections', 'policy_versions', 'strategy_versions', 'activations',
          'approval_events', 'reservations', 'execution_reports', 'proposals', 'proposal_items', 'risk_runs']
          .map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }))))).deferred();
      } finally { db.close(); }
    };
    const rotationCommand = (command_type, payload, idempotency_key) => ({ action: 'enqueue_task', command: {
      portfolio_id: rotationPortfolio, expected_revision: 0, idempotency_key, command_type, payload,
    } });
    const rotationQueue = async (command_type, payload, id, expectedStatus = 'succeeded') => {
      const body = rotationCommand(command_type, payload, id), headers = { 'X-Workbench-Session-Binding': rotationBinding };
      const response = await post(body, headers); assert.equal(response.status, 200, JSON.stringify(response.json));
      assert.equal(response.json.status, 'queued');
      const duplicate = await post(body, headers); assert.equal(duplicate.status, 200); assert.deepEqual(duplicate.json, response.json);
      const worker = spawnSync(rotationPython, ['-m', 'worker.orchestration', '--db', filename, '--once'], {
        cwd: root, env: rotationEnv, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      });
      assert.equal(worker.status, expectedStatus === 'failed' ? 2 : 0, worker.stderr || worker.stdout);
      const db = new Database(filename, { readonly: true });
      try {
        const stored = db.prepare('SELECT actor_id,payload_json FROM command_requests WHERE id=?').get(response.json.request_id);
        assert.equal(stored.actor_id, 'owner'); assert.deepEqual(JSON.parse(stored.payload_json), payload);
        const job = db.prepare('SELECT id,status,result_json FROM job_runs WHERE command_request_id=?').get(response.json.request_id);
        assert.equal(job.status, expectedStatus, job.result_json);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM job_attempts WHERE job_id=? AND status=?').get(job.id, expectedStatus).n, 1);
        return JSON.parse(job.result_json);
      } finally { db.close(); }
    };
    await check('HTTP-R01', 'authenticated v2 rotation reaches real Python execution and exposes bounded money, cost and blocked summaries without changing actual accounts', async () => {
      const session = await jsonRequest('/api/auth/session', { headers: { Cookie: cookie } });
      assert.equal(session.status, 200); assert.equal(session.json.authenticated, true);
      rotationBinding = session.json.session_binding; assert.match(rotationBinding, /^[a-f0-9]{64}$/);
      const created = await post({ action: 'create_portfolio', name: 'Synthetic rotation research only' });
      assert.equal(created.status, 200); rotationPortfolio = created.json.id;
      assert.equal((await post({ action: 'create_account', portfolio_id: rotationPortfolio, name: 'Empty synthetic research boundary', broker: 'Synthetic only', currency: 'CNY' })).status, 200);
      const before = rotationSnapshot();
      const fixture = spawnSync(rotationPython, ['-c', 'import json; from tests.research.rotation_fixtures import dataset,plan,parameters; print(json.dumps({"dataset":dataset(),"plan":plan(),"parameters":parameters()}))'], {
        cwd: root, env: rotationEnv, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      });
      assert.equal(fixture.status, 0, fixture.stderr); rotationPrepared = JSON.parse(fixture.stdout);
      assert.equal(rotationPrepared.plan.schema_version, 'research-plan-v2'); assert.equal(rotationPrepared.dataset.schema_version, 'research-dataset-v2');
      assert.equal(rotationPrepared.parameters.schema_version, 'research-rotation-parameters-v1');
      const experiment_id = 'http-synthetic-rotation-v2';
      const registered = await rotationQueue('research_register', { experiment_id, dataset: rotationPrepared.dataset, plan: rotationPrepared.plan }, 'rotation-http-register');
      assert.equal(registered.experiment_id, experiment_id);
      const trial = await rotationQueue('research_register_trial', { experiment_id, phase: 'train', parameters: rotationPrepared.parameters }, 'rotation-http-trial');
      const executed = await rotationQueue('research_trial', { trial_id: trial.trial_id }, 'rotation-http-run');
      assert.equal(executed.live_advice_eligible, false);
      const response = await jsonRequest(`/api/workbench?portfolio=${rotationPortfolio}&view=research`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
      assert.equal(response.json.live_advice_eligible, false); assert.equal(response.json.trials.length, 1);
      const summary = response.json.trials[0]; assert.equal(summary.status, 'succeeded'); assert.equal(summary.data_mode, 'synthetic');
      assert.equal(summary.plan_schema_version, 'research-plan-v2'); assert.deepEqual(JSON.parse(summary.parameters_json), rotationPrepared.parameters);
      const db = new Database(filename, { readonly: true });
      let report, simulationEventCount;
      try {
        const run = db.prepare('SELECT environment,result_json FROM research_runs WHERE id=? AND portfolio_id=?').get(trial.research_run_id, rotationPortfolio);
        assert.equal(run.environment, 'research'); report = JSON.parse(run.result_json);
        assert.equal(report.live_advice_eligible, false); assert.notEqual(report.admission_grade, 'formal_verified');
        assert.equal(Object.keys(report.strategy_gates).length, 10);
        assert.ok(Object.values(report.strategy_gates).every(gate => ['NOT_RUN', 'BLOCKED'].includes(gate.status)));
        assert.equal(report.result_hash, executed.result_hash); assert.equal(summary.result_hash, report.result_hash);
        assert.equal(report.strategy.engine_version, 'monthly-rotation-rebalance-v1'); assert.equal(report.benchmark.engine_version, report.strategy.engine_version);
        assert.equal(report.strategy.initial_equity_cny, rotationPrepared.plan.initial_capital_cny);
        assert.equal(report.benchmark.initial_equity_cny, report.strategy.initial_equity_cny);
        assert.equal(report.benchmark.contributions_cny, report.strategy.contributions_cny);
        for (const key of ['engine_version', 'initial_equity_cny', 'contributions_cny', 'ending_nav_cny', 'profit_cny', 'fees_cny', 'fx_fees_cny', 'slippage_cny', 'cash_rounding_cny',
          'buy_turnover_on_mean_observed_nav', 'sell_turnover_on_mean_observed_nav', 'total_turnover_on_mean_observed_nav', 'ending_cash_ratio', 'execution_failure_count', 'monthly_evaluation_counts'])
          assert.deepEqual(summary[key], report.strategy[key], key);
        assert.equal('curve' in summary, false); assert.equal('events' in summary, false); assert.equal('result_json' in summary, false);
        for (const type of ['simulated_buy', 'simulated_sell', 'stock_settlement', 'sale_cash_settlement']) assert.ok(report.strategy.events.some(event => event.type === type), type);
        for (const outcome of ['proposed', 'unchanged', 'blocked']) assert.equal(summary.monthly_evaluation_counts[outcome], report.strategy.events.filter(event => event.type === 'evaluation' && event.outcome === outcome).length);
        simulationEventCount = db.prepare('SELECT COUNT(*) n FROM simulation_events WHERE run_id=?').get(trial.research_run_id).n;
        assert.ok(simulationEventCount > 0);
      } finally { db.close(); }
      const replay = await rotationQueue('research_trial', { trial_id: trial.trial_id }, 'rotation-http-replay'); assert.equal(replay.result_hash, report.result_hash);
      const reread = new Database(filename, { readonly: true });
      try { assert.equal(reread.prepare('SELECT COUNT(*) n FROM simulation_events WHERE run_id=?').get(trial.research_run_id).n, simulationEventCount); }
      finally { reread.close(); }
      assert.equal(rotationSnapshot(), before); assert.equal((await state(rotationPortfolio)).revision, 0); assert.deepEqual((await state(rotationPortfolio)).balances, []);
      assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '790231');
      return { transport: 'real HTTP with authenticated cookie and session binding', research_trial_id: trial.trial_id, result_hash: report.result_hash,
        monthly_evaluation_counts: summary.monthly_evaluation_counts, actual_state_sha256: before, actual_tables_unchanged: 18, simulation_events: simulationEventCount, live_advice_eligible: false };
    });
    await check('HTTP-R02', 'rotation network requests reject invalid versions and forged session or result fields, while semantic failures remain failed worker evidence', async () => {
      const before = rotationSnapshot(), count = () => { const db = new Database(filename, { readonly: true });
        try { return db.prepare('SELECT COUNT(*) n FROM command_requests WHERE portfolio_id=?').get(rotationPortfolio).n; } finally { db.close(); } };
      const queuedBefore = count(), payload = { experiment_id: 'rotation-rejected', dataset: rotationPrepared.dataset, plan: rotationPrepared.plan };
      const valid = rotationCommand('research_register', payload, 'rotation-invalid');
      for (const patch of [
        { ...payload, plan: { ...rotationPrepared.plan, schema_version: 'research-plan-v1' } },
        { ...payload, plan: { ...rotationPrepared.plan, auto_approve: true } },
        { ...payload, dataset: { ...rotationPrepared.dataset, result: { status: 'PASS' } } },
      ]) assert.equal((await post(rotationCommand('research_register', patch, 'rotation-invalid'), { 'X-Workbench-Session-Binding': rotationBinding })).status, 400);
      assert.equal((await post(valid, { 'X-Workbench-Session-Binding': '0'.repeat(64) })).status, 401);
      const anonymous = await jsonRequest('/api/workbench', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(valid) });
      assert.equal(anonymous.status, 401); assert.equal(count(), queuedBefore);
      const invalid = await rotationQueue('research_register', { experiment_id: 'rotation-semantic-invalid', dataset: rotationPrepared.dataset,
        plan: { ...rotationPrepared.plan, parameter_candidates: [{ ...rotationPrepared.parameters, target_fraction: '1.1' }] } }, 'rotation-semantic-invalid', 'failed');
      assert.equal(invalid.code, 'INVALID_RESEARCH_TARGET_FRACTION'); assert.equal(invalid.live_advice_eligible, false);
      const db = new Database(filename, { readonly: true });
      try { assert.equal(db.prepare("SELECT COUNT(*) n FROM research_experiments WHERE id='rotation-semantic-invalid'").get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM research_trials t JOIN research_experiments e ON e.id=t.experiment_id WHERE e.portfolio_id=?').get(rotationPortfolio).n, 1); }
      finally { db.close(); }
      assert.equal(rotationSnapshot(), before);
      return { malformed_status: 400, anonymous_status: 401, stale_binding_status: 401, semantic_job_status: 'failed', semantic_code: invalid.code, actual_state_unchanged: true };
    });
    let fundingPortfolio, fundingAccount, fundingPlan, fundingOpening, fundingLink;
    const fundingView = async () => {
      const response = await jsonRequest(`/api/workbench?portfolio=${fundingPortfolio}&view=funding`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, JSON.stringify(response.json)); return response.json;
    };
    const fundingRequest = async (operation, values, overrides = {}) => {
      const current = await fundingView();
      return { action: 'funding', command: { operation, command: {
        portfolio_id: fundingPortfolio, expected_ledger_revision: current.ledger_revision,
        expected_funding_revision: current.funding_revision, idempotency_key: `funding-http:${++sourceSequence}`,
        reason: 'Synthetic funding HTTP verification', ...values, ...overrides,
      } } };
    };
    await check('HTTP-F01', 'dated funding plan publication changes no actual cash and uses owner authority', async () => {
      const created = await post({ action: 'create_portfolio', name: 'Synthetic funding only' }); assert.equal(created.status, 200); fundingPortfolio = created.json.id;
      const createdAccount = await post({ action: 'create_account', portfolio_id: fundingPortfolio, name: 'Synthetic funding account', broker: 'Synthetic', currency: 'CNY' });
      assert.equal(createdAccount.status, 200); fundingAccount = createdAccount.json.id;
      const before = await fundingView(); assert.equal(before.plan_status, 'not_configured'); assert.equal(before.funding_revision, 0);
      assert.equal(before.accounts.length, 1); assert.equal(before.accounts[0].id, fundingAccount); assert.deepEqual(before.account_cash, []);
      const source = { currency: 'CNY', period_start: '2026-01-01', period_end: '2026-12-31', expected_arrival_date: '2026-01-01', account_id: fundingAccount, status: 'planned' };
      fundingPlan = { schema_version: 2, title: 'Synthetic dated budget', timezone: 'Asia/Shanghai', sources: [
        { ...source, id: 'funding-initial', label: 'Synthetic initial', kind: 'initial', planned_amount: '100.25' },
        { ...source, id: 'funding-addition', label: 'Synthetic addition', kind: 'contribution', planned_amount: '50' },
      ], tranches: [{ id: 'funding-tranche', source_id: 'funding-initial', label: 'Synthetic tranche', planned_amount: '50', account_id: fundingAccount, invest_by: '2026-01-31', unspent_action: 'Manual review; no order', status: 'planned' }] };
      const body = await fundingRequest('publish_plan', { plan: fundingPlan, acknowledge_shortfall: false });
      const saved = await post(body); assert.equal(saved.status, 200, JSON.stringify(saved.json));
      const replay = await post(body); assert.equal(replay.status, 200); assert.equal(replay.json.duplicate, true);
      const forged = structuredClone(body); forged.command.command.actor = { id: 'other', kind: 'worker' };
      assert.equal((await post(forged)).status, 400);
      const current = await fundingView(); assert.equal(current.funding_revision, 1); assert.equal(current.ledger_revision, 0);
      assert.equal(current.plan_status, 'confirmed_plan'); assert.equal(current.sources[0].matched_amount, '0');
      const ledger = await state(fundingPortfolio); assert.deepEqual(ledger.events, []); assert.deepEqual(ledger.balances, []);
      assert.deepEqual(ledger.funding_summary.totals, [{ currency: 'CNY', planned_amount: '150.25' }]);
      const page = await request('/workbench/funding', { headers: { Cookie: cookie } }); assert.equal(page.status, 200); assert.match(await page.text(), /资金计划与投入批次/);
      return { funding_revision: 1, ledger_revision: 0, actual_cash: '0', planned_cny: '150.25' };
    });
    await check('HTTP-F02', 'funding rejects stale versions, scope forgery, numeric amounts and unknown fields', async () => {
      const valid = { plan: fundingPlan, acknowledge_shortfall: false };
      assert.equal((await post(await fundingRequest('publish_plan', valid, { expected_funding_revision: 0 }))).status, 409);
      assert.equal((await post(await fundingRequest('publish_plan', valid, { expected_ledger_revision: 10 }))).status, 409);
      const crossScope = structuredClone(fundingPlan); crossScope.sources[0].account_id = foreignAccount;
      assert.equal((await post(await fundingRequest('publish_plan', { ...valid, plan: crossScope }))).status, 403);
      const numeric = structuredClone(fundingPlan); numeric.sources[0].planned_amount = 100;
      assert.equal((await post(await fundingRequest('publish_plan', { ...valid, plan: numeric }))).status, 400);
      assert.equal((await post(await fundingRequest('publish_plan', { ...valid, confirmed_actual_cash: '999' }))).status, 400);
      assert.equal((await jsonRequest('/api/workbench?view=funding', { headers: { Cookie: cookie } })).status, 400);
      assert.equal((await jsonRequest(`/api/workbench?portfolio=${fundingPortfolio}&view=funding&batch=wrong`, { headers: { Cookie: cookie } })).status, 400);
      assert.equal((await fundingView()).funding_revision, 1); assert.equal((await state(fundingPortfolio)).revision, 0);
    });
    await check('HTTP-F03', 'partial receipt matches are append-only, capped and do not create cash twice', async () => {
      const fact = command({ type: 'opening_cash', account_id: fundingAccount, amount: '100.25' }, { portfolio_id: fundingPortfolio, expected_revision: 0 });
      const recorded = await post({ action: 'record_fact', command: fact }); assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
      fundingOpening = (await fundingView()).matchable_facts[0].id;
      const body = await fundingRequest('link_receipt', { source_id: 'funding-initial', ledger_event_id: fundingOpening, amount: '60' });
      const linked = await post(body); assert.equal(linked.status, 200, JSON.stringify(linked.json)); fundingLink = linked.json.id;
      assert.equal((await post(body)).json.duplicate, true);
      assert.equal((await post(await fundingRequest('link_receipt', { source_id: 'funding-initial', ledger_event_id: fundingOpening, amount: '40.26' }))).status, 400);
      assert.equal((await post(await fundingRequest('link_receipt', { source_id: 'funding-addition', ledger_event_id: fundingOpening, amount: '1' }))).status, 400);
      assert.equal((await post(await fundingRequest('link_receipt', { source_id: 'funding-initial', ledger_event_id: fundingOpening, amount: '40.25' }))).status, 200);
      const current = await fundingView(); assert.equal(current.sources[0].matched_amount, '100.25'); assert.equal(current.sources[0].opening_amount, '100.25');
      assert.equal(current.matchable_facts[0].remaining_amount, '0'); assert.equal(current.ledger_revision, 1);
      assert.equal(current.account_cash[0].available, '100.25'); assert.equal((await state(fundingPortfolio)).events.length, 1);
      return { matched: '100.25', available_cash: '100.25', actual_events: 1 };
    });
    await check('HTTP-F04', 'budget shortfalls require acknowledgement; defer and unmatch preserve facts', async () => {
      const reduced = structuredClone(fundingPlan); reduced.sources[0].planned_amount = '90';
      assert.equal((await post(await fundingRequest('publish_plan', { plan: reduced, acknowledge_shortfall: false }))).status, 400);
      assert.equal((await post(await fundingRequest('publish_plan', { plan: reduced, acknowledge_shortfall: true }))).status, 200);
      assert.equal((await fundingView()).sources[0].excess_arrival, '10.25');
      const future = new Date(); future.setUTCFullYear(future.getUTCFullYear() + 1); future.setUTCMonth(11, 15);
      const date = future.toISOString().slice(0, 10);
      const defer = await post(await fundingRequest('defer_tranche', { tranche_id: 'funding-tranche', invest_by: date, unspent_action: 'Synthetic explicit manual deferral' }));
      assert.equal(defer.status, 200, JSON.stringify(defer.json)); assert.equal((await fundingView()).tranches[0].invest_by, date);
      assert.equal((await post(await fundingRequest('unlink_receipt', { link_id: fundingLink }))).status, 200);
      const current = await fundingView(); assert.equal(current.sources[0].matched_amount, '40.25'); assert.equal(current.account_cash[0].available, '100.25');
      assert.equal(current.links.find(link => link.id === fundingLink).status, 'released'); assert.equal(current.ledger_revision, 1);
      assert.equal(current.versions.length, 3); assert.equal(current.link_history.length, 3);
      const ledger = await state(fundingPortfolio); assert.equal(ledger.funding_summary.version, 3);
      assert.deepEqual(ledger.funding_summary.totals, [{ currency: 'CNY', planned_amount: '140' }]);
    });
    await check('HTTP-F05', 'recovery marker keeps funding readable and denies every new mutation', async () => {
      const body = await fundingRequest('unlink_receipt', { link_id: 'synthetic-unknown-link' });
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic restore guard');
      try {
        assert.equal((await fundingView()).read_only, true); assert.equal((await state(fundingPortfolio)).read_only, true);
        assert.equal((await post(body)).status, 423);
      } finally { rmSync(marker); }
      const db = new Database(filename, { readonly: true });
      try {
        assert.deepEqual(db.prepare('SELECT DISTINCT actor_id FROM funding_plan_links WHERE portfolio_id=?').all(fundingPortfolio), [{ actor_id: 'owner' }]);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_events WHERE portfolio_id=?').get(fundingPortfolio).n, 1);
      } finally { db.close(); }
    });
    await check('HTTP-SEC01', 'securities transfer preview, exact partial receipt and return never create cash or income', async () => {
      const created = await post({ action: 'create_portfolio', name: 'Synthetic securities only' }); assert.equal(created.status, 200);
      const p = created.json.id;
      const source = await post({ action: 'create_account', portfolio_id: p, name: 'Synthetic transfer source', broker: 'Not an actual broker', currency: 'CNY' });
      const target = await post({ action: 'create_account', portfolio_id: p, name: 'Synthetic transfer target', broker: 'Not an actual broker', currency: 'CNY' });
      assert.equal(source.status, 200); assert.equal(target.status, 200);
      const a = source.json.id, b = target.json.id;
      const factCommand = async fact => command({ account_id: a, currency: 'CNY', ...fact }, { portfolio_id: p, expected_revision: (await state(p)).revision });
      const valueEvidence = { schema_version: 'security-transfer-value-v1', reference: 'Synthetic confirmed total market value', effective_at: '2026-01-01', time_precision: 'date', source_timezone: 'Asia/Shanghai' };
      const incoming = await factCommand({ type: 'security_in', listing_id: 'http-listing', quantity: '3', cost_amount: '1', market_value: '6', value_evidence: valueEvidence });
      const { portfolio_id: _p, expected_revision: _r, idempotency_key: _key, ...row } = incoming;
      const previewed = await post({ action: 'preview_import', portfolio_id: p, account_id: a, raw: JSON.stringify([row]) });
      assert.equal(previewed.status, 200); assert.equal(previewed.json.status, 'preview'); assert.equal((await state(p)).revision, 0);
      const body = { action: 'confirm_import', portfolio_id: p, batch_id: previewed.json.id, preview_hash: previewed.json.preview_hash, expected_revision: 0 };
      assert.equal((await post(body)).status, 200); assert.equal((await post(body)).json.duplicate, true);
      const badValue = await post({ action: 'record_fact', command: await factCommand({ type: 'security_out', listing_id: 'http-listing', quantity: '1', market_value: '2', value_evidence: { ...valueEvidence, effective_at: '2026-01-02' } }) });
      assert.equal(badValue.status, 400); assert.equal(badValue.json.error, 'SECURITY_VALUE_TIME_MISMATCH');
      const dispatched = await post({ action: 'record_fact', command: await factCommand({ type: 'security_transfer_out', listing_id: 'http-listing', quantity: '3', target_account_id: b }) });
      assert.equal(dispatched.status, 200, JSON.stringify(dispatched.json));
      let view = await state(p); assert.equal(view.security_transits.length, 1); assert.equal(view.positions.filter(position => position.account_id === b).length, 0);
      const received = await post({ action: 'record_fact', command: await factCommand({ type: 'security_transfer_in', account_id: b, listing_id: 'http-listing', quantity: '1', related_event_id: dispatched.json.event_id }) });
      assert.equal(received.status, 200, JSON.stringify(received.json));
      view = await state(p); assert.equal(view.positions.find(position => position.account_id === b).cost_amount, '0.333333333333333333');
      assert.equal(view.security_transits[0].cost_amount, '0.666666666666666667');
      const returned = await post({ action: 'record_fact', command: await factCommand({ type: 'security_transfer_return', listing_id: 'http-listing', quantity: '2', related_event_id: dispatched.json.event_id }) });
      assert.equal(returned.status, 200, JSON.stringify(returned.json));
      view = await state(p); assert.equal(view.revision, 4); assert.equal(view.security_transits.length, 0);
      assert.equal(view.balances.filter(balance => ['cash_settled', 'income', 'trade_payable', 'trade_receivable'].includes(balance.ledger_account)).length, 0);
      assert.equal(view.positions.find(position => position.account_id === a).cost_amount, '0.666666666666666667');
      return { revision: 4, cash_rows: 0, income_rows: 0, pending_lots: 0, received_cost: '0.333333333333333333', returned_cost: '0.666666666666666667' };
    });
    let csvPortfolio, csvAccount, csvMapping, csvPreview, csvConfirmed, csvPending;
    const csvBytes = Buffer.from('\ufeffdate,amount,id,note\r\n2026-01-01,100.123456789012345678,csv-http-1,"Synthetic line one\r\n合成凭证"\r\n2026-01-02,50,csv-http-2,Second synthetic deposit\r\n');
    const csvForm = (bytes = csvBytes, overrides = {}) => {
      const form = new FormData();
      form.set('portfolio_id', overrides.portfolio_id ?? csvPortfolio);
      form.set('account_id', overrides.account_id ?? csvAccount);
      form.set('expected_revision', String(overrides.expected_revision ?? 0));
      form.set('mapping', overrides.mapping ?? JSON.stringify(csvMapping));
      form.set('file', new Blob([bytes], { type: 'text/csv' }), overrides.filename ?? 'synthetic-deposits.csv');
      return form;
    };
    const csvUpload = (form) => jsonRequest('/api/workbench/csv', { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: form });
    const inspectionDialect = { encoding: 'utf-8', delimiter: ',', record_separator: 'either' };
    const inspectionForm = (bytes = csvBytes, overrides = {}) => {
      const form = new FormData();
      form.set('portfolio_id', overrides.portfolio_id ?? csvPortfolio);
      form.set('account_id', overrides.account_id ?? csvAccount);
      form.set('expected_revision', String(overrides.expected_revision ?? 3));
      const dialect = overrides.dialect ?? inspectionDialect;
      form.set('dialect', typeof dialect === 'string' ? dialect : JSON.stringify(dialect));
      if (overrides.values !== undefined) form.set('values', typeof overrides.values === 'string' ? overrides.values : JSON.stringify(overrides.values));
      form.set('file', new Blob([bytes], { type: 'text/csv' }), 'synthetic-inspection.csv');
      return form;
    };
    const inspectUpload = form => jsonRequest('/api/workbench/csv/inspect', { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: form });
    const inspectionStorage = () => {
      const db = new Database(filename, { readonly: true });
      let tables;
      try {
        tables = db.transaction(() => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => {
          const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort();
          return { name, rows: rows.length, sha256: sha(JSON.stringify(rows)) };
        })).deferred();
      } finally { db.close(); }
      const inventoryEvidence = relative => {
        const file = path.join(directory, relative);
        if (!existsSync(file)) return [];
        const stat = statSync(file), entry = { path: relative, mode: stat.mode & 0o777, type: stat.isDirectory() ? 'directory' : 'file' };
        return stat.isDirectory() ? [entry, ...readdirSync(file).sort().flatMap(name => inventoryEvidence(`${relative}/${name}`))] : [{ ...entry, bytes: stat.size, sha256: sha(readFileSync(file)) }];
      };
      return { tables, attachments: ['attachments', 'auth/attachments'].flatMap(inventoryEvidence) };
    };
    // Send headers but no body: a response proves auth/Origin did not wait for multipart consumption.
    const inspectBeforeBody = headers => new Promise((resolve, reject) => {
      const target = new URL(address), socket = net.connect({ host: target.hostname, port: Number(target.port) });
      let received = '', done = false;
      const finish = (error, status) => { if (done) return; done = true; socket.destroy(); if (error) reject(error); else resolve(status); };
      socket.setTimeout(10000, () => finish(new Error('Inspector did not reject before reading the unsent body.')));
      socket.on('error', error => finish(error));
      socket.on('end', () => finish(new Error('Inspector closed without a response to request headers.')));
      socket.on('connect', () => socket.write([
        'POST /api/workbench/csv/inspect HTTP/1.1', `Host: ${target.host}`,
        'Content-Type: multipart/form-data; boundary=synthetic-inspection-auth', 'Content-Length: 5242881', 'Connection: close',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', '',
      ].join('\r\n')));
      socket.on('data', chunk => {
        received += chunk.toString('latin1');
        if (received.includes('\r\n\r\n')) {
          const match = /^HTTP\/1\.[01] (\d{3}) /.exec(received);
          if (!match) finish(new Error('Inspector returned an invalid HTTP status line.'));
          else finish(null, Number(match[1]));
        }
      });
    });
    const csvReview = batch => ({ acknowledge_unverified_mapping: true, review_hash: batch.csv.review_hash, rows: [] });
    const csvConfirmation = batch => ({ action: 'confirm_import', portfolio_id: csvPortfolio, batch_id: batch.id, preview_hash: batch.preview_hash, expected_revision: batch.expected_revision, csv_review: csvReview(batch) });
    const csvCash = snapshot => snapshot.balances.find(row => row.account_id === csvAccount && row.currency === 'CNY' && row.ledger_account === 'cash_settled')?.balance ?? '0';
    await check('HTTP-CSV01', 'real multipart CSV preview retains explicit mapping and row locations without publishing facts', async () => {
      const created = await post({ action: 'create_portfolio', name: 'Synthetic CSV integration only' }); assert.equal(created.status, 200); csvPortfolio = created.json.id;
      const createdAccount = await post({ action: 'create_account', portfolio_id: csvPortfolio, name: 'Synthetic CSV account', broker: 'Not a verified broker format', currency: 'CNY' });
      assert.equal(createdAccount.status, 200); csvAccount = createdAccount.json.id;
      csvMapping = {
        schema_version: 'csv-import-mapping-v1', mapping_id: 'HTTP-SYNTHETIC-DEPOSIT', version: 1, title: 'Synthetic manual mapping only',
        dialect: { encoding: 'utf-8', delimiter: ',', record_separator: 'either' }, expected_headers: ['date', 'amount', 'id', 'note'], ignored_columns: [],
        account: { kind: 'constant', value: csvAccount }, event_type: { kind: 'constant', value: 'deposit' }, source_id: 'synthetic-csv-http',
        source_event_id: { kind: 'column', column: 'id', trim: false, empty: 'reject' }, reason: { kind: 'column', column: 'note', trim: false, empty: 'reject' },
        effective_at: { column: 'date', format: 'YYYY-MM-DD', trim: false, source_timezone: 'Asia/Shanghai' },
        rules: [{ event_type: 'deposit', fields: { currency: { kind: 'constant', value: 'CNY' }, amount: { kind: 'decimal', column: 'amount', empty: 'reject', format: { decimal_separator: '.', grouping_separator: 'none', negative_style: 'minus', allow_leading_plus: false, trim: false } } } }],
      };
      const previewed = await csvUpload(csvForm());
      assert.equal(previewed.status, 200, JSON.stringify(previewed.json)); csvPreview = previewed.json;
      assert.equal(csvPreview.status, 'preview'); assert.equal(csvPreview.parser_version, 'csv-v1'); assert.equal(csvPreview.rows.length, 2);
      assert.equal(csvPreview.csv.broker_format_verified, false); assert.equal(csvPreview.csv.content_hash, sha(csvBytes));
      assert.deepEqual(csvPreview.csv.required_review_rows, []); assert.equal('context' in csvPreview.csv, false);
      assert.equal(csvPreview.rows[0].source.line_start, 2); assert.equal(csvPreview.rows[0].source.line_end, 3); assert.equal(csvPreview.rows[1].source.line_start, 4);
      assert.equal(csvPreview.rows[0].command.fact.amount, '100.123456789012345678');
      const current = await state(csvPortfolio); assert.equal(current.revision, 0); assert.deepEqual(current.events, []); assert.deepEqual(current.balances, []);
      const reloaded = await jsonRequest(`/api/workbench?portfolio=${csvPortfolio}&batch=${csvPreview.id}`, { headers: { Cookie: cookie } });
      assert.equal(reloaded.status, 200); assert.equal(reloaded.json.preview_hash, csvPreview.preview_hash); assert.equal(reloaded.json.csv.review_hash, csvPreview.csv.review_hash);
      return { parser: csvPreview.parser_version, original_sha256: sha(csvBytes), original_bytes: csvBytes.length, rows: 2, actual_events: 0, broker_format_verified: false };
    });
    await check('HTTP-CSV02', 'CSV and mapping originals download with exact bytes, trusted suffixes and scoped attachment headers', async () => {
      const url = `/api/workbench/attachments/${csvPreview.attachment_id}?portfolio=${csvPortfolio}`;
      const downloaded = await request(url, { headers: { Cookie: cookie } });
      assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), csvBytes);
      assert.equal(downloaded.headers.get('content-type'), 'text/csv; charset=utf-8'); assert.equal(downloaded.headers.get('content-length'), String(csvBytes.length));
      assert.equal(downloaded.headers.get('content-disposition'), `attachment; filename="${sha(csvBytes)}.csv"`);
      assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff'); assert.match(downloaded.headers.get('content-security-policy'), /sandbox/);
      assert.match(downloaded.headers.get('cache-control'), /no-store/); assert.equal(downloaded.headers.get('etag'), `"${sha(csvBytes)}"`);
      assert.equal((await request(url)).status, 401);
      assert.equal((await request(`/api/workbench/attachments/${csvPreview.attachment_id}?portfolio=${otherPortfolio}`, { headers: { Cookie: cookie } })).status, 403);
      const mappingDownload = await request(`/api/workbench/attachments/${csvPreview.csv.mapping_attachment_id}?portfolio=${csvPortfolio}`, { headers: { Cookie: cookie } });
      assert.equal(mappingDownload.status, 200); assert.equal(mappingDownload.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.match(mappingDownload.headers.get('content-disposition'), /^attachment; filename="[a-f0-9]{64}\.json"$/);
      assert.equal(await mappingDownload.text(), JSON.stringify(csvMapping));
      assert.equal((await state(csvPortfolio)).revision, 0);
      return { csv_download_sha256: sha(csvBytes), csv_mime: 'text/csv; charset=utf-8', mapping_mime: 'application/json; charset=utf-8', anonymous_status: 401, foreign_scope_status: 403 };
    });
    await check('HTTP-CSV03', 'CSV confirmation requires explicit unverified-mapping acknowledgement before exact atomic booking', async () => {
      const body = csvConfirmation(csvPreview), { csv_review: _review, ...withoutReview } = body;
      const absent = await post(withoutReview); assert.equal(absent.status, 400); assert.equal(absent.json.error, 'CSV_REVIEW_INVALID');
      assert.equal((await post({ ...body, csv_review: { ...body.csv_review, acknowledge_unverified_mapping: false } })).status, 400);
      assert.equal((await post({ ...body, csv_review: { ...body.csv_review, review_hash: '0'.repeat(64) } })).status, 409);
      assert.equal((await state(csvPortfolio)).revision, 0);
      const confirmed = await post(body); assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json)); csvConfirmed = confirmed.json;
      assert.equal(csvConfirmed.revision, 2); assert.equal(csvConfirmed.receipts.length, 2);
      const current = await state(csvPortfolio); assert.equal(current.revision, 2); assert.equal(current.events.length, 2); assert.equal(csvCash(current), '150.123456789012345678');
      const db = new Database(filename, { readonly: true });
      try {
        assert.equal(db.prepare('SELECT COUNT(*) n FROM csv_import_outcomes WHERE batch_id=?').get(csvPreview.id).n, 2);
        assert.deepEqual(db.prepare('SELECT DISTINCT actor_id,import_batch_id FROM ledger_events WHERE portfolio_id=?').all(csvPortfolio), [{ actor_id: 'owner', import_batch_id: csvPreview.id }]);
      } finally { db.close(); }
      return { actual_events: 2, ledger_revision: 2, cash_cny: csvCash(current), mapping_acknowledgement_required: true };
    });
    await check('HTTP-CSV04', 'identical confirmation and multipart file retries return the original outcome without duplicate cash', async () => {
      const retry = await post(csvConfirmation(csvPreview)); assert.equal(retry.status, 200, JSON.stringify(retry.json));
      assert.equal(retry.json.duplicate, true); assert.deepEqual(retry.json.receipts, csvConfirmed.receipts); assert.equal(retry.json.revision, 2);
      const uploaded = await csvUpload(csvForm(csvBytes, { expected_revision: 2, filename: 'renamed-synthetic-deposits.csv' }));
      assert.equal(uploaded.status, 200, JSON.stringify(uploaded.json)); assert.equal(uploaded.json.id, csvPreview.id); assert.equal(uploaded.json.status, 'confirmed'); assert.equal(uploaded.json.duplicate, true);
      const current = await state(csvPortfolio); assert.equal(current.revision, 2); assert.equal(current.events.length, 2); assert.equal(csvCash(current), '150.123456789012345678');
      return { replay_duplicate: true, repeated_upload_same_batch: true, actual_events: 2, cash_cny: csvCash(current) };
    });
    await check('HTTP-CSV05', 'malformed and partly invalid CSV retain evidence but cannot book a valid subset; malformed uploads fail safely', async () => {
      for (const raw of [
        'date,amount,id,note\r\n2026-01-03,1,csv-valid-not-booked,Valid row\r\n2026-01-03,-1,csv-invalid,Negative amount\r\n',
        'date,amount,id,note\r\n2026-01-03,1,csv-quote,"Unclosed quoted field\r\n',
      ]) {
        const invalid = await csvUpload(csvForm(Buffer.from(raw), { expected_revision: 2 }));
        assert.equal(invalid.status, 200, JSON.stringify(invalid.json)); assert.equal(invalid.json.status, 'invalid');
        assert.ok(invalid.json.csv.document_errors.length || invalid.json.rows.some(row => row.errors.length));
        const rejected = await post(csvConfirmation(invalid.json)); assert.equal(rejected.status, 400); assert.equal(rejected.json.error, 'IMPORT_HAS_ERRORS');
        const original = await request(`/api/workbench/attachments/${invalid.json.attachment_id}?portfolio=${csvPortfolio}`, { headers: { Cookie: cookie } });
        assert.equal(original.status, 200); assert.deepEqual(Buffer.from(await original.arrayBuffer()), Buffer.from(raw));
      }
      for (const change of [form => form.set('actor_id', 'forged'), form => form.append('portfolio_id', otherPortfolio)]) {
        const form = csvForm(csvBytes, { expected_revision: 2 }); change(form);
        const rejected = await csvUpload(form); assert.equal(rejected.status, 400); assert.equal(rejected.json.error, 'CSV_UPLOAD_FIELDS_INVALID');
      }
      const invalidUtf8 = await csvUpload(csvForm(Buffer.from([0xff]), { expected_revision: 2 })); assert.equal(invalidUtf8.status, 400); assert.equal(invalidUtf8.json.error, 'INVALID_UTF8');
      const invalidMapping = await csvUpload(csvForm(csvBytes, { expected_revision: 2, mapping: '{bad' })); assert.equal(invalidMapping.status, 400); assert.equal(invalidMapping.json.error, 'CSV_MAPPING_JSON_INVALID');
      const current = await state(csvPortfolio); assert.equal(current.revision, 2); assert.equal(current.events.length, 2); assert.equal(csvCash(current), '150.123456789012345678');
    });
    await check('HTTP-CSV06', 'CSV authentication precedes oversized-body validation and transport, file and mapping limits are enforced', async () => {
      const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 65), multipart = 'multipart/form-data; boundary=synthetic-auth';
      const anonymous = await jsonRequest('/api/workbench/csv', { method: 'POST', headers: { Origin: origin, 'Content-Type': multipart }, body: oversized });
      assert.equal(anonymous.status, 401); assert.equal(anonymous.json.error, 'UNAUTHENTICATED');
      const badOrigin = await jsonRequest('/api/workbench/csv', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example.test', 'Content-Type': multipart }, body: oversized });
      assert.equal(badOrigin.status, 403);
      const wrongType = await jsonRequest('/api/workbench/csv', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(wrongType.status, 415); assert.equal(wrongType.json.error, 'CSV_MULTIPART_REQUIRED');
      const streamed = await probeEarlyRejection(address + '/api/workbench/csv', { Cookie: cookie, Origin: origin, 'Content-Type': multipart });
      assert.equal(streamed.status, 413); assert.equal(streamed.json.error, 'REQUEST_TOO_LARGE'); assert.equal(streamed.headers.get('connection'), 'close');
      const largeFile = await csvUpload(csvForm(Buffer.alloc(4 * 1024 * 1024 + 1, 65), { expected_revision: 2 }));
      assert.equal(largeFile.status, 413); assert.equal(largeFile.json.error, 'CSV_TOO_LARGE');
      const largeMapping = await csvUpload(csvForm(csvBytes, { expected_revision: 2, mapping: 'x'.repeat(256 * 1024 + 1) }));
      assert.equal(largeMapping.status, 413); assert.equal(largeMapping.json.error, 'CSV_MAPPING_TOO_LARGE');
      assert.equal((await state(csvPortfolio)).revision, 2);
      return { transport_limit_bytes: 5242880, file_limit_bytes: 4194304, mapping_limit_bytes: 262144, anonymous_oversized_status: 401, wrong_origin_oversized_status: 403,
        streamed_bytes_sent: streamed.bytes_sent, streaming_request_ended: streamed.request_ended, streaming_response_complete: streamed.response_complete };
    });
    await check('HTTP-CSV07', 'CSV account scope and ledger CAS reject cross-account uploads and stale confirmations', async () => {
      assert.equal((await csvUpload(csvForm(csvBytes, { portfolio_id: otherPortfolio, expected_revision: 2 }))).status, 403);
      const staleUpload = await csvUpload(csvForm(csvBytes, { expected_revision: 0 })); assert.equal(staleUpload.status, 409); assert.equal(staleUpload.json.error, 'VERSION_CONFLICT');
      const pendingBytes = Buffer.from('date,amount,id,note\r\n2026-01-03,25,csv-pending,Pending synthetic deposit\r\n');
      const pending = await csvUpload(csvForm(pendingBytes, { expected_revision: 2 })); assert.equal(pending.status, 200); assert.equal(pending.json.status, 'preview');
      const fee = await post({ action: 'record_fact', command: command({ type: 'fee', account_id: csvAccount, amount: '1' }, { portfolio_id: csvPortfolio, expected_revision: 2, effective_at: '2026-01-03' }) });
      assert.equal(fee.status, 200); assert.equal(fee.json.revision, 3);
      const rejected = await post(csvConfirmation(pending.json)); assert.equal(rejected.status, 409); assert.equal(rejected.json.error, 'VERSION_CONFLICT');
      const refreshed = await csvUpload(csvForm(pendingBytes, { expected_revision: 3 })); assert.equal(refreshed.status, 200); csvPending = refreshed.json;
      assert.notEqual(csvPending.id, pending.json.id); assert.equal(csvPending.expected_revision, 3); assert.equal(csvPending.status, 'preview');
      const current = await state(csvPortfolio); assert.equal(current.revision, 3); assert.equal(current.events.length, 3); assert.equal(csvCash(current), '149.123456789012345678');
      assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '790231');
      return { stale_upload_status: 409, stale_confirmation_status: 409, refreshed_preview_without_booking: true, isolated_ledger_revision: 3 };
    });
    const beforeInspection = inspectionStorage();
    await check('HTTP-INS01', 'inspector authentication and both Origin checks reject before any multipart body is sent', async () => {
      assert.equal(await inspectBeforeBody({ Origin: origin }), 401);
      assert.equal(await inspectBeforeBody({ Cookie: cookie }), 403);
      assert.equal(await inspectBeforeBody({ Cookie: cookie, Origin: 'https://evil.example.test' }), 403);
      const wrongType = await jsonRequest('/api/workbench/csv/inspect', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(wrongType.status, 415); assert.equal(wrongType.json.error, 'CSV_MULTIPART_REQUIRED');
      assert.match(wrongType.headers.get('cache-control'), /no-store/);
      return { body_bytes_sent: 0, declared_body_bytes: 5242881, anonymous_status: 401, missing_origin_status: 403, wrong_origin_status: 403 };
    });
    await check('HTTP-INS02', 'inspector binds account scope and exact current revision and rejects malformed request fields', async () => {
      for (const [overrides, status, error] of [
        [{ account_id: foreignAccount }, 403, 'ACCOUNT_OUT_OF_SCOPE'],
        [{ portfolio_id: otherPortfolio }, 403, 'ACCOUNT_OUT_OF_SCOPE'],
        [{ portfolio_id: 'synthetic-absent-portfolio' }, 404, 'PORTFOLIO_NOT_FOUND'],
        [{ expected_revision: 2 }, 409, 'VERSION_CONFLICT'],
        [{ expected_revision: 4 }, 409, 'VERSION_CONFLICT'],
        [{ expected_revision: '3.0' }, 400, 'CSV_INSPECTION_FIELDS_INVALID'],
        [{ expected_revision: '9007199254740992' }, 400, 'CSV_INSPECTION_FIELDS_INVALID'],
        [{ dialect: '{bad' }, 400, 'CSV_INSPECTION_DIALECT_INVALID'],
        [{ dialect: 'auto', values: { column: 'id', trim: false, offset: 0, limit: 1 } }, 400, 'CSV_INSPECTION_FIELDS_INVALID'],
      ]) {
        const result = await inspectUpload(inspectionForm(csvBytes, overrides));
        assert.equal(result.status, status, JSON.stringify(result.json)); assert.equal(result.json.error, error);
      }
      for (const change of [form => form.append('account_id', csvAccount), form => form.set('actor_id', 'forged'), form => form.delete('dialect')]) {
        const form = inspectionForm(); change(form);
        const result = await inspectUpload(form); assert.equal(result.status, 400); assert.equal(result.json.error, 'CSV_INSPECTION_FIELDS_INVALID');
      }
      return { account_scope_status: 403, stale_and_future_revision_status: 409, fractional_revision_status: 400 };
    });
    await check('HTTP-INS03', 'inspector bounds streaming uploads, original bytes and values requests without storing rejected evidence', async () => {
      const streamed = await probeEarlyRejection(address + '/api/workbench/csv/inspect', { Cookie: cookie, Origin: origin, 'Content-Type': 'multipart/form-data; boundary=synthetic-inspection-limit' });
      assert.equal(streamed.status, 413); assert.equal(streamed.json.error, 'REQUEST_TOO_LARGE'); assert.equal(streamed.headers.get('connection'), 'close');
      const large = await inspectUpload(inspectionForm(Buffer.alloc(4 * 1024 * 1024 + 1, 65)));
      assert.equal(large.status, 413); assert.equal(large.json.error, 'CSV_TOO_LARGE');
      for (const overrides of [
        { values: { column: 'id', trim: false, offset: 0, limit: 101 } },
        { values: { column: 'id', trim: false, offset: -1, limit: 100 } },
        { values: 'x'.repeat(4097) }, { dialect: 'x'.repeat(1025) },
      ]) {
        const invalid = await inspectUpload(inspectionForm(csvBytes, overrides));
        assert.equal(invalid.status, 400); assert.equal(invalid.json.error, 'CSV_INSPECTION_FIELDS_INVALID');
      }
      const invalidUtf8 = await inspectUpload(inspectionForm(Buffer.from([0xff])));
      assert.equal(invalidUtf8.status, 400); assert.equal(invalidUtf8.json.error, 'INVALID_UTF8');
      return { transport_limit_bytes: 5242880, file_limit_bytes: 4194304, values_page_limit: 100,
        streamed_bytes_sent: streamed.bytes_sent, streaming_request_ended: streamed.request_ended, streaming_response_complete: streamed.response_complete };
    });
    await check('HTTP-INS04', 'inspector auto never selects semantics; explicit dialect preserves BOM, original row bytes and scoped identities', async () => {
      for (const raw of [csvBytes, Buffer.from('Code\n000001\n'), Buffer.from('Code;Note\n000001;"contains,comma"\n')]) {
        const automatic = await inspectUpload(inspectionForm(raw, { dialect: 'auto' }));
        assert.equal(automatic.status, 200, JSON.stringify(automatic.json));
        assert.deepEqual(automatic.json.candidates.map(item => item.dialect.delimiter), [',', ';', '\t']);
        assert.equal(automatic.json.selected, null); assert.equal(automatic.json.values, null); assert.equal(automatic.json.content_hash, sha(raw));
      }
      const explicit = await inspectUpload(inspectionForm()); assert.equal(explicit.status, 200, JSON.stringify(explicit.json));
      const inspected = explicit.json;
      assert.equal(inspected.schema_version, 'csv-inspection-v1'); assert.equal(inspected.parser_version, 'strict-csv-utf8-v1');
      assert.equal(inspected.portfolio_id, csvPortfolio); assert.equal(inspected.account_id, csvAccount); assert.equal(inspected.ledger_revision, 3);
      assert.equal(inspected.content_hash, csvPreview.csv.content_hash); assert.equal(inspected.content_hash, sha(csvBytes)); assert.equal(inspected.byte_length, csvBytes.length); assert.equal(inspected.bom, true);
      assert.equal(inspected.selected.valid, true); assert.deepEqual(inspected.selected.headers, csvMapping.expected_headers); assert.deepEqual(inspected.selected.dialect, inspectionDialect);
      assert.equal(inspected.selected.row_count, 2); assert.equal(inspected.selected.header_location.byte_start, 3);
      const first = inspected.selected.sample_rows[0];
      assert.equal(first.record_number, 2); assert.equal(first.line_start, 2); assert.equal(first.line_end, 3);
      assert.equal(csvBytes.subarray(first.byte_start, first.byte_end).toString('utf8'), '2026-01-01,100.123456789012345678,csv-http-1,"Synthetic line one\r\n合成凭证"');
      assert.equal(first.cells[1].value, '100.123456789012345678'); assert.equal(first.cells[3].value, 'Synthetic line one\r\n合成凭证');
      assert.deepEqual(inspected.context.accounts.items.map(item => item.id), [csvAccount]); assert.equal(inspected.context.accounts.total, 1); assert.equal(inspected.context.accounts.truncated, false);
      assert.ok(inspected.context.listings.items.some(item => item.id === 'http-listing')); assert.equal(inspected.context.listings.truncated, false);
      assert.equal(inspected.state_written, false); assert.equal(inspected.broker_format_verified, false); assert.match(explicit.headers.get('cache-control'), /no-store/); assert.equal(explicit.headers.get('x-content-type-options'), 'nosniff');
      const semicolon = await inspectUpload(inspectionForm(Buffer.from('Code;Note\n000001;"contains,comma"\n'), { dialect: { ...inspectionDialect, delimiter: ';' } }));
      assert.equal(semicolon.status, 200); assert.equal(semicolon.json.selected.valid, true); assert.deepEqual(semicolon.json.selected.sample_rows[0].cells.map(cell => cell.value), ['000001', 'contains,comma']);
      return { selected_only_when_explicit: true, original_sha256: sha(csvBytes), revision: 3, other_portfolio_accounts_exposed: 0, state_written: false };
    });
    await check('HTTP-INS05', 'inspector full-file values page exactly with leading zeros, duplicate counts and explicit trim', async () => {
      const originals = Array.from({ length: 205 }, (_, i) => String(i).padStart(6, '0'));
      const bytes = Buffer.from(['Code', ...originals, '000001'].join('\n')), all = [], offsets = [];
      let offset = 0;
      while (offset !== null) {
        assert.ok(offsets.length < 4, 'Values cursor must progress.'); offsets.push(offset);
        const result = await inspectUpload(inspectionForm(bytes, { values: { column: 'Code', trim: false, offset, limit: 100 } }));
        assert.equal(result.status, 200, JSON.stringify(result.json)); assert.equal(result.json.content_hash, sha(bytes)); assert.equal(result.json.ledger_revision, 3);
        const page = result.json.values;
        assert.equal(page.total, 205); assert.equal(page.offset, offset); assert.ok(page.items.length > 0 && page.items.length <= 100);
        if (offset === 0) assert.deepEqual(page.items[1], { value: '000001', count: 2, first_record_number: 3, lookup_compatible: true, formula_like: false });
        all.push(...page.items.map(item => item.value));
        if (page.next_offset !== null) assert.equal(page.next_offset, offset + page.items.length);
        offset = page.next_offset;
      }
      assert.deepEqual(all, originals); assert.deepEqual(offsets, [0, 100, 200]);
      const spaces = Buffer.from('Code\n 001\n001 \n002\n');
      const untrimmed = await inspectUpload(inspectionForm(spaces, { values: { column: 'Code', trim: false, offset: 0, limit: 100 } }));
      const trimmed = await inspectUpload(inspectionForm(spaces, { values: { column: 'Code', trim: true, offset: 0, limit: 100 } }));
      assert.equal(untrimmed.status, 200); assert.equal(trimmed.status, 200);
      assert.deepEqual(untrimmed.json.values.items.map(item => item.value), [' 001', '001 ', '002']); assert.equal(trimmed.json.values.total, 2); assert.equal(trimmed.json.values.items[0].count, 2);
      for (const [column, offset, error] of [['missing', 0, 'CSV_COLUMN_NOT_FOUND'], ['Code', 206, 'CSV_INSPECTION_VALUES_INVALID']]) {
        const invalid = await inspectUpload(inspectionForm(bytes, { values: { column, trim: false, offset, limit: 100 } }));
        assert.equal(invalid.status, 400); assert.equal(invalid.json.error, error);
      }
      const end = await inspectUpload(inspectionForm(bytes, { values: { column: 'Code', trim: false, offset: 205, limit: 100 } }));
      assert.equal(end.status, 200); assert.deepEqual(end.json.values.items, []); assert.equal(end.json.values.next_offset, null);
      return { unique_values: 205, duplicate_count: 2, offsets, exact_first_occurrence_order: true };
    });
    await check('HTTP-INS06', 'inspector distinguishes truncated samples from exact values and exposes invalid rows beyond the sample', async () => {
      const formula = '=' + '中'.repeat(300), bytes = Buffer.from(`Code,Note\n000001,${formula}\n`);
      const result = await inspectUpload(inspectionForm(bytes, { values: { column: 'Note', trim: false, offset: 0, limit: 100 } }));
      assert.equal(result.status, 200, JSON.stringify(result.json));
      const cell = result.json.selected.sample_rows[0].cells[1];
      assert.equal(cell.truncated, true); assert.equal(cell.formula_like, true); assert.equal(cell.byte_length, Buffer.byteLength(formula)); assert.ok(Buffer.byteLength(cell.value) <= 256); assert.equal(cell.value.includes('\ufffd'), false);
      assert.equal(result.json.values.items[0].value, formula); assert.equal(result.json.values.items[0].lookup_compatible, false); assert.equal(result.json.values.items[0].formula_like, true);
      const originals = Array.from({ length: 70 }, (_, i) => `${i}:` + 'x'.repeat(6000)), largeValues = Buffer.from(['Code', ...originals].join('\n'));
      const page1 = await inspectUpload(inspectionForm(largeValues, { values: { column: 'Code', trim: false, offset: 0, limit: 100 } }));
      assert.equal(page1.status, 200); assert.ok(page1.json.values.items.length > 0 && page1.json.values.items.length < 70); assert.equal(page1.json.values.next_offset, page1.json.values.items.length);
      const page2 = await inspectUpload(inspectionForm(largeValues, { values: { column: 'Code', trim: false, offset: page1.json.values.next_offset, limit: 100 } }));
      assert.equal(page2.status, 200); assert.equal(page2.json.values.next_offset, null); assert.deepEqual([...page1.json.values.items, ...page2.json.values.items].map(item => item.value), originals);
      const malformed = Buffer.from(['Code,Amount', ...Array.from({ length: 6 }, () => '000001,1'), 'bad-tail-only'].join('\n'));
      const invalid = await inspectUpload(inspectionForm(malformed)); assert.equal(invalid.status, 200); assert.equal(invalid.json.selected.valid, false);
      assert.equal(invalid.json.selected.sample_rows.length, 5); assert.equal(invalid.json.selected.row_error_count, 1); assert.equal(invalid.json.selected.row_errors[0].record_number, 8);
      assert.ok(invalid.json.selected.row_errors[0].errors.some(error => error.code === 'CSV_COLUMN_COUNT_MISMATCH'));
      const unavailable = await inspectUpload(inspectionForm(malformed, { values: { column: 'Code', trim: false, offset: 0, limit: 100 } }));
      assert.equal(unavailable.status, 400); assert.equal(unavailable.json.error, 'CSV_INSPECTION_VALUES_UNAVAILABLE');
      return { sample_limit_bytes: 256, values_page_limit_bytes: 262144, large_value_pages: 2, invalid_record_outside_sample: 8 };
    });
    await check('HTTP-INS07', 'every successful and rejected inspection leaves all business tables and attachment bytes unchanged', async () => {
      const after = inspectionStorage(); assert.deepEqual(after, beforeInspection);
      assert.equal((await state(csvPortfolio)).revision, 3); assert.equal(csvCash(await state(csvPortfolio)), '149.123456789012345678');
      return { tables_checked: after.tables.length, attachment_entries_checked: after.attachments.length, before_sha256: sha(JSON.stringify(beforeInspection)), after_sha256: sha(JSON.stringify(after)), writes: 0 };
    });
    await check('HTTP-CSV08', 'recovery lock permits inspection and CSV downloads but blocks upload and confirmation without touching prior scenarios', async () => {
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic CSV recovery fixture\n');
      try {
        assert.equal((await state(csvPortfolio)).read_only, true);
        const before = inspectionStorage(), inspected = await inspectUpload(inspectionForm());
        assert.equal(inspected.status, 200, JSON.stringify(inspected.json)); assert.equal(inspected.json.selected.valid, true);
        assert.equal(inspected.json.ledger_revision, 3); assert.equal(inspected.json.content_hash, sha(csvBytes)); assert.equal(inspected.json.state_written, false);
        assert.deepEqual(inspectionStorage(), before);
        const upload = await csvUpload(csvForm(csvBytes, { expected_revision: 3 })); assert.equal(upload.status, 423); assert.equal(upload.json.error, 'WORKBENCH_READ_ONLY');
        const confirmation = await post(csvConfirmation(csvPending)); assert.equal(confirmation.status, 423); assert.equal(confirmation.json.error, 'WORKBENCH_READ_ONLY');
        const download = await request(`/api/workbench/attachments/${csvPreview.attachment_id}?portfolio=${csvPortfolio}`, { headers: { Cookie: cookie } });
        assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), csvBytes);
      } finally { rmSync(marker); }
      assert.equal((await state(csvPortfolio)).revision, 3); assert.equal(csvCash(await state(csvPortfolio)), '149.123456789012345678');
      assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '790231');
    });
    let recoveryRaw, recoveredAttempt, recoveredConfirmation, recoveryReviewBatch, recoveryGoodAttempt;
    const failedRecoveryAttempts = [];
    const recoveryGet = (query = '', selectedCookie = cookie) => jsonRequest(`/api/workbench/csv/recovery${query ? `?${query}` : ''}`, { headers: selectedCookie ? { Cookie: selectedCookie } : {} });
    const recoveryForPayload = (batch, raw, selectedCookie = cookie) => recoveryGet(new URLSearchParams({ batch, payload_hash: sha(Buffer.from(raw)) }).toString(), selectedCookie);
    const rawConfirmation = raw => jsonRequest('/api/workbench', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: Buffer.from(raw) });
    const attemptsForBatch = batch => {
      const db = new Database(filename, { readonly: true });
      try { return db.prepare('SELECT id,payload_text,payload_hash FROM csv_confirmation_attempts WHERE batch_id=? ORDER BY id').all(batch); }
      finally { db.close(); }
    };
    await check('HTTP-REC01', 'discarded confirmation response is recovered through exact durable request bytes and independently checked real receipts', async () => {
      const body = csvConfirmation(csvPending);
      recoveryRaw = '\ufeff \n' + JSON.stringify({ expected_revision: body.expected_revision, csv_review: body.csv_review, preview_hash: body.preview_hash,
        action: body.action, batch_id: body.batch_id, portfolio_id: body.portfolio_id }, null, 2) + '\r\n \t';
      assert.deepEqual(attemptsForBatch(csvPending.id), []);
      const response = await request('/api/workbench', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: Buffer.from(recoveryRaw) });
      assert.equal(response.status, 200); await response.body?.cancel();
      const recovered = await recoveryForPayload(csvPending.id, recoveryRaw);
      assert.equal(recovered.status, 200, JSON.stringify(recovered.json)); const detail = recovered.json;
      assert.equal(detail.schema_version, 'csv-confirmation-recovery-v1'); assert.equal(detail.payload_text, recoveryRaw);
      assert.deepEqual(Buffer.from(detail.payload_text), Buffer.from(recoveryRaw)); assert.equal(detail.attempt.payload_hash, sha(Buffer.from(recoveryRaw)));
      assert.equal(detail.attempt.payload_bytes, Buffer.byteLength(recoveryRaw)); assert.equal(detail.attempt.expected_revision, 3);
      assert.equal(detail.attempt.portfolio_id, csvPortfolio); assert.equal(detail.attempt.account_id, csvAccount); assert.equal(detail.attempt.batch_id, csvPending.id);
      assert.equal(detail.confirmation.status, 'confirmed'); assert.equal(detail.confirmation.attempt_matches, true); assert.equal(detail.confirmation.revision, 4); assert.equal(detail.confirmation.receipts.length, 1);
      assert.equal(detail.review_error, null); assert.equal(detail.read_only, false); assert.match(detail.session_binding, /^[a-f0-9]{64}$/);
      assert.equal(detail.batch.row_count, 1); assert.equal(detail.batch.status, 'confirmed'); assert.equal('rows' in detail.batch, false);
      assert.equal(recovered.headers.get('cache-control'), 'private, no-store'); assert.ok(recovered.headers.get('vary')?.toLowerCase().split(',').map(value => value.trim()).includes('cookie'));
      recoveredAttempt = detail.attempt; recoveredConfirmation = detail.confirmation;
      const db = new Database(filename, { readonly: true });
      try {
        const receipt = detail.confirmation.receipts[0], event = db.prepare('SELECT * FROM ledger_events WHERE id=?').get(receipt.event_id);
        assert.equal(event.portfolio_id, csvPortfolio); assert.equal(event.account_id, csvAccount); assert.equal(event.import_batch_id, csvPending.id); assert.equal(event.ledger_revision, receipt.revision);
        assert.equal(db.prepare('SELECT object_id FROM audit_events WHERE id=?').get(receipt.audit_id).object_id, receipt.event_id);
        assert.equal(JSON.parse(event.payload_json).fact.amount, '25');
      } finally { db.close(); }
      assert.equal((await state(csvPortfolio)).revision, 4); assert.equal(csvCash(await state(csvPortfolio)), '174.123456789012345678');
      return { response_body_discarded_after_headers: true, recovered_only_via_get: true, exact_request_sha256: sha(Buffer.from(recoveryRaw)), request_bytes: Buffer.byteLength(recoveryRaw), actual_receipts: 1, revision: 4 };
    });
    await check('HTTP-REC02', 'same BOM, whitespace and field-order request replays to one attempt and one financial fact', async () => {
      const before = attemptsForBatch(csvPending.id); assert.equal(before.length, 1); assert.equal(before[0].payload_text, recoveryRaw);
      const replayed = await rawConfirmation(recoveryRaw); assert.equal(replayed.status, 200, JSON.stringify(replayed.json));
      assert.equal(replayed.json.duplicate, true); assert.deepEqual(replayed.json.receipts, recoveredConfirmation.receipts); assert.equal(replayed.json.revision, 4);
      assert.deepEqual(attemptsForBatch(csvPending.id), before);
      const detail = await recoveryGet(new URLSearchParams({ id: recoveredAttempt.id }).toString());
      assert.equal(detail.status, 200); assert.equal(detail.json.payload_text, recoveryRaw); assert.deepEqual(detail.json.confirmation, recoveredConfirmation);
      assert.equal((await state(csvPortfolio)).revision, 4); assert.equal(csvCash(await state(csvPortfolio)), '174.123456789012345678');
      return { exact_retry_single_attempt: true, ledger_revision_unchanged: 4, source_bytes_preserved: true };
    });
    await check('HTTP-REC03', 'missing or invalid reviews remain failed attempts without facts; an explicitly corrected review is a new successful attempt', async () => {
      const bytes = Buffer.from('date,amount,id,note\r\n2026-01-04,7,csv-recovery-review,Synthetic review correction\r\n');
      const previewed = await csvUpload(csvForm(bytes, { expected_revision: 4 })); assert.equal(previewed.status, 200); recoveryReviewBatch = previewed.json;
      const correct = csvConfirmation(recoveryReviewBatch), { csv_review: _review, ...withoutReview } = correct;
      const failures = [
        [withoutReview, 400, 'CSV_REVIEW_INVALID'],
        [{ ...correct, csv_review: { ...correct.csv_review, acknowledge_unverified_mapping: false } }, 400, 'CSV_REVIEW_INVALID'],
        [{ ...correct, csv_review: { ...correct.csv_review, review_hash: '0'.repeat(64) } }, 409, 'CSV_REVIEW_HASH_MISMATCH'],
      ];
      for (const [body, status, error] of failures) {
        const raw = ' \n' + JSON.stringify(body, null, 2) + '\n', rejected = await rawConfirmation(raw);
        assert.equal(rejected.status, status, JSON.stringify(rejected.json)); assert.equal(rejected.json.error, error);
        const restored = await recoveryForPayload(recoveryReviewBatch.id, raw); assert.equal(restored.status, 200, JSON.stringify(restored.json));
        assert.equal(restored.json.payload_text, raw); assert.equal(restored.json.review_error, error);
        assert.deepEqual(restored.json.confirmation, { status: 'unconfirmed', attempt_matches: null }); assert.equal(restored.json.batch.status, 'preview');
        failedRecoveryAttempts.push({ id: restored.json.attempt.id, raw, error });
        assert.equal((await state(csvPortfolio)).revision, 4); assert.equal(csvCash(await state(csvPortfolio)), '174.123456789012345678');
      }
      assert.equal(attemptsForBatch(recoveryReviewBatch.id).length, 3);
      const repeatedFailure = await rawConfirmation(failedRecoveryAttempts[0].raw); assert.equal(repeatedFailure.status, 400); assert.equal(attemptsForBatch(recoveryReviewBatch.id).length, 3);
      const successRaw = JSON.stringify(correct), confirmed = await rawConfirmation(successRaw); assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json)); assert.equal(confirmed.json.revision, 5);
      const success = await recoveryForPayload(recoveryReviewBatch.id, successRaw); assert.equal(success.status, 200); recoveryGoodAttempt = success.json.attempt;
      assert.equal(success.json.confirmation.attempt_matches, true); assert.deepEqual(success.json.confirmation.receipts, confirmed.json.receipts); assert.equal(success.json.review_error, null);
      assert.equal(attemptsForBatch(recoveryReviewBatch.id).length, 4);
      for (const failed of failedRecoveryAttempts) {
        const detail = await recoveryGet(new URLSearchParams({ id: failed.id }).toString()); assert.equal(detail.status, 200);
        assert.equal(detail.json.payload_text, failed.raw); assert.equal(detail.json.review_error, failed.error);
        assert.equal(detail.json.confirmation.status, 'confirmed'); assert.equal(detail.json.confirmation.attempt_matches, false);
        assert.deepEqual(detail.json.confirmation.receipts, confirmed.json.receipts); assert.notEqual(detail.json.attempt.id, recoveryGoodAttempt.id);
      }
      assert.equal((await state(csvPortfolio)).revision, 5); assert.equal(csvCash(await state(csvPortfolio)), '181.123456789012345678');
      return { failed_attempts_without_facts: 3, exact_failed_retry_no_extra_attempt: true, explicit_corrected_attempts: 1, old_attempt_matches_actual_confirmation: false, revision: 5 };
    });
    await check('HTTP-REC04', 'same owner with another session cannot list or address prior attempts and recovery bindings reveal no session authority', async () => {
      const originalProbe = await jsonRequest('/api/auth/session', { headers: { Cookie: cookie } }); assert.equal(originalProbe.status, 200);
      assert.deepEqual(Object.keys(originalProbe.json).sort(), ['authenticated', 'session_binding']); assert.equal(originalProbe.json.authenticated, true); assert.match(originalProbe.json.session_binding, /^[a-f0-9]{64}$/);
      const detail = await recoveryGet(new URLSearchParams({ id: recoveredAttempt.id }).toString()); assert.equal(detail.status, 200); assert.equal(detail.json.session_binding, originalProbe.json.session_binding);
      const db = new Database(filename, { readonly: true });
      try {
        const stored = db.prepare('SELECT session_hash FROM csv_confirmation_attempts WHERE id=?').get(recoveredAttempt.id);
        assert.notEqual(originalProbe.json.session_binding, stored.session_hash); assert.equal(JSON.stringify(detail.json).includes(stored.session_hash), false);
      } finally { db.close(); }
      assert.equal(/"(?:sid|session_id|sessionId|session_hash|actor_id)"\s*:/.test(JSON.stringify(detail.json)), false);
      const secondLogin = await request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });
      assert.equal(secondLogin.status, 303); const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
      const anotherProbe = await jsonRequest('/api/auth/session', { headers: { Cookie: secondCookie } }); assert.equal(anotherProbe.status, 200); assert.notEqual(anotherProbe.json.session_binding, originalProbe.json.session_binding);
      const empty = await recoveryGet('', secondCookie); assert.equal(empty.status, 200); assert.deepEqual(empty.json.attempts, []); assert.equal(empty.json.next_cursor, null); assert.equal(empty.json.session_binding, anotherProbe.json.session_binding);
      for (const query of [new URLSearchParams({ id: recoveredAttempt.id }).toString(), new URLSearchParams({ batch: csvPending.id, payload_hash: recoveredAttempt.payload_hash }).toString()]) {
        const denied = await recoveryGet(query, secondCookie); assert.equal(denied.status, 404); assert.deepEqual(denied.json, { error: 'CSV_RECOVERY_NOT_FOUND' });
      }
      const beforeStaleSessionPost = inspectionStorage();
      const staleSessionPost = await jsonRequest('/api/workbench', { method: 'POST', headers: { Cookie: secondCookie, Origin: origin, 'Content-Type': 'application/json', 'X-Workbench-Session-Binding': originalProbe.json.session_binding }, body: Buffer.from(recoveryRaw) });
      assert.equal(staleSessionPost.status, 401); assert.equal(staleSessionPost.json.error, 'SESSION_CHANGED'); assert.deepEqual(inspectionStorage(), beforeStaleSessionPost);
      const explicitNewSessionPost = await jsonRequest('/api/workbench', { method: 'POST', headers: { Cookie: secondCookie, Origin: origin, 'Content-Type': 'application/json', 'X-Workbench-Session-Binding': anotherProbe.json.session_binding }, body: Buffer.from(recoveryRaw) });
      assert.equal(explicitNewSessionPost.status, 200, JSON.stringify(explicitNewSessionPost.json)); assert.equal(explicitNewSessionPost.json.duplicate, true);
      assert.deepEqual(explicitNewSessionPost.json.receipts, recoveredConfirmation.receipts);
      const ownNewAttempt = await recoveryForPayload(csvPending.id, recoveryRaw, secondCookie); assert.equal(ownNewAttempt.status, 200); assert.notEqual(ownNewAttempt.json.attempt.id, recoveredAttempt.id);
      assert.equal(ownNewAttempt.json.session_binding, anotherProbe.json.session_binding); assert.equal(ownNewAttempt.json.confirmation.attempt_matches, true);
      assert.equal((await recoveryGet(new URLSearchParams({ id: recoveredAttempt.id }).toString(), secondCookie)).status, 404);
      assert.equal((await state(csvPortfolio)).revision, 5); assert.equal(csvCash(await state(csvPortfolio)), '181.123456789012345678');
      assert.equal((await recoveryGet(new URLSearchParams({ id: recoveredAttempt.id }).toString())).status, 200);
      const loggedOut = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: secondCookie, Origin: origin } }); assert.equal(loggedOut.status, 303);
      const revoked = await jsonRequest('/api/auth/session', { headers: { Cookie: secondCookie } }); assert.equal(revoked.status, 401);
      assert.equal((await recoveryGet('', secondCookie)).status, 401); assert.equal((await jsonRequest('/api/auth/session', { headers: { Cookie: cookie } })).status, 200);
      return { same_owner_other_session_initial_attempts: 0, cross_session_detail_status: 404, stale_session_post_status: 401, stale_session_post_writes: 0,
        explicit_new_session_replay_duplicate: true, public_binding_distinct_from_authority_hash: true, second_session_logout_status: 401 };
    });
    await check('HTTP-REC05', 'restore mode allows exact recovery list and detail without writes but denies even same-body confirmation retry', async () => {
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic confirmation recovery lock\n');
      try {
        const before = inspectionStorage(), list = await recoveryGet(), detail = await recoveryGet(new URLSearchParams({ id: recoveredAttempt.id }).toString());
        assert.equal(list.status, 200); assert.equal(detail.status, 200); assert.equal(list.json.read_only, true); assert.equal(detail.json.read_only, true);
        assert.equal(detail.json.payload_text, recoveryRaw); assert.deepEqual(detail.json.confirmation, recoveredConfirmation);
        assert.ok(list.json.attempts.some(attempt => attempt.id === recoveredAttempt.id));
        const denied = await rawConfirmation(recoveryRaw); assert.equal(denied.status, 423); assert.equal(denied.json.error, 'WORKBENCH_READ_ONLY');
        assert.deepEqual(inspectionStorage(), before); assert.equal((await state(csvPortfolio)).revision, 5);
      } finally { rmSync(marker); }
      return { readonly_detail_status: 200, readonly_list_status: 200, readonly_replay_status: 423, business_and_evidence_writes: 0 };
    });
    await check('HTTP-REC06', 'recovery authentication precedes query validation and scoped keyset pages reject duplicate or mixed selectors', async () => {
      const anonymous = await recoveryGet('id=not-a-uuid&id=another', ''); assert.equal(anonymous.status, 401); assert.equal(anonymous.json.error, 'UNAUTHENTICATED');
      for (const query of [
        'id=not-a-uuid', 'limit=0', 'limit=21', 'limit=1&limit=2', 'portfolio_id=forged', 'cursor=not-a-cursor',
        new URLSearchParams({ id: recoveredAttempt.id, limit: '1' }).toString(),
        new URLSearchParams({ id: recoveredAttempt.id, batch: csvPending.id, payload_hash: recoveredAttempt.payload_hash }).toString(),
        new URLSearchParams({ batch: csvPending.id }).toString(),
      ]) {
        const rejected = await recoveryGet(query); assert.equal(rejected.status, 400, JSON.stringify({ query, response: rejected.json }));
      }
      const ids = [], cursors = new Set(); let cursor = null, pages = 0;
      do {
        assert.ok(pages++ < 70, 'Recovery cursor must progress within the session budget.');
        const query = new URLSearchParams({ limit: '2', ...(cursor === null ? {} : { cursor }) });
        const page = await recoveryGet(query.toString()); assert.equal(page.status, 200, JSON.stringify(page.json)); assert.ok(page.json.attempts.length <= 2);
        for (const attempt of page.json.attempts) { assert.equal('payload_text' in attempt, false); assert.equal('session_hash' in attempt, false); ids.push(attempt.id); }
        cursor = page.json.next_cursor;
        if (cursor !== null) { assert.equal(cursors.has(cursor), false); cursors.add(cursor); }
      } while (cursor !== null);
      assert.equal(new Set(ids).size, ids.length);
      for (const id of [recoveredAttempt.id, recoveryGoodAttempt.id, ...failedRecoveryAttempts.map(attempt => attempt.id)]) assert.ok(ids.includes(id));
      return { authenticated_query_rejections: 9, unauthenticated_bad_query_status: 401, pages, unique_attempts: ids.length, list_exposes_no_payload: true };
    });
    let dividendPortfolio, dividendAccount, dividendRoot, dividendRevision = 0;
    const dividendCommand = (fact) => ({ portfolio_id: dividendPortfolio, expected_revision: dividendRevision, idempotency_key: `dividend-http:${++sourceSequence}`, source_id: 'synthetic-dividend-http', source_event_id: String(sourceSequence), effective_at: '2026-01-02', time_precision: 'date', source_timezone: 'UTC', reason: 'Synthetic dividend HTTP only', fact: { account_id: dividendAccount, currency: 'CNY', ...fact } });
    const dividendRecord = async (fact) => {
      const value = await post({ action: 'record_fact', command: dividendCommand(fact) }); assert.equal(value.status, 200, JSON.stringify(value.json)); dividendRevision = value.json.revision; return value.json;
    };
    const dividendView = (extra = '') => jsonRequest(`/api/workbench?view=dividends&portfolio=${dividendPortfolio}&account=${dividendAccount}&revision=${dividendRevision}${extra}`, { headers: { Cookie: cookie } });
    await check('HTTP-DIV01', 'unknown withholding preview creates no financial facts and confirmation retries are exact', async () => {
      const p = await post({ action: 'create_portfolio', name: 'Synthetic dividend HTTP' }); assert.equal(p.status, 200); dividendPortfolio = p.json.id;
      const a = await post({ action: 'create_account', portfolio_id: dividendPortfolio, name: 'Synthetic tax account', broker: 'Synthetic', currency: 'CNY' }); assert.equal(a.status, 200); dividendAccount = a.json.id;
      const input = dividendCommand({ type: 'dividend_accrual', amount: '200', tax_status: 'unknown' });
      const raw = JSON.stringify([input]);
      const preview = await post({ action: 'preview_import', portfolio_id: dividendPortfolio, account_id: dividendAccount, raw }); assert.equal(preview.status, 200); assert.equal(preview.json.status, 'preview');
      assert.equal((await state(dividendPortfolio)).revision, 0);
      const body = { action: 'confirm_import', portfolio_id: dividendPortfolio, batch_id: preview.json.id, preview_hash: preview.json.preview_hash, expected_revision: 0 };
      const committed = await post(body); assert.equal(committed.status, 200); dividendRevision = committed.json.revision; dividendRoot = committed.json.receipts[0].event_id;
      const repeated = await post(body); assert.equal(repeated.status, 200); assert.equal(repeated.json.duplicate, true); assert.equal(repeated.json.receipts[0].event_id, dividendRoot);
      const view = await dividendView(); assert.equal(view.status, 200); assert.equal(view.json.quality.nav_quality, 'provisional'); assert.equal(view.json.rows[0].dividend.tax_status, 'unknown');
      return { committed_revision: dividendRevision, nav_quality: view.json.quality.nav_quality, duplicate_retry: true };
    });
    await check('HTTP-DIV02', 'actual payout, cumulative tax, later deduction and refund remain separate balanced facts', async () => {
      await dividendRecord({ type: 'dividend_payment', related_event_id: dividendRoot, amount: '180' });
      await dividendRecord({ type: 'dividend_tax_assessment', related_event_id: dividendRoot, tax: '20', tax_status: 'confirmed', evidence_reference: 'Synthetic final cumulative tax' });
      let view = (await dividendView()).json; assert.equal(view.quality.nav_quality, 'complete'); assert.equal(view.rows[0].dividend.net_cash, '180'); assert.equal(view.rows[0].dividend.receivable, '0');
      await dividendRecord({ type: 'dividend_tax_assessment', related_event_id: dividendRoot, tax: '25', tax_status: 'confirmed', evidence_reference: 'Synthetic revised final tax' });
      view = (await dividendView()).json; assert.equal(view.rows[0].dividend.tax_payable, '-5'); assert.equal(view.rows[0].dividend.net_cash, '180');
      await dividendRecord({ type: 'dividend_tax_payment', related_event_id: dividendRoot, amount: '5', evidence_reference: 'Synthetic actual deduction' });
      await dividendRecord({ type: 'dividend_tax_assessment', related_event_id: dividendRoot, tax: '20', tax_status: 'confirmed', evidence_reference: 'Synthetic refund assessment' });
      await dividendRecord({ type: 'dividend_payment', related_event_id: dividendRoot, amount: '5' });
      view = (await dividendView()).json; assert.equal(view.rows[0].dividend.net_cash, '180'); assert.equal(view.rows[0].dividend.receivable, '0'); assert.equal(view.rows[0].dividend.tax_payable, '0');
      return { revision: dividendRevision, cash: '180', receivable: '0', tax_payable: '0' };
    });
    await check('HTTP-DIV03', 'net-only attribution and unresolved company actions retain independent quality', async () => {
      const net = await dividendRecord({ type: 'dividend_net', amount: '90', net_status: 'final' });
      let view = (await dividendView()).json; assert.equal(view.quality.nav_quality, 'complete'); assert.equal(view.quality.attribution_quality, 'provisional');
      await dividendRecord({ type: 'dividend_breakdown', related_event_id: net.event_id, gross_amount: '100', tax: '10', evidence_reference: 'Synthetic breakdown' });
      const notice = await dividendRecord({ type: 'corporate_action_notice', action_kind: 'merger', evidence_reference: 'Synthetic pending notice' });
      view = (await dividendView()).json; assert.equal(view.quality.nav_quality, 'blocked');
      await dividendRecord({ type: 'corporate_action_resolution', related_event_id: notice.event_id, resolution: 'not_applicable', supporting_event_ids: [], evidence_reference: 'Synthetic verified unrelated action' });
      view = (await dividendView()).json; assert.equal(view.quality.nav_quality, 'complete'); assert.equal(view.quality.attribution_quality, 'complete');
      const current = await state(dividendPortfolio); assert.equal(current.balances.find(row => row.ledger_account === 'cash_settled').balance, '270');
      return { nav_quality: 'complete', attribution_quality: 'complete', cash: '270' };
    });
    await check('HTTP-DIV04', 'dividend query scope and integer CAS reject malformed input, direct unknown tax cannot be booked', async () => {
      const direct = await post({ action: 'record_fact', command: dividendCommand({ type: 'dividend', amount: '100' }) }); assert.equal(direct.status, 400); assert.equal(direct.json.error, 'DIRECT_DIVIDEND_TAX_REQUIRED');
      const invalid = await post({ action: 'record_fact', command: dividendCommand({ type: 'dividend_tax_payment', related_event_id: dividendRoot, amount: '1', evidence_reference: 'Synthetic excessive deduction' }) }); assert.equal(invalid.status, 400); assert.equal(invalid.json.error, 'EXCEEDS_OUTSTANDING');
      for (const suffix of ['&before=0', '&before=01', '&before=-1', '&before=9007199254740992', '&account=duplicate']) assert.equal((await dividendView(suffix)).status, 400);
      const stale = await jsonRequest(`/api/workbench?view=dividends&portfolio=${dividendPortfolio}&account=${dividendAccount}&revision=0`, { headers: { Cookie: cookie } }); assert.equal(stale.status, 409);
      const cross = await jsonRequest(`/api/workbench?view=dividends&portfolio=${portfolio}&account=${dividendAccount}&revision=${revision}`, { headers: { Cookie: cookie } }); assert.equal(cross.status, 403);
      assert.equal((await state(dividendPortfolio)).revision, dividendRevision); assert.equal(cash(await state()), '790231');
      return { malformed_status: 400, stale_status: 409, cross_scope_status: 403, prior_scenario_unchanged: true };
    });
    let catalogPortfolio, catalogRevision = 0, catalogSource, catalogFirstHoldings, catalogSecondHoldings;
    const catalogGet = suffix => jsonRequest(`/api/workbench/catalog?portfolio=${catalogPortfolio}${suffix ?? ''}`, { headers: { Cookie: cookie } });
    const catalogPost = (action, command, extraHeaders = {}) => jsonRequest('/api/workbench/catalog', {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify({ action, command }),
    });
    const catalogCommand = payload => ({ portfolio_id: catalogPortfolio, expected_catalog_revision: catalogRevision, idempotency_key: `catalog:${++sourceSequence}`, ...payload });
    const catalogWrite = async (action, payload) => {
      const command = catalogCommand(payload), result = await catalogPost(action, command);
      assert.equal(result.status, 200, JSON.stringify(result.json)); catalogRevision = result.json.catalog_revision;
      assert.equal(result.json.research_only, true); return { command, result: result.json };
    };
    await check('HTTP-CAT01', 'private directory membership has independent CAS and same-body retry without personal defaults or ledger facts', async () => {
      const created = await post({ action: 'create_portfolio', name: 'Synthetic catalog scope only' }); assert.equal(created.status, 200); catalogPortfolio = created.json.id;
      const before = await catalogGet(); assert.equal(before.status, 200); assert.equal(before.json.rows.length, 0); assert.equal(before.json.catalog_revision, 0);
      const first = await catalogWrite('add_entry', { listing_id: 'http-listing' });
      const duplicate = await catalogPost('add_entry', first.command); assert.equal(duplicate.status, 200); assert.equal(duplicate.json.duplicate, true); assert.equal(duplicate.json.id, first.result.id);
      const stale = await catalogPost('add_entry', catalogCommand({ listing_id: 'http-listing-2', expected_catalog_revision: 0 })); assert.equal(stale.status, 409);
      await catalogWrite('add_entry', { listing_id: 'http-listing-2' });
      const scoped = await catalogGet(); assert.equal(scoped.json.rows.length, 2); assert.equal((await state(catalogPortfolio)).revision, 0);
      assert.equal((await state(catalogPortfolio)).balances.length, 0);
      const page = await request('/workbench/catalog', { headers: { Cookie: cookie } }); assert.equal(page.status, 200); assert.match(await page.text(), /ETF 标的与持仓比较/);
      const empty = await catalogPost('compare', { portfolio_id: catalogPortfolio, expected_catalog_revision: catalogRevision, selections: [{ listing_id: 'http-listing' }, { listing_id: 'http-listing-2' }] });
      assert.equal(empty.status, 200); assert.equal(empty.json.pairs[0].overlap, null);
      return { catalog_revision: catalogRevision, economic_revision: 0, missing_holdings_overlap: null };
    });
    await check('HTTP-CAT02', 'structured source is private, immutable, downloadable as inert JSON, and never fetched as a URL', async () => {
      const first = await catalogWrite('store_source', { reference: 'Synthetic source; not a provider original', document: { fixture: true, note: '<script>not executable</script>', holdings: [{ security_id: 'ISIN:SYNTHETIC1', weight: '0.5' }] } });
      catalogSource = first.result.id;
      const duplicate = await catalogPost('store_source', first.command); assert.equal(duplicate.status, 200); assert.equal(duplicate.json.id, catalogSource);
      const download = await catalogGet(`&view=source&source=${catalogSource}`); assert.equal(download.status, 200); assert.equal(download.json.fixture, true);
      assert.match(download.headers.get('content-disposition'), /attachment/); assert.match(download.headers.get('content-security-policy'), /sandbox/);
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); assert.match(download.headers.get('cache-control'), /no-store/);
      const cross = await jsonRequest(`/api/workbench/catalog?portfolio=${otherPortfolio}&view=source&source=${catalogSource}`, { headers: { Cookie: cookie } }); assert.equal(cross.status, 403);
      const denied = await catalogPost('store_source', catalogCommand({ reference: 'denied', document: {} }), { Origin: 'https://not-workbench.example.test' }); assert.equal(denied.status, 403);
      return { source_hash: first.result.content_hash, cross_scope_status: 403, inert_download: true };
    });
    const catalogProfile = { issuer: 'Synthetic issuer', index_id: 'SYNTHETIC:INDEX', domicile: null, underlying_asset_class: 'equity', economic_regions: [], sectors: [], annual_expense_ratio: null, distribution: 'unknown', replication: 'unknown' };
    await check('HTTP-CAT03', 'versioned profile and exact-decimal disclosure comparison preserve unknown coverage and different dates', async () => {
      for (const listing_id of ['http-listing', 'http-listing-2']) await catalogWrite('publish_profile', { listing_id, expected_profile_version: 0, source_id: catalogSource, as_of: '2025-01-01', profile: catalogProfile });
      const first = await catalogWrite('publish_holdings', { listing_id: 'http-listing', expected_holdings_version: 0, source_id: catalogSource, as_of: '2025-01-01', weight_basis: 'net_assets_long_only', complete: true, coverage: '1', items: [{ security_id: 'ISIN:SYNTHETIC1', weight: '0.50' }, { security_id: 'ISIN:SYNTHETIC2', weight: '0.5' }] });
      const second = await catalogWrite('publish_holdings', { listing_id: 'http-listing-2', expected_holdings_version: 0, source_id: catalogSource, as_of: '2025-02-01', weight_basis: 'net_assets_long_only', complete: false, coverage: '0.5', items: [{ security_id: 'ISIN:SYNTHETIC1', weight: '0.25' }, { security_id: 'ISIN:SYNTHETIC3', weight: '0.25' }] });
      catalogFirstHoldings = first.result.id; catalogSecondHoldings = second.result.id;
      const comparison = await catalogPost('compare', { portfolio_id: catalogPortfolio, expected_catalog_revision: catalogRevision, selections: [{ listing_id: 'http-listing', holdings_version_id: catalogFirstHoldings }, { listing_id: 'http-listing-2', holdings_version_id: catalogSecondHoldings }] });
      assert.equal(comparison.status, 200, JSON.stringify(comparison.json)); const result = comparison.json.pairs[0].overlap;
      assert.equal(result.known_overlap, '0.25'); assert.equal(result.conservative_upper_bound, '0.75'); assert.equal(result.coverage_b, '0.5'); assert.equal(result.quality, 'different_dates');
      const detail = await catalogGet('&view=detail&listing=http-listing'); assert.equal(detail.status, 200); assert.equal(detail.json.profile.profile.annual_expense_ratio, null); assert.equal(detail.json.profile_versions.length, 1);
      assert.equal(detail.json.account_capabilities.length, 0); assert.equal((await state(catalogPortfolio)).revision, 0);
      const db = new Database(filename, { readonly: true });
      try { assert.equal(db.prepare("SELECT status FROM listings WHERE id='http-listing'").get().status, 'unverified'); assert.equal(db.prepare('SELECT COUNT(*) n FROM policy_versions WHERE portfolio_id=?').get(catalogPortfolio).n, 0); }
      finally { db.close(); }
      return { known_overlap: result.known_overlap, upper: result.conservative_upper_bound, quality: result.quality, listing_unchanged: true };
    });
    await check('HTTP-CAT04', 'catalog pagination, scoped version binding and malformed disclosure fail closed', async () => {
      const first = await catalogGet('&limit=1'); assert.equal(first.json.rows.length, 1); assert.ok(first.json.next_cursor);
      const next = await catalogGet(`&limit=1&cursor=${first.json.next_cursor}`); assert.equal(next.status, 200); assert.equal(next.json.rows.length, 1); assert.notEqual(first.json.rows[0].listing_id, next.json.rows[0].listing_id);
      const before = catalogRevision;
      const invalid = await catalogPost('publish_holdings', catalogCommand({ listing_id: 'http-listing', expected_holdings_version: 1, source_id: catalogSource, as_of: '2025-01-01', weight_basis: 'net_assets_long_only', complete: true, coverage: '0.5', items: [{ security_id: 'ISIN:SYNTHETIC1', weight: '0.5' }] })); assert.equal(invalid.status, 400);
      const mixed = await catalogPost('compare', { portfolio_id: catalogPortfolio, expected_catalog_revision: catalogRevision, selections: [{ listing_id: 'http-listing', holdings_version_id: catalogSecondHoldings }, { listing_id: 'http-listing-2' }] }); assert.equal(mixed.status, 403);
      await catalogWrite('publish_profile', { listing_id: 'http-listing', expected_profile_version: 1, source_id: catalogSource, as_of: '2025-02-01', profile: { ...catalogProfile, annual_expense_ratio: '0.003' } });
      assert.equal((await catalogGet(`&limit=1&cursor=${first.json.next_cursor}`)).status, 409);
      const stale = await catalogPost('compare', { portfolio_id: catalogPortfolio, expected_catalog_revision: before, selections: [{ listing_id: 'http-listing' }, { listing_id: 'http-listing-2' }] }); assert.equal(stale.status, 409);
      for (const query of ['&portfolio=duplicate', '&view=source', '&limit=0', '&actor=owner']) assert.equal((await catalogGet(query)).status, 400);
      return { stale_cursor: 409, stale_comparison: 409, wrong_listing_version: 403, invalid_complete: 400 };
    });
    await check('HTTP-CAT05', 'catalog recovery mode permits private evidence reads and comparison but blocks every mutation', async () => {
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic catalog recovery fixture\n');
      try {
        assert.equal((await catalogGet()).json.read_only, true);
        assert.equal((await catalogGet(`&view=source&source=${catalogSource}`)).status, 200);
        const mutation = await catalogPost('store_source', catalogCommand({ reference: 'blocked', document: {} })); assert.equal(mutation.status, 423);
        const comparison = await catalogPost('compare', { portfolio_id: catalogPortfolio, expected_catalog_revision: catalogRevision, selections: [{ listing_id: 'http-listing' }, { listing_id: 'http-listing-2' }] }); assert.equal(comparison.status, 200);
      } finally { rmSync(marker); }
      assert.equal((await catalogGet()).json.catalog_revision, catalogRevision); assert.equal((await state(catalogPortfolio)).revision, 0); assert.equal(cash(await state()), '790231');
      return { read_only_mutation_status: 423, prior_ledger_unchanged: true };
    });
    let collectionPortfolio, collectionBinding, collectionResult;
    const collectionPayload = { provider: 'ecb', feed: 'daily', currencies: ['USD', 'HKD'], expected_publication_revision: 0, publish: true };
    const collectionCommand = (payload, idempotency_key, overrides = {}) => ({ action: 'enqueue_task', command: {
      portfolio_id: collectionPortfolio, expected_revision: 0, idempotency_key, command_type: 'market_collect', payload, ...overrides,
    } });
    const collectionHeaders = () => ({ 'X-Workbench-Session-Binding': collectionBinding });
    const collectionMarketState = () => inspectionStorage().tables.filter(row => row.name.startsWith('market_'));
    const collectionWorker = (requestId, fail = false) => {
      // This literal belongs only to the integration process. The application
      // receives the ordinary fixed-provider command, never transport controls.
      const script = `import json,sys
from unittest.mock import patch
from worker.orchestration.db import WorkbenchError,open_database
from worker.orchestration.runtime import run_pending_once
from worker.market.collection import verify_provider_capture
from tests.market.test_collection import fake_download,utc_now
db=open_database(sys.argv[1])
try:
    transport=RuntimeError('synthetic-transport-detail-not-for-api') if sys.argv[3]=='fail' else fake_download()
    with patch('worker.market.collection.download_ecb_xml',side_effect=transport) as download:
        try:
            job=run_pending_once(db,'synthetic-http-collector',lease_seconds=300,clock=utc_now)
        except WorkbenchError as error:
            print(json.dumps({'error':str(error),'download_calls':download.call_count}))
            sys.exit(2)
    assert job['command_request_id']==sys.argv[2]
    result=json.loads(job['result_json'])
    proof=verify_provider_capture(db,result['batch_id'])
    print(json.dumps({'status':job['status'],'request_id':job['command_request_id'],'download_calls':download.call_count,'proof':proof}))
finally:
    db.close()
`;
      const worker = spawnSync(process.env.WORKBENCH_TEST_PYTHON || process.env.WORKBENCH_PYTHON || 'python3', ['-c', script, filename, requestId, fail ? 'fail' : 'success'], {
        cwd: root, env: { PATH: process.env.PATH, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: '1', TZ: 'UTC',
          WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: path.join(directory, 'auth'), WORKBENCH_MODE: 'ledger' },
        encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      });
      assert.equal(worker.status, fail ? 2 : 0, worker.stderr || worker.stdout || String(worker.error));
      const result = JSON.parse(worker.stdout); assert.equal(result.download_calls, 1);
      if (fail) assert.equal(result.error, 'PROVIDER_COLLECTION_FAILED');
      return result;
    };
    await check('HTTP-MC01', 'authenticated fixed-provider command reaches real Python jobs and immutable synthetic capture without publishing financial facts or XML through the API', async () => {
      const created = await post({ action: 'create_portfolio', name: 'Synthetic provider HTTP fixture' });
      assert.equal(created.status, 200, JSON.stringify(created.json)); collectionPortfolio = created.json.id;
      const session = await jsonRequest('/api/auth/session', { headers: { Cookie: cookie } });
      assert.equal(session.status, 200); collectionBinding = session.json.session_binding; assert.match(collectionBinding, /^[a-f0-9]{64}$/);
      const financialBefore = rotationSnapshot();
      const body = collectionCommand(collectionPayload, 'http-collection-success');
      const queued = await post(body, collectionHeaders());
      assert.equal(queued.status, 200, JSON.stringify(queued.json)); assert.equal(queued.json.status, 'queued');
      const duplicate = await post(body, collectionHeaders());
      assert.equal(duplicate.status, 200); assert.deepEqual(duplicate.json, queued.json);
      const worker = collectionWorker(queued.json.request_id);
      assert.equal(worker.status, 'succeeded'); assert.equal(worker.request_id, queued.json.request_id);
      const db = new Database(filename, { readonly: true });
      let rawHash;
      try {
        const command = db.prepare('SELECT * FROM command_requests WHERE id=?').get(queued.json.request_id);
        assert.equal(command.actor_id, 'owner'); assert.deepEqual(JSON.parse(command.payload_json), collectionPayload);
        const job = db.prepare('SELECT * FROM job_runs WHERE command_request_id=?').get(command.id);
        assert.equal(job.status, 'succeeded'); assert.equal(job.attempt_count, 1);
        assert.equal(db.prepare("SELECT COUNT(*) n FROM job_attempts WHERE job_id=? AND status='succeeded' AND fencing_token=?").get(job.id, job.fencing_token).n, 1);
        collectionResult = JSON.parse(job.result_json);
        assert.equal(collectionResult.batch_status, 'published'); assert.equal(collectionResult.live_advice_eligible, false);
        const capture = db.prepare('SELECT * FROM market_provider_captures WHERE command_request_id=?').get(command.id);
        assert.ok(Buffer.isBuffer(capture.raw_body)); assert.deepEqual([...capture.raw_body.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
        const receipt = JSON.parse(capture.receipt_json); rawHash = sha(capture.raw_body);
        assert.equal(receipt.raw_sha256, rawHash); assert.equal(receipt.raw_bytes, capture.raw_body.length);
        assert.equal(receipt.capture_kind, 'http_response_bytes'); assert.equal(receipt.rate_kind, 'reference_not_executable');
        assert.equal(worker.proof.id, capture.id); assert.equal(worker.proof.raw_sha256, rawHash);
        assert.equal(worker.proof.receipt_hash, collectionResult.receipt_hash);
        const publication = db.prepare('SELECT * FROM market_publications WHERE scope=?').get('provider:ecb:fx:daily:HKD-USD');
        assert.equal(publication.revision, 1); assert.equal(publication.batch_id, capture.batch_id);
        const observations = db.prepare('SELECT observed_at,published_at,ingested_at,time_precision FROM market_observations WHERE batch_id=?').all(capture.batch_id);
        assert.equal(observations.length, 2);
        for (const row of observations) {
          assert.equal(row.observed_at, '2025-06-06'); assert.equal(row.published_at, null);
          assert.equal(row.time_precision, 'date'); assert.equal(row.ingested_at, receipt.received_at);
        }
      } finally { db.close(); }
      const current = await state(collectionPortfolio);
      assert.equal(current.revision, 0); assert.equal(current.tasks.find(row => row.id === queued.json.request_id).status, 'succeeded');
      assert.doesNotMatch(JSON.stringify(current), /<\?xml|gesmes:Envelope|"raw_body"|"normalized_json"|"document_json"/);
      assert.doesNotMatch(JSON.stringify(queued.json), /<\?xml|gesmes:Envelope|"raw_body"/);
      assert.equal(rotationSnapshot(), financialBefore);
      return { transport: 'real HTTP plus independent synthetic Python transport', original_bytes_sha256: rawHash,
        publication_revision: 1, provider_reference_not_executable: true, financial_tables_unchanged: true, api_exposes_original_xml: false };
    });
    let scheduleDue, scheduleDefinition, scheduleReceipts = [], scheduledWinner, scheduledLoser;
    const schedulePost = (action, command, extraHeaders = {}) => jsonRequest('/api/workbench/market', {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...collectionHeaders(), ...extraHeaders },
      body: JSON.stringify({ action, command }),
    });
    const scheduleGet = (extra = '', selected = collectionPortfolio) => jsonRequest(`/api/workbench/market?view=collection_schedules&portfolio=${selected}${extra}`, { headers: { Cookie: cookie, ...collectionHeaders() } });
    const scheduleSave = (definition, idempotency_key, selected = collectionPortfolio) => ({ portfolio_id: selected,
      expected_schedule_id: null, expected_schedule_revision: 0, definition_json: JSON.stringify(definition),
      idempotency_key, reason: 'Synthetic recurring collection HTTP fixture', acknowledgement: true });
    const scheduleStatus = (receipt, status, idempotency_key, selected = collectionPortfolio) => ({ portfolio_id: selected,
      schedule_id: receipt.schedule_id, expected_schedule_revision: receipt.schedule_revision, status, idempotency_key,
      reason: 'Synthetic explicit collection authorization', acknowledgement: true });
    const scheduledWorker = (pause = null) => {
      const script = `import json,sys
from urllib.request import Request,urlopen
from unittest.mock import patch
from worker.orchestration.db import open_database
from worker.orchestration.runtime import run_pending_once
from worker.market.collection import verify_provider_capture
from tests.market.test_collection import fake_download,utc_now
control=json.load(sys.stdin)
db=open_database(sys.argv[1])
paused=[]
def revoke():
    if control is not None:
        request=Request(control['url'],data=json.dumps(control['body']).encode(),headers=control['headers'],method='POST')
        with urlopen(request,timeout=10) as response:
            paused.append(response.status)
            assert json.load(response)['status']=='paused'
def synthetic_download(feed):
    started=utc_now()
    revoke()
    response=fake_download()(feed)
    from worker.orchestration.db import instant,stamp
    response['started_at']=stamp(started)
    if control is not None:
        ended=db.execute('SELECT updated_at FROM collection_schedule_heads WHERE schedule_id=?',
                         (control['body']['command']['schedule_id'],)).fetchone()['updated_at']
        assert started <= instant(ended) <= instant(response['completed_at'])
    return response
try:
    with patch('worker.market.collection.download_ecb_xml',side_effect=synthetic_download) as download:
        job=run_pending_once(db,'synthetic-http-schedule-worker',lease_seconds=300,clock=utc_now)
    result=None if job is None else json.loads(job['result_json'])
    slot=None if job is None else dict(db.execute('SELECT * FROM collection_schedule_slots WHERE command_request_id=?',(job['command_request_id'],)).fetchone())
    proof=verify_provider_capture(db,result['batch_id']) if job is not None and job['status']=='succeeded' else None
    print(json.dumps({'status':None if job is None else job['status'],'download_calls':download.call_count,'slot':slot,'result':result,'proof':proof,'pause_statuses':paused}))
finally: db.close()
`;
      const worker = spawnSync(process.env.WORKBENCH_TEST_PYTHON || process.env.WORKBENCH_PYTHON || 'python3', ['-c', script, filename], {
        cwd: root, env: { PATH: process.env.PATH, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: '1', TZ: 'UTC',
          WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: path.join(directory, 'auth'), WORKBENCH_MODE: 'ledger' },
        input: JSON.stringify(pause), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      });
      assert.equal(worker.status, 0, worker.stderr || worker.stdout || String(worker.error));
      return JSON.parse(worker.stdout);
    };
    const scheduledWebProof = batchId => {
      const script = `import Database from 'better-sqlite3';
import {verifiedMarketSource} from './src/server/market-source.ts';
const db=new Database(process.argv[1],{readonly:true});
try {console.log(JSON.stringify(verifiedMarketSource(db,process.argv[2],new Date().toISOString())));}finally{db.close();}`;
      const result = spawnSync(path.join(web, 'node_modules/.bin/tsx'), ['-e', script, filename, batchId], { cwd: web, encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 0, result.stderr || String(result.error)); return JSON.parse(result.stdout);
    };
    await check('HTTP-SC01', 'private recurring schedules have no defaults and saving never enables or collects data', async () => {
      assert.equal((await request('/workbench/market/schedules')).headers.get('location'), '/login');
      const page = await request('/workbench/market/schedules', { headers: { Cookie: cookie } }); assert.equal(page.status, 200);
      const empty = await scheduleGet(); assert.equal(empty.status, 200); assert.deepEqual(empty.json.schedules, []); assert.deepEqual(empty.json.slots, []);
      scheduleDue = new Date(Math.ceil((Date.now() + 15000) / 60000) * 60000);
      scheduleDefinition = { schema_version: 'collection-schedule-v1', provider: 'ecb', feed: 'daily', currencies: ['EUR'],
        frequency: 'daily', timezone: 'UTC', start_date: scheduleDue.toISOString().slice(0, 10), end_date: null,
        trigger: { hour: scheduleDue.getUTCHours(), minute: scheduleDue.getUTCMinutes() }, deadline_seconds: 120,
        max_attempts: 2, publish: true, missed_policy: 'record_no_backfill' };
      const financial = rotationSnapshot();
      for (const currency of ['EUR', 'CNY']) {
        const command = scheduleSave({ ...scheduleDefinition, currencies: [currency] }, `synthetic-http-schedule:${currency}`);
        const saved = await schedulePost('save_collection_schedule', command); assert.equal(saved.status, 200, JSON.stringify(saved.json));
        assert.equal(saved.json.status, 'paused'); assert.equal(saved.json.schedule_revision, 1); assert.equal(saved.json.version, 1);
        assert.equal(saved.json.content_hash, sha(command.definition_json));
        assert.deepEqual((await schedulePost('save_collection_schedule', command)).json, saved.json);
        scheduleReceipts.push(saved.json);
      }
      const idle = scheduledWorker(); assert.equal(idle.status, null); assert.equal(idle.download_calls, 0);
      const savedState = await scheduleGet(); assert.equal(savedState.status, 200); assert.equal(savedState.json.schedules.length, 2);
      assert(savedState.json.schedules.every(row => row.status === 'paused')); assert.deepEqual(savedState.json.slots, []);
      assert.equal(rotationSnapshot(), financial);
      return { schedules: 2, initial_status: 'paused', slots: 0, provider_requests: 0, financial_tables_unchanged: true };
    });
    await check('HTTP-SC02', 'recurring controls reject unauthenticated, forged, stale and read-only writes without mutating state', async () => {
      const command = scheduleStatus(scheduleReceipts[0], 'enabled', 'synthetic-http-schedule-invalid');
      const before = inspectionStorage();
      const anonymous = await jsonRequest('/api/workbench/market', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set_collection_schedule_status', command }) });
      assert.equal(anonymous.status, 401);
      assert.equal((await schedulePost('set_collection_schedule_status', command, { Origin: 'https://synthetic-wrong-origin.invalid' })).status, 403);
      assert.equal((await schedulePost('set_collection_schedule_status', command, { 'X-Workbench-Session-Binding': '0'.repeat(64) })).status, 401);
      assert.equal((await schedulePost('set_collection_schedule_status', { ...command, actor_id: 'forged' })).status, 400);
      assert.equal((await schedulePost('set_collection_schedule_status', { ...command, expected_schedule_revision: 0 })).status, 400, 'Status controls require a positive CAS.');
      assert.equal((await schedulePost('set_collection_schedule_status', { ...command, expected_schedule_revision: 2 })).status, 409, 'A valid but mismatched CAS must conflict.');
      assert.equal((await schedulePost('set_collection_schedule_status', { ...command, portfolio_id: otherPortfolio })).status, 403);
      assert.equal((await scheduleGet('&view=collection_schedules')).status, 400);
      assert.equal((await scheduleGet('&limit=51')).status, 400);
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic recurring collection recovery fixture\n');
      try {
        assert.equal((await scheduleGet()).json.read_only, true);
        assert.equal((await schedulePost('set_collection_schedule_status', command)).status, 423);
      } finally { rmSync(marker); }
      assert.deepEqual(inspectionStorage(), before);
      for (let i = 0; i < scheduleReceipts.length; i++) {
        const enabled = await schedulePost('set_collection_schedule_status', scheduleStatus(scheduleReceipts[i], 'enabled', `synthetic-http-schedule-enable:${i}`));
        assert.equal(enabled.status, 200, JSON.stringify(enabled.json)); assert.equal(enabled.json.status, 'enabled'); scheduleReceipts[i] = enabled.json;
      }
      assert(Date.now() < scheduleDue.getTime(), 'Fixture setup must finish before its real authorized trigger.');
      const sharedScope = await schedulePost('save_collection_schedule', scheduleSave(scheduleDefinition, 'synthetic-http-schedule-other-scope', otherPortfolio));
      assert.equal(sharedScope.status, 200);
      const conflict = await schedulePost('set_collection_schedule_status', scheduleStatus(sharedScope.json, 'enabled', 'synthetic-http-schedule-scope-conflict', otherPortfolio));
      assert.equal(conflict.status, 409); assert.equal(conflict.json.error, 'COLLECTION_SCOPE_CONFLICT');
      assert.deepEqual((await scheduleGet()).json.slots, []);
      return { initial_rejections_zero_write: true, explicit_enable_required: true, cross_portfolio_same_scope_conflict: 409, actual_trigger: scheduleDue.toISOString() };
    });
    await check('HTTP-SC03', 'a real authorized UTC trigger publishes one synthetic capture while an in-flight HTTP pause blocks the other scope atomically', async () => {
      const financial = rotationSnapshot();
      await new Promise(resolve => setTimeout(resolve, Math.max(0, scheduleDue.getTime() - Date.now() + 50)));
      scheduledWinner = scheduledWorker(); assert.equal(scheduledWinner.status, 'succeeded'); assert.equal(scheduledWinner.download_calls, 1);
      assert.equal(scheduledWinner.slot.disposition, 'requested'); assert.equal(scheduledWinner.slot.authorization_revision, 2);
      assert.equal(scheduledWinner.result.live_advice_eligible, false);
      const listed = await scheduleGet(); assert.equal(listed.status, 200, JSON.stringify(listed.json)); assert.equal(listed.json.slots.length, 2);
      const pending = listed.json.slots.find(row => row.job.status === 'queued'); assert.ok(pending);
      const receipt = scheduleReceipts.find(row => row.schedule_id === pending.schedule_id); assert.ok(receipt);
      scheduledLoser = scheduledWorker({ url: address + '/api/workbench/market',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...collectionHeaders() },
        body: { action: 'set_collection_schedule_status', command: scheduleStatus(receipt, 'paused', 'synthetic-http-schedule-inflight-pause') } });
      assert.equal(scheduledLoser.status, 'skipped'); assert.equal(scheduledLoser.download_calls, 1); assert.deepEqual(scheduledLoser.pause_statuses, [200]);
      assert.equal(scheduledLoser.slot.id, pending.id); assert.equal(scheduledLoser.result.code, 'COLLECTION_AUTHORIZATION_ENDED');
      const current = await scheduleGet(); assert.equal(current.status, 200, JSON.stringify(current.json));
      const success = current.json.slots.find(row => row.id === scheduledWinner.slot.id), stopped = current.json.slots.find(row => row.id === pending.id);
      assert.equal(success.job.status, 'succeeded'); assert.equal(success.capture.rate_date, '2025-06-06');
      assert.notEqual(success.capture.received_at.slice(0, 10), success.capture.rate_date);
      assert.equal(stopped.job.status, 'skipped'); assert.equal(stopped.capture, null);
      assert.equal(scheduledWebProof(success.capture.batch_id).capture_id, success.capture.id);
      const db = new Database(filename, { readonly: true });
      try {
        assert.equal(db.prepare('SELECT COUNT(*) n FROM market_provider_captures WHERE command_request_id=?').get(pending.command_request_id).n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM market_publications WHERE scope=?').get(pending.scope_key).n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM collection_schedule_slots WHERE scope_key=? AND period=?').get(success.scope_key, success.period).n, 1);
      } finally { db.close(); }
      assert.equal(rotationSnapshot(), financial);
      return { actual_time_trigger: true, synthetic_provider_downloads: 2, atomic_publications: 1, inflight_pause_status: 'skipped',
        old_rate_date_preserved: true, source_verified_independently: true, financial_tables_unchanged: true };
    });
    await check('HTTP-SC04', 'pause and resume never replay a completed daily slot and historical capture proof remains valid', async () => {
      const winner = scheduleReceipts.find(row => row.schedule_id === scheduledWinner.slot.schedule_id);
      const paused = await schedulePost('set_collection_schedule_status', scheduleStatus(winner, 'paused', 'synthetic-http-schedule-history-pause'));
      assert.equal(paused.status, 200);
      const resumed = await schedulePost('set_collection_schedule_status', scheduleStatus(paused.json, 'enabled', 'synthetic-http-schedule-history-resume'));
      assert.equal(resumed.status, 200);
      const before = collectionMarketState(), idle = scheduledWorker(); assert.equal(idle.status, null); assert.equal(idle.download_calls, 0);
      assert.deepEqual(collectionMarketState(), before);
      const detail = await jsonRequest(`/api/workbench/market?view=collection_slot&portfolio=${collectionPortfolio}&id=${scheduledWinner.slot.id}`, { headers: { Cookie: cookie, ...collectionHeaders() } });
      assert.equal(detail.status, 200, JSON.stringify(detail.json)); assert.equal(detail.json.attempts.length, 1); assert.equal(detail.json.slot.job.status, 'succeeded');
      assert.equal(scheduledWebProof(scheduledWinner.result.batch_id).capture_id, scheduledWinner.proof.id);
      const denied = await jsonRequest(`/api/workbench/market?view=collection_slot&portfolio=${otherPortfolio}&id=${scheduledWinner.slot.id}`, { headers: { Cookie: cookie, ...collectionHeaders() } });
      assert.equal(denied.status, 403);
      assert.doesNotMatch(JSON.stringify(detail.json), /raw_body|normalized_json|<\?xml|gesmes:Envelope/);
      return { daily_slot_replayed: false, provider_requests: 0, historical_capture_still_verified: true, cross_portfolio_detail: 403 };
    });
    await check('HTTP-MC02', 'collection HTTP rejects caller transport, reserved manual origin, unauthorized sessions, stale ledger versions and recovery writes without durable side effects', async () => {
      const before = inspectionStorage();
      const base = collectionCommand({ ...collectionPayload, expected_publication_revision: 1 }, 'http-collection-invalid');
      const anonymous = await jsonRequest('/api/workbench', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(base) });
      assert.equal(anonymous.status, 401);
      const noOrigin = await jsonRequest('/api/workbench', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(base) });
      assert.equal(noOrigin.status, 403);
      assert.equal((await post(base, { ...collectionHeaders(), Origin: 'https://synthetic-wrong-origin.invalid' })).status, 403);
      assert.equal((await post(base, { 'X-Workbench-Session-Binding': '0'.repeat(64) })).status, 401);
      assert.equal((await post({ ...base, command: { ...base.command, expected_revision: 1 } }, collectionHeaders())).status, 409);
      const forbidden = [{ url: 'https://synthetic-provider.invalid/feed' }, { token: 'SYNTHETIC-NOT-A-CREDENTIAL' },
        { received_at: '2025-06-06T12:00:00Z' }, { source_mode: 'provider_observed' }, { raw: '<synthetic-not-a-response/>' },
        { headers: {} }, { provider_capture_id: 'synthetic-forged-capture' }, { scope: 'synthetic-forged-scope' }];
      for (const [index, fields] of forbidden.entries()) {
        const invalid = await post(collectionCommand({ ...collectionPayload, ...fields }, `http-collection-forbidden:${index}`), collectionHeaders());
        assert.equal(invalid.status, 400, JSON.stringify(invalid.json)); assert.equal(invalid.json.error, 'INVALID_MARKET_COLLECT');
      }
      const observation = { id: 'http-synthetic-manual-fx', batch_id: 'http-synthetic-manual-batch', source_id: 'synthetic-manual',
        series_key: 'FX:USD', metric: 'fx_cny_per_unit', value: '1', unit: 'CNY_per_unit_currency', observed_at: '2025-01-01',
        ingested_at: '2025-01-02T00:00:00Z', source_timezone: 'UTC', time_precision: 'date', price_basis: 'not_applicable',
        revision_id: 'synthetic-1', raw_hash: 'a'.repeat(64), parser_version: 'synthetic', provenance: 'live_observed' };
      const document = { schema_version: 'market-batch-v1', batch: { id: observation.batch_id, source_id: observation.source_id,
        batch_type: 'fx', scope: 'synthetic-manual-fx', expected_pages: 1, expected_rows: 1, expected_publication_revision: 0,
        source_mode: 'manual_verified', source_evidence: 'Synthetic HTTP rejection fixture only' }, pages: [{ page_number: 1, observations: [observation] }] };
      for (const field of ['source_id', 'scope']) {
        const attempt = structuredClone(document); attempt.batch[field] = 'provider:ecb:reference-fx';
        if (field === 'source_id') attempt.pages[0].observations[0].source_id = attempt.batch.source_id;
        const invalid = await post(collectionCommand({ document: attempt, publish: true }, `http-manual-reserved:${field}`, { command_type: 'market_ingest' }), collectionHeaders());
        assert.equal(invalid.status, 400, JSON.stringify(invalid.json)); assert.equal(invalid.json.error, 'RESERVED_MARKET_SOURCE');
      }
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic collection recovery fixture\n');
      try {
        assert.equal((await state(collectionPortfolio)).read_only, true);
        assert.equal((await post(base, collectionHeaders())).status, 423);
      } finally { rmSync(marker); }
      assert.deepEqual(inspectionStorage(), before);
      return { authentication: 401, csrf: 403, session_binding: 401, stale_revision: 409, forbidden_transport_and_origin: 400,
        restore_mutation: 423, database_and_attachment_state_unchanged: true, worker_or_provider_network_started: false };
    });
    await check('HTTP-MC03', 'a real queued collection failure records a safe failed attempt while keeping the previous publication and all financial facts unchanged', async () => {
      const marketBefore = collectionMarketState(), financialBefore = rotationSnapshot();
      const body = collectionCommand({ ...collectionPayload, expected_publication_revision: 1 }, 'http-collection-transport-failure');
      const queued = await post(body, collectionHeaders()); assert.equal(queued.status, 200, JSON.stringify(queued.json));
      const failed = collectionWorker(queued.json.request_id, true); assert.equal(failed.error, 'PROVIDER_COLLECTION_FAILED');
      const db = new Database(filename, { readonly: true });
      try {
        const job = db.prepare('SELECT * FROM job_runs WHERE command_request_id=?').get(queued.json.request_id);
        assert.equal(job.status, 'retry_queued'); assert.equal(job.attempt_count, 1);
        const attempt = db.prepare('SELECT * FROM job_attempts WHERE job_id=?').get(job.id);
        assert.equal(attempt.status, 'failed');
        assert.deepEqual(JSON.parse(attempt.error_json), { code: 'WorkbenchError', message: 'PROVIDER_COLLECTION_FAILED' });
        assert.equal(db.prepare('SELECT COUNT(*) n FROM market_provider_captures WHERE command_request_id=?').get(queued.json.request_id).n, 0);
        assert.equal(db.prepare('SELECT batch_id FROM market_publications WHERE scope=?').get('provider:ecb:fx:daily:HKD-USD').batch_id, collectionResult.batch_id);
      } finally { db.close(); }
      const current = await state(collectionPortfolio);
      assert.equal(current.tasks.find(row => row.id === queued.json.request_id).status, 'retry_queued');
      assert.doesNotMatch(JSON.stringify(current), /synthetic-transport-detail-not-for-api|<\?xml|gesmes:Envelope|"raw_body"/);
      assert.deepEqual(collectionMarketState(), marketBefore); assert.equal(rotationSnapshot(), financialBefore);
      return { job_status: 'retry_queued', attempt_status: 'failed', error: 'PROVIDER_COLLECTION_FAILED', previous_head_unchanged: true,
        capture_created: false, financial_tables_unchanged: true, actual_provider_requests: 0 };
    });
    let pricePortfolio, priceSource, priceVersions, pricePayload, priceResult;
    const priceDocuments = ['http-listing', 'http-price-listing'].map((listing_id, i) => ({ kind: 'mapping', facts: {
      provider: 'longport', listing_id, provider_symbol: `00000${i + 1}.SH`, market: 'CN', exchange: 'SSE', currency: 'CNY', valid_from: '2025-01-01', valid_to: null,
    } }));
    priceDocuments.push({ kind: 'calendar', facts: { market: 'CN', exchange: 'SSE', timezone: 'Asia/Shanghai', range_start: '2025-06-05', range_end: '2025-06-08',
      days: [{ date: '2025-06-05', kind: 'full', close_at: '2025-06-05T07:00:00.000000Z' }, { date: '2025-06-06', kind: 'half', close_at: '2025-06-06T07:00:00.000000Z' },
        { date: '2025-06-07', kind: 'closed', close_at: null }, { date: '2025-06-08', kind: 'closed', close_at: null }] } });
    const priceRaw = JSON.stringify({ fixture: 'Synthetic review input; not exchange or provider evidence', documents: priceDocuments }, null, 2) + '\n';
    const marketPost = (body, extraHeaders = {}) => jsonRequest('/api/workbench/market', { method: 'POST', headers: {
      Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...collectionHeaders(), ...extraHeaders,
    }, body: JSON.stringify(body) });
    const marketGet = (query = `portfolio=${pricePortfolio}`) => jsonRequest(`/api/workbench/market?${query}`, { headers: { Cookie: cookie, ...collectionHeaders() } });
    const reviewCommand = (document, version = 0) => ({ action: 'publish_reference', command: { portfolio_id: pricePortfolio,
      idempotency_key: `http-price-review:${++sourceSequence}`, expected_version: version, source_id: priceSource.id, source_hash: priceSource.content_hash,
      review_reason: 'Synthetic human review only; no exchange verification', acknowledgement: true, document } });
    const priceCommand = (payload, key) => collectionCommand(payload, key, { portfolio_id: pricePortfolio, command_type: 'market_collect_prices' });
    const priceWorker = (requestId, fail = false) => {
      const script = `import json,sys
from unittest.mock import patch
from worker.orchestration.db import WorkbenchError,open_database
from worker.orchestration.runtime import run_pending_once
from worker.market.collection import verify_provider_capture
from tests.market.test_price_collection import fake_collect
db=open_database(sys.argv[1]); calls=[]
def transport(**kwargs):
    calls.append(kwargs['mapping']['listing_id'])
    if len(calls)==2 and sys.argv[3]=='fail':
        raise RuntimeError('synthetic-sdk-detail-not-for-api')
    return fake_collect(**kwargs)
try:
    with patch('worker.market.providers.longport.collect_longport_candles',transport):
        try:
            job=run_pending_once(db,'synthetic-http-price-worker',role='longport',lease_seconds=300)
        except WorkbenchError as error:
            print(json.dumps({'error':str(error),'calls':calls})); sys.exit(2)
    assert job['command_request_id']==sys.argv[2]
    result=json.loads(job['result_json'])
    print(json.dumps({'status':job['status'],'result':result,'proof':verify_provider_capture(db,result['batch_id']),'calls':calls}))
finally: db.close()
`;
      const worker = spawnSync(rotationPython, ['-c', script, filename, requestId, fail ? 'fail' : 'success'], { cwd: root, env: rotationEnv, encoding: 'utf8', timeout: 30000 });
      assert.equal(worker.status, fail ? 2 : 0, worker.stderr || worker.stdout || String(worker.error));
      const result = JSON.parse(worker.stdout); assert.deepEqual(result.calls, ['http-listing', 'http-price-listing']); return result;
    };
    const priceWebProof = (knownAt = new Date().toISOString()) => {
      const script = `import Database from 'better-sqlite3';
import {verifiedMarketSource} from './src/server/market-source.ts';
import {verifiedPriceCalendarSession} from './src/server/market-price-source.ts';
const db=new Database(process.argv[1],{readonly:true});
try { console.log(JSON.stringify({source:verifiedMarketSource(db,process.argv[2],process.argv[4]),
session:verifiedPriceCalendarSession(db,process.argv[2],process.argv[3],'http-listing','2025-06-07T06:00:00Z',process.argv[4])})); }
catch(error) { console.log(JSON.stringify({error:error.message})); } finally {db.close();}`;
      const checked = spawnSync(path.join(web, 'node_modules/.bin/tsx'), ['-e', script, filename, priceResult.batch_id, pricePortfolio, knownAt], { cwd: web, encoding: 'utf8', timeout: 30000 });
      assert.equal(checked.status, 0, checked.stderr || String(checked.error)); return JSON.parse(checked.stdout);
    };
    await check('HTTP-MP01', 'scoped human source storage preserves exact bytes and audited reference versions without creating financial facts', async () => {
      const created = await post({ action: 'create_portfolio', name: 'Synthetic price HTTP fixture' }); assert.equal(created.status, 200); pricePortfolio = created.json.id;
      const db = new Database(filename);
      try { db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('http-price-listing','http-instrument','CN','SSE','SYNTH03','CNY',?)").run(new Date().toISOString()); } finally { db.close(); }
      for (const [i, listing_id] of ['http-listing', 'http-price-listing'].entries()) {
        const added = await catalogPost('add_entry', { portfolio_id: pricePortfolio, expected_catalog_revision: i, idempotency_key: `http-price-entry:${i}`, listing_id });
        assert.equal(added.status, 200, JSON.stringify(added.json));
      }
      const before = rotationSnapshot();
      const stored = await marketPost({ action: 'store_source', command: { portfolio_id: pricePortfolio, idempotency_key: 'http-price-source', reference: 'Synthetic review fixture', content_text: priceRaw } });
      assert.equal(stored.status, 200, JSON.stringify(stored.json)); priceSource = stored.json;
      assert.equal(priceSource.verification_status, 'unreviewed'); assert.equal(priceSource.content_hash, sha(priceRaw));
      const download = await request(`/api/workbench/market?portfolio=${pricePortfolio}&view=source&id=${priceSource.id}`, { headers: { Cookie: cookie, ...collectionHeaders() } });
      assert.equal(download.status, 200); assert.equal(await download.text(), priceRaw);
      assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.match(download.headers.get('content-type'), /^application\/json/);
      assert.match(download.headers.get('content-security-policy'), /sandbox/); assert.match(download.headers.get('content-security-policy'), /default-src 'none'/);
      assert.match(download.headers.get('cache-control'), /private.*no-store/); assert.match(download.headers.get('vary'), /Cookie/i);
      priceVersions = [];
      for (const document of priceDocuments) {
        const reviewed = await marketPost(reviewCommand(document)); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
        assert.equal(reviewed.json.version, 1); assert.equal(reviewed.json.verification_status, 'human_reviewed_not_provider_verified'); priceVersions.push(reviewed.json);
        const detail = await marketGet(`portfolio=${pricePortfolio}&view=version&id=${reviewed.json.id}`); assert.equal(detail.status, 200);
        assert.equal(detail.json.version.created_by, 'owner'); assert.match(detail.json.version.known_at, /\.\d{6}Z$/);
      }
      const summary = await marketGet(); assert.equal(summary.status, 200); assert.equal(summary.json.heads.length, 3);
      const page = await request('/workbench/market', { headers: { Cookie: cookie } }); assert.equal(page.status, 200); assert.match(await page.text(), /市场资料与价格采集/);
      assert.equal(summary.json.sources.length, 1); assert.doesNotMatch(JSON.stringify(summary.json), /content_text|"days"|raw_body|longport-candles-projection/);
      const foreign = await marketGet(`portfolio=${otherPortfolio}`); assert.equal(foreign.status, 200); assert.equal(foreign.json.sources.length, 0); assert.equal(foreign.json.versions.length, 0);
      assert.equal((await marketGet(`portfolio=${otherPortfolio}&view=source&id=${priceSource.id}`)).status, 403);
      assert.equal((await marketGet(`portfolio=${otherPortfolio}&view=version&id=${priceVersions[0].id}`)).status, 403);
      assert.equal(rotationSnapshot(), before);
      pricePayload = { schema_version: 'market-price-collect-v1', provider: 'longport', mapping_version_ids: priceVersions.slice(0, 2).map(row => row.id), calendar_version_ids: [priceVersions[2].id],
        start_date: '2025-06-05', end_date: '2025-06-06', expected_publication_revision: 0, publish: true };
      return { exact_source_sha256: priceSource.content_hash, reviewed_versions: 3, human_review_only: true, cross_portfolio_source: 403, financial_tables_unchanged: true, inert_download: true };
    });
    await check('HTTP-MP02', 'market endpoints reject unauthenticated, forged, duplicate-query and recovery writes before changing state', async () => {
      const before = inspectionStorage(), body = reviewCommand(priceDocuments[0], 1);
      assert.equal((await jsonRequest('/api/workbench/market')).status, 401);
      assert.equal((await jsonRequest('/api/workbench/market', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
      assert.equal((await marketPost(body, { Origin: 'https://synthetic-wrong-origin.invalid' })).status, 403);
      assert.equal((await marketPost(body, { 'X-Workbench-Session-Binding': '0'.repeat(64) })).status, 401);
      assert.equal((await marketGet(`portfolio=${pricePortfolio}&portfolio=${pricePortfolio}`)).status, 400);
      assert.equal((await marketGet(`portfolio=${pricePortfolio}&unexpected=1`)).status, 400);
      for (const fields of [{ verified: true }, { created_by: 'worker' }, { known_at: '2025-01-01T00:00:00.000000Z' }, { audit_id: 'synthetic-forged' }]) {
        const rejected = await marketPost({ ...body, command: { ...body.command, ...fields } }); assert.equal(rejected.status, 400, JSON.stringify(rejected.json));
      }
      for (const fields of [{ url: 'https://synthetic-provider.invalid/' }, { token: 'SYNTHETIC-NOT-A-CREDENTIAL' }, { raw_body: '{}' }, { collector_runtime: 'isolated_official_sdk' }]) {
        const rejected = await post(priceCommand({ ...pricePayload, ...fields }, `http-price-forged:${++sourceSequence}`), collectionHeaders());
        assert.equal(rejected.status, 400, JSON.stringify(rejected.json)); assert.equal(rejected.json.error, 'INVALID_MARKET_PRICE_COLLECT');
      }
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic reviewed-reference recovery fixture\n');
      try {
        assert.equal((await marketGet()).json.read_only, true); assert.equal((await marketPost(body)).status, 423);
        assert.equal((await post(priceCommand(pricePayload, 'http-price-recovery'), collectionHeaders())).status, 423);
      } finally { rmSync(marker); }
      assert.deepEqual(inspectionStorage(), before);
      return { authentication: 401, origin: 403, binding: 401, invalid_metadata: 400, recovery: 423, database_unchanged: true, network_requests: 0 };
    });
    await check('HTTP-MP03', 'two reviewed ETF mappings reach one atomic SDK capture through the dedicated Python role and independent Web verification', async () => {
      const before = rotationSnapshot(), body = priceCommand(pricePayload, 'http-price-success');
      const queued = await post(body, collectionHeaders()); assert.equal(queued.status, 200, JSON.stringify(queued.json));
      const duplicate = await post(body, collectionHeaders()); assert.equal(duplicate.status, 200); assert.deepEqual(duplicate.json, queued.json);
      const worker = priceWorker(queued.json.request_id); assert.equal(worker.status, 'succeeded'); priceResult = worker.result;
      assert.equal(priceResult.live_advice_eligible, false); assert.equal(worker.proof.capture_kind, 'sdk_projection');
      const db = new Database(filename, { readonly: true });
      try {
        const captures = db.prepare('SELECT * FROM market_sdk_captures WHERE command_request_id=?').all(queued.json.request_id); assert.equal(captures.length, 1);
        assert.equal(sha(captures[0].raw_body), worker.proof.raw_sha256);
        const rows = db.prepare('SELECT * FROM market_observations WHERE batch_id=?').all(priceResult.batch_id); assert.equal(rows.length, 4);
        for (const row of rows) { assert.equal(row.time_precision, 'date'); assert.equal(row.published_at, null); assert.equal(row.value, '10.100000000000000001'); }
      } finally { db.close(); }
      const proof = priceWebProof(); assert.equal(proof.source.portfolio_id, pricePortfolio); assert.equal(proof.session, '2025-06-06');
      const current = await state(pricePortfolio); assert.equal(current.tasks.find(row => row.id === queued.json.request_id).status, 'succeeded');
      assert.doesNotMatch(JSON.stringify(current), /raw_body|projection_bytes|candlesticks|synthetic-sdk-detail/); assert.equal(rotationSnapshot(), before);
      return { sdk_calls_in_test_transport: 2, atomic_captures: 1, observations: 4, date_precision_preserved: true, independently_verified_session: proof.session,
        financial_tables_unchanged: true, provider_requests: 0, live_advice_eligible: false };
    });
    await check('HTTP-MP04', 'second ETF failure leaves the old publication and capture intact with a safe retryable error', async () => {
      const before = collectionMarketState(), financial = rotationSnapshot();
      const queued = await post(priceCommand({ ...pricePayload, expected_publication_revision: 1 }, 'http-price-second-failure'), collectionHeaders()); assert.equal(queued.status, 200, JSON.stringify(queued.json));
      assert.equal(priceWorker(queued.json.request_id, true).error, 'PRICE_PROVIDER_COLLECTION_FAILED');
      const db = new Database(filename, { readonly: true });
      try {
        const job = db.prepare('SELECT * FROM job_runs WHERE command_request_id=?').get(queued.json.request_id); assert.equal(job.status, 'retry_queued');
        const attempt = db.prepare('SELECT * FROM job_attempts WHERE job_id=?').get(job.id); assert.equal(attempt.status, 'failed');
        assert.deepEqual(JSON.parse(attempt.error_json), { code: 'WorkbenchError', message: 'PRICE_PROVIDER_COLLECTION_FAILED' });
        assert.equal(db.prepare('SELECT COUNT(*) n FROM market_sdk_captures WHERE command_request_id=?').get(queued.json.request_id).n, 0);
      } finally { db.close(); }
      assert.deepEqual(collectionMarketState(), before); assert.equal(rotationSnapshot(), financial);
      assert.doesNotMatch(JSON.stringify(await state(pricePortfolio)), /synthetic-sdk-detail-not-for-api|raw_body|candlesticks/);
      return { partial_capture_created: false, previous_market_state_unchanged: true, safe_error: 'PRICE_PROVIDER_COLLECTION_FAILED', financial_tables_unchanged: true };
    });
    await check('HTTP-MP05', 'reference revisions invalidate current SDK use while preserving independently verified as-known evidence', async () => {
      const known = new Date().toISOString(), before = rotationSnapshot(); assert.equal(priceWebProof(known).session, '2025-06-06');
      const changed = await marketPost(reviewCommand(priceDocuments[2], 1)); assert.equal(changed.status, 200, JSON.stringify(changed.json)); assert.equal(changed.json.version, 2);
      assert.equal(priceWebProof(known).session, '2025-06-06'); assert.equal(priceWebProof().error, 'MARKET_PROVIDER_EVIDENCE_INVALID');
      const stale = await post(priceCommand({ ...pricePayload, expected_publication_revision: 1 }, 'http-price-stale-reference'), collectionHeaders()); assert.equal(stale.status, 409);
      assert.equal(rotationSnapshot(), before);
      return { current_old_reference_rejected: true, as_known_snapshot_preserved: true, stale_queue: 409, financial_tables_unchanged: true };
    });
    let identityPortfolio, identityListing, identityCommand, identityReceipt;
    const identityPath = '/api/workbench/listing-reviews';
    const identityGet = (query = `portfolio=${identityPortfolio}&listing=${identityListing}`) => jsonRequest(`${identityPath}?${query}`, { headers: { Cookie: cookie, ...collectionHeaders() } });
    const identityPost = (command, extraHeaders = {}) => jsonRequest(identityPath, { method: 'POST', headers: {
      Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...collectionHeaders(), ...extraHeaders,
    }, body: JSON.stringify({ action: 'publish', command }) });
    const identityStorage = () => {
      const db = new Database(filename, { readonly: true });
      try { return sha(JSON.stringify(['listing_review_versions', 'listing_review_heads', 'market_reference_sources', 'audit_events', 'command_dedup', 'instruments', 'listings']
        .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))); } finally { db.close(); }
    };
    const identityFacts = { instrument_kind: 'ETF', lifecycle_status: 'active', quantity_step: '100', price_step: '0.001',
      source_effective_date: null, fund_identifier: null, share_class_identifier: null,
      product_structure: { leverage: 'unleveraged', direction: 'long_only' },
      risk_classification: { index_id: 'SYNTHETIC-INDEX', region: 'SYNTHETIC-REGION', sector: 'SYNTHETIC-BROAD' } };
    await check('HTTP-LR01', 'normal listing registration and private source review produce a scoped immutable identity without changing ledger or global approval flags', async () => {
      const created = await post({ action: 'create_portfolio', name: 'Synthetic identity review HTTP scope' }); assert.equal(created.status, 200); identityPortfolio = created.json.id;
      const registered = await post({ action: 'register_listing', command: { portfolio_id: identityPortfolio, expected_revision: 0, idempotency_key: 'http-identity-register',
        name: 'Synthetic identity ETF', market: 'CN', exchange: 'SSE', ticker: 'SYNTH-ID19', currency: 'CNY', asset_class: 'unknown', source_evidence: 'Synthetic initial registration, not issuer verification' } });
      assert.equal(registered.status, 200, JSON.stringify(registered.json)); assert.equal(registered.json.status, 'unverified'); identityListing = registered.json.listing_id;
      const added = await catalogPost('add_entry', { portfolio_id: identityPortfolio, listing_id: identityListing, expected_catalog_revision: 0, idempotency_key: 'http-identity-member' });
      assert.equal(added.status, 200, JSON.stringify(added.json));
      const empty = await identityGet(); assert.equal(empty.status, 200, JSON.stringify(empty.json)); assert.equal(empty.json.selected.review_revision, 0);
      assert.deepEqual(empty.json.selected.issues, ['LISTING_REVIEW_MISSING']);
      const raw = JSON.stringify({ synthetic: true, fixture: 'Not an issuer or exchange original', facts: identityFacts }, null, 2) + '\n';
      const source = await marketPost({ action: 'store_source', command: { portfolio_id: identityPortfolio, idempotency_key: 'http-identity-source',
        reference: 'Synthetic identity source, not live approval', content_text: raw } });
      assert.equal(source.status, 200, JSON.stringify(source.json)); assert.equal(source.json.content_hash, sha(raw));
      identityCommand = { portfolio_id: identityPortfolio, listing_id: identityListing, expected_review_revision: 0,
        expected_identity_hash: empty.json.selected.identity_hash, source_id: source.json.id, source_hash: source.json.content_hash,
        facts: identityFacts, review_until: new Date(Date.now() + 3600000).toISOString().replace(/(\.\d{3})Z$/, '$1000Z'),
        reason: 'Synthetic human review only, no account or strategy approval', acknowledgement: true, idempotency_key: 'http-identity-review' };
      const financial = rotationSnapshot(), db = new Database(filename, { readonly: true });
      let globals;
      try { globals = db.prepare('SELECT * FROM listings WHERE id=?').get(identityListing); } finally { db.close(); }
      const reviewed = await identityPost(identityCommand); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json)); identityReceipt = reviewed.json;
      assert.equal(identityReceipt.revision, 1); assert.equal(identityReceipt.review_basis, 'human_reviewed_not_provider_verified');
      const current = await identityGet(); assert.equal(current.status, 200); assert.equal(current.json.selected.quality, 'complete');
      assert.equal(current.json.selected.current.document.id, identityReceipt.id); assert.equal(current.json.selected.current.document.created_by, 'owner');
      assert.equal(current.json.selected.current.content_hash, identityReceipt.content_hash); assert.match(identityReceipt.known_at, /\.\d{6}Z$/);
      assert.equal(current.json.sources.find(row => row.id === source.json.id).content_hash, sha(raw)); assert.doesNotMatch(JSON.stringify(current.json), /content_text|"raw_body"/);
      assert.match(current.headers.get('cache-control'), /private.*no-store/); assert.match(current.headers.get('vary'), /Cookie/i);
      const after = new Database(filename, { readonly: true });
      try { assert.deepEqual(after.prepare('SELECT * FROM listings WHERE id=?').get(identityListing), globals); } finally { after.close(); }
      assert.equal(rotationSnapshot(), financial); assert.equal((await state(identityPortfolio)).revision, 0);
      const page = await request('/workbench/market/listings', { headers: { Cookie: cookie } }); assert.equal(page.status, 200); assert.match(await page.text(), /证券身份/);
      return { normal_registration: true, private_review_revision: 1, source_sha256: source.json.content_hash, global_approval_unchanged: true, ledger_revision: 0, human_review_not_provider_verification: true };
    });
    await check('HTTP-LR02', 'identity review requires current auth, same session, exact identity, explicit CAS and private original scope', async () => {
      const before = identityStorage(), financial = rotationSnapshot();
      assert.equal((await jsonRequest(identityPath)).status, 401);
      assert.equal((await jsonRequest(identityPath, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
      assert.equal((await identityPost(identityCommand, { Origin: 'https://synthetic-invalid-origin.invalid' })).status, 403);
      assert.equal((await identityPost(identityCommand, { 'X-Workbench-Session-Binding': '0'.repeat(64) })).status, 401);
      assert.equal((await identityGet(`portfolio=${identityPortfolio}&portfolio=${identityPortfolio}`)).status, 400);
      const retried = await identityPost(identityCommand); assert.equal(retried.status, 200); assert.deepEqual(retried.json, identityReceipt);
      assert.equal((await identityPost({ ...identityCommand, expected_review_revision: 1 })).status, 409);
      assert.equal((await identityPost({ ...identityCommand, idempotency_key: 'http-identity-stale-cas' })).status, 409);
      const next = { ...identityCommand, expected_review_revision: 1, idempotency_key: 'http-identity-invalid-next' };
      assert.equal((await identityPost({ ...next, expected_identity_hash: '0'.repeat(64) })).status, 409);
      assert.equal((await identityPost({ ...next, source_id: priceSource.id, source_hash: priceSource.content_hash })).status, 403);
      for (const extra of [{ known_at: identityReceipt.known_at }, { created_by: 'system:claimed-human' }, { review_basis: 'provider_verified' }]) {
        assert.equal((await identityPost({ ...next, ...extra })).status, 400);
      }
      assert.equal((await identityGet(`portfolio=${otherPortfolio}&listing=${identityListing}`)).status, 403);
      assert.equal(identityStorage(), before); assert.equal(rotationSnapshot(), financial);
      return { auth: 401, origin: 403, stale_session: 401, stale_cas: 409, identity_change: 409, private_source: 403, exact_retry: true, no_mutation: true };
    });
    await check('HTTP-LR03', 'a sourced suspension supersedes an old active review and recovery prevents writes while preserving readable private history', async () => {
      const financial = rotationSnapshot(), facts = { ...identityFacts, lifecycle_status: 'suspended' };
      const stored = await marketPost({ action: 'store_source', command: { portfolio_id: identityPortfolio, idempotency_key: 'http-identity-suspended-source',
        reference: 'Synthetic suspended listing notice', content_text: JSON.stringify({ synthetic: true, facts }) } }); assert.equal(stored.status, 200);
      const next = { ...identityCommand, expected_review_revision: 1, source_id: stored.json.id, source_hash: stored.json.content_hash, facts, idempotency_key: 'http-identity-suspended' };
      const updated = await identityPost(next); assert.equal(updated.status, 200, JSON.stringify(updated.json)); assert.equal(updated.json.revision, 2);
      const detail = await identityGet(); assert.equal(detail.status, 200); assert.equal(detail.json.selected.quality, 'blocked'); assert.deepEqual(detail.json.selected.issues, ['LISTING_REVIEW_NOT_ACTIVE']);
      assert.equal(detail.json.history.length, 2); assert.equal(detail.json.history.find(row => row.document.revision === 1).document.id, identityReceipt.id);
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'), before = identityStorage();
      writeFileSync(marker, 'Synthetic identity recovery test\n');
      try {
        const read = await identityGet(); assert.equal(read.status, 200); assert.equal(read.json.read_only, true);
        assert.equal((await identityPost({ ...next, expected_review_revision: 2, idempotency_key: 'http-identity-readonly' })).status, 423);
      } finally { rmSync(marker); }
      assert.equal(identityStorage(), before); assert.equal(rotationSnapshot(), financial);
      return { revision: 2, blocked_issue: 'LISTING_REVIEW_NOT_ACTIVE', historical_versions_preserved: 2, recovery_write: 423, financial_tables_unchanged: true };
    });
    await check('HTTP-16', 'storage errors do not expose paths or SQL', async () => {
      renameSync(filename, `${filename}.held`);
      try {
        const response = await jsonRequest('/api/workbench', { headers: { Cookie: cookie } });
        assert.equal(response.status, 503); assert.deepEqual(response.json, { error: 'WORKBENCH_UNAVAILABLE' });
      } finally { renameSync(`${filename}.held`, filename); }
    });
    await check('HTTP-17', 'logout revokes API access and final ledger remains internally consistent', async () => {
      const result = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } }); assert.equal(result.status, 303);
      assert.equal((await jsonRequest('/api/workbench', { headers: { Cookie: cookie } })).status, 401);
      assert.equal((await catalogGet()).status, 401);
      assert.equal((await marketGet()).status, 401);
      assert.equal((await identityGet()).status, 401);
      const deniedCatalog = await jsonRequest('/api/workbench/catalog', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: 'x'.repeat(2 * 1024 * 1024 + 1) }); assert.equal(deniedCatalog.status, 401);
      const db = new Database(filename, { readonly: true });
      try {
        assert.equal(db.pragma('quick_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_events WHERE portfolio_id=?').get(portfolio).n, revision);
        assert.deepEqual(db.prepare('SELECT DISTINCT actor_id FROM ledger_events').all(), [{ actor_id: 'owner' }]);
        return { ledger_events: revision, ledger_revision: revision, cash_cny: '790231', foreign_key_errors: 0, quick_check: 'ok', legacy_database_created: false };
      } finally { db.close(); }
    });
  } finally {
    if (server && server.exitCode === null) await new Promise(resolve => { server.once('exit', resolve); server.kill('SIGTERM'); });
    const sanitizedLogs = logs.replaceAll(directory, '[temporary-fixture]').replaceAll(password, '[redacted]');
    writeFileSync(path.join(output, 'server.log'), sanitizedLogs);
    rmSync(directory, { recursive: true, force: true });
  }
}

try { await main(); report.status = 'PASS'; }
catch (error) { report.status = 'FAIL'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; console.error(report.error); }
finally {
  report.completed_at = new Date().toISOString();
  report.source_end_sha256 = Object.fromEntries(inventory().map(relative => [relative, sha(readFileSync(path.join(root, relative)))]));
  report.source_changed_during_run = [...new Set([...Object.keys(report.source_sha256), ...Object.keys(report.source_end_sha256)])].filter(relative => report.source_sha256[relative] !== report.source_end_sha256[relative]);
  if (report.status === 'PASS' && report.source_changed_during_run.length) {
    report.status = 'STALE';
    report.error = 'Source changed during this run; rerun on a stable worktree before using it as release evidence.';
    process.exitCode = 1;
  }
  report.summary = { passed: report.cases.filter(item => item.status === 'PASS').length, failed: report.cases.filter(item => item.status === 'FAIL').length };
  writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(output, 'report.md'), `# Workbench HTTP integration\n\nStatus: **${report.status}**\n\nStarted: ${report.started_at}\n\nBuild: \`${report.build_id ?? 'not completed'}\`\n\n| Case | Status | Description |\n| --- | --- | --- |\n${report.cases.map(item => `| ${item.id} | ${item.status} | ${item.description} |`).join('\n')}\n\n${report.error ? `Failure: ${report.error}\n\n` : ''}## Boundaries\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n\nAll account facts and credentials were synthetic. Temporary databases were removed.\n`);
  process.stdout.write(`Evidence: ${path.relative(root, output)}\n`);
}
