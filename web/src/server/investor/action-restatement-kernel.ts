import { Decimal } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { modelDefinitionHash } from "./fixed-policy";
import { validateActionRestatementKernel } from "./kernel-contracts";

type Obj = Record<string, unknown>;
type Economics = Obj & { quantities: Obj; cash_by_currency: Obj; receivables: Obj[]; entitlements: Record<string, Obj>; processed_actions: Obj };
const fields = ["initialized_at", "market_cutoffs", "quantities", "cash_by_currency", "receivables", "entitlements", "processed_actions", "initial_notional_cny"];
const rank: Record<string, number> = { split: 0, dividend_ex: 1, dividend_payment: 2 };
function check(value: unknown, code: string): asserts value { if (!value) throw new Error("INVESTOR_RESTATEMENT_" + code); }
function obj(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value), "OBJECT"); return value as Obj; }
function text(value: unknown): string { check(typeof value === "string", "TEXT"); return value; }
function rows(value: unknown): Obj[] { check(Array.isArray(value), "ROWS"); return value.map(obj); }
const time = (value: unknown) => priceInstant(text(value));
const dec = (value: unknown) => new Decimal(text(value));
const number = (value: Decimal) => {
  check(value.isFinite() && value.abs().lt("1e200") && value.decimalPlaces() <= 120, "DERIVED_RANGE");
  const result = value.isZero() ? "0" : value.toFixed(); check(result.length <= 200, "DERIVED_RANGE"); return result;
};
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const keys = (value: Obj) => Object.keys(value).sort();
const sum = (values: Decimal[]) => values.reduce((a, b) => a.add(b), new Decimal(0));
const economics = (value: Obj) => Object.fromEntries(fields.map(key => [key, structuredClone(value[key])])) as Economics;

function quoteBinding(definition: Obj, projection: Obj) {
  const targetRows = rows(definition.targets), quoteRows = rows(projection.quotes), fxRows = rows(projection.fx);
  const targets = Object.fromEntries(targetRows.map(row => [text(row.listing_id), row]));
  const quotes = Object.fromEntries(quoteRows.map(row => [text(row.listing_id), row]));
  const foreign = Object.fromEntries(fxRows.map(row => [text(row.currency), dec(row.value)]));
  check(targetRows.length === keys(targets).length && quoteRows.length === keys(quotes).length && same(keys(targets), keys(quotes)), "QUOTE_SCOPE");
  check(fxRows.length === Object.keys(foreign).length
    && same(Object.keys(foreign).sort(), [...new Set(targetRows.map(row => text(row.currency)))].filter(value => value !== "CNY").sort())
    && Object.values(foreign).every(value => value.gt(0)), "FX_SCOPE");
  check(targetRows.every(row => dec(row.weight).gt(0)) && sum(targetRows.map(row => dec(row.weight))).eq(1), "TARGET_WEIGHTS");
  const cutoffs: Obj = {};
  for (const target of targetRows) {
    const quote = quotes[text(target.listing_id)], market = text(target.market);
    check(quote.market === market && quote.currency === target.currency && dec(quote.close).gt(0), "QUOTE_IDENTITY");
    check(!cutoffs[market] || cutoffs[market] === quote.observed_at, "MARKET_CUTOFF"); cutoffs[market] = quote.observed_at;
  }
  return { targetRows, targets, quotes, fx: { CNY: new Decimal(1), ...foreign } as Record<string, Decimal>, cutoffs };
}

function ledger(actions: Obj[], targets: Record<string, Obj>, cutoffs: Obj, at: bigint) {
  check(new Set(actions.map(row => row.id)).size === actions.length, "DUPLICATE_ACTION");
  for (const action of actions) {
    const listing = text(action.listing_id); check(Object.hasOwn(targets, listing), "ACTION_SCOPE"); const target = targets[listing];
    check(time(action.known_at) <= at && time(action.effective_at) <= time(cutoffs[text(target.market)]), "ACTION_CLOCK");
    if (action.kind === "split") check(dec(action.ratio).gt(0), "SPLIT_RATIO");
    else {
      check(action.currency === target.currency, "ACTION_CURRENCY");
      if (action.kind === "dividend_ex") check(dec(action.net_per_unit).gte(0), "DIVIDEND_AMOUNT");
      else check(time(action.ex_at) <= time(action.effective_at), "PAYMENT_CHRONOLOGY");
    }
  }
  return [...actions].sort((a, b) => time(a.effective_at) < time(b.effective_at) ? -1 : time(a.effective_at) > time(b.effective_at) ? 1
    : rank[text(a.kind)] - rank[text(b.kind)] || (text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0));
}

