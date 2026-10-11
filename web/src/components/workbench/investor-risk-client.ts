import { investorProfileSchema, type InvestorProfile } from "@/server/investor/schemas";
import type { InvestorState } from "@/server/investor/types";
import { currentResearchDisplay } from "./research-format";

export function investorRiskIdentity(state: InvestorState, binding: string) {
  return JSON.stringify([binding, state.workspace_id, state.revision, state.profile?.id, state.profile?.content_hash,
    state.funding.status, state.funding.plan?.id, state.research_task?.id, state.research_task?.input_version,
    state.research_task?.status, state.research_task?.study?.result_hash, state.research_task?.study?.source_context?.valid_until]);
}
export function riskIllustrationCapital(state: InvestorState): string | null {
  return state.funding.status === "planned" && state.funding.plan ? state.funding.plan.document.initial_capital_cny
    : state.profile?.document.illustrative_budget_cny ?? null;
}
export function currentRiskCandidates(state: InvestorState, nowMs: number) {
  const task = state.research_task ? currentResearchDisplay(state.research_task, nowMs) : null;
  if (!task || task.status !== "calculated" || task.profile_id !== state.profile?.id) return null;
  return task.study;
}
export function riskBudgetIntent(state: InvestorState, binding: string, expectedIdentity: string, choice: string, acknowledged: boolean) {
  if (state.read_only || !state.profile || investorRiskIdentity(state, binding) !== expectedIdentity || !acknowledged)
    throw new Error("INVESTOR_RISK_REVIEW_REQUIRED");
  const loss = investorProfileSchema.shape.loss_tolerance.unwrap().safeParse(choice);
  if (!loss.success) throw new Error("INVESTOR_RISK_INPUT_INVALID");
  if (state.profile.document.loss_tolerance === loss.data) throw new Error("INVESTOR_RISK_UNCHANGED");
  const profile: InvestorProfile = investorProfileSchema.parse({ ...state.profile.document, loss_tolerance: loss.data });
  return { action: "save_profile" as const, profile };
}
