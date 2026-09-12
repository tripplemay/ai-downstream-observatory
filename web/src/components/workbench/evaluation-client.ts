import { z } from "zod";
import { evaluationScheduleSchema, retryEvaluationSchema, saveScheduleSchema, setScheduleStatusSchema } from "@/server/evaluation/schemas";
import { parseStrictJson } from "@/server/strict-json";
import type { EvaluationState } from "@/server/evaluation/types";

export type EvaluationAction = "save_schedule" | "enable" | "pause" | "retry_evaluation";
export interface EvaluationDraft { action: EvaluationAction; scheduleId: string; cycleId: string; definitionJson: string; reason: string }
export interface EvaluationPending { portfolioId: string; sessionBinding: string; body: string; action: EvaluationAction; scheduleId: string; versionId: string; expectedVersion: number; expectedDefinitionVersion: number; expectedDefinitionHash: string | null; expectedState: number }
export const emptyEvaluationDraft = (): EvaluationDraft => ({ action: "save_schedule", scheduleId: "", cycleId: "", definitionJson: "", reason: "" });
export const evaluationTemplate = () => JSON.stringify({
  schema_version: "evaluation-schedule-v1", frequency: "monthly", environment: "actual",
  policy_version_id: "", strategy_version_id: "", activation_id: "", timezone: "", start_month: "", end_month: "",
  trigger: { day: null, hour: null, minute: null }, deadline_seconds: null, max_attempts: null,
  targets: { method: "manual_weight_targets_v1", weight_basis: "portfolio_nav", rows: [{ account_id: "", listing_id: "", currency: "", weight: "" }],
    absolute_tolerance_cny: "", weight_tolerance: "", tolerance_rule: "max_absolute_or_weight", unlisted_strategy_positions: "block",
    pending_activity: "block", price_rule: "close_rounded_to_step", quantity_rule: "floor_to_step" },
}, null, 2);

const id = z.string().min(1).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/), integer = z.number().int().safe().nonnegative();
const time = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/), cursor = z.string().min(1).max(1024).nullable();
const cycle = z.object({ id, portfolio_id: id, period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), status: z.enum(["pending", "running", "completed", "blocked", "failed"]),
  outcome: z.enum(["unchanged", "proposed", "blocked"]).nullable(), schedule_version_id: id, scheduled_at: time, cutoff_at: time, knowledge_at: time,
  deadline_at: time, created_at: time, state_revision: integer.positive(), terminal_attempt_id: id.nullable(), completed_at: time.nullable() }).strict();
const responseSchema = z.object({ schema_version: z.literal("monthly-evaluations-v1"), portfolios: z.array(z.object({ id, name: z.string().max(1000) }).strict()).max(1000),
  selected_portfolio_id: id.nullable(), ledger_revision: integer.nullable(), read_only: z.boolean(), schedules_truncated: z.boolean(),
  schedules: z.array(z.object({ id, strategy_key: id, status: z.enum(["enabled", "paused"]), schedule_revision: integer.positive(), last_audit_id: id, updated_at: time,
    current_version: z.object({ id, version: integer.positive(), policy_version_id: id, strategy_version_id: id, definition_json: z.string().max(262144),
      definition: evaluationScheduleSchema, content_hash: hash, created_at: time }).strict() }).strict()).max(100),
  cycles: z.array(cycle).max(50), next_cursor: cursor,
  detail: z.object({ cycle, attempts: z.array(z.object({ id, attempt: integer.positive(), status: z.enum(["succeeded", "blocked", "failed"]), input_hash: hash, result_hash: hash,
    created_at: time, completed_at: time, job_attempt_id: id, input_manifest_json: z.string().max(8 * 1024 * 1024), result_json: z.string().max(8 * 1024 * 1024) }).strict()).max(50),
    requests: z.array(z.object({ command_request_id: id, generation: integer.positive(), requested_by: id, reason: z.string().max(2000), created_at: time }).strict()).max(100),
    jobs: z.array(z.object({ id, command_request_id: id, status: z.string().min(1).max(100), attempt_count: integer, max_attempts: integer.positive(), created_at: time, updated_at: time }).strict()).max(100),
    requests_truncated: z.boolean(), next_attempt_cursor: cursor }).strict().nullable(),
}).strict();

export function assertEvaluationState(value: unknown, expected: { portfolioId?: string; cycleId?: string } = {}): asserts value is EvaluationState {
  if (!responseSchema.safeParse(value).success) throw new Error("EVALUATION_RESPONSE_INVALID");
  const state = value as EvaluationState;
  if ((expected.portfolioId && state.selected_portfolio_id !== expected.portfolioId)
    || (state.selected_portfolio_id === null ? state.ledger_revision !== null || !!state.schedules.length || !!state.cycles.length || !!state.detail : state.ledger_revision === null || !state.portfolios.some(row => row.id === state.selected_portfolio_id))
    || state.cycles.some(row => row.portfolio_id !== state.selected_portfolio_id)
    || (expected.cycleId ? state.detail?.cycle.id !== expected.cycleId : state.detail !== null)
    || (state.detail && state.detail.cycle.portfolio_id !== state.selected_portfolio_id)
    || new Set(state.portfolios.map(row => row.id)).size !== state.portfolios.length
    || new Set(state.schedules.map(row => row.id)).size !== state.schedules.length
    || new Set(state.cycles.map(row => row.id)).size !== state.cycles.length) throw new Error("EVALUATION_RESPONSE_INVALID");
}

