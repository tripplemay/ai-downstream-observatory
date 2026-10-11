import { Decimal } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";

type Obj = Record<string, unknown>;
type Context = {
  parameters: Obj; state: Obj; at: bigint; timezone: string; reviewPeriod: string; calendarDue: boolean; cooldownActive: boolean;
  triggers: string[]; repair: boolean; eligible: boolean; cash: Decimal; newFunding: boolean; newCash: boolean; pendingCash: boolean;
  fundingDue: boolean; fundingIntent: Obj | null;
};
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_EVIDENCE_INVALID"); }
const dec = (value: unknown) => new Decimal(String(value));
const time = (value: unknown) => priceInstant(String(value));
const canonical = (value: Decimal) => value.isZero() ? "0" : value.toFixed();
function fact(value: unknown) {
  const [whole, fractional = ""] = String(value).replace(/^-/, "").split(".");
  check(Math.max(1, (whole + fractional).replace(/^0+/, "").length) <= 38 && fractional.length <= 18);
  return dec(value);
}
function localDate(at: bigint, timezone: string) {
  const milliseconds = at / 1000n - (at < 0n && at % 1000n !== 0n ? 1n : 0n);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(Number(milliseconds)));
  const field = (type: string) => parts.find(row => row.type === type)!.value;
  const year = field("year").padStart(4, "0"), month = field("month"), day = field("day");
  return { year, month: Number(month), ordinal: Date.parse(`${year}-${month}-${day}T00:00:00Z`) / 86400000 };
}
function period(at: bigint, timezone: string, schedule: unknown) {
  const date = localDate(at, timezone);
  check(schedule === "first_decision_each_year" || schedule === "first_decision_each_half_year");
  return date.year + (schedule === "first_decision_each_half_year" ? `-H${date.month <= 6 ? 1 : 2}` : "");
}
function stamp(at: bigint) {
  const seconds = at / 1000000n - (at < 0n && at % 1000000n !== 0n ? 1n : 0n);
  const fraction = at - seconds * 1000000n;
  return new Date(Number(seconds * 1000n)).toISOString().slice(0, 19) + "." + String(fraction).padStart(6, "0") + "Z";
}
function fundingHash(intent: Obj) {
  return hash({ id: intent.id, amount_cny: canonical(dec(intent.amount_cny)), expected_at: stamp(time(intent.expected_at)) });
}

/** State provenance must be bound by the publisher, never asserted by an app. */
export function prepareFixedPolicy(document: Obj, now: string): Context {
  const rule = document.fixed_policy as Obj, parameters = rule.parameters as Obj, state = rule.state as Obj;
  const weights = parameters.weights as Record<string, string>, roles = parameters.roles as Record<string, string>, tolerance = parameters.tolerance as Obj;
  const at = time(now), timezone = String(rule.evaluation_timezone), keys = Object.keys(weights).sort();
  const sameKeys = (value: unknown) => hash(Object.keys(value as Obj).sort()) === hash(keys);
  check(sameKeys(roles) && sameKeys(document.quantities) && ["before_weights", "after_weights"].every(key => sameKeys(document[key])
    && Object.entries(weights).every(([listing, weight]) => dec((document[key] as Obj)[listing]).eq(weight)))
    && Object.values(weights).every(weight => fact(weight).gte(0) && fact(weight).lte(1))
    && document.before_plan_hash === document.after_plan_hash
    && fact(parameters.class_drift_threshold).gt(0) && fact(parameters.class_drift_threshold).lte(1)
    && fact(tolerance.absolute_cny).gte(0) && fact(tolerance.weight).gte(0) && fact(tolerance.weight).lte(1));
  const review = state.last_review_at === null ? null : time(state.last_review_at), proposed = state.last_proposed_at === null ? null : time(state.last_proposed_at);
  check([review, proposed].every(value => value === null || value <= at) && (proposed === null || review !== null && proposed <= review)
    && (state.last_funding_hash === null || proposed !== null) && (state.cash_cny_seen === null || dec(state.cash_cny_seen).gte(0))
    && (state.cash_cny_seen !== null || review === null && proposed === null && !state.cash_repair_pending));
  const reviewPeriod = period(at, timezone, parameters.rebalance), days = Number(parameters.minimum_days_between_rebalances);
  check(Number.isSafeInteger(days) && days >= 1 && days <= 366);
  return { parameters, state: structuredClone(state), at, timezone, reviewPeriod,
    calendarDue: review === null || period(review, timezone, parameters.rebalance) !== reviewPeriod,
    cooldownActive: proposed !== null && localDate(at, timezone).ordinal - localDate(proposed, timezone).ordinal < days,
    triggers: [], repair: false, eligible: false, cash: dec(document.cash_cny), newFunding: false, newCash: false, pendingCash: false,
    fundingDue: false, fundingIntent: document.funding_intent as Obj | null };
}

