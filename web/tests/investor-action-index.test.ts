import assert from "node:assert/strict";
import test from "node:test";
import { runContinuousEconomics } from "../src/server/investor/continuous-economics";
import { actionIndexFixture } from "./investor-action-index-fixture";
import { hash } from "../src/server/ledger/service";

const legacyHashes = [
  "4aefb721403cdffc327595b14b6f2b2b3a05e5ae6713da7a167855a99a793c94",
  "97f3ae700d4f9ec245789f017e4859a252cbc806475f0c182cea880ae5578d2c",
  "a7ecbeb97faac1aa1d0c6604faf3ae3d9cfabd66ab284b6c0449a62b22300e8f",
  "ea70824a81f5546ea7ffc5b1a6ff2b73ead0d4976a43ddce6432b53c79610c96",
];

for (const version of [1, 2, 3, 4]) test(`complete action trace matches frozen pre-index v${version} engine`, () => {
  const { data, plan, releases } = actionIndexFixture(version), before = structuredClone({ data, plan });
  const result = runContinuousEconomics(data, plan, releases, { researchPhase: "train" });
  assert.equal(hash(result), legacyHashes[version - 1]);
  assert.equal(result.curve.length, 198);
  assert.deepEqual({ data, plan }, before);
});

test("one replay indexes actions once instead of rescanning the complete action history at every valuation", () => {
  const { data, plan, releases } = actionIndexFixture();
  const before = structuredClone({ data, plan });
  let fullScans = 0;
  Object.defineProperty(data.actions, "filter", { value: function(predicate: (value: unknown) => boolean) {
    fullScans++;
    return Array.prototype.filter.call(this, predicate);
  } });
  const result = runContinuousEconomics(data, plan, releases, { researchPhase: "train" });
  assert(result.events.some(row => row.type === "split"));
  assert(result.events.some(row => row.type === "dividend_payment"));
  assert.equal(fullScans, 0, "all-listing action filtering belongs in neither daily marks nor order reviews");
  assert.deepEqual({ data, plan }, before);
});

test("action interval excludes the observed quote boundary, includes the ex-time, and orders same-time splits first", () => {
  const { data, plan, releases } = actionIndexFixture();
  const sameClose = runContinuousEconomics(data, plan, releases, { researchPhase: "train" });
  assert.deepEqual(sameClose.curve.find(row => row.at === "2016-01-22T06:00:00.000000Z")!.derived_carry_marks, []);
  for (const row of data.actions) if (["split:alpha", "dividend:CN:ALPHA:21", "dividend:CN:BETA:21"].includes(row.id))
    row.at = "2016-01-22T05:00:00Z";
  const result = runContinuousEconomics(data, plan, releases, { researchPhase: "train" });
  const beforePublication = result.curve.find(row => row.at === "2016-01-22T05:00:00.000000Z")!;
  const freshQuote = result.curve.find(row => row.at === "2016-01-22T06:00:00.000000Z")!;
  const marks = beforePublication.derived_carry_marks as { listing_id: string; action_ids: string[] }[];
  assert.deepEqual(marks.find(row => row.listing_id === "CN:ALPHA")!.action_ids, ["split:alpha", "dividend:CN:ALPHA:21"]);
  assert.deepEqual(marks.find(row => row.listing_id === "CN:BETA")!.action_ids, ["dividend:CN:BETA:21"]);
  assert.deepEqual(freshQuote.derived_carry_marks, []);
  data.actions.reverse();
  const reversed = runContinuousEconomics(data, plan, releases, { researchPhase: "train" });
  assert.deepEqual(reversed.events, result.events);
  assert.deepEqual(reversed.curve, result.curve);
});

test("indexes are rebuilt for each invocation and still validate missing or invalid action facts", () => {
  const { data, plan, releases } = actionIndexFixture();
  const original = structuredClone(data);
  const first = runContinuousEconomics(data, plan, releases, { researchPhase: "train" });
  data.actions[0].gross_per_unit = "0.2";
  assert.notEqual(hash(runContinuousEconomics(data, plan, releases, { researchPhase: "train" })), hash(first));
  data.actions = structuredClone(original.actions);
  assert.equal(hash(runContinuousEconomics(data, plan, releases, { researchPhase: "train" })), hash(first));
  for (const change of [{ listing_id: "CN:FOREIGN" }, { at: "2016-02-30T06:00:00Z" },
    { published_at: "2017-01-01T00:00:00Z" }, { pay_at: "2015-01-01T00:00:00Z" }]) {
    data.actions = structuredClone(original.actions);
    Object.assign(data.actions[0], change);
    assert.throws(() => runContinuousEconomics(data, plan, releases, { researchPhase: "train" }));
  }
  data.actions = [];
  const empty = runContinuousEconomics(data, plan, releases, { researchPhase: "train" });
  assert(!empty.events.some(row => row.type === "split" || row.type === "dividend_payment"));
});

test("actual replay still rejects action facts learned after their effective time", () => {
  const { data, plan, releases } = actionIndexFixture();
  data.mode = "actual_replay";
  for (const row of data.observations) row.provenance = "live_observed";
  for (const row of data.actions) row.ingested_at = row.published_at;
  for (const row of data.settlements) row.ingested_at = row.published_at;
  assert.doesNotThrow(() => runContinuousEconomics(data, plan, releases, { researchPhase: "train" }));
  data.actions[0].ingested_at = "2017-01-01T00:00:00Z";
  assert.throws(() => runContinuousEconomics(data, plan, releases, { researchPhase: "train" }));
});
