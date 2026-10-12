import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { Decimal } from "../src/server/ledger/decimal";
import { hash } from "../src/server/ledger/service";
import { economicDate, economicInstant, economicStamp } from "../src/server/investor/continuous-market";
import { replayFundedHistoryEconomics, verifyFundedHistoryEconomics } from "../src/server/investor/funded-history-economics";
import type { FundedHistoryInput } from "../src/server/investor/funded-history";
import { runContinuousEconomics, type ContinuousPlan } from "../src/server/investor/continuous-economics";
import type { ContinuousDataset } from "../src/server/investor/continuous-market";
import { fundedPathReleases } from "../src/server/investor/funded-history-economics";
import { analyzeFundedHistory, analyzeFundedTrace } from "../src/server/investor/funded-analysis-math";

type Obj = Record<string, unknown>;
type Case = { name: string; input: FundedHistoryInput; result: Obj & { comparison: Obj & { runs: Record<string, Obj> } }; traces: Record<string, Obj>; baselines: Record<string, Obj> };
let cache: Case[] | null = null;
function fixtures() {
  if (cache) return cache;
  const script = `
import json
from copy import deepcopy
from datetime import timedelta
from zoneinfo import ZoneInfo
from tests.investor.funded_history_fixtures import funded_input
from worker.investor.funded_history import calculate_funded_history,prepare_funded_history
from worker.investor.long_horizon import funding_schedule
from worker.research.rotation import run_continuous_portfolio
from worker.orchestration.db import instant,stamp
cases=[]
def add(name,p):
    projection,kernel=prepare_funded_history(p,allow_synthetic=True)
    traces={};baselines={}
    for key in ('immediate','staged'):
        _,releases=funding_schedule(kernel['plan'],ZoneInfo(kernel['plan']['evaluation_timezone']),staged=key=='staged')
        traces[key]=run_continuous_portfolio(kernel['dataset'],kernel['plan'],releases)
        baselines[key]=run_continuous_portfolio(kernel['dataset'],kernel['plan'],releases,holding_baseline=True)
    cases.append(dict(name=name,input=p,result=calculate_funded_history(p,allow_synthetic=True),traces=traces,baselines=baselines))
base=funded_input();add('flat',deepcopy(base))
p=deepcopy(base);p['funding_plan'].update(first_annual_date='2026-01-01',initial_capital_cny='100.01',annual_contribution_cny='100.01');add('same_day_cents',p)
p=deepcopy(base);p['funding_plan']['first_annual_date']='2026-02-01';p['funding_plan']['annual_contribution_cny']='1200'
for row in p['dataset']['observations']:
    row['value']='5' if instant(row['observed_at'])>=instant('2015-01-31T00:00:00Z') else '10'
add('drawdown_new_principal',p)
p=deepcopy(base);p['context']['parameters']['minimum_days_between_rebalances']=1
for row in p['dataset']['observations']:
    if row['listing_id']=='CN:ALPHA' and '2015-01-25' in row['observed_at']:row['value']='20'
add('sales_cash_dependencies',p)
p=funded_input(years=2);p['dataset']['actions']=[
dict(id='fictional-dividend',listing_id='CN:ALPHA',type='dividend',at='2015-12-31T06:00:00Z',published_at='2015-12-01T00:00:00Z',source_evidence='Fictional only',gross_per_unit='1',tax_per_unit='0.2',pay_at='2016-01-03T00:00:00Z'),
dict(id='fictional-split',listing_id='CN:ALPHA',type='split',at='2016-01-01T06:00:00Z',published_at='2015-12-01T00:00:00Z',source_evidence='Fictional only',ratio='2')]
for row in p['dataset']['observations']:
    if row['listing_id']=='CN:ALPHA':row['value']='4.5' if row['observed_at']>='2016-01-01T06' else '9' if row['observed_at']>='2015-12-31T06' else '10'
add('cross_year_actions',p)
p=deepcopy(base);p['dataset']['assets'][0]['currency']='USD';template=deepcopy(p['dataset']['observations'][0]);template.pop('listing_id')
for row in p['dataset']['observations']:
    if row['listing_id']=='CN:ALPHA':row['unit']='USD'
for s in p['dataset']['sessions']:
    at=stamp(instant(s['close_at'])-timedelta(hours=1));value='2' if at<'2015-02-01' else '1'
    p['dataset']['observations'].append(dict(template,id='fx:'+s['session_date'],series_key='FX:USD',metric='fx_cny_per_unit',unit='CNY_per_unit_currency',price_basis='not_applicable',value=value,observed_at=at,published_at=at,ingested_at=at))
p['context']['execution'].update(commission_bps='10',minimum_fee_cny='1',slippage_bps='5',fx_bps='20');add('fx_costs',p)
p=deepcopy(base)
for row in p['dataset']['observations']:
    row['assumed_available_at']=row.pop('published_at');row['provenance']='reconstructed'
p['dataset']['mode']='reconstructed';add('reconstructed',p)
p=deepcopy(base);p['dataset']['observations']=[row for row in p['dataset']['observations'] if row['listing_id']!='CN:ALPHA'];add('missing_prices',p)
p=deepcopy(base);p['funding_plan']['evaluation_timezone']='America/New_York';p['context']['parameters']['rebalance']='first_decision_each_half_year';add('ny_calendar',p)
p=deepcopy(base);p['dataset']['mode']='actual_replay'
for row in p['dataset']['observations']:row['provenance']='live_observed'
for row in p['dataset']['settlements']:row['ingested_at']=row['published_at']
add('fictional_actual_replay',p)
p=deepcopy(base);revision=deepcopy(next(row for row in p['dataset']['observations'] if row['listing_id']=='CN:ALPHA' and '2015-01-03' in row['observed_at']))
revision.update(id='fictional-late-revision',revision_id='2',value='11',published_at='2015-01-03T07:01:30Z',ingested_at='2015-01-03T07:01:30Z')
p['dataset']['observations'].append(revision);p['context']['decision_times']=sorted(p['context']['decision_times']+['2015-01-03T07:02:00Z']);add('late_revision',p)
p=deepcopy(base);original=deepcopy(p['dataset']);p['dataset']['assets'][1].update(listing_id='HK:BETA',market='HK',currency='HKD')
p['dataset']['assets'].append(dict(original['assets'][0],listing_id='US:GAMMA',market='US',currency='USD'))
p['context']['parameters']['weights']={'CN:ALPHA':'0.4','HK:BETA':'0.4','US:GAMMA':'0.2'}
p['context']['parameters']['roles']={'CN:ALPHA':'growth','HK:BETA':'defensive','US:GAMMA':'diversifier'}
for row in p['dataset']['observations']:
    if row['listing_id']=='CN:BETA':row.update(listing_id='HK:BETA',unit='HKD')
for s in original['sessions']:
    close=instant(s['close_at']).replace(hour=21);available=stamp(close+timedelta(minutes=1))
    p['dataset']['sessions'].extend([dict(s,market='HK'),dict(s,market='US',close_at=stamp(close),available_at=available)])
    p['context']['decision_times'].append(available)
    quote=deepcopy(next(row for row in original['observations'] if row['listing_id']=='CN:ALPHA' and row['observed_at']==s['close_at']))
    p['dataset']['observations'].append(dict(quote,id='us:'+s['session_date'],listing_id='US:GAMMA',series_key='US:GAMMA',unit='USD',observed_at=stamp(close),published_at=available,ingested_at=available))
    fx_at=stamp(instant(s['close_at'])-timedelta(hours=1));quote.pop('listing_id')
    for currency,value in [('USD','2'),('HKD','0.5')]:
        p['dataset']['observations'].append(dict(quote,id='fx:'+currency+':'+s['session_date'],series_key='FX:'+currency,metric='fx_cny_per_unit',unit='CNY_per_unit_currency',price_basis='not_applicable',value=value,observed_at=fx_at,published_at=fx_at,ingested_at=fx_at))
for s in original['settlements']:p['dataset']['settlements'].extend([dict(s,market='HK'),dict(s,market='US')])
p['context']['decision_times']=sorted(set(at for at in p['context']['decision_times'] if instant(at)<=instant('2015-12-31T15:59:59.999000Z')));add('three_markets',p)
add('ten_years',funded_input(years=10))
print(json.dumps(cases))
`;
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3", ["-c", script],
    { cwd: path.resolve(".."), encoding: "utf8", maxBuffer: 96 * 1024 * 1024, timeout: 240000 });
  assert.equal(child.status, 0, child.stderr); cache = JSON.parse(child.stdout) as Case[]; return cache;
}
function equalEconomics(actual: unknown, expected: unknown, location = "root") {
  if (typeof actual === "string" && typeof expected === "string" && /^-?\d+(?:\.\d+)?$/.test(actual) && /^-?\d+(?:\.\d+)?$/.test(expected)) {
    const delta = new Decimal(actual).minus(expected).abs(), allowed = Decimal.max(1, new Decimal(expected).abs()).times("1e-40");
    assert.ok(delta.lte(allowed), `${location}: ${actual} != ${expected}`); return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, location); actual.forEach((value, index) => equalEconomics(value, expected[index], `${location}[${index}]`)); return;
  }
  if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object") {
    const a = actual as Obj, b = expected as Obj; assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), location);
    Object.keys(a).forEach(key => equalEconomics(a[key], b[key], location + "." + key)); return;
  }
  assert.equal(actual, expected, location);
}
function seal(object: Obj) { const { result_hash: ignored, ...body } = object; void ignored; object.result_hash = hash(body); }

