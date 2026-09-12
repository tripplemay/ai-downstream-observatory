import { z } from "zod";
import { parseStrictJson } from "@/server/strict-json";
import { collectionScheduleSchema } from "@/server/market-schedules/schemas";
import type { CollectionScheduleReceipt, CollectionScheduleState } from "@/server/market-schedules/types";

const id = z.string().min(1).max(160), stamp = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/), digest = z.string().regex(/^[a-f0-9]{64}$/), revision = z.number().int().safe().positive();
const version = z.object({ id, version: revision, definition_json: z.string().min(1).max(65536), definition: collectionScheduleSchema, content_hash: digest, created_by: id, created_at: stamp, audit_id: id }).strict();
const slot = z.object({ id, portfolio_id: id, scope_key: id, period: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/), schedule_id: id, schedule_version_id: id, authorization_audit_id: id, authorization_revision: revision, scheduled_at: stamp, deadline_at: stamp, created_at: stamp, disposition: z.enum(["requested", "missed"]), reason_code: z.enum(["DEADLINE_EXPIRED", "AUTHORIZATION_ENDED"]).nullable(), command_request_id: id.nullable(), expected_publication_revision: z.number().int().safe().nonnegative().nullable(), job: z.object({ id, status: z.string().min(1).max(40), attempt_count: z.number().int().min(0).max(5), max_attempts: z.number().int().min(1).max(5), updated_at: stamp }).strict().nullable(), capture: z.object({ id, received_at: stamp, rate_date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).nullable(), batch_id: id, receipt_hash: digest, status: z.literal("published") }).strict().nullable() }).strict();
const stateSchema = z.object({ schema_version: z.literal("collection-schedules-v1"), portfolios: z.array(z.object({ id, name: z.string().max(2000) }).strict()).max(1000), portfolios_truncated: z.boolean(), selected_portfolio_id: id.nullable(), read_only: z.boolean(), server_now: stamp, schedules: z.array(z.object({ id, portfolio_id: id, scope_key: id, schedule_revision: revision, status: z.enum(["paused", "enabled"]), current_version: version, last_audit_id: id, updated_at: stamp, next_trigger_at: stamp.nullable() }).strict()).max(20), schedules_truncated: z.boolean(), slots: z.array(slot).max(50), next_cursor: z.string().max(1024).nullable(), session_binding: digest }).strict();
export function assertCollectionState(raw: unknown, portfolio: string | null, binding: string): asserts raw is CollectionScheduleState & { session_binding: string } {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success || parsed.data.session_binding !== binding || (portfolio !== null && parsed.data.selected_portfolio_id !== portfolio) || parsed.data.schedules.some(row => row.portfolio_id !== parsed.data.selected_portfolio_id) || parsed.data.slots.some(row => row.portfolio_id !== parsed.data.selected_portfolio_id)) throw new Error("COLLECTION_RESPONSE_INVALID");
}
export type CollectionDraft = { operation: "save" | "enabled" | "paused"; scheduleId: string; definitionJson: string; reason: string };
export const emptyCollectionDraft = (): CollectionDraft => ({ operation: "save", scheduleId: "", definitionJson: "", reason: "" });
export type CollectionPending = { body: string; portfolio: string; binding: string; operation: CollectionDraft["operation"]; expected: Omit<CollectionScheduleReceipt, "schedule_id" | "version_id"> & { schedule_id: string | null; version_id: string | null } };
export async function prepareCollectionAttempt(state: CollectionScheduleState, draft: CollectionDraft, binding: string, key: string): Promise<CollectionPending> {
  if (state.read_only || !state.selected_portfolio_id || !digest.safeParse(binding).success || !id.safeParse(key).success) throw new Error("COLLECTION_WRITE_LOCKED");
  if (!draft.reason.trim() || draft.reason.length > 2000) throw new Error("COLLECTION_REASON_REQUIRED");
  const selected = state.schedules.find(row => row.id === draft.scheduleId);
  if (draft.scheduleId && !selected) throw new Error("COLLECTION_SCHEDULE_CONFLICT");
  const common = { portfolio_id: state.selected_portfolio_id, expected_schedule_revision: selected?.schedule_revision ?? 0, idempotency_key: key, reason: draft.reason, acknowledgement: true };
  if (common.expected_schedule_revision >= Number.MAX_SAFE_INTEGER) throw new Error("COLLECTION_SCHEDULE_CONFLICT");
  if (common.expected_schedule_revision >= 1024 || (common.expected_schedule_revision >= 1023 && !(selected?.status === "enabled" && draft.operation === "paused"))) throw new Error("COLLECTION_LIMIT_REACHED");
  let command: unknown, expected: CollectionPending["expected"];
  if (draft.operation === "save") {
    const bytes = new TextEncoder().encode(draft.definitionJson); let definition;
    try { if (bytes.length > 65536 || new TextDecoder().decode(bytes) !== draft.definitionJson) throw new Error(); definition = collectionScheduleSchema.parse(parseStrictJson(draft.definitionJson)); } catch { throw new Error("COLLECTION_INVALID_DEFINITION"); }
    const scope = `provider:ecb:fx:daily:${[...definition.currencies].sort().join("-")}`;
    if ((selected && selected.scope_key !== scope) || (!selected && state.schedules.some(row => row.scope_key === scope))) throw new Error("COLLECTION_SCHEDULE_CONFLICT");
    const contentHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    command = { ...common, expected_schedule_id: selected?.id ?? null, definition_json: draft.definitionJson };
    expected = { schedule_id: selected?.id ?? null, version_id: null, version: (selected?.current_version.version ?? 0) + 1, schedule_revision: common.expected_schedule_revision + 1, status: "paused", scope_key: scope, content_hash: contentHash };
  } else {
    if (!selected) throw new Error("COLLECTION_SCHEDULE_CONFLICT");
    command = { ...common, schedule_id: selected.id, status: draft.operation };
    expected = { schedule_id: selected.id, version_id: selected.current_version.id, version: selected.current_version.version, schedule_revision: common.expected_schedule_revision + 1, status: draft.operation, scope_key: selected.scope_key, content_hash: selected.current_version.content_hash };
  }
  return { body: JSON.stringify({ action: draft.operation === "save" ? "save_collection_schedule" : "set_collection_schedule_status", command }), portfolio: state.selected_portfolio_id, binding, operation: draft.operation, expected };
}
export function assertCollectionReceipt(raw: unknown, attempt: CollectionPending) {
  const parsed = z.object({ schedule_id: id, version_id: id, version: revision, schedule_revision: revision, status: z.enum(["paused", "enabled"]), scope_key: id, content_hash: digest, session_binding: digest }).strict().safeParse(raw);
  if (!parsed.success || parsed.data.session_binding !== attempt.binding || Object.entries(attempt.expected).some(([key, expected]) => expected !== null && parsed.data[key as keyof typeof parsed.data] !== expected)) throw new Error("COLLECTION_RECEIPT_INVALID");
}
