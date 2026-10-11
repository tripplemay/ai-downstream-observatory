import assert from "node:assert/strict";
import test from "node:test";
import { parseInvestorState, verifyInvestorReceipt } from "../src/components/workbench/investor-client";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import type { InvestorState } from "../src/server/investor/types";
import { investorActor as actor, investorFixture, investorNow as now, saveSyntheticProfile, seedSyntheticCandidate, syntheticProfile } from "./investor-fixture";

const binding = "a".repeat(64), currentTime = "2026-01-02T12:00:02.000Z";
test("client accepts verified empty, blocked, decision, observe and expired read models", () => {
  const f = investorFixture();
  try {
    for (const stage of ["empty", "blocked", "decision", "observe", "expired"]) {
      if (stage === "blocked") saveSyntheticProfile(f);
      if (stage === "decision") seedSyntheticCandidate(f);
      if (stage === "observe") seedSyntheticCandidate(f, "observe");
      const state = getInvestorState(f.db, actor, stage === "expired" ? "2026-01-06T12:00:00.000Z" : currentTime);
      assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    }
  } finally { f.close(); }
});

test("client rejects stale bindings, inconsistent histories, future facts and fictional current plans", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f); seedSyntheticCandidate(f);
    const original = getInvestorState(f.db, actor, currentTime);
    const changes: ((state: InvestorState) => void)[] = [
      state => { state.workspace_id = null; },
      state => { state.profile!.version++; },
      state => { state.latest!.document.profile_version++; },
      state => { state.observations[0].document.reasons = ["Different history"]; },
      state => { state.effective_gaps = [{ code: "GAP", title: "Gap", detail: "Gap", affected_markets: [], action: "Check" }]; },
      state => { state.plan = null; },
      state => { state.plan!.id = "other"; },
      state => { state.plan!.quality = "expired"; },
      state => { state.plan!.document.input_version = "b".repeat(64); },
      state => { state.profile_history[0].created_at = "2027-01-01T00:00:00.000Z"; },
      state => { state.effective_outcome = "observe"; },
      state => { state.effective_outcome = "insufficient_evidence"; },
      state => { state.actual_holdings_status = "confirmed" as never; },
      state => { state.live_advice_eligible = true as never; },
    ];
    for (const change of changes) {
      const state = JSON.parse(JSON.stringify(original)) as InvestorState; change(state);
      assert.throws(() => parseInvestorState({ ...state, session_binding: binding }, binding), /RESPONSE_INVALID/);
    }
    assert.throws(() => parseInvestorState({ ...original, session_binding: "b".repeat(64) }, binding), /RESPONSE_INVALID/);
    assert.throws(() => parseInvestorState({ ...original, session_binding: binding, actor_id: "owner" }, binding), /RESPONSE_INVALID/);
  } finally { f.close(); }
});

test("receipt verification binds the action, exact successor revision, workspace and session", () => {
  const f = investorFixture();
  try {
    const command = { action: "save_profile", expected_revision: 0, idempotency_key: "receipt", profile: syntheticProfile };
    const receipt = { ...executeInvestorCommand(f.db, actor, command, now), session_binding: binding };
    const pending = { body: JSON.stringify(command), binding, workspace: null };
    assert.deepEqual(verifyInvestorReceipt(receipt, pending), receipt);
    for (const extra of [{ session_binding: "b".repeat(64) }, { revision: 2 }, { action: "review" }, { execution_authorized: true }])
      assert.throws(() => verifyInvestorReceipt({ ...receipt, ...extra }, pending), /RESPONSE_INVALID/);
    assert.throws(() => verifyInvestorReceipt(receipt, { ...pending, workspace: "other" }), /RESPONSE_INVALID/);
  } finally { f.close(); }
});