for (const name of ["flat", "same_day_cents", "drawdown_new_principal", "sales_cash_dependencies", "cross_year_actions", "fx_costs", "reconstructed", "missing_prices",
  "ny_calendar", "fictional_actual_replay", "late_revision", "three_markets", "ten_years"]) {
  test(`independent continuous economics and every causal event: ${name}`, () => {
    const sample = fixtures().find(row => row.name === name)!, before = structuredClone(sample.input);
    const independent = replayFundedHistoryEconomics(sample.input, { allowSynthetic: true });
    for (const key of ["immediate", "staged"] as const) {
      equalEconomics(independent.paths[key].trace, sample.traces[key], key);
      const baseline = runContinuousEconomics(independent.input.dataset as unknown as ContinuousDataset, independent.input.plan as unknown as ContinuousPlan,
        fundedPathReleases(independent.projection, key), { holdingBaseline: true });
      equalEconomics(baseline, sample.baselines[key], key + ".baseline");
      assert.ok(!baseline.events.some(row => row.type === "simulated_sell" || row.type === "sale_cash_settlement"));
      assert.equal(baseline.engine_version, "continuous-hold-new-cash-v1");
      assert.equal(baseline.ending_nav_cny, analyzeFundedTrace(baseline, independent.projection.evaluation_timezone).summary.ending_nav_cny);
      for (const row of baseline.curve) assert.ok(new Decimal(row.cash_cny as string).gte(row.locked_cash_cny as string));
    }
    const verified = verifyFundedHistoryEconomics(sample.input, sample.result, { allowSynthetic: true });
    assert.equal(verified.economics_independently_replayed, true); assert.equal(verified.publication_eligible, false);
    assert.equal(verified.engine_trace_hash_independently_certified, false); assert.equal(verified.live_advice_eligible, false);
    assert.deepEqual(sample.input, before);
    if (name === "cross_year_actions") for (const path of Object.values(independent.paths)) {
      assert.ok(path.trace.events.some(row => row.type === "split")); assert.ok(path.trace.events.some(row => row.type === "dividend_payment"));
    }
    if (name === "sales_cash_dependencies") assert.ok(independent.paths.immediate.trace.events.some(row => row.type === "sale_cash_settlement"));
    if (name === "drawdown_new_principal") assert.ok(new Decimal(independent.paths.immediate.trace.max_drawdown!).lt(0));
    if (name === "ten_years") {
      const run = independent.paths.staged.summary;
      assert.equal(run.profit_cny, "0"); assert.equal(run.principal_cny, "4200"); assert.equal((run.annual as unknown[]).length, 10);
      assert.equal((run.monthly as unknown[]).length, 120); assert.equal(run.ending_locked_cash_cny, "200");
      const analysis = analyzeFundedTrace(independent.paths.staged.trace, independent.projection.evaluation_timezone);
      assert.equal(analysis.monthly.length, 120); assert.deepEqual(analysis.rolling.map(row => row.window_count), [108, 84, 60]);
      assert.ok(analysis.rolling.every(row => row.negative_count === 0 && row.negative_fraction === "0"));
    }
    if (name === "three_markets") assert.deepEqual(Object.keys(independent.paths.immediate.trace.positions).sort(), ["CN:ALPHA", "HK:BETA", "US:GAMMA"]);
  });
}

