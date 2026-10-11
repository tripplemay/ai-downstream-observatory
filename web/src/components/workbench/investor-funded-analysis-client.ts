import { Decimal } from "@/server/ledger/decimal";
import { fundedAnalysisSchema, type FundedPathAnalysis } from "@/server/investor/funded-analysis-schemas";
import type { FundedComparison } from "@/server/investor/funded-comparison-schemas";
import { investorHash } from "@/server/investor/schemas";
import { observedMonthlyRisk } from "@/server/investor/funded-analysis-statistics";

const responseSchema = fundedAnalysisSchema.innerType().extend({ session_binding: investorHash }).strict();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function sha(value: unknown) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
const stamp = (value: string) => value.slice(0, 19) + "." + (value.slice(19, -1).replace(/^\./, "")).padEnd(6, "0") + "Z";
const calendarDays = (from: string, to: string, formatter: Intl.DateTimeFormat) => {
  const local = (value: string) => { const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(row => [row.type, row.value]));
    return Date.parse(`${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}T00:00:00Z`); };
  return (local(to) - local(from)) / 86400000;
};
export async function parseFundedAnalysis(raw: unknown, comparison: FundedComparison, binding: string, parameters: string, path: "immediate" | "staged", now = Date.now()): Promise<FundedPathAnalysis> {
  const parsed = responseSchema.safeParse(raw), candidate = comparison.candidates.find(row => row.parameters_hash === parameters);
  function demand(value: unknown): asserts value { if (!value) throw new Error("FUNDED_ANALYSIS_RESPONSE_INVALID"); }
  demand(parsed.success && parsed.data.session_binding === binding && parsed.data.parameters_hash === parameters && parsed.data.path === path);
  const { session_binding: ignored, ...body } = parsed.data; void ignored;
  const value = fundedAnalysisSchema.parse(body);
  for (const key of ["workspace_id", "workspace_revision", "profile_id", "funding_plan_id", "request_id", "input_version", "run_id", "valid_until"] as const)
    demand(value[key] === comparison[key]);
  demand(candidate?.paths && candidate.economics_hash && comparison.valid_until && Date.parse(comparison.valid_until) > now
    && Date.parse(value.checked_at) <= now + 60000 && stamp(value.checked_at) >= stamp(comparison.checked_at) && value.analysis);
  const data = value.analysis;
  demand(data.economics_hash === candidate.economics_hash && canonical(data.candidate.summary) === canonical(candidate.paths[path])
    && data.candidate.summary.principal_cny === data.baseline.summary.principal_cny);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: data.evaluation_timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  demand(stamp(data.window.start) < stamp(data.window.end));
  for (const series of [data.candidate, data.baseline]) {
    demand(await sha(series.daily) === series.daily_curve_hash && series.daily.length <= series.full_observation_count);
    let previousDate = "", previousPrincipal = new Decimal(0);
    for (const point of series.daily) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(point.at)).map(row => [row.type, row.value]));
      const nav = new Decimal(point.nav_cny), principal = new Decimal(point.principal_cny), cash = new Decimal(point.cash_cny), locked = new Decimal(point.locked_cash_cny);
      demand(point.local_date === `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}` && point.local_date > previousDate
        && stamp(point.at) >= stamp(data.window.start) && stamp(point.at) <= stamp(data.window.end) && nav.gte(cash) && principal.gt(0) && principal.gte(previousPrincipal)
        && nav.minus(principal).eq(point.profit_cny) && cash.gte(locked) && locked.gte(0)
        && new Decimal(point.unit_nav).gte(0) && (point.drawdown === null || new Decimal(point.drawdown).gte(-1) && new Decimal(point.drawdown).lte(0)));
      previousDate = point.local_date; previousPrincipal = principal;
    }
    const last = series.daily.at(-1)!;
    demand(stamp(last.at) === stamp(data.window.end) && last.nav_cny === series.summary.ending_nav_cny && last.principal_cny === series.summary.principal_cny
      && last.profit_cny === series.summary.profit_cny && last.locked_cash_cny === series.summary.ending_locked_cash_cny
      && series.risk.max_drawdown === series.summary.max_drawdown && series.risk.recovered_at === series.summary.recovered_at);
    const risk = series.risk, derived = observedMonthlyRisk(series.daily, risk.status === "computed");
    demand(canonical(derived.monthly) === canonical(series.monthly) && canonical(derived.rolling) === canonical(series.rolling));
    demand((risk.status === "computed") === (risk.max_drawdown !== null));
    for (const point of series.daily) demand(risk.status === "unit_nav_unavailable" ? point.drawdown === null
      : point.drawdown !== null && new Decimal(point.drawdown).gte(risk.max_drawdown!));
    const within = (at: string) => stamp(at) >= stamp(data.window.start) && stamp(at) <= stamp(data.window.end);
    const decline = risk.max_drawdown !== null && new Decimal(risk.max_drawdown).lt(0);
    demand((risk.peak_at !== null) === (risk.trough_at !== null));
    if (risk.status === "computed") demand(decline === (risk.peak_at !== null));
    if (risk.peak_at) demand(within(risk.peak_at) && within(risk.trough_at!) && stamp(risk.peak_at) < stamp(risk.trough_at!));
    if (risk.recovered_at) demand(risk.trough_at && within(risk.recovered_at) && stamp(risk.recovered_at) > stamp(risk.trough_at)
      && risk.recovery_days === calendarDays(risk.trough_at, risk.recovered_at, formatter));
    else demand(risk.recovery_days === null);
    const episode = risk.longest_underwater;
    if (episode) demand(risk.peak_at && within(episode.peak_at) && within(episode.trough_at) && stamp(episode.peak_at) < stamp(episode.trough_at)
      && episode.ongoing === (episode.recovered_at === null)
      && (!episode.recovered_at || within(episode.recovered_at) && stamp(episode.recovered_at) > stamp(episode.trough_at))
      && episode.duration_days === calendarDays(episode.peak_at, episode.recovered_at ?? data.window.end, formatter));
  }
  for (const [field, key] of [["ending_nav_difference_cny", "ending_nav_cny"], ["profit_difference_cny", "profit_cny"], ["fees_difference_cny", "fees_cny"],
    ["fx_fees_difference_cny", "fx_fees_cny"], ["slippage_difference_cny", "slippage_cny"]] as const)
    demand(new Decimal(data.candidate.summary[key]).minus(data.baseline.summary[key]).eq(data.comparison[field]));
  const a = data.candidate.summary.twr, b = data.baseline.summary.twr;
  demand(a === null || b === null ? data.comparison.twr_difference === null : data.comparison.twr_difference !== null && new Decimal(a).minus(b).eq(data.comparison.twr_difference));
  demand(value.economics_independently_replayed === (data.candidate.summary.execution_failure_count === 0 && data.baseline.summary.execution_failure_count === 0));
  return value;
}
