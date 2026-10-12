import { fundedComparisonSchema, type FundedComparison } from "@/server/investor/funded-comparison-schemas";
import { investorHash } from "@/server/investor/schemas";
import type { InvestorState } from "@/server/investor/types";

const responseSchema = fundedComparisonSchema.innerType().extend({ session_binding: investorHash }).strict();
export function fundedComparisonIdentity(state: InvestorState, binding: string) {
  return JSON.stringify([binding, state.workspace_id, state.revision, state.profile?.id, state.funding.plan?.id, state.funded_study?.id,
    state.funded_study?.input_version, state.funded_study?.status, state.funded_study_unavailable]);
}
export function parseFundedComparison(raw: unknown, state: InvestorState, binding: string, now = Date.now()): FundedComparison {
  const parsed = responseSchema.safeParse(raw), task = state.funded_study;
  if (!parsed.success || parsed.data.session_binding !== binding || parsed.data.workspace_id !== state.workspace_id
    || parsed.data.workspace_revision !== state.revision || parsed.data.profile_id !== (state.profile?.id ?? null)
    || parsed.data.request_id !== (task?.id ?? null) || parsed.data.input_version !== (task?.input_version ?? null)
    || parsed.data.funding_plan_id !== (task?.funding_plan_id ?? null) || state.funded_study_unavailable
    || Date.parse(parsed.data.checked_at) > now + 60000 || parsed.data.checked_at < (task?.created_at ?? state.checked_at)) throw new Error("FUNDED_COMPARISON_RESPONSE_INVALID");
  const { session_binding: _, ...body } = parsed.data;
  const result = fundedComparisonSchema.safeParse(body);
  if (!result.success || result.data.candidates.length && (task?.candidate_count !== result.data.candidates.length
    || state.funding.status !== "planned" || task.profile_id !== state.profile?.id || task.funding_plan_id !== state.funding.plan?.id)
    || result.data.valid_until && Date.parse(result.data.valid_until) <= now) throw new Error("FUNDED_COMPARISON_RESPONSE_INVALID");
  return result.data;
}
