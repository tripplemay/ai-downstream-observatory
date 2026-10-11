import assert from "node:assert/strict";
import test from "node:test";
import { blankTradeRecordingDraft, buildTradeRecordingIntent, parseTradeRecordingContext } from "../src/components/workbench/investor-trade-recording-client";
import { tradeRecordingContextSchema, type TradeRecordingContext } from "../src/server/investor/trade-recording-schemas";
import { verifyInvestorReceipt } from "../src/components/workbench/investor-client";

export const tradeBinding = "a".repeat(64);
export const tradeContext: TradeRecordingContext = tradeRecordingContextSchema.parse({ schema_version: "investor-trade-recording-v1",
  workspace_id: "fictional-workspace", workspace_revision: 2, portfolio_id: "fictional-book", ledger_revision: 3, link_id: "fictional-link", link_version: 1,
  account_id: "fictional-account", account_row_version: 4, account_status: "active", checked_at: "2026-01-02T00:15:00.000Z", read_only: false,
  context_hash: "c".repeat(64), listings: [{ id: "fictional-listing", ticker: "FICTIONAL", name: "Fictional ETF only", market: "US", currency: "USD" }],
  unsettled_trades: [{ event_id: "fictional-event", direction: "buy", currency: "USD", effective_at: "2026-01-01", source_id: "FICTIONAL", source_event_id: "1" }],
  basis: "metadata_only_no_fact_prefill", execution_authorized: false });
export const tradeScope = { binding: tradeBinding, workspace: tradeContext.workspace_id, revision: tradeContext.workspace_revision,
  portfolio: tradeContext.portfolio_id, ledgerRevision: tradeContext.ledger_revision, linkId: tradeContext.link_id, linkVersion: tradeContext.link_version,
  accountId: tradeContext.account_id, accountRowVersion: tradeContext.account_row_version };
export function validTradeDraft() { return { ...blankTradeRecordingDraft("trade"), side: "buy", listing: "fictional-listing", quantity: "1.00000001",
  consideration: "10.00000001", fee: "0.00000001", date: "2026-01-01", zone: "America/New_York", source: "FICTIONAL", sourceEvent: "2",
  reference: "Fictional transcription only", acknowledged: true }; }

test("trade metadata rejects foreign scopes, extra financial facts, duplicate identities and promoted execution authority", () => {
  const response = { ...tradeContext, session_binding: tradeBinding };
  assert.deepEqual(parseTradeRecordingContext(response, tradeScope), tradeContext);
  for (const patch of [{ session_binding: "b".repeat(64) }, { workspace_id: "foreign" }, { workspace_revision: 3 }, { portfolio_id: "foreign" },
    { ledger_revision: 4 }, { link_id: "foreign" }, { link_version: 2 }, { account_id: "foreign" }, { account_row_version: 5 },
    { execution_authorized: true }, { quantity: "100" }, { listings: [...tradeContext.listings, ...tradeContext.listings] },
    { unsettled_trades: [...tradeContext.unsettled_trades, ...tradeContext.unsettled_trades] },
    { unsettled_trades: tradeContext.unsettled_trades.map(row => ({ ...row, amount: "10" })) }])
    assert.throws(() => parseTradeRecordingContext({ ...response, ...patch }, tradeScope), /RESPONSE_INVALID/);
});

test("blank trade/settlement drafts have no monetary, date, source, direction or acknowledgement defaults", () => {
  for (const mode of ["trade", "settlement"] as const) {
    const draft = blankTradeRecordingDraft(mode), { mode: _, acknowledged, ...fields } = draft;
    assert.equal(acknowledged, false); assert.ok(Object.values(fields).every(value => value === ""));
    assert.throws(() => buildTradeRecordingIntent(tradeContext, draft), /DRAFT_INVALID/);
  }
});

test("explicit draft uses exact strings and known currency; missing fees, future local days and impossible identities never become facts", () => {
  const draft = validTradeDraft(), result = buildTradeRecordingIntent(tradeContext, draft);
  assert.deepEqual(result.entry, { type: "buy", listing_id: "fictional-listing", currency: "USD", quantity: "1.00000001", consideration: "10.00000001", fee: "0.00000001" });
  assert.equal(result.effective_date, "2026-01-01"); assert.equal(result.source_timezone, "America/New_York");
  for (const patch of [{ acknowledged: false }, { side: "" }, { listing: "foreign" }, { quantity: "0" }, { consideration: "1e3" }, { fee: "" },
    { fee: "-1" }, { date: "2026-01-02" }, { date: "2026-02-30" }, { zone: "" }, { sourceEvent: "" }, { reference: "" },
    { quantity: "1.000000001" }, { source: "invalid source" }, { sourceEvent: "中文编号" }, { side: "sell", consideration: "0.1", fee: "0.1" }])
    assert.throws(() => buildTradeRecordingIntent(tradeContext, { ...draft, ...patch }), /DRAFT_INVALID/);
  assert.throws(() => buildTradeRecordingIntent({ ...tradeContext, read_only: true }, draft), /DRAFT_INVALID/);
  assert.throws(() => buildTradeRecordingIntent({ ...tradeContext, account_status: "disabled" }, draft), /DRAFT_INVALID/);
  assert.equal(buildTradeRecordingIntent(tradeContext, { ...draft, fee: "0" }).entry.type, "buy");
});

test("settlement needs an explicitly selected current parent and actual payment, never a trade amount default", () => {
  const draft = { ...validTradeDraft(), mode: "settlement" as const, related: "fictional-event", payment: "4" };
  assert.deepEqual(buildTradeRecordingIntent(tradeContext, draft).entry, { type: "settlement", related_event_id: "fictional-event", direction: "buy", currency: "USD", amount: "4" });
  for (const patch of [{ related: "foreign" }, { payment: "" }, { payment: "0" }, { payment: "-1" }])
    assert.throws(() => buildTradeRecordingIntent(tradeContext, { ...draft, ...patch }), /DRAFT_INVALID/);
});

test("parent recovery receipt recognises manual fact action but still binds exact action, session, workspace and CAS revision", () => {
  const input = buildTradeRecordingIntent(tradeContext, validTradeDraft()), pending = { body: JSON.stringify({ ...input, expected_revision: 2, idempotency_key: "fictional-key" }),
    binding: tradeBinding, workspace: tradeContext.workspace_id };
  const receipt = { workspace_id: tradeContext.workspace_id, revision: 3, action: input.action, resource_id: "fictional-event", audit_id: "fictional-audit", session_binding: tradeBinding };
  assert.deepEqual(verifyInvestorReceipt(receipt, pending), receipt);
  for (const patch of [{ action: "save_profile" }, { revision: 2 }, { workspace_id: "foreign" }, { session_binding: "b".repeat(64) }, { execution_authorized: true }])
    assert.throws(() => verifyInvestorReceipt({ ...receipt, ...patch }, pending), /RESPONSE_INVALID/);
});
