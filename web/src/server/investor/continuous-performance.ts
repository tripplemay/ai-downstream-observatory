import { Decimal } from "../ledger/decimal";
import { economicDate, economicInstant, requireEconomic } from "./continuous-market";

type Flow = { at: bigint; amount: Decimal; before: Decimal };
type Point = { at: string; nav_cny: string; unit_nav: string };
const sum = (values: Decimal[]) => values.reduce((a, b) => a.plus(b), new Decimal(0));
const day = (date: string) => Date.parse(date + "T00:00:00Z") / 86400000;
const text = (value: Decimal | null) => value === null ? null : value.isZero() ? "0" : value.toFixed();

/** Positive capital arrivals and one terminal asset value have at most one XIRR root. */
function contributionXirr(flows: { date: string; amount: Decimal }[]) {
  const grouped = new Map<string, Decimal>();
  for (const flow of flows) grouped.set(flow.date, (grouped.get(flow.date) ?? new Decimal(0)).plus(flow.amount));
  const all = [...grouped].sort(([a], [b]) => a.localeCompare(b));
  const duration_days = day(all.at(-1)![0]) - day(all[0][0]);
  const result = (status: string, rate: Decimal | null = null) => ({ status, rate: status === "ok" ? text(rate) : null,
    roots: rate === null ? [] : [text(rate)!], duration_days });
  if (!duration_days) return result("same_day_flows");
  const nonzero = all.filter(([, amount]) => !amount.isZero());
  if (!nonzero.length) return result("ambiguous");
  if (!nonzero.some(([, value]) => value.gt(0)) || !nonzero.some(([, value]) => value.lt(0))) return result("missing_signs");
  requireEconomic(nonzero.slice(0, -1).every(([, amount]) => amount.lt(0)) && nonzero.at(-1)![1].gt(0));
  const first = day(nonzero[0][0]), scale = Decimal.max(...nonzero.map(([, amount]) => amount.abs()));
  const terms = nonzero.map(([date, amount]) => ({ day: day(date) - first, amount: amount.div(scale) }));
  const value = (x: Decimal) => {
    const anchor = x.gte(0) ? terms[0].day : terms.at(-1)!.day;
    return sum(terms.map(term => term.amount.times(new Decimal(term.day - anchor).negated().times(x).exp())));
  };
  let bound = new Decimal(1), bracketed = false;
  for (let index = 0; index < 18; index++) {
    const right = sum(terms.slice(1).map(term => term.amount.abs().times(new Decimal(term.day - terms[0].day).negated().times(bound).exp())));
    const left = sum(terms.slice(0, -1).map(term => term.amount.abs().times(new Decimal(terms.at(-1)!.day - term.day).negated().times(bound).exp())));
    if (right.lt(terms[0].amount.abs()) && left.lt(terms.at(-1)!.amount.abs())) { bracketed = true; break; }
    bound = bound.times(2);
  }
  if (!bracketed) return result("ambiguous");
  let left = bound.negated(), right = bound, leftValue = value(left), candidate: Decimal | null = null;
  for (let index = 0; index < 256; index++) {
    const middle = left.plus(right).div(2), middleValue = value(middle);
    if (middleValue.isZero() || right.minus(left).lte("1e-48")) { candidate = middle; break; }
    if (leftValue.gt(0) === middleValue.gt(0)) { left = middle; leftValue = middleValue; } else right = middle;
  }
  if (candidate === null) return result("ambiguous");
  const rate = candidate.times(365).exp().minus(1);
  if (!rate.isFinite() || rate.lte(-1)) return result("ambiguous");
  const daily = rate.plus(1).ln().div(365);
  const residual = sum(nonzero.map(([date, amount]) => amount.times(new Decimal(day(date) - first).negated().times(daily).exp())));
  return residual.abs().gt("0.000000000001") ? result("ambiguous", rate) : result("ok", rate);
}

export function continuousPerformance(start: bigint, end: bigint, initial: Decimal, closing: Decimal, flows: Flow[], curve: Point[], zone: string) {
  let factor = new Decimal(1), previous = initial, valid = initial.gt(0);
  for (const flow of flows) {
    requireEconomic(start < flow.at && flow.at <= end && flow.amount.gt(0));
    if (previous.lte(0) || flow.before.lte(0) || flow.before.plus(flow.amount).lte(0)) { valid = false; break; }
    factor = factor.times(flow.before.div(previous)); previous = flow.before.plus(flow.amount);
  }
  const twr = valid ? factor.times(closing).div(previous).minus(1) : null;
  let peak: Decimal | null = null, worst = new Decimal(0), worstPeak: Decimal | null = null, recovered: string | null = null, gap = false;
  for (const point of curve) {
    const value = new Decimal(point.unit_nav);
    requireEconomic(value.gte(0));
    if (peak === null) { if (value.isZero()) { gap = true; continue; } peak = value; }
    if (worstPeak !== null && recovered === null && value.gte(worstPeak)) recovered = point.at;
    if (value.gte(peak)) peak = value;
    const decline = value.div(peak).minus(1);
    if (decline.lt(worst)) { worst = decline; worstPeak = peak; recovered = null; }
  }
  const days = day(economicDate(end, zone)) - day(economicDate(start, zone));
  const annual = days > 0 ? new Decimal(curve.at(-1)!.unit_nav).pow(new Decimal(365).div(days)).minus(1) : null;
  const xirr = contributionXirr([{ date: economicDate(start, zone), amount: initial.negated() },
    ...flows.map(flow => ({ date: economicDate(flow.at, zone), amount: flow.amount.negated() })),
    { date: economicDate(end, zone), amount: closing }]);
  requireEconomic(curve.every((point, index) => index === 0 || economicInstant(point.at) > economicInstant(curve[index - 1].at)));
  return { twr: text(twr), return_method: "exact_twr", annualized_unit_return: text(annual), xirr,
    max_drawdown: gap ? null : text(worst), recovered_at: recovered };
}
