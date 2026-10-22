import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { Decimal } from "../src/server/ledger/decimal";
import { hash } from "../src/server/ledger/service";
import { prepareFundedHistory, verifyFundedHistoryBinding, type FundedHistoryInput } from "../src/server/investor/funded-history";
import { replayFundedHistoryEconomics, verifyFundedHistoryEconomics, fundedPathReleases } from "../src/server/investor/funded-history-economics";
import { runContinuousEconomics, type ContinuousPlan } from "../src/server/investor/continuous-economics";
import type { ContinuousDataset } from "../src/server/investor/continuous-market";
import { analyzeFundedHistory } from "../src/server/investor/funded-analysis-math";

type Obj = Record<string, unknown>;
type Vector = { name: string; input: FundedHistoryInput; prepared: unknown; result: Obj & { comparison: Obj & { runs: Record<string, Obj> } };
  traces: Record<string, Obj>; baselines: Record<string, Obj> };
let cache: Vector[] | undefined;
function vectors() {
  if (!cache) {
    const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3", ["-c",
      "import json; from tests.investor.bounded_funding_fixtures import cases,vector; print(json.dumps([vector(k,v) for k,v in cases().items()]))"],
    { cwd: path.resolve(".."), encoding: "utf8", maxBuffer: 96 * 1024 * 1024, timeout: 240000 });
    assert.equal(child.status, 0, child.stderr); cache = JSON.parse(child.stdout);
  }
  return cache!;
}
function equalEconomics(actual: unknown, expected: unknown, location = "root") {
  if (typeof actual === "string" && typeof expected === "string" && /^-?\d+(?:\.\d+)?$/.test(actual) && /^-?\d+(?:\.\d+)?$/.test(expected)) {
    const tolerance = Decimal.min("1e-12", Decimal.max(1, new Decimal(expected).abs()).times("1e-40"));
    assert.ok(new Decimal(actual).minus(expected).abs().lte(tolerance), `${location}: ${actual} != ${expected}`); return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, location);
    actual.forEach((row, index) => equalEconomics(row, expected[index], `${location}[${index}]`)); return;
  }
  if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object") {
    const a = actual as Obj, b = expected as Obj;
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), location);
    Object.keys(a).forEach(key => equalEconomics(a[key], b[key], location + "." + key)); return;
  }
  assert.equal(actual, expected, location);
}
function seal(value: Obj) { const { result_hash: ignored, ...body } = value; void ignored; value.result_hash = hash(body); }

