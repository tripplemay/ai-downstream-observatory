import type { InvestorObservation, InvestorProfile, InvestorResearchTask, InvestorModelWatch, ReferencePlan } from "./schemas";
import type { InvestorFundingState } from "./funding-schemas";
import type { FundedStudyTask } from "./funded-study-schemas";
import type { MonitorCostState } from "./monitor-cost-schemas";
import type { ActionDraftProgress } from "./action-draft-progress-schemas";

export type InvestorProfileVersion = { id: string; version: number; content_hash: string; created_at: string; document: InvestorProfile };
export type InvestorObservationRecord = { id: string; content_hash: string; candidate_plan_id: string | null; document: InvestorObservation };
export type InvestorDecision = { id: string; observation_id: string; decision: "accept_idea" | "defer" | "reject"; note: string; created_at: string };
export type InvestorPlan = { id: string; content_hash: string; document: ReferencePlan; saved_for_observation: boolean; quality: "current" | "expired" | "different_profile" };
export type InvestorState = {
  schema_version: "investor-state-v1"; workspace_id: string | null; revision: number; checked_at: string; read_only: boolean;
  profile: InvestorProfileVersion | null; profile_history: InvestorProfileVersion[];
  latest: InvestorObservationRecord | null; observations: InvestorObservationRecord[]; observations_truncated: boolean;
  research_task: InvestorResearchTask | null;
  model_watch: InvestorModelWatch | null;
  monitor_costs: MonitorCostState | null;
  action_drafts?: ActionDraftProgress;
  funding: InvestorFundingState;
  funded_study: FundedStudyTask | null;
  funded_study_unavailable: boolean;
  decisions: InvestorDecision[]; decisions_truncated: boolean; plan: InvestorPlan | null;
  effective_outcome: "not_started" | InvestorObservation["outcome"]; effective_gaps: InvestorObservation["gaps"];
  live_advice_eligible: false; actual_holdings_status: "not_linked" | "linked" | "unavailable"; ai_status: "not_configured";
};
export type InvestorReceipt = { workspace_id: string; revision: number; action: string; resource_id: string; audit_id: string };
