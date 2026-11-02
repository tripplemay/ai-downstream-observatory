import assert from "node:assert/strict";
import test from "node:test";
import { buildLegacyTransitionConfirmation, legacyTransitionAttempt, parseLegacyTransitionResponse, readLegacyTransitionJson } from "../src/components/workbench/investor-legacy-transition-client";
import { legacyTransitionAcknowledgements } from "../src/server/investor/legacy-transition-schemas";
import { transitionBinding as binding, transitionIntent, transitionNow as now, transitionResponse } from "./legacy-transition-client-fixture";

test("closed client verifies session, workspace, exact attempt, witness hash and refresh before constructing an explicit five-ack confirmation", async () => {
  const attempt = legacyTransitionAttempt(transitionIntent, binding, "w"), response = transitionResponse({ lookup_nonce: attempt.nonce });
  const value = await parseLegacyTransitionResponse(response, binding, "w", now, attempt);
  const acks = Object.fromEntries(legacyTransitionAcknowledgements.map(key => [key, true]));
  assert.throws(() => buildLegacyTransitionConfirmation(value, {}, "fictional-submit", now), /ACK_REQUIRED/);
  const intent = buildLegacyTransitionConfirmation(value, acks, "fictional-submit", now); assert.equal(intent.kind, "confirmation");
  if (intent.kind !== "confirmation") throw new Error("EXPECTED_CONFIRMATION");
  assert.equal(intent.body.expected_preview_hash, value.request?.resource_hash); assert.equal(intent.body.expected_revision, 1);
  assert.deepEqual(intent.body.acknowledgements, acks); assert.equal("enable_rule" in intent.body, false);
  const frozen = legacyTransitionAttempt(intent, binding, "w"); intent.body.idempotency_key = "caller-change";
  assert.equal(JSON.parse(frozen.body).body.idempotency_key, "fictional-submit");
  for (const [raw, sid, workspace, at] of [[response, "b".repeat(64), "w", now], [response, binding, "other", now],
    [response, binding, "w", now + 15000], [{ ...response, lookup_nonce: "other" }, binding, "w", now],
    [{ ...response, request: { ...response.request, intent_hash: "0".repeat(64) } }, binding, "w", now],
    [{ ...response, view: { ...response.view, preview: { ...response.view!.preview, basis_hash: "0".repeat(64) } } }, binding, "w", now]] as const)
    await assert.rejects(parseLegacyTransitionResponse(raw, sid, workspace, at, attempt));
  assert.throws(() => buildLegacyTransitionConfirmation(value, acks, "fictional-submit", now + 15000), /VIEW_STALE/);
});

test("response decoding is byte bounded, strict UTF8 and duplicate-key rejecting", async () => {
  assert.deepEqual(await readLegacyTransitionJson(new Response(JSON.stringify(transitionResponse()))), transitionResponse());
  for (const data of ['{"request":null,"request":null}', new Uint8Array([255]), "x".repeat(65537)]) await assert.rejects(readLegacyTransitionJson(new Response(data)));
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  await assert.rejects(readLegacyTransitionJson(new Response(stream))); assert.equal(cancelled, true);
});
