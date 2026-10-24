import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { replayBoundedComparison, type BoundedResearchPlan } from "../src/server/investor/bounded-research";
import type { ContinuousDataset } from "../src/server/investor/continuous-market";
import type { ContinuousParameters } from "../src/server/investor/continuous-economics";

type Vector = { kind: string; input: { dataset: ContinuousDataset; plan: BoundedResearchPlan; parameters: ContinuousParameters; phase: "train" }; result: unknown };
const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
  "import json; from tests.research.event_review_fixtures import vectors; print(json.dumps(vectors()))"], {
  cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024,
});
assert.equal(child.status, 0, child.stderr);
const vectors: Vector[] = JSON.parse(child.stdout);

test("v5 independent full replay retains original cancellations, generations, settled funding and terminal failures", () => {
  for (const { input, result, kind } of vectors)
    assert.deepEqual(replayBoundedComparison(input.dataset, input.plan, input.parameters, input.phase), result, kind);
});
