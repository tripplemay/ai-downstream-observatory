import { z } from "zod";
import { executionEvidenceReceiptSchema, executionFollowupBasis, executionFollowupContextSchema, executionReportIntentSchema,
  linkExecutionIntentSchema, type ExecutionFollowupContext } from "@/server/investor/execution-followup-schemas";
import type { ReconciliationScope } from "./investor-reconciliation-client";

const binding = z.string().regex(/^[a-f0-9]{64}$/);
const response = executionFollowupContextSchema.innerType().extend({ session_binding: binding }).strict();
export function parseExecutionFollowup(value: unknown, expected: ReconciliationScope) {
  const parsed = response.parse(value), { session_binding, ...body } = parsed, context = executionFollowupContextSchema.parse(body);
  if (session_binding !== expected.binding || context.workspace_id !== expected.workspace || context.workspace_revision !== expected.revision
    || context.portfolio_id !== expected.portfolio || context.ledger_revision !== expected.ledgerRevision || context.link_id !== expected.linkId
    || context.link_version !== expected.linkVersion || context.account_id !== expected.accountId || context.account_row_version !== expected.accountRowVersion)
    throw new Error("INVESTOR_EXECUTION_RESPONSE_INVALID");
  return context;
}
export function executionScope(context: ExecutionFollowupContext) {
  return { portfolio_id: context.portfolio_id, account_id: context.account_id, expected_ledger_revision: context.ledger_revision,
    expected_account_row_version: context.account_row_version, expected_link_id: context.link_id, expected_link_version: context.link_version,
    expected_context_hash: context.context_hash };
}
export type ExecutionDraft = { mode: "link" | "report"; item: string; fact: string; evidence: string;
  status: string; quantity: string; source: string; sourceEvent: string; reason: string; acknowledged: boolean };
export function blankExecutionDraft(mode: ExecutionDraft["mode"]): ExecutionDraft {
  return { mode, item: "", fact: "", evidence: "", status: "", quantity: "", source: "", sourceEvent: "", reason: "", acknowledged: false };
}
export function buildExecutionFollowup(context: ExecutionFollowupContext, draft: ExecutionDraft) {
  executionFollowupContextSchema.parse(context);
  if (context.read_only || context.account_status === "disabled") throw new Error("INVESTOR_EXECUTION_DRAFT_INVALID");
  const item = context.items.find(row => row.id === draft.item), fact = context.facts.find(row => row.event_id === draft.fact);
  if (!item || !context.evidence.some(row => row.id === draft.evidence)) throw new Error("INVESTOR_EXECUTION_DRAFT_INVALID");
  const scope = { ...executionScope(context), basis: executionFollowupBasis, acknowledgement: draft.acknowledged, proposal_item_id: item.id, attachment_id: draft.evidence };
  const result = draft.mode === "report" ? executionReportIntentSchema.parse({ ...scope, action: "record_linked_execution_report",
    status: draft.status, reported_quantity: draft.quantity.trim(), source_id: draft.source, source_event_id: draft.sourceEvent, reason: draft.reason })
    : linkExecutionIntentSchema.parse({ ...scope, action: "link_recorded_execution_fact", event_id: fact?.event_id });
  if (draft.mode === "link" && (!fact || fact.listing_id !== item.listing_id || fact.currency !== item.currency || fact.side !== item.side || fact.link
    && (fact.link.proposal_item_id !== item.id || fact.link.attachment_id !== draft.evidence))) throw new Error("INVESTOR_EXECUTION_DRAFT_INVALID");
  if (new TextEncoder().encode(JSON.stringify({ ...result, expected_revision: context.workspace_revision, idempotency_key: "0".repeat(36) })).length > 32768)
    throw new Error("INVESTOR_EXECUTION_DRAFT_INVALID");
  return result;
}
export type EvidenceUpload = { scope: ReturnType<typeof executionScope> & { expected_workspace_revision: number }; idempotency_key: string;
  bytes: ArrayBuffer; content_hash: string; media_type: "application/json" | "text/csv"; workspace: string };
export async function prepareExecutionUpload(context: ExecutionFollowupContext, file: File, idempotencyKey: string): Promise<EvidenceUpload> {
  executionFollowupContextSchema.parse(context);
  if (context.read_only || context.account_status === "disabled" || !file.size || file.size > 4 * 1024 * 1024
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(idempotencyKey) || !/\.(csv|json)$/i.test(file.name)) throw new Error("INVESTOR_EXECUTION_UPLOAD_INVALID");
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size) throw new Error("INVESTOR_EXECUTION_UPLOAD_INVALID");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return { scope: { ...executionScope(context), expected_workspace_revision: context.workspace_revision }, idempotency_key: idempotencyKey,
    bytes, content_hash: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join(""),
    media_type: /\.csv$/i.test(file.name) ? "text/csv" : "application/json", workspace: context.workspace_id };
}
export function executionUploadForm(upload: EvidenceUpload) {
  const body = new FormData(); body.set("scope", JSON.stringify(upload.scope)); body.set("idempotency_key", upload.idempotency_key);
  body.set("media_type", upload.media_type);
  body.set("file", new Blob([upload.bytes], { type: upload.media_type }), upload.media_type === "text/csv" ? "evidence.csv" : "evidence.json");
  return body;
}
export function parseExecutionEvidenceReceipt(value: unknown, upload: EvidenceUpload, expectedBinding: string) {
  const parsed = executionEvidenceReceiptSchema.extend({ session_binding: binding }).strict().parse(value);
  if (parsed.session_binding !== expectedBinding || parsed.workspace_id !== upload.workspace || parsed.portfolio_id !== upload.scope.portfolio_id
    || parsed.account_id !== upload.scope.account_id || parsed.content_hash !== upload.content_hash || parsed.byte_size !== upload.bytes.byteLength
    || parsed.media_type !== upload.media_type) throw new Error("INVESTOR_EXECUTION_RESPONSE_INVALID");
  return parsed;
}
export function executionDeviationMessage(code: string) {
  const labels: Record<string, string> = {
    FACT_AFTER_TERMINAL_OR_EXPIRY: "关联时原清单已取消或到期，不能据此继续执行。",
    FACT_AGAINST_STALE_PROPOSAL: "关联时账本版本已变化；这不追认过去交易在当时获得授权。",
    EXECUTION_PRICE_OUTSIDE_LIMIT: "已记成交价格超出原清单的限价范围。",
    NO_ACTIVE_RESERVATION: "没有有效剩余预占可供核销，关联没有新建预占。",
    FACT_EXCEEDS_RESERVED_QUANTITY: "成交数量超过剩余预占，只核销原有余量，超出部分保留偏离。",
    FACT_PREDATES_PROPOSAL: "成交日期早于原清单，不核销其预占。",
    SUPERSEDED_FACT_NOT_CONSUMED: "原事实已被更正，未核销预占。",
    REPORTED_AFTER_TERMINAL_OR_EXPIRY: "登记回报时原清单已终止或到期；回报不能恢复交易权限。",
    REPORTED_QUANTITY_EXCEEDS_PROPOSAL: "回报数量超过原清单数量，仍不视为新增成交。",
    REPORTED_WITHOUT_APPROVAL: "未找到原清单的人工批准记录；回报不能补成批准。",
  };
  return labels[code] ?? "存在其他已登记偏离，请展开原始标识复核，不能推定可执行。";
}
