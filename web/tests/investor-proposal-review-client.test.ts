import assert from "node:assert/strict";
import test from "node:test";
import { buildProposalReview, parseProposalReview, proposalRiskMessage } from "../src/components/workbench/investor-proposal-review-client";
import { proposalBinding as binding, proposalContext as context, proposalScope as scope } from "./investor-proposal-fixture";

test("proposal context requires an exact bound whole-book scope and explicit selection", () => {
  const response = { ...context, session_binding: binding };
  assert.deepEqual(parseProposalReview(response, scope, "fictional-proposal"), context);
  assert.throws(() => parseProposalReview(response, scope, null));
  for (const patch of [{ session_binding: "b".repeat(64) }, { workspace_id: "foreign" }, { workspace_revision: 3 },
    { ledger_revision: 4 }, { portfolio_id: "foreign" }, { link_id: "foreign" }, { link_version: 2 }, { injected: true }])
    assert.throws(() => parseProposalReview({ ...response, ...patch }, scope, "fictional-proposal"));
  assert.deepEqual(parseProposalReview({ ...response, selected: null }, scope, null), { ...context, selected: null });
  assert.throws(() => parseProposalReview({ ...response, read_only: true }, scope, "fictional-proposal"));
});

test("narrow proposal intents never accept arbitrary governance commands, weights, clocks or trade quantities", () => {
  const now = Date.parse(context.checked_at), intent = buildProposalReview(context, "approve", " Fictional review ", true, now);
  assert.equal(intent.action, "review_linked_proposal"); assert.equal(intent.note, "Fictional review");
  assert.ok(!("quantity" in intent)); assert.ok(!("command" in intent)); assert.ok(!("releaseHash" in intent));
  for (const op of ["", "prepare", "trade", "create_proposal"]) assert.throws(() => buildProposalReview(context, op, "", true, now));
  assert.throws(() => buildProposalReview(context, "approve", "", false, now));
  assert.throws(() => buildProposalReview(context, "approve", "", true, NaN));
  assert.throws(() => buildProposalReview({ ...context, selected: null }, "approve", "", true, now));
  assert.throws(() => buildProposalReview({ ...context, read_only: true, selected: { ...context.selected!, allowed_operations: [] } }, "approve", "", true, now));
  const expiry = Date.parse(context.selected!.expires_at);
  assert.throws(() => buildProposalReview(context, "approve", "", true, expiry));
  assert.equal(buildProposalReview(context, "cancel_remainder", "", true, expiry).operation, "cancel_remainder");
  assert.match(proposalRiskMessage("G-01_POLICY"), /政策范围/);
  assert.match(proposalRiskMessage("UNKNOWN_FIXTURE"), /未通过/);
});