test("self-sealed wrong economic summaries cannot pass independent replay", () => {
  const sample = fixtures().find(row => row.name === "fx_costs")!;
  const mutations = [
    (run: Obj) => { run.ending_nav_cny = new Decimal(run.ending_nav_cny as string).plus("0.01").toFixed(); run.profit_cny = new Decimal(run.profit_cny as string).plus("0.01").toFixed(); },
    (run: Obj) => { run.fees_cny = "0"; }, (run: Obj) => { run.fx_fees_cny = "0"; }, (run: Obj) => { run.slippage_cny = "0"; },
    (run: Obj) => { run.cash_rounding_cny = "999"; }, (run: Obj) => { run.twr = "0.25"; }, (run: Obj) => { run.max_drawdown = "0"; },
    (run: Obj) => { run.annualized_unit_return = "0.10"; }, (run: Obj) => { run.ending_cash_ratio = "1"; },
    (run: Obj) => { (run.xirr as Obj).rate = "0.30"; }, (run: Obj) => { (run.xirr as Obj).duration_days = 100; },
    (run: Obj) => { (run.event_counts as Obj).simulated_buy = 0; }, (run: Obj) => { (run.ending_positions as Obj)["CN:ALPHA"] = "0"; },
    (run: Obj) => { (run.monthly as Obj[])[0].nav_cny = "9999"; }, (run: Obj) => { (run.annual as Obj[])[0].unit_nav = "2"; },
    (run: Obj) => { run.execution_failure_count = Number(run.execution_failure_count) + 1; },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(sample.result); mutate(altered.comparison.runs.immediate); seal(altered.comparison); seal(altered);
    assert.throws(() => verifyFundedHistoryEconomics(sample.input, altered, { allowSynthetic: true }), /INVESTOR_FUNDED_HISTORY_(?:ECONOMICS_)?INVALID/);
  }
});

