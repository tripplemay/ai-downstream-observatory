import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const Ajv2020 = require('ajv/dist/2020').default, formats = require('ajv-formats').default;
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true }); formats(ajv);
const directory = new URL('../../contracts/v1/', import.meta.url);
for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.schema.json')))
  ajv.addSchema(JSON.parse(fs.readFileSync(new URL(name, directory), 'utf8')));

test('issuer permission and capture contracts are closed staging records, never financial admission or arbitrary transport metadata', () => {
  const authority = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-issuer-authority.schema.json');
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3',
    ['-c', 'import json; from tests.investor.test_issuer_sources import policy; print(json.dumps(policy()))'],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr); const policy = JSON.parse(child.stdout);
  assert.equal(authority(policy), true, JSON.stringify(authority.errors));
  for (const change of [{ uses: [...policy.uses, 'external_ai'] }, { authorization_basis: 'provider_certified' },
    { fund_id: '9998/../../' }, { enabled: true }, { app_secret: 'fictional' }]) assert.equal(authority({ ...policy, ...change }), false);
  const id = 'https://etf-workbench.invalid/contracts/v1/investor-issuer-capture.schema.json';
  const result = ajv.getSchema(id + '#/$defs/result'), at = '2026-01-03T12:00:03.000Z';
  const failure = { schema_version: 'investor-issuer-capture-v1', capture_id: 'c', workspace_id: 'w', request_id: 'r', request_hash: 'a'.repeat(64),
    qualification: 'injected_test_issuer', status: 'transport_failed', reason_code: 'ISSUER_CAPTURE_RATE_LIMITED',
    raw_sha256: null, raw_bytes: null, draft_hash: null, parser_version: null, transport: null, created_at: at, retain_until: null,
    owner_reviewed: false, research_admitted: false, corporate_actions_complete: false, live_advice_eligible: false };
  assert.equal(result(failure), true, JSON.stringify(result.errors));
  for (const change of [{ reason_code: 'PRIVATE_UNRECOGNIZED_DIAGNOSTIC' }, { status: 'superseded' }, { raw_bytes: 1 },
    { owner_reviewed: true }, { research_admitted: true }, { corporate_actions_complete: true }, { live_advice_eligible: true },
    { raw: '{}' }, { qualification: 'owner_reviewed_reconstructed' }]) assert.equal(result({ ...failure, ...change }), false);
  const captured = { ...failure, status: 'captured', reason_code: 'ISSUER_DRAFT_CAPTURED', raw_sha256: 'b'.repeat(64), raw_bytes: 2,
    draft_hash: 'c'.repeat(64), parser_version: 'vanguard-distributions-draft-v1', retain_until: '2026-01-04T12:00:03.000Z',
    transport: { schema_version: 'vanguard-fixed-issuer-https-v1', source_url: 'https://fictional.invalid/fixture',
      request: { fund_id: '9998', has_distribution_yield: false }, started_at: at, completed_at: at, retrieved_at: at,
      http_status: 200, headers: { 'content-type': 'application/json' }, raw_sha256: 'b'.repeat(64), raw_bytes: 2, redirects_followed: 0 } };
  assert.equal(result(captured), true, JSON.stringify(result.errors));
  for (const transport of [{ ...captured.transport, credential: 'fictional' }, { ...captured.transport, raw_base64: 'e30=' },
    { ...captured.transport, redirects_followed: 1 }, { ...captured.transport, headers: { ...captured.transport.headers, 'set-cookie': 'fictional' } }])
    assert.equal(result({ ...captured, transport }), false);
});

test('bounded funding has explicit closed versions and does not relabel old economics or grant execution', () => {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c',
    "import json; from tests.investor.bounded_funding_fixtures import bounded_input; from worker.investor.funded_history import prepare_funded_history,calculate_funded_history; d=bounded_input(); p,k=prepare_funded_history(d,allow_synthetic=True); print(json.dumps({'input':d,'continuous':k,'result':calculate_funded_history(d,allow_synthetic=True)}))"],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout), validate = name => ajv.getSchema('https://etf-workbench.invalid/contracts/v1/' + name + '.schema.json');
  for (const [document, current, legacy] of [[value.input, 'investor-funded-history-input-v2', 'investor-funded-history-input'],
    [value.result, 'investor-funded-history-result-v2', 'investor-funded-history-result'],
    [value.continuous, 'investor-long-horizon-input-v3', 'investor-long-horizon-input-v2'],
    [value.result.comparison, 'investor-long-horizon-result-v3', 'investor-long-horizon-result-v2']]) {
    assert.equal(validate(current)(document), true, JSON.stringify(validate(current).errors));
    assert.equal(validate(legacy)(document), false);
    assert.equal(validate(current)({ ...document, unexpected: true }), false);
  }
  assert.equal(validate('investor-funded-history-request')(value.input), true);
  for (const key of ['buy_price_buffer_bps', 'buy_fx_buffer_bps']) {
    const missing = structuredClone(value.input); delete missing.context.execution[key];
    assert.equal(validate('investor-funded-history-request')(missing), false);
  }
  for (const key of ['actual_arrivals_confirmed', 'economics_independently_replayed', 'execution_authorized',
    'parameters_independently_preregistered', 'source_independently_verified', 'live_advice_eligible'])
    assert.equal(validate('investor-funded-history-result-v2')({ ...value.result, [key]: true }), false);
});

