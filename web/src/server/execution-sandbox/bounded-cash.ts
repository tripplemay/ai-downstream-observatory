import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import DecimalJs from "decimal.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import schema from "../../../../contracts/v1/bounded-cash-buy.schema.json";

const ENGINE = "bounded-cash-buy-sandbox-v1";
const D = DecimalJs.clone({ precision: 160, rounding: DecimalJs.ROUND_HALF_EVEN, toExpNeg: -200, toExpPos: 200 });
const ajv = new Ajv2020({ strict: true, strictRequired: false });
addFormats(ajv); ajv.addSchema(schema);
const sources = ["contracts/v1/bounded-cash-buy.schema.json", "worker/execution_sandbox/__init__.py",
  "worker/execution_sandbox/bounded_cash.py", "web/src/server/execution-sandbox/bounded-cash.ts",
  "worker/market/contracts.py", "worker/orchestration/db.py", "worker/accounting/decimal_math.py",
  "requirements-workbench.txt", "web/package-lock.json"];

export type BuyPolicy = { schema_version: "bounded-cash-buy-policy-v1"; price_buffer_bps: string; commission_bps: string;
  minimum_fee_cny: string; slippage_bps: string; cash_quantum: "0.01"; max_quote_age_seconds: number };
export type BuyInput = { schema_version: "bounded-cash-buy-input-v1"; qualification: "synthetic_test_only"; batch_id: string;
  decision_at: string; policy: BuyPolicy; settled_cash_cny: string; unsettled_receivable_cny: string;
  existing_reservations: {order_id: string; budget_cny: string}[]; orders: {order_id: string; listing_id: string; market: "CN";
    currency: "CNY"; allocated_budget_cny: string; quantity_step: string;
    decision_quote: {id: string; close: string; observed_at: string; known_at: string; valid_until: string}; execute_at: string; expires_at: string}[] };
type PlannedOrder = {order_id: string; listing_id: string; status: "planned" | "below_minimum"; quantity: string; quantity_step: string;
  lot_count: string; allocated_budget_cny: string; reserved_cny: string; price_cap: string; worst_total_cash_cny: string;
  decision_quote_id: string; execute_at: string; expires_at: string};
export type BuyPlan = {schema_version: "bounded-cash-buy-plan-v1"; engine_version: typeof ENGINE; qualification: "synthetic_test_only";
  implementation_hash: string; input_hash: string; policy_hash: string; batch_id: string; decision_at: string; settled_cash_cny: string;
  existing_reserved_cny: string; new_reserved_cny: string; unreserved_cash_cny: string; orders: PlannedOrder[]; plan_hash: string};
export type BuyOutcome = {schema_version: "bounded-cash-buy-outcome-input-v1"; qualification: "synthetic_test_only"; evaluated_at: string;
  observations: {order_id: string; quote_id: string; close: string; observed_at: string; known_at: string; corporate_action_since_decision: boolean}[]};
type Reason = "SYNTHETIC_NEXT_CLOSE_PROXY" | "BUDGET_BELOW_ONE_STEP_TOTAL_COST" | "MISSING_EXECUTION_OBSERVATION"
  | "CORPORATE_ACTION_REVIEW_REQUIRED" | "EXECUTION_TIME_MISMATCH" | "EXECUTION_EVIDENCE_LATE" | "PRICE_BOUND_EXCEEDED" | "PRECOMMITTED_BUDGET_EXCEEDED";
type ExecutedOrder = {order_id: string; listing_id: string; status: "simulated_filled" | "skipped" | "below_minimum"; reason: Reason;
  quantity: string; execution_price: string | null; fee_cny: string; rounding_cny: string; total_cash_cny: string; released_cny: string; quote_id: string | null};
export type BuyResult = {schema_version: "bounded-cash-buy-result-v1"; engine_version: typeof ENGINE; qualification: "synthetic_test_only";
  implementation_hash: string; input_hash: string; policy_hash: string; plan_hash: string; outcome_input_hash: string; batch_id: string;
  evaluated_at: string; cash_after_cny: string; existing_reserved_cny: string; unreserved_cash_after_cny: string;
  new_reserved_released_cny: string; total_debited_cny: string; execution_failure_count: number; orders: ExecutedOrder[];
  live_advice_eligible: false; result_hash: string};

