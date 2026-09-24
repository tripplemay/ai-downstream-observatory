import { createHash } from "node:crypto";
import type { PriceCollectionScheduleDefinition, PriceCollectionScheduleState, PriceCollectionSlotDetail, PriceCollectionVersionView, PriceScheduleReferenceBinding } from "../src/server/price-schedules/types";
import type { PriceScheduleDraft } from "../src/components/workbench/price-schedule-client";

export const priceBinding = "a".repeat(64), priceOtherBinding = "b".repeat(64), stamp = "2030-01-01T00:00:00.000000Z";
export const rawHash = (raw: string) => createHash("sha256").update(raw).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, row]) => `${JSON.stringify(key)}:${canonical(row)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const priceDefinition = (): PriceCollectionScheduleDefinition => ({ schema_version: "price-collection-schedule-v1", provider: "longport", frequency: "daily", publish: true,
  market: "HK", timezone: "Asia/Hong_Kong", mapping_version_ids: ["mapping-synthetic"], calendar_version_ids: ["calendar-synthetic"], start_date: "2030-01-02", end_date: "2030-01-04",
  trigger_local: { hour: 2, minute: 5 }, deadline_seconds: 600, max_attempts: 2, missed_policy: "record_no_backfill" });
export const priceDraft = (): PriceScheduleDraft => ({ operation: "save", scheduleId: "", market: "HK", mappingIds: ["mapping-synthetic"], calendarIds: ["calendar-synthetic"],
  startDate: "2030-01-02", endDate: "2030-01-04", hour: "2", minute: "5", deadline: "600", maxAttempts: "2", reason: "SYNTHETIC EXPLICIT FINITE AUTHORIZATION" });
export function priceVersion(portfolio = "p"): PriceCollectionVersionView {
  const definition = priceDefinition(), proof = { version_hash: "c".repeat(64), source_row_hash: "d".repeat(64), source_audit_hash: "e".repeat(64), review_audit_hash: "f".repeat(64) };
  const binding: PriceScheduleReferenceBinding = { schema_version: "price-schedule-reference-binding-v1", portfolio_id: portfolio, market: "HK", timezone: "Asia/Hong_Kong", start_date: definition.start_date, end_date: definition.end_date,
    known_at: stamp, mappings: [{ ...proof, version_id: "mapping-synthetic", listing_id: "listing-synthetic", listing_identity_hash: "e".repeat(64), catalog_entry_hash: "f".repeat(64), calendar_version_id: "calendar-synthetic" }],
    calendars: [{ ...proof, version_id: "calendar-synthetic" }], heads: [{ portfolio_id: portfolio, kind: "mapping", scope_key: "listing-synthetic", version: 1, version_id: "mapping-synthetic", updated_at: stamp },
      { portfolio_id: portfolio, kind: "calendar", scope_key: "HK:SYNTHETIC", version: 1, version_id: "calendar-synthetic", updated_at: stamp }] };
  const definition_json = JSON.stringify(definition), reference_binding_json = canonical(binding);
  return { id: "version-synthetic", version: 1, definition_json, definition, content_hash: rawHash(definition_json), reference_binding_json, reference_binding_hash: rawHash(reference_binding_json), reference_binding: binding,
    created_by: "synthetic-owner", created_at: stamp, audit_id: "audit-synthetic" };
}
export function priceState(portfolio = "p", saved = false, withSlot = false): PriceCollectionScheduleState {
  const version = priceVersion(portfolio), scope = "provider:longport:prices:" + rawHash(canonical({ portfolio_id: portfolio, market: "HK", listing_ids: ["listing-synthetic"] }));
  return { schema_version: "price-collection-schedules-v1", portfolios: [{ id: "p", name: "SYNTHETIC SCOPE A" }, { id: "q", name: "SYNTHETIC SCOPE B" }], portfolios_truncated: false, selected_portfolio_id: portfolio,
    read_only: false, server_now: stamp, reference_candidates_truncated: false,
    reference_candidates: [{ id: "mapping-synthetic", kind: "mapping", market: "HK", scope_key: "listing-synthetic", version: 1, known_at: stamp, content_hash: "c".repeat(64), listing_id: "listing-synthetic", provider_symbol: "SYNTHETIC.HK", exchange: "SYNTHETIC", range_start: "2030-01-01", range_end: null, verification_status: "human_reviewed_not_provider_verified" },
      { id: "calendar-synthetic", kind: "calendar", market: "HK", scope_key: "HK:SYNTHETIC", version: 1, known_at: stamp, content_hash: "c".repeat(64), listing_id: null, provider_symbol: null, exchange: "SYNTHETIC", range_start: "2030-01-01", range_end: "2030-01-31", verification_status: "human_reviewed_not_provider_verified" }],
    schedules: saved ? [{ id: "schedule-synthetic", portfolio_id: portfolio, scope_key: scope, market: "HK", schedule_revision: 1, status: "paused", current_version: version, last_audit_id: "audit-synthetic", updated_at: stamp, next_trigger_at: null, next_target_date: null, reference_status: "current" }] : [], schedules_truncated: false,
    slots: withSlot ? [{ id: "slot-synthetic", portfolio_id: portfolio, scope_key: scope, period: "2030-01-02", schedule_id: "schedule-synthetic", schedule_version_id: version.id, authorization_audit_id: "authorization-synthetic", authorization_revision: 2,
      reference_binding_json: version.reference_binding_json, reference_binding_hash: version.reference_binding_hash, scheduled_at: "2030-01-02T18:05:00.000000Z", deadline_at: "2030-01-02T18:15:00.000000Z", created_at: "2030-01-02T18:05:00.000000Z", disposition: "requested", reason_code: null, command_request_id: "command-synthetic", expected_publication_revision: 0,
      job: { id: "job-synthetic", status: "succeeded", attempt_count: 1, max_attempts: 2, updated_at: "2030-01-02T18:05:05.000000Z" }, capture: { id: "capture-synthetic", received_at: "2030-01-02T18:05:04.000000Z", batch_id: "batch-synthetic", receipt_hash: "c".repeat(64), status: "published" } }] : [], next_cursor: null };
}
export function priceDetail(portfolio = "p"): PriceCollectionSlotDetail {
  const state = priceState(portfolio, true, true);
  return { schema_version: "price-collection-slot-v1", portfolio_id: portfolio, read_only: false, server_now: stamp, slot: state.slots[0], version: state.schedules[0].current_version,
    attempts: [{ attempt: 1, status: "succeeded", started_at: "2030-01-02T18:05:00.000000Z", finished_at: "2030-01-02T18:05:05.000000Z", error_code: null }] };
}
export function priceReceipt(body: string, binding = priceBinding) {
  const { action, command } = JSON.parse(body), definition = action === "save_schedule" ? JSON.parse(command.definition_json) : priceDefinition();
  return { schedule_id: command.expected_schedule_id ?? command.schedule_id ?? "schedule-synthetic", version_id: "version-synthetic", version: 1,
    schedule_revision: command.expected_schedule_revision + 1, status: action === "save_schedule" ? "paused" : command.status,
    scope_key: "provider:longport:prices:" + rawHash(canonical({ portfolio_id: command.portfolio_id, market: definition.market, listing_ids: ["listing-synthetic"] })),
    content_hash: rawHash(action === "save_schedule" ? command.definition_json : JSON.stringify(definition)), session_binding: binding };
}