test('private funded-study registration and digest-only run are closed and cannot claim economic replay or contain raw economics', () => {
  const id = 'https://etf-workbench.invalid/contracts/v1/investor-funded-study.schema.json', digest = 'a'.repeat(64);
  const denied = { economics_independently_replayed: false, parameters_independently_preregistered: false,
    actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false };
  const request = { schema_version: 'investor-funded-study-request-v1', workspace_id: 'w', profile_id: 'p', profile_hash: digest,
    funding_plan_id: 'f', funding_plan_hash: digest, source_head_id: null, evidence_input_id: null, input_hash: null,
    comparison_declared_at: '2026-01-02T12:00:04.000Z', window_selection: 'earliest_complete_same_calendar_anchor_v1', historical_start_date: null,
    candidate_hashes: [], reason_codes: ['FUNDED_STUDY_REVIEWED_SOURCE_REQUIRED'], ...denied };
  const run = { schema_version: 'investor-funded-study-run-v1', request_id: 'r', input_version: digest, implementation_hash: digest,
    created_at: request.comparison_declared_at, status: 'blocked', reason_codes: request.reason_codes, candidates: [], ...denied };
  assert.equal(ajv.getSchema(id)(request), true);
  assert.equal(ajv.getSchema(id + '#/$defs/run')(run), true);
  for (const key of Object.keys(denied)) {
    assert.equal(ajv.getSchema(id)({ ...request, [key]: true }), false);
    assert.equal(ajv.getSchema(id + '#/$defs/run')({ ...run, [key]: true }), false);
  }
  for (const extra of [{ dataset: {} }, { parameters: {} }, { profit_cny: '123' }, { result: {} }, { selected_weights: {} }]) {
    assert.equal(ajv.getSchema(id)({ ...request, ...extra }), false);
    assert.equal(ajv.getSchema(id + '#/$defs/run')({ ...run, ...extra }), false);
  }
});

test('planned historical funding retains real registration claims and closed retrospective versions without publication grants', () => {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c',
    "import json; from tests.investor.funded_history_fixtures import funded_input; from worker.investor.funded_history import prepare_funded_history,calculate_funded_history; d=funded_input(); p,k=prepare_funded_history(d,allow_synthetic=True); print(json.dumps({'input':d,'continuous':k,'result':calculate_funded_history(d,allow_synthetic=True)}))"],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout), validate = name => ajv.getSchema('https://etf-workbench.invalid/contracts/v1/' + name + '.schema.json');
  assert.equal(validate('investor-funded-history-input')(value.input), true);
  assert.equal(validate('investor-funded-history-result')(value.result), true);
  assert.equal(validate('investor-long-horizon-input-v2')(value.continuous), true);
  assert.equal(validate('investor-long-horizon-result-v2')(value.result.comparison), true);
  assert.equal(validate('investor-long-horizon-input')(value.continuous), false);
  assert.equal(validate('investor-long-horizon-result')(value.result.comparison), false);
  assert.equal(validate('investor-kernel-request')({ action: 'funded_history', ...value.input }), false);
  for (const key of ['actual_arrivals_confirmed', 'economics_independently_replayed', 'execution_authorized',
    'parameters_independently_preregistered', 'source_independently_verified', 'live_advice_eligible'])
    assert.equal(validate('investor-funded-history-result')({ ...value.result, [key]: true }), false);
  assert.equal(validate('investor-funded-history-input')({ ...value.input, context: { ...value.input.context, parameters_frozen_at: '2014-01-01T00:00:00Z' } }), false);
  assert.equal(validate('investor-funded-history-input')({ ...value.input, result: value.result }), false);
});