function requireValue(condition: unknown, code: string): asserts condition { if (!condition) throw new Error("BOUNDED_CASH_" + code); }
function contract(value: unknown, kind: string) { requireValue(ajv.getSchema(schema.$id + "#/$defs/" + kind)!(value), "CONTRACT_INVALID"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key,item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  requireValue(value !== undefined && !(typeof value === "number" && !Number.isFinite(value)), "JSON_INVALID");
  return JSON.stringify(value);
}
export const buyDigest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function buyImplementationHash() {
  // This offline source reader requires the repository or its web directory as cwd.
  const root = resolve(basename(process.cwd()) === "web" ? ".." : ".");
  return buyDigest({engine_version:ENGINE,precision:160,sources:Object.fromEntries(sources.map(name =>
    [name,createHash("sha256").update(readFileSync(resolve(root,name))).digest("hex")]))});
}
function time(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(value);
  requireValue(match && !value.startsWith("0000"), "INSTANT_INVALID");
  const millis = Date.parse(match[1] + "Z");
  requireValue(Number.isFinite(millis) && new Date(millis).toISOString().slice(0,19) === match[1], "INSTANT_INVALID");
  return BigInt(millis) * 1000n + BigInt(match[2]);
}
function text(value: DecimalJs) { return value.isZero() ? "0" : value.toFixed(); }
function cost(quantity: DecimalJs, price: DecimalJs, policy: BuyPolicy) {
  const principal = quantity.mul(price), fee = D.max(policy.minimum_fee_cny,principal.mul(policy.commission_bps).div(10000));
  return {total:principal.add(fee).toDecimalPlaces(2,D.ROUND_CEIL),fee};
}

export function planBuys(input: BuyInput): BuyPlan {
  contract(input,"input");
  const policy = input.policy, at = time(input.decision_at), settled = new D(input.settled_cash_cny);
  requireValue([policy.price_buffer_bps,policy.commission_bps,policy.slippage_bps].every(value => new D(value).lte(10000)), "RATE_OUT_OF_RANGE");
  requireValue(new D(policy.slippage_bps).lte(policy.price_buffer_bps), "SLIPPAGE_EXCEEDS_BOUND");
  const ids = [...input.existing_reservations,...input.orders].map(row => row.order_id);
  requireValue(new Set(ids).size === ids.length,"DUPLICATE_ORDER_ID");
  requireValue(new Set(input.orders.map(row => row.listing_id)).size === input.orders.length,"DUPLICATE_LISTING");
  requireValue(input.existing_reservations.every(row => new D(row.budget_cny).gt(0)),"RESERVATION_INVALID");
  const existing = input.existing_reservations.reduce((sum,row) => sum.add(row.budget_cny),new D(0));
  const allocated = input.orders.reduce((sum,row) => sum.add(row.allocated_budget_cny),new D(0));
  requireValue(existing.add(allocated).lte(settled),"SETTLED_CASH_EXCEEDED");
  const orders: PlannedOrder[] = [...input.orders].sort((a,b) => a.order_id < b.order_id ? -1 : a.order_id > b.order_id ? 1 : 0).map(row => {
    const quote = row.decision_quote, budget = new D(row.allocated_budget_cny), step = new D(row.quantity_step);
    const observed = time(quote.observed_at), known = time(quote.known_at), valid = time(quote.valid_until);
    requireValue(budget.gt(0) && step.gt(0) && new D(quote.close).gt(0),"NONPOSITIVE_ORDER_INPUT");
    requireValue(observed <= known && known <= at && at < valid && at - observed <= BigInt(policy.max_quote_age_seconds) * 1000000n,"DECISION_QUOTE_UNAVAILABLE");
    requireValue(at < time(row.execute_at) && time(row.execute_at) <= time(row.expires_at),"EXECUTION_WINDOW_INVALID");
    const cap = new D(quote.close).mul(new D(1).add(new D(policy.price_buffer_bps).div(10000)));
    let low = 0n, high = BigInt(budget.div(step.mul(cap)).floor().toFixed());
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      if (cost(step.mul(middle.toString()),cap,policy).total.lte(budget)) low = middle;
      else high = middle - 1n;
    }
    const quantity = step.mul(low.toString());
    return {order_id:row.order_id,listing_id:row.listing_id,status:low ? "planned" : "below_minimum",quantity:text(quantity),
      quantity_step:row.quantity_step,lot_count:low.toString(),allocated_budget_cny:row.allocated_budget_cny,reserved_cny:text(low ? budget : new D(0)),
      price_cap:text(cap),worst_total_cash_cny:text(low ? cost(quantity,cap,policy).total : new D(0)),
      decision_quote_id:quote.id,execute_at:row.execute_at,expires_at:row.expires_at};
  });
  const reserved = orders.reduce((sum,row) => sum.add(row.reserved_cny),new D(0));
  const body: Omit<BuyPlan,"plan_hash"> = {schema_version:"bounded-cash-buy-plan-v1",engine_version:ENGINE,qualification:"synthetic_test_only",
    implementation_hash:buyImplementationHash(),input_hash:buyDigest(input),policy_hash:buyDigest(policy),batch_id:input.batch_id,
    decision_at:input.decision_at,settled_cash_cny:text(settled),existing_reserved_cny:text(existing),new_reserved_cny:text(reserved),
    unreserved_cash_cny:text(settled.sub(existing).sub(reserved)),orders};
  const result = {...body,plan_hash:buyDigest(body)};
  contract(result,"plan"); return result;
}

