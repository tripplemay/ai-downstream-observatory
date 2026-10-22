import { z } from "zod";
import { reconciliationInstantMicros } from "../ledger/reconciliation-schemas";

// Independent from investor/schemas: that command union imports this module.
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/), revision = z.number().int().nonnegative().safe();
const currency = z.string().regex(/^[A-Z]{3}$/);
const sourceId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/);
const instant = z.string().datetime({ precision: 3 });
export const TRADE_RECORDING_ZONES = ["Asia/Shanghai", "Asia/Hong_Kong", "America/New_York", "UTC"] as const;
export function tradeRecordingDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000") && Number.isFinite(Date.parse(value + "T00:00:00Z"))
    && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}
export function tradeEvidenceNotFuture(effectiveAt: string, zone: string | undefined, checkedAt: string): boolean {
  const checked = reconciliationInstantMicros(checkedAt);
  if (checked === null) return false;
  if (!tradeRecordingDate(effectiveAt)) {
    const effective = reconciliationInstantMicros(effectiveAt);
    return effective !== null && effective <= checked;
  }
  if (!zone) return effectiveAt <= checkedAt.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(checkedAt));
    return effectiveAt <= ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
  } catch { return false; }
}
const decimal = z.string().regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,8})?$/);
const positive = decimal.refine(value => /[1-9]/.test(value));
const trade = z.object({ listing_id: id, currency, quantity: positive, consideration: positive, fee: decimal });
export const tradeRecordingIntentSchema = z.object({ action: z.literal("record_linked_trade_fact"), portfolio_id: id, account_id: id,
  expected_ledger_revision: revision, expected_account_row_version: revision, expected_link_id: id,
  expected_link_version: revision.refine(value => value > 0), expected_context_hash: hash,
  basis: z.literal("operator_transcription_not_broker_file"), acknowledgement: z.literal(true),
  source_id: sourceId, source_event_id: sourceId, source_reference: z.string().trim().min(1).max(500),
  effective_date: z.string().refine(tradeRecordingDate), source_timezone: z.enum(TRADE_RECORDING_ZONES),
  entry: z.discriminatedUnion("type", [trade.extend({ type: z.literal("buy") }).strict(), trade.extend({ type: z.literal("sell") }).strict(),
    z.object({ type: z.literal("settlement"), related_event_id: id, direction: z.enum(["buy", "sell"]), currency, amount: positive }).strict()]),
}).strict();
const listing = z.object({ id, ticker: z.string().min(1).max(120), name: z.string().min(1).max(200),
  market: z.enum(["CN", "HK", "US"]), currency }).strict();
export const tradeRecordingContextSchema = z.object({ schema_version: z.literal("investor-trade-recording-v1"), workspace_id: id,
  workspace_revision: revision.refine(value => value > 0), portfolio_id: id, ledger_revision: revision, link_id: id,
  link_version: revision.refine(value => value > 0), account_id: id, account_row_version: revision,
  account_status: z.enum(["active", "disabled", "reconciliation_required"]), checked_at: instant, read_only: z.boolean(), context_hash: hash,
  listings: z.array(listing).max(200), unsettled_trades: z.array(z.object({ event_id: id, direction: z.enum(["buy", "sell"]), currency,
    effective_at: z.string().min(1).max(40), source_timezone: z.string().min(1).max(100).optional(),
    source_id: z.string().min(1).max(200), source_event_id: z.string().max(200).nullable() }).strict()).max(50),
  basis: z.literal("metadata_only_no_fact_prefill"), execution_authorized: z.literal(false),
}).strict().superRefine((value, context) => {
  if (new Set(value.listings.map(row => row.id)).size !== value.listings.length
    || new Set(value.unsettled_trades.map(row => row.event_id)).size !== value.unsettled_trades.length
    || value.unsettled_trades.some(row => !tradeEvidenceNotFuture(row.effective_at, row.source_timezone, value.checked_at)))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "INVESTOR_TRADE_CONTEXT_INVALID" });
});
export type TradeRecordingContext = z.infer<typeof tradeRecordingContextSchema>;
export type TradeRecordingIntent = z.infer<typeof tradeRecordingIntentSchema>;