test('planned annual funding is a closed private assumption, not cash, risk or a strategy result', () => {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c',
    "import json; from tests.investor.test_funding_plan import plan; from worker.investor.funding_plan import funding_timeline; p=plan(); print(json.dumps({'input':p,'timeline':funding_timeline(p)}))"],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8', maxBuffer: 65536, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout), validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-funding-plan.schema.json');
  assert.equal(validate(value.input), true, JSON.stringify(validate.errors));
  assert.equal(value.timeline.total_planned_principal_cny, '3900.00');
  for (const change of [{ actual_arrivals_confirmed: true }, { execution_authorized: true }, { live_advice_eligible: true },
    { actual_cash: '1200' }, { targets: { a: '1' } }, { loss_tolerance: '0.30' }, { horizon_years: 11 }, { evaluation_timezone: '+01:00' }])
    assert.equal(validate({ ...value.input, ...change }), false);
});

test('continuous funding contracts are shared and closed, not historical phase inputs or advice grants', () => {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c',
    "import json; from tests.investor.long_horizon_fixtures import long_input; from worker.investor.long_horizon import compare_funding_paths; d=long_input(days=5); print(json.dumps({'input':d,'output':compare_funding_paths(d,allow_synthetic=True)}))"],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout);
  const input = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-long-horizon-input.schema.json');
  const output = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-long-horizon-result.schema.json');
  assert.equal(input(value.input), true, JSON.stringify(input.errors));
  assert.equal(output(value.output), true, JSON.stringify(output.errors));
  for (const change of [{ approved: true }, { execute: true }, { result: value.output },
    { plan: { ...value.input.plan, schema_version: 'research-plan-v2' } },
    { plan: { ...value.input.plan, funding_policy: { ...value.input.plan.funding_policy, choose_best_price: true } } },
    { plan: { ...value.input.plan, funding_policy: { ...value.input.plan.funding_policy, contribution_offsets_days: [0, 61] } } }])
    assert.equal(input({ ...value.input, ...change }), false);
  for (const key of ['live_advice_eligible', 'actual_holdings_linked', 'execution_authorized',
    'source_independently_verified', 'parameters_independently_preregistered'])
    assert.equal(output({ ...value.output, [key]: true }), false);
  assert.equal(output({ ...value.output, runs: { ...value.output.runs,
    staged: { ...value.output.runs.staged, actual_cash_written: true } } }), false);
  assert.equal(ajv.getSchema('https://etf-workbench.invalid/contracts/v1/research-plan.schema.json')(value.input.plan), false);
  assert.equal(ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-kernel-request.schema.json')({ action: 'long_horizon', ...value.input }), false);
});

test('stateful fixed monitor and assessment are closed new versions, not grants or extensions of old inputs', () => {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? 'python3', ['-c',
    "import json; from tests.investor.policy_monitor_fixtures import document; from tests.investor.fixtures import MONITOR_NOW; from worker.investor.monitor import assess_model; d=document(); print(json.dumps({'request':{'action':'monitor','document':d,'now':MONITOR_NOW},'result':assess_model(d,MONITOR_NOW)}))"],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  const { request, result } = JSON.parse(child.stdout);
  const input = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-kernel-request.schema.json');
  const output = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-model-assessment-v2.schema.json');
  assert.equal(input(request), true, JSON.stringify(input.errors)); assert.equal(output(result), true, JSON.stringify(output.errors));
  for (const change of [{ schema_version: 'investor-model-monitor-v2' }, { actual_cash: '100' }, { execution_authorized: true },
    { policy: { ...request.document.policy, weight_band: '0' } }, { fixed_policy: { ...request.document.fixed_policy, auto_trade: true } }])
    assert.equal(input({ ...request, document: { ...request.document, ...change } }), false);
  for (const change of [{ schema_version: 'investor-model-assessment-v1' }, { live_advice_eligible: true }, { source_certified: true },
    { next_policy_state: { ...result.next_policy_state, transaction_applied: true } }]) assert.equal(output({ ...result, ...change }), false);
  assert.equal(ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-model-assessment.schema.json')(result), false);
});

test('fixed-policy v2 is an explicit closed union, not an extension of monthly v1 defaults', () => {
  const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/research-fixed-policy-parameters.schema.json');
  const legacy = { schema_version: 'research-fixed-rebalance-parameters-v1', weights: { a: '1' }, rebalance: 'first_decision_each_month', tolerance: { absolute_cny: '0', weight: '0' } };
  const value = { ...legacy, schema_version: 'research-fixed-rebalance-parameters-v2', rebalance: 'first_decision_each_year', roles: { a: 'growth' },
    class_drift_threshold: '0.05', minimum_days_between_rebalances: 30, contribution_mode: 'repair_underweight_without_sales', order_expiry: 'next_month_boundary' };
  assert.equal(validate(legacy), true); assert.equal(validate(value), true, JSON.stringify(validate.errors));
  for (const change of [{ schema_version: legacy.schema_version }, { rebalance: legacy.rebalance }, { minimum_days_between_rebalances: 0 },
    { minimum_days_between_rebalances: 367 }, { contribution_mode: 'sell_then_buy' }, { order_expiry: 'never' }, { auto_trade: true }])
    assert.equal(validate({ ...value, ...change }), false);
});

test('owner-reviewed evidence facts are closed contracts, not provider licence certification', () => {
  const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-data-facts.schema.json');
  const value = { kind: 'rights', facts: { provider: 'longport', account_region: 'SG', markets: ['CN'], uses: ['private_research'],
    retention_days: 1, valid_from: '2025-01-01T00:00:00Z', valid_until: '2027-01-01T00:00:00Z', clause_references: ['Fictional software test only'] } };
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, provider_certified: true }), false);
  assert.equal(validate({ ...value, facts: { ...value.facts, uses: ['automatic_trading'] } }), false);
  assert.equal(validate({ ...value, facts: { ...value.facts, account_region: 'unknown' } }), false);
});