export function executeBuys(input: BuyInput, plan: BuyPlan, outcome: BuyOutcome): BuyResult {
  contract(plan,"plan"); requireValue(buyDigest(plan) === buyDigest(planBuys(input)),"FROZEN_PLAN_MISMATCH");
  contract(outcome,"outcomeInput");
  const evaluated = time(outcome.evaluated_at);
  requireValue(plan.orders.every(order => evaluated >= time(order.expires_at)),"BATCH_NOT_TERMINAL");
  const ids = outcome.observations.map(row => row.order_id), active = new Set(plan.orders.filter(row => row.status === "planned").map(row => row.order_id));
  requireValue(new Set(ids).size === ids.length && ids.every(id => active.has(id)),"EXECUTION_SCOPE_INVALID");
  const observations = new Map(outcome.observations.map(row => [row.order_id,row]));
  for (const observed of observations.values()) {
    requireValue(new D(observed.close).gt(0),"NONPOSITIVE_EXECUTION_PRICE");
    requireValue(time(observed.observed_at) <= time(observed.known_at) && time(observed.known_at) <= evaluated,"FUTURE_EXECUTION_OBSERVATION");
  }
  let debited = new D(0), failures = 0;
  const orders: ExecutedOrder[] = plan.orders.map(order => {
    const observed = observations.get(order.order_id);
    let reason: Reason | null = order.status === "below_minimum" ? "BUDGET_BELOW_ONE_STEP_TOTAL_COST" : null;
    let price: DecimalJs | null = null, fee = new D(0), total = new D(0);
    if (reason === null) {
      if (!observed) reason = "MISSING_EXECUTION_OBSERVATION";
      else if (observed.corporate_action_since_decision) reason = "CORPORATE_ACTION_REVIEW_REQUIRED";
      else if (observed.observed_at !== order.execute_at) reason = "EXECUTION_TIME_MISMATCH";
      else if (time(observed.known_at) > time(order.expires_at)) reason = "EXECUTION_EVIDENCE_LATE";
      else {
        price = new D(observed.close).mul(new D(1).add(new D(input.policy.slippage_bps).div(10000)));
        const required = cost(new D(order.quantity),price,input.policy);
        if (price.gt(order.price_cap)) reason = "PRICE_BOUND_EXCEEDED";
        else if (required.total.gt(order.reserved_cny)) reason = "PRECOMMITTED_BUDGET_EXCEEDED";
        else { reason = "SYNTHETIC_NEXT_CLOSE_PROXY"; total = required.total; fee = required.fee; }
      }
    }
    requireValue(reason !== null,"EXECUTION_REASON_MISSING");
    const filled = reason === "SYNTHETIC_NEXT_CLOSE_PROXY";
    if (order.status === "planned" && !filled) failures++;
    debited = debited.add(total);
    return {order_id:order.order_id,listing_id:order.listing_id,status:filled ? "simulated_filled" : order.status === "below_minimum" ? "below_minimum" : "skipped",
      reason,quantity:order.quantity,execution_price:price === null ? null : text(price),fee_cny:text(fee),
      rounding_cny:text(filled ? total.sub(new D(order.quantity).mul(price!)).sub(fee) : new D(0)),total_cash_cny:text(total),
      released_cny:text(new D(order.reserved_cny).sub(total)),quote_id:observed?.quote_id ?? null};
  });
  const cash = new D(plan.settled_cash_cny).sub(debited);
  requireValue(cash.gte(plan.existing_reserved_cny),"RESERVATION_INVARIANT_BROKEN");
  const body: Omit<BuyResult,"result_hash"> = {schema_version:"bounded-cash-buy-result-v1",engine_version:ENGINE,qualification:"synthetic_test_only",
    implementation_hash:plan.implementation_hash,input_hash:plan.input_hash,policy_hash:plan.policy_hash,plan_hash:plan.plan_hash,
    outcome_input_hash:buyDigest(outcome),batch_id:plan.batch_id,evaluated_at:outcome.evaluated_at,cash_after_cny:text(cash),existing_reserved_cny:plan.existing_reserved_cny,
    unreserved_cash_after_cny:text(cash.sub(plan.existing_reserved_cny)),new_reserved_released_cny:text(new D(plan.new_reserved_cny).sub(debited)),
    total_debited_cny:text(debited),execution_failure_count:failures,orders,live_advice_eligible:false as const};
  const result = {...body,result_hash:buyDigest(body)};
  contract(result,"result"); return result;
}

export function verifyBuyResult(input: BuyInput, plan: BuyPlan, outcome: BuyOutcome, result: BuyResult) {
  contract(result,"result"); requireValue(buyDigest(result) === buyDigest(executeBuys(input,plan,outcome)),"RESULT_REPLAY_MISMATCH"); return result;
}
