import type { EvaluationScheduleDefinition } from "./schemas";
export type { EvaluationScheduleDefinition } from "./schemas";
export interface EvaluationActor { id: string; kind: "human" | "strategy" | "ai" }
export interface EvaluationOptions { now?: string }
export interface ScheduleVersionView {
  id: string; version: number; policy_version_id: string; strategy_version_id: string;
  definition_json: string; definition: EvaluationScheduleDefinition; content_hash: string; created_at: string;
}
export interface EvaluationScheduleView {
  id: string; strategy_key: string; status: "enabled" | "paused"; schedule_revision: number;
  current_version: ScheduleVersionView; last_audit_id: string; updated_at: string;
}
export interface EvaluationCycleSummary {
  id: string; portfolio_id: string; period: string; status: "pending" | "running" | "completed" | "blocked" | "failed";
  outcome: "unchanged" | "proposed" | "blocked" | null; schedule_version_id: string;
  scheduled_at: string; cutoff_at: string; knowledge_at: string; deadline_at: string; created_at: string;
  state_revision: number; terminal_attempt_id: string | null; completed_at: string | null;
}
export interface EvaluationAttemptView {
  id: string; attempt: number; status: "succeeded" | "blocked" | "failed"; input_hash: string; result_hash: string;
  created_at: string; completed_at: string; job_attempt_id: string; input_manifest_json: string; result_json: string;
}
export interface EvaluationRequestView { command_request_id: string; generation: number; requested_by: string; reason: string; created_at: string }
export interface EvaluationJobView { id: string; command_request_id: string; status: string; attempt_count: number; max_attempts: number; created_at: string; updated_at: string }
export interface EvaluationState {
  schema_version: "monthly-evaluations-v1";
  portfolios: { id: string; name: string }[]; selected_portfolio_id: string | null; ledger_revision: number | null; read_only: boolean;
  schedules: EvaluationScheduleView[]; schedules_truncated: boolean; cycles: EvaluationCycleSummary[]; next_cursor: string | null;
  detail: null | { cycle: EvaluationCycleSummary; attempts: EvaluationAttemptView[]; requests: EvaluationRequestView[]; jobs: EvaluationJobView[]; requests_truncated: boolean; next_attempt_cursor: string | null };
}