for (const name of ["flat", "same_day_cents", "price_breach", "sale_dependencies", "pending_action", "foreign_fx_breach_costs", "cross_year_actions", "ten_years"]) {
  test(`bounded annual funding independently replays complete Python traces and hold-new-cash baseline: ${name}`, () => {
    const sample = vectors().find(row => row.name === name)!, before = structuredClone(sample.input);
    assert.deepEqual(prepareFundedHistory(sample.input), sample.prepared);
    const independent = replayFundedHistoryEconomics(sample.input, { allowSynthetic: true });
    for (const key of ["immediate", "staged"] as const) {
      equalEconomics(independent.paths[key].trace, sample.traces[key], key);
      const baseline = runContinuousEconomics(independent.input.dataset as unknown as ContinuousDataset, independent.input.plan as unknown as ContinuousPlan,
        fundedPathReleases(independent.projection, key), { holdingBaseline: true });
      equalEconomics(baseline, sample.baselines[key], key + ".baseline");
      assert.equal(baseline.engine_version, "continuous-bounded-hold-new-cash-v1");
      assert.ok(!baseline.events.some(row => row.type === "simulated_sell"));
      assert.equal(independent.paths[key].trace.engine_version, "continuous-bounded-fixed-policy-funding-v1");
      for (const row of independent.paths[key].trace.curve) {
        assert.ok(new Decimal(row.cash_cny as string).gte(row.locked_cash_cny as string));
        assert.ok(new Decimal(row.unreserved_released_cash_cny as string).gte(0));
      }
    }
    const checked = verifyFundedHistoryEconomics(sample.input, sample.result, { allowSynthetic: true });
    assert.equal(checked.verification_version, "funded-history-economic-replay-v2");
    assert.equal(checked.economics_independently_replayed, true); assert.equal(checked.publication_eligible, false);
    assert.equal(checked.actual_arrivals_confirmed, false); assert.equal(checked.live_advice_eligible, false);
    assert.deepEqual(sample.input, before);
    if (name.includes("breach")) for (const path of Object.values(independent.paths))
      assert.ok(path.trace.events.some(row => row.type === "execution_skipped" && row.reason === "EXECUTION_PRICE_OR_FX_BOUND_EXCEEDED"));
    if (name === "sale_dependencies") assert.ok(independent.paths.immediate.trace.events.some(row => row.type === "sale_cash_settlement"));
    if (name === "pending_action") for (const path of Object.values(independent.paths))
      assert.ok(path.trace.events.some(row => row.type === "execution_skipped" && row.reason === "CORPORATE_ACTION_INVALIDATES_FROZEN_ORDER"));
    if (name === "cross_year_actions") for (const path of Object.values(independent.paths)) {
      assert.ok(path.trace.events.some(row => row.type === "split")); assert.ok(path.trace.events.some(row => row.type === "dividend_payment"));
    }
    if (name === "ten_years") {
      const analysis = analyzeFundedHistory(sample.input, sample.result, "staged", { allowSynthetic: true });
      assert.equal(analysis.candidate.summary.principal_cny, "4200");
      assert.equal(analysis.candidate.summary.profit_cny, "0");
      assert.equal(analysis.candidate.monthly.length, 120);
      assert.equal(analysis.candidate.summary.execution_failure_count, 0);
    }
  });
}

test("bounded funding never supplies missing buffers, accepts legacy resealing or trusts self-sealed wrong economics", () => {
  const sample = vectors()[0];
  for (const key of ["buy_price_buffer_bps", "buy_fx_buffer_bps"]) {
    const input = structuredClone(sample.input); delete input.context.execution[key];
    assert.throws(() => prepareFundedHistory(input), /INVESTOR_FUNDED_HISTORY_INVALID/);
  }
  for (const mutate of [(result: typeof sample.result) => { result.schema_version = "investor-funded-history-result-v1"; },
    (result: typeof sample.result) => { result.comparison.schema_version = "investor-long-horizon-result-v2"; },
    (result: typeof sample.result) => { result.comparison.runs.immediate.engine_version = "continuous-fixed-policy-funding-v1"; },
    (result: typeof sample.result) => { result.comparison.runs.immediate.profit_cny = "10"; result.comparison.runs.immediate.ending_nav_cny = "1510"; }]) {
    const result = structuredClone(sample.result); mutate(result); seal(result.comparison); seal(result);
    assert.throws(() => verifyFundedHistoryEconomics(sample.input, result, { allowSynthetic: true }));
  }
  const relabelled = structuredClone(sample.result);
  relabelled.schema_version = "investor-funded-history-result-v1";
  relabelled.comparison.schema_version = "investor-long-horizon-result-v2";
  for (const run of Object.values(relabelled.comparison.runs)) run.engine_version = "continuous-fixed-policy-funding-v1";
  seal(relabelled.comparison); seal(relabelled);
  assert.throws(() => verifyFundedHistoryBinding(sample.input, relabelled), /INVESTOR_FUNDED_HISTORY_INVALID/);
  const input = structuredClone(sample.input); input.context.execution.buy_price_buffer_bps = "500";
  const wrong = structuredClone(sample.result), prepared = prepareFundedHistory(input);
  wrong.input_hash = hash(input); wrong.comparison.input_hash = hash(prepared.input); wrong.comparison.plan_hash = hash(prepared.input.plan);
  seal(wrong.comparison); seal(wrong);
  assert.throws(() => verifyFundedHistoryEconomics(input, wrong, { allowSynthetic: true }), /ECONOMICS_INVALID/);
});