test('current FX series requires an explicit closed owner-reviewed append-only declaration', () => {
  const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-data-facts.schema.json');
  const facts = { currency: 'USD', unit: 'CNY_per_unit_currency', rows: [
    { observed_at: '2026-01-02T10:00:00Z', assumed_available_at: '2026-01-02T10:01:00Z', value: '7.1' } ] };
  assert.equal(validate({ kind: 'fx', facts }), true, JSON.stringify(validate.errors));
  const series = { authority_id: 'fictional-reference-series', revision_policy: 'append_only_no_restatements' };
  assert.equal(validate({ kind: 'fx', facts: { ...facts, monitor_series: series } }), true, JSON.stringify(validate.errors));
  for (const monitor_series of [{ ...series, revision_policy: 'pick_newest' }, { authority_id: series.authority_id },
    { ...series, provider_certified: true }, { ...series, authority_id: '' }, null])
    assert.equal(validate({ kind: 'fx', facts: { ...facts, monitor_series } }), false);
});

test('snapshot manifest cannot grant external AI, live eligibility or point-in-time archive status', () => {
  const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-data-snapshot.schema.json');
  const value = { schema_version: 'investor-data-snapshot-v1', workspace_id: 'fixture', created_at: '2026-01-02T12:00:03.000Z',
    range_start: '2025-06-05', range_end: '2025-06-06', mode: 'reconstructed',
    capture_refs: [{ capture_id: 'fixture-capture', receipt_hash: 'a'.repeat(64), projection_sha256: 'b'.repeat(64) }],
    review_refs: [{ review_id: 'fixture-review', review_hash: 'c'.repeat(64), source_id: 'fixture-source', source_hash: 'd'.repeat(64) }],
    publication_times: 'reconstructed_assumptions_not_provider_published_at', universe_basis: 'retrospectively_selected_not_survivorship_free',
    review_basis: 'owner_reviewed_not_provider_certified', external_ai_authorized: false, live_advice_eligible: false };
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  for (const change of [{ mode: 'historical_point_in_time' }, { external_ai_authorized: true }, { live_advice_eligible: true }, { capture_refs: [] }, { unexpected: true }])
    assert.equal(validate({ ...value, ...change }), false);
});

