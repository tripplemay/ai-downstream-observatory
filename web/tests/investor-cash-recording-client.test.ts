import assert from "node:assert/strict";
import test from "node:test";
import { blankCashRecordingDraft, buildCashRecordingIntent, parseCashRecordingContext } from "../src/components/workbench/investor-cash-recording-client";
import { verifyInvestorReceipt } from "../src/components/workbench/investor-client";
import { cashBinding as binding, cashContext as context, cashScope as scope, validCashDraft } from "./investor-cash-recording-fixture";

test("cash response accepts only current scoped metadata and never authority, balances or a plan amount", () => {
  const response = { ...context, session_binding: binding };
  assert.deepEqual(parseCashRecordingContext(response, scope), context);
  for (const patch of [{ session_binding: "b".repeat(64) }, { workspace_id: "foreign" }, { workspace_revision: 3 }, { portfolio_id: "foreign" },
    { ledger_revision: 4 }, { link_id: "foreign" }, { link_version: 2 }, { account_id: "foreign" }, { account_row_version: 5 },
    { amount: "300" }, { balance: "100" }, { planned_annual_contribution_cny: "500" }, { execution_authorized: true }, { allowed_currencies: ["JPY"] },
    { schema_version: "investor-trade-recording-v1" }]) assert.throws(() => parseCashRecordingContext({ ...response, ...patch }, scope), /CASH_RESPONSE_INVALID/);
});

test("blank cash form has no amount, direction, currency, date, source or acknowledgement defaults", () => {
  const draft = blankCashRecordingDraft();
  assert.equal(draft.acknowledged, false); assert.ok(Object.entries(draft).filter(([key]) => key !== "acknowledged").every(([, value]) => value === ""));
  assert.throws(() => buildCashRecordingIntent(context, draft), /CASH_DRAFT_INVALID/);
});

test("cash draft validates exact external principal, explicit currency and local date, never infers a fee or planned arrival", () => {
  const draft = validCashDraft(), value = buildCashRecordingIntent(context, draft);
  assert.deepEqual(value.entry, { type: "deposit", currency: "USD", amount: "300.01" });
  assert.equal(value.basis, "operator_external_cash_transcription_not_broker_file");
  assert.equal(buildCashRecordingIntent(context, { ...draft, direction: "withdrawal", currency: "HKD" }).entry.type, "withdrawal");
  for (const patch of [{ direction: "" }, { direction: "transfer_out" }, { currency: "" }, { currency: "JPY" }, { amount: "0" },
    { amount: "-1" }, { amount: "1.001" }, { amount: "1e3" }, { acknowledged: false }, { date: "2026-01-02" },
    { date: "2026-02-30" }, { zone: "" }, { sourceEvent: "" }, { reference: "" }, { source: "invalid source" }])
    assert.throws(() => buildCashRecordingIntent(context, { ...draft, ...patch }), /CASH_DRAFT_INVALID/);
  assert.throws(() => buildCashRecordingIntent({ ...context, read_only: true }, draft), /CASH_DRAFT_INVALID/);
  assert.throws(() => buildCashRecordingIntent({ ...context, account_status: "disabled" }, draft), /CASH_DRAFT_INVALID/);
});

test("existing unknown-response recovery binds the cash receipt to its exact action, scope, session and revision", () => {
  const input = buildCashRecordingIntent(context, validCashDraft()), pending = { body: JSON.stringify({ ...input, expected_revision: 2, idempotency_key: "fictional-key" }),
    binding, workspace: context.workspace_id };
  const receipt = { workspace_id: context.workspace_id, revision: 3, action: input.action, resource_id: "fictional-event", audit_id: "fictional-audit", session_binding: binding };
  assert.deepEqual(verifyInvestorReceipt(receipt, pending), receipt);
  for (const patch of [{ action: "record_linked_trade_fact" }, { revision: 2 }, { workspace_id: "foreign" }, { session_binding: "b".repeat(64) }, { execution_authorized: true }])
    assert.throws(() => verifyInvestorReceipt({ ...receipt, ...patch }, pending), /RESPONSE_INVALID/);
});
