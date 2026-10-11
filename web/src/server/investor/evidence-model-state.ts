import { Decimal } from "../ledger/decimal";
import { hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";
import { validateInvestorEvidenceCheckpoint, validateInvestorModelDocument, validateInvestorMonitorDataDocument } from "./kernel-contracts";
import { modelDefinitionHash } from "./fixed-policy";
import { replayEvidenceAssessment } from "./evidence-model-assessment";
import { projectPlannedFundingMonitor } from "./planned-funding-monitor";

type Obj = Record<string, unknown>;
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_EVIDENCE_INVALID"); }
function obj(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function text(value: unknown): string { check(typeof value === "string"); return value; }
function rows(value: unknown): Obj[] { check(Array.isArray(value)); return value.map(obj); }
const time = (value: unknown) => priceInstant(text(value));
const dec = (value: unknown) => new Decimal(text(value));
const sortedKeys = (value: Obj) => Object.keys(value).sort();
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const sum = (values: Decimal[]) => values.reduce((a,b) => a.add(b), new Decimal(0));
const canonical = (value: Decimal) => value.isZero() ? "0" : value.toFixed();
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export class EvidenceActionRestatement extends Error {
  constructor() { super("MONITOR_ACTION_RESTATEMENT_REQUIRED"); }
}
export class EvidenceCheckpointLimitRequired extends Error {
  constructor() { super("MONITOR_CHECKPOINT_LIMIT_REQUIRES_RESTART"); }
}

/** Independently replay units, cash and action state; never trust worker quantities. */
export function replayEvidenceModel(rawDefinition: unknown, rawProjection: unknown, rawPrevious: unknown, now: string, inputHash: string, sparse = false, plannedFunding: unknown = null) {
  try {
    check(typeof sparse === "boolean");
    validateInvestorModelDocument("definition", rawDefinition); validateInvestorMonitorDataDocument("projection", rawProjection);
    const definition = obj(rawDefinition), snapshot = obj(rawProjection), previous = rawPrevious === null ? null : obj(rawPrevious), at = time(now);
    const fixed = definition.schema_version === "investor-model-definition-v2";
    const funding = plannedFunding === null ? null : projectPlannedFundingMonitor(plannedFunding);
    if (funding) check(funding.evaluated_at === now && funding.binding.model_id === definition.model_id
      && funding.binding.model_hash === hash(definition) && funding.binding.profile_hash === definition.profile_hash
      && funding.binding.model_created_at === definition.created_at && funding.status !== "expired" && snapshot.funding_intent === null);
    check(/^[a-f0-9]{64}$/.test(inputHash) && definition.data_mode === "reconstructed" && snapshot.model_id === definition.model_id
      && time(definition.created_at) <= at && at < time(definition.valid_until) && time(snapshot.created_at) <= at && at < time(snapshot.valid_until)
      && definition.target_definition_hash === modelDefinitionHash(definition as Parameters<typeof modelDefinitionHash>[0]));
    const targetRows = rows(definition.targets), quoteRows = rows(snapshot.quotes), fxRows = rows(snapshot.fx);
    const targets = Object.fromEntries(targetRows.map(row => [text(row.listing_id),row])), quotes = Object.fromEntries(quoteRows.map(row => [text(row.listing_id),row]));
    const fx = Object.fromEntries(fxRows.map(row => [text(row.currency),dec(row.value)]));
    check(targetRows.length === Object.keys(targets).length && quoteRows.length === Object.keys(quotes).length && same(sortedKeys(targets),sortedKeys(quotes))
      && fxRows.length === Object.keys(fx).length && same(Object.keys(fx).sort(), [...new Set(targetRows.map(row => text(row.currency)))].filter(value => value !== "CNY").sort())
      && Object.values(fx).every(value => value.gt(0)) && targetRows.every(row => dec(row.weight).gt(0)) && sum(targetRows.map(row => dec(row.weight))).eq(1));
    const rate = (currency: unknown) => currency === "CNY" ? new Decimal(1) : fx[text(currency)];
    const cutoffs: Obj = {}, gaps = [...snapshot.quality_gaps as string[]], coverage = obj(snapshot.corporate_action_coverage);
    for (const [id,target] of Object.entries(targets)) {
      const quote = quotes[id], market = text(target.market);
      check(quote.market === market && quote.currency === target.currency && dec(quote.close).gt(0) && (!cutoffs[market] || cutoffs[market] === quote.observed_at));
      cutoffs[market] = quote.observed_at;
    }
    check(same(sortedKeys(coverage), sortedKeys(cutoffs)));
    for (const [market,raw] of Object.entries(coverage)) {
      const window = obj(raw); check(time(window.from) <= time(window.to) && time(window.to) === time(cutoffs[market]));
      if (!window.complete) gaps.push("CORPORATE_ACTION_COVERAGE_INCOMPLETE");
    }
    let candidate: Obj;
    if (previous) {
      validateInvestorEvidenceCheckpoint(previous);
      if (previous.schema_version === "investor-evidence-model-checkpoint-v3") {
        const bound = obj(previous.funding_binding);
        check(funding && bound.model_id === definition.model_id && bound.model_hash === hash(definition)
          && bound.profile_hash === definition.profile_hash && bound.model_created_at === definition.created_at
          && time(bound.plan_declared_at) <= time(previous.created_at));
      }
      check((previous.schema_version === (fixed ? "investor-evidence-model-checkpoint-v2" : "investor-evidence-model-checkpoint-v1")
        || funding && previous.schema_version === "investor-evidence-model-checkpoint-v3") && fixed === (previous.policy_state !== undefined)
        && previous.model_id === definition.model_id && previous.profile_id === definition.profile_id && previous.target_definition_hash === definition.target_definition_hash
        && same(sortedKeys(obj(previous.quantities)),sortedKeys(targets)) && same(sortedKeys(obj(previous.market_cutoffs)),sortedKeys(cutoffs))
        && same(sortedKeys(obj(previous.initialized_at)),sortedKeys(cutoffs)) && time(previous.created_at) <= at
        && [...Object.values(obj(previous.quantities)),...Object.values(obj(previous.cash_by_currency))].every(value => dec(value).gte(0)));
      for (const [market,cutoff] of Object.entries(cutoffs)) {
        check(time(obj(previous.initialized_at)[market]) <= time(obj(previous.market_cutoffs)[market]) && time(cutoff) >= time(obj(previous.market_cutoffs)[market]));
        if (time(obj(coverage[market]).from) > time(obj(previous.market_cutoffs)[market])) gaps.push("CORPORATE_ACTION_COVERAGE_GAP");
      }
      check(Object.entries(obj(previous.cash_by_currency)).every(([currency,value]) => currency === "CNY" || dec(value).isZero() || fx[currency]));
      candidate = { ...structuredClone(previous), market_cutoffs: cutoffs,
        ...(!sparse ? { sequence: (previous.sequence as number) + 1, previous_hash: hash(previous), created_at: now, input_hash: inputHash, projection_hash: hash(snapshot) } : {}) };
    } else {
      const quantities: Obj = {}; let invested = new Decimal(0);
      for (const [id,target] of Object.entries(targets)) {
        const price = dec(quotes[id].close).mul(rate(target.currency)), quantity = new Decimal(10000).mul(text(target.weight)).div(price).toDecimalPlaces(18, Decimal.ROUND_DOWN);
        check(quantity.gt(0)); quantities[id] = canonical(quantity); invested = invested.add(quantity.mul(price));
      }
      const residual = new Decimal(10000).sub(invested); check(residual.gte(0));
      candidate = { schema_version: fixed ? "investor-evidence-model-checkpoint-v2" : "investor-evidence-model-checkpoint-v1", model_id: definition.model_id, profile_id: definition.profile_id, target_definition_hash: definition.target_definition_hash,
        ...(fixed ? { policy_state: { last_review_at: null, last_proposed_at: null, last_funding_hash: null, cash_cny_seen: null, cash_repair_pending: false } } : {}),
        sequence: 1, previous_hash: null, input_hash: inputHash, projection_hash: hash(snapshot), created_at: now, initialized_at: structuredClone(cutoffs), market_cutoffs: cutoffs,
        quantities, cash_by_currency: { CNY: canonical(residual), HKD: "0", USD: "0" }, receivables: [], entitlements: {}, processed_actions: {}, initial_notional_cny: "10000",
        assumptions: ["Normalized valuation-only reference starting at 10000 CNY, not personal cash or account performance", "Fractional model units; no entry trade, lot, settlement or execution is simulated",
          "Dividend amounts use declared net-per-unit tax assumptions, not actual account tax", "No proposed rebalance or planned funding is applied to model holdings"],
        scope: "research_model", data_mode: "reconstructed", live_advice_eligible: false };
    }
    if (funding) candidate = { ...candidate, schema_version: "investor-evidence-model-checkpoint-v3", funding_binding: structuredClone(funding.binding) };
    const receivableRows = rows(candidate.receivables), receivables = Object.fromEntries(receivableRows.map(row => [text(row.id),structuredClone(row)]));
    check(receivableRows.length === Object.keys(receivables).length);
    const entitlements = obj(candidate.entitlements), pending: Obj = {}, processed = obj(candidate.processed_actions), quantities = obj(candidate.quantities), cash = obj(candidate.cash_by_currency);
    for (const [id,raw] of Object.entries(entitlements)) {
      const entitlement = obj(raw), listing = text(entitlement.listing_id), target = targets[listing]; check(target);
      check(id === entitlement.id && entitlement.currency === target.currency && dec(entitlement.amount).gte(0)
        && time(entitlement.ex_at) > time(obj(candidate.initialized_at)[text(target.market)]) && time(entitlement.ex_at) <= time(cutoffs[text(target.market)]));
      if (!entitlement.paid) { const { paid: _, ...unpaid } = entitlement; pending[id] = unpaid; }
    }
    check(same(pending,receivables));
    const actions = rows(snapshot.corporate_actions), ranks: Record<string,number> = { split: 0, dividend_ex: 1, dividend_payment: 2 };
    check(new Set(actions.map(row => row.id)).size === actions.length);
    for (const action of [...actions].sort((a,b) => time(a.effective_at) < time(b.effective_at) ? -1 : time(a.effective_at) > time(b.effective_at) ? 1 : ranks[text(a.kind)] - ranks[text(b.kind)] || cmp(text(a.id),text(b.id)))) {
      const listing = text(action.listing_id), target = targets[listing]; check(target);
      const market = text(target.market), effective = time(action.effective_at), id = text(action.id), kind = text(action.kind), digest = hash(action);
      if (time(action.known_at) > at) gaps.push("CORPORATE_ACTION_NOT_KNOWN");
      check(effective <= time(cutoffs[market]));
      if (kind === "split") check(dec(action.ratio).gt(0));
      else check(action.currency === target.currency && (kind !== "dividend_ex" || dec(action.net_per_unit).gte(0)) && (kind !== "dividend_payment" || time(action.ex_at) <= effective));
      if (processed[id] !== undefined) { if (processed[id] !== digest) throw new EvidenceActionRestatement(); continue; }
      if (!previous || effective <= time(obj(previous.market_cutoffs)[market])) {
        if (previous && effective > time(obj(previous.initialized_at)[market])) throw new EvidenceActionRestatement();
        processed[id] = digest; continue;
      }
      const quantity = dec(quantities[listing]);
      if (kind === "split") quantities[listing] = canonical(quantity.mul(text(action.ratio)));
      else if (kind === "dividend_ex") {
        const entitlement = text(action.entitlement_id); check(!entitlements[entitlement]);
        const value = { id: entitlement, listing_id: listing, currency: action.currency, amount: canonical(quantity.mul(text(action.net_per_unit))), ex_at: action.effective_at, tax_assumption_hash: action.tax_assumption_hash };
        receivables[entitlement] = value; entitlements[entitlement] = { ...value, paid: false };
      } else {
        const entitlement = text(action.entitlement_id), value = receivables[entitlement];
        if (!value) { if (time(action.ex_at) > time(obj(candidate.initialized_at)[market])) throw new EvidenceActionRestatement(); }
        else {
          check(value.listing_id === listing && value.currency === action.currency && time(value.ex_at) === time(action.ex_at));
          const currency = text(action.currency); cash[currency] = canonical(dec(cash[currency]).add(text(value.amount)));
          obj(entitlements[entitlement]).paid = true; delete receivables[entitlement];
        }
      }
      processed[id] = digest;
    }
    candidate.receivables = Object.values(receivables).sort((a,b) => text(a.id) < text(b.id) ? -1 : text(a.id) > text(b.id) ? 1 : 0);
    if (sparse && previous && !fixed) {
      const metadata = new Set(["sequence", "previous_hash", "created_at", "input_hash", "projection_hash"]);
      const state = (value: Obj) => Object.fromEntries(Object.entries(value).filter(([key]) => !metadata.has(key)));
      if (same(state(candidate),state(previous))) candidate = structuredClone(previous);
      else {
        if ((previous.sequence as number) >= 1000) throw new EvidenceCheckpointLimitRequired();
        candidate = { ...candidate, sequence: (previous.sequence as number) + 1, previous_hash: hash(previous), created_at: now, input_hash: inputHash, projection_hash: hash(snapshot) };
      }
    }
    validateInvestorEvidenceCheckpoint(candidate);
    let nonCash = sum(Object.entries(cash).filter(([currency,value]) => currency !== "CNY" && !dec(value).isZero()).map(([currency,value]) => dec(value).mul(rate(currency))));
    nonCash = nonCash.add(sum(rows(candidate.receivables).map(row => dec(row.amount).mul(rate(row.currency)))));
    const weights = Object.fromEntries(targetRows.map(row => [text(row.listing_id),row.weight]));
    const policy = obj(snapshot.policy);
    const document: Obj = { schema_version: fixed ? "investor-model-monitor-v3" : "investor-model-monitor-v2", profile_id: definition.profile_id, profile_version: definition.profile_version, profile_hash: definition.profile_hash,
      model_id: definition.model_id, model_state_hash: hash(candidate), before_plan_hash: definition.target_definition_hash, after_plan_hash: definition.target_definition_hash,
      before_weights: weights, after_weights: weights, quantities, cash_cny: cash.CNY, non_cash_assets_cny: canonical(nonCash),
      quotes: snapshot.quotes, fx: snapshot.fx, funding_intent: funding ? structuredClone(funding.funding_intent) : snapshot.funding_intent,
      policy: fixed ? { version: policy.version, max_fx_age_seconds: policy.max_fx_age_seconds, costs: policy.costs } : policy,
      ...(fixed ? { fixed_policy: { ...structuredClone(obj(definition.fixed_policy)), state: structuredClone(candidate.policy_state) } } : {}), quality_gaps: [...new Set(gaps)].sort() };
    if (fixed) {
      const evaluation = replayEvidenceAssessment(document, now, "0".repeat(64)) as Obj;
      if (evaluation.outcome !== "insufficient_evidence") {
        candidate.policy_state = structuredClone(evaluation.next_policy_state);
        if (sparse && previous) {
          const metadata = new Set(["sequence", "previous_hash", "created_at", "input_hash", "projection_hash"]);
          const state = (value: Obj) => Object.fromEntries(Object.entries(value).filter(([key]) => !metadata.has(key)));
          if (same(state(candidate), state(previous))) candidate = structuredClone(previous);
          else {
            if ((previous.sequence as number) >= 1000) throw new EvidenceCheckpointLimitRequired();
            candidate = { ...candidate, sequence: (previous.sequence as number) + 1, previous_hash: hash(previous), created_at: now, input_hash: inputHash, projection_hash: hash(snapshot) };
          }
        }
        validateInvestorEvidenceCheckpoint(candidate);
        document.model_state_hash = hash(candidate);
      }
    }
    return { checkpoint: candidate, document };
  } catch (error) { if (error instanceof EvidenceActionRestatement || error instanceof EvidenceCheckpointLimitRequired) throw error; throw new Error("INVESTOR_EVIDENCE_INVALID"); }
}