function replay(origin: Obj, actions: Obj[], targets: Record<string, Obj>, cutoffs: Obj) {
  const result: Economics = { ...economics(origin), market_cutoffs: structuredClone(cutoffs), receivables: [], entitlements: {}, processed_actions: {} };
  const pending: Record<string, Obj> = {}, quantities = obj(result.quantities), cash = obj(result.cash_by_currency);
  for (const action of actions) {
    const listing = text(action.listing_id), kind = text(action.kind), id = text(action.id), inception = time(obj(origin.initialized_at)[text(targets[listing].market)]);
    if (time(action.effective_at) <= inception) { result.processed_actions[id] = hash(action); continue; }
    const quantity = dec(quantities[listing]);
    if (kind === "split") quantities[listing] = number(quantity.mul(dec(action.ratio)));
    else if (kind === "dividend_ex") {
      const entitlementId = text(action.entitlement_id); check(!Object.hasOwn(result.entitlements, entitlementId), "DUPLICATE_ENTITLEMENT");
      pending[entitlementId] = { id: entitlementId, listing_id: listing, currency: action.currency, amount: number(quantity.mul(dec(action.net_per_unit))),
        ex_at: action.effective_at, tax_assumption_hash: action.tax_assumption_hash };
      check(Object.keys(pending).length <= 500, "RECEIVABLE_LIMIT");
      result.entitlements[entitlementId] = { ...pending[entitlementId], paid: false };
    } else {
      const entitlementId = text(action.entitlement_id), receivable = Object.hasOwn(pending, entitlementId) ? pending[entitlementId] : undefined;
      if (!receivable) check(time(action.ex_at) <= inception && !Object.hasOwn(result.entitlements, entitlementId), "PAYMENT_ENTITLEMENT_UNKNOWN");
      else {
        check(receivable.listing_id === listing && receivable.currency === action.currency && time(receivable.ex_at) === time(action.ex_at), "PAYMENT_BINDING");
        const currency = text(action.currency); cash[currency] = number(dec(cash[currency]).add(dec(receivable.amount)));
        result.entitlements[entitlementId].paid = true; delete pending[entitlementId];
      }
    }
    result.processed_actions[id] = hash(action);
  }
  result.receivables = Object.keys(pending).sort().map(id => pending[id]);
  validateActionRestatementKernel("economics", result); return result;
}

function receivables(state: Obj) {
  const result = Object.fromEntries(Object.keys(obj(state.cash_by_currency)).map(currency => [currency, new Decimal(0)]));
  for (const row of rows(state.receivables)) result[text(row.currency)] = result[text(row.currency)].add(dec(row.amount));
  return result;
}

function valuation(state: Obj, binding: ReturnType<typeof quoteBinding>) {
  let value = sum(binding.targetRows.map(target => dec(obj(state.quantities)[text(target.listing_id)]).mul(dec(binding.quotes[text(target.listing_id)].close)).mul(binding.fx[text(target.currency)])));
  value = value.add(sum(Object.entries(obj(state.cash_by_currency)).filter(([, amount]) => !dec(amount).isZero()).map(([currency, amount]) => dec(amount).mul(binding.fx[currency]))));
  return value.add(sum(rows(state.receivables).map(row => dec(row.amount).mul(binding.fx[text(row.currency)]))));
}

