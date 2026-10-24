import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { hash } from "../src/server/ledger/service";
import { prepareFundedHistory, type FundedHistoryInput } from "../src/server/investor/funded-history";
import { verifyFundedHistoryEconomics } from "../src/server/investor/funded-history-economics";

const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
  "import json; from tests.investor.event_review_funding_fixtures import vectors; print(json.dumps(vectors()))"], {
  cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024,
});
assert.equal(child.status, 0, child.stderr);
const vectors: { name: string; input: FundedHistoryInput; result: Record<string, unknown>; prepared: unknown }[] = JSON.parse(child.stdout);

test("continuous v4 and funded v3 independently verify full economics, review counts and exact lineage hashes", () => {
  for (const row of vectors) {
    assert.deepEqual(prepareFundedHistory(row.input), row.prepared, row.name);
    assert.equal(verifyFundedHistoryEconomics(row.input, row.result, { allowSynthetic: true }).economics_independently_replayed, true);
  }
});

test("resealed success cannot erase unresolved gaps or forge review lineage", () => {
  const row = vectors.find(row => row.name === "pending_action")!;
  for (const key of ["order_review_lineage_hash", "corporate_action_cancellation_count", "terminal_execution_failure_count"]) {
    const forged = structuredClone(row.result) as Record<string, any>;
    forged.comparison.runs.immediate[key] = key.endsWith("hash") ? "0".repeat(64) : 999;
    const seal = (value: Record<string, any>) => { const { result_hash: ignored, ...body } = value; void ignored; value.result_hash = hash(body); };
    seal(forged.comparison); seal(forged);
    assert.throws(() => verifyFundedHistoryEconomics(row.input, forged, { allowSynthetic: true }), /ECONOMICS_INVALID|LINEAGE_INVALID/);
  }
});
