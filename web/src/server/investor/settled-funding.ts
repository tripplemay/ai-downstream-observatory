import { Decimal as LedgerDecimal, amount } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { economicInstant, economicStamp, economicText } from "./continuous-market";

type Obj = Record<string, unknown>;
// Keep full fact-range products exact until the final cent ceiling; no global change.
const Decimal = LedgerDecimal.clone({ precision: 256 });
function requireValue(value: unknown, code = "SETTLED_FUNDING_INPUT_INVALID"): asserts value {
  if (!value) throw new Error(code);
}
function object(value: unknown, fields: string): Obj {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const result = value as Obj, expected = fields.split(" ");
  requireValue(Object.keys(result).length === expected.length && expected.every(key => Object.hasOwn(result, key)));
  return result;
}
function ids(value: unknown, maximum: number): string[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= maximum
    && value.every(item => typeof item === "string" && item.trim() === item && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(item))
    && new Set(value).size === value.length);
  return value as string[];
}
function number(value: unknown, positive = false) {
  try {
    requireValue(typeof value === "string" && value.length <= 100 && value.trim() === value);
    const parsed = new Decimal(amount(value).toFixed()); requireValue(positive ? parsed.gt(0) : parsed.gte(0));
    return parsed;
  } catch { throw new Error("SETTLED_FUNDING_INPUT_INVALID"); }
}
function time(value: unknown) {
  try {
    requireValue(typeof value === "string" && value.endsWith("Z") && value.length <= 40);
    return economicInstant(value);
  } catch { throw new Error("SETTLED_FUNDING_INPUT_INVALID"); }
}

