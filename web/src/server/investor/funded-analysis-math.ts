import { Decimal } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { runContinuousEconomics, type ContinuousPlan } from "./continuous-economics";
import { economicDate, economicInstant, economicText, requireEconomic, type ContinuousDataset } from "./continuous-market";
import { fundedExecutionReview, fundedPathReleases, verifiedFundedHistoryReplay } from "./funded-history-economics";
import type { FundedHistoryInput } from "./funded-history";
import { fundedAnalysisDataSchema, fundedAnalysisSeriesSchema, type FundedAnalysisSeries } from "./funded-analysis-schemas";
import { observedMonthlyRisk } from "./funded-analysis-statistics";

type Trace = ReturnType<typeof runContinuousEconomics>;
type Point = FundedAnalysisSeries["daily"][number];
const days = (from: string, to: string, zone: string) => (Date.parse(economicDate(economicInstant(to), zone) + "T00:00:00Z")
  - Date.parse(economicDate(economicInstant(from), zone) + "T00:00:00Z")) / 86400000;

/** Risk is evaluated on every model valuation, before daily chart compression. */
export function analyzeFundedTrace(trace: Trace, zone: string): FundedAnalysisSeries {
  requireEconomic(trace.curve.length > 0 && trace.curve.length <= 100000, "FUNDED_ANALYSIS_CURVE_LIMIT");
  const all: Point[] = [], daily = new Map<string, Point>();
  let peak = new Decimal(0), peakAt: string | null = null, worst = new Decimal(0), unavailable = false;
  let worstPeak: string | null = null, worstTrough: string | null = null, recovery: string | null = null, worstPeakValue: Decimal | null = null;
  let active: { peak_at: string; trough_at: string; low: Decimal } | null = null;
  let longest: FundedAnalysisSeries["risk"]["longest_underwater"] = null;
  function consider(episode: NonNullable<typeof active>, end: string, ongoing: boolean) {
    const duration = days(episode.peak_at, end, zone);
    if (!longest || duration > longest.duration_days) longest = { peak_at: episode.peak_at, trough_at: episode.trough_at,
      recovered_at: ongoing ? null : end, duration_days: duration, ongoing };
  }
  for (const row of trace.curve) {
    const at = row.at as string, time = economicInstant(at), nav = new Decimal(row.nav_cny as string), principal = new Decimal(row.principal_cny as string);
    const unit = new Decimal(row.unit_nav as string), cash = new Decimal(row.cash_cny as string), locked = new Decimal(row.locked_cash_cny as string);
    requireEconomic(!all.length || time > economicInstant(all.at(-1)!.at), "FUNDED_ANALYSIS_CHRONOLOGY_INVALID");
    requireEconomic(nav.isFinite() && unit.isFinite() && nav.gte(cash) && unit.gte(0) && principal.gt(0)
      && (!all.length || principal.gte(all.at(-1)!.principal_cny))
      && nav.minus(principal).eq(row.profit_cny as string) && cash.gte(locked) && locked.gte(0), "FUNDED_ANALYSIS_ACCOUNTING_INVALID");
    if (!peakAt && unit.isZero()) unavailable = true;
    if (worstPeakValue && recovery === null && unit.gte(worstPeakValue)) recovery = at;
    if (unit.gte(peak) && !unit.isZero()) {
      if (active) { consider(active, at, false); active = null; }
      peak = unit; peakAt = at;
    }
    const decline = peak.gt(0) ? unit.div(peak).minus(1) : null;
    if (decline?.lt(0)) {
      if (!active) active = { peak_at: peakAt!, trough_at: at, low: unit };
      else if (unit.lt(active.low)) { active.low = unit; active.trough_at = at; }
    }
    if (decline?.lt(worst)) { worst = decline; worstPeak = peakAt; worstTrough = at; worstPeakValue = peak; recovery = null; }
    const point: Point = { at, local_date: economicDate(time, zone), nav_cny: row.nav_cny as string,
      principal_cny: row.principal_cny as string, profit_cny: row.profit_cny as string, cash_cny: row.cash_cny as string,
      locked_cash_cny: row.locked_cash_cny as string, unit_nav: row.unit_nav as string,
      drawdown: unavailable || decline === null ? null : economicText(decline) };
    all.push(point); daily.set(point.local_date, point);
  }
  if (active) consider(active, all.at(-1)!.at, true);
  const observed = [...daily.values()], { monthly, rolling } = observedMonthlyRisk(observed, !unavailable);
  const summary = { principal_cny: all.at(-1)!.principal_cny, ending_locked_cash_cny: all.at(-1)!.locked_cash_cny,
    ...(fundedExecutionReview(trace) ? { execution_review: fundedExecutionReview(trace) } : {}),
    ...Object.fromEntries(["ending_nav_cny", "profit_cny", "fees_cny", "fx_fees_cny", "slippage_cny", "cash_rounding_cny", "twr", "annualized_unit_return",
      "max_drawdown", "recovered_at", "ending_cash_ratio", "execution_failure_count", "xirr"].map(key => [key, trace[key as keyof Trace]])) };
  requireEconomic(unavailable ? trace.max_drawdown === null : trace.max_drawdown !== null && new Decimal(trace.max_drawdown).eq(worst), "FUNDED_ANALYSIS_RISK_INVALID");
  requireEconomic(trace.recovered_at === recovery, "FUNDED_ANALYSIS_RECOVERY_INVALID");
  return fundedAnalysisSeriesSchema.parse({ summary, trace_hash: hash(trace), full_observation_count: all.length, daily_curve_hash: hash(observed), daily: observed, monthly, rolling,
    risk: { status: unavailable ? "unit_nav_unavailable" : "computed", max_drawdown: unavailable ? null : economicText(worst),
      peak_at: worstPeak, trough_at: worstTrough, recovered_at: recovery, recovery_days: worstTrough && recovery ? days(worstTrough, recovery, zone) : null,
      longest_underwater: unavailable ? null : longest } });
}

