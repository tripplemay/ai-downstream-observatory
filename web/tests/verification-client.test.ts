import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertVerificationReceipt, assertVerificationState, prepareVerificationRequest, readVerificationArtifact } from "../src/components/workbench/verification-client";
import { verificationArtifactBody, verificationArtifactSha256, verificationBinding as binding, verificationOtherBinding as otherBinding, verificationReceipt, verificationState } from "./verification-test-fixture";

test("verification state validates private scope, bounded shape and actual result hash", async () => {
  const value = { ...verificationState("p", true), session_binding: binding };
  assert.equal((await assertVerificationState(value, "p", null, binding)).requests[0].execution!.status, "pass");
  for (const changed of [
    { ...value, session_binding: otherBinding }, { ...value, selected_portfolio_id: "p2" }, { ...value, actor: "forged" },
    { ...value, check: { ...value.check, gate_eligible: true } }, { ...value, check: { ...value.check, data_provenance: "actual" } },
    { ...value, check: { ...value.check, context_hash: null } },
    { ...value, requests: [value.requests[0], value.requests[0]] },
    { ...value, requests: [{ ...value.requests[0], execution: { ...value.requests[0].execution, result_hash: "0".repeat(64) } }] },
    { ...value, requests: [{ ...value.requests[0], execution: { ...value.requests[0].execution, result: { ...value.requests[0].execution!.result, completed_requirements: ["E-02"] } } }] },
  ]) await assert.rejects(assertVerificationState(changed, "p", null, binding), /VERIFICATION_RESPONSE_INVALID/);
  await assert.rejects(assertVerificationState(value, "p", "foreign-request", binding), /VERIFICATION_RESPONSE_INVALID/);
  await assert.rejects(assertVerificationState({ ...value, next_cursor: "cursor" }, "p", "synthetic-request", binding), /VERIFICATION_RESPONSE_INVALID/);
});
test("readonly and unavailable check states remain readable without inventing source readiness", async () => {
  const value = { ...verificationState(), read_only: true, session_binding: binding };
  value.check.available = false; value.check.context_hash = null; value.check.issues = ["VERIFICATION_SOURCE_UNAVAILABLE"];
  const state = await assertVerificationState(value, "p", null, binding); assert.equal(state.read_only, true); assert.equal(state.check.available, false);
  assert.throws(() => prepareVerificationRequest(state, "Synthetic reason", binding, "key"), /VERIFICATION_WRITE_LOCKED/);
});
test("human request freezes the exact context and bytes without an actor, result, shell or fixture payload", () => {
  const state = verificationState(), request = prepareVerificationRequest(state, " Synthetic reason ", binding, "synthetic-key");
  assert.equal(request.command.reason, "Synthetic reason"); assert.equal(request.contextHash, state.check.context_hash);
  assert.deepEqual(Object.keys(JSON.parse(request.body)), ["command"]);
  assert.deepEqual(Object.keys(request.command).sort(), ["check_id", "expected_context_hash", "idempotency_key", "portfolio_id", "reason"]);
  assert.throws(() => prepareVerificationRequest(state, "   ", binding, "key"), /VERIFICATION_COMMAND_INVALID/);
  assert.throws(() => prepareVerificationRequest({ ...state, read_only: true }, "Synthetic", binding, "key"), /VERIFICATION_WRITE_LOCKED/);
  assert.throws(() => prepareVerificationRequest({ ...state, selected_portfolio_id: null }, "Synthetic", binding, "key"), /VERIFICATION_WRITE_LOCKED/);
});
test("receipt confirms only queued status for the exact check/context/session, never a claimed pass", () => {
  const pending = prepareVerificationRequest(verificationState(), "Synthetic request", binding, "key"), receipt = verificationReceipt(pending.body);
  assert.equal(assertVerificationReceipt(receipt, pending).status, "queued");
  for (const changed of [{ ...receipt, context_hash: "0".repeat(64) }, { ...receipt, session_binding: otherBinding }, { ...receipt, status: "pass" },
    { ...receipt, check_id: "G-03" }, { ...receipt, result: { status: "pass" } }]) assert.throws(() => assertVerificationReceipt(changed, pending), /VERIFICATION_RESPONSE_INVALID/);
});
test("private artifact bytes require the bound session, inert attachment headers and exact verified SHA256", async () => {
  const headers = { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="verification-artifact.json"',
    "X-Content-Type-Options": "nosniff", "X-Workbench-Session-Binding": binding, "X-Artifact-SHA256": verificationArtifactSha256 };
  const blob = await readVerificationArtifact(new Response(verificationArtifactBody, { headers }), verificationArtifactSha256, binding);
  assert.equal(blob.type, "application/octet-stream"); assert.equal(await blob.text(), verificationArtifactBody);
  const overrides: Record<string, string>[] = [{ "X-Workbench-Session-Binding": otherBinding }, { "X-Artifact-SHA256": "0".repeat(64) },
    { "Content-Type": "text/html" }, { "Content-Disposition": "inline" }, { "X-Content-Type-Options": "" }, { "Content-Length": "1048577" }];
  for (const extra of overrides) {
    await assert.rejects(readVerificationArtifact(new Response(verificationArtifactBody, { headers: { ...headers, ...extra } }), verificationArtifactSha256, binding), /VERIFICATION_ARTIFACT_INVALID/);
  }
  await assert.rejects(readVerificationArtifact(new Response("SYNTHETIC_TAMPERED", { headers }), verificationArtifactSha256, binding), /VERIFICATION_ARTIFACT_INVALID/);
  const maximum = new Uint8Array(1048576), maximumHash = createHash("sha256").update(maximum).digest("hex");
  const maximumBlob = await readVerificationArtifact(new Response(maximum, { headers: { ...headers, "X-Artifact-SHA256": maximumHash, "Content-Length": "1048576" } }), maximumHash, binding);
  assert.equal(maximumBlob.size, 1048576);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1048577)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  await assert.rejects(readVerificationArtifact(new Response(stream, { headers }), verificationArtifactSha256, binding), /VERIFICATION_ARTIFACT_INVALID/);
  assert.equal(cancelled, true);
});
