import { amount, Decimal, exact } from "../ledger/decimal";

export interface TargetMeasurement {
  account_id: string; listing_id: string; currency: string; weight: string;
  settled_quantity: string; transit_quantity: string; close: string; fx_cny: string;
  quantity_step: string; price_step: string;
}
export interface TargetComparison {
  account_id: string; listing_id: string; currency: string; weight: string;
  target_value_cny: string; owned_value_cny: string; difference_cny: string;
  tolerance_cny: string; within_tolerance: boolean; quantity: string;
  side: "buy" | "sell" | null; residual_cny: string;
}
export interface EvaluationItem {
  account_id: string; listing_id: string; currency: string; side: "buy" | "sell";
  quantity: string; limit_price: string; estimated_fees: string;
}
export interface TargetComparisonResult {
  comparisons: TargetComparison[]; items: EvaluationItem[];
  blockers: { code: string; account_id: string; listing_id: string }[];
}
const display = (value: Decimal) => exact(value.toDecimalPlaces(18, Decimal.ROUND_HALF_EVEN));

/** Planning arithmetic only. Permission, cash, evidence and risk checks are required separately. */
export function compareManualTargets(input: {
  nav_cny: string; rows: TargetMeasurement[]; absolute_tolerance_cny: string;
  weight_tolerance: string; fee_rate_bps: string; minimum_fee_by_currency: Record<string, string>;
}): TargetComparisonResult {
  const nav = amount(input.nav_cny), absolute = amount(input.absolute_tolerance_cny), relative = amount(input.weight_tolerance), feeRate = amount(input.fee_rate_bps);
  if (!nav.gt(0) || absolute.lt(0) || relative.lt(0) || relative.gt(1) || feeRate.lt(0) || feeRate.gt(10000)
    || !input.rows.length || input.rows.length > 100) throw new Error("EVALUATION_TARGET_INPUT_INVALID");
  const tolerance = Decimal.max(absolute, nav.mul(relative));
  const result: TargetComparisonResult = { comparisons: [], items: [], blockers: [] }, seen = new Set<string>();
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  for (const row of [...input.rows].sort((a, b) => compare(a.account_id, b.account_id) || compare(a.listing_id, b.listing_id))) {
    const key = JSON.stringify([row.account_id, row.listing_id]);
    if (!row.account_id || !row.listing_id || !/^[A-Z]{3}$/.test(row.currency) || seen.has(key)) throw new Error("EVALUATION_TARGET_INPUT_INVALID");
    seen.add(key);
    const weight = amount(row.weight), settled = amount(row.settled_quantity), transit = amount(row.transit_quantity);
    const close = amount(row.close), fx = amount(row.fx_cny), step = amount(row.quantity_step), priceStep = amount(row.price_step);
    if (weight.lt(0) || weight.gt(1) || settled.lt(0) || transit.lt(0) || !close.gt(0) || !fx.gt(0) || !step.gt(0) || !priceStep.gt(0)) throw new Error("EVALUATION_TARGET_INPUT_INVALID");
    const target = nav.mul(weight), owned = settled.add(transit).mul(close).mul(fx), delta = target.sub(owned);
    const within = delta.abs().lte(tolerance), side = within ? null : delta.gt(0) ? "buy" : "sell";
    const quantity = within ? amount("0") : delta.abs().div(close.mul(fx)).div(step).floor().mul(step);
    const residual = delta.sub(quantity.mul(close).mul(fx).mul(side === "sell" ? -1 : 1));
    result.comparisons.push({ account_id: row.account_id, listing_id: row.listing_id, currency: row.currency, weight: row.weight,
      target_value_cny: display(target), owned_value_cny: display(owned), difference_cny: display(delta), tolerance_cny: display(tolerance),
      within_tolerance: within, quantity: exact(quantity), side, residual_cny: display(residual) });
    if (!side) continue;
    const block = (code: string) => result.blockers.push({ code, account_id: row.account_id, listing_id: row.listing_id });
    if (quantity.isZero()) { block("EVALUATION_DIFFERENCE_BELOW_TRADING_UNIT"); continue; }
    if (side === "sell" && quantity.gt(settled)) { block("EVALUATION_IN_TRANSIT_NOT_SELLABLE"); continue; }
    const price = close.div(priceStep).toDecimalPlaces(0, side === "buy" ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR).mul(priceStep);
    if (!price.gt(0)) { block("EVALUATION_PRICE_INCREMENT_INVALID"); continue; }
    const minimum = input.minimum_fee_by_currency[row.currency];
    if (minimum === undefined || amount(minimum).lt(0)) { block("EVALUATION_FEE_INPUT_MISSING"); continue; }
    const fees = Decimal.max(amount(minimum), price.mul(quantity).mul(feeRate).div(10000)).toDecimalPlaces(18, Decimal.ROUND_CEIL);
    result.items.push({ account_id: row.account_id, listing_id: row.listing_id, currency: row.currency, side,
      quantity: exact(quantity), limit_price: exact(price), estimated_fees: exact(fees) });
  }
  return result;
}
