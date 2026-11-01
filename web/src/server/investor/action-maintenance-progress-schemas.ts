import { z } from "zod";
import { investorInstant } from "./schemas";

export const actionMaintenanceProgressRequest = { header: "X-Workbench-Investor-View", value: "action-drafts-v2" } as const;
const day = z.iso.date();
export const actionMaintenanceReasonSchema = z.enum([
  "NEW_REPORTED_ACTION", "HISTORICAL_RECORDS_CHANGED", "CURRENT_SOURCE_UNAVAILABLE", "SOURCE_CAPTURE_TERMINAL_FAILURE",
  "MAINTENANCE_WINDOW_MISSED", "AUTHORITY_INPUTS_CHANGED", "RULE_INPUTS_REJECTED", "SOURCE_PERMISSION_CHANGED",
  "SOURCE_RETENTION_EXPIRED", "SOURCE_PAYLOAD_PURGED", "BASE_REVIEW_CHANGED", "BASE_REVIEW_EXPIRED", "RULE_CONTROL_CHANGED",
]);
export const actionMaintenanceEntrySchema = z.object({
  symbol: z.enum(["VT.US", "BND.US"]), enabled: z.boolean(),
  state: z.enum(["future", "disabled", "expired", "waiting_sources", "waiting_next_window", "coverage_recorded", "coverage_unchanged", "needs_review", "source_unavailable"]),
  valid_from: investorInstant, valid_until: investorInstant,
  last_source_day: day.nullable(), last_result_at: investorInstant.nullable(),
  coverage_source_day: day.nullable(), coverage_end: day.nullable(), coverage_recorded_at: investorInstant.nullable(),
  reason_code: actionMaintenanceReasonSchema.nullable(),
}).strict();
export const actionMaintenanceProgressSchema = z.object({
  schema_version: z.literal("investor-action-maintenance-progress-v1"), checked_at: investorInstant, refresh_after: investorInstant,
  status: z.enum(["not_configured", "visible", "unavailable"]), entries: z.array(actionMaintenanceEntrySchema).max(2),
  scope: z.literal("workspace_registered_fixed_rules"),
  coverage_basis: z.literal("selected_two_source_reports_not_objective_absence"),
  evidence_scope: z.literal("standing_rule_metadata_not_payload_verification"),
  provider_online_verified: z.literal(false), raw_evidence_replayed_by_this_view: z.literal(false),
  research_admitted_by_this_view: z.literal(false), human_review_performed_today: z.literal(false), trading_permission: z.literal(false),
}).strict().superRefine((value, context) => {
  const now = Date.parse(value.checked_at);
  let bad = Date.parse(value.refresh_after) <= now || Date.parse(value.refresh_after) > now + 60000
    || (value.status === "visible") !== (value.entries.length > 0)
    || new Set(value.entries.map(row => row.symbol)).size !== value.entries.length;
  for (const row of value.entries) {
    const coverage = [row.coverage_source_day, row.coverage_end, row.coverage_recorded_at];
    const effective = row.enabled && Date.parse(row.valid_from) <= now && now < Date.parse(row.valid_until);
    bad ||= Date.parse(row.valid_from) >= Date.parse(row.valid_until)
      || coverage.some(v => v === null) && coverage.some(v => v !== null)
      || row.coverage_end !== null && row.coverage_end >= row.coverage_source_day!
      || [row.last_result_at, row.coverage_recorded_at].some(v => v !== null && Date.parse(v) > now)
      || [row.last_source_day, row.coverage_source_day].some(v => v !== null && v > value.checked_at.slice(0, 10))
      || row.state === "disabled" && row.enabled || row.state === "future" && Date.parse(row.valid_from) <= now
      || row.state === "expired" && Date.parse(row.valid_until) > now
      || ["waiting_sources", "waiting_next_window", "coverage_recorded", "coverage_unchanged", "source_unavailable"].includes(row.state) && !effective
      || row.state === "coverage_recorded" && row.coverage_end === null
      || ["needs_review", "source_unavailable"].includes(row.state) !== (row.reason_code !== null);
  }
  if (bad) context.addIssue({ code: "custom", message: "Invalid action maintenance metadata" });
});
export type ActionMaintenanceProgress = z.infer<typeof actionMaintenanceProgressSchema>;
export type ActionMaintenanceEntry = z.infer<typeof actionMaintenanceEntrySchema>;
