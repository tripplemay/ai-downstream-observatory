import { z } from "zod";
import { amount } from "@/server/ledger/decimal";
import { tradeRecordingContextSchema, tradeRecordingIntentSchema, TRADE_RECORDING_ZONES,
  type TradeRecordingContext, type TradeRecordingIntent } from "@/server/investor/trade-recording-schemas";
import type { ReconciliationScope } from "./investor-reconciliation-client";

const responseSchema = tradeRecordingContextSchema.safeExtend({ session_binding: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function parseTradeRecordingContext(value: unknown, expected: ReconciliationScope): TradeRecordingContext {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new Error("INVESTOR_TRADE_RESPONSE_INVALID");
  const { session_binding, ...document } = parsed.data, checked = tradeRecordingContextSchema.safeParse(document);
  if (!checked.success || session_binding !== expected.binding || document.workspace_id !== expected.workspace || document.workspace_revision !== expected.revision
    || document.portfolio_id !== expected.portfolio || document.ledger_revision !== expected.ledgerRevision || document.link_id !== expected.linkId
    || document.link_version !== expected.linkVersion || document.account_id !== expected.accountId || document.account_row_version !== expected.accountRowVersion)
    throw new Error("INVESTOR_TRADE_RESPONSE_INVALID");
  return checked.data;
}
export type TradeRecordingDraft = { mode: "trade" | "settlement"; side: string; listing: string; related: string;
  quantity: string; consideration: string; fee: string; payment: string; date: string; zone: string;
  source: string; sourceEvent: string; reference: string; acknowledged: boolean };
export function blankTradeRecordingDraft(mode: TradeRecordingDraft["mode"]): TradeRecordingDraft {
  return { mode, side: "", listing: "", related: "", quantity: "", consideration: "", fee: "", payment: "", date: "", zone: "",
    source: "", sourceEvent: "", reference: "", acknowledged: false };
}
export function buildTradeRecordingIntent(context: TradeRecordingContext, draft: TradeRecordingDraft): TradeRecordingIntent {
  try {
    if (!tradeRecordingContextSchema.safeParse(context).success || context.read_only || context.account_status === "disabled"
      || !TRADE_RECORDING_ZONES.some(value => value === draft.zone)) throw new Error();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: draft.zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(context.checked_at));
    const part = (type: string) => parts.find(value => value.type === type)!.value;
    if (draft.date > `${part("year")}-${part("month")}-${part("day")}`) throw new Error();
    const listing = context.listings.find(row => row.id === draft.listing), parent = context.unsettled_trades.find(row => row.event_id === draft.related);
    const parsed = tradeRecordingIntentSchema.parse({ action: "record_linked_trade_fact", portfolio_id: context.portfolio_id, account_id: context.account_id,
      expected_ledger_revision: context.ledger_revision, expected_account_row_version: context.account_row_version,
      expected_link_id: context.link_id, expected_link_version: context.link_version, expected_context_hash: context.context_hash,
      basis: "operator_transcription_not_broker_file", acknowledgement: draft.acknowledged,
      source_id: draft.source, source_event_id: draft.sourceEvent, source_reference: draft.reference, effective_date: draft.date, source_timezone: draft.zone,
      entry: draft.mode === "trade" ? { type: draft.side, listing_id: listing?.id, currency: listing?.currency,
        quantity: draft.quantity.trim(), consideration: draft.consideration.trim(), fee: draft.fee.trim() }
        : { type: "settlement", related_event_id: parent?.event_id, direction: parent?.direction, currency: parent?.currency, amount: draft.payment.trim() } });
    if (parsed.entry.type === "sell" && amount(parsed.entry.fee).gte(parsed.entry.consideration)
      || new TextEncoder().encode(JSON.stringify({ ...parsed, expected_revision: context.workspace_revision, idempotency_key: "0".repeat(36) })).byteLength > 32768) throw new Error();
    return parsed;
  } catch { throw new Error("INVESTOR_TRADE_DRAFT_INVALID"); }
}
