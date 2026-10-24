import { Decimal } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { runContinuousEconomics, type ContinuousParameters, type ContinuousPlan } from "./continuous-economics";
import { requireEconomic, type ContinuousDataset } from "./continuous-market";

type Phase = "train" | "validation" | "holdout";
export type BoundedResearchPlan = Omit<ContinuousPlan, "schema_version" | "window" | "parameters"> & {
  schema_version: "research-plan-v3" | "research-plan-v4"; windows: Record<Phase, { start: string; end: string }>;
  parameter_candidates: ContinuousParameters[]; benchmark: ContinuousParameters;
};

/** Independent phase replay; source admission and durable exposure are checked by the caller. */
export function replayBoundedComparison(data: ContinuousDataset, plan: BoundedResearchPlan, parameters: ContinuousParameters, phase: Phase) {
  requireEconomic(["research-plan-v3", "research-plan-v4"].includes(plan.schema_version) && ["train", "validation", "holdout"].includes(phase));
  const run = (p: ContinuousParameters) => runContinuousEconomics(data, {
    ...plan, schema_version: plan.schema_version === "research-plan-v4" ? "bounded-research-window-v2" : "bounded-research-window-v1", window: plan.windows[phase], parameters: p,
  }, new Map(), { researchPhase: phase });
  const strategy = run(parameters), benchmark = run(plan.benchmark);
  requireEconomic(strategy.initial_equity_cny === benchmark.initial_equity_cny && strategy.contributions_cny === benchmark.contributions_cny);
  const body = { schema_version: plan.schema_version === "research-plan-v4" ? "research-result-v3" : "research-result-v2", dataset_hash: hash(data), plan_hash: hash(plan), parameters_hash: hash(parameters),
    phase, data_mode: data.mode, strategy, benchmark,
    excess_twr: strategy.twr !== null && benchmark.twr !== null ? new Decimal(strategy.twr).minus(benchmark.twr).toFixed() : null,
    live_advice_eligible: false,
    strategy_gates: Object.fromEntries(Array.from({ length: 10 }, (_, i) => i + 1).map(index => [`S-${String(index).padStart(2, "0")}`,
      { status: [1, 6, 7, 8, 9, 10].includes(index) ? "BLOCKED" : "NOT_RUN", reason: "Exploratory implementation evidence is not formal investment admission" }])),
  };
  return { ...body, result_hash: hash(body) };
}

const verified = new Map<string, string>();
export function verifyBoundedResearchSummary(data: ContinuousDataset, plan: BoundedResearchPlan, parameters: ContinuousParameters,
  summary: Record<string, unknown>, phase: Phase) {
  const key = hash({ dataset: hash(data), plan: hash(plan), parameters: hash(parameters), phase }), summaryHash = hash(summary);
  if (verified.get(key) === summaryHash) return;
  const result = replayBoundedComparison(data, plan, parameters, phase), a = result.strategy, b = result.benchmark;
  const own = ["twr", "annualized_unit_return", "max_drawdown", "profit_cny", "fees_cny", "fx_fees_cny", "slippage_cny", "execution_failure_count", "sell_turnover_on_mean_observed_nav", "buy_turnover_on_mean_observed_nav"] as const;
  const baseline = ["twr", "annualized_unit_return", "max_drawdown", "execution_failure_count", "profit_cny", "fees_cny", "fx_fees_cny", "slippage_cny"] as const;
  const expected = { phase, result_hash: result.result_hash, window: a.window, ...Object.fromEntries(own.map(key => [key, a[key]])),
    ...Object.fromEntries(baseline.map(key => ["benchmark_" + key, b[key]])), excess_twr: result.excess_twr, assumptions: a.assumptions };
  requireEconomic(hash(expected) === summaryHash, "INVESTOR_BOUNDED_RESEARCH_REPLAY_MISMATCH");
  if (verified.size >= 64) verified.clear(); verified.set(key, summaryHash);
}
