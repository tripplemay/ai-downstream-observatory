import { hash } from "../ledger/service";
import { fundingHistoryProjection, prepareFundedHistory, type FundedHistoryInput } from "./funded-history";
import type { InvestorFundingPlan } from "./funding-schemas";
import type { InvestorProfile } from "./schemas";

type Obj = Record<string, unknown>;
export type FundedStudySource = { created_at: string; range_start: string; range_end: string;
  payload: { dataset: Obj; plan: unknown; policy: unknown } };

/** Calendar-only selection; prices, returns and the preferred entry path do not choose the window. */
export function prepareFundedStudyInputs(funding: InvestorFundingPlan, source: FundedStudySource, declared: string, profile: InvestorProfile) {
  const gap = (reason: string) => ({ historical_start_date: null, candidate_hashes: [] as string[], reason_codes: [reason], inputs: [] as FundedHistoryInput[] });
  const { dataset } = source.payload, plan = source.payload.plan as Obj, policy = source.payload.policy as Obj;
  if (profile.liquidity_need !== "none_in_horizon") return gap("FUNDED_STUDY_LIQUIDITY_REVIEW_REQUIRED");
  if (profile.exclusions.length) return gap("FUNDED_STUDY_EXCLUSIONS_REQUIRE_QUALIFIED_UNIVERSE");
  if ((dataset.assets as Obj[]).some(row => !profile.markets.includes(row.market as "CN" | "HK" | "US"))) return gap("FUNDED_STUDY_UNIVERSE_OUTSIDE_ALLOWED_MARKETS");
  if (profile.horizon_years < (policy.minimum_horizon_years as number)) return gap("FUNDED_STUDY_HORIZON_OUTSIDE_STRATEGY_SCOPE");
  if (profile.research_direction === "rotation") return gap("FUNDED_STUDY_ENHANCEMENT_EVIDENCE_REQUIRED");
  if (plan.evaluation_timezone !== funding.evaluation_timezone) return gap("FUNDED_STUDY_TIMEZONE_CONFLICT");
  const candidates = policy.candidates as Obj[];
  if (!candidates.length || candidates.length > 8 || candidates.some(row => row.schema_version !== "research-fixed-rebalance-parameters-v2"))
    return gap("FUNDED_STUDY_FIXED_POLICY_V2_REQUIRED");
  const sorted = candidates.map(parameters => ({ parameters, digest: hash(parameters) })).sort((a, b) => a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0);
  if (new Set(sorted.map(row => row.digest)).size !== sorted.length) return gap("FUNDED_STUDY_DUPLICATE_CANDIDATES");
  let historical_start_date: string | null = null, window: { start: string; end: string } | null = null;
  const make = (anchor: string, parameters: Obj, decision_times: string[]): FundedHistoryInput => ({
    schema_version: plan.schema_version === "research-plan-v3" ? "investor-funded-history-input-v2" : "investor-funded-history-input-v1", funding_plan: funding, historical_start_date: anchor, dataset,
    context: { parameters_recorded_at: source.created_at, comparison_declared_at: declared, information_cutoff_at: declared,
      parameters, decision_times, execution: plan.execution as Obj, tax_coverage: plan.tax_coverage as string } });
  for (let year = Math.max(1970, Number(source.range_start.slice(0, 4))); year <= Math.min(2199, Number(source.range_end.slice(0, 4))); year++) {
    const anchor = `${year}${funding.start_date.slice(4)}`;
    if (anchor < source.range_start) continue;
    const end = `${year + funding.horizon_years}${funding.start_date.slice(4)}`;
    const last = new Date(Date.parse(end + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
    if (last > source.range_end) break;
    try {
      window = fundingHistoryProjection(make(anchor, sorted[0].parameters, plan.decision_times as string[])).window;
      historical_start_date = anchor; break;
    } catch { /* An invalid leap-day translation is not a shorter or shifted investment horizon. */ }
  }
  if (!historical_start_date || !window) return gap("FUNDED_STUDY_FULL_HORIZON_NOT_COVERED");
  const decisions = (plan.decision_times as string[]).filter(value => Date.parse(window!.start) <= Date.parse(value) && Date.parse(value) < Date.parse(window!.end));
  try {
    const inputs = sorted.map(row => make(historical_start_date!, row.parameters, decisions));
    inputs.forEach(prepareFundedHistory);
    return { historical_start_date, candidate_hashes: sorted.map(row => row.digest), reason_codes: [] as string[], inputs };
  } catch { return gap("FUNDED_STUDY_INPUT_UNSUPPORTED"); }
}
