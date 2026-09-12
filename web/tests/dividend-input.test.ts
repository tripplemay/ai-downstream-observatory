import assert from "node:assert/strict";
import test from "node:test";
import { dividendInput } from "../src/components/workbench/dividend-input";
import { assertLedgerCommand } from "../src/server/contracts";

function data(patch: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ currency: "CNY", source_id: "synthetic", source_event_id: "synthetic-1", effective_at: "2026-01-02", time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic input only", ...patch })) form.set(key, value);
  return form;
}
function validate(value: ReturnType<typeof dividendInput>) { assertLedgerCommand({ portfolio_id: "p", expected_revision: 0, idempotency_key: "synthetic-command", ...value }); }
test("dividend input never defaults unknown tax or final net status", () => {
  assert.throws(() => dividendInput(data({ amount: "200" }), "dividend_accrual", "a"), /选择/);
  assert.throws(() => dividendInput(data({ amount: "180" }), "dividend_net", "a"), /选择/);
  const unknown = dividendInput(data({ amount: "200", tax_status: "unknown", tax: "99" }), "dividend_accrual", "a");
  assert.equal(unknown.fact.tax, undefined); assert.equal(unknown.fact.tax_status, "unknown"); validate(unknown);
  const final = dividendInput(data({ amount: "180", net_status: "final", tax: "99", gross_amount: "279" }), "dividend_net", "a");
  assert.equal(final.fact.tax, undefined); assert.equal(final.fact.gross_amount, undefined); validate(final);
});
test("cumulative assessments and actual cash deductions are distinct inputs", () => {
  const assessment = dividendInput(data({ related_event_id: "root", tax_status: "confirmed", tax: "0", evidence_reference: "Synthetic confirmed exemption", amount: "5" }), "dividend_tax_assessment", "a");
  assert.equal(assessment.fact.amount, undefined); assert.equal(assessment.fact.tax, "0"); validate(assessment);
  const payment = dividendInput(data({ related_event_id: "root", amount: "5", evidence_reference: "Synthetic cash deduction", tax: "5" }), "dividend_tax_payment", "a");
  assert.equal(payment.fact.tax, undefined); validate(payment);
});
test("direct dividends require explicit tax, breakdowns do not create cash", () => {
  assert.throws(() => validate(dividendInput(data({ amount: "200" }), "dividend", "a")), /VALIDATION_FAILED/);
  const direct = dividendInput(data({ amount: "200", tax: "20" }), "dividend", "a");
  assert.equal(direct.fact.tax_status, "confirmed"); validate(direct);
  const breakdown = dividendInput(data({ gross_amount: "200", tax: "20", related_event_id: "net-root", evidence_reference: "Synthetic gross/tax", amount: "180" }), "dividend_breakdown", "a");
  assert.equal(breakdown.fact.amount, undefined); validate(breakdown);
});
test("company action resolution preserves explicit supporting identities without monetary fields", () => {
  const recorded = dividendInput(data({ resolution: "recorded", supporting_event_ids: "fact-a\n fact-b", related_event_id: "notice", evidence_reference: "Synthetic manual check", amount: "100" }), "corporate_action_resolution", "a");
  assert.deepEqual(recorded.fact.supporting_event_ids, ["fact-a", "fact-b"]); assert.equal(recorded.fact.amount, undefined); validate(recorded);
  const ignored = dividendInput(data({ resolution: "not_applicable", related_event_id: "notice", evidence_reference: "Synthetic not applicable" }), "corporate_action_resolution", "a");
  assert.deepEqual(ignored.fact.supporting_event_ids, []); validate(ignored);
});
