import assert from "node:assert/strict";
import test from "node:test";
import { buildEntry } from "../src/server/ledger/engine";

const base = { account_id: "source", currency: "CNY", listing_id: "etf", quantity: "100" };
const value_evidence = { schema_version: "security-transfer-value-v1" as const, reference: "Synthetic confirmed custody value", effective_at: "2026-01-02T00:00:00Z", time_precision: "second" as const, source_timezone: "UTC" };

test("external securities use confirmed market value as capital, never historical carry cost as profit", () => {
  const entry = buildEntry({ ...base, type: "security_in", market_value: "1000", cost_amount: "700", value_evidence });
  assert.deepEqual(entry.postings.map(row => [row.ledger_account, row.amount]), [["inventory_cost", "700"], ["external_capital", "-1000"], ["capital_valuation_adjustment", "300"]]);
  assert.equal(entry.movements[0].cost_amount, "700");
  const unknown = buildEntry({ ...base, type: "security_in", market_value: "1000", value_evidence });
  assert.equal(unknown.movements[0].cost_known, false);
  const out = buildEntry({ ...base, type: "security_out", quantity: "40", market_value: "480", value_evidence }, { position: { quantity: "100", cost_amount: "700", cost_known: true, currency: "CNY" } });
  assert.deepEqual(out.postings.map(row => [row.ledger_account, row.amount]), [["inventory_cost", "-280"], ["external_capital", "480"], ["capital_valuation_adjustment", "-200"]]);
  assert.equal(out.movements[0].quantity, "-40");
  assert.throws(() => buildEntry({ ...base, type: "security_in", market_value: "1000" }), /VALUE_EVIDENCE/);
});

test("internal dispatch and partial receive carry exact lot cost without cash, capital or income", () => {
  const out = buildEntry({ ...base, type: "security_transfer_out", target_account_id: "target", quantity: "3" }, { position: { quantity: "3", cost_amount: "1", cost_known: false, currency: "CNY" } });
  assert.equal(out.movements[0].quantity, "-3"); assert.equal(out.transits?.[0].quantity, "3");
  assert.equal(out.transits?.[0].cost_known, false);
  const lot = { transfer_event_id: "dispatch", source_account_id: "source", target_account_id: "target", listing_id: "etf", currency: "CNY", quantity: "3", cost_amount: "1", cost_known: false };
  const first = buildEntry({ ...base, account_id: "target", type: "security_transfer_in", quantity: "1", related_event_id: "dispatch" }, { transfer: lot });
  assert.equal(first.movements[0].cost_amount, "0.333333333333333333");
  assert.equal(first.transits?.[0].cost_amount, "-0.333333333333333333");
  const final = buildEntry({ ...base, type: "security_transfer_return", quantity: "2", related_event_id: "dispatch" }, { transfer: { ...lot, quantity: "2", cost_amount: "0.666666666666666667" } });
  assert.equal(final.movements[0].cost_amount, "0.666666666666666667");
  assert.equal(final.movements[0].cost_known, false);
  for (const entry of [out, first, final]) assert.equal(entry.postings.some(row => ["income", "external_capital", "cash_settled", "trade_payable"].includes(row.ledger_account)), false);
  assert.throws(() => buildEntry({ ...base, account_id: "third", type: "security_transfer_in", related_event_id: "dispatch", quantity: "1" }, { transfer: lot }), /TRANSFER_TARGET_MISMATCH/);
  assert.throws(() => buildEntry({ ...base, account_id: "target", type: "security_transfer_in", related_event_id: "dispatch", quantity: "4" }, { transfer: lot }), /EXCEEDS_OUTSTANDING/);
});

test("a split adjusts both owned settled and transit quantity without changing cost", () => {
  const lot = { transfer_event_id: "dispatch", source_account_id: "source", target_account_id: "target", listing_id: "etf", currency: "CNY", quantity: "40", cost_amount: "280", cost_known: true };
  const entry = buildEntry({ ...base, type: "split", split_numerator: "2", split_denominator: "1" }, { position: { quantity: "60", cost_amount: "420", cost_known: true, currency: "CNY" }, transit_positions: [lot] });
  assert.equal(entry.movements[0].quantity, "60"); assert.equal(entry.transits?.[0].quantity, "40");
  assert.equal(entry.transits?.[0].cost_amount, "0"); assert.deepEqual(entry.postings, []);
});
