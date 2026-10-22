import { z } from "zod";
import { tradeRecordingDate, tradeEvidenceNotFuture } from "./trade-recording-schemas";
import { reconciliationInstantMicros } from "../ledger/reconciliation-schemas";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/), revision = z.number().int().safe().nonnegative();
const clockInstant = z.string().datetime({ precision: 3 }), instant = z.string().max(40).refine(value => reconciliationInstantMicros(value) !== null);
const currency = z.string().regex(/^[A-Z]{3}$/);
const decimal = z.string().max(80).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const positive = decimal.refine(value => /[1-9]/.test(value));
const source = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/);
const deviations = z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)).max(20);
export const executionFollowupBasis = "owner_selected_execution_evidence_not_broker_verified" as const;
const scope = z.object({ portfolio_id: id, account_id: id, expected_ledger_revision: revision, expected_account_row_version: revision,
  expected_link_id: id, expected_link_version: revision.positive(), expected_context_hash: hash,
  basis: z.literal(executionFollowupBasis), acknowledgement: z.literal(true) });
export const linkExecutionIntentSchema = scope.extend({ action: z.literal("link_recorded_execution_fact"),
  event_id: id, proposal_item_id: id, attachment_id: id }).strict();
export const executionReportIntentSchema = scope.extend({ action: z.literal("record_linked_execution_report"),
  proposal_item_id: id, attachment_id: id, source_id: source, source_event_id: source,
  status: z.enum(["submitted", "partial", "filled", "cancelled", "rejected"]), reported_quantity: decimal,
  reason: z.string().trim().min(1).max(500) }).strict();
export const executionUploadScopeSchema = scope.omit({ basis: true, acknowledgement: true }).extend({
  expected_workspace_revision: revision.positive() }).strict();
export const executionEvidenceReceiptSchema = z.object({ schema_version: z.literal("investor-execution-evidence-v1"), workspace_id: id,
  portfolio_id: id, account_id: id, attachment_id: id, content_hash: hash, byte_size: revision.positive().max(4 * 1024 * 1024),
  media_type: z.enum(["application/json", "text/csv"]), audit_id: id }).strict();
export const executionFollowupContextSchema = z.object({ schema_version: z.literal("investor-execution-followup-v1"),
  workspace_id: id, workspace_revision: revision.positive(), portfolio_id: id, ledger_revision: revision,
  link_id: id, link_version: revision.positive(), account_id: id, account_row_version: revision,
  account_status: z.enum(["active", "disabled", "reconciliation_required"]), read_only: z.boolean(), checked_at: clockInstant, context_hash: hash,
  items: z.array(z.object({ id, proposal_id: id, listing_id: id, ticker: z.string().min(1).max(120), market: z.enum(["CN", "HK", "US"]),
    side: z.enum(["buy", "sell"]), currency, quantity: positive, limit_price: positive, estimated_fees: decimal,
    created_at: instant, expires_at: instant }).strict()).max(200),
  facts: z.array(z.object({ event_id: id, listing_id: id, side: z.enum(["buy", "sell"]), currency, quantity: positive,
    consideration: positive, fee: decimal, effective_at: z.union([instant, z.string().refine(tradeRecordingDate)]),
    source_timezone: z.string().min(1).max(100), recorded_at: instant, source_id: z.string().min(1).max(200),
    source_event_id: z.string().max(200).nullable(),
    link: z.object({ proposal_item_id: id, attachment_id: id, consumed: z.boolean(), deviations, recorded_at: instant }).strict().nullable() }).strict()).max(200),
  evidence: z.array(z.object({ id, content_hash: hash, byte_size: revision.max(4 * 1024 * 1024),
    media_type: z.enum(["application/json", "text/csv"]), created_at: instant }).strict()).max(50),
  reports: z.array(z.object({ id, proposal_item_id: id, status: executionReportIntentSchema.shape.status,
    source_id: z.string().min(1).max(200), source_event_id: z.string().min(1).max(200), reason: z.string().min(1).max(2000),
    attachment_id: id, reported_quantity: decimal, deviations, recorded_at: instant, fact_confirmed: z.literal(false) }).strict()).max(200),
  basis: z.literal(executionFollowupBasis), execution_authorized: z.literal(false), broker_ordering_enabled: z.literal(false),
}).strict().superRefine((value, context) => {
  const later = (left: string, right: string) => {
    const a = reconciliationInstantMicros(left), b = reconciliationInstantMicros(right);
    return a !== null && b !== null && a > b;
  };
  for (const rows of [value.items.map(row => row.id), value.facts.map(row => row.event_id), value.evidence.map(row => row.id), value.reports.map(row => row.id)])
    if (new Set(rows).size !== rows.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "DUPLICATE_EXECUTION_ROWS" });
  if (value.items.some(row => later(row.created_at, value.checked_at) || !later(row.expires_at, row.created_at))
    || value.evidence.some(row => later(row.created_at, value.checked_at))
    || value.reports.some(row => later(row.recorded_at, value.checked_at))
    || value.facts.some(row => later(row.recorded_at, value.checked_at) || !tradeEvidenceNotFuture(row.effective_at, row.source_timezone, row.recorded_at)
      || row.link && (later(row.link.recorded_at, value.checked_at)
      || !value.items.some(item => item.id === row.link!.proposal_item_id && item.listing_id === row.listing_id && item.side === row.side && item.currency === row.currency)))
    || value.reports.some(row => !value.items.some(item => item.id === row.proposal_item_id)))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_EXECUTION_CLOCK_OR_BINDING" });
});
export type ExecutionFollowupContext = z.infer<typeof executionFollowupContextSchema>;
export type LinkExecutionIntent = z.infer<typeof linkExecutionIntentSchema>;
export type ExecutionReportIntent = z.infer<typeof executionReportIntentSchema>;
