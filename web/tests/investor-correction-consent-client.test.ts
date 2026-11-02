import assert from "node:assert/strict";
import test from "node:test";
import { buildConsentAttempt, parseConsentResponse } from "../src/components/workbench/investor-correction-consent-client";
import { consentAnswers, consentResponse, consentScope, consentSummaryHash, confirmedConsent, queuedConsent } from "./correction-consent-client-fixture";
import { reviewNow } from "./action-review-client-fixture";

test("formal correction requires the exact displayed comparison and seven new acknowledgements, never hypothetical or retain consent", () => {
  const response = consentResponse(), scope = consentScope;
  for (const patch of [{}, { ...consentAnswers, explicit_historical_restatement: false }, { hypothetical_only: true }])
    assert.throws(() => buildConsentAttempt(response, scope, consentSummaryHash, patch as Record<string, boolean>, "fictional-nonce", reviewNow), /ACK_REQUIRED/);
  for (const patch of [{ read_only: true }, { candidate: { ...response.candidate!, all_differences_resolved: false } }])
    assert.throws(() => buildConsentAttempt(consentResponse(patch), scope, consentSummaryHash, consentAnswers, "fictional-nonce", reviewNow), /COMPARISON_REQUIRED/);
  assert.throws(() => buildConsentAttempt(response, scope, "d".repeat(64), consentAnswers, "fictional-nonce", reviewNow), /COMPARISON_REQUIRED/);
  assert.throws(() => buildConsentAttempt(response, scope, consentSummaryHash, consentAnswers, "fictional-nonce", reviewNow + 15000), /EXPIRED/);
  const attempt = buildConsentAttempt(response, scope, consentSummaryHash, consentAnswers, "fictional-nonce", reviewNow);
  assert.equal(attempt.intent.expected_result_hash, response.candidate!.impact_result_hash);
  assert.equal("tax_per_unit" in attempt.intent, false); assert.equal("enable_rule" in attempt.intent, false);
});
test("strict readback binds session/model/impact/original nonce and intent hash; receipts cannot contain economics or claim resumed monitoring", async () => {
  const attempt = buildConsentAttempt(consentResponse(), consentScope, consentSummaryHash, consentAnswers, "fictional-nonce", reviewNow);
  const queued = queuedConsent(attempt.intent), confirmed = confirmedConsent(attempt.intent);
  assert.equal((await parseConsentResponse(queued, consentScope, attempt, reviewNow)).request!.status, "queued");
  assert.equal((await parseConsentResponse(confirmed, consentScope, attempt, reviewNow)).receipt!.source_values_included, false);
  for (const patch of [{ session_binding: "d".repeat(64) }, { lookup_nonce: "other" }, { request: { ...queued.request!, intent_hash: "d".repeat(64) } },
    { request: { ...queued.request!, model_id: "other" } }, { request: { ...queued.request!, impact_request_id: "other" } },
    { receipt: { ...confirmed.receipt!, baseline: {} } }, { receipt: { ...confirmed.receipt!, monitoring_resumed: true } }])
    await assert.rejects(() => parseConsentResponse({ ...confirmed, ...patch }, consentScope, attempt, reviewNow));
  await assert.rejects(() => parseConsentResponse(consentResponse(), consentScope, undefined, reviewNow + 15000));
  const noMatch = consentResponse({ candidate: null, lookup_nonce: attempt.nonce });
  assert.equal((await parseConsentResponse(noMatch, consentScope, attempt, reviewNow)).request, null);
});
