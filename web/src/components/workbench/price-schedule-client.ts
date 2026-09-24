import { z } from "zod";
import { parseStrictJson } from "@/server/strict-json";
import { PRICE_MARKET_ZONES, priceScheduleIdSchema as id, priceScheduleDateSchema as date, priceCollectionScheduleSchema,
  savePriceCollectionScheduleSchema, setPriceCollectionScheduleStatusSchema } from "@/server/price-schedules/schemas";
import type { PriceCollectionScheduleState, PriceCollectionSlotDetail, PriceCollectionScheduleReceipt, PriceCollectionScheduleDefinition, PriceCollectionVersionView } from "@/server/price-schedules/types";

const digest = z.string().regex(/^[a-f0-9]{64}$/), stamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/);
const revision = z.number().int().safe().positive(), market = z.enum(["CN", "HK", "US"]), status = z.enum(["paused", "enabled"]);
const proof = z.object({ version_id: id, version_hash: digest, source_row_hash: digest, source_audit_hash: digest, review_audit_hash: digest }).strict();
const referenceBinding = z.object({ schema_version: z.literal("price-schedule-reference-binding-v1"), portfolio_id: id, market,
  timezone: z.string().max(40), start_date: date, end_date: date, known_at: stamp,
  mappings: z.array(proof.extend({ listing_id: id, listing_identity_hash: digest, catalog_entry_hash: digest, calendar_version_id: id }).strict()).min(1).max(4),
  calendars: z.array(proof).min(1).max(4), heads: z.array(z.object({ portfolio_id: id, kind: z.enum(["mapping", "calendar"]), scope_key: id, version: revision, version_id: id, updated_at: stamp }).strict()).min(2).max(8),
}).strict();
const version = z.object({ id, version: revision, definition_json: z.string().min(1).max(65536), definition: priceCollectionScheduleSchema,
  content_hash: digest, reference_binding_json: z.string().min(1).max(65536), reference_binding_hash: digest, reference_binding: referenceBinding,
  created_by: z.string().min(1).max(160), created_at: stamp, audit_id: id }).strict();
const schedule = z.object({ id, portfolio_id: id, scope_key: id, market, schedule_revision: revision, status, current_version: version,
  last_audit_id: id, updated_at: stamp, next_trigger_at: stamp.nullable(), next_target_date: date.nullable(), reference_status: z.enum(["current", "changed", "invalid"]) }).strict();
const slot = z.object({ id, portfolio_id: id, scope_key: id, period: date, schedule_id: id, schedule_version_id: id, authorization_audit_id: id,
  authorization_revision: revision, reference_binding_json: z.string().min(1).max(65536), reference_binding_hash: digest, scheduled_at: stamp,
  deadline_at: stamp, created_at: stamp, disposition: z.enum(["requested", "skipped", "blocked", "missed"]), reason_code: z.string().min(1).max(200).nullable(),
  command_request_id: id.nullable(), expected_publication_revision: z.number().int().safe().nonnegative().nullable(),
  job: z.object({ id, status: z.string().min(1).max(80), attempt_count: z.number().int().min(0).max(5), max_attempts: z.number().int().min(1).max(5), updated_at: stamp }).strict().nullable(),
  capture: z.object({ id, received_at: stamp, batch_id: id, receipt_hash: digest, status: z.literal("published") }).strict().nullable(),
}).strict();
const candidate = z.object({ id, kind: z.enum(["mapping", "calendar"]), market, scope_key: id, version: revision, known_at: stamp,
  content_hash: digest, listing_id: id.nullable(), provider_symbol: z.string().min(1).max(200).nullable(), exchange: id,
  range_start: date, range_end: date.nullable(), verification_status: z.literal("human_reviewed_not_provider_verified") }).strict();
const stateSchema = z.object({ schema_version: z.literal("price-collection-schedules-v1"), portfolios: z.array(z.object({ id, name: z.string().max(2000) }).strict()).max(1000),
  portfolios_truncated: z.boolean(), selected_portfolio_id: id.nullable(), read_only: z.boolean(), server_now: stamp,
  reference_candidates: z.array(candidate).max(1000), reference_candidates_truncated: z.boolean(), schedules: z.array(schedule).max(20), schedules_truncated: z.boolean(),
  slots: z.array(slot).max(50), next_cursor: z.string().min(1).max(1024).nullable(), session_binding: digest }).strict();