test("full-window daily diagnostics compare one cashflow path without certifying an ex-post holding baseline", () => {
  const sample = fixtures().find(row => row.name === "sales_cash_dependencies")!, before = structuredClone(sample.input);
  const data = analyzeFundedHistory(sample.input, sample.result, "immediate", { allowSynthetic: true });
  assert.equal(data.candidate_summary_verified, true); assert.equal(data.baseline_preregistered, false);
  assert.equal(data.candidate.summary.principal_cny, data.baseline.summary.principal_cny);
  assert.ok(data.candidate.full_observation_count > data.candidate.daily.length);
  assert.equal(data.candidate.daily.at(-1)!.at, data.window.end);
  assert.deepEqual(data.candidate.monthly.map(row => row.period), Array.from({ length: 12 }, (_, i) => `2015-${String(i + 1).padStart(2, "0")}`));
  assert.ok(data.candidate.rolling.every(row => row.status === "insufficient_history"));
  assert.deepEqual(sample.input, before);
  assert.throws(() => analyzeFundedHistory(sample.input, sample.result, "immediate"), /SYNTHETIC_FORBIDDEN/);
});

test("default synthetic denial, explicit opaque trace boundary and exact microsecond roundtrips", () => {
  const sample = fixtures()[0]; assert.throws(() => replayFundedHistoryEconomics(sample.input), /SYNTHETIC_FORBIDDEN/);
  const changed = structuredClone(sample.result); changed.comparison.runs.immediate.engine_trace_hash = "a".repeat(64); seal(changed.comparison); seal(changed);
  const result = verifyFundedHistoryEconomics(sample.input, changed, { allowSynthetic: true });
  assert.equal(result.engine_trace_hash_independently_certified, false); assert.equal(result.publication_eligible, false);
  for (const at of ["1969-12-31T15:59:59.999999Z", "2015-01-01T07:00:00.000001Z", "2026-10-08T00:00:00.999999Z"])
    assert.equal(economicStamp(economicInstant(at)), at);
  assert.equal(economicDate(-1n, "UTC"), "1969-12-31");
});

test("invalid dataset semantics are rejected instead of repaired by the second engine", () => {
  const sample = fixtures()[0];
  const mutations = [(p: FundedHistoryInput) => { p.dataset.assets = [...p.dataset.assets as unknown[], (p.dataset.assets as unknown[])[0]]; },
    (p: FundedHistoryInput) => { (p.dataset.sessions as Obj[])[0].session_date = "2015-01-02"; },
    (p: FundedHistoryInput) => { (p.dataset.settlements as Obj[])[0].published_at = "2025-01-01T00:00:00Z"; },
    (p: FundedHistoryInput) => { (p.dataset.observations as Obj[])[0].unit = "USD"; },
    (p: FundedHistoryInput) => { (p.dataset.observations as Obj[])[0].assumed_available_at = (p.dataset.observations as Obj[])[0].published_at; },
    (p: FundedHistoryInput) => { p.context.parameters.roles = { "CN:ALPHA": "growth" }; },
    (p: FundedHistoryInput) => { p.dataset.corporate_actions_complete = false; }];
  for (const mutate of mutations) { const changed = structuredClone(sample.input); mutate(changed); assert.throws(() => replayFundedHistoryEconomics(changed, { allowSynthetic: true })); }
});

test("stale FX and conflicting visible revisions fail after holdings exist instead of reusing old NAV", () => {
  const fx = structuredClone(fixtures().find(row => row.name === "fx_costs")!.input);
  fx.context.execution.max_fx_age_seconds = 86400;
  fx.dataset.observations = (fx.dataset.observations as Obj[]).filter(row => row.metric !== "fx_cny_per_unit" || (row.observed_at as string) < "2015-01-05");
  assert.throws(() => replayFundedHistoryEconomics(fx, { allowSynthetic: true }), /STALE_RESEARCH_FX/);
  const ambiguous = structuredClone(fixtures()[0].input), observations = ambiguous.dataset.observations as Obj[];
  const quote = observations.find(row => row.listing_id === "CN:ALPHA" && (row.observed_at as string).startsWith("2015-01-03"))!;
  observations.push({ ...quote, id: "fictional-conflict", revision_id: "2", value: "11" });
  assert.throws(() => replayFundedHistoryEconomics(ambiguous, { allowSynthetic: true }), /AMBIGUOUS_RESEARCH_PRICE_REVISION/);
});
