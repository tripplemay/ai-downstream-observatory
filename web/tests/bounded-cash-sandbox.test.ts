import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import Decimal from "decimal.js";
import { buyDigest, buyImplementationHash, executeBuys, planBuys, verifyBuyResult, type BuyInput, type BuyOutcome, type BuyPlan, type BuyResult } from "../src/server/execution-sandbox/bounded-cash";

function python(script: string, input?: unknown) {
  const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3",["-c",script],
    {cwd:path.resolve(".."),encoding:"utf8",input:input === undefined ? undefined : JSON.stringify(input),timeout:30000,maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.stderr); return JSON.parse(result.stdout);
}
const fixture: BuyInput = python("import json; from tests.execution_sandbox.fixtures import buy_input; print(json.dumps(buy_input()))");
function input() { return structuredClone(fixture); }
function outcome(value = input(), close = "10.12"): BuyOutcome {
  return {schema_version:"bounded-cash-buy-outcome-input-v1",qualification:"synthetic_test_only",
    evaluated_at:[...value.orders].map(row => row.expires_at).sort().at(-1)!,observations:value.orders.map((row,index) =>
      ({order_id:row.order_id,quote_id:"synthetic:execution-"+index,close,observed_at:row.execute_at,known_at:row.execute_at,corporate_action_since_decision:false}))};
}
function independent(vectors: {input: BuyInput; outcome: BuyOutcome}[]): {plan: BuyPlan; result: BuyResult}[] {
  return python("import json,sys; from worker.execution_sandbox.bounded_cash import plan_buys,execute_buys; rows=[]\nfor v in json.load(sys.stdin):\n p=plan_buys(v['input']); rows.append({'plan':p,'result':execute_buys(v['input'],p,v['outcome'])})\nprint(json.dumps(rows))",vectors);
}
function reseal(value: Record<string,unknown>, field: string) { const body = {...value}; delete body[field]; value[field] = buyDigest(body); }

test("independent runtime manifests and hand-computed maximum quantities, cents and cash agree", () => {
  const value = input(), at = outcome(value), plan = planBuys(value), result = executeBuys(value,plan,at);
  assert.equal(plan.implementation_hash,buyImplementationHash());
  assert.equal(plan.orders[0].quantity,"90"); assert.equal(plan.orders[0].price_cap,"10.2");
  assert.equal(plan.orders[0].worst_total_cash_cny,"920"); assert.equal(plan.unreserved_cash_cny,"0");
  assert.equal(result.total_debited_cny,"912.8"); assert.equal(result.cash_after_cny,"289.2");
  assert.equal(result.unreserved_cash_after_cny,"89.2"); assert.equal(result.execution_failure_count,0);
  assert.deepEqual(independent([{input:value,outcome:at}]),[{plan,result}]);
});

test("future fill cannot resize frozen quantities or change policy and no-buffer diagnostic preserves the failure", () => {
  const value = input(); value.policy.price_buffer_bps = "0";
  const plan = planBuys(value), result = executeBuys(value,plan,outcome(value));
  assert.equal(plan.orders[0].quantity,"100"); assert.equal(result.orders[0].quantity,"100");
  assert.equal(result.orders[0].reason,"PRICE_BOUND_EXCEEDED"); assert.equal(result.execution_failure_count,1);
  assert.equal(result.total_debited_cny,"0"); assert.equal(result.cash_after_cny,"1202");
  const changed = structuredClone(value); changed.policy.price_buffer_bps = "200";
  assert.throws(() => executeBuys(changed,plan,outcome(changed)),/FROZEN_PLAN_MISMATCH/);
});