/** Independent arithmetic boundary, not source/lineage/strategy admission or an order publisher. */
export function prepareSettledCashBuys(raw: unknown) {
  const value = object(raw, "schema_version intent decision_at decision_times cash book needs execution");
  requireValue(value.schema_version === "settled-cash-buy-preparation-v1");
  const intent = object(value.intent, "id declared_at deadline policy_hash sale_order_ids buy_listing_ids");
  const intentId = ids([intent.id], 1)[0];
  requireValue(typeof intent.policy_hash === "string" && intent.policy_hash.length === 64 && /^[a-f0-9]{64}$/.test(intent.policy_hash));
  const sales = ids(intent.sale_order_ids, 100), scope = ids(intent.buy_listing_ids, 20);
  const declared = time(intent.declared_at), deadline = time(intent.deadline), at = time(value.decision_at);
  requireValue(declared < deadline);
  requireValue(Array.isArray(value.decision_times) && value.decision_times.length > 0 && value.decision_times.length <= 30000);
  const decisions = value.decision_times.map(time);
  requireValue(decisions.every((item, index) => index === 0 || decisions[index - 1] < item));
  requireValue(decisions.includes(at) && at > declared, "SETTLED_FUNDING_DECISION_NOT_DECLARED");
  requireValue(at < deadline, "SETTLED_FUNDING_INTENT_EXPIRED");
  requireValue(Array.isArray(value.book) && value.book.length > 0 && value.book.length <= 10000);
  const book = new Map<string, Obj>();
  for (const item of value.book) {
    const row = object(item, "id listing_id side cash_intent_id state settled_at");
    const id = ids([row.id], 1)[0]; ids([row.listing_id], 1);
    if (row.cash_intent_id !== null) ids([row.cash_intent_id], 1);
    requireValue(!book.has(id) && ["buy", "sell"].includes(row.side as string)
      && ["scheduled", "waiting_for_sales", "filled", "settled", "skipped", "expired"].includes(row.state as string));
    requireValue(row.settled_at === null || time(row.settled_at) <= at);
    book.set(id, row);
  }
  const linked = [...book.values()].filter(row => row.cash_intent_id === intentId);
  requireValue(!linked.some(row => row.side === "buy"), "SETTLED_FUNDING_BUY_ALREADY_PUBLISHED");
  requireValue(linked.length === sales.length && linked.every(row => sales.includes(row.id as string)), "SETTLED_FUNDING_SCOPE_MISMATCH");
  requireValue(sales.every(id => !["skipped", "expired"].includes(book.get(id)!.state as string)), "SETTLED_FUNDING_SALE_FAILED");
  requireValue(sales.every(id => book.get(id)!.state === "settled" && book.get(id)!.settled_at !== null), "SETTLED_FUNDING_SALES_UNSETTLED");
  const settlements = sales.map(id => time(book.get(id)!.settled_at));
  requireValue(settlements.every(item => item > declared), "SETTLED_FUNDING_SALES_UNSETTLED");
  const settled = settlements.reduce((maximum, item) => item > maximum ? item : maximum);
  requireValue(settled < at, "SETTLED_FUNDING_SALES_UNSETTLED");
  const cash = object(value.cash, "as_of settled_cny reserved_cny floor_cny");
  requireValue(time(cash.as_of) === at, "SETTLED_FUNDING_CASH_SNAPSHOT_STALE");
  const available = Decimal.max(0, number(cash.settled_cny).minus(number(cash.reserved_cny)).minus(number(cash.floor_cny)));
  requireValue(available.gt(0), "SETTLED_FUNDING_NO_AVAILABLE_CASH");
  const execution = object(value.execution, "commission_bps minimum_fee_cny fx_bps slippage_bps buy_price_buffer_bps buy_fx_buffer_bps cash_quantum max_fx_age_seconds");
  const rates = Object.fromEntries(["commission_bps", "fx_bps", "slippage_bps", "buy_price_buffer_bps", "buy_fx_buffer_bps"]
    .map(key => [key, number(execution[key])]));
  requireValue(Object.values(rates).every(rate => rate.lte(10000)) && rates.slippage_bps.lt(10000));
  const minimum = number(execution.minimum_fee_cny), age = execution.max_fx_age_seconds;
  requireValue(execution.cash_quantum === "0.01" && typeof age === "number" && Number.isInteger(age) && age > 0 && age <= 31536000);
  requireValue(Array.isArray(value.needs) && value.needs.length === scope.length);
  const needs = new Map<string, { row: Obj; need: LedgerDecimal; step: LedgerDecimal; close: LedgerDecimal; fx: LedgerDecimal }>();
  const newIds = new Set<string>();
  for (const item of value.needs) {
    const row = object(item, "listing_id order_id need_cny quantity_step currency close fx_cny_per_unit observed_at available_at fx_observed_at fx_available_at mark_kind price_observation_id fx_observation_id");
    const listing = ids([row.listing_id], 1)[0];
    requireValue(scope.includes(listing) && !needs.has(listing), "SETTLED_FUNDING_SCOPE_MISMATCH");
    const id = ids([row.order_id], 1)[0]; ids([row.price_observation_id], 1); ids([row.fx_observation_id], 1);
    requireValue(!book.has(id) && !newIds.has(id), "SETTLED_FUNDING_ORDER_ID_REUSED"); newIds.add(id);
    requireValue(["CNY", "HKD", "USD"].includes(row.currency as string));
    const observed = time(row.observed_at), known = time(row.available_at);
    requireValue(row.mark_kind === "observed_close" && settled <= observed && observed <= known && known <= at,
      "SETTLED_FUNDING_POST_SETTLEMENT_CLOSE_REQUIRED");
    if (row.currency === "CNY") requireValue(row.fx_observed_at === null && row.fx_available_at === null);
    else {
      const fxObserved = time(row.fx_observed_at), fxKnown = time(row.fx_available_at);
      requireValue(fxObserved <= fxKnown && fxKnown <= at && at - fxObserved <= BigInt(age) * 1000000n, "SETTLED_FUNDING_FX_UNAVAILABLE");
    }
    const parsed = { row, need: number(row.need_cny, true), step: number(row.quantity_step, true), close: number(row.close, true), fx: number(row.fx_cny_per_unit, true) };
    requireValue(row.currency !== "CNY" || parsed.fx.eq(1));
    needs.set(listing, parsed);
  }
  const totalNeed = [...needs.values()].reduce((total, item) => total.plus(item.need), new Decimal(0));
  const deployment = Decimal.min(available, totalNeed), orders = [];
  for (const listing of [...needs.keys()].sort()) {
    const { row, need, step, close, fx } = needs.get(listing)!;
    const budget = deployment.times(need).div(totalNeed).times(100).floor().div(100);
    const priceCap = close.times(new Decimal(1).plus(rates.buy_price_buffer_bps.div(10000)));
    const fxCap = row.currency !== "CNY" ? fx.times(new Decimal(1).plus(rates.buy_fx_buffer_bps.div(10000))) : new Decimal(1);
    const worst = (units: bigint) => {
      const principal = step.times(units.toString()).times(priceCap.times(new Decimal(1).plus(rates.slippage_bps.div(10000)))).times(fxCap);
      const fee = Decimal.max(minimum, principal.times(rates.commission_bps).div(10000));
      const fxFee = row.currency !== "CNY" ? principal.times(rates.fx_bps).div(10000) : new Decimal(0);
      return principal.plus(fee).plus(fxFee).times(100).ceil().div(100);
    };
    let low = 0n, high = BigInt(budget.div(priceCap.times(fxCap).times(step)).floor().toFixed(0));
    requireValue(high <= 10n ** 30n, "SETTLED_FUNDING_SIZING_RANGE");
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      if (worst(middle).lte(budget)) low = middle; else high = middle - 1n;
    }
    requireValue(low > 0n, "SETTLED_FUNDING_BELOW_MINIMUM_ORDER");
    const quantity = economicText(step.times(low.toString()));
    try { amount(quantity); } catch { throw new Error("SETTLED_FUNDING_SIZING_RANGE"); }
    orders.push({ order_id: row.order_id as string, cash_intent_id: intentId, listing_id: listing, side: "buy" as const,
      quantity, budget_cny: economicText(budget), buy_price_cap: economicText(priceCap), buy_fx_cap: economicText(fxCap),
      worst_total_cash_cny: economicText(worst(low)), decision_price_observation_id: row.price_observation_id as string,
      decision_fx_observation_id: row.fx_observation_id as string });
  }
  const totalBudget = orders.reduce((total, order) => total.plus(order.budget_cny), new Decimal(0));
  requireValue(totalBudget.lte(available));
  return { schema_version: "settled-cash-buy-preparation-result-v1" as const, input_hash: hash(value),
    intent_id: intentId, policy_hash: intent.policy_hash, decision_at: economicStamp(at), latest_sale_settlement_at: economicStamp(settled),
    cash_snapshot_hash: hash(cash), available_cash_cny: economicText(available), total_budget_cny: economicText(totalBudget),
    total_worst_cash_cny: economicText(orders.reduce((total, order) => total.plus(order.worst_total_cash_cny), new Decimal(0))),
    unreserved_cash_cny: economicText(available.minus(totalBudget)), orders, published: false as const, live_advice_eligible: false as const };
}
