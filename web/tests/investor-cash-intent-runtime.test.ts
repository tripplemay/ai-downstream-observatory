import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { runContinuousEconomics, type ContinuousPlan, type ContinuousParameters } from "../src/server/investor/continuous-economics";
import type { ContinuousDataset } from "../src/server/investor/continuous-market";

test("independent Web v6 execution reconstructs complete fictional sale/settlement/buy and action lineage", () => {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
    "import json; from tests.research.cash_intent_fixtures import vectors; print(json.dumps(vectors()))"],
    { cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  const vectors = JSON.parse(child.stdout) as Array<{ kind: string; dataset: ContinuousDataset;
    plan: Record<string, unknown> & { windows: { train: { start: string; end: string } } }; parameters: ContinuousParameters; result: unknown }>;
  assert.equal(vectors.length, 10);
  for (const vector of vectors) {
    const { windows, hypothesis, falsification, parameter_candidates, trial_budgets, benchmark, evidence_requirements, ...rest } = vector.plan;
    const plan = { ...rest, schema_version: "bounded-research-window-v4", parameters: vector.parameters, window: windows.train } as ContinuousPlan;
    const before = JSON.stringify({ data: vector.dataset, plan });
    const result = runContinuousEconomics(vector.dataset, plan, new Map(), { researchPhase: "train" });
    assert.deepEqual(result, vector.result, vector.kind);
    assert.equal(JSON.stringify({ data: vector.dataset, plan }), before);
  }
});