export function prepareEvaluationAttempt(state: EvaluationState, draft: EvaluationDraft, sessionBinding: string, key: string): EvaluationPending {
  if (state.read_only || !state.selected_portfolio_id || state.ledger_revision === null || !hash.safeParse(sessionBinding).success) throw new Error("EVALUATION_WRITE_UNAVAILABLE");
  const envelope = { portfolio_id: state.selected_portfolio_id, expected_revision: state.ledger_revision, idempotency_key: key, reason: draft.reason };
  const schedule = state.schedules.find(row => row.id === draft.scheduleId);
  let command: unknown, action: string = draft.action, expectedState = 0;
  if (draft.action === "save_schedule") {
    if (draft.scheduleId && !schedule) throw new Error("EVALUATION_SCHEDULE_NOT_FOUND");
    if (new TextEncoder().encode(draft.definitionJson).length > 262144) throw new Error("EVALUATION_DEFINITION_TOO_LARGE");
    try { evaluationScheduleSchema.parse(parseStrictJson(draft.definitionJson)); } catch { throw new Error("EVALUATION_DEFINITION_INVALID"); }
    command = saveScheduleSchema.parse({ ...envelope, expected_schedule_id: schedule?.id ?? null, expected_schedule_revision: schedule?.schedule_revision ?? 0, definition_json: draft.definitionJson });
  } else if (draft.action === "enable" || draft.action === "pause") {
    if (!schedule) throw new Error("EVALUATION_SCHEDULE_NOT_FOUND");
    const status = draft.action === "enable" ? "enabled" : "paused";
    if (schedule.status === status) throw new Error("EVALUATION_STATUS_UNCHANGED");
    action = "set_schedule_status";
    command = setScheduleStatusSchema.parse({ ...envelope, schedule_id: schedule.id, expected_schedule_revision: schedule.schedule_revision, status });
  } else {
    const selected = state.detail?.cycle.id === draft.cycleId ? state.detail.cycle : state.cycles.find(row => row.id === draft.cycleId);
    if (!selected || !["blocked", "failed"].includes(selected.status)) throw new Error("EVALUATION_NOT_RETRYABLE");
    expectedState = selected.state_revision;
    command = retryEvaluationSchema.parse({ ...envelope, cycle_id: selected.id, expected_state_revision: selected.state_revision });
  }
  const body = JSON.stringify({ action, command });
  if (new TextEncoder().encode(body).length > 1024 * 1024) throw new Error("EVALUATION_REQUEST_TOO_LARGE");
  return { portfolioId: state.selected_portfolio_id, sessionBinding, body, action: draft.action, scheduleId: draft.scheduleId,
    versionId: schedule?.current_version.id ?? "", expectedVersion: schedule?.schedule_revision ?? 0, expectedDefinitionVersion: (schedule?.current_version.version ?? 0) + 1, expectedDefinitionHash: null, expectedState };
}

export async function sealEvaluationAttempt(attempt: EvaluationPending): Promise<EvaluationPending> {
  if (attempt.action !== "save_schedule" || attempt.expectedDefinitionHash !== null) return attempt;
  const original = JSON.parse(attempt.body) as { command: { definition_json: string } };
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(original.command.definition_json));
  return { ...attempt, expectedDefinitionHash: Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("") };
}

export function assertEvaluationReceipt(value: unknown, attempt: EvaluationPending): void {
  const row = z.record(z.unknown()).safeParse(value); if (!row.success) throw new Error("EVALUATION_RECEIPT_INVALID");
  const v = row.data, invalid = () => { throw new Error("EVALUATION_RECEIPT_INVALID"); };
  if (attempt.action === "retry_evaluation") {
    const original = JSON.parse(attempt.body) as { command: { cycle_id: string } };
    if (v.cycle_id !== original.command.cycle_id || !id.safeParse(v.request_id).success || !integer.positive().safeParse(v.generation).success
      || v.state_revision !== attempt.expectedState + 1 || v.status !== "pending") invalid();
  } else {
    if (!id.safeParse(v.schedule_id).success || !id.safeParse(v.version_id).success || v.schedule_revision !== attempt.expectedVersion + 1
      || (attempt.scheduleId && v.schedule_id !== attempt.scheduleId)) invalid();
    if (attempt.action === "save_schedule") {
      if (v.status !== "paused" || v.version !== attempt.expectedDefinitionVersion || !attempt.expectedDefinitionHash || v.content_hash !== attempt.expectedDefinitionHash) invalid();
    } else if (v.version_id !== attempt.versionId || v.status !== (attempt.action === "enable" ? "enabled" : "paused")
      || (attempt.action === "enable" ? !time.safeParse(v.first_scheduled_at).success : v.first_scheduled_at !== null)) invalid();
  }
}

export class EvaluationRequestGate {
  private sequence = 0;
  next() { return ++this.sequence; }
  invalidate() { ++this.sequence; }
  current(token: number) { return token === this.sequence; }
}

export function evaluationProposalId(raw: string): string | null {
  try { const value = parseStrictJson(raw) as { proposal_id?: unknown }; return id.safeParse(value?.proposal_id).success ? value.proposal_id as string : null; }
  catch { return null; }
}
