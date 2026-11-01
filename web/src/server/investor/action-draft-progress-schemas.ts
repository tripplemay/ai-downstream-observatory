import { z } from "zod";
import { investorInstant } from "./schemas";

export const actionDraftProgressRequest = { header: "X-Workbench-Investor-View", value: "action-drafts-v1" } as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const at = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
});

export const actionDraftEntrySchema = z.object({
  symbol: z.enum(["VT.US", "BND.US"]), kind: z.enum(["div", "splits"]),
  status: z.enum(["queued", "running", "lease_expired", "indeterminate_no_retry", "closed", "captured_draft", "transport_failed", "superseded", "retention_expired"]),
  qualification: z.enum(["none", "official_transport", "synthetic_test"]),
  reason_code: z.enum(["EODHD_ACTION_DRAFT_CAPTURED", "EODHD_SLOT_NO_LONGER_CURRENT", "EODHD_CAPTURE_TRANSPORT_FAILED", "EODHD_CAPTURE_RESPONSE_INVALID", "EODHD_CAPTURE_TIMEOUT", "EODHD_CAPTURE_ROUTE_FORBIDDEN", "EODHD_CAPTURE_AUTH_FAILED", "EODHD_CAPTURE_RATE_LIMITED", "EODHD_CAPTURE_UNAVAILABLE"]).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.status === "captured_draft" || value.status === "retention_expired") && value.reason_code !== "EODHD_ACTION_DRAFT_CAPTURED"
    || value.status === "superseded" && value.reason_code !== "EODHD_SLOT_NO_LONGER_CURRENT"
    || value.status === "transport_failed" && (!value.reason_code || ["EODHD_ACTION_DRAFT_CAPTURED", "EODHD_SLOT_NO_LONGER_CURRENT"].includes(value.reason_code))
    || !["captured_draft", "retention_expired", "transport_failed", "superseded"].includes(value.status) && (value.reason_code !== null || value.qualification !== "none")
    || ["captured_draft", "retention_expired", "transport_failed", "superseded"].includes(value.status) && value.qualification === "none")
    context.addIssue({ code: "custom", message: "Invalid draft metadata state" });
});

export const actionDraftProgressSchema = z.object({
  schema_version: z.literal("investor-action-draft-progress-v1"), checked_at: investorInstant, refresh_after: investorInstant,
  status: z.enum(["not_configured", "future", "disabled", "expired", "waiting_scheduler", "visible", "unavailable"]),
  valid_from: investorInstant.nullable(), valid_until: investorInstant.nullable(), latest_source_day: date.nullable(),
  entries: z.array(actionDraftEntrySchema).max(4),
  evidence_scope: z.literal("task_metadata_not_payload_verification"), provider_online_verified: z.literal(false),
  corporate_actions_complete: z.literal(false), research_admitted: z.literal(false), live_advice_eligible: z.literal(false),
}).strict().superRefine((value, context) => {
  const bad = value.refresh_after <= value.checked_at || Date.parse(value.refresh_after) > Date.parse(value.checked_at) + 60000
    || value.latest_source_day !== null && value.latest_source_day > value.checked_at.slice(0, 10)
    || value.valid_from !== null && (value.valid_until === null || value.valid_from >= value.valid_until)
    || (value.status === "visible") !== (value.entries.length === 4 && value.latest_source_day !== null)
    || value.status !== "visible" && (value.entries.length !== 0 || value.latest_source_day !== null)
    || ["not_configured", "unavailable"].includes(value.status) && (value.valid_from !== null || value.valid_until !== null)
    || !["not_configured", "unavailable"].includes(value.status) && (value.valid_from === null || value.valid_until === null)
    || value.status === "future" && value.valid_from! <= value.checked_at
    || value.status === "expired" && value.valid_until! > value.checked_at
    || ["visible", "waiting_scheduler"].includes(value.status) && (value.valid_from! > value.checked_at || value.valid_until! <= value.checked_at)
    || new Set(value.entries.map(row => row.symbol + ":" + row.kind)).size !== value.entries.length;
  if (bad) context.addIssue({ code: "custom", message: "Invalid draft progress" });
});
export type ActionDraftProgress = z.infer<typeof actionDraftProgressSchema>;