/** Counterfactual baseline changes only the rebalance decision rule, not cashflow, prices or costs. */
export function analyzeFundedHistory(raw: FundedHistoryInput, claimed: Record<string, unknown>, path: "immediate" | "staged", options: { allowSynthetic?: boolean } = {}) {
  const { verification, independent } = verifiedFundedHistoryReplay(raw, claimed, options), zone = independent.projection.evaluation_timezone;
  const candidate = analyzeFundedTrace(independent.paths[path].trace, zone);
  const baselineTrace = runContinuousEconomics(independent.input.dataset as unknown as ContinuousDataset, independent.input.plan as unknown as ContinuousPlan,
    fundedPathReleases(independent.projection, path), { holdingBaseline: true });
  const baseline = analyzeFundedTrace(baselineTrace, zone);
  requireEconomic(candidate.summary.principal_cny === baseline.summary.principal_cny, "FUNDED_ANALYSIS_PRINCIPAL_INVALID");
  const diff = (key: "ending_nav_cny" | "profit_cny" | "fees_cny" | "fx_fees_cny" | "slippage_cny") => economicText(new Decimal(candidate.summary[key]).minus(baseline.summary[key]));
  const baselineRule = { rule: "same_weights_hold_new_cash_repair_v1", input_hash: verification.input_hash, path,
    weights: raw.context.parameters.weights, execution: raw.context.execution, tax_coverage: raw.context.tax_coverage };
  return fundedAnalysisDataSchema.parse({ path, evaluation_timezone: zone, window: independent.projection.window, parameters_hash: hash(raw.context.parameters),
    input_hash: verification.input_hash, economics_hash: verification.independently_replayed_economics_hash, candidate_summary_verified: true, candidate, baseline,
    baseline_rule: baselineRule.rule, baseline_rule_hash: hash(baselineRule), baseline_preregistered: false,
    curve_basis: "last_observed_point_per_local_date_full_window_not_interpolated", risk_basis: "all_model_observation_points_unit_nav_not_principal",
    rolling_basis: "observed_month_end_unit_nav_ratios_12_36_60_months_not_probability",
    comparison: { ending_nav_difference_cny: diff("ending_nav_cny"), profit_difference_cny: diff("profit_cny"), fees_difference_cny: diff("fees_cny"),
      fx_fees_difference_cny: diff("fx_fees_cny"), slippage_difference_cny: diff("slippage_cny"),
      twr_difference: candidate.summary.twr === null || baseline.summary.twr === null ? null : economicText(new Decimal(candidate.summary.twr).minus(baseline.summary.twr)) } });
}