test("cap includes slippage; exact boundary and upward debit rounding survive dual replay", () => {
  const first = input(), second = input(), third = input();
  second.policy.slippage_bps = "100"; second.policy.minimum_fee_cny = "0";
  third.policy = {...third.policy,price_buffer_bps:"0",commission_bps:"0",minimum_fee_cny:"0"};
  third.existing_reservations = []; third.settled_cash_cny = "1";
  third.orders[0].allocated_budget_cny = "1"; third.orders[0].quantity_step = "1"; third.orders[0].decision_quote.close = "0.33333333";
  const vectors = [{input:first,outcome:outcome(first,"10.2")},{input:first,outcome:outcome(first,"10.20000001")},
    {input:second,outcome:outcome(second,"10")},{input:third,outcome:outcome(third,"0.33333333")}];
  const actual = vectors.map(v => {const plan = planBuys(v.input); return {plan,result:executeBuys(v.input,plan,v.outcome)};});
  assert.deepEqual(actual,independent(vectors));
  assert.equal(actual[0].result.total_debited_cny,"920"); assert.equal(actual[1].result.execution_failure_count,1);
  assert.equal(actual[2].result.total_debited_cny,"909.46"); assert.equal(actual[3].result.total_debited_cny,"1");
  assert.equal(actual[2].result.orders[0].rounding_cny,"0.0055");
});

test("batch budgets, pending reservations, unsettled money and below-minimum amounts never cross-finance", () => {
  const value = input(), second = structuredClone(value.orders[0]);
  second.order_id = "synthetic:buy-b"; second.listing_id = "CN:SYNTHETIC_B";
  value.orders.push(second); value.settled_cash_cny = "2204";
  const at = outcome(value); at.observations[1].close = "10.21";
  const plan = planBuys(value), result = executeBuys(value,plan,at);
  assert.equal(result.cash_after_cny,"1291.2"); assert.equal(result.existing_reserved_cny,"200");
  assert.deepEqual(result.orders.map(row => row.status),["simulated_filled","skipped"]);
  assert.deepEqual(independent([{input:value,outcome:at}]),[{plan,result}]);
  value.settled_cash_cny = "2203.99"; assert.throws(() => planBuys(value),/SETTLED_CASH_EXCEEDED/);
  const small = input(); small.orders[0].allocated_budget_cny = "1";
  const smallOutcome = outcome(small); smallOutcome.observations = [];
  const smallPlan = planBuys(small), smallResult = executeBuys(small,smallPlan,smallOutcome);
  assert.equal(smallPlan.new_reserved_cny,"0"); assert.equal(smallResult.total_debited_cny,"0");
  assert.equal(smallResult.orders[0].reason,"BUDGET_BELOW_ONE_STEP_TOTAL_COST");
  assert.deepEqual(independent([{input:small,outcome:smallOutcome}]),[{plan:smallPlan,result:smallResult}]);
});

test("missing, late, wrong-time and corporate-action evidence remain distinct counted execution gaps", () => {
  const value = input(), plan = planBuys(value), vectors: {input: BuyInput; outcome: BuyOutcome}[] = [];
  const missing = outcome(value); missing.observations = [];
  const late = outcome(value); late.observations[0].known_at = "2025-01-03T08:00:00.000001Z"; late.evaluated_at = late.observations[0].known_at;
  const wrong = outcome(value); wrong.observations[0].observed_at = "2025-01-03T06:59:59.999999Z";
  const action = outcome(value); action.observations[0].corporate_action_since_decision = true; action.observations[0].close = "5";
  for (const at of [missing,late,wrong,action]) vectors.push({input:value,outcome:at});
  const results = vectors.map(v => ({plan,result:executeBuys(v.input,plan,v.outcome)}));
  assert.deepEqual(results,independent(vectors));
  assert.deepEqual(results.map(row => row.result.orders[0].reason),["MISSING_EXECUTION_OBSERVATION","EXECUTION_EVIDENCE_LATE","EXECUTION_TIME_MISMATCH","CORPORATE_ACTION_REVIEW_REQUIRED"]);
  assert(results.every(row => row.result.execution_failure_count === 1 && row.result.orders[0].quantity === "90" && row.result.total_debited_cny === "0"));
});

