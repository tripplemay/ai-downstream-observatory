import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { hash } from "../src/server/ledger/service";
import { replayCorrectedModelEpoch, replayModelEpochContinuation, verifyCorrectedModelEpochArithmetic, verifyModelEpochContinuationArithmetic } from "../src/server/investor/model-epoch-transition";
import { replayEvidenceModel } from "../src/server/investor/evidence-model-state";
import { replayEvidenceAssessment } from "../src/server/investor/evidence-model-assessment";
import { validateModelEpochTransition, validateInvestorEvidenceCheckpoint, validateInvestorMonitorDataDocument } from "../src/server/investor/kernel-contracts";

type Obj = Record<string, unknown>;
type Result = ReturnType<typeof replayCorrectedModelEpoch>;
const python = process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3";
function fixtures(continuation = false) {
  return JSON.parse(execFileSync(python, ["-c", `
from tests.investor.test_model_epoch_transition import epoch_cases,continuation_cases
from worker.investor.model_epoch_transition import advance_corrected_model_epoch,continue_corrected_model_epoch
from worker.orchestration.db import canonical_json
fn=${continuation ? "continue_corrected_model_epoch" : "advance_corrected_model_epoch"}
cases=${continuation ? "continuation_cases" : "epoch_cases"}
print(canonical_json({name:{'input':value,'result':fn(value)} for name,value in cases().items()}))
`], { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 30000, maxBuffer: 2097152 })) as Record<string, { input: Obj; result: Result }>;
}

test("ongoing v4 observations retain their immutable epoch, reuse sparse state and apply a new split or payment only once", () => {
  for (const [name, { input, result }] of Object.entries(fixtures(true))) {
    const before = structuredClone(input), actual = replayModelEpochContinuation(input, result.assessment.implementation_hash as string);
    assert.deepEqual(actual, result, name); assert.deepEqual(input, before, name);
    assert.deepEqual(actual.epoch_binding, (input.previous as Obj).epoch_binding);
    if (name === "stale") { assert.equal(actual.checkpoint, null); assert.equal(actual.monitor_request, null); continue; }
    if (name === "same_close" || name === "same_payment_again") assert.deepEqual(actual.checkpoint, input.previous);
    if (name === "paid") assert.notDeepEqual(actual.checkpoint, input.previous);
    if (name === "new_split" || name === "new_payment") assert.equal(actual.checkpoint!.previous_hash, hash(input.previous));
    assert.deepEqual(verifyModelEpochContinuationArithmetic(input, result, result.assessment.implementation_hash as string), result);
    assert.equal(actual.registered_bindings_verified, false); assert.equal(actual.source_evidence_verified, false);
  }
});

test("independent epoch bridge replays corrections and the next close without resetting principal or rewriting the stored parent", () => {
  for (const [name, { input, result }] of Object.entries(fixtures())) {
    const before = structuredClone(input), actual = replayCorrectedModelEpoch(input, result.assessment.implementation_hash as string);
    assert.deepEqual(actual, result, name); assert.deepEqual(input, before, name);
    assert.equal(actual.registered_bindings_verified, false); assert.equal(actual.source_evidence_verified, false);
    assert.equal(actual.checkpoint_created, false); assert.equal(actual.monitoring_resumed, false); assert.equal(actual.trading_permission, false);
    if (name === "stale") { assert.equal(actual.checkpoint, null); assert.equal(actual.monitor_request, null); continue; }
    const candidate = actual.checkpoint!, history = input.history as Obj, head = history.head as Obj;
    assert.equal(candidate.previous_hash, hash(head)); assert.equal(candidate.initial_notional_cny, "10000");
    assert.deepEqual(candidate.initialized_at, head.initialized_at);
    assert.equal(((actual.monitor_request!.document) as Obj).model_state_hash, hash(candidate));
    assert.throws(() => validateInvestorEvidenceCheckpoint(candidate));
    assert.throws(() => validateInvestorMonitorDataDocument("input", input));
    assert.throws(() => replayEvidenceModel(history.definition, input.projection, candidate, input.now as string, input.input_hash as string));
    assert.deepEqual(verifyCorrectedModelEpochArithmetic(input, result, result.assessment.implementation_hash as string), result);
  }
});

test("wrong economics, ledger, strategy state, scope, handover clock or one old market close cannot become a corrected current state", () => {
  const { input: base, result } = fixtures().paid;
  const mutations: ((value: Obj) => void)[] = [
    v => { (v.corrections as Obj[]).push(structuredClone((v.corrections as Obj[])[0])); },
    v => { ((((v.corrections as Obj[])[0].baseline as Obj).economics as Obj).cash_by_currency as Obj).HKD = "99999"; },
    v => { ((v.corrections as Obj[])[0].baseline as Obj).policy_state = {}; },
    v => { (v.corrections as Obj[])[0].handover_at = v.now; },
    v => { const quote = ((v.projection as Obj).quotes as Obj[])[0]; quote.observed_at = (((v.history as Obj).head as Obj).market_cutoffs as Obj)[quote.market as string]; },
    v => { ((v.projection as Obj).quotes as Obj[]).pop(); },
    v => { (v.projection as Obj).corporate_actions = []; },
    v => { ((v.corrections as Obj[])[0].corrected_actions as Obj[])[0].known_at = ((v.history as Obj).head as Obj).created_at; },
    v => { (((v.corrections as Obj[])[0].baseline as Obj).original_history as Obj).model_hash = "a".repeat(64); },
    v => { v.force = true; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = structuredClone(base); mutate(value);
    assert.throws(() => replayCorrectedModelEpoch(value, result.assessment.implementation_hash as string), "mutation " + index);
  }
  for (const flag of ["registered_bindings_verified", "source_evidence_verified", "checkpoint_created", "state_published", "monitoring_resumed", "trading_permission"])
    assert.throws(() => validateModelEpochTransition("result", { ...result, [flag]: true }));
  for (let index = 0; index < ((base.projection as Obj).quotes as Obj[]).length; index++) {
    const value = structuredClone(base);
    ((value.projection as Obj).quotes as Obj[])[index].observed_at = (value.corrections as Obj[])[0].handover_at;
    assert.throws(() => replayCorrectedModelEpoch(value, result.assessment.implementation_hash as string), /NEXT_CLOSE_REQUIRED/);
  }
  const forged = structuredClone(result); forged.checkpoint!.previous_hash = forged.epoch_binding.bridge_hash;
  const document = forged.monitor_request!.document as Obj; document.model_state_hash = hash(forged.checkpoint);
  forged.assessment = replayEvidenceAssessment(document, base.now as string, result.assessment.implementation_hash as string) as Obj;
  validateModelEpochTransition("result", forged);
  assert.throws(() => verifyCorrectedModelEpochArithmetic(base, forged, result.assessment.implementation_hash as string), /RESULT_REPLAY_MISMATCH/);
});
