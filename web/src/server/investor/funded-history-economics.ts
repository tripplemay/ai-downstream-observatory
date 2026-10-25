import { hash } from "../ledger/service";
import { Decimal } from "../ledger/decimal";
import { prepareFundedHistory, verifyFundedHistoryBinding, type FundedHistoryInput } from "./funded-history";
import { runContinuousEconomics, type ContinuousPlan } from "./continuous-economics";
import { economicDate, economicInstant, economicText, requireEconomic, type ContinuousDataset } from "./continuous-market";

type ObjectValue = Record<string, unknown>;
const economicFields = ["engine_version", "initial_equity_cny", "contributions_cny", "ending_nav_cny", "profit_cny", "twr", "return_method",
  "annualized_unit_return", "xirr", "max_drawdown", "recovered_at", "fees_cny", "fx_fees_cny", "slippage_cny", "cash_rounding_cny",
  "execution_failure_count", "ending_cash_ratio", "assumptions"] as const;

export function fundedExecutionReview(run: ObjectValue) {
  if (!["continuous-event-review-funding-v1", "continuous-event-review-hold-v1", "continuous-settled-intent-funding-v1", "continuous-settled-intent-hold-v1"].includes(run.engine_version as string)) return undefined;
  const count = (key: string) => { const value = run[key]; requireEconomic(typeof value === "number" && Number.isInteger(value) && value >= 0); return value; };
  return { schema_version: run.engine_version === "continuous-settled-intent-funding-v1" || run.engine_version === "continuous-settled-intent-hold-v1"
      ? "execution-review-summary-v2" as const : "execution-review-summary-v1" as const, terminal_failure_count: count("terminal_execution_failure_count"),
    cancellations: count("corporate_action_cancellation_count"), resolved_cancellations: count("resolved_corporate_action_cancellation_count"),
    unresolved_reviews: count("unresolved_order_review_count"), lineage_hash: run.order_review_lineage_hash as string };
}

export function fundedCashIntentReview(run: ObjectValue) {
  if (!["continuous-settled-intent-funding-v1", "continuous-settled-intent-hold-v1"].includes(run.engine_version as string)) return undefined;
  const count = (key: string) => { const value = run[key]; requireEconomic(typeof value === "number" && Number.isInteger(value) && value >= 0); return value; };
  requireEconomic(typeof run.cash_intent_lineage_hash === "string" && /^[a-f0-9]{64}$/.test(run.cash_intent_lineage_hash));
  return { schema_version: "cash-intent-summary-v1" as const, pending_intents: count("pending_cash_intent_count"),
    failed_intents: count("failed_cash_intent_count"), lineage_hash: run.cash_intent_lineage_hash };
}

function summary(run: ReturnType<typeof runContinuousEconomics>, zone: string) {
  const snapshots = (yearOnly: boolean) => {
    const latest = new Map<string, ObjectValue>();
    for (const row of run.curve) {
      const period = economicDate(economicInstant(row.at as string), zone).slice(0, yearOnly ? 4 : 7);
      latest.set(period, { period, observed_at: row.at, ...Object.fromEntries(["nav_cny", "unit_nav", "principal_cny", "profit_cny", "cash_cny",
        "locked_cash_cny", "released_capital_cny", "unreserved_released_cash_cny"].map(key => [key, row[key]])) });
    }
    return [...latest].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row);
  };
  return { ...(Object.fromEntries(economicFields.map(key => [key, run[key]])) as Pick<typeof run, typeof economicFields[number]>),
    ...(["continuous-event-review-funding-v1", "continuous-settled-intent-funding-v1"].includes(run.engine_version) ? Object.fromEntries(["terminal_execution_failure_count", "corporate_action_cancellation_count",
      "resolved_corporate_action_cancellation_count", "unresolved_order_review_count", "order_review_lineage_hash"].map(key => [key, run[key as keyof typeof run]])) : {}),
    ...(run.engine_version === "continuous-settled-intent-funding-v1" ? Object.fromEntries(["failed_cash_intent_count", "pending_cash_intent_count", "cash_intent_lineage_hash"].map(key => [key, run[key as keyof typeof run]])) : {}),
    principal_cny: run.curve.at(-1)!.principal_cny,
    ending_locked_cash_cny: run.curve.at(-1)!.locked_cash_cny, ending_positions: run.positions,
    event_counts: Object.fromEntries(["external_contribution", "funding_release", "simulated_buy", "simulated_sell", "execution_skipped",
      "order_expired", "policy_deployment_failed"].map(type => [type, run.events.filter(row => row.type === type).length])),
    monthly: snapshots(false), annual: snapshots(true) };
}

/** Only derived decimal outputs permit relative rounding tolerance; identities and inputs remain exact. */
function sameEconomics(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string" && typeof expected === "string" && /^-?\d+(?:\.\d+)?$/.test(actual) && /^-?\d+(?:\.\d+)?$/.test(expected)) {
    const a = new Decimal(actual), b = new Decimal(expected);
    return a.isFinite() && b.isFinite() && a.minus(b).abs().lte(Decimal.min("0.000000000001", Decimal.max(1, b.abs()).times("1e-40")));
  }
  if (Array.isArray(actual) || Array.isArray(expected)) return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
    && actual.every((value, index) => sameEconomics(value, expected[index]));
  if (actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object") {
    const a = actual as ObjectValue, b = expected as ObjectValue;
    return Object.keys(a).sort().join() === Object.keys(b).sort().join() && Object.keys(b).every(key => sameEconomics(a[key], b[key]));
  }
  return actual === expected;
}