test("microsecond point-in-time checks reject future knowledge, expiry, stale quotes and nonterminal evaluation", () => {
  for (const [field,value] of [["known_at","2025-01-02T08:00:00.000001Z"],["valid_until","2025-01-02T08:00:00.000000Z"],
    ["observed_at","2025-01-02T06:59:59.999999Z"]] as const) {
    const changed = input(); changed.orders[0].decision_quote[field] = value;
    assert.throws(() => planBuys(changed),/DECISION_QUOTE_UNAVAILABLE/);
  }
  const value = input(), plan = planBuys(value), at = outcome(value); at.evaluated_at = "2025-01-03T07:59:59.999999Z";
  assert.throws(() => executeBuys(value,plan,at),/BATCH_NOT_TERMINAL/);
  at.evaluated_at = value.orders[0].expires_at; at.observations[0].known_at = "2025-01-03T08:00:00.000001Z";
  assert.throws(() => executeBuys(value,plan,at),/FUTURE_EXECUTION_OBSERVATION/);
});

test("resealed coherent-looking order and cash mutations fail independent replay, not just hash checks", () => {
  const value = input(), plan = planBuys(value), at = outcome(value), result = executeBuys(value,plan,at);
  for (const field of ["quantity","price_cap","reserved_cny","worst_total_cash_cny"] as const) {
    const changed = structuredClone(plan); changed.orders[0][field] = "80"; reseal(changed,"plan_hash");
    assert.throws(() => executeBuys(value,changed,at),/FROZEN_PLAN_MISMATCH/);
  }
  for (const mutate of [(r: BuyResult) => {r.cash_after_cny = "999";},(r: BuyResult) => {r.execution_failure_count = 1;},
    (r: BuyResult) => {r.orders[0].fee_cny = "0";},(r: BuyResult) => {r.orders[0].quantity = "80";}]) {
    const changed = structuredClone(result); mutate(changed); reseal(changed,"result_hash");
    assert.throws(() => verifyBuyResult(value,plan,at,changed),/RESULT_REPLAY_MISMATCH/);
  }
  assert.deepEqual(verifyBuyResult(value,plan,at,result),result);
});

test("unsupported real data, FX, partial fills, duplicate orders and float coercions fail closed in both runtimes", () => {
  const values: BuyInput[] = [];
  for (const mutate of [(r: BuyInput) => {r.orders[0].currency = "USD" as never;},(r: BuyInput) => {r.orders[0].market = "HK" as never;},
    (r: BuyInput) => {r.qualification = "owner_reviewed_reconstructed" as never;},(r: BuyInput) => {r.policy.commission_bps = 0.1 as never;},
    (r: BuyInput) => {r.policy.max_quote_age_seconds = true as never;},(r: BuyInput) => {r.policy.cash_quantum = "0.001" as never;},
    (r: BuyInput) => {r.orders[0].order_id = r.existing_reservations[0].order_id;},(r: BuyInput) => {r.orders.push(structuredClone(r.orders[0]));},
    (r: BuyInput) => {r.policy.price_buffer_bps = "10001";},(r: BuyInput) => {r.orders[0].quantity_step = "0";},
    (r: BuyInput) => {r.orders[0].decision_quote.close = "1e2";},(r: BuyInput) => {r.orders[0].allocated_budget_cny = "0.001";}]) {
    const value = input(); mutate(value); values.push(value); assert.throws(() => planBuys(value),/BOUNDED_CASH_/);
  }
  const rejects = python("import json,sys; from worker.execution_sandbox.bounded_cash import plan_buys,BoundedCashError; rows=[]\nfor v in json.load(sys.stdin):\n try: plan_buys(v); rows.append(False)\n except BoundedCashError: rows.append(True)\nprint(json.dumps(rows))",values);
  assert(rejects.every(Boolean));
  const value = input(), plan = planBuys(value), at = outcome(value);
  (at.observations[0] as unknown as Record<string,unknown>).filled_quantity = "80";
  assert.throws(() => executeBuys(value,plan,at),/CONTRACT_INVALID/);
});

