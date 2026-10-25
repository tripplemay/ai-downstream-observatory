import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { prepareSettledCashBuys } from "../src/server/investor/settled-funding";
import { Decimal as LedgerDecimal } from "../src/server/ledger/decimal";

const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c",
  "import json; from tests.research.settled_funding_fixtures import preparation_vectors; print(json.dumps(preparation_vectors()))"],
  { cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
assert.equal(child.status, 0, child.stderr);
const vectors: Array<{ kind: string; input: Record<string, unknown>; result: { prepared?: unknown; blocked?: string } }> = JSON.parse(child.stdout);

test("independent settled-cash preparation matches every declared numerical and failure vector without mutation", () => {
  assert.equal(LedgerDecimal.precision, 60);
  assert.equal(vectors.length, 36);
  for (const vector of vectors) {
    const before = JSON.stringify(vector.input);
    if (vector.result.blocked) assert.throws(() => prepareSettledCashBuys(vector.input), error => error instanceof Error && error.message === vector.result.blocked, vector.kind);
    else assert.deepEqual(prepareSettledCashBuys(vector.input), vector.result.prepared, vector.kind);
    assert.equal(JSON.stringify(vector.input), before);
    assert.equal(LedgerDecimal.precision, 60);
  }
});
test("smaller and larger settled receipts create new orders rather than resizing or retrying a previous buy", () => {
  for (const [kind, expected] of [["smaller_sale", "29"], ["larger_sale", "28"]]) {
    const input = vectors.find(v => v.kind === kind)!.input;
    const result = prepareSettledCashBuys(input);
    assert.equal(result.orders[0].quantity, expected); assert.equal(result.orders[0].order_id, "fictional-new-buy:1");
    assert.equal(result.published, false); assert.equal(result.live_advice_eligible, false);
  }
});
