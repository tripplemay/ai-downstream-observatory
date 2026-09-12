import assert from "node:assert/strict";
import test from "node:test";
import { amount, Decimal, exact } from "../src/server/ledger/decimal";
import { buildEntry, type Entry, type Fact, type FactState, type Position } from "../src/server/ledger/engine";

function ledger() {
  const balances = new Map<string, Decimal>();
  const positions = new Map<string, Position>();
  const balance = (name: string, account = "a", currency = "CNY") => balances.get(`${account}:${currency}:${name}`) ?? new Decimal(0);
  const post = (fact: Fact, state: FactState = {}): Entry => {
    const key = `${fact.account_id}:${fact.listing_id}`;
    const entry = buildEntry(fact, { position: positions.get(key), ...state });
    for (const p of entry.postings) {
      const k = `${p.account_id}:${p.currency}:${p.ledger_account}`;
      balances.set(k, (balances.get(k) ?? new Decimal(0)).add(amount(p.amount)));
    }
    for (const m of entry.movements) {
      const k = `${m.account_id}:${m.listing_id}`, old = positions.get(k);
      positions.set(k, { quantity: exact(amount(old?.quantity ?? "0").add(amount(m.quantity))), cost_amount: exact(amount(old?.cost_amount ?? "0").add(amount(m.cost_amount))), currency: m.currency, cost_known: m.cost_known && (old?.cost_known ?? true) });
    }
    return entry;
  };
  return { post, balance, positions };
}
const base = { account_id: "a", currency: "CNY" };

test("F03/F04 trade-date ledger and settlement conserve NAV and fees", () => {
  const l = ledger();
  l.post({ ...base, type: "opening_cash", amount: "100000" });
  l.post({ ...base, type: "buy", listing_id: "etf", quantity: "1000", price: "10", fee: "10" });
  assert.equal(l.balance("cash_settled").toString(), "100000");
  assert.equal(l.balance("trade_payable").toString(), "-10010");
  assert.equal(l.balance("cash_settled").add(l.balance("trade_payable")).add(10000).toString(), "99990");
  l.post({ ...base, type: "settlement", amount: "10010", direction: "buy", related_event_id: "buy" }, { related: { type: "buy", account_id: "a", currency: "CNY", outstanding: "10010" } });
  l.post({ ...base, type: "sell", listing_id: "etf", quantity: "400", price: "12", fee: "4" });
  assert.equal(l.balance("trade_receivable").toString(), "4796");
  l.post({ ...base, type: "settlement", amount: "4796", direction: "sell", related_event_id: "sell" }, { related: { type: "sell", account_id: "a", currency: "CNY", outstanding: "4796" } });
  assert.equal(l.balance("cash_settled").toString(), "94786");
  assert.deepEqual(l.positions.get("a:etf"), { quantity: "600", cost_amount: "6000", currency: "CNY", cost_known: true });
  assert.equal(l.balance("income").toString(), "-800");
  assert.equal(l.balance("expense").toString(), "14");
  assert.equal(l.balance("cash_settled").add(7200).toString(), "101986");
});

test("F05 dividend receivable transfers to cash without duplicate income", () => {
  const l = ledger();
  l.post({ ...base, type: "dividend_accrual", amount: "200", tax: "20" });
  assert.equal(l.balance("dividend_receivable").toString(), "180");
  l.post({ ...base, type: "dividend_payment", amount: "180", related_event_id: "div" }, { dividend: { root_event_id: "div", type: "dividend_accrual", account_id: "a", currency: "CNY", gross_amount: "200", tax: "20", tax_status: "confirmed", net_cash: "0", receivable: "180", tax_payable: "0", assessment_confirmed: false } });
  assert.equal(l.balance("dividend_receivable").toString(), "0");
  assert.equal(l.balance("cash_settled").toString(), "180");
  assert.equal(l.balance("income").toString(), "-200");
});

test("F06 transfer in transit is owned once, never external capital", () => {
  const l = ledger();
  l.post({ ...base, type: "opening_cash", amount: "100000" });
  l.post({ ...base, type: "transfer_out", target_account_id: "b", amount: "30000", fee: "10" });
  assert.equal(l.balance("cash_settled").toString(), "69990");
  assert.equal(l.balance("transfer_in_transit").toString(), "30000");
  l.post({ ...base, account_id: "b", type: "transfer_in", amount: "30000", related_event_id: "transfer" }, { related: { type: "transfer_out", account_id: "a", currency: "CNY", target_account_id: "b", outstanding: "30000" } });
  assert.equal(l.balance("transfer_in_transit").toString(), "0");
  assert.equal(l.balance("cash_settled", "b").toString(), "30000");
  assert.equal(l.balance("external_capital").toString(), "0");
});

