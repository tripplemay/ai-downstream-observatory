import assert from "node:assert/strict";
import test from "node:test";
import { buildEntry, type DividendState, type Entry, type Fact } from "../src/server/ledger/engine";
import { amount, exact } from "../src/server/ledger/decimal";

const fact = (type: Fact["type"], values: Partial<Fact> = {}): Fact => ({ type, account_id: "a", currency: "CNY", ...values });
const context = (values: Partial<DividendState> = {}): DividendState => ({ root_event_id: "root", type: "dividend_accrual", account_id: "a", currency: "CNY", gross_amount: "200", tax: "0", tax_status: "unknown", net_cash: "0", receivable: "200", tax_payable: "0", assessment_confirmed: false, ...values });
const child = (type: Fact["type"], values: Partial<Fact> = {}) => fact(type, { related_event_id: "root", evidence_reference: "Synthetic tax confirmation", ...values });
function balanced(entry: Entry) {
  for (const currency of new Set(entry.postings.map(row => row.currency))) assert.equal(exact(entry.postings.filter(row => row.currency === currency).reduce((sum, row) => sum.add(row.amount), amount("0"))), "0");
  assert.deepEqual(entry.movements, []); assert.equal(entry.transits, undefined);
  return Object.fromEntries(entry.postings.map(row => [row.ledger_account, row.amount]));
}

test("dividend tax state distinguishes unknown, estimates and confirmed zero; direct receipts require explicit tax", () => {
  const unknown = buildEntry(fact("dividend_accrual", { amount: "200" }));
  assert.ok(unknown.warnings.includes("DIVIDEND_TAX_PROVISIONAL")); assert.equal(balanced(unknown).dividend_receivable, "200");
  for (const status of [undefined, "confirmed"] as const) assert.deepEqual(buildEntry(fact("dividend_accrual", { amount: "200", tax: "0", tax_status: status })).warnings, []);
  assert.ok(buildEntry(fact("dividend_accrual", { amount: "200", tax: "20", tax_status: "estimated" })).warnings.length);
  for (const values of [{ tax_status: "confirmed" }, { tax_status: "estimated" }, { tax_status: "unknown", tax: "0" }]) assert.throws(() => buildEntry(fact("dividend_accrual", { amount: "200", ...values } as Partial<Fact>)), /INVALID_DIVIDEND_TAX_STATUS/);
  assert.throws(() => buildEntry(fact("dividend", { amount: "200" })), /DIRECT_DIVIDEND_TAX_REQUIRED/);
  assert.throws(() => buildEntry(fact("dividend", { amount: "200", tax: "20", tax_status: "estimated" })), /DIRECT_DIVIDEND_TAX_REQUIRED/);
  assert.equal(balanced(buildEntry(fact("dividend", { amount: "200", tax: "20" }))).cash_settled, "180");
  assert.ok(buildEntry(fact("dividend", { amount: "200" }), { legacy_direct_dividend: true }).warnings.includes("DIVIDEND_TAX_PROVISIONAL"));
});

test("a real net payment exceeding the estimated net receivable recognizes a tax liability, not a second expense", () => {
  const value = context({ tax: "30", tax_status: "estimated", receivable: "170" });
  assert.deepEqual(balanced(buildEntry(child("dividend_payment", { amount: "180" }), { dividend: value })), { cash_settled: "180", dividend_receivable: "-170", dividend_tax_payable: "-10" });
  assert.throws(() => buildEntry(child("dividend_payment", { amount: "201" }), { dividend: value }), /EXCEEDS_DIVIDEND_GROSS/);
  assert.deepEqual(balanced(buildEntry(child("dividend_tax_assessment", { tax: "20", tax_status: "confirmed" }), { dividend: context({ tax: "30", tax_status: "estimated", net_cash: "180", receivable: "0", tax_payable: "-10" }) })), { dividend_tax_payable: "10", expense: "-10" });
});

