import { Decimal } from "../ledger/decimal";

// Retain all accepted rate digits before rounding a hypothetical amount to cents.
const RiskDecimal = Decimal.clone({ precision: 160 });
const amountPattern = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;
const returnPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,120})?$/;

/** A static shock on a hypothetical amount, not a historical peak loss or account valuation. */
export function projectRiskScenario(portfolioReturn: string, hypotheticalCapitalCny: string | null) {
  if (portfolioReturn.length > 200 || !returnPattern.test(portfolioReturn)) throw new Error("INVESTOR_RISK_SCENARIO_INVALID");
  const change = new RiskDecimal(portfolioReturn);
  if (!change.isFinite() || change.lt(-1) || change.gt(1)) throw new Error("INVESTOR_RISK_SCENARIO_INVALID");
  if (hypotheticalCapitalCny !== null && !amountPattern.test(hypotheticalCapitalCny)) throw new Error("INVESTOR_RISK_AMOUNT_INVALID");
  const capital = hypotheticalCapitalCny === null ? null : new RiskDecimal(hypotheticalCapitalCny);
  const moneyChange = capital === null ? null : capital.times(change).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const recovery = change.gte(0) ? new RiskDecimal(0) : change.eq(-1) ? null : change.negated().div(change.plus(1)).toDecimalPlaces(120);
  return { portfolio_return: change.isZero() ? "0" : change.toFixed(), capital_cny: capital?.toFixed(2) ?? null,
    change_cny: moneyChange?.toFixed(2) ?? null, remaining_cny: capital === null ? null : capital.plus(moneyChange!).toFixed(2),
    recovery_gain: recovery === null ? null : recovery.toFixed(),
    basis: "static_hypothetical_amount_not_account_or_peak_valuation" as const };
}