test("F07 FX bridges each currency; explicit fee counted once", () => {
  const l = ledger();
  l.post({ ...base, type: "opening_cash", amount: "7007" });
  l.post({ ...base, type: "fx", amount: "7000", fee: "7", received_amount: "1000", target_currency: "USD" });
  assert.equal(l.balance("cash_settled").toString(), "0");
  assert.equal(l.balance("cash_settled", "a", "USD").toString(), "1000");
  assert.equal(l.balance("expense").toString(), "7");
});

test("F13 split conserves cost; unknown historical cost remains unknown", () => {
  const l = ledger();
  l.post({ ...base, type: "opening_position", listing_id: "etf", quantity: "100", cost_amount: "2000" });
  l.post({ ...base, type: "split", listing_id: "etf", split_numerator: "2", split_denominator: "1" });
  assert.equal(l.positions.get("a:etf")?.quantity, "200");
  assert.equal(l.positions.get("a:etf")?.cost_amount, "2000");
  const warning = l.post({ ...base, type: "opening_position", listing_id: "unknown", quantity: "10" });
  assert.deepEqual(warning.warnings, ["UNKNOWN_HISTORICAL_COST"]);
  assert.equal(l.positions.get("a:unknown")?.cost_known, false);
});

test("money rejects numeric coercion, oversized precision and malicious strings", () => {
  for (const v of [1, NaN, Infinity, "1e3", "01", "+1", "1,000", "0.0000000000000000001", "1;DROP TABLE accounts", "9".repeat(39)]) assert.throws(() => amount(v));
  assert.equal(exact(amount("0.1").add(amount("0.2"))), "0.3");
});

test("settlement requires correct event, currency, account and remaining amount", () => {
  const fact: Fact = { ...base, type: "settlement", amount: "11", direction: "buy", related_event_id: "x" };
  assert.throws(() => buildEntry(fact));
  assert.throws(() => buildEntry(fact, { related: { type: "buy", account_id: "a", currency: "CNY", outstanding: "10" } }));
  assert.throws(() => buildEntry({ ...fact, amount: "1" }, { related: { type: "buy", account_id: "b", currency: "CNY", outstanding: "10" } }));
});

test("average cost repeated allocations exhaust exact total without residual", () => {
  const l = ledger();
  l.post({ ...base, type: "buy", listing_id: "etf", quantity: "3", consideration: "1" });
  for (let i = 0; i < 3; i++) l.post({ ...base, type: "sell", listing_id: "etf", quantity: "1", price: "1" });
  assert.equal(l.positions.get("a:etf")?.cost_amount, "0");
  assert.equal(l.balance("inventory_cost").toString(), "0");
});

test("sell fees greater than proceeds settle as a cash debit, not an invented credit", () => {
  const l = ledger();
  l.post({ ...base, type: "opening_position", listing_id: "etf", quantity: "1", cost_amount: "1" });
  l.post({ ...base, type: "sell", listing_id: "etf", quantity: "1", price: "1", fee: "2" });
  assert.equal(l.balance("trade_receivable").toString(), "-1");
  l.post({ ...base, type: "settlement", amount: "-1", direction: "sell", related_event_id: "sell" }, { related: { type: "sell", account_id: "a", currency: "CNY", outstanding: "-1" } });
  assert.equal(l.balance("cash_settled").toString(), "-1");
  assert.equal(l.balance("trade_receivable").toString(), "0");
});

test("supplied price must be valid; broker amount differences are never silently hidden", () => {
  assert.throws(() => buildEntry({ ...base, type: "buy", listing_id: "etf", quantity: "1", price: "-1", consideration: "100" }), /POSITIVE/);
  const e = buildEntry({ ...base, type: "buy", listing_id: "etf", quantity: "1", price: "99", consideration: "100" });
  assert.ok(e.warnings.includes("BROKER_PRINCIPAL_DIFFERS_FROM_QUANTITY_PRICE"));
});

test("selling unknown-cost holdings does not classify all proceeds as realized profit", () => {
  const l = ledger();
  l.post({ ...base, type: "opening_position", listing_id: "unknown", quantity: "1" });
  const e = l.post({ ...base, type: "sell", listing_id: "unknown", quantity: "1", price: "10" });
  assert.equal(l.balance("income").toString(), "0");
  assert.equal(l.balance("unclassified_income").toString(), "-10");
  assert.ok(e.warnings.includes("UNKNOWN_REALIZED_COST"));
});
