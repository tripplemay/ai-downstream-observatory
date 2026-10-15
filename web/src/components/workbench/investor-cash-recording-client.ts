import { z } from "zod";
import { cashRecordingContextSchema, cashRecordingIntentSchema, type CashRecordingContext, type CashRecordingIntent } from "@/server/investor/cash-recording-schemas";
import { TRADE_RECORDING_ZONES } from "@/server/investor/trade-recording-schemas";
import type { ReconciliationScope } from "./investor-reconciliation-client";

const responseSchema = cashRecordingContextSchema.extend({ session_binding: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function parseCashRecordingContext(value: unknown, expected: ReconciliationScope): CashRecordingContext {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new Error("INVESTOR_CASH_RESPONSE_INVALID");
  const { session_binding, ...document } = parsed.data;
  if (session_binding !== expected.binding || document.workspace_id !== expected.workspace || document.workspace_revision !== expected.revision
    || document.portfolio_id !== expected.portfolio || document.ledger_revision !== expected.ledgerRevision || document.link_id !== expected.linkId
    || document.link_version !== expected.linkVersion || document.account_id !== expected.accountId || document.account_row_version !== expected.accountRowVersion)
    throw new Error("INVESTOR_CASH_RESPONSE_INVALID");
  return document;
}
export type CashRecordingDraft = { direction: string; currency: string; amount: string; date: string; zone: string;
  source: string; sourceEvent: string; reference: string; acknowledged: boolean };
export function blankCashRecordingDraft(): CashRecordingDraft {
  return { direction: "", currency: "", amount: "", date: "", zone: "", source: "", sourceEvent: "", reference: "", acknowledged: false };
}
export function buildCashRecordingIntent(context: CashRecordingContext, draft: CashRecordingDraft): CashRecordingIntent {
  try {
    if (!cashRecordingContextSchema.safeParse(context).success || context.read_only || context.account_status === "disabled"
      || !TRADE_RECORDING_ZONES.some(value => value === draft.zone)) throw new Error();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: draft.zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(context.checked_at));
    const part = (type: string) => parts.find(value => value.type === type)!.value;
    if (draft.date > `${part("year")}-${part("month")}-${part("day")}`) throw new Error();
    const intent = cashRecordingIntentSchema.parse({ action: "record_linked_cash_fact", portfolio_id: context.portfolio_id, account_id: context.account_id,
      expected_ledger_revision: context.ledger_revision, expected_account_row_version: context.account_row_version,
      expected_link_id: context.link_id, expected_link_version: context.link_version, expected_context_hash: context.context_hash,
      basis: "operator_external_cash_transcription_not_broker_file", acknowledgement: draft.acknowledged,
      source_id: draft.source, source_event_id: draft.sourceEvent, source_reference: draft.reference, effective_date: draft.date, source_timezone: draft.zone,
      entry: { type: draft.direction, currency: draft.currency, amount: draft.amount.trim() } });
    if (new TextEncoder().encode(JSON.stringify({ ...intent, expected_revision: context.workspace_revision, idempotency_key: "0".repeat(36) })).byteLength > 32768) throw new Error();
    return intent;
  } catch { throw new Error("INVESTOR_CASH_DRAFT_INVALID"); }
}
