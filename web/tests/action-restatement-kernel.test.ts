import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { compareActionRestatement, verifyActionRestatementArithmetic } from "../src/server/investor/action-restatement-kernel";
import { validateActionRestatementKernel, validateInvestorEvidenceCheckpoint, validateInvestorMonitorDataDocument } from "../src/server/investor/kernel-contracts";

type Obj = Record<string, unknown>;
const python = process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3";
function fixtures(extended = false) {
  return JSON.parse(execFileSync(python, ["-c", `
from tests.investor.test_action_restatement_kernel import restatement_cases
from worker.investor.action_restatement_kernel import compare_action_restatement
from worker.orchestration.db import canonical_json
values=restatement_cases(include_long=${extended ? "True" : "False"})
print(canonical_json({key:{'input':value,'result':compare_action_restatement(value)} for key,value in values.items()}))
`], { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 30000, maxBuffer: 2097152 })) as Record<string, { input: Obj; result: ReturnType<typeof compareActionRestatement> }>;
}

test("independent Node reconstructs original and corrected paid/unpaid/cancelled/missed/split economics at the same old prices", () => {
  const values = fixtures(true);
  for (const [name, { input, result }] of Object.entries(values)) {
    const before = structuredClone(input), actual = compareActionRestatement(input);
    assert.deepEqual(actual, result, name); assert.deepEqual(input, before, name);
    assert.deepEqual(verifyActionRestatementArithmetic(input, result), actual, name);
    assert.equal(actual.source_evidence_verified, false); assert.equal(actual.checkpoint_created, false);
    assert.equal(actual.state_published, false); assert.equal(actual.monitoring_resumed, false);
    assert.equal(actual.current_advice_certified, false); assert.equal(actual.trading_permission, false);
    assert.equal(actual.provider_calls, 0); assert.equal(actual.database_writes, 0);
    assert.throws(() => validateInvestorEvidenceCheckpoint(actual));
    assert.throws(() => validateInvestorMonitorDataDocument("input", actual));
  }
  assert.equal(values.paid.result.difference_cny, "24"); assert.equal(values.unpaid.result.difference_cny, "24");
  assert.equal(values.cancelled.result.difference_cny, "-120"); assert.equal(values.missed.result.difference_cny, "144");
  assert.equal(values.split.result.difference_cny, "2000");
  assert.equal(values.ex_entitlement_before_later_split.result.difference_cny, "48");
  assert.equal(Object.keys(values.long_ledger.result.restated.processed_actions).length, 600);
  for (const name of ["fixed", "funded_v1", "funded_fixed"]) assert.equal(values[name].result.difference_cny, "24");
  assert.equal(values.dictionary_identifier.result.difference_cny, "24");
  assert.equal(values.knowledge_only.result.economics_changed, false); assert.equal(values.knowledge_only.result.changed_action_count, 2);
});

test("original replay and correction coverage cannot be replaced by a well-shaped state, changed prices, a missing entitlement or future knowledge", () => {
  const base = fixtures().paid.input;
  const mutations: ((value: Obj) => void)[] = [
    value => { ((value.head as Obj).cash_by_currency as Obj).HKD = "151"; },
    value => { const quantities = (value.origin as Obj).quantities as Obj; quantities[Object.keys(quantities)[0]] = "999"; },
    value => { ((value.original_actions as Obj[])[0]).net_per_unit = "7"; },
    value => { ((value.head_projection as Obj).fx as Obj[])[0].value = "2"; },
    value => { (value.head as Obj).model_id = "foreign-model"; },
    value => { ((value.corrected_coverage as Obj).HK as Obj).complete = false; },
    value => { const row = (value.corrected_coverage as Obj).HK as Obj; row.from = row.to; },
    value => { (value.corrected_actions as Obj[])[0].known_at = "2025-07-19T00:00:00.000Z"; },
    value => { (value.corrected_actions as Obj[]).push(structuredClone((value.corrected_actions as Obj[])[0])); },
    value => { value.corrected_actions = (value.corrected_actions as Obj[]).slice(1); },
    value => { (value.corrected_actions as Obj[])[0].currency = "USD"; },
    value => { (value.corrected_actions as Obj[])[1].ex_at = "2025-07-19T00:00:00.000Z"; },
  ];
  for (const [index, mutate] of mutations.entries()) { const value = structuredClone(base); mutate(value); assert.throws(() => compareActionRestatement(value), "mutation " + index); }
});

test("closed arithmetic results cannot become source certification, current advice, publication or automatic migration", () => {
  const { input, result } = fixtures().paid;
  for (const key of ["source_evidence_verified", "state_published", "checkpoint_created", "monitoring_resumed", "current_advice_certified", "trading_permission"]) {
    assert.throws(() => validateActionRestatementKernel("result", { ...result, [key]: true }), key);
  }
  assert.throws(() => compareActionRestatement({ ...input, force: true }));
  assert.throws(() => compareActionRestatement({ ...input, now: input.checked_at }));
  const forged = { ...result, difference_cny: "0" };
  validateActionRestatementKernel("result", forged);
  assert.throws(() => verifyActionRestatementArithmetic(input, forged), /RESULT_REPLAY_MISMATCH/);
});

test("extreme split growth and underflow stop at the existing derived-number limits instead of overflowing or zeroing units", () => {
  for (const ratio of ["1000000000000000000", "0.000000000000000001"]) {
    const value = fixtures().paid.input, action = (value.corrected_actions as Obj[])[0];
    (value.corrected_actions as Obj[]).push(...Array.from({ length: 20 }, (_, index) => ({ id: "fictional-extreme-" + index,
      listing_id: action.listing_id, kind: "split", ratio, effective_at: action.effective_at, known_at: value.checked_at })));
    assert.throws(() => compareActionRestatement(value), /DERIVED_RANGE/);
  }
});