test("seeded synthetic fee, price, step and boundary corpus satisfies maximum-lot and cash invariants in both languages", () => {
  let seed = 64107;
  const next = () => {seed = (seed * 48271) % 2147483647; return seed;};
  const vectors: {input: BuyInput; outcome: BuyOutcome}[] = [];
  for (let index = 0; index < 64; index++) {
    const value = input(), price = (next() % 50000 + 100) / 100;
    value.policy.price_buffer_bps = String(next() % 1001); value.policy.commission_bps = String(next() % 41);
    value.policy.minimum_fee_cny = String(next() % 6); value.policy.slippage_bps = "0";
    value.existing_reservations = []; value.settled_cash_cny = String(next() % 50000 + 1);
    value.orders[0].allocated_budget_cny = value.settled_cash_cny; value.orders[0].quantity_step = ["1","10","100","0.01"][next() % 4];
    value.orders[0].decision_quote.close = String(price);
    const at = outcome(value,String(price));
    if (planBuys(value).orders[0].status === "below_minimum") at.observations = [];
    vectors.push({input:value,outcome:at});
  }
  const actual = vectors.map(v => {const plan = planBuys(v.input); return {plan,result:executeBuys(v.input,plan,v.outcome)};});
  assert.deepEqual(actual,independent(vectors));
  for (const [index,row] of actual.entries()) {
    const order = row.plan.orders[0], policy = vectors[index].input.policy, quantity = new Decimal(order.quantity), budget = new Decimal(order.allocated_budget_cny);
    const nextPrincipal = quantity.add(order.quantity_step).mul(order.price_cap);
    const nextCost = nextPrincipal.add(Decimal.max(policy.minimum_fee_cny,nextPrincipal.mul(policy.commission_bps).div(10000))).toDecimalPlaces(2,Decimal.ROUND_CEIL);
    assert(nextCost.gt(budget)); assert(new Decimal(order.worst_total_cash_cny).lte(budget));
    assert(new Decimal(row.result.cash_after_cny).gte(0)); assert.equal(row.result.live_advice_eligible,false);
  }
});

test("large exact quantities beyond Number safety and small price/step retain identical bounded results", () => {
  const value = input(); value.policy.price_buffer_bps = "10000"; value.policy.commission_bps = "0"; value.policy.minimum_fee_cny = "0";
  value.existing_reservations = []; value.settled_cash_cny = "999999999999999999.99";
  value.orders[0].allocated_budget_cny = value.settled_cash_cny; value.orders[0].quantity_step = "0.00000001";
  value.orders[0].decision_quote.close = "0.00000001";
  const at = outcome(value,"0.00000001"), plan = planBuys(value), result = executeBuys(value,plan,at);
  assert(BigInt(plan.orders[0].lot_count) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.deepEqual(independent([{input:value,outcome:at}]),[{plan,result}]);
});

test("replay is deterministic and input mutation or global decimal configuration is never performed", () => {
  const value = input(), at = outcome(value), before = structuredClone({value,at}), precision = Decimal.precision;
  const plan = planBuys(value), saved = structuredClone(plan), result = executeBuys(value,plan,at);
  assert.deepEqual({value,at},before); assert.deepEqual(plan,saved); assert.equal(Decimal.precision,precision);
  assert.deepEqual(planBuys(value),plan); assert.deepEqual(executeBuys(value,plan,at),result);
});

test("UTC years before epoch and sub-millisecond boundaries replay without calendar normalization", () => {
  const vectors = ["0001","1969","2025"].map(year => {
    const value = input(); value.decision_at = value.decision_at.replace("2025",year);
    const order = value.orders[0]; order.execute_at = order.execute_at.replace("2025",year); order.expires_at = order.expires_at.replace("2025",year);
    for (const field of ["observed_at","known_at","valid_until"] as const) order.decision_quote[field] = order.decision_quote[field].replace("2025",year);
    return {input:value,outcome:outcome(value)};
  });
  assert.deepEqual(vectors.map(v => {const plan = planBuys(v.input); return {plan,result:executeBuys(v.input,plan,v.outcome)};}),independent(vectors));
  const value = input(); value.orders[0].decision_quote.observed_at = "2025-02-29T07:00:00.000000Z";
  assert.throws(() => planBuys(value),/CONTRACT_INVALID/);
});

test("integral JSON number spelling does not give Python and Web different frozen identities", () => {
  const value = input();
  const other = python("import json; from tests.execution_sandbox.fixtures import buy_input; from worker.execution_sandbox.bounded_cash import plan_buys; v=buy_input(); v['policy']['max_quote_age_seconds']=3600.0; print(json.dumps(plan_buys(v)))");
  assert.deepEqual(planBuys(value),other);
});