/** Independent historical economics only: never a source proof or current advice. */
export function compareActionRestatement(raw: unknown) {
  validateActionRestatementKernel("input", raw);
  const value = obj(raw), definition = obj(value.definition), origin = obj(value.origin), head = obj(value.head), at = time(value.checked_at);
  check(definition.data_mode === "reconstructed" && definition.target_definition_hash === modelDefinitionHash(definition as Parameters<typeof modelDefinitionHash>[0]), "DEFINITION_BINDING");
  if (definition.schema_version === "investor-model-definition-v2") {
    const policy = obj(definition.fixed_policy), parameters = obj(policy.parameters), weights = obj(parameters.weights), roles = obj(parameters.roles);
    const targetRows = rows(definition.targets), targetKeys = targetRows.map(row => text(row.listing_id)).sort();
    check(same(keys(weights), targetKeys) && same(keys(roles), targetKeys) && targetRows.every(row => dec(row.weight).eq(dec(weights[text(row.listing_id)]))), "FIXED_POLICY_BINDING");
    try { new Intl.DateTimeFormat("en", { timeZone: text(policy.evaluation_timezone) }); } catch { check(false, "FIXED_POLICY_TIMEZONE"); }
  }
  check(origin.sequence === 1 && origin.previous_hash === null && time(definition.created_at) <= time(origin.created_at)
    && time(origin.created_at) <= time(head.created_at) && time(head.created_at) < time(definition.valid_until) && time(head.created_at) <= at, "ORIGIN_OR_CLOCK");
  check(Number(head.sequence) >= 1 && (head.sequence === 1 ? same(head, origin) : head.previous_hash !== null), "HEAD_SEQUENCE");
  if (head.sequence === 2) check(head.previous_hash === hash(origin), "HEAD_SEQUENCE");
  for (const checkpoint of [origin, head]) {
    check(["model_id", "profile_id", "target_definition_hash"].every(key => checkpoint[key] === definition[key]), "CHECKPOINT_SCOPE");
    check(same(checkpoint.initialized_at, origin.initialized_at) && same(keys(obj(checkpoint.quantities)), rows(definition.targets).map(row => text(row.listing_id)).sort()), "INCEPTION_SCOPE");
    check((checkpoint.policy_state !== undefined) === (definition.schema_version === "investor-model-definition-v2"), "POLICY_SCOPE");
    if (checkpoint.funding_binding !== undefined) {
      const binding = obj(checkpoint.funding_binding);
      check(binding.model_id === definition.model_id && binding.model_hash === hash(definition) && binding.profile_hash === definition.profile_hash
        && binding.model_created_at === definition.created_at && time(binding.plan_declared_at) <= time(checkpoint.created_at), "FUNDING_SCOPE");
    }
  }
  check(same(origin.market_cutoffs, origin.initialized_at) && rows(origin.receivables).length === 0 && keys(obj(origin.entitlements)).length === 0, "ORIGIN_ASSETS");
  const bindings = [["origin_projection", origin], ["head_projection", head]].map(([key, rawCheckpoint]) => {
    const checkpoint = obj(rawCheckpoint), projection = obj(value[text(key)]);
    check(projection.model_id === definition.model_id && hash(projection) === checkpoint.projection_hash
      && time(projection.created_at) <= time(checkpoint.created_at) && time(checkpoint.created_at) < time(projection.valid_until)
      && (projection.quality_gaps as unknown[]).length === 0, "PROJECTION_BINDING");
    check([...rows(projection.quotes), ...rows(projection.fx)].every(row => time(row.observed_at) <= time(row.known_at)
      && time(row.known_at) <= time(checkpoint.created_at) && time(checkpoint.created_at) < time(row.valid_until)), "ORIGINAL_PRICE_CLOCK");
    check(rows(projection.quotes).every(row => time(row.observed_at) === time(row.expected_close_at)), "ORIGINAL_PRICE_CLOCK");
    const binding = quoteBinding(definition, projection), coverage = obj(projection.corporate_action_coverage);
    check(same(binding.cutoffs, checkpoint.market_cutoffs), "CHECKPOINT_CUTOFF");
    check(same(keys(coverage), keys(binding.cutoffs)) && Object.entries(coverage).every(([market, raw]) => {
      const row = obj(raw); return row.complete && time(row.from) <= time(row.to) && time(row.to) === time(binding.cutoffs[market]);
    }), "ORIGINAL_COVERAGE"); return binding;
  });
  const initial = bindings[0], binding = bindings[1], { targets, cutoffs } = binding;
  check(same(keys(obj(origin.initialized_at)), keys(cutoffs)) && Object.entries(cutoffs).every(([market, cutoff]) =>
    time(obj(origin.initialized_at)[market]) <= time(cutoff) && time(cutoff) <= time(head.created_at)), "INCEPTION_CUTOFF");
  const initialPrices = Object.fromEntries(binding.targetRows.map(target => [text(target.listing_id), dec(initial.quotes[text(target.listing_id)].close).mul(initial.fx[text(target.currency)])]));
  const quantities = Object.fromEntries(binding.targetRows.map(target => [text(target.listing_id), number(new Decimal(10000).mul(dec(target.weight))
    .div(initialPrices[text(target.listing_id)]).toDecimalPlaces(18, Decimal.ROUND_DOWN))]));
  const residual = new Decimal(10000).sub(sum(binding.targetRows.map(target => dec(quantities[text(target.listing_id)]).mul(initialPrices[text(target.listing_id)]))));
  check(Object.values(quantities).every(quantity => dec(quantity).gt(0)) && residual.gte(0) && same(origin.quantities, quantities)
    && same(origin.cash_by_currency, { CNY: number(residual), HKD: "0", USD: "0" }), "ORIGIN_VALUE");
  const originalActions = ledger(rows(value.original_actions), targets, cutoffs, time(head.created_at));
  const originActions = ledger(rows(obj(value.origin_projection).corporate_actions), targets, obj(origin.market_cutoffs), time(origin.created_at));
  const oldLedgerHashes = Object.fromEntries(originalActions.map(row => [text(row.id), hash(row)]));
  check(same(Object.fromEntries(originActions.map(row => [text(row.id), hash(row)])), origin.processed_actions)
    && Object.entries(obj(origin.processed_actions)).every(([id, digest]) => oldLedgerHashes[id] === digest), "ORIGIN_LEDGER");
  const original = replay(origin, originalActions, targets, cutoffs); check(same(original, economics(head)), "ORIGINAL_REPLAY_MISMATCH");
  const coverage = obj(value.corrected_coverage);
  check(same(keys(coverage), keys(cutoffs)) && Object.entries(coverage).every(([market, raw]) => {
    const row = obj(raw); return row.complete && time(row.from) <= time(obj(origin.initialized_at)[market]) && time(row.to) === time(cutoffs[market]);
  }), "CORRECTED_COVERAGE_GAP");
  const correctedActions = ledger(rows(value.corrected_actions), targets, cutoffs, at), restated = replay(origin, correctedActions, targets, cutoffs);
  const oldValue = valuation(original, binding), newValue = valuation(restated, binding), oldPending = receivables(original), newPending = receivables(restated);
  const oldHashes = obj(original.processed_actions), newHashes = obj(restated.processed_actions);
  const result = { schema_version: "investor-action-restatement-kernel-result-v1", model_id: definition.model_id, checked_at: value.checked_at,
    basis: Object.fromEntries(["definition", "origin", "head", "origin_projection", "head_projection", "original_actions", "corrected_actions", "corrected_coverage"].map(key => [key + "_hash", hash(value[key])])),
    original, restated, delta: {
      quantities: Object.fromEntries(Object.keys(targets).sort().map(key => [key, number(dec(obj(restated.quantities)[key]).sub(dec(obj(original.quantities)[key])))])),
      cash_by_currency: Object.fromEntries(keys(obj(original.cash_by_currency)).map(key => [key, number(dec(obj(restated.cash_by_currency)[key]).sub(dec(obj(original.cash_by_currency)[key])))])),
      receivables_by_currency: Object.fromEntries(Object.keys(oldPending).sort().map(key => [key, number(newPending[key].sub(oldPending[key]))])),
    }, original_valuation_cny: number(oldValue), restated_valuation_cny: number(newValue), difference_cny: number(newValue.sub(oldValue)),
    changed_action_count: [...new Set([...Object.keys(oldHashes), ...Object.keys(newHashes)])].filter(key => oldHashes[key] !== newHashes[key]).length,
    economics_changed: fields.some(key => key !== "processed_actions" && !same(original[key], restated[key])),
    valuation_basis: "same_original_checkpoint_quotes_and_fx_not_current_nav", knowledge_basis: "corrected_economic_history_as_of_checked_at_not_point_in_time_strategy",
    visibility: "private_owner_only_not_ai", source_evidence_verified: false, checkpoint_created: false, state_published: false,
    historical_observations_rewritten: false, historical_strategy_results_recomputed: false, monitoring_resumed: false,
    current_advice_certified: false, trading_permission: false, provider_calls: 0, database_writes: 0,
  };
  validateActionRestatementKernel("result", result); return result;
}

export function verifyActionRestatementArithmetic(input: unknown, result: unknown) {
  validateActionRestatementKernel("result", result);
  const calculated = compareActionRestatement(input);
  check(same(calculated, result), "RESULT_REPLAY_MISMATCH"); return calculated;
}
