import { z } from "zod";
import { evidenceGapSchema, investorHash, investorId, investorInstant, investorProfileSchema, investorReceiptSchema, observationSchema, referencePlanSchema, researchTaskSchema, modelWatchSchema } from "@/server/investor/schemas";
import type { InvestorState } from "@/server/investor/types";
import { fundingStateSchema, fundingTimeline } from "@/server/investor/funding-schemas";
import { fundedStudyTaskSchema } from "@/server/investor/funded-study-schemas";
import { monitorCostStateSchema } from "@/server/investor/monitor-cost-schemas";

const natural = z.number().int().nonnegative().safe();
const profile = z.object({ id: investorId, version: natural.refine(value => value > 0), content_hash: investorHash, created_at: investorInstant, document: investorProfileSchema }).strict();
const observation = z.object({ id: investorId, content_hash: investorHash, candidate_plan_id: investorId.nullable(), document: observationSchema }).strict();
const stateSchema = z.object({
  schema_version: z.literal("investor-state-v1"), workspace_id: investorId.nullable(), revision: natural,
  checked_at: investorInstant, read_only: z.boolean(), profile: profile.nullable(), profile_history: z.array(profile).max(20),
  latest: observation.nullable(), observations: z.array(observation).max(50), observations_truncated: z.boolean(),
  research_task: researchTaskSchema.nullable(),
  model_watch: modelWatchSchema.nullable(),
  monitor_costs: monitorCostStateSchema.nullable(),
  funding: fundingStateSchema,
  funded_study: fundedStudyTaskSchema.nullable(), funded_study_unavailable: z.boolean(),
  decisions: z.array(z.object({ id: investorId, observation_id: investorId,
    decision: z.enum(["accept_idea", "defer", "reject"]), note: z.string().max(2000), created_at: investorInstant }).strict()).max(50),
  decisions_truncated: z.boolean(), plan: z.object({ id: investorId, content_hash: investorHash, document: referencePlanSchema, saved_for_observation: z.boolean(), quality: z.enum(["current", "expired", "different_profile"]) }).strict().nullable(),
  effective_outcome: z.enum(["not_started", "observe", "decision_required", "insufficient_evidence"]), effective_gaps: z.array(evidenceGapSchema).max(45),
  live_advice_eligible: z.literal(false), actual_holdings_status: z.enum(["not_linked", "linked", "unavailable"]), ai_status: z.literal("not_configured"),
  session_binding: investorHash,
}).strict();
export function parseInvestorState(value: unknown, binding: string): InvestorState {
  const result = stateSchema.safeParse(value);
  if (!result.success || result.data.session_binding !== binding) throw new Error("INVESTOR_RESPONSE_INVALID");
  const { session_binding: _, ...state } = result.data;
  if (state.monitor_costs && (!state.model_watch || state.monitor_costs.model_id !== state.model_watch.id
    || state.monitor_costs.model_valid_until !== state.model_watch.valid_until
    || state.monitor_costs.status === "known" && (state.monitor_costs.valid_until! <= state.checked_at || state.monitor_costs.effective_from! > state.checked_at)
    || state.monitor_costs.status === "expired" && state.monitor_costs.valid_until! > state.checked_at
    || state.monitor_costs.editable && (state.read_only || state.model_watch.profile_id !== state.profile?.id || state.model_watch.valid_until <= state.checked_at)))
    throw new Error("INVESTOR_RESPONSE_INVALID");
  if ((state.workspace_id === null && (state.profile !== null || state.revision !== 0 || state.observations.length > 0 || state.decisions.length > 0 || state.plan !== null || state.research_task !== null || state.model_watch !== null || state.actual_holdings_status !== "not_linked" || state.funding.status !== "not_configured" || state.funded_study !== null || state.funded_study_unavailable))
      || (state.workspace_id !== null && (state.profile === null || state.revision === 0))
      || JSON.stringify(state.profile ?? null) !== JSON.stringify(state.profile_history[0] ?? null)
      || JSON.stringify(state.latest ?? null) !== JSON.stringify(state.observations[0] ?? null)
      || state.observations.some(row => row.document.evaluated_at > state.checked_at)
      || state.profile_history.some(row => row.created_at > state.checked_at)
      || state.profile_history.some((row, i) => i > 0 && row.version >= state.profile_history[i - 1].version)
      || state.decisions.some(row => row.created_at > state.checked_at)
      || state.observations.some(row => (row.candidate_plan_id === null) !== (row.document.outcome === "insufficient_evidence"))
      || (state.latest === null) !== (state.effective_outcome === "not_started")
      || (state.effective_outcome === "insufficient_evidence") !== (state.effective_gaps.length > 0)) throw new Error("INVESTOR_RESPONSE_INVALID");
  if (state.research_task && (state.research_task.profile_id !== state.profile?.id || state.research_task.profile_version !== state.profile.version
      || state.research_task.created_at > state.checked_at || (state.research_task.completed_at !== null && state.research_task.completed_at > state.checked_at)
      || (state.research_task.study?.status === "risk_options_ready" && state.profile.document.loss_tolerance !== null)
      || (state.research_task.study?.status === "reference_ready" && state.profile.document.loss_tolerance === null))) throw new Error("INVESTOR_RESPONSE_INVALID");
  const context = state.research_task?.study?.source_context;
  if (state.funded_study_unavailable && state.funded_study !== null || state.funded_study && (state.funded_study.created_at > state.checked_at
    || state.funded_study.completed_at !== null && state.funded_study.completed_at > state.checked_at
    || state.funded_study.status !== "outdated" && (state.funded_study.profile_id !== state.profile?.id
      || state.funding.status !== "planned" || state.funded_study.funding_plan_id !== state.funding.plan?.id))) throw new Error("INVESTOR_RESPONSE_INVALID");
  if (state.funding.plan && (state.funding.plan.created_at > state.checked_at
    || state.funding.status !== (state.funding.plan.profile_id === state.profile?.id ? "planned" : "requires_review")
    || state.funding.status === "planned" && (state.funding.plan.profile_hash !== state.profile?.content_hash
      || state.funding.plan.document.horizon_years > state.profile.document.horizon_years)
    || JSON.stringify(state.funding.plan.timeline) !== JSON.stringify(fundingTimeline(state.funding.plan.document)))) throw new Error("INVESTOR_RESPONSE_INVALID");
  if (context && (context.valid_until <= state.checked_at || state.research_task!.study!.candidates.some(candidate =>
    Object.keys(candidate.weights).some(id => !context.listings.some(row => row.listing_id === id))))) throw new Error("INVESTOR_RESPONSE_INVALID");
  if (state.plan) {
    const expectedQuality = state.plan.document.profile_id !== state.profile?.id ? "different_profile"
      : state.plan.document.valid_until <= state.checked_at ? "expired" : "current";
    if (state.plan.document.created_at > state.checked_at || state.plan.quality !== expectedQuality) throw new Error("INVESTOR_RESPONSE_INVALID");
    if (state.plan.document.data_mode === "reconstructed" && state.plan.quality === "current") {
      const evidence = state.plan.document.reference_evidence!;
      if (state.profile?.document.loss_tolerance === null || state.research_task?.id !== evidence.request_id
        || state.research_task.status !== "calculated" || state.research_task.study?.status !== "reference_ready"
        || state.research_task.study.qualification !== evidence.qualification || state.research_task.study.result_hash !== evidence.result_hash
        || state.research_task.registry?.manifest_hash !== evidence.manifest_hash) throw new Error("INVESTOR_RESPONSE_INVALID");
    }
  }
  if (state.model_watch && (state.model_watch.created_at > state.checked_at
    || (state.model_watch.completed_at !== null && state.model_watch.completed_at > state.checked_at)
    || (state.plan?.id === state.model_watch.plan_id && state.model_watch.plan_hash !== state.plan.content_hash)
    || (["synthetic_preview", "research_observe", "research_decision"].includes(state.model_watch.status) && (state.model_watch.profile_id !== state.profile?.id
      || state.model_watch.valid_until <= state.checked_at
      || state.model_watch.next_check_at === null || state.model_watch.next_check_at <= state.checked_at)))) throw new Error("INVESTOR_RESPONSE_INVALID");
  const acquisition = state.model_watch?.acquisition;
  if (acquisition && (acquisition.model_id !== state.model_watch!.id || acquisition.checked_at !== state.checked_at
    || acquisition.status === "visible" && (!state.model_watch!.enabled || state.model_watch!.profile_id !== state.profile?.id || state.model_watch!.valid_until <= state.checked_at)
    || acquisition.status === "paused" && state.model_watch!.enabled
    || acquisition.status === "visible" && state.plan?.id === state.model_watch!.plan_id && (
      acquisition.markets.length !== new Set(state.plan.document.targets.map(row => row.market)).size
      || acquisition.markets.some(row => row.target_count !== state.plan!.document.targets.filter(target => target.market === row.market).length)))) throw new Error("INVESTOR_RESPONSE_INVALID");
  if (state.latest && state.effective_outcome !== "insufficient_evidence") {
    const doc = state.latest.document;
    const qualifiedMonitor = !!doc.model_change && state.model_watch?.source_qualification === "owner_reviewed_reconstructed"
      && state.plan?.document.data_mode === "reconstructed" && state.model_watch.plan_id === state.latest.candidate_plan_id
      && state.model_watch.evaluation_input_version === doc.input_version
      && state.model_watch.status === (doc.outcome === "observe" ? "research_observe" : "research_decision");
    if (state.effective_outcome !== doc.outcome || doc.profile_id !== state.profile?.id || doc.profile_version !== state.profile.version
        || !state.plan || state.plan.quality !== "current" || state.plan.id !== state.latest.candidate_plan_id
        || !qualifiedMonitor && (state.plan.document.input_version !== doc.input_version || state.plan.document.data_cutoff !== doc.data_cutoff)
        || (doc.next_review_at !== null && doc.next_review_at <= state.checked_at)) throw new Error("INVESTOR_RESPONSE_INVALID");
  }
  return state;
}
const receiptSchema = investorReceiptSchema.extend({ session_binding: investorHash }).strict();
export function verifyInvestorReceipt(value: unknown, pending: { body: string; binding: string; workspace: string | null }) {
  const result = receiptSchema.safeParse(value), command = JSON.parse(pending.body) as { action: string; expected_revision: number };
  if (!result.success || result.data.session_binding !== pending.binding || result.data.action !== command.action
      || result.data.revision !== command.expected_revision + 1 || (pending.workspace !== null && result.data.workspace_id !== pending.workspace)) throw new Error("INVESTOR_RESPONSE_INVALID");
  return result.data;
}