export function evaluateFixedPolicy(context: Context, document: Obj, values: Record<string, Decimal>, nav: Decimal, due: boolean) {
  const { parameters, state, cash } = context, weights = parameters.weights as Record<string, string>, roles = parameters.roles as Record<string, string>;
  const targets: Record<string, Decimal> = {}, current: Record<string, Decimal> = {};
  check(nav.gt(0) && Object.values(values).every(value => value.gte(0)));
  for (const [listing, weight] of Object.entries(weights)) {
    const role = roles[listing]; check(["growth", "defensive", "diversifier"].includes(role));
    targets[role] = (targets[role] ?? new Decimal(0)).add(weight);
    current[role] = (current[role] ?? new Decimal(0)).add(values[listing].div(nav));
  }
  const classes = Object.keys(targets).sort().map(role => ({ role, target_weight: canonical(targets[role]), current_weight: canonical(current[role]),
    difference_weight: canonical(current[role].sub(targets[role])), threshold_breached: current[role].sub(targets[role]).abs().gte(dec(parameters.class_drift_threshold)) }));
  context.newCash = state.cash_cny_seen !== null && cash.gt(dec(state.cash_cny_seen));
  context.pendingCash = cash.gt(0) && (Boolean(state.cash_repair_pending) || context.newCash);
  context.newFunding = due && fundingHash(context.fundingIntent!) !== state.last_funding_hash;
  context.fundingDue = due;
  context.triggers = [
    ...(due ? [context.newFunding ? "NEW_PLANNED_FUNDING" : "PLANNED_FUNDING_REVIEW_OPEN"] : []),
    ...(context.pendingCash ? [context.newCash ? "NEW_MODEL_CNY_CASH" : "MODEL_CNY_CASH_REVIEW_OPEN"] : []),
    ...(context.calendarDue ? ["CALENDAR_POLICY_REVIEW"] : []),
    ...(classes.some(row => row.threshold_breached) ? ["CLASS_WEIGHT_BREACH"] : []),
  ];
  context.repair = due || context.pendingCash; context.eligible = context.repair || !context.cooldownActive;
  return { parameters_hash: hash(parameters), evaluation_timezone: context.timezone, review_period: context.reviewPeriod,
    calendar_due: context.calendarDue, cooldown_active: context.cooldownActive, new_funding: context.newFunding, new_cny_cash: context.newCash,
    cash_repair_pending: context.pendingCash, class_drift: classes };
}

export function nextFixedPolicyState(context: Context, outcome: string) {
  const state = structuredClone(context.state);
  if (outcome === "insufficient_evidence") return state;
  state.cash_cny_seen = canonical(context.cash); state.cash_repair_pending = context.pendingCash;
  if (context.eligible && context.triggers.length && (context.calendarDue || !context.repair || context.newFunding || context.newCash)) state.last_review_at = stamp(context.at);
  if (outcome === "decision_required") {
    if (state.last_proposed_at === null || !context.repair || context.newFunding || context.newCash) state.last_proposed_at = stamp(context.at);
    if (context.fundingDue) state.last_funding_hash = fundingHash(context.fundingIntent!);
  }
  return state;
}