export function fundedPathReleases(projection: ReturnType<typeof prepareFundedHistory>["projection"], name: "immediate" | "staged") {
  const releases = new Map<bigint, Decimal>();
  for (const lot of projection.lots) for (const tranche of name === "staged" ? lot.staged_releases
    : [{ at: lot.arrival_at, amount_cny: lot.amount_cny, within_window: true }]) {
    if (!tranche.within_window) continue;
    const at = economicInstant(tranche.at); releases.set(at, (releases.get(at) ?? new Decimal(0)).plus(tranche.amount_cny));
  }
  return releases;
}
export function replayFundedHistoryEconomics(raw: FundedHistoryInput, options: { allowSynthetic?: boolean } = {}) {
  const { projection, input } = prepareFundedHistory(raw);
  requireEconomic(options.allowSynthetic === true || raw.dataset.mode !== "synthetic", "INVESTOR_CONTINUOUS_SYNTHETIC_FORBIDDEN");
  const data = input.dataset as unknown as ContinuousDataset, plan = input.plan as unknown as ContinuousPlan;
  const paths = Object.fromEntries((["immediate", "staged"] as const).map(name => {
    const releases = fundedPathReleases(projection, name);
    const trace = runContinuousEconomics(data, plan, releases);
    return [name, { summary: summary(trace, projection.evaluation_timezone), trace }];
  }));
  return { projection, input, paths };
}

/** Verifies every published economic field, not the opaque Python trace digest or source/strategy qualification. */
export function verifiedFundedHistoryReplay(raw: FundedHistoryInput, claimed: ObjectValue, options: { allowSynthetic?: boolean } = {}) {
  const binding = verifyFundedHistoryBinding(raw, claimed), independent = replayFundedHistoryEconomics(raw, options);
  const comparison = claimed.comparison as ObjectValue, runs = comparison.runs as Record<string, ObjectValue>;
  for (const name of ["immediate", "staged"]) {
    const { engine_trace_hash: ignoredTrace, funding_schedule: ignoredSchedule, ...metrics } = runs[name];
    void ignoredTrace; void ignoredSchedule;
    requireEconomic(sameEconomics(metrics, independent.paths[name].summary), "INVESTOR_FUNDED_HISTORY_ECONOMICS_INVALID");
    if (["investor-funded-history-input-v3", "investor-funded-history-input-v4"].includes(raw.schema_version)) requireEconomic(runs[name].order_review_lineage_hash
      === independent.paths[name].trace.order_review_lineage_hash, "INVESTOR_FUNDED_HISTORY_LINEAGE_INVALID");
    if (raw.schema_version === "investor-funded-history-input-v4") requireEconomic(runs[name].cash_intent_lineage_hash
      === independent.paths[name].trace.cash_intent_lineage_hash, "INVESTOR_FUNDED_HISTORY_LINEAGE_INVALID");
  }
  requireEconomic(comparison.status === (Object.values(independent.paths).some(path => raw.schema_version === "investor-funded-history-input-v4"
    ? path.trace.failed_cash_intent_count! > 0 || path.trace.pending_cash_intent_count! > 0 || path.trace.terminal_execution_failure_count! > 0 || path.trace.unresolved_order_review_count! > 0 : raw.schema_version === "investor-funded-history-input-v3"
    ? path.trace.terminal_execution_failure_count! > 0 || path.trace.unresolved_order_review_count! > 0 : path.trace.execution_failure_count > 0) ? "execution_gaps" : "computed"),
    "INVESTOR_FUNDED_HISTORY_ECONOMICS_INVALID");
  const economics = Object.fromEntries(Object.entries(independent.paths).map(([name, value]) => [name, value.summary]));
  const verification = { ...binding, economics_independently_replayed: true as const, publication_eligible: false as const,
    verification_version: raw.schema_version === "investor-funded-history-input-v4" ? "funded-history-economic-replay-v4" : raw.schema_version === "investor-funded-history-input-v3" ? "funded-history-economic-replay-v3" : raw.schema_version === "investor-funded-history-input-v2" ? "funded-history-economic-replay-v2" : "funded-history-economic-replay-v1", relative_decimal_tolerance: "0.0000000000000000000000000000000000000001",
    absolute_decimal_tolerance_ceiling: "0.000000000001",
    independently_replayed_economics_hash: hash(economics), engine_trace_hash_independently_certified: false as const,
    source_independently_verified: false as const, parameters_independently_preregistered: false as const,
    actual_arrivals_confirmed: false as const, execution_authorized: false as const, live_advice_eligible: false as const,
    principal_cny: economicText(new Decimal(independent.projection.total_assumed_principal_cny)), economics };
  return { verification, independent };
}
export function verifyFundedHistoryEconomics(raw: FundedHistoryInput, claimed: ObjectValue, options: { allowSynthetic?: boolean } = {}) {
  return verifiedFundedHistoryReplay(raw, claimed, options).verification;
}
