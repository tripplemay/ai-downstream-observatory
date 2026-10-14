import assert from 'node:assert/strict';
import { runHttpFixture } from './http-fixture-process.mjs';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const endpoint = '/api/workbench/investor';
const profile = { schema_version: 'investor-profile-v1', horizon_years: 12, loss_tolerance: null,
  liquidity_need: 'none_in_horizon', markets: ['CN', 'HK', 'US'], product_scope: 'unleveraged_long_only_etfs',
  research_direction: 'system_design', exclusions: [], illustrative_budget_cny: '250000', planned_annual_contribution_cny: null };

export async function investorHttpCases({ check, request, jsonRequest, filename, directory, origin, password, Database, diagnosticsDirectory = null }) {
  let cookie, binding, first;
  const headers = extra => ({ Cookie: cookie, 'X-Workbench-Session-Binding': binding, ...extra });
  const get = () => jsonRequest(endpoint, { headers: headers() });
  const post = (value, extra = {}) => jsonRequest(endpoint, { method: 'POST', headers: headers({ Origin: origin, 'Content-Type': 'application/json', ...extra }), body: JSON.stringify(value) });
  const read = operation => { const db = new Database(filename, { readonly: true }); try { return operation(db); } finally { db.close(); } };
  const financial = () => read(db => Object.fromEntries(['portfolios', 'accounts', 'ledger_heads', 'ledger_events', 'postings', 'position_movements', 'approval_events', 'activations', 'reservations', 'execution_reports'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const login = async () => {
    const response = await request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });
    assert.equal(response.status, 303); cookie = response.headers.get('set-cookie').split(';')[0];
    const session = await jsonRequest('/api/auth/session', { headers: { Cookie: cookie } }); assert.equal(session.status, 200); binding = session.json.session_binding;
  };
  const initialFinancial = financial();
  await check('HTTP-I01', 'investor authentication precedes body reads; GET creates no workspace or financial facts', async () => {
    assert.equal((await jsonRequest(endpoint)).status, 401);
    assert.equal((await jsonRequest(endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' })).status, 401);
    for (const route of ['/workbench/plan', '/workbench/observations', '/workbench/accounts', '/workbench/ledger'])
      assert.equal((await request(route)).headers.get('location'), '/login');
    await login();
    const state = await get(); assert.equal(state.status, 200); assert.equal(state.json.workspace_id, null);
    assert.equal(state.json.effective_outcome, 'not_started'); assert.equal(state.json.session_binding, binding);
    assert.equal(state.headers.get('cache-control'), 'private, no-store'); assert.ok(state.headers.get('vary').split(/,\s*/).includes('Cookie'));
    assert.equal(read(db => db.prepare('SELECT count(*) n FROM investor_workspaces').get().n), 0);
    assert.deepEqual(financial(), initialFinancial);
    assert.equal((await jsonRequest(`${endpoint}/accounts`)).status, 401);
    const accounts = await jsonRequest(`${endpoint}/accounts`, { headers: headers() });
    assert.equal(accounts.status, 200); assert.equal(accounts.json.workspace_id, null); assert.equal(accounts.json.link, null);
    assert.deepEqual(accounts.json.books, []); assert.deepEqual(accounts.json.accounts, []);
    assert.equal(accounts.headers.get('cache-control'), 'private, no-store');
    assert.equal((await jsonRequest(`${endpoint}/holdings`)).status, 401);
    assert.equal((await jsonRequest(`${endpoint}/funded-comparison?actor_id=forged`)).status, 401);
    assert.equal((await jsonRequest(`${endpoint}/funded-analysis?actor_id=forged`)).status, 401);
    const comparison = await jsonRequest(`${endpoint}/funded-comparison`, { headers: headers() });
    assert.equal(comparison.status, 200); assert.equal(comparison.json.status, 'not_started'); assert.deepEqual(comparison.json.candidates, []);
    assert.equal(comparison.headers.get('cache-control'), 'private, no-store');
    assert.equal((await jsonRequest(`${endpoint}/reconciliation?account=missing`)).status, 401);
    const holdings = await jsonRequest(`${endpoint}/holdings`, { headers: headers() });
    assert.equal(holdings.status, 200); assert.equal(holdings.json.status, 'not_linked'); assert.equal(holdings.json.snapshot, null);
    assert.equal(holdings.headers.get('cache-control'), 'private, no-store');
    assert.equal(read(db => db.prepare('SELECT count(*) n FROM investor_workspaces').get().n), 0);
    assert.deepEqual(financial(), initialFinancial);
    return { implicit_workspace: false, financial_writes: false, current_session_bound: true };
  });
  await check('HTTP-I02', 'strict input rejects forged actors, stale sessions, wrong origins, duplicate keys and oversized bodies', async () => {
    const command = { action: 'save_profile', expected_revision: 0, idempotency_key: 'investor-http-save', profile };
    assert.equal((await post(command, { Origin: 'https://wrong.example.test' })).status, 403);
    assert.equal((await post(command, { 'X-Workbench-Session-Binding': 'b'.repeat(64) })).status, 401);
    assert.equal((await post(command, { 'Content-Type': 'text/plain' })).status, 415);
    for (const extra of [{ actor_id: 'other' }, { result: {} }, { execution_authorized: true }]) assert.equal((await post({ ...command, ...extra })).status, 400);
    for (const body of ['{"action":"evaluate","action":"save_plan"}', Buffer.from([0x7b, 0xff, 0x7d])]) {
      const response = await jsonRequest(endpoint, { method: 'POST', headers: headers({ Origin: origin, 'Content-Type': 'application/json' }), body });
      assert.equal(response.status, 400); assert.equal(response.json.error, 'INVALID_JSON');
    }
    assert.equal((await post({ ...command, idempotency_key: 'large', padding: 'x'.repeat(33000) })).status, 413);
    const chunked = await jsonRequest(endpoint, { method: 'POST', headers: headers({ Origin: origin, 'Content-Type': 'application/json' }), duplex: 'half',
      body: (async function* () { yield Buffer.from('{"padding":"'); yield Buffer.alloc(33000, 120); yield Buffer.from('"}'); })() });
    assert.equal(chunked.status, 413);
    for (const query of ['portfolio=forged', 'actor_id=other', 'x=1&x=2'])
      assert.equal((await jsonRequest(`${endpoint}?${query}`, { headers: headers() })).status, 400);
    assert.equal((await jsonRequest(`${endpoint}/accounts?portfolio_id=forged`, { headers: headers() })).status, 400);
    assert.equal((await jsonRequest(`${endpoint}/accounts`, { headers: headers({ 'X-Workbench-Session-Binding': 'b'.repeat(64) }) })).status, 401);
    assert.equal((await jsonRequest(`${endpoint}/holdings?portfolio_id=forged`, { headers: headers() })).status, 400);
    assert.equal((await jsonRequest(`${endpoint}/holdings`, { headers: headers({ 'X-Workbench-Session-Binding': 'b'.repeat(64) }) })).status, 401);
    assert.equal((await jsonRequest(`${endpoint}/funded-comparison?actor_id=forged`, { headers: headers() })).status, 400);
    assert.equal((await jsonRequest(`${endpoint}/funded-comparison`, { headers: headers({ 'X-Workbench-Session-Binding': 'b'.repeat(64) }) })).status, 401);
    for (const query of ['', 'candidate=invalid&path=immediate', `candidate=${'a'.repeat(64)}&path=other`,
      `candidate=${'a'.repeat(64)}&path=immediate&path=staged`, `candidate=${'a'.repeat(64)}&path=immediate&actor_id=other`])
      assert.equal((await jsonRequest(`${endpoint}/funded-analysis?${query}`, { headers: headers() })).status, 400);
    assert.equal((await jsonRequest(`${endpoint}/funded-analysis`, { headers: headers({ 'X-Workbench-Session-Binding': 'b'.repeat(64) }) })).status, 401);
    for (const query of ['', '?account=missing&account=another', '?account=missing&actor_id=other'])
      assert.equal((await jsonRequest(`${endpoint}/reconciliation${query}`, { headers: headers() })).status, 400);
    assert.equal((await jsonRequest(`${endpoint}/reconciliation?account=missing`, { headers: headers({ 'X-Workbench-Session-Binding': 'b'.repeat(64) }) })).status, 401);
    assert.equal(read(db => db.prepare('SELECT count(*) n FROM investor_workspaces').get().n), 0);
    assert.deepEqual(financial(), initialFinancial);
    return { maximum_body_bytes: 32768, duplicate_json_rejected: true, auth_scope_not_client_supplied: true };
  });
  await check('HTTP-I20', 'AI explanation endpoint has current-session and strict small-body boundaries; reads never generate AI or financial facts', async () => {
    const route = `${endpoint}/ai-explanation`, body = { observation_id: 'fictional-observation', binding_hash: 'a'.repeat(64) };
    const facts = financial(), count = () => read(db => db.prepare('SELECT count(*) n FROM audit_events').get().n), before = count();
    assert.equal((await jsonRequest(route)).status, 401);
    assert.equal((await jsonRequest(route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' })).status, 401);
    assert.equal((await jsonRequest(route, { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await jsonRequest(route, { headers: headers({ 'X-Workbench-Session-Binding': 'b'.repeat(64) }) })).status, 401);
    assert.equal((await jsonRequest(`${route}?actor_id=other`, { headers: headers() })).status, 400);
    const result = await jsonRequest(route, { headers: headers() });
    assert.equal(result.status, 200); assert.equal(result.json.status, 'blocked'); assert.equal(result.json.review, null);
    assert.equal(result.json.narrative_verified, false); assert.equal(result.json.live_advice_eligible, false); assert.equal(result.json.session_binding, binding);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    const send = (value, extra = {}) => jsonRequest(route, { method: 'POST', headers: headers({ Origin: origin, 'Content-Type': 'application/json', ...extra }), body: typeof value === 'string' ? value : JSON.stringify(value) });
    assert.equal((await send(body, { Origin: 'https://wrong.example.test' })).status, 403);
    assert.equal((await send(body, { 'X-Workbench-Session-Binding': 'b'.repeat(64) })).status, 401);
    assert.equal((await send(body, { 'Content-Type': 'text/plain' })).status, 415);
    for (const extra of [{ actor_id: 'other' }, { context: {} }, { execution_authorized: true }, { gateway_url: 'https://forged.invalid' }]) assert.equal((await send({ ...body, ...extra })).status, 400);
    assert.equal((await send('{"observation_id":"a","observation_id":"b"}')).status, 400);
    assert.equal((await send({ ...body, padding: 'x'.repeat(1025) })).status, 413);
    const chunked = await jsonRequest(route, { method: 'POST', headers: headers({ Origin: origin, 'Content-Type': 'application/json' }), duplex: 'half',
      body: (async function* () { yield Buffer.from('{"padding":"'); yield Buffer.alloc(1025, 120); yield Buffer.from('"}'); })() });
    assert.equal(chunked.status, 413); assert.equal(count(), before); assert.deepEqual(financial(), facts);
    return { auth_before_body: true, no_free_text_or_caller_context: true, maximum_body_bytes: 1024, get_never_calls_ai: true, financial_writes: false };
  });
  await check('HTTP-I03', 'four-constraint save is idempotent and keeps unknown risk, no account or JSON-result prerequisite', async () => {
    const command = { action: 'save_profile', expected_revision: 0, idempotency_key: 'investor-http-save', profile };
    first = await post(command); assert.equal(first.status, 200); assert.equal(first.json.action, 'save_profile'); assert.equal(first.json.revision, 1);
    assert.deepEqual((await post(command)).json, first.json);
    assert.equal((await post({ ...command, profile: { ...profile, horizon_years: 8 } })).status, 409);
    assert.equal((await post({ ...command, idempotency_key: 'stale' })).status, 409);
    const state = await get(); assert.equal(state.json.profile.document.loss_tolerance, null); assert.equal(state.json.effective_outcome, 'insufficient_evidence');
    assert.equal(state.json.plan, null); assert.equal(state.json.latest.document.monitoring, 'not_enabled');
    assert.equal(state.json.research_task.status, 'queued');
    assert.ok(state.json.effective_gaps.some(g => g.code === 'REFERENCE_DATASET_NOT_READY'));
    assert.ok(state.json.effective_gaps.some(g => g.code === 'RISK_BUDGET_UNCONFIRMED'));
    assert.equal(read(db => db.prepare('SELECT count(*) n FROM investor_profiles').get().n), 1);
    assert.deepEqual(financial(), initialFinancial);
    for (const route of ['/workbench', '/workbench/plan', '/workbench/observations', '/workbench/accounts', '/workbench/ledger'])
      assert.equal((await request(route, { headers: headers() })).status, 200);
    return { revision: 1, profile_versions: 1, risk_unknown_retained: true, financial_tables_unchanged: true };
  });
  await check('HTTP-I04', 'reevaluation preserves immutable history; blocked observations cannot be accepted as trade ideas', async () => {
    const state = await get(), observation = state.json.latest.id;
    assert.equal((await post({ action: 'review', expected_revision: 1, idempotency_key: 'not-decision', observation_id: observation, decision: 'accept_idea', note: '' })).status, 400);
    assert.equal((await post({ action: 'save_plan', expected_revision: 1, idempotency_key: 'unknown-plan', plan_id: 'missing' })).status, 403);
    assert.equal((await post({ action: 'evaluate', expected_revision: 1, idempotency_key: 'investor-http-eval' })).status, 200);
    const refreshed = await get(); assert.equal(refreshed.json.revision, 2); assert.equal(refreshed.json.observations.length, 2); assert.equal(refreshed.json.profile_history.length, 1);
    assert.equal(refreshed.json.decisions.length, 0); assert.deepEqual(financial(), initialFinancial);
    return { independent_observations: 2, profile_versions: 1, implied_trades: 0 };
  });
  await check('HTTP-I05', 'recovery mode preserves reads but rejects new mutations and retries of an already accepted save', async () => {
    const marker = path.join(directory, 'auth', 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'SYNTHETIC INVESTOR LOCK\n');
    try {
      const state = await get(); assert.equal(state.status, 200); assert.equal(state.json.read_only, true);
      assert.equal((await post({ action: 'save_profile', expected_revision: 0, idempotency_key: 'investor-http-save', profile })).status, 423);
      assert.equal((await post({ action: 'evaluate', expected_revision: 2, idempotency_key: 'frozen' })).status, 423);
      assert.equal(state.json.revision, 2); assert.deepEqual(financial(), initialFinancial);
    } finally { rmSync(marker); }
    return { readable: true, new_write: 423, identical_retry: 423 };
  });
  await check('HTTP-I06', 'logout hides data, a new session cannot use the old binding, private research survives login', async () => {
    const oldCookie = cookie, oldBinding = binding;
    assert.equal((await request('/api/auth/logout', { method: 'POST', headers: headers({ Origin: origin }) })).status, 303);
    assert.equal((await get()).status, 401);
    await login(); assert.notEqual(binding, oldBinding);
    assert.equal((await jsonRequest(endpoint, { headers: { Cookie: oldCookie, 'X-Workbench-Session-Binding': oldBinding } })).status, 401);
    assert.equal((await jsonRequest(endpoint, { headers: headers({ 'X-Workbench-Session-Binding': oldBinding }) })).status, 401);
    const state = await get(); assert.equal(state.json.workspace_id, first.json.workspace_id); assert.equal(state.json.revision, 2);
    assert.deepEqual(financial(), initialFinancial);
    return { persistent_private_workspace: true, revoked_session: 401, mismatched_binding: 401 };
  });
  await check('HTTP-I07', 'independent core research handler commits a missing-input result and revision through authenticated HTTP', async () => {
    const before = await get(), taskId = before.json.research_task.id;
    const worker = await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3',
      ['-c', `import sys
from worker.orchestration.db import open_database
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import command_handler
from worker.investor.runtime import sync_research_requests
db=open_database(sys.argv[1])
try:
    sync_research_requests(db)
    result=run_one(db,'http-research-worker',command_handler(db),job_type='investor_research')
    assert result is not None and result['status']=='succeeded'
finally:
    db.close()
`, filename], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 60000, encoding: 'utf8', maxBuffer: 65536,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') },
      });
    assert.equal(worker.status, 0, 'Core research worker did not complete');
    const state = await get(); assert.equal(state.status, 200);
    assert.equal(state.json.research_task.id, taskId); assert.equal(state.json.research_task.status, 'blocked');
    assert.equal(state.json.research_task.study, null); assert.equal(state.json.revision, before.json.revision + 1);
    assert.equal(state.json.latest.document.input_version, state.json.research_task.input_version);
    assert.equal(state.json.effective_outcome, 'insufficient_evidence'); assert.equal(state.json.latest.document.monitoring, 'not_enabled');
    assert.equal((await post({ action: 'evaluate', expected_revision: before.json.revision, idempotency_key: 'pre-worker-stale' })).status, 409);
    assert.equal(read(db => db.prepare('SELECT count(*) n FROM investor_research_runs').get().n), 1);
    assert.deepEqual(financial(), initialFinancial);
    return { background_result_published: true, research_revision: state.json.revision, actual_financial_rows_unchanged: true, monitoring_enabled: false };
  });
  await check('HTTP-I08', 'saving a synthetic reference registers an isolated watcher; core publishes gaps and pause/resume survives authenticated reads', async () => {
    const before = await get();
    const seed = await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c', `import sys,tempfile
from pathlib import Path
from datetime import datetime,timedelta,timezone
from worker.orchestration.db import open_database,transaction,canonical_json,content_hash,new_id
p=Path(sys.argv[1]).resolve(strict=True)
assert p.parent.parent==Path(tempfile.gettempdir()).resolve() and p.parent.name.startswith('etf-workbench-http-') and p.name=='workbench.db'
db=open_database(p)
try:
    workspace,profile=sys.argv[2:4]
    row=db.execute('SELECT * FROM investor_profiles WHERE id=? AND workspace_id=?',(profile,workspace)).fetchone()
    assert row is not None
    at=datetime.now(timezone.utc); at=at.replace(microsecond=at.microsecond//1000*1000)
    stamp=lambda x:x.isoformat(timespec='milliseconds').replace('+00:00','Z')
    now,expiry=stamp(at),stamp(at+timedelta(days=1))
    plan={'schema_version':'investor-reference-plan-v1','profile_id':profile,'strategy_version':'SYNTHETIC-HTTP-ONLY','strategy_evidence':'Synthetic software fixture; not validated research','input_version':content_hash({'synthetic_http':True}),'data_cutoff':now,'created_at':now,'valid_until':expiry,'data_mode':'synthetic','targets':[{'listing_id':'synthetic-http-model','symbol':'SYNTHETIC.CN','name':'Synthetic only','market':'CN','currency':'CNY','weight':'1','role':'Test only','overlap_summary':'Test only'}],'estimated_cost':'Test only','risk_scenarios':['Test only'],'benchmark_summary':'Test only','counterarguments':['Not investment evidence'],'uncertainties':['No real data'],'live_advice_eligible':False}
    plan_id,observation_id=new_id('http-test-plan'),new_id('http-test-observation')
    obs={'schema_version':'investor-observation-v1','outcome':'observe','evaluated_at':now,'data_cutoff':now,'profile_id':profile,'profile_version':row['version'],'input_version':plan['input_version'],'gaps':[],'reasons':['Synthetic software fixture only'],'next_review_at':expiry,'next_conditions':['Synthetic fixture only'],'monitoring':'not_enabled','scope':'research_model','live_advice_eligible':False}
    with transaction(db):
        db.execute('INSERT INTO investor_reference_plans(id,workspace_id,profile_id,document_json,content_hash,created_at) VALUES(?,?,?,?,?,?)',(plan_id,workspace,profile,canonical_json(plan),content_hash(plan),now))
        db.execute('INSERT INTO investor_observations(id,workspace_id,profile_id,candidate_plan_id,outcome,document_json,content_hash,input_version,created_at) VALUES(?,?,?,?,?,?,?,?,?)',(observation_id,workspace,profile,plan_id,'observe',canonical_json(obs),content_hash(obs),obs['input_version'],now))
    print(plan_id)
finally:
    db.close()
`, filename, before.json.workspace_id, before.json.profile.id], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 30000, encoding: 'utf8', maxBuffer: 65536,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') },
    });
    assert.equal(seed.status, 0, 'Synthetic model seeder did not complete');
    const save = { action: 'save_plan', expected_revision: before.json.revision, idempotency_key: 'http-watch-save', plan_id: seed.stdout.trim() };
    const receipt = await post(save); assert.equal(receipt.status, 200); assert.deepEqual((await post(save)).json, receipt.json);
    let state = await get(); assert.equal(state.json.model_watch.status, 'awaiting_inputs'); assert.equal(state.json.model_watch.enabled, true);
    const modelId = state.json.model_watch.id;
    assert.equal((await post({ action: 'set_monitoring', expected_revision: state.json.revision, idempotency_key: 'http-forged-model', model_id: 'not-owned', enabled: false })).status, 403);
    const worker = await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c', `import sys
from worker.orchestration.db import open_database
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import command_handler
from worker.investor.model_runtime import discover_monitor_requests
db=open_database(sys.argv[1])
try:
    discover_monitor_requests(db)
    result=run_one(db,'http-model-worker',command_handler(db),job_type='investor_monitor')
    assert result is not None and result['status']=='succeeded'
finally:
    db.close()
`, filename], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 60000, encoding: 'utf8', maxBuffer: 65536,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') },
    });
    assert.equal(worker.status, 0, 'Core model worker did not complete');
    state = await get(); assert.equal(state.status, 200); assert.equal(state.json.model_watch.status, 'blocked');
    assert.equal(state.json.model_watch.model_nav_cny, null); assert.equal(state.json.model_watch.checkpoint_sequence, 0);
    assert.equal(state.json.effective_outcome, 'insufficient_evidence'); assert.equal(state.json.latest.document.monitoring, 'not_enabled');
    const pause = { action: 'set_monitoring', expected_revision: state.json.revision, idempotency_key: 'http-watch-pause', model_id: modelId, enabled: false };
    const paused = await post(pause); assert.equal(paused.status, 200); assert.deepEqual((await post(pause)).json, paused.json);
    state = await get(); assert.equal(state.json.model_watch.status, 'paused');
    assert.equal((await post({ action: 'set_monitoring', expected_revision: state.json.revision, idempotency_key: 'http-watch-resume', model_id: modelId, enabled: true })).status, 200);
    state = await get(); assert.equal(state.json.model_watch.enabled, true); assert.equal(state.json.model_watch.status, 'outdated');
    assert.deepEqual(financial(), initialFinancial);
    assert.match(await (await request('/workbench', { headers: headers() })).text(), /持续观察/);
    return { independent_model: true, persisted_controls: true, synthetic_checkpoint_published: false, financial_rows_unchanged: true };
  });
  await check('HTTP-I09', 'synthetic research registers phase intents before calculation and exposes sealed local trial evidence over authenticated HTTP', async () => {
    const invoke = async mode => {
      const worker = await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c', `import sys,tempfile
from pathlib import Path
from tests.investor.fixtures import research_input
from worker.orchestration.db import open_database
from worker.orchestration.jobs import run_one
from worker.investor.runtime import register_synthetic_input,sync_research_requests,prepare_research_job
p=Path(sys.argv[1]).resolve(strict=True)
assert p.parent.parent==Path(tempfile.gettempdir()).resolve() and p.parent.name.startswith('etf-workbench-http-') and p.name=='workbench.db'
db=open_database(p)
try:
    if sys.argv[2]=='register':
        rows=db.execute('SELECT id FROM investor_workspaces').fetchall()
        assert len(rows)==1
        register_synthetic_input(db,rows[0]['id'],*research_input())
    else:
        sync_research_requests(db)
        result=run_one(db,'http-test-trial-worker',lambda job,lease:prepare_research_job(db,job,lease,allow_synthetic=True),job_type='investor_research')
        assert result is not None and result['status']=='succeeded'
finally:
    db.close()
`, filename, mode], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 60000, encoding: 'utf8', maxBuffer: 65536,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') } });
      assert.equal(worker.status, 0, 'Synthetic trial fixture did not complete');
    };
    await invoke('register');
    let state = await get();
    assert.equal((await post({ action: 'evaluate', expected_revision: state.json.revision, idempotency_key: 'http-trials-input' })).status, 200);
    await invoke('compute'); state = await get();
    assert.equal(state.status, 200); assert.equal(state.json.research_task.status, 'calculated');
    const registry = state.json.research_task.registry;
    assert.deepEqual(registry.phases, { train: { registered: 3, completed: 3 }, validation: { registered: 0, completed: 0 }, holdout: { registered: 0, completed: 0 } });
    assert.equal(registry.freeze_hash, null); assert.equal(registry.holdout_status, 'not_independently_verified');
    assert.equal(registry.live_advice_eligible, false); assert.equal(state.json.profile.document.loss_tolerance, null);
    assert.equal(state.json.effective_outcome, 'insufficient_evidence');
    const html = await (await request('/workbench', { headers: headers() })).text();
    assert.match(html.replace(/<!--.*?-->/gs, '').replace(/<[^>]+>/g, ''), /训练 3\/3/);
    assert.deepEqual(financial(), initialFinancial);
    return { persistent_trial_count: 3, unknown_risk_no_freeze: true, independent_holdout_claimed: false, financial_rows_unchanged: true };
  });
  await check('HTTP-I10', 'fictional evidence admission reaches default core and independent HTTP replay; withdrawn sources hide weights but preferences remain editable', async () => {
    const invoke = async mode => {
      const worker = await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c', `import sys,tempfile
from pathlib import Path
from datetime import datetime,timezone
from tests.investor.evidence_fixture import create,EXPIRY
from worker.investor.data_evidence import review_source
from worker.investor.runtime import sync_research_requests
from worker.orchestration.db import open_database
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import command_handler
p=Path(sys.argv[1]).resolve(strict=True)
assert p.parent.parent==Path(tempfile.gettempdir()).resolve() and p.parent.name.startswith('etf-workbench-http-') and p.name=='workbench.db'
db=open_database(p)
try:
    rows=db.execute('SELECT id,owner_id FROM investor_workspaces').fetchall()
    assert len(rows)==1
    workspace,actor=rows[0]['id'],rows[0]['owner_id']
    at=datetime.now(timezone.utc); at=at.replace(microsecond=at.microsecond//1000*1000)
    now=at.isoformat(timespec='milliseconds').replace('+00:00','Z')
    if sys.argv[2] in ('admit','calculate'):
        if sys.argv[2]=='admit': create(db,workspace,actor,now=now)
        sync_research_requests(db)
        result=run_one(db,'http-fictional-evidence',command_handler(db),job_type='investor_research')
        assert result is not None, 'NO_JOB'
        assert result['status']=='succeeded', result['status']
    elif sys.argv[2] in ('monitor','funding'):
        from tests.investor.live_monitor_fixture import create as monitor_create
        from worker.investor.evidence_monitor_runtime import discover_evidence_monitor_requests
        model=db.execute('SELECT m.id FROM investor_models m JOIN investor_profiles p ON p.id=m.profile_id WHERE m.workspace_id=? ORDER BY p.version DESC,m.rowid DESC LIMIT 1',(workspace,)).fetchone()
        assert model is not None
        monitor_create(db,workspace,actor,model['id'],now,funding=sys.argv[2]=='funding')
        discover_evidence_monitor_requests(db,now=now)
        result=run_one(db,'http-fictional-monitor',command_handler(db),job_type='investor_evidence_monitor')
        assert result is not None, 'NO_JOB'
        assert result['status']=='succeeded', result['status']
    else:
        rights=db.execute("SELECT s.id FROM investor_data_sources s WHERE s.workspace_id=? AND s.kind='rights'",(workspace,)).fetchall()
        assert len(rights)>=1
        for right in rights:
            review_source(db,workspace,actor,right['id'],'withdrawn',None,'Fictional HTTP withdrawal',EXPIRY,now=now)
finally:
    db.close()
`, filename, mode], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 60000, encoding: 'utf8', maxBuffer: 65536,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') } });
      const diagnostic = (worker.stderr ?? '').split(/\r?\n/).map(line => line.trim())
        .filter(line => /^(?:(?:[A-Za-z0-9_]+\.)*WorkbenchError: [A-Z][A-Z0-9_]{0,119}|AssertionError: (?:NO_JOB|skipped|failed|retry_queued|cancelled))$/.test(line)).at(-1)
        ?? (worker.error?.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'NO_SAFE_DIAGNOSTIC');
      assert.equal(worker.status, 0, `Fictional evidence fixture did not complete (${mode}): ${diagnostic}`);
    };
    await invoke('admit');
    let state = await get(); assert.equal(state.status, 200); assert.equal(state.json.research_task.status, 'calculated');
    assert.equal(state.json.research_task.study.qualification, 'owner_reviewed_reconstructed');
    assert.equal(state.json.research_task.study.status, 'risk_options_ready');
    assert.deepEqual(state.json.research_task.study.phase_checks, []);
    assert.equal(state.json.research_task.study.source_context.listings.length, 2);
    assert.equal(state.json.research_task.registry.phases.train.completed, 3);
    assert.equal(state.json.research_task.registry.phases.validation.registered, 0);
    assert.equal(state.json.profile.document.loss_tolerance, null); assert.equal(state.json.live_advice_eligible, false);
    const html = await (await request('/workbench', { headers: headers() })).text(); assert.match(html, /候选已计算，等待确认风险范围/);
    assert.match(html, /当前只有训练期比较，尚未选择最终权重/);
    assert.deepEqual(financial(), initialFinancial);
    const confirmed = await post({ action: 'save_profile', expected_revision: state.json.revision, idempotency_key: 'http-fictional-confirmed-risk', profile: { ...profile, loss_tolerance: '0.30' } });
    assert.equal(confirmed.status, 200); await invoke('calculate'); state = await get(); assert.equal(state.status, 200);
    assert.equal(state.json.research_task.study.status, 'reference_ready');
    assert.deepEqual(state.json.research_task.study.phase_checks, ['train', 'validation', 'holdout'].map(phase => ({
      phase, execution_failure_count: 0, benchmark_execution_failure_count: 0,
    })));
    assert.equal(state.json.plan.document.data_mode, 'reconstructed'); assert.equal(state.json.plan.saved_for_observation, false);
    assert.equal(state.json.plan.document.reference_evidence.result_hash, state.json.research_task.study.result_hash);
    const planId = state.json.plan.id;
    const saved = await post({ action: 'save_plan', expected_revision: state.json.revision, idempotency_key: 'http-evidence-reference-save', plan_id: planId });
    assert.equal(saved.status, 200); state = await get(); assert.equal(state.status, 200);
    assert.equal(state.json.plan.saved_for_observation, true); assert.equal(state.json.model_watch.status, 'awaiting_inputs');
    assert.equal(state.json.model_watch.model_nav_cny, null); assert.equal(state.json.effective_outcome, 'insufficient_evidence');
    const savedHtml = await (await request('/workbench', { headers: headers() })).text(); assert.match(savedHtml, /已保存为观察方案/);
    await check('HTTP-I11', 'fictional receipt-qualified core monitor reaches SSR, pause/resume and human review without executing a change', async () => {
      await invoke('monitor'); state = await get(); assert.equal(state.status, 200);
      assert.equal(state.json.model_watch.status, 'research_observe'); assert.equal(state.json.effective_outcome, 'observe');
      assert.equal(state.json.model_watch.model_nav_cny, '10000'); assert.equal(state.json.model_watch.checkpoint_sequence, 1);
      assert.equal(state.json.latest.document.monitoring, 'active');
      assert.equal(state.json.latest.document.input_version, state.json.model_watch.evaluation_input_version);
      const originalCheckpoints = read(db => db.prepare('SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence').all());
      const originalUnits = read(db => db.prepare('SELECT payload FROM investor_evidence_checkpoint_payloads ORDER BY rowid').all());
      const modelId = state.json.model_watch.id;
      const paused = await post({ action: 'set_monitoring', model_id: modelId, enabled: false, expected_revision: state.json.revision, idempotency_key: 'http-qualified-pause' });
      assert.equal(paused.status, 200); state = await get(); assert.equal(state.json.model_watch.status, 'paused');
      assert.equal(state.json.effective_outcome, 'insufficient_evidence'); assert.equal(state.json.model_watch.model_nav_cny, null);
      assert.equal((await post({ action: 'set_monitoring', model_id: modelId, enabled: true, expected_revision: state.json.revision, idempotency_key: 'http-qualified-resume' })).status, 200);
      await invoke('funding'); state = await get(); assert.equal(state.status, 200);
      assert.equal(state.json.model_watch.status, 'research_decision'); assert.equal(state.json.effective_outcome, 'decision_required');
      assert.equal(state.json.model_watch.model_nav_cny, '10000'); assert.equal(state.json.model_watch.checkpoint_sequence, 1);
      assert.deepEqual(read(db => db.prepare('SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence').all()), originalCheckpoints);
      assert.deepEqual(read(db => db.prepare('SELECT payload FROM investor_evidence_checkpoint_payloads ORDER BY rowid').all()), originalUnits);
      assert.equal(state.json.latest.document.model_change.funding_status, 'hypothetical_due');
      assert.equal(state.json.latest.document.model_change.allocation_method, 'contribution_repair_without_sales');
      const changes = await (await request('/workbench', { headers: headers() })).text();
      assert.match(changes, /历史重建参考模型估值/); assert.match(changes, /变化卡/);
      const unitState = read(db => db.prepare('SELECT payload FROM investor_evidence_checkpoint_payloads ORDER BY rowid').all());
      const review = await post({ action: 'review', observation_id: state.json.latest.id, decision: 'accept_idea', note: 'Fictional HTTP review, not execution', expected_revision: state.json.revision, idempotency_key: 'http-qualified-review' });
      assert.equal(review.status, 200); state = await get(); assert.equal(state.json.decisions[0].decision, 'accept_idea');
      assert.deepEqual(read(db => db.prepare('SELECT payload FROM investor_evidence_checkpoint_payloads ORDER BY rowid').all()), unitState);
      assert.deepEqual(financial(), initialFinancial);
      return { stub_transport_only: true, real_provider_called: false, independent_model_and_cost_replay: true, unchanged_state_reused: true, review_changes_holdings: false };
    });
    await invoke('withdraw'); state = await get(); assert.equal(state.status, 200);
    assert.equal(state.json.research_task.status, 'outdated'); assert.equal(state.json.research_task.study, null);
    assert.equal(state.json.research_task.registry, null); assert.ok(state.json.effective_gaps.some(g => g.code === 'REFERENCE_SOURCE_NO_LONGER_CURRENT'));
    assert.equal(state.json.plan, null); assert.equal(state.json.model_watch.status, 'outdated');
    const refused = await post({ action: 'save_plan', expected_revision: state.json.revision, idempotency_key: 'http-no-withdrawn-save', plan_id: planId });
    assert.equal(refused.status, 409); assert.equal(refused.json.error, 'INVESTOR_PLAN_SOURCE_UNAVAILABLE');
    const changed = await post({ action: 'save_profile', expected_revision: state.json.revision, idempotency_key: 'http-withdrawn-edit', profile: { ...profile, horizon_years: 13 } });
    assert.equal(changed.status, 200); state = await get(); assert.equal(state.status, 200);
    assert.equal(state.json.profile.document.horizon_years, 13); assert.equal(state.json.research_task.study, null);
    assert.deepEqual(financial(), initialFinancial);
    return { fictional_documents_and_stub_transport_only: true, real_provider_called: false, default_core_reconstructed: true,
      reference_plan_independently_replayed: true, model_saved_without_quotes_or_nav: true,
      withdrawn_weights_hidden: true, withdrawn_plan_save_rejected: true, preferences_remain_editable: true, independent_holdout_claimed: false, financial_rows_unchanged: true };
  });
  await check('HTTP-I15', 'frozen low-frequency plans retain legacy guards and publish new stateful decisions without financial writes', async () => {
    const before = financial();
    const jobCounts = [];
    const invoke = async (admit, legacy = true) => {
      const worker = await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c', `import sys,tempfile,json
from pathlib import Path
from datetime import datetime,timezone
from tests.investor.evidence_fixture import create
from worker.investor.runtime import sync_research_requests
from worker.orchestration.db import open_database
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import command_handler
from worker.investor.reference_plan import render_reference_plan
from unittest.mock import patch
from contextlib import nullcontext
p=Path(sys.argv[1]).resolve(strict=True)
assert p.parent.parent==Path(tempfile.gettempdir()).resolve() and p.parent.name.startswith('etf-workbench-http-') and p.name=='workbench.db'
db=open_database(p)
try:
    rows=db.execute('SELECT id,owner_id FROM investor_workspaces').fetchall(); assert len(rows)==1
    if sys.argv[2]=='admit':
        now=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        create(db,rows[0]['id'],rows[0]['owner_id'],now=now,fixed_policy_v2=True)
    sync_research_requests(db)
    counts={'succeeded':0,'skipped':0}
    with patch('worker.investor.reference_plan.render_reference_plan',side_effect=lambda *a,**k:render_reference_plan(*a,version='investor-reference-plan-v1')) if sys.argv[3]=='legacy' else nullcontext():
        for _ in range(10):
            result=run_one(db,'http-fixed-policy',command_handler(db),job_type='investor_research')
            if result is None: break
            assert result['status'] in ('succeeded','skipped'), result['status']
            counts[result['status']]+=1
    print(json.dumps(counts))
finally: db.close()
`, filename, admit ? 'admit' : 'compute', legacy ? 'legacy' : 'current'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 60000, encoding: 'utf8', maxBuffer: 65536,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') } });
      const diagnostic = (worker.stderr ?? '').split(/\r?\n/).map(line => line.trim())
        .filter(line => /^(?:(?:[A-Za-z0-9_]+\.)*WorkbenchError: [A-Z][A-Z0-9_]{0,119}|AssertionError(?:: (?:skipped|failed|retry_queued|cancelled))?)$/.test(line)).at(-1) ?? 'NO_SAFE_DIAGNOSTIC';
      assert.equal(worker.status, 0, `Fictional fixed-policy fixture did not complete: ${diagnostic}`);
      const counts = JSON.parse(worker.stdout);
      assert.deepEqual(Object.keys(counts).sort(), ['skipped', 'succeeded']);
      assert.ok(Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0));
      jobCounts.push(counts);
    };
    await invoke(true); let state = await get(); assert.equal(state.status, 200);
    assert.equal(state.json.profile.document.loss_tolerance, null);
    assert.equal(state.json.research_task.study.status, 'risk_options_ready');
    assert.equal(state.json.research_task.registry.freeze_hash, null);
    assert.ok(state.json.research_task.study.candidates.every(row => row.decision_rule.includes('5 个百分点')));
    const optionsHtml = await (await request('/workbench', { headers: headers() })).text();
    assert.match(optionsHtml, /每半年复核/); assert.match(optionsHtml, /带冻结规则的新版方案/);
    const confirmed = await post({ action: 'save_profile', expected_revision: state.json.revision, idempotency_key: 'http-fixed-policy-fictional-risk', profile: { ...profile, loss_tolerance: '0.30' } });
    assert.equal(confirmed.status, 200); await invoke(false); state = await get(); assert.equal(state.status, 200);
    assert.equal(state.json.research_task.study.status, 'reference_ready');
    assert.match(state.json.plan.document.strategy_version, /\+fixed-policy-v2$/);
    const saved = await post({ action: 'save_plan', plan_id: state.json.plan.id, expected_revision: state.json.revision, idempotency_key: 'http-save-fixed-policy' });
    assert.equal(saved.status, 200); state = await get(); assert.equal(state.status, 200);
    assert.equal(state.json.model_watch.enabled, false); assert.equal(state.json.model_watch.model_nav_cny, null);
    assert.ok(state.json.effective_gaps.some(row => row.code === 'INVESTOR_MONITOR_FIXED_POLICY_UNSUPPORTED'));
    const rejected = await post({ action: 'set_monitoring', model_id: state.json.model_watch.id, enabled: true, expected_revision: state.json.revision, idempotency_key: 'http-no-old-monitor' });
    assert.equal(rejected.status, 409); assert.equal(rejected.json.error, 'INVESTOR_MONITOR_FIXED_POLICY_UNSUPPORTED');
    assert.equal((await get()).json.revision, state.json.revision); assert.deepEqual(financial(), before);
    const html = await (await request('/workbench', { headers: headers() })).text(); assert.match(html, /低频策略持续监测待接入/);
    const newProfile = await post({ action: 'save_profile', expected_revision: state.json.revision,
      idempotency_key: 'http-fixed-current-research', profile: { ...state.json.profile.document, horizon_years: 14 } });
    assert.equal(newProfile.status, 200); await invoke(false, false); state = await get(); assert.equal(state.status, 200);
    assert.equal(state.json.plan.document.schema_version, 'investor-reference-plan-v2');
    assert.ok(state.json.plan.document.fixed_policy.parameters.roles);
    assert.ok(!state.json.plan.document.strategy_evidence.includes('尚不支持'));
    const newSaved = await post({ action: 'save_plan', plan_id: state.json.plan.id, expected_revision: state.json.revision,
      idempotency_key: 'http-save-fixed-current' });
    assert.equal(newSaved.status, 200); state = await get(); assert.equal(state.status, 200);
    const modelId = state.json.model_watch.id; assert.equal(state.json.model_watch.enabled, true);
    const monitor = async collect => {
      const label = collect ? 'collect' : 'reuse';
      const snapshot = async stage => {
        if (!diagnosticsDirectory) return;
        mkdirSync(diagnosticsDirectory, { recursive: true, mode: 0o700 });
        const destination = path.join(diagnosticsDirectory, `${label}-${stage}.db`);
        const db = new Database(filename, { readonly: true });
        try { await db.backup(destination); chmodSync(destination, 0o600); } finally { db.close(); }
      };
      await snapshot('before');
      const worker = await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3',
        ['-m', 'tests.investor.http_fixed_monitor_fixture', filename, modelId, label],
        { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 60000, encoding: 'utf8', maxBuffer: 65536,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') } });
      const phases = (worker.stderr ?? '').split(/\r?\n/).flatMap(line => {
        try {
          const value = JSON.parse(line);
          if (!['imports', 'open', 'poll_window', 'collect_admit', 'discover', 'execute_publish'].includes(value.phase)) return [];
          if (value.event === 'start' && Object.keys(value).length === 2) return [value];
          if (value.event === 'end' && Object.keys(value).length === 4 && [value.elapsed_ms, value.cpu_ms].every(n => Number.isSafeInteger(n) && n >= 0)) return [value];
        } catch { /* Arbitrary child diagnostics are never copied to the report. */ }
        return [];
      });
      await snapshot('after');
      const diagnostic = { mode: label, status: worker.status, signal: worker.signal, killed: worker.error?.killed === true,
        elapsed_ms: worker.elapsed_ms, phases, fictional_only: true, model_id: modelId };
      if (diagnosticsDirectory) writeFileSync(path.join(diagnosticsDirectory, `${label}.json`), JSON.stringify(diagnostic, null, 2) + '\n', { mode: 0o600 });
      assert.equal(worker.status, 0, `Fictional fixed-policy monitor did not complete (${label}, signal=${worker.signal}, phase=${phases.at(-1)?.phase ?? 'unknown'}, elapsed_ms=${worker.elapsed_ms})`);
      assert.deepEqual(JSON.parse(worker.stdout), { status: 'fictional_fixed_monitor_published', real_provider_called: false });
    };
    await monitor(true); state = await get(); assert.equal(state.status, 200);
    assert.equal(state.json.effective_outcome, 'decision_required'); assert.equal(state.json.model_watch.status, 'research_decision');
    assert.equal(state.json.latest.document.model_change.allocation_method, 'contribution_repair_without_sales');
    assert.equal(state.json.latest.document.model_change.policy_evaluation.class_drift.length, 2);
    const checkpoints = () => read(db => db.prepare('SELECT * FROM investor_evidence_model_checkpoints WHERE model_id=? ORDER BY sequence').all(modelId));
    const frozen = checkpoints(); assert.equal(frozen.length, 1);
    const clock = read(db => JSON.parse(db.prepare('SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?').get(frozen[0].id).payload.toString()).policy_state);
    assert.ok(clock.last_proposed_at); assert.ok(clock.last_funding_hash);
    for (const enabled of [false, true]) {
      const control = await post({ action: 'set_monitoring', model_id: modelId, enabled, expected_revision: state.json.revision,
        idempotency_key: `http-fixed-current-${enabled}` });
      assert.equal(control.status, 200); state = await get(); assert.equal(state.status, 200);
    }
    await monitor(false); state = await get(); assert.equal(state.status, 200); assert.equal(state.json.effective_outcome, 'decision_required');
    assert.deepEqual(checkpoints(), frozen);
    assert.ok(state.json.latest.document.reasons.some(reason => reason.includes('不重复延后冷却起点')));
    const reviewed = await post({ action: 'review', observation_id: state.json.latest.id, decision: 'accept_idea', note: 'Fictional low-frequency review only',
      expected_revision: state.json.revision, idempotency_key: 'http-fixed-current-review' });
    assert.equal(reviewed.status, 200); assert.deepEqual(checkpoints(), frozen); assert.deepEqual(financial(), before);
    const currentHtml = await (await request('/workbench', { headers: headers() })).text(); assert.match(currentHtml, /不重复延后冷却起点/);
    assert.match(currentHtml, /本次低频规则复核/); assert.match(currentHtml, /单证券金额容差不替代类别阈值/);
    return { frozen_rule_version_replayed: true, unknown_risk_not_selected: true, low_frequency_rule_visible: true,
      old_monitor_activation_rejected: true, new_frozen_plan_published: true, policy_state_persisted: true, repeated_idea_anchor_preserved: true,
      pause_resume_and_review_no_execution: true, job_counts: jobCounts, real_provider_called: false, financial_rows_unchanged: true };
  });
  await check('HTTP-I12', 'optional account setup, explicit unlink and relink preserve facts and survive authenticated reads', async () => {
    const before = await get(), initial = financial();
    const command = { action: 'create_account_book', expected_revision: before.json.revision, idempotency_key: 'http-fictional-account-book',
      book_name: 'Fictional HTTP private ledger', account: { name: 'Fictional HTTP account', broker: 'Fictional HTTP broker', currency: 'CNY' } };
    assert.equal((await post({ ...command, actor_id: 'forged' })).status, 400);
    const receipt = await post(command); assert.equal(receipt.status, 200); assert.deepEqual((await post(command)).json, receipt.json);
    let accounts = await jsonRequest(`${endpoint}/accounts`, { headers: headers() }); assert.equal(accounts.status, 200);
    assert.equal(accounts.json.workspace_id, before.json.workspace_id); assert.equal(accounts.json.workspace_revision, before.json.revision + 1);
    const portfolioId = accounts.json.link.document.portfolio_id;
    assert.equal(accounts.json.accounts.length, 1); assert.equal(accounts.json.accounts[0].status, 'reconciliation_required');
    assert.equal(accounts.json.books.find(row => row.id === portfolioId).ledger_revision, 0);
    assert.equal(accounts.json.scope, 'account_records_not_valued'); assert.equal(accounts.json.execution_authorized, false);
    assert.equal((await get()).json.actual_holdings_status, 'linked');
    const after = financial();
    for (const name of Object.keys(initial).filter(name => !['portfolios', 'accounts', 'ledger_heads'].includes(name))) assert.deepEqual(after[name], initial[name]);
    assert.equal(after.portfolios.length, initial.portfolios.length + 1); assert.equal(after.accounts.length, initial.accounts.length + 1);
    let state = await get();
    assert.equal((await post({ action: 'link_portfolio', portfolio_id: 'foreign', expected_ledger_revision: 0,
      expected_revision: state.json.revision, idempotency_key: 'http-out-of-scope-link' })).status, 403);
    const marker = path.join(directory, 'auth', 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'FICTIONAL ACCOUNT RECOVERY LOCK\n');
    try {
      assert.equal((await jsonRequest(`${endpoint}/accounts`, { headers: headers() })).json.read_only, true);
      assert.equal((await post(command)).status, 423);
    } finally { rmSync(marker); }
    assert.equal((await post({ action: 'link_portfolio', portfolio_id: null, expected_ledger_revision: null,
      expected_revision: state.json.revision, idempotency_key: 'http-unlink' })).status, 200);
    accounts = await jsonRequest(`${endpoint}/accounts`, { headers: headers() }); assert.equal(accounts.json.link.version, 2);
    assert.deepEqual(accounts.json.accounts, []); assert.equal((await get()).json.actual_holdings_status, 'not_linked');
    state = await get();
    assert.equal((await post({ action: 'link_portfolio', portfolio_id: portfolioId, expected_ledger_revision: 1,
      expected_revision: state.json.revision, idempotency_key: 'http-stale-ledger-link' })).status, 409);
    assert.equal((await post({ action: 'link_portfolio', portfolio_id: portfolioId, expected_ledger_revision: 0,
      expected_revision: state.json.revision, idempotency_key: 'http-relink' })).status, 200);
    accounts = await jsonRequest(`${endpoint}/accounts`, { headers: headers() }); assert.equal(accounts.json.link.version, 3);
    assert.equal(accounts.json.accounts.length, 1); assert.deepEqual(financial(), after);
    assert.equal((await request('/workbench/accounts', { headers: headers() })).status, 200);
    return { explicit_empty_book_creation: true, association_only: true, factual_cash_and_holdings_writes: false, automatic_orders: false };
  });
  await check('HTTP-I13', 'actual reconciliation and Python valuation reach zero-write holdings HTTP; a new fact invalidates the recorded snapshot', async () => {
    const holdings = () => jsonRequest(`${endpoint}/holdings`, { headers: headers() });
    const accounts = (await jsonRequest(`${endpoint}/accounts`, { headers: headers() })).json;
    const portfolio = accounts.link.document.portfolio_id, account = accounts.accounts[0].id;
    const ledgerPost = value => jsonRequest('/api/workbench', { method: 'POST', headers: headers({ Origin: origin, 'Content-Type': 'application/json' }), body: JSON.stringify(value) });
    const allRows = () => read(db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .filter(row => row.name !== 'auth_sessions').map(row => [row.name, db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()])));
    const fact = (revision, amount) => ({ action: 'record_fact', command: { portfolio_id: portfolio, expected_revision: revision,
      idempotency_key: `http-holdings-${revision}`, source_id: 'FICTIONAL-HOLDINGS', source_event_id: String(revision),
      effective_at: '2000-01-01', time_precision: 'date', source_timezone: 'Asia/Shanghai', reason: 'Fictional holdings HTTP test only',
      fact: { type: 'deposit', account_id: account, currency: 'CNY', amount } } });
    assert.equal((await holdings()).json.status, 'evidence_required');
    const recorded = await ledgerPost(fact(0, '100')); assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
    const cutoff = new Date().toISOString();
    const balances = ['cash_settled', 'trade_receivable', 'trade_payable', 'dividend_receivable', 'dividend_tax_payable', 'transfer_in_transit', 'other_liability', 'cash_hold'];
    const statement = { schema_version: 1, portfolio_id: portfolio, account_id: account, cutoff_at: cutoff,
      coverage: { currencies: ['CNY'], ledger_accounts: balances, positions_complete: true, balances_complete: true, security_transits_complete: true },
      balances: balances.map(ledger_account => ({ currency: 'CNY', ledger_account, balance: ledger_account === 'cash_settled' ? '100' : '0' })), positions: [], security_transits: [] };
    const attachment = await ledgerPost({ action: 'store_attachment', portfolio_id: portfolio, account_id: account, raw: JSON.stringify(statement) });
    assert.equal(attachment.status, 200, JSON.stringify(attachment.json));
    const reconciled = await ledgerPost({ action: 'reconcile_account', command: { portfolio_id: portfolio, account_id: account, expected_revision: 1, attachment_id: attachment.json.id } });
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.json)); assert.equal(reconciled.json.status, 'matched');
    assert.deepEqual((await holdings()).json.gaps, ['VALUATION_REQUIRED']);
    const valuation = await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-m', 'tests.investor.holdings_fixture', '--db', filename], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 60000, encoding: 'utf8', maxBuffer: 65536,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') },
      input: JSON.stringify({ portfolio_id: portfolio, now: new Date().toISOString(), cutoff, documents: [],
        rules: { schema_version: 'valuation-rules-v1', approved: true, approval_evidence: 'Fictional software test only',
          price_scope_by_market: {}, expected_sessions: {}, corporate_actions_complete: {}, max_fx_age_seconds: 86400 } }),
    });
    assert.equal(valuation.status, 0, 'Fictional cash valuation helper did not complete');
    assert.equal(JSON.parse(valuation.stdout).real_provider_called, false);
    const before = allRows(), value = await holdings(); assert.equal(value.status, 200, JSON.stringify(value.json));
    assert.equal(value.json.status, 'verified_as_of'); assert.equal(value.json.snapshot.nav_cny, '100');
    assert.equal(value.json.snapshot.reconciliations.length, 1); assert.equal(value.json.snapshot.account_sync, 'recorded_facts_only_not_realtime');
    assert.equal(value.json.comparison, null); assert.equal(value.json.execution_authorized, false);
    assert.equal(value.headers.get('cache-control'), 'private, no-store'); assert.equal(value.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(allRows(), before);
    const marker = path.join(directory, 'auth', 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'FICTIONAL HOLDINGS RECOVERY LOCK\n');
    try { const locked = await holdings(); assert.equal(locked.json.read_only, true); assert.equal(locked.json.status, 'verified_as_of'); assert.deepEqual(allRows(), before); }
    finally { rmSync(marker); }
    assert.equal((await ledgerPost(fact(1, '1'))).status, 200);
    const changed = allRows(), stale = await holdings(); assert.equal(stale.status, 200); assert.equal(stale.json.snapshot, null);
    assert.deepEqual(stale.json.gaps, ['RECONCILIATION_FACTS_CHANGED']); assert.deepEqual(allRows(), changed);
    assert.equal((await request(`${endpoint}/holdings`, { method: 'POST', headers: headers({ Origin: origin }) })).status, 405);
    return { fictional_facts_explicitly_written: 2, genuine_python_valuation: true, holdings_get_writes: false,
      independent_statement_replayed: true, recorded_snapshot_not_realtime: true, new_fact_hides_snapshot: true, real_provider_called: false, automatic_orders: false };
  });
  await check('HTTP-I14', 'structured independent transcription matches current account through authenticated CAS and exact retry without financial writes', async () => {
    const accounts = (await jsonRequest(`${endpoint}/accounts`, { headers: headers() })).json;
    const account = accounts.accounts[0].id;
    const contextGet = id => jsonRequest(`${endpoint}/reconciliation?account=${encodeURIComponent(id)}`, { headers: headers() });
    assert.equal((await contextGet('foreign')).status, 403);
    const before = financial(), current = await contextGet(account);
    assert.equal(current.status, 200, JSON.stringify(current.json)); assert.deepEqual(financial(), before);
    assert.equal(current.headers.get('cache-control'), 'private, no-store'); assert.equal(current.headers.get('x-content-type-options'), 'nosniff');
    const ctx = current.json;
    assert.equal(ctx.scope, 'metadata_only_no_prefilled_balances'); assert.equal(ctx.execution_authorized, false);
    assert.ok(!JSON.stringify(ctx).includes('"balance"')); assert.ok(!JSON.stringify(ctx).includes('"quantity"'));
    const balances = ['cash_settled', 'trade_receivable', 'trade_payable', 'dividend_receivable', 'dividend_tax_payable', 'transfer_in_transit', 'other_liability', 'cash_hold'];
    const body = { action: 'reconcile_linked_account', expected_revision: (await get()).json.revision, idempotency_key: 'http-structured-reconciliation',
      portfolio_id: ctx.portfolio_id, account_id: account, expected_ledger_revision: ctx.ledger_revision, expected_account_row_version: ctx.account_row_version,
      expected_link_id: ctx.link_id, expected_link_version: ctx.link_version, source_reference: 'Fictional independent manually transcribed statement',
      basis: 'operator_transcription_not_broker_file', acknowledgement: true, resolves_issue_ids: [], resolution_reason: '',
      statement: { schema_version: 1, portfolio_id: ctx.portfolio_id, account_id: account, cutoff_at: new Date().toISOString(),
        coverage: { currencies: ['CNY'], ledger_accounts: balances, positions_complete: true, balances_complete: true, security_transits_complete: true },
        balances: balances.map(ledger_account => ({ currency: 'CNY', ledger_account, balance: ledger_account === 'cash_settled' ? '101' : '0' })), positions: [], security_transits: [] } };
    assert.equal((await post({ ...body, acknowledgement: false })).status, 400);
    assert.equal((await post({ ...body, expected_account_row_version: ctx.account_row_version + 1 })).status, 409);
    assert.deepEqual(financial(), before);
    const accepted = await post(body); assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.equal(accepted.json.action, 'reconcile_linked_account'); const after = financial();
    for (const table of Object.keys(before).filter(table => table !== 'accounts')) assert.deepEqual(after[table], before[table]);
    const repeat = await post(body); assert.equal(repeat.status, 200); assert.deepEqual(repeat.json, accepted.json); assert.deepEqual(financial(), after);
    const refreshed = (await contextGet(account)).json; assert.equal(refreshed.latest.status, 'matched'); assert.equal(refreshed.latest.current_facts, true);
    assert.equal(refreshed.account_row_version, ctx.account_row_version + 1); assert.equal(refreshed.open_issue_count, 0);
    const holdings = await jsonRequest(`${endpoint}/holdings`, { headers: headers() }); assert.equal(holdings.status, 200); assert.equal(holdings.json.snapshot, null);
    assert.deepEqual(holdings.json.gaps, ['VALUATION_NOT_CURRENT']);
    const marker = path.join(directory, 'auth', 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'FICTIONAL STRUCTURED RECONCILIATION RECOVERY\n');
    try { assert.equal((await contextGet(account)).json.read_only, true); assert.equal((await post(body)).status, 423); assert.deepEqual(financial(), after); }
    finally { rmSync(marker); }
    assert.equal((await request(`${endpoint}/reconciliation?account=${account}`, { method: 'POST', headers: headers({ Origin: origin }) })).status, 405);
    return { operator_transcription_not_broker_file: true, no_prefilled_amounts: true, exact_retry: true, current_account_cas: true,
      original_statement_saved: true, financial_writes: false, implicit_valuation: false, automatic_orders: false };
  });
  await check('HTTP-I16', 'private funding persists and retires old current conclusions without rewriting research history or financial facts', async () => {
    const before = (await get()).json, facts = financial();
    const research = () => read(db => Object.fromEntries(['investor_observations', 'investor_reference_plans',
      'investor_plan_selections', 'investor_models', 'investor_model_controls', 'investor_monitor_evidence_inputs',
      'investor_evidence_model_checkpoints', 'investor_evidence_checkpoint_payloads', 'investor_evidence_monitor_requests',
      'investor_evidence_monitor_runs', 'investor_evidence_run_payloads', 'investor_decisions']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
    const archived = research();
    assert.equal(before.funding.status, 'not_configured');
    assert.equal(before.effective_outcome, 'decision_required', JSON.stringify({ gaps: before.effective_gaps.map(gap => gap.code),
      next_review_at: before.latest?.document.next_review_at, checked_at: new Date().toISOString() }));
    assert.equal(before.model_watch.status, 'research_decision');
    const fundingPlan = { schema_version: 'investor-funding-plan-v1', start_date: '2026-01-01', horizon_years: 10,
      evaluation_timezone: 'Asia/Shanghai', initial_capital_cny: '1200', annual_contribution_cny: '300', first_annual_date: '2027-01-01',
      entry_method: 'three_tranches_60_days', actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false };
    const body = { action: 'save_funding_plan', expected_revision: before.revision, idempotency_key: 'http-private-funding', funding_plan: fundingPlan };
    assert.equal((await post(body, { Origin: 'https://wrong.example.test' })).status, 403);
    assert.equal((await post(body, { 'X-Workbench-Session-Binding': 'b'.repeat(64) })).status, 401);
    for (const change of [{ actual_arrivals_confirmed: true }, { execution_authorized: true }, { live_advice_eligible: true }, { actual_cash: '1200' }, { first_annual_date: '2036-01-01' }])
      assert.equal((await post({ ...body, funding_plan: { ...fundingPlan, ...change } })).status, 400);
    assert.equal(read(db => db.prepare('SELECT count(*) n FROM investor_funding_plans').get().n), 0);
    const accepted = await post(body); assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.equal(accepted.json.action, 'save_funding_plan'); assert.deepEqual((await post(body)).json, accepted.json);
    assert.equal((await post({ ...body, idempotency_key: 'http-stale-funding' })).status, 409);
    let state = (await get()).json;
    assert.equal(state.revision, before.revision + 1); assert.equal(state.funding.status, 'planned');
    assert.equal(state.funding.plan.timeline.total_planned_principal_cny, '3900.00'); assert.equal(state.funding.plan.timeline.lots.length, 10);
    assert.equal(state.funding.actual_cash_linked, false); assert.equal(state.funding.plan.profile_hash, state.profile.content_hash);
    for (const key of ['profile', 'plan', 'research_task']) assert.deepEqual(state[key], before[key]);
    // Current read projections retire stale funding bindings; archived evidence stays immutable.
    assert.equal(state.latest.id, before.latest.id); assert.equal(state.latest.candidate_plan_id, null);
    assert.equal(state.latest.document.input_version, before.latest.document.input_version);
    assert.equal(state.latest.document.outcome, 'insufficient_evidence'); assert.equal(state.latest.document.model_change, undefined);
    assert.equal(state.effective_outcome, 'insufficient_evidence');
    assert.ok(state.effective_gaps.some(gap => gap.code === 'MONITOR_FUNDING_PLAN_CHANGED'));
    assert.equal(state.model_watch.status, 'outdated'); assert.equal(state.model_watch.model_nav_cny, null);
    for (const key of ['id', 'profile_id', 'plan_id', 'plan_hash', 'evaluation_input_version', 'checkpoint_sequence', 'enabled'])
      assert.deepEqual(state.model_watch[key], before.model_watch[key]);
    assert.deepEqual(state.observations.map(row => row.id), before.observations.map(row => row.id));
    assert.deepEqual(research(), archived);
    assert.equal((await post({ action: 'review', expected_revision: state.revision, idempotency_key: 'http-retired-funding-review',
      observation_id: before.latest.id, decision: 'accept_idea', note: '' })).status, 400);
    assert.equal((await get()).json.revision, state.revision); assert.deepEqual(research(), archived);
    assert.deepEqual(financial(), facts);
    const html = await (await request('/workbench/plan', { headers: headers() })).text();
    assert.ok(html.includes('长期投入安排')); assert.ok(html.includes('3900.00')); assert.ok(html.includes('没有预测收益'));
    const marker = path.join(directory, 'auth', 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'FICTIONAL PLANNED FUNDING RECOVERY\n');
    try { assert.equal((await get()).json.funding.status, 'planned'); assert.equal((await post(body)).status, 423); assert.deepEqual(financial(), facts); }
    finally { rmSync(marker); }
    assert.equal((await post({ action: 'save_profile', expected_revision: state.revision, idempotency_key: 'http-funding-profile-review',
      profile: { ...state.profile.document, horizon_years: 5 } })).status, 200);
    state = (await get()).json; assert.equal(state.funding.status, 'requires_review'); assert.equal(state.funding.plan.document.initial_capital_cny, '1200');
    assert.equal((await post({ ...body, expected_revision: state.revision, idempotency_key: 'http-funding-horizon-conflict' })).status, 409);
    assert.equal((await post({ ...body, expected_revision: state.revision, idempotency_key: 'http-funding-reviewed', funding_plan: { ...fundingPlan, horizon_years: 5 } })).status, 200);
    // Reuse the authenticated session: the full fixture already consumes its
    // login budget in dedicated auth cases. Native UI covers a second login.
    state = (await get()).json;
    assert.equal(state.funding.status, 'planned'); assert.equal(state.funding.plan.version, 2);
    assert.equal(state.funding.plan.timeline.total_planned_principal_cny, '2400.00'); assert.deepEqual(financial(), facts);
    return { private_planned_funding: true, explicit_annual_dates: true, cents_conserved: true, exact_retry: true,
      old_conclusion_retired: true, archived_research_unchanged_on_funding_save: true, retired_review_rejected: true,
      profile_change_requires_review: true, risk_budget_changed: false, financial_tables_unchanged: true,
      history_or_source_comparison_computed: false, actual_arrivals_confirmed: false, automatic_orders: false };
  });
  await check('HTTP-I17', 'one-click funding study binds current private versions and retains a full-horizon gap without inline data, profit publication or financial writes', async () => {
    const before = (await get()).json, facts = financial();
    const body = { action: 'compare_funding', expected_revision: before.revision, idempotency_key: 'http-private-funding-study' };
    assert.equal((await post(body, { Origin: 'https://wrong.example.test' })).status, 403);
    assert.equal((await post(body, { 'X-Workbench-Session-Binding': 'b'.repeat(64) })).status, 401);
    for (const extra of [{ dataset: {} }, { parameters: {} }, { historical_start_date: '2024-01-01' }, { execution_authorized: true }])
      assert.equal((await post({ ...body, ...extra })).status, 400);
    const accepted = await post(body); assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.equal(accepted.json.action, 'compare_funding'); assert.deepEqual((await post(body)).json, accepted.json);
    assert.equal((await post({ ...body, idempotency_key: 'http-stale-study' })).status, 409);
    let state = (await get()).json;
    assert.equal(state.funded_study.profile_id, state.profile.id); assert.equal(state.funded_study.funding_plan_id, state.funding.plan.id);
    assert.ok(['queued', 'outdated'].includes(state.funded_study.status)); assert.equal(state.funded_study.economics_independently_replayed, false);
    assert.deepEqual(financial(), facts);
    const worker = await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON ?? 'python3', ['-c', `
from pathlib import Path
import sys,tempfile
from worker.orchestration.db import open_database
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import command_handler
from worker.investor.funded_study_runtime import sync_funded_study_requests
p=Path(sys.argv[1]).resolve(strict=True)
assert p.parent.parent==Path(tempfile.gettempdir()).resolve() and p.parent.name.startswith('etf-workbench-http-') and p.name=='workbench.db'
db=open_database(p)
try:
    sync_funded_study_requests(db)
    result=run_one(db,'http-fictional-funded-study',command_handler(db),job_type='investor_funded_study')
    assert result is not None
    assert result['status'] in ('succeeded','skipped')
finally:
    db.close()
`, filename], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 60000, encoding: 'utf8', maxBuffer: 65536,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') } });
    assert.equal(worker.status, 0, 'Fictional funded-study worker did not complete');
    state = (await get()).json;
    assert.ok(['blocked', 'outdated'].includes(state.funded_study.status)); assert.equal(state.funded_study.historical_start_date, null);
    assert.ok(state.funded_study.reason_codes.length); assert.equal(state.funded_study.candidate_count, 0);
    assert.equal(state.funded_study.live_advice_eligible, false); assert.deepEqual(financial(), facts);
    const html = await (await request('/workbench/plan', { headers: headers() })).text();
    assert.ok(html.includes('比较及时投入与有限分期')); assert.ok(html.includes('长期比较条件尚未满足') || html.includes('旧任务不再适用'));
    const marker = path.join(directory, 'auth', 'RESTORE_PENDING_REVIEW'); writeFileSync(marker, 'FICTIONAL FUNDED STUDY RECOVERY\n');
    try { assert.equal((await get()).json.funded_study.status, state.funded_study.status); assert.equal((await post(body)).status, 423); }
    finally { rmSync(marker); }
    return { private_version_binding: true, exact_retry: true, no_inline_dataset: true, full_horizon_not_truncated: true,
      profit_published: false, risk_budget_changed: false, financial_tables_unchanged: true, automatic_orders: false };
  });
  await check('HTTP-I18', 'private on-demand economic comparison replays every retained fictional candidate, rejects forged scope, and hides withdrawn results', async () => {
    let state = (await get()).json; const facts = financial(), originalRisk = state.profile.document.loss_tolerance;
    const funding = { ...state.funding.plan.document, horizon_years: 1, first_annual_date: '2026-12-31' };
    assert.equal((await post({ action: 'save_funding_plan', expected_revision: state.revision, idempotency_key: 'http-result-funding', funding_plan: funding })).status, 200);
    const fixture = async code => {
      const result = await runHttpFixture(process.env.WORKBENCH_TEST_PYTHON ?? 'python3', ['-c', `
from pathlib import Path
import sys,tempfile
from datetime import timedelta
from worker.orchestration.db import open_database,instant
p=Path(sys.argv[1]).resolve(strict=True)
assert p.parent.parent==Path(tempfile.gettempdir()).resolve() and p.parent.name.startswith('etf-workbench-http-') and p.name=='workbench.db'
db=open_database(p)
try:
${code}
finally:
    db.close()
`, filename], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 120000, encoding: 'utf8', maxBuffer: 65536,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') } });
      assert.equal(result.status, 0, 'Fictional retained-results fixture did not complete');
    };
    await fixture(`    from tests.investor import evidence_fixture as f
    now=instant().isoformat(timespec='milliseconds').replace('+00:00','Z')
    f.EXPIRY=(instant(now)+timedelta(days=30)).isoformat(timespec='milliseconds').replace('+00:00','Z')
    rows=db.execute('SELECT id,owner_id FROM investor_workspaces').fetchall()
    assert len(rows)==1
    f.create(db,rows[0]['id'],rows[0]['owner_id'],now=now,fixed_policy_v2=True,funded_year=True)`);
    state = (await get()).json;
    assert.equal((await post({ action: 'compare_funding', expected_revision: state.revision, idempotency_key: 'http-retained-result-study' })).status, 200);
    await fixture(`    from worker.investor.funded_study_runtime import sync_funded_study_requests
    from worker.orchestration.jobs import run_one
    from worker.orchestration.runtime import command_handler
    sync_funded_study_requests(db)
    result=run_one(db,'http-retained-result-worker',command_handler(db),job_type='investor_funded_study')
    assert result and result['status']=='succeeded'`);
    state = (await get()).json; assert.equal(state.funded_study.status, 'calculated_unverified');
    const metadata = () => read(db => ({ audit_count: db.prepare('SELECT count(*) n FROM audit_events').get().n,
      revision: db.prepare('SELECT revision FROM investor_workspaces').get().revision,
      result_count: db.prepare('SELECT count(*) n FROM investor_funded_result_payloads').get().n,
      runs: db.prepare('SELECT * FROM investor_funded_study_runs ORDER BY rowid').all() }));
    const beforeRead = metadata(), comparison = await jsonRequest(`${endpoint}/funded-comparison`, { headers: headers() });
    assert.equal(comparison.status, 200, JSON.stringify(comparison.json)); assert.equal(comparison.json.status, 'verified_retrospective');
    assert.equal(comparison.json.candidates.length, 3); assert.equal(comparison.json.economics_independently_replayed, true);
    assert.equal(comparison.json.session_binding, binding); assert.equal(comparison.json.workspace_revision, state.revision);
    assert.equal(comparison.json.execution_authorized, false); assert.equal(comparison.json.publication_eligible, false);
    assert.equal(comparison.json.source_independently_verified, false); assert.equal(comparison.json.parameters_independently_preregistered, false);
    assert.equal(comparison.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(metadata(), beforeRead); assert.deepEqual(financial(), facts); assert.equal((await get()).json.profile.document.loss_tolerance, originalRisk);
    assert.equal((await request(`${endpoint}/funded-comparison`, { method: 'POST', headers: headers({ Origin: origin }) })).status, 405);
    const analysisUrl = `${endpoint}/funded-analysis?candidate=${comparison.json.candidates[0].parameters_hash}&path=staged`;
    const analysis = await jsonRequest(analysisUrl, { headers: headers() });
    assert.equal(analysis.status, 200, JSON.stringify(analysis.json)); assert.equal(analysis.json.status, 'verified_retrospective');
    assert.equal(analysis.headers.get('cache-control'), 'private, no-store'); assert.equal(analysis.json.session_binding, binding);
    assert.equal(analysis.json.publication_eligible, false); assert.equal(analysis.json.execution_authorized, false); assert.equal(analysis.json.live_advice_eligible, false);
    assert.equal(analysis.json.source_independently_verified, false); assert.equal(analysis.json.parameters_independently_preregistered, false);
    assert.deepEqual(analysis.json.analysis.candidate.summary, comparison.json.candidates[0].paths.staged);
    assert.equal(analysis.json.analysis.candidate.daily.at(-1).principal_cny, '1500'); assert.equal(analysis.json.analysis.baseline.summary.principal_cny, '1500');
    assert.equal(analysis.json.analysis.baseline_preregistered, false); assert.equal(analysis.json.analysis.candidate.monthly.length, 12);
    assert.ok(analysis.json.analysis.candidate.full_observation_count > analysis.json.analysis.candidate.daily.length);
    assert.ok(analysis.json.analysis.candidate.rolling.every(row => row.status === 'insufficient_history'));
    assert.deepEqual(metadata(), beforeRead); assert.deepEqual(financial(), facts);
    assert.equal((await request(analysisUrl, { method: 'POST', headers: headers({ Origin: origin }) })).status, 405);
    await fixture(`    from worker.investor.data_evidence import review_source
    now=instant().isoformat(timespec='milliseconds').replace('+00:00','Z')
    row=db.execute("""SELECT s.*,w.owner_id FROM investor_funded_study_requests r
        JOIN investor_evidence_inputs i ON i.id=r.evidence_input_id
        JOIN json_each(i.document_json,'$.snapshot.review_refs') ref
        JOIN investor_data_sources s ON s.id=json_extract(ref.value,'$.source_id') AND s.workspace_id=r.workspace_id
        JOIN investor_workspaces w ON w.id=r.workspace_id WHERE s.kind='rights'
        ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1""").fetchone()
    review_source(db,row['workspace_id'],row['owner_id'],row['id'],'withdrawn',None,'Fictional HTTP withdrawal',(instant(now)+timedelta(days=30)).isoformat(timespec='milliseconds').replace('+00:00','Z'),now=now)`);
    const stale = await jsonRequest(`${endpoint}/funded-comparison`, { headers: headers() });
    assert.equal(stale.status, 200); assert.equal(stale.json.status, 'outdated'); assert.deepEqual(stale.json.candidates, []);
    const staleAnalysis = await jsonRequest(analysisUrl, { headers: headers() });
    assert.equal(staleAnalysis.status, 200); assert.equal(staleAnalysis.json.status, 'outdated'); assert.equal(staleAnalysis.json.analysis, null);
    await fixture(`    from worker.orchestration.runtime import run_pending_once
    run_pending_once(db,'http-retention-core')
    assert db.execute('SELECT count(*) FROM investor_funded_result_payloads').fetchone()[0]==0
    assert db.execute('SELECT count(*) FROM investor_funded_result_purges').fetchone()[0]==3`);
    assert.deepEqual(financial(), facts);
    return { fictional_reconstructed_source: true, all_candidates_retained: true, independent_economic_replay: true,
      read_only_get: true, full_window_daily_curve: true, all_observation_risk: true, same_cashflow_holding_baseline: true,
      source_withdrawal_hides_results: true, core_retention_cleanup: true, real_strategy_certified: false, automatic_orders: false };
  });
  await check('HTTP-I19', 'explicit risk confirmation preserves other preferences and funding, requeues research without selecting weights or trading', async () => {
    const before = (await get()).json, facts = financial();
    const requestCount = () => read(db => db.prepare('SELECT count(*) n FROM investor_research_requests WHERE workspace_id=?').get(before.workspace_id).n);
    const requestsBefore = requestCount();
    const fundingDocument = before.funding.plan?.document ?? null;
    const profile = { ...before.profile.document, loss_tolerance: before.profile.document.loss_tolerance === '0.20' ? '0.30' : '0.20' };
    const body = { action: 'save_profile', profile, expected_revision: before.revision, idempotency_key: 'http-risk-confirm' };
    const html = await (await request('/workbench/plan', { headers: headers() })).text();
    assert.ok(html.includes('先看可能损失，再确认研究风险预算')); assert.ok(html.includes('不授权交易'));
    const saved = await post(body); assert.equal(saved.status, 200);
    assert.deepEqual((await post(body)).json, saved.json);
    assert.equal((await post({ ...body, idempotency_key: 'http-risk-stale-choice' })).status, 409);
    const after = (await get()).json;
    assert.deepEqual(after.profile.document, profile); assert.equal(after.profile.version, before.profile.version + 1);
    assert.equal(requestCount(), requestsBefore + 1); assert.notEqual(after.research_task.id, before.research_task.id);
    assert.equal(after.research_task.profile_id, after.profile.id); assert.equal(after.research_task.study, null);
    assert.equal(after.research_task.status, 'outdated'); assert.ok(after.research_task.reason_codes.includes('REFERENCE_SOURCE_NO_LONGER_CURRENT'));
    const registered = read(db => db.prepare('SELECT * FROM investor_research_requests WHERE id=? AND workspace_id=?').get(after.research_task.id, after.workspace_id));
    assert.equal(registered.profile_id, after.profile.id); assert.equal(JSON.parse(registered.document_json).profile_hash, after.profile.content_hash);
    assert.deepEqual(after.funding.plan?.document ?? null, fundingDocument);
    if (fundingDocument) assert.equal(after.funding.status, 'requires_review');
    assert.equal(after.plan, null); assert.equal(after.live_advice_eligible, false);
    assert.deepEqual(financial(), facts);
    return { explicit_choice: true, original_preferences_preserved: true, existing_funding_not_automatically_rebound: true,
      current_research_registered: true, withdrawn_source_stays_unavailable: true, duplicate_replay_safe: true, source_qualification_upgraded: false, automatic_orders: false };
  });
}
