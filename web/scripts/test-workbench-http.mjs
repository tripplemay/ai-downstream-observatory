import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateWorkbench } from '../../scripts/migrate-workbench.mjs';

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
    const response = await request(url, init);
    const text = await response.text();
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
      db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('http-instrument','Synthetic ETF','2026-01-01')").run();
      db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('http-listing','http-instrument','CN','SSE','TEST01','CNY','2026-01-01')").run();
      db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('http-listing-2','http-instrument','US','SYNTHETIC','TEST02','USD','2026-01-01')").run();
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
      async function* oversized() { for (let i = 0; i < 85; i++) yield Buffer.alloc(65536, 32); }
      const result = await jsonRequest('/api/workbench', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: oversized(), duplex: 'half' });
      assert.equal(result.status, 413); assert.equal(result.json.error, 'REQUEST_TOO_LARGE');
      return { declared_content_length: false, limit_bytes: 5242880 };
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
    let opening;
    await check('HTTP-06', 'actual opening and contribution produce exact decimal cash', async () => {
      opening = command({ type: 'opening_cash', amount: '1000000' });
      const result = await post({ action: 'record_fact', command: opening }); assert.equal(result.status, 200); revision = result.json.revision;
      await record({ type: 'deposit', amount: '500000' });
      const current = await state(); assert.equal(current.revision, 2); assert.equal(cash(current), '1500000');
      return { revision, cash_cny: cash(current) };
    });
    await check('HTTP-07', 'idempotency replay is stable and conflicting payload is rejected', async () => {
      const replay = await post({ action: 'record_fact', command: opening }); assert.equal(replay.status, 200); assert.equal(replay.json.duplicate, true);
      const conflict = await post({ action: 'record_fact', command: { ...opening, fact: { ...opening.fact, amount: '1' } } });
      assert.equal(conflict.status, 409); assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '1500000');
    });
    await check('HTTP-08', 'stale revisions, forged account scope and numeric money fail atomically', async () => {
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'deposit', amount: '1' }, { expected_revision: 0 }) })).status, 409);
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'deposit', account_id: foreignAccount, amount: '1' }) })).status, 403);
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'deposit', amount: 100 }) })).status, 400);
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'transfer_out', target_account_id: foreignAccount, amount: '1' }) })).status, 403);
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'deposit', amount: '1' }, { effective_at: '2099-01-01' }) })).status, 400);
      assert.equal((await post({ action: 'record_fact', command: command({ type: 'buy', listing_id: 'http-listing', quantity: '100', price: '-1', consideration: '100', fee: '0' }) })).status, 400);
      assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '1500000');
    });
    let goodPreview, rawImport;
    await check('HTTP-09', 'import preview validates without publishing any facts', async () => {
      rawImport = JSON.stringify([importRow('100'), importRow('50')]);
      goodPreview = await preview(rawImport); assert.equal(goodPreview.status, 'preview'); assert.equal(goodPreview.rows.length, 2);
      assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '1500000');
      const read = await jsonRequest(`/api/workbench?portfolio=${portfolio}&batch=${goodPreview.id}`, { headers: { Cookie: cookie } });
      assert.equal(read.status, 200); assert.equal(read.json.preview_hash, goodPreview.preview_hash);
      assert.equal((await jsonRequest(`/api/workbench?portfolio=${otherPortfolio}&batch=${goodPreview.id}`, { headers: { Cookie: cookie } })).status, 404);
    });
    await check('HTTP-10', 'import hash check, atomic confirmation and duplicate confirmation', async () => {
      assert.equal((await confirm(goodPreview, { preview_hash: 'tampered' })).status, 409);
      const confirmed = await confirm(goodPreview); assert.equal(confirmed.status, 200); revision = confirmed.json.revision;
      assert.equal(revision, 4); assert.equal(cash(await state()), '1500150');
      const replay = await confirm(goodPreview); assert.equal(replay.status, 200); assert.equal(replay.json.duplicate, true);
      const repeatedPreview = await preview(rawImport); assert.equal(repeatedPreview.id, goodPreview.id); assert.equal(repeatedPreview.duplicate, true);
      assert.equal((await state()).revision, revision);
    });
    await check('HTTP-11', 'an invalid row quarantines the entire import', async () => {
      const invalid = await preview(JSON.stringify([importRow('100'), importRow('-50')]));
      assert.equal(invalid.status, 'invalid'); assert.ok(invalid.rows[1].errors.length);
      assert.equal((await confirm(invalid)).status, 400); assert.equal((await state()).revision, revision);
      assert.equal(cash(await state()), '1500150');
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
      assert.equal(cash(await state()), '1500240');
    });
    await check('HTTP-13', 'buy recognition and separate settlement cannot double-count cash', async () => {
      const buy = await record({ type: 'buy', listing_id: 'http-listing', quantity: '1000', price: '10', fee: '10' });
      const before = await state();
      assert.equal(cash(before), '1500240'); assert.equal(before.positions[0].quantity, '1000');
      assert.equal(before.balances.find(row => row.ledger_account === 'trade_payable').balance, '-10010');
      await record({ type: 'settlement', direction: 'buy', related_event_id: buy.event_id, amount: '10010' });
      assert.equal(cash(await state()), '1490230');
      const excess = await post({ action: 'record_fact', command: command({ type: 'settlement', direction: 'buy', related_event_id: buy.event_id, amount: '1' }) });
      assert.equal(excess.status, 400); assert.equal((await state()).revision, revision);
    });
    await check('HTTP-14', 'two concurrent stale-state commands cannot both commit', async () => {
      const first = command({ type: 'deposit', amount: '1' });
      const second = command({ type: 'deposit', amount: '1' });
      const results = await Promise.all([post({ action: 'record_fact', command: first }), post({ action: 'record_fact', command: second })]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
      revision += 1; assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '1490231');
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
        balances: ['cash_settled', 'trade_receivable', 'trade_payable', 'dividend_receivable', 'transfer_in_transit', 'other_liability', 'cash_hold'].map(ledger_account => ({ currency: 'CNY', ledger_account, balance: ledger_account === 'cash_settled' ? '1490231' : '0' })),
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
      assert.equal(cash(await state()), '1490231');
      return { research_trial_id: trial.trial_id, real_ledger_unchanged: true, live_advice_eligible: false };
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
      async function* chunks() { for (let i = 0; i < 85; i++) yield Buffer.alloc(65536, 65); }
      const streamed = await jsonRequest('/api/workbench/csv', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': multipart }, body: chunks(), duplex: 'half' });
      assert.equal(streamed.status, 413); assert.equal(streamed.json.error, 'REQUEST_TOO_LARGE'); assert.equal(streamed.headers.get('connection'), 'close');
      const largeFile = await csvUpload(csvForm(Buffer.alloc(4 * 1024 * 1024 + 1, 65), { expected_revision: 2 }));
      assert.equal(largeFile.status, 413); assert.equal(largeFile.json.error, 'CSV_TOO_LARGE');
      const largeMapping = await csvUpload(csvForm(csvBytes, { expected_revision: 2, mapping: 'x'.repeat(256 * 1024 + 1) }));
      assert.equal(largeMapping.status, 413); assert.equal(largeMapping.json.error, 'CSV_MAPPING_TOO_LARGE');
      assert.equal((await state(csvPortfolio)).revision, 2);
      return { transport_limit_bytes: 5242880, file_limit_bytes: 4194304, mapping_limit_bytes: 262144, anonymous_oversized_status: 401, wrong_origin_oversized_status: 403 };
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
      assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '1490231');
      return { stale_upload_status: 409, stale_confirmation_status: 409, refreshed_preview_without_booking: true, isolated_ledger_revision: 3 };
    });
    await check('HTTP-CSV08', 'recovery lock preserves CSV downloads but blocks upload and confirmation without touching prior scenarios', async () => {
      const marker = path.join(directory, 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'Synthetic CSV recovery fixture\n');
      try {
        assert.equal((await state(csvPortfolio)).read_only, true);
        const upload = await csvUpload(csvForm(csvBytes, { expected_revision: 3 })); assert.equal(upload.status, 423); assert.equal(upload.json.error, 'WORKBENCH_READ_ONLY');
        const confirmation = await post(csvConfirmation(csvPending)); assert.equal(confirmation.status, 423); assert.equal(confirmation.json.error, 'WORKBENCH_READ_ONLY');
        const download = await request(`/api/workbench/attachments/${csvPreview.attachment_id}?portfolio=${csvPortfolio}`, { headers: { Cookie: cookie } });
        assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), csvBytes);
      } finally { rmSync(marker); }
      assert.equal((await state(csvPortfolio)).revision, 3); assert.equal(csvCash(await state(csvPortfolio)), '149.123456789012345678');
      assert.equal((await state()).revision, revision); assert.equal(cash(await state()), '1490231');
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
      assert.equal((await state(dividendPortfolio)).revision, dividendRevision); assert.equal(cash(await state()), '1490231');
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
      assert.equal((await catalogGet()).json.catalog_revision, catalogRevision); assert.equal((await state(catalogPortfolio)).revision, 0); assert.equal(cash(await state()), '1490231');
      return { read_only_mutation_status: 423, prior_ledger_unchanged: true };
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
      const deniedCatalog = await jsonRequest('/api/workbench/catalog', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: 'x'.repeat(2 * 1024 * 1024 + 1) }); assert.equal(deniedCatalog.status, 401);
      const db = new Database(filename, { readonly: true });
      try {
        assert.equal(db.pragma('quick_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_events WHERE portfolio_id=?').get(portfolio).n, revision);
        assert.deepEqual(db.prepare('SELECT DISTINCT actor_id FROM ledger_events').all(), [{ actor_id: 'owner' }]);
        return { ledger_events: revision, ledger_revision: revision, cash_cny: '1490231', foreign_key_errors: 0, quick_check: 'ok', legacy_database_created: false };
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
