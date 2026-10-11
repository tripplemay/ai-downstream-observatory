import { Decimal } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { prepareFixedPolicy, evaluateFixedPolicy, nextFixedPolicyState } from "./fixed-policy-monitor";

type Obj = Record<string, unknown>;
const dec = (value: unknown) => new Decimal(String(value));
const time = (value: unknown) => priceInstant(String(value));
const sum = (values: Decimal[]) => values.reduce((a, b) => a.add(b), new Decimal(0));
const canonical = (value: Decimal) => value.isZero() ? "0" : value.toFixed();
function stamp(value: bigint) {
  const seconds = value / 1000000n - (value < 0n && value % 1000000n !== 0n ? 1n : 0n);
  return new Date(Number(seconds * 1000n)).toISOString().slice(0, 19) + "." + String(value - seconds * 1000000n).padStart(6, "0") + "Z";
}

/** Replay decisions and cost reservations, not just a worker's sealed totals. */
export function replayEvidenceAssessment(document: Obj, now: string, implementationHash: string) {
  const fixed = document.schema_version === "investor-model-monitor-v3", context = fixed ? prepareFixedPolicy(document, now) : null;
  const at = time(now), quotes = document.quotes as Obj[], fx = document.fx as Obj[], policy = document.policy as Obj;
  const before = document.before_weights as Record<string, string>, after = document.after_weights as Record<string, string>;
  const quantities = document.quantities as Record<string, string>, cash = dec(document.cash_cny), nonCash = dec(document.non_cash_assets_cny ?? "0");
  const intent = document.funding_intent as Obj | null, due = intent !== null && time(intent.expected_at) <= at;
  const toleranceRule = context?.parameters.tolerance as Obj | undefined;
  const funding = due ? dec(intent!.amount_cny) : new Decimal(0), band = dec(toleranceRule?.weight ?? policy.weight_band), absolute = dec(toleranceRule?.absolute_cny ?? policy.absolute_band_cny);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(quantities)])].sort();
  const gaps = [...document.quality_gaps as string[]], cutoffs: bigint[] = [], deadlines: bigint[] = [];
  const quoteMap = Object.fromEntries(quotes.map(row => [String(row.listing_id), row]));
  if (fixed) {
    const currencies = [...new Set(quotes.map(row => String(row.currency)))].filter(currency => currency !== "CNY").sort();
    if (!sum(Object.values(before).map(dec)).eq(1) || !sum(Object.values(after).map(dec)).eq(1)
      || [...Object.values(before), ...Object.values(after)].some(value => dec(value).lt(0) || dec(value).gt(1))
      || [...Object.values(quantities), cash, nonCash].some(value => dec(value).lt(0))
      || quotes.length !== keys.length || hash(Object.keys(quoteMap).sort()) !== hash(keys)
      || fx.length !== currencies.length || hash(fx.map(row => String(row.currency)).sort()) !== hash(currencies)
      || intent !== null && !dec(intent.amount_cny).gt(0)) throw new Error("INVESTOR_EVIDENCE_INVALID");
    const costs = policy.costs as Obj | null;
    if (costs && (["commission_bps", "minimum_fee_cny", "fx_bps", "slippage_bps", "maximum_cost_fraction"].some(key => dec(costs[key]).lt(0))
      || ["commission_bps", "fx_bps", "slippage_bps"].some(key => dec(costs[key]).gte(10000)) || dec(costs.maximum_cost_fraction).gt(1))) throw new Error("INVESTOR_EVIDENCE_INVALID");
  }
  for (const row of quotes) {
    const observed = time(row.observed_at), known = time(row.known_at), expected = time(row.expected_close_at), expiry = time(row.valid_until);
    if (!dec(row.close).gt(0) || known < observed || expected > at || expiry <= known) throw new Error("INVESTOR_EVIDENCE_INVALID");
    if (known > at || observed > at) gaps.push("QUOTE_NOT_KNOWN_AT_EVALUATION");
    if (observed !== expected || expiry <= at) gaps.push("MARKET_DATA_NOT_CURRENT:" + row.market);
    cutoffs.push(observed); deadlines.push(expiry);
  }
  for (const row of fx) {
    const observed = time(row.observed_at), known = time(row.known_at), expiry = time(row.valid_until);
    if (!dec(row.value).gt(0) || known < observed || expiry <= known) throw new Error("INVESTOR_EVIDENCE_INVALID");
    if (known > at || observed > at) gaps.push("FX_NOT_KNOWN_AT_EVALUATION");
    if (expiry <= at || at - observed > BigInt(Number(policy.max_fx_age_seconds)) * 1000000n) gaps.push("FX_NOT_CURRENT:" + row.currency);
    cutoffs.push(observed); deadlines.push(expiry);
  }
  if (intent && !due) deadlines.push(time(intent.expected_at));
  const min = (values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
  const output: Obj = { schema_version: fixed ? "investor-model-assessment-v2" : "investor-model-assessment-v1", engine_version: fixed ? "investor-fixed-policy-monitor-v1" : "investor-model-monitor-v1", implementation_hash: implementationHash,
    profile_id: document.profile_id, profile_version: document.profile_version, input_version: hash({ document, funding_due: due }), evaluated_at: stamp(at),
    data_cutoff: stamp(min(cutoffs)), market_cutoffs: Object.fromEntries([...new Set(quotes.map(row => String(row.market)))].sort().map(market =>
      [market, stamp(min(quotes.filter(row => row.market === market).map(row => time(row.observed_at))))])),
    next_review_at: min(deadlines) > at ? stamp(min(deadlines)) : null, gaps: [...new Set(gaps)].sort(), reason_codes: [], changes: [], model_nav_cny: null,
    estimated_cost_cny: null, allocation_method: "none", hypothetical_cash_remaining_cny: null, funding_status: due ? "hypothetical_due" : intent ? "not_due" : "none",
    constraints_not_checked: ["lot_size", "tradability", "actual_cash", "settlement", "tax", "account_permissions"], scope: "research_model",
    actual_holdings_linked: false, execution_authorized: false, live_advice_eligible: false };
  if (context) { output.policy_evaluation = null; output.next_policy_state = context.state; }
  const finish = (outcome: string, reasons: string[]) => {
    if (context) output.next_policy_state = nextFixedPolicyState(context, outcome);
    const result = { ...output, outcome, reason_codes: reasons }; return { ...result, result_hash: hash(result) };
  };
  if (gaps.length) return finish("insufficient_evidence", ["REQUIRED_INPUTS_NOT_CURRENT"]);
  const values = Object.fromEntries(keys.map(key => { const row = quoteMap[key]; return [key, dec(quantities[key] ?? "0").mul(String(row.close))
    .mul(row.currency === "CNY" ? "1" : String(fx.find(value => value.currency === row.currency)!.value))]; }));
  const nav = cash.add(nonCash).add(sum(Object.values(values))), projected = nav.add(funding), tolerance = Decimal.max(absolute, projected.mul(band));
  if (!nav.gt(0)) throw new Error("INVESTOR_EVIDENCE_INVALID");
  output.model_nav_cny = canonical(nav);
  let triggers: string[] = [];
  if (due) triggers.push("NEW_PLANNED_FUNDING");
  if (keys.some(key => dec(after[key] ?? "0").sub(before[key] ?? "0").abs().gt(band))) triggers.push("TARGET_WEIGHTS_CHANGED");
  if (keys.some(key => values[key].sub(nav.mul(after[key] ?? "0")).abs().gt(Decimal.max(absolute, nav.mul(band))))) triggers.push("MODEL_DRIFT_OUTSIDE_BAND");
  let repair = due;
  if (context) { output.policy_evaluation = evaluateFixedPolicy(context, document, values, nav, due); triggers = context.triggers; repair = context.repair; }
  const differences = Object.fromEntries(keys.map(key => [key, projected.mul(after[key] ?? "0").sub(values[key])]));
  const changes = keys.map(key => ({ listing_id: key, before_target_weight: canonical(dec(before[key] ?? "0")), after_target_weight: canonical(dec(after[key] ?? "0")),
    observed_model_weight: canonical(values[key].div(nav)), current_model_value_cny: canonical(values[key]), hypothetical_target_value_cny: canonical(projected.mul(after[key] ?? "0")),
    difference_cny: canonical(differences[key]), within_band: differences[key].abs().lte(tolerance), proposed_change_cny: "0", remaining_target_difference_cny: canonical(differences[key]) }));
  output.changes = changes;
  if (!triggers.length) return finish("observe", [fixed ? "FIXED_POLICY_WITHIN_CLASS_BANDS" : "MODEL_WITHIN_CONFIRMED_BANDS"]);
  if (context) {
    if (!context.eligible) return finish("observe", ["POLICY_COOLDOWN_NO_NEW_ADVICE", ...triggers]);
    if (changes.every(row => row.within_band)) return finish("observe", ["POLICY_TARGETS_WITHIN_TOLERANCE", ...triggers]);
  }
  const costs = policy.costs as Obj | null;
  if (!costs) { output.gaps = ["COST_ASSUMPTIONS_MISSING"]; return finish("insufficient_evidence", ["CANNOT_COMPARE_CHANGE_COST"]); }
  const rates = Object.fromEntries(["commission_bps", "minimum_fee_cny", "fx_bps", "slippage_bps", "maximum_cost_fraction"].map(key => [key, dec(costs[key])]));
  if (Object.values(rates).some(value => value.lt(0)) || ["commission_bps", "fx_bps", "slippage_bps"].some(key => rates[key].gte(10000)) || rates.maximum_cost_fraction.gt(1)) throw new Error("INVESTOR_EVIDENCE_INVALID");
  const estimate = (proposal: Record<string, Decimal>) => sum(keys.map(key => { const notional = proposal[key].abs(); return notional.isZero() ? new Decimal(0)
    : Decimal.max(rates.minimum_fee_cny, notional.mul(rates.commission_bps).div(10000)).add(notional.mul(rates.slippage_bps.add(quoteMap[key].currency === "CNY" ? 0 : rates.fx_bps)).div(10000)); }));
  let proposal: Record<string, Decimal>;
  if (repair) {
    const deficits = Object.fromEntries(keys.map(key => [key, fixed && differences[key].abs().lte(tolerance) ? new Decimal(0) : Decimal.max(0, differences[key])])), total = sum(Object.values(deficits)), available = cash.add(funding);
    const amounts = (scale: Decimal) => Object.fromEntries(keys.map(key => [key, deficits[key].mul(scale).toDecimalPlaces(2, Decimal.ROUND_DOWN)]));
    if (total.isZero() || available.isZero()) proposal = amounts(new Decimal(0));
    else {
      let upper = Decimal.min(1, available.div(total)), lower = new Decimal(0); proposal = amounts(upper);
      if (sum(Object.values(proposal)).add(estimate(proposal)).gt(available)) {
        for (let i = 0; i < 100; i++) { const midpoint = lower.add(upper).div(2), candidate = amounts(midpoint);
          if (sum(Object.values(candidate)).add(estimate(candidate)).lte(available)) lower = midpoint; else upper = midpoint; }
        proposal = amounts(lower);
      }
    }
    output.allocation_method = "contribution_repair_without_sales";
  } else {
    proposal = Object.fromEntries(keys.map(key => [key, differences[key].abs().gt(tolerance) ? differences[key] : new Decimal(0)]));
    output.allocation_method = "band_rebalance_research_not_executable";
  }
  const cost = estimate(proposal); output.estimated_cost_cny = canonical(cost);
  for (const row of changes) { row.proposed_change_cny = canonical(proposal[row.listing_id]); row.remaining_target_difference_cny = canonical(differences[row.listing_id].sub(proposal[row.listing_id])); }
  if (repair) {
    output.hypothetical_cash_remaining_cny = canonical(cash.add(funding).sub(sum(Object.values(proposal))).sub(cost));
    if (!Object.values(proposal).some(amount => amount.gt(0))) { output.gaps = ["FUNDING_CANNOT_BE_ALLOCATED_WITHIN_COST_BUDGET"]; return finish("insufficient_evidence", ["NO_COST_QUALIFIED_CONTRIBUTION_REPAIR"]); }
  }
  if (cost.div(projected).gt(rates.maximum_cost_fraction)) { output.gaps = ["CHANGE_COST_EXCEEDS_POLICY"]; return finish("insufficient_evidence", ["CHANGE_NOT_COST_QUALIFIED"]); }
  return finish("decision_required", triggers);
}
