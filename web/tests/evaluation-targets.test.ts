import assert from "node:assert/strict";
import test from "node:test";
import { compareManualTargets, type TargetMeasurement } from "../src/server/evaluation/targets";

const row = (changes: Partial<TargetMeasurement> = {}): TargetMeasurement => ({ account_id: "synthetic-account", listing_id: "synthetic-etf", currency: "CNY", weight: "0.3",
  settled_quantity: "24", transit_quantity: "0", close: "10", fx_cny: "1", quantity_step: "1", price_step: "0.01", ...changes });
const input = (rows = [row()]) => ({ nav_cny: "800", rows, absolute_tolerance_cny: "0", weight_tolerance: "0", fee_rate_bps: "0", minimum_fee_by_currency: { CNY: "0", USD: "0" } });

test("monthly target comparison is explicit and signed; matching target does not manufacture an order", () => {
  const equal = compareManualTargets(input());
  assert.deepEqual(equal.items, []); assert.deepEqual(equal.blockers, []); assert.equal(equal.comparisons[0].within_tolerance, true);
  assert.equal(equal.comparisons[0].difference_cny, "0");
  const buy = compareManualTargets(input([row({ settled_quantity: "4" })]));
  assert.equal(buy.items[0].quantity, "20"); assert.equal(buy.items[0].side, "buy");
  const sell = compareManualTargets(input([row({ settled_quantity: "44" })]));
  assert.equal(sell.items[0].quantity, "20"); assert.equal(sell.items[0].side, "sell"); assert.equal(sell.comparisons[0].difference_cny, "-200");
});

test("approved maximum absolute-or-NAV tolerance compares unrounded differences", () => {
  const inside = compareManualTargets({ ...input([row({ settled_quantity: "23.3" })]), absolute_tolerance_cny: "6", weight_tolerance: "0.01" });
  assert.equal(inside.comparisons[0].tolerance_cny, "8"); assert.equal(inside.comparisons[0].within_tolerance, true);
  const outside = compareManualTargets({ ...input([row({ settled_quantity: "23.1" })]), absolute_tolerance_cny: "6", weight_tolerance: "0.01" });
  assert.equal(outside.comparisons[0].within_tolerance, false); assert.deepEqual(outside.items, []);
  assert.equal(outside.blockers[0].code, "EVALUATION_DIFFERENCE_BELOW_TRADING_UNIT");
  const tiny = compareManualTargets({ ...input([row({ weight: "0.000000000000000001", settled_quantity: "0" })]), nav_cny: "0.01" });
  assert.equal(tiny.comparisons[0].difference_cny, "0"); assert.equal(tiny.comparisons[0].within_tolerance, false);
  assert.equal(tiny.blockers[0].code, "EVALUATION_DIFFERENCE_BELOW_TRADING_UNIT");
});

test("source-owned transit participates in exposure but cannot become sellable shares", () => {
  const unchanged = compareManualTargets(input([row({ settled_quantity: "4", transit_quantity: "20" })]));
  assert.equal(unchanged.comparisons[0].owned_value_cny, "240"); assert.equal(unchanged.comparisons[0].within_tolerance, true);
  const blocked = compareManualTargets(input([row({ weight: "0", settled_quantity: "4", transit_quantity: "20" })]));
  assert.deepEqual(blocked.items, []); assert.equal(blocked.blockers[0].code, "EVALUATION_IN_TRANSIT_NOT_SELLABLE");
});

test("FX, price/quantity increments and fee floors remain explicit with conservative fee rounding", () => {
  const result = compareManualTargets({ ...input([row({ currency: "USD", weight: "0.5", settled_quantity: "0", close: "5.01", fx_cny: "2", quantity_step: "3", price_step: "0.1" })]), fee_rate_bps: "10", minimum_fee_by_currency: { USD: "1" } });
  assert.deepEqual(result.items[0], { account_id: "synthetic-account", listing_id: "synthetic-etf", currency: "USD", side: "buy", quantity: "39", limit_price: "5.1", estimated_fees: "1" });
  assert.equal(result.comparisons[0].residual_cny, "9.22");
  const sell = compareManualTargets(input([row({ weight: "0", settled_quantity: "3", close: "5.09", price_step: "0.1" })]));
  assert.equal(sell.items[0].limit_price, "5");
  const missing = compareManualTargets({ ...input(), rows: [row({ currency: "EUR", settled_quantity: "0" })] });
  assert.equal(missing.blockers[0].code, "EVALUATION_FEE_INPUT_MISSING");
});

test("invalid or duplicate target facts cannot be accepted as a complete comparison", () => {
  for (const changes of [{ weight: "-1" }, { fx_cny: "0" }, { close: "0" }, { settled_quantity: "-1" }, { transit_quantity: "-1" }, { quantity_step: "0" }]) {
    assert.throws(() => compareManualTargets(input([row(changes)])), /EVALUATION_TARGET_INPUT_INVALID/);
  }
  assert.throws(() => compareManualTargets(input([row(), row()])), /EVALUATION_TARGET_INPUT_INVALID/);
  assert.throws(() => compareManualTargets({ ...input(), nav_cny: "0" }), /EVALUATION_TARGET_INPUT_INVALID/);
  assert.throws(() => compareManualTargets({ ...input(), weight_tolerance: "1.01" }), /EVALUATION_TARGET_INPUT_INVALID/);
});