test("cumulative tax changes, actual extra withholding and refunds conserve cash plus net outstanding rights", () => {
  let state = context();
  const balances = new Map<string, string>([["dividend_receivable", "200"], ["income", "-200"]]);
  for (const input of [
    child("dividend_payment", { amount: "180" }), child("dividend_tax_assessment", { tax: "20", tax_status: "confirmed" }),
    child("dividend_tax_assessment", { tax: "25", tax_status: "confirmed" }), child("dividend_tax_payment", { amount: "5" }),
    child("dividend_tax_assessment", { tax: "20", tax_status: "confirmed" }), child("dividend_payment", { amount: "5" }),
  ]) {
    const entry = buildEntry(input, { dividend: state }); balanced(entry);
    if (input.type === "dividend_tax_assessment") assert.ok(entry.postings.every(row => row.ledger_account !== "cash_settled"));
    if (input.type === "dividend_payment" || input.type === "dividend_tax_payment") assert.ok(entry.postings.every(row => !["income", "expense"].includes(row.ledger_account)));
    for (const posting of entry.postings) balances.set(posting.ledger_account, exact(amount(balances.get(posting.ledger_account) ?? "0").add(posting.amount)));
    state = { ...state, tax: balances.get("expense") ?? "0", net_cash: balances.get("cash_settled") ?? "0", receivable: balances.get("dividend_receivable") ?? "0", tax_payable: balances.get("dividend_tax_payable") ?? "0" };
    assert.equal(exact(amount(state.net_cash).add(state.receivable).add(state.tax_payable)), exact(amount("200").sub(state.tax)));
  }
  assert.deepEqual({ cash: state.net_cash, receivable: state.receivable, payable: state.tax_payable, tax: state.tax }, { cash: "180", receivable: "0", payable: "0", tax: "20" });
  assert.throws(() => buildEntry(child("dividend_tax_payment", { amount: "1" }), { dividend: state }), /EXCEEDS_OUTSTANDING/);
  assert.deepEqual(balanced(buildEntry(child("dividend_tax_assessment", { tax: "20", tax_status: "confirmed" }), { dividend: state })), {});
});

test("net-only dividends preserve real cash; a unique exact gross/tax breakdown changes classification only", () => {
  const original = buildEntry(fact("dividend_net", { amount: "180", net_status: "final" }));
  assert.deepEqual(balanced(original), { cash_settled: "180", unclassified_income: "-180" });
  assert.ok(original.warnings.includes("DIVIDEND_BREAKDOWN_MISSING"));
  const value = context({ type: "dividend_net", gross_amount: null, net_amount: "180", net_status: "provisional", net_cash: "180", receivable: "0" });
  assert.deepEqual(balanced(buildEntry(child("dividend_breakdown", { gross_amount: "200", tax: "20" }), { dividend: value })), { unclassified_income: "180", income: "-200", expense: "20" });
  assert.throws(() => buildEntry(child("dividend_breakdown", { gross_amount: "201", tax: "20" }), { dividend: value }), /DIVIDEND_BREAKDOWN_MISMATCH/);
  assert.throws(() => buildEntry(child("dividend_breakdown", { gross_amount: "200", tax: "20" }), { dividend: { ...value, breakdown_event_id: "existing" } }), /DIVIDEND_BREAKDOWN_ALREADY_RECORDED/);
  assert.throws(() => buildEntry(child("dividend_tax_assessment", { tax: "20", tax_status: "confirmed" }), { dividend: value }), /DIVIDEND_BREAKDOWN_REQUIRED/);
  assert.throws(() => buildEntry(child("dividend_payment", { amount: "1" }), { dividend: value }), /DIVIDEND_BREAKDOWN_REQUIRED/);
});

test("tax recognition rejects missing evidence, negative or excessive cumulative taxes and wrong root scope", () => {
  for (const values of [{ tax: "-1" }, { tax: "201" }, { tax: undefined }, { evidence_reference: "  " }, { currency: "USD" }, { account_id: "b" }]) assert.throws(() => buildEntry(child("dividend_tax_assessment", { tax: "20", tax_status: "confirmed", ...values }), { dividend: context() }));
  assert.throws(() => buildEntry(child("dividend_tax_payment", { amount: "0" }), { dividend: context({ net_cash: "200", receivable: "0", tax: "20", tax_payable: "-20" }) }));
  assert.throws(() => buildEntry(child("dividend_payment", { amount: "1", listing_id: "other" }), { dividend: context({ listing_id: "original" }) }), /DIVIDEND_LISTING_MISMATCH/);
});

test("corporate notices and resolutions emit zero economic postings, retain explicit evidence and block duplicate resolution", () => {
  const notice = buildEntry(fact("corporate_action_notice", { action_kind: "merger", evidence_reference: "Synthetic notice" }));
  assert.deepEqual(balanced(notice), {}); assert.ok(notice.warnings.includes("CORPORATE_ACTION_UNRESOLVED"));
  const resolution = fact("corporate_action_resolution", { related_event_id: "notice", resolution: "not_applicable", supporting_event_ids: [], evidence_reference: "Synthetic determination" });
  assert.deepEqual(balanced(buildEntry(resolution, { notice: { account_id: "a", currency: "CNY", resolved: false } })), {});
  assert.throws(() => buildEntry(resolution, { notice: { account_id: "a", currency: "CNY", resolved: true } }), /CORPORATE_ACTION_ALREADY_RESOLVED/);
  assert.throws(() => buildEntry({ ...resolution, resolution: "recorded" }, { notice: { account_id: "a", currency: "CNY", resolved: false } }), /INVALID_CORPORATE_ACTION_RESOLUTION/);
});
