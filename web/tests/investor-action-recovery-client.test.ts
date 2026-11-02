import assert from "node:assert/strict";
import test from "node:test";
import { recoveryAttempt, parseRecoveryResponse } from "../src/components/workbench/investor-action-recovery-client";
import { actionReviewInputSchema } from "../src/server/investor/action-review-schemas";
import { recoveryResponse } from "./action-recovery-client-fixture";
import { reviewBinding as binding, reviewNow as now } from "./action-review-client-fixture";

test("separate closed recovery intent requires explicit consent and failure binding, and never supplies event/tax answers", async () => {
  const value = recoveryResponse(), view = value.review.view!;
  await parseRecoveryResponse(value, binding, "w", view, now);
  assert.throws(() => recoveryAttempt(value, false, false, "fictional-recovery", now));
  const attempt = recoveryAttempt(value, true, false, "fictional-recovery", now), input = JSON.parse(attempt.body);
  assert.equal(input.body.schema_version, "investor-unchanged-action-recovery-submit-v1");
  assert.equal(input.body.enable_rule, false); assert.equal(input.body.failed_publication_hash, value.recovery!.failed_publication_hash);
  assert.doesNotMatch(attempt.body, /new_events|tax_per_unit|unchanged private|distribution_amount/);
  assert.equal(actionReviewInputSchema.safeParse(input).success, false);
  assert.equal(JSON.parse(recoveryAttempt(value, true, true, "fictional-enable", now).body).body.enable_rule, true);
});
test("a stale, foreign, non-advancing or changed-data response never creates recovery consent", async () => {
  const base = recoveryResponse(), view = base.review.view!;
  for (const mutate of [
    (v: typeof base) => { v.recovery = null; },
    (v: typeof base) => { v.recovery!.preview_id = "foreign"; },
    (v: typeof base) => { v.review.view!.candidate_coverage_end = view.previous_coverage_end; },
    (v: typeof base) => { v.review.view!.status = "historical_correction_required"; },
    (v: typeof base) => { v.recovery!.failed_source_day = view.source_day; },
    (v: typeof base) => { v.review.read_only = true; },
  ]) { const v = structuredClone(base); mutate(v); assert.throws(() => recoveryAttempt(v, true, false, "fictional", now)); }
  assert.throws(() => recoveryAttempt(base, true, false, "fictional", Date.parse(base.review.refresh_after)));
  const foreign = structuredClone(base); foreign.recovery!.preview_id = "foreign";
  await assert.rejects(parseRecoveryResponse(foreign, binding, "w", view, now));
  await assert.rejects(parseRecoveryResponse(base, "b".repeat(64), "w", view, now));
  await assert.rejects(parseRecoveryResponse(base, binding, "other", view, now));
  await assert.rejects(parseRecoveryResponse(base, binding, "w", { ...view, preview: { ...view.preview, draft_basis_hash: "3".repeat(64) } }, now));
});
