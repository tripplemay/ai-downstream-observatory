import { z } from "zod";
import { TRADE_RECORDING_ZONES, tradeRecordingDate } from "./trade-recording-schemas";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/), revision = z.number().int().nonnegative().safe();
const sourceId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/);
export const CASH_RECORDING_CURRENCIES = ["CNY", "HKD", "USD"] as const;
export const cashRecordingIntentSchema = z.object({ action: z.literal("record_linked_cash_fact"), portfolio_id: id, account_id: id,
  expected_ledger_revision: revision, expected_account_row_version: revision, expected_link_id: id,
  expected_link_version: revision.refine(value => value > 0), expected_context_hash: hash,
  basis: z.literal("operator_external_cash_transcription_not_broker_file"), acknowledgement: z.literal(true),
  source_id: sourceId, source_event_id: sourceId, source_reference: z.string().trim().min(1).max(500),
  effective_date: z.string().refine(tradeRecordingDate), source_timezone: z.enum(TRADE_RECORDING_ZONES),
  entry: z.object({ type: z.enum(["deposit", "withdrawal"]), currency: z.enum(CASH_RECORDING_CURRENCIES),
    amount: z.string().regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/).refine(value => /[1-9]/.test(value)) }).strict(),
}).strict();
export const cashRecordingContextSchema = z.object({ schema_version: z.literal("investor-cash-recording-v1"), workspace_id: id,
  workspace_revision: revision.refine(value => value > 0), portfolio_id: id, ledger_revision: revision, link_id: id,
  link_version: revision.refine(value => value > 0), account_id: id, account_row_version: revision,
  account_status: z.enum(["active", "disabled", "reconciliation_required"]), base_currency: z.string().regex(/^[A-Z]{3}$/),
  checked_at: z.string().datetime({ precision: 3 }), read_only: z.boolean(), context_hash: hash,
  allowed_currencies: z.tuple([z.literal("CNY"), z.literal("HKD"), z.literal("USD")]),
  basis: z.literal("metadata_only_no_fact_prefill"), execution_authorized: z.literal(false),
}).strict();
export type CashRecordingContext = z.infer<typeof cashRecordingContextSchema>;
export type CashRecordingIntent = z.infer<typeof cashRecordingIntentSchema>;