test('reconstructed reference plans require closed research provenance without conferring live eligibility', () => {
  const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-reference-plan.schema.json');
  const value = { schema_version: 'investor-reference-plan-v1', profile_id: 'fictional-profile', strategy_version: 'fictional-version',
    strategy_evidence: 'Fictional software fixture only', input_version: 'a'.repeat(64),
    data_cutoff: '2025-06-10T07:00:00.000Z', created_at: '2026-01-02T12:00:03.000Z', valid_until: '2026-02-01T12:00:03.000Z', data_mode: 'reconstructed',
    targets: [{ listing_id: 'fictional', symbol: 'FICTIONAL.SH', name: 'Fictional', market: 'CN', currency: 'CNY', weight: '1', role: 'Fictional role', overlap_summary: 'Unknown overlap' }],
    estimated_cost: 'Frozen assumptions only', risk_scenarios: ['Not a forecast'], benchmark_summary: 'Fictional baseline', counterarguments: ['Not certified'], uncertainties: [],
    reference_evidence: { request_id: 'q', run_id: 'r', source_input_id: 's', experiment_id: 'e', manifest_hash: 'b'.repeat(64), result_hash: 'c'.repeat(64), selected_parameters_hash: 'd'.repeat(64),
      holdout_status: 'not_independently_verified', qualification: 'owner_reviewed_reconstructed' }, live_advice_eligible: false };
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  const { reference_evidence, ...missing } = value;
  assert.equal(validate(missing), false);
  for (const change of [{ live_advice_eligible: true }, { data_cutoff: '2025-06-10T07:00:00.000123Z' }, { unexpected: true },
    { data_mode: 'synthetic' }, { reference_evidence: { ...reference_evidence, holdout_status: 'independently_verified' } },
    { reference_evidence: { ...reference_evidence, auto_trading_authorized: true } }]) assert.equal(validate({ ...value, ...change }), false);
  assert.equal(validate({ ...missing, data_mode: 'synthetic' }), true);
});

test('monitor data inputs contain only scoped references and explicit settings, not quote arrays or live grants', () => {
  const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-monitor-data-input.schema.json');
  const snapshot = { schema_version: 'investor-data-snapshot-v1', workspace_id: 'fixture', created_at: '2026-01-03T12:00:03.000Z',
    range_start: '2026-01-01', range_end: '2026-01-02', mode: 'reconstructed',
    capture_refs: [{ capture_id: 'fictional-capture', receipt_hash: 'a'.repeat(64), projection_sha256: 'b'.repeat(64) }],
    review_refs: [{ review_id: 'fictional-review', review_hash: 'c'.repeat(64), source_id: 'fictional-source', source_hash: 'd'.repeat(64) }],
    publication_times: 'reconstructed_assumptions_not_provider_published_at', universe_basis: 'retrospectively_selected_not_survivorship_free',
    review_basis: 'owner_reviewed_not_provider_certified', external_ai_authorized: false, live_advice_eligible: false };
  const settings = { policy: { version: 'fictional-policy', weight_band: '0.05', absolute_band_cny: '10', max_fx_age_seconds: 172800, costs: null },
    funding_intent: null, max_quote_age_seconds: 172800 };
  const value = { schema_version: 'investor-monitor-data-input-v1', workspace_id: 'fixture', model_id: 'fictional-model', target_definition_hash: 'e'.repeat(64),
    source_qualification: 'owner_reviewed_reconstructed', segments: [{ snapshot, dataset_hash: 'f'.repeat(64), catalog_hash: 'a'.repeat(64) }],
    settings, projection_hash: 'b'.repeat(64), created_at: snapshot.created_at, valid_until: '2026-02-01T00:00:00.000Z', live_advice_eligible: false };
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  for (const change of [{ quotes: [{ close: '100' }] }, { live_advice_eligible: true }, { segments: [] }, { source_qualification: 'provider_certified' },
    { settings: { ...settings, max_quote_age_seconds: 0 } }, { settings: { ...settings, external_ai_authorized: true } },
    { segments: [{ ...value.segments[0], snapshot: { ...snapshot, mode: 'synthetic' } }] },
    { segments: [{ ...value.segments[0], prices: [] }] }]) assert.equal(validate({ ...value, ...change }), false);
});

test('monitor requests version sparse transitions explicitly without granting new actions', () => {
  const validate = ajv.getSchema('https://etf-workbench.invalid/contracts/v1/investor-evidence-monitor.schema.json');
  const value = { schema_version: 'investor-evidence-monitor-request-v1', engine_version: 'investor-evidence-model-watcher-v2',
    model_hash: 'a'.repeat(64), profile_hash: 'b'.repeat(64), control_id: 'fictional-control', input_hash: 'c'.repeat(64), checkpoint_hash: null };
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, engine_version: 'investor-evidence-model-watcher-v1', checkpoint_hash: 'd'.repeat(64) }), true);
  assert.equal(validate({ ...value, engine_version: 'investor-evidence-model-watcher-v3' }), true);
  for (const change of [{ engine_version: 'investor-evidence-model-watcher-v4' }, { reuse_checkpoint: true },
    { automatic_restart: true }, { live_advice_eligible: true }, { checkpoint_hash: 'invalid' }])
    assert.equal(validate({ ...value, ...change }), false);
});
