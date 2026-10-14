import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { replayLongportProjection } from "../src/server/market-price-source";

const fixtureScript = String.raw`
import json
from tests.market.test_longport_duplicate_projection import projection
from tests.market.test_longport_provider import candle
value=projection([candle(),candle(),candle('2025-06-06')])
print(json.dumps({'projection':value['projection'],'records':value['records'],'digest':value['projection_sha256']}))
`;
function fixture() {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.PYTHON ?? "python3", ["-c", fixtureScript],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", maxBuffer: 65536 }));
}
function replay(projection: ReturnType<typeof fixture>["projection"]) {
  const { mapping, expected_dates, start_date, end_date } = projection.request;
  return replayLongportProjection(projection, mapping, expected_dates, { start_date, end_date });
}
test("independent Web replay agrees with Python v2 hash, raw repeat rows and first-row provenance", () => {
  const value = fixture(), result = replay(value.projection);
  assert.equal(result.digest, value.digest); assert.deepEqual(result.records, value.records);
  assert.equal(value.projection.candlesticks.length, 3); assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map(row => row.projection_row), [0, 2]);
});
test("self-rehashed duplicate metadata cannot change counts, first-row evidence or acceptance policy", () => {
  const value = fixture();
  for (const [key, changed] of [["raw_record_count", 2], ["unique_record_count", 3],
    ["duplicate_rows", [{ row: 1, first_row: 2 }]], ["duplicate_bar_policy", "last_wins"]] as const) {
    const projection = structuredClone(value.projection); projection.source[key] = changed;
    assert.throws(() => replay(projection), /PRICE_PROVIDER_EVIDENCE_INVALID/);
  }
  const legacy = structuredClone(value.projection); legacy.schema_version = "longport-candles-projection-v1";
  assert.throws(() => replay(legacy), /PRICE_PROVIDER_EVIDENCE_INVALID/);
});
test("same market day or same close is insufficient when any other SDK field conflicts", () => {
  const value = fixture();
  for (const [key, changed] of [["close", "10"], ["open", "10.01"], ["high", "12"], ["low", "8"],
    ["turnover", "106"], ["volume", "9007199254740994"], ["timestamp", "2025-06-05T20:00:01.123456Z"],
    ["trade_session", 1], ["open", "10.00000"]] as const) {
    const projection = structuredClone(value.projection); projection.candlesticks[1][key] = changed;
    assert.throws(() => replay(projection), /PRICE_PROVIDER_EVIDENCE_INVALID/);
  }
});
test("repeated rows cannot fill a missing date and v2 cannot be asserted without duplicates", () => {
  const value = fixture(), missing = structuredClone(value.projection); missing.candlesticks.pop();
  assert.throws(() => replay(missing), /PRICE_PROVIDER_EVIDENCE_INVALID/);
  const empty = structuredClone(value.projection); empty.candlesticks.splice(1, 1);
  assert.throws(() => replay(empty), /PRICE_PROVIDER_EVIDENCE_INVALID/);
});
