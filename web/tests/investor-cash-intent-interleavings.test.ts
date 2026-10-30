import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { runContinuousEconomics, type ContinuousParameters, type ContinuousPlan } from "../src/server/investor/continuous-economics";
import type { ContinuousDataset } from "../src/server/investor/continuous-market";
import { fundedPathReleases, verifiedFundedHistoryReplay } from "../src/server/investor/funded-history-economics";
import { Decimal } from "../src/server/ledger/decimal";
import { hash } from "../src/server/ledger/service";

type Vector = { kind: string; dataset: ContinuousDataset; plan: Record<string, unknown> & { windows: { train: { start: string; end: string } } };
  parameters: ContinuousParameters; result: unknown };
let cache: Vector[] | undefined;
function vectors() {
  if (cache) return cache;
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
    "import json; from tests.research.cash_intent_interleavings import vectors; print(json.dumps(vectors()))"],
    { cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  cache = JSON.parse(child.stdout); assert.equal(cache!.length, 6); return cache!;
}

test("annual partial release during sale settlement preserves locked cash, cash binding and later funding trigger", () => {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
    "import json; from tests.investor.settled_funding_fixtures import release_during_settlement_case; from tests.investor.bounded_funding_fixtures import vector; print(json.dumps(vector('release_during_settlement',release_during_settlement_case())))"],
    { cwd: path.resolve(".."), encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  const row = JSON.parse(child.stdout), { independent } = verifiedFundedHistoryReplay(row.input, row.result, { allowSynthetic: true });
  for (const name of ["immediate", "staged"] as const) {
    const trace = independent.paths[name].trace;
    for (const key of ["events", "cash_intents", "cash_intent_lineage_hash", "order_reviews", "order_review_lineage_hash", "curve", "positions",
      "ending_cash", "ending_receivables", "ending_unsettled_positions"]) assert.deepEqual(trace[key as keyof typeof trace], row.traces[name][key], `${name}/${key}`);
    const baseline = runContinuousEconomics(independent.input.dataset as unknown as ContinuousDataset, independent.input.plan as unknown as ContinuousPlan,
      fundedPathReleases(independent.projection, name), { holdingBaseline: true });
    for (const key of ["events", "curve", "cash_intents", "cash_intent_lineage_hash", "ending_cash", "positions"])
      assert.deepEqual(baseline[key as keyof typeof baseline], row.baselines[name][key], `${name}/baseline/${key}`);
  }
  const trace = independent.paths.staged.trace;
  const publication = trace.events.find(event => event.type === "cash_intent_buy_published")!;
  const receipt = publication.preparation as Record<string, string>, point = trace.curve.find(point => point.at === publication.at)!;
  assert.equal(point.locked_cash_cny, "200");
  assert.equal(receipt.cash_snapshot_hash, hash({ as_of: publication.at, settled_cny: point.cash_cny, reserved_cny: "0", floor_cny: "200" }));
  assert.equal(receipt.available_cash_cny, new Decimal(point.cash_cny as string).minus(200).toFixed());
  assert.ok(trace.events.some(event => (event.at as string) > (publication.at as string) && (event.trigger_codes as string[] | undefined)?.includes("NEW_CASH_REPAIR")));
  assert.equal(trace.contributions_cny, "300"); assert.equal(trace.failed_cash_intent_count, 0);
});

for (const kind of ["repeated_sale_actions", "partial_sale_wait", "partial_sale_action", "late_sale_settlement", "minimum_lot", "fees"]) {
  test(`complete independent v6 execution and preserved lineage: ${kind}`, () => {
    const vector = vectors().find(row => row.kind === kind)!;
    const { windows, hypothesis, falsification, parameter_candidates, trial_budgets, benchmark, evidence_requirements, ...rest } = vector.plan;
    const plan = { ...rest, schema_version: "bounded-research-window-v4", parameters: vector.parameters, window: windows.train } as ContinuousPlan;
    const before = JSON.stringify({ data: vector.dataset, plan });
    assert.deepEqual(runContinuousEconomics(vector.dataset, plan, new Map(), { researchPhase: "train" }), vector.result, kind);
    assert.equal(JSON.stringify({ data: vector.dataset, plan }), before);
  });
}
