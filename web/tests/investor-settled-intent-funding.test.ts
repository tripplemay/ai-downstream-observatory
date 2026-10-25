import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { hash } from "../src/server/ledger/service";
import { prepareFundedHistory, type FundedHistoryInput } from "../src/server/investor/funded-history";
import { fundedCashIntentReview, fundedExecutionReview, fundedPathReleases, verifiedFundedHistoryReplay } from "../src/server/investor/funded-history-economics";
import { analyzeFundedTrace } from "../src/server/investor/funded-analysis-math";
import { fundedComparisonPathSchema, fundedPathExecutionUsable } from "../src/server/investor/funded-comparison-schemas";
import { runContinuousEconomics, type ContinuousPlan } from "../src/server/investor/continuous-economics";
import type { ContinuousDataset } from "../src/server/investor/continuous-market";

const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
  "import json; from tests.investor.settled_funding_fixtures import vectors; print(json.dumps(vectors()))"], {
  cwd: path.resolve(".."), encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024,
});
assert.equal(child.status, 0, child.stderr);
const vectors: { name: string; input: FundedHistoryInput; result: Record<string, any>; prepared: unknown;
  traces: Record<string, Record<string, any>>; baselines: Record<string, Record<string, any>> }[] = JSON.parse(child.stdout);
assert.equal(vectors.length, 5);

test("annual v5/funded v4 preserve policy and independently reconstruct intent, execution and holding-baseline lineage", () => {
  for (const row of vectors) {
    assert.deepEqual(prepareFundedHistory(row.input), row.prepared, row.name);
    const { verification, independent } = verifiedFundedHistoryReplay(row.input, row.result, { allowSynthetic: true });
    assert.equal(verification.verification_version, "funded-history-economic-replay-v4");
    for (const name of ["immediate", "staged"] as const) {
      const trace = independent.paths[name].trace, expected = row.traces[name];
      if (name === "immediate" && ["sale_settlement", "three_markets"].includes(row.name)) {
        const intents = trace.cash_intents as { state: string; declaration: { sale_order_ids: string[] } }[];
        assert.ok(intents.length > 0); assert.ok(intents.every(row => row.state === "resolved"));
        if (row.name === "three_markets") {
          assert.ok(intents.some(row => row.declaration.sale_order_ids.length === 2));
          assert.deepEqual(Object.keys(trace.positions).sort(), ["CN:ALPHA", "HK:BETA", "US:GAMMA"]);
        }
      }
      for (const key of ["events", "orders", "cash_intents", "cash_intent_lineage_hash", "pending_cash_intent_count", "failed_cash_intent_count",
        "order_reviews", "order_review_lineage_hash", "positions", "curve"]) assert.deepEqual(trace[key as keyof typeof trace], expected[key], `${row.name}/${name}/${key}`);
      const summary = analyzeFundedTrace(trace, independent.projection.evaluation_timezone).summary;
      assert.equal(summary.execution_review?.schema_version, "execution-review-summary-v2");
      assert.deepEqual(summary.cash_intent_review, fundedCashIntentReview(trace));
      assert.deepEqual(summary.execution_review, fundedExecutionReview(trace));
      assert.equal(fundedPathExecutionUsable(summary), row.result.comparison.runs[name].failed_cash_intent_count === 0
        && row.result.comparison.runs[name].terminal_execution_failure_count === 0 && row.result.comparison.runs[name].unresolved_order_review_count === 0);
      const missing = structuredClone(summary); delete missing.cash_intent_review;
      assert.equal(fundedComparisonPathSchema.safeParse(missing).success, false);
      assert.equal(fundedPathExecutionUsable(missing), false);
      const baseline = runContinuousEconomics(independent.input.dataset as unknown as ContinuousDataset, independent.input.plan as unknown as ContinuousPlan,
        fundedPathReleases(independent.projection, name), { holdingBaseline: true });
      for (const key of ["engine_version", "events", "cash_intents", "cash_intent_lineage_hash", "positions", "curve"])
        assert.deepEqual(baseline[key as keyof typeof baseline], row.baselines[name][key], `${row.name}/${name}/baseline/${key}`);
      const baselineSummary = analyzeFundedTrace(baseline, independent.projection.evaluation_timezone).summary;
      assert.equal(baselineSummary.cash_intent_review?.failed_intents, 0);
      assert.equal(baselineSummary.principal_cny, summary.principal_cny);
    }
  }
});

test("ten-year v6 annual and holding paths retain cumulative principal, units, releases and complete-window diagnostics", () => {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
    "import json; from tests.investor.settled_funding_fixtures import documents; from worker.investor.funded_history import calculate_funded_history; p=documents()['ten_years']; print(json.dumps({'input':p,'result':calculate_funded_history(p,allow_synthetic=True)}))"],
    { cwd: path.resolve(".."), encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  const row = JSON.parse(child.stdout), { independent } = verifiedFundedHistoryReplay(row.input, row.result, { allowSynthetic: true });
  for (const name of ["immediate", "staged"] as const) {
    const trace = independent.paths[name].trace;
    const baseline = runContinuousEconomics(independent.input.dataset as unknown as ContinuousDataset, independent.input.plan as unknown as ContinuousPlan,
      fundedPathReleases(independent.projection, name), { holdingBaseline: true });
    for (const run of [trace, baseline]) {
      assert.equal(run.ending_nav_cny, "4200"); assert.equal(run.contributions_cny, "3000");
      assert.equal(run.profit_cny, "0"); assert.equal(run.curve.at(-1)!.unit_nav, "1");
      const analysis = analyzeFundedTrace(run, independent.projection.evaluation_timezone);
      assert.equal(analysis.monthly.length, 120); assert.equal(analysis.summary.cash_intent_review?.failed_intents, 0);
      assert.deepEqual(analysis.rolling.map(row => row.window_count), [108, 84, 60]);
    }
    assert.equal(trace.curve.at(-1)!.locked_cash_cny, name === "staged" ? "200" : "0");
  }
});

test("zero-order-error orphan cannot be resealed as completed or have its required cash lineage removed", () => {
  const row = vectors.find(row => row.name === "orphan")!;
  assert.equal(row.result.comparison.status, "execution_gaps");
  assert.equal(row.result.comparison.runs.immediate.execution_failure_count, 0);
  assert.equal(row.result.comparison.runs.immediate.failed_cash_intent_count, 1);
  const seal = (value: Record<string, any>) => { const { result_hash: ignored, ...body } = value; void ignored; value.result_hash = hash(body); };
  for (const key of ["failed_cash_intent_count", "pending_cash_intent_count", "cash_intent_lineage_hash"]) {
    const forged = structuredClone(row.result);
    forged.comparison.runs.immediate[key] = key.endsWith("hash") ? "0".repeat(64) : key.startsWith("failed") ? 0 : 1;
    forged.comparison.status = "computed";
    seal(forged.comparison); seal(forged);
    assert.throws(() => verifiedFundedHistoryReplay(row.input, forged, { allowSynthetic: true }), /ECONOMICS_INVALID|LINEAGE_INVALID/);
    delete forged.comparison.runs.immediate[key]; seal(forged.comparison); seal(forged);
    assert.throws(() => verifiedFundedHistoryReplay(row.input, forged, { allowSynthetic: true }));
  }
});
