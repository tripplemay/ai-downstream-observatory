import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
const denied = { economics_independently_replayed: z.literal(false), parameters_independently_preregistered: z.literal(false),
  actual_arrivals_confirmed: z.literal(false), execution_authorized: z.literal(false), live_advice_eligible: z.literal(false) };
export const fundedStudyRequestSchema = z.object({ schema_version: z.literal("investor-funded-study-request-v1"),
  workspace_id: id, profile_id: id, profile_hash: digest, funding_plan_id: id, funding_plan_hash: digest,
  source_head_id: id.nullable(), evidence_input_id: id.nullable(), input_hash: digest.nullable(), comparison_declared_at: at,
  window_selection: z.literal("earliest_complete_same_calendar_anchor_v1"), historical_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  candidate_hashes: z.array(digest).max(8), reason_codes: z.array(code).max(8), ...denied,
}).strict().refine(value => (value.source_head_id === null) === (value.input_hash === null)
  && (value.evidence_input_id === null || value.evidence_input_id === value.source_head_id)
  && (value.reason_codes.length === 0 ? value.historical_start_date !== null && value.candidate_hashes.length > 0 && value.evidence_input_id !== null
    : value.historical_start_date === null && value.candidate_hashes.length === 0)
  && value.candidate_hashes.every((hash, index) => index === 0 || value.candidate_hashes[index - 1] < hash));
export const fundedStudyRunSchema = z.object({ schema_version: z.literal("investor-funded-study-run-v1"),
  request_id: id, input_version: digest, implementation_hash: digest, created_at: at,
  status: z.enum(["blocked", "calculated_unverified", "failed"]), reason_codes: z.array(code).min(1).max(8),
  candidates: z.array(z.object({ parameters_hash: digest, input_hash: digest, projection_hash: digest,
    result_hash: digest.nullable(), status: z.enum(["calculated_unverified", "failed"]), reason_code: code.nullable(),
  }).strict().refine(value => (value.status === "failed" || value.result_hash !== null)
    && (value.status === "failed") === (value.reason_code !== null))).max(8), ...denied,
}).strict().refine(value => value.status === "blocked" ? value.candidates.length === 0
  : value.candidates.length > 0 && (value.status === "failed") === value.candidates.some(row => row.status === "failed"));
export const fundedStudyTaskSchema = z.object({ id, profile_id: id, funding_plan_id: id, input_version: digest,
  status: z.enum(["queued", "running", "retrying", "blocked", "calculated_unverified", "failed", "outdated"]),
  created_at: at, completed_at: at.nullable(), historical_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  candidate_count: z.number().int().min(0).max(8), reason_codes: z.array(code).max(8), ...denied,
}).strict().refine(value => (value.completed_at === null || value.completed_at >= value.created_at)
  && (!["blocked", "calculated_unverified"].includes(value.status) || value.completed_at !== null)
  && (!["queued", "running", "retrying"].includes(value.status) || value.completed_at === null)
  && (value.status !== "calculated_unverified" || value.candidate_count > 0 && value.historical_start_date !== null));
export type FundedStudyRequest = z.infer<typeof fundedStudyRequestSchema>;
export type FundedStudyTask = z.infer<typeof fundedStudyTaskSchema>;
export const fundedStudyDenials = { economics_independently_replayed: false, parameters_independently_preregistered: false,
  actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false } as const;
