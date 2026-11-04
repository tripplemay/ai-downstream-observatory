import assert from "node:assert/strict";
import test from "node:test";
import { withInvestorKernelReadScope as scope, verifyInvestorKernelProof as proof } from "../src/server/investor/kernel-read-scope";
import { actionPython, readActionFixtureTimings } from "./action-maintenance-fixture";
import { investorFixture } from "./investor-fixture";

const key = (n: number) => () => n.toString(16).padStart(64, "0");
test("offline timing diagnostics contain only bounded fixed scalar phases, never child documents or warnings", () => {
  const row={phase:"progress",checks:128,validated:8,hits:120,uncacheable:0,entries:8,key_ms:5.1,validation_ms:12,elapsed_ms:18};
  const line=(value:unknown)=>"FICTIONAL_SHAPE_TIMING "+JSON.stringify(value)+"\n";
  assert.deepEqual(readActionFixtureTimings("foreign warning with fictional private content\n"+line(row)),[row]);
  for(const value of [null,[],{...row,secret:"FICTIONAL_PRIVATE_VALUE"},{...row,phase:"FICTIONAL_PRIVATE_VALUE"},
    {...row,key_ms:"1"},{...row,entries:9},{...row,hits:121},{...row,checks:-1},{...row,validated:1.5},
    {...row,uncacheable:9},{...row,elapsed_ms:null},{...row,key_ms:-1}]) {
    assert.throws(()=>readActionFixtureTimings(line(value)),error=>error instanceof Error&&error.message==="INVALID_ACTION_FIXTURE_TIMING");
  }
  for(const value of ["FICTIONAL_SHAPE_TIMING {\"secret\":",line({...row,phase:"x".repeat(2048)}),line(row).repeat(257),
    line(row).replace('"key_ms":5.1','"key_ms":1e999')])
    assert.throws(()=>readActionFixtureTimings(value),/^Error: INVALID_ACTION_FIXTURE_TIMING$/);
});
test("malformed offline diagnostics never replace an original child failure or turn a successful child into silent acceptance", t => {
  const f=investorFixture();t.after(f.close);
  const malformed="print('FICTIONAL_SHAPE_TIMING malformed',file=sys.stderr)\n";
  assert.throws(()=>actionPython(f.filename,malformed+"raise RuntimeError('FICTIONAL_ORIGINAL_CHILD_FAILURE')"),/FICTIONAL_ORIGINAL_CHILD_FAILURE/);
  assert.throws(()=>actionPython(f.filename,malformed+"print('{}')"),/^Error: INVALID_ACTION_FIXTURE_TIMING$/);
});
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
