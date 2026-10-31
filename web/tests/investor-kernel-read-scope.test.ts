import assert from "node:assert/strict";
import test from "node:test";
import { withInvestorKernelReadScope as scope, verifyInvestorKernelProof as proof } from "../src/server/investor/kernel-read-scope";

const key = (n: number) => () => n.toString(16).padStart(64, "0");
test("cheap legacy checks can opt out without retaining a proof", () => {
  let count = 0;
  scope(() => { for (let n = 0; n < 3; n++) proof(() => null, () => { count++; }); });
  assert.equal(count, 3);
});
test("proof reuse is synchronous, success-only, bounded and never survives the owning read", () => {
  let count = 0;
  const verify = () => { count++; };
  proof(() => { throw new Error("OUTSIDE_SCOPE_KEY_MUST_NOT_RUN"); }, verify);
  scope(() => { proof(key(1), verify); proof(key(1), verify); });
  assert.equal(count, 2);
  scope(() => { proof(key(1), verify); }); assert.equal(count, 3);
  assert.throws(() => scope(() => { proof(key(2), () => { throw new Error("FICTIONAL_INVALID_PROOF"); }); }), /FICTIONAL_INVALID_PROOF/);
  scope(() => {
    assert.throws(() => proof(key(2), () => { throw new Error("FICTIONAL_INVALID_PROOF"); }));
    proof(key(2), verify);
  }); assert.equal(count, 4);
  scope(() => {
    for (let n = 1; n <= 70; n++) proof(key(n), verify);
    for (let n = 1; n <= 70; n++) proof(key(n), verify);
  }); assert.equal(count, 80);
  assert.throws(() => scope(() => Promise.resolve(true)), /MUST_BE_SYNCHRONOUS/);
  proof(key(1), verify); assert.equal(count, 81);
});

test("nested reads have distinct proof sets, restore the parent on success/failure, and reject malformed keys", () => {
  let count = 0;
  const verify = () => { count++; };
  scope(() => {
    proof(key(1), verify);
    scope(() => { proof(key(1), verify); proof(key(1), verify); });
    assert.throws(() => scope(() => { proof(key(1), verify); throw new Error("FICTIONAL_READ_FAILURE"); }));
    proof(key(1), verify);
    assert.throws(() => proof(() => "unbound", verify), /PROOF_KEY_INVALID/);
  });
  assert.equal(count, 3);
  scope(() => proof(key(1), verify)); assert.equal(count, 4);
});
