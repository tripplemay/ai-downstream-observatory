import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { investorFixture, investorActor as actor, saveSyntheticProfile, seedSyntheticCandidate } from "./investor-fixture";
import { audit, canonical, hash } from "../src/server/ledger/service";
import { aiLimitations, aiMonitorContextSchema, type AiMonitorContext } from "../src/server/investor/ai-explanation-schemas";
import { registerDurableAiRequest, claimDurableAiRequest, finishDurableAiRequest, purgeDurableAiScope, readDurableAiStatus, type AiRequestBinding } from "../src/server/investor/ai-explanation-store";

const now = "2026-01-03T12:00:00.000Z", later = "2026-01-03T12:00:45.000Z";
function fixture() {
  const f = investorFixture(); saveSyntheticProfile(f); const seed = seedSyntheticCandidate(f);
  const workspace = (f.db.prepare("SELECT id FROM investor_workspaces").get() as { id: string }).id;
  const context = aiMonitorContextSchema.parse({ schema_version: "ai-monitor-context-v1", deterministic_outcome: "observe", evaluated_at: now,
    evidence: [{ evidence_id: "derived:max_abs_target_gap", metric: "model.max_abs_target_gap", value: "0.01", as_of: now },
      { evidence_id: "derived:target_change_count", metric: "model.target_change_count", value: "0", as_of: now }],
    trigger_codes: ["FIXED_POLICY_WITHIN_CLASS_BANDS"], limitations: aiLimitations, strategy_gates: { investment_gate_passed: false, live_advice_eligible: false } });
  const binding: AiRequestBinding = { workspace_id: workspace, actor_id: actor.id, observation_id: seed.observationId, source_binding_hash: hash("fictional-source"),
    context_hash: hash(context), config_hash: hash("fictional-config"), consent_hash: hash("fictional-consent"), implementation_hash: hash("fictional-implementation"),
    binding_hash: "", valid_until: "2026-01-04T12:00:00.000Z" };
  binding.binding_hash = key(binding);
  return { ...f, binding, context };
}
function key(binding: AiRequestBinding) {
  return hash({ binding: binding.source_binding_hash, context: binding.context_hash, config: binding.config_hash,
    consent: binding.consent_hash, implementation: binding.implementation_hash, valid_until: binding.valid_until });
}
function review(context: AiMonitorContext) {
  return { schema_version: "ai-research-review-v1" as const, facts: context.evidence, inferences: [], supporting_evidence: [], counter_evidence: [], risks: [],
    recommendation: "maintain_research" as const, reason: "Fictional storage component only; not qualified real research", unknowns: [], invalidation_conditions: [] };
}
function finance(f: ReturnType<typeof fixture>) {
  return hash(Object.fromEntries(["portfolios", "accounts", "ledger_events", "postings", "approval_events", "activations", "reservations", "execution_reports"]
    .map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}
test("durable claim is irreversible and terminal evidence reads do not change finance or workspace", () => {
  const f = fixture();
  try {
    const before = finance(f), revision = f.db.prepare("SELECT revision FROM investor_workspaces").get();
    assert.equal(readDurableAiStatus(f.db, f.binding, f.context, now), null);
    const claim = claimDurableAiRequest(f.db, f.binding, now)!; assert.ok(claim);
    assert.equal(claimDurableAiRequest(f.db, f.binding, now), null);
    assert.equal(readDurableAiStatus(f.db, f.binding, f.context, now)?.status, "running");
    finishDurableAiRequest(f.db, f.binding, claim, f.context, now, review(f.context), null);
    assert.equal(readDurableAiStatus(f.db, f.binding, f.context, now)?.status, "complete");
    assert.throws(() => finishDurableAiRequest(f.db, f.binding, claim, f.context, now, review(f.context), null));
    assert.equal(finance(f), before); assert.deepEqual(f.db.prepare("SELECT revision FROM investor_workspaces").get(), revision);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_dispatches").get() as { n: number }).n, 1);
    for (const table of ["investor_ai_requests", "investor_ai_dispatches", "investor_ai_outcomes", "investor_ai_payloads"])
      assert.throws(() => f.db.exec(`DELETE FROM ${table}`));
  } finally { f.close(); }
});
test("missing completion after the dispatch deadline stays unknown and never becomes a new claim", () => {
  const f = fixture();
  try {
    const claim = claimDurableAiRequest(f.db, f.binding, now)!;
    assert.equal(readDurableAiStatus(f.db, f.binding, f.context, later)?.reason_code, "INVESTOR_AI_OUTCOME_UNKNOWN");
    assert.equal(claimDurableAiRequest(f.db, f.binding, later), null);
    assert.equal(finishDurableAiRequest(f.db, f.binding, claim, f.context, later, review(f.context), null), "unknown");
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_payloads").get() as { n: number }).n, 0);
  } finally { f.close(); }
});
test("scope and fence mismatches cannot publish; changed evidence cannot be resealed into a supported response", () => {
  const f = fixture();
  try {
    assert.throws(() => claimDurableAiRequest(f.db, { ...f.binding, actor_id: "foreign" }, now));
    const claim = claimDurableAiRequest(f.db, f.binding, now)!;
    assert.throws(() => finishDurableAiRequest(f.db, f.binding, { ...claim, token: "b".repeat(48) }, f.context, now, review(f.context), null));
    const altered = structuredClone(review(f.context)); altered.facts[0].value = "0.99";
    assert.throws(() => finishDurableAiRequest(f.db, f.binding, claim, f.context, now, altered, null));
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_outcomes").get() as { n: number }).n, 0);
  } finally { f.close(); }
});
test("purge physically removes text, keeps deduplication tombstones and fences a late successful result", () => {
  const f = fixture();
  try {
    const claim = claimDurableAiRequest(f.db, f.binding, now)!;
    assert.equal(purgeDurableAiScope(f.db, { id: "foreign" }, now, null), 0);
    assert.equal(purgeDurableAiScope(f.db, actor, now, null), 1);
    assert.equal(finishDurableAiRequest(f.db, f.binding, claim, f.context, now, review(f.context), null), "failed");
    assert.equal(readDurableAiStatus(f.db, f.binding, f.context, now)?.reason_code, "INVESTOR_AI_RESULT_PURGED");
    assert.equal(claimDurableAiRequest(f.db, f.binding, now), null);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_payloads").get() as { n: number }).n, 0);
    assert.throws(() => f.db.exec("DELETE FROM investor_ai_purges"));
  } finally { f.close(); }
  const complete = fixture();
  try {
    const claim = claimDurableAiRequest(complete.db, complete.binding, now)!;
    finishDurableAiRequest(complete.db, complete.binding, claim, complete.context, now, review(complete.context), null);
    assert.equal(purgeDurableAiScope(complete.db, actor, complete.binding.valid_until, complete.binding.binding_hash), 1);
    assert.equal((complete.db.prepare("SELECT count(*) n FROM investor_ai_payloads").get() as { n: number }).n, 0);
    assert.throws(() => complete.db.prepare("INSERT INTO investor_ai_payloads VALUES(?,?)").run(claim.id, Buffer.from(JSON.stringify(review(complete.context)))));
  } finally { complete.close(); }
});
test("a second binding in the same workspace cannot bypass an active durable dispatch", () => {
  const f = fixture();
  try {
    claimDurableAiRequest(f.db, f.binding, now);
    const alternate = { ...f.binding, config_hash: hash("alternate") }; alternate.binding_hash = key(alternate);
    assert.throws(() => claimDurableAiRequest(f.db, alternate, now), /INVESTOR_AI_BUSY/);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_requests").get() as { n: number }).n, 1);
  } finally { f.close(); }
});

test("global two-call bound is serialized in both the store and SQL trigger", () => {
  const f = fixture();
  try {
    claimDurableAiRequest(f.db, f.binding, now);
    const bind = (id: string) => {
      const alternateActor = { id }; saveSyntheticProfile(f, alternateActor);
      const seed = seedSyntheticCandidate(f, "decision_required", alternateActor);
      const workspace = (f.db.prepare("SELECT id FROM investor_workspaces WHERE owner_id=?").get(id) as { id: string }).id;
      const binding = { ...f.binding, workspace_id: workspace, actor_id: id, observation_id: seed.observationId }; binding.binding_hash = key(binding);
      return binding;
    };
    const second = bind("fictional-second-owner"), third = bind("fictional-third-owner");
    claimDurableAiRequest(f.db, second, now);
    assert.throws(() => claimDurableAiRequest(f.db, third, now), /INVESTOR_AI_BUSY/);
    assert.throws(() => f.db.transaction(() => {
      const request = { ...third, schema_version: "investor-ai-request-v1", id: randomUUID(), created_at: now };
      const event = audit(f.db, { id: third.actor_id }, "investor_ai_request", "investor_ai_request", request.id, null, null, { content_hash: hash(request) }, now);
      f.db.prepare("INSERT INTO investor_ai_requests VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(request.id, request.workspace_id, request.observation_id, request.actor_id, request.binding_hash, canonical(request), hash(request), now, request.valid_until, event);
      const token = "a".repeat(48), event2 = audit(f.db, { id: third.actor_id }, "investor_ai_dispatch", "investor_ai_request", request.id, null, null, { token, deadline: later }, now);
      f.db.prepare("INSERT INTO investor_ai_dispatches VALUES(?,?,?,?,?)").run(request.id, token, now, later, event2);
    }).immediate(), /AI dispatch binding differs/);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_requests").get() as { n: number }).n, 2);
  } finally { f.close(); }
});

test("recovery lock prevents new dispatch, completion and purge without disturbing retained metadata", () => {
  const f = fixture();
  try {
    const claim = claimDurableAiRequest(f.db, f.binding, now)!;
    const before = hash(f.db.prepare("SELECT * FROM investor_ai_requests").all());
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Fictional recovery lock\n", { mode: 0o600 });
    assert.throws(() => claimDurableAiRequest(f.db, f.binding, now), /WORKBENCH_READ_ONLY/);
    assert.throws(() => registerDurableAiRequest(f.db, f.binding, now), /WORKBENCH_READ_ONLY/);
    assert.throws(() => finishDurableAiRequest(f.db, f.binding, claim, f.context, now, review(f.context), null), /WORKBENCH_READ_ONLY/);
    assert.throws(() => purgeDurableAiScope(f.db, actor, now, null), /WORKBENCH_READ_ONLY/);
    assert.equal(hash(f.db.prepare("SELECT * FROM investor_ai_requests").all()), before);
    assert.equal(readDurableAiStatus(f.db, f.binding, f.context, now)?.status, "running");
  } finally { f.close(); }
});

test("64 pending intents are bounded in the store and SQL; purged queued intent cannot dispatch", () => {
  const f = fixture();
  try {
    const alternate = (n: number) => { const b = { ...f.binding, config_hash: hash({ fictional: n }) }; b.binding_hash = key(b); return b; };
    const ids = Array.from({ length: 64 }, (_, n) => registerDurableAiRequest(f.db, alternate(n), now));
    assert.equal(readDurableAiStatus(f.db, alternate(0), f.context, now)?.status, "queued");
    assert.equal(registerDurableAiRequest(f.db, alternate(0), now), ids[0]);
    assert.throws(() => registerDurableAiRequest(f.db, alternate(64), now), /INVESTOR_AI_BUSY/);
    assert.throws(() => f.db.transaction(() => {
      const request = { ...alternate(64), schema_version: "investor-ai-request-v1", id: randomUUID(), created_at: now };
      const event = audit(f.db, actor, "investor_ai_request", "investor_ai_request", request.id, null, null, { content_hash: hash(request) }, now);
      f.db.prepare("INSERT INTO investor_ai_requests VALUES(?,?,?,?,?,?,?,?,?,?)").run(request.id, request.workspace_id, request.observation_id,
        request.actor_id, request.binding_hash, canonical(request), hash(request), now, request.valid_until, event);
    }).immediate(), /AI pending capacity exceeded/);
    assert.equal(purgeDurableAiScope(f.db, actor, now, null), 64);
    assert.equal(claimDurableAiRequest(f.db, alternate(0), now), null);
    assert.throws(() => f.db.transaction(() => {
      const token = "c".repeat(48), event = audit(f.db, actor, "investor_ai_dispatch", "investor_ai_request", ids[0], null, null, { token, deadline: later }, now);
      f.db.prepare("INSERT INTO investor_ai_dispatches VALUES(?,?,?,?,?)").run(ids[0], token, now, later, event);
    }).immediate(), /AI purged intent cannot dispatch/);
    assert.ok(registerDurableAiRequest(f.db, alternate(64), now));
  } finally { f.close(); }
});

test("64 retained payloads reject another dispatch until previous text is purged", () => {
  const f = fixture();
  try {
    const alternate = (n: number) => { const b = { ...f.binding, config_hash: hash({ fictional: n }) }; b.binding_hash = key(b); return b; };
    for (let n = 0; n < 64; n++) {
      const b = alternate(n), claim = claimDurableAiRequest(f.db, b, now)!;
      finishDurableAiRequest(f.db, b, claim, f.context, now, review(f.context), null);
    }
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_payloads").get() as { n: number }).n, 64);
    assert.throws(() => claimDurableAiRequest(f.db, alternate(64), now), /INVESTOR_AI_BUSY/);
    assert.equal(purgeDurableAiScope(f.db, actor, now, alternate(63).binding_hash), 63);
    assert.ok(claimDurableAiRequest(f.db, alternate(64), now));
  } finally { f.close(); }
});