const detailSchema = z.object({ schema_version: z.literal("price-collection-slot-v1"), portfolio_id: id, read_only: z.boolean(), server_now: stamp,
  slot, version, attempts: z.array(z.object({ attempt: revision, status: z.string().min(1).max(80), started_at: stamp, finished_at: stamp.nullable(), error_code: z.string().min(1).max(200).nullable() }).strict()).max(5), session_binding: digest }).strict();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha = async (raw: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const unique = (values: string[]) => new Set(values).size === values.length;
function invalid(): never { throw new Error("PRICE_SCHEDULE_RESPONSE_INVALID"); }
async function verifyBinding(raw: string, expectedHash: string, portfolio: string) {
  const parsed = referenceBinding.safeParse(parseStrictJson(raw)); if (!parsed.success || await sha(raw) !== expectedHash) invalid();
  const binding = parsed.data;
  if (binding.portfolio_id !== portfolio || binding.heads.some(row => row.portfolio_id !== portfolio) || binding.timezone !== PRICE_MARKET_ZONES[binding.market]
    || !unique(binding.mappings.map(row => row.listing_id)) || !unique(binding.mappings.map(row => row.version_id)) || !unique(binding.calendars.map(row => row.version_id))
    || binding.mappings.some(row => !binding.calendars.some(calendar => calendar.version_id === row.calendar_version_id))) invalid();
  return binding;
}
async function verifyVersion(value: PriceCollectionVersionView, portfolio: string) {
  if (canonical(parseStrictJson(value.definition_json)) !== canonical(value.definition) || await sha(value.definition_json) !== value.content_hash) invalid();
  const binding = await verifyBinding(value.reference_binding_json, value.reference_binding_hash, portfolio), definition = value.definition;
  if (canonical(binding) !== canonical(value.reference_binding) || binding.market !== definition.market || binding.timezone !== definition.timezone
    || binding.start_date !== definition.start_date || binding.end_date !== definition.end_date
    || canonical(binding.mappings.map(row => row.version_id).sort()) !== canonical([...definition.mapping_version_ids].sort())
    || canonical(binding.calendars.map(row => row.version_id).sort()) !== canonical([...definition.calendar_version_ids].sort())) invalid();
  return "provider:longport:prices:" + await sha(canonical({ portfolio_id: portfolio, market: binding.market, listing_ids: binding.mappings.map(row => row.listing_id).sort() }));
}
async function verifySlot(value: z.infer<typeof slot>, portfolio: string) {
  if (value.portfolio_id !== portfolio || value.scheduled_at >= value.deadline_at) invalid();
  const binding = await verifyBinding(value.reference_binding_json, value.reference_binding_hash, portfolio);
  if (value.period < binding.start_date || value.period > binding.end_date || value.scope_key !== "provider:longport:prices:" + await sha(canonical({ portfolio_id: portfolio, market: binding.market, listing_ids: binding.mappings.map(row => row.listing_id).sort() }))) invalid();
  if (value.disposition === "requested" ? !value.command_request_id || value.expected_publication_revision === null || value.reason_code !== null
    : value.command_request_id !== null || value.expected_publication_revision !== null || value.job !== null || value.capture !== null || !value.reason_code) invalid();
  if (value.capture && (value.job?.status !== "succeeded" || value.disposition !== "requested")) invalid();
}
export async function assertPriceScheduleState(raw: unknown, portfolio: string | null, selectedSchedule: string | null, binding: string): Promise<PriceCollectionScheduleState> {
  try {
    const parsed = stateSchema.safeParse(raw); if (!parsed.success) invalid(); const data = parsed.data, p = data.selected_portfolio_id;
    if (data.session_binding !== binding || portfolio !== null && p !== portfolio || p !== null && !data.portfolios.some(row => row.id === p)
      || !unique(data.portfolios.map(row => row.id)) || !unique(data.schedules.map(row => row.id)) || !unique(data.slots.map(row => row.id)) || !unique(data.reference_candidates.map(row => row.id))
      || p === null && (data.schedules.length || data.slots.length || data.reference_candidates.length)
      || selectedSchedule !== null && data.slots.some(row => row.schedule_id !== selectedSchedule)) invalid();
    for (const row of data.schedules) {
      if (row.portfolio_id !== p || row.market !== row.current_version.definition.market || (row.next_trigger_at === null) !== (row.next_target_date === null)
        || row.status === "paused" && row.next_trigger_at !== null) invalid();
      if (row.scope_key !== await verifyVersion(row.current_version, p!)) invalid();
    }
    for (const row of data.reference_candidates) if (row.kind === "mapping" ? row.listing_id === null || row.provider_symbol === null : row.listing_id !== null || row.provider_symbol !== null || row.range_end === null) invalid();
    for (const row of data.slots) await verifySlot(row, p!);
    return data;
  } catch { return invalid(); }
}
export async function assertPriceScheduleDetail(raw: unknown, portfolio: string, slotId: string, binding: string): Promise<PriceCollectionSlotDetail> {
  try {
    const parsed = detailSchema.safeParse(raw); if (!parsed.success) invalid(); const data = parsed.data;
    if (data.session_binding !== binding || data.portfolio_id !== portfolio || data.slot.id !== slotId || data.slot.schedule_version_id !== data.version.id
      || data.slot.reference_binding_hash !== data.version.reference_binding_hash || !unique(data.attempts.map(row => String(row.attempt)))) invalid();
    await verifyVersion(data.version, portfolio); await verifySlot(data.slot, portfolio); return data;
  } catch { return invalid(); }
}
export type PriceScheduleDraft = { operation: "save" | "enabled" | "paused"; scheduleId: string; market: "" | "CN" | "HK" | "US";
  mappingIds: string[]; calendarIds: string[]; startDate: string; endDate: string; hour: string; minute: string; deadline: string; maxAttempts: string; reason: string };
export const emptyPriceScheduleDraft = (): PriceScheduleDraft => ({ operation: "save", scheduleId: "", market: "", mappingIds: [], calendarIds: [], startDate: "", endDate: "", hour: "", minute: "", deadline: "", maxAttempts: "", reason: "" });
export function draftFromDefinition(scheduleId: string, definition: PriceCollectionScheduleDefinition): PriceScheduleDraft {
  return { operation: "save", scheduleId, market: definition.market, mappingIds: [...definition.mapping_version_ids], calendarIds: [...definition.calendar_version_ids], startDate: definition.start_date,
    endDate: definition.end_date, hour: String(definition.trigger_local.hour), minute: String(definition.trigger_local.minute), deadline: String(definition.deadline_seconds), maxAttempts: String(definition.max_attempts), reason: "" };
}
export type PriceSchedulePending = { body: string; portfolio: string; binding: string; operation: PriceScheduleDraft["operation"];
  expected: Omit<PriceCollectionScheduleReceipt, "schedule_id" | "version_id"> & { schedule_id: string | null; version_id: string | null } };
export async function preparePriceScheduleAttempt(data: PriceCollectionScheduleState, draft: PriceScheduleDraft, binding: string, key: string): Promise<PriceSchedulePending> {
  if (data.read_only || !data.selected_portfolio_id || !digest.safeParse(binding).success) throw new Error("PRICE_SCHEDULE_WRITE_LOCKED");
  const selected = data.schedules.find(row => row.id === draft.scheduleId);
  if (draft.scheduleId && !selected) throw new Error("PRICE_SCHEDULE_CONFLICT");
  const common = { portfolio_id: data.selected_portfolio_id, expected_schedule_revision: selected?.schedule_revision ?? 0, idempotency_key: key, reason: draft.reason, acknowledgement: true as const };
  let command: unknown, expected: PriceSchedulePending["expected"];
  if (draft.operation === "save") {
    const number = (value: string) => /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
    const parsed = priceCollectionScheduleSchema.safeParse({ schema_version: "price-collection-schedule-v1", provider: "longport", frequency: "daily", publish: true,
      market: draft.market, timezone: draft.market ? PRICE_MARKET_ZONES[draft.market] : "", mapping_version_ids: draft.mappingIds, calendar_version_ids: draft.calendarIds,
      start_date: draft.startDate, end_date: draft.endDate, trigger_local: { hour: number(draft.hour), minute: number(draft.minute) }, deadline_seconds: number(draft.deadline), max_attempts: number(draft.maxAttempts), missed_policy: "record_no_backfill" });
    if (!parsed.success) throw new Error("PRICE_SCHEDULE_INVALID_DEFINITION");
    const definition = parsed.data, mappings = definition.mapping_version_ids.map(value => data.reference_candidates.find(row => row.id === value && row.kind === "mapping")),
      calendars = definition.calendar_version_ids.map(value => data.reference_candidates.find(row => row.id === value && row.kind === "calendar"));
    if ([...mappings, ...calendars].some(row => !row || row.market !== definition.market || row.range_start > definition.start_date
      || row.range_end !== null && (row.kind === "mapping" ? row.range_end <= definition.end_date : row.range_end < definition.end_date))
      || !unique(mappings.map(row => row!.listing_id!)) || !unique(calendars.map(row => row!.exchange))
      || mappings.some(row => !calendars.some(calendar => calendar!.exchange === row!.exchange)) || calendars.some(row => !mappings.some(mapping => mapping!.exchange === row!.exchange))) throw new Error("PRICE_SCHEDULE_REFERENCES_REQUIRED");
    const scope = "provider:longport:prices:" + await sha(canonical({ portfolio_id: data.selected_portfolio_id, market: definition.market, listing_ids: mappings.map(row => row!.listing_id!).sort() }));
    if (selected ? selected.scope_key !== scope : data.schedules.some(row => row.scope_key === scope)) throw new Error("PRICE_SCHEDULE_CONFLICT");
    const raw = JSON.stringify(definition), parsedCommand = savePriceCollectionScheduleSchema.safeParse({ ...common, expected_schedule_id: selected?.id ?? null, definition_json: raw });
    if (!parsedCommand.success || new TextEncoder().encode(raw).byteLength > 65536) throw new Error("PRICE_SCHEDULE_INVALID_COMMAND");
    command = parsedCommand.data; expected = { schedule_id: selected?.id ?? null, version_id: null, version: (selected?.current_version.version ?? 0) + 1,
      schedule_revision: common.expected_schedule_revision + 1, status: "paused", scope_key: scope, content_hash: await sha(raw) };
  } else {
    if (!selected || draft.operation === "enabled" && selected.reference_status !== "current") throw new Error("PRICE_SCHEDULE_REFERENCES_REQUIRED");
    const parsed = setPriceCollectionScheduleStatusSchema.safeParse({ ...common, schedule_id: selected.id, status: draft.operation });
    if (!parsed.success) throw new Error("PRICE_SCHEDULE_INVALID_COMMAND"); command = parsed.data;
    expected = { schedule_id: selected.id, version_id: selected.current_version.id, version: selected.current_version.version, schedule_revision: common.expected_schedule_revision + 1,
      status: draft.operation, scope_key: selected.scope_key, content_hash: selected.current_version.content_hash };
  }
  if (common.expected_schedule_revision >= 1024 || common.expected_schedule_revision >= 1023 && !(selected?.status === "enabled" && draft.operation === "paused")) throw new Error("PRICE_SCHEDULE_LIMIT_REACHED");
  return { body: JSON.stringify({ action: draft.operation === "save" ? "save_schedule" : "set_status", command }), portfolio: data.selected_portfolio_id, binding, operation: draft.operation, expected };
}
export function assertPriceScheduleReceipt(raw: unknown, pending: PriceSchedulePending): PriceCollectionScheduleReceipt {
  const parsed = z.object({ schedule_id: id, version_id: id, version: revision, schedule_revision: revision, status, scope_key: id, content_hash: digest, session_binding: digest }).strict().safeParse(raw);
  if (!parsed.success || parsed.data.session_binding !== pending.binding || Object.entries(pending.expected).some(([key, expected]) => expected !== null && parsed.data[key as keyof typeof parsed.data] !== expected)) throw new Error("PRICE_SCHEDULE_RECEIPT_INVALID");
  return parsed.data;
}
