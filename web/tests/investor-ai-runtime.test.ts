import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { aiSourceFiles } from "../../scripts/ai-explanation-source.mjs";
import { investorActor, investorFixture, saveSyntheticProfile, seedSyntheticCandidate } from "./investor-fixture";
import { hash } from "../src/server/ledger/service";
import { aiLimitations, aiMonitorContextSchema } from "../src/server/investor/ai-explanation-schemas";
import { claimDurableAiRequest, finishDurableAiRequest, type AiRequestBinding } from "../src/server/investor/ai-explanation-store";

test("built launcher verifies the complete source map and rejects tampered bundle, source or arbitrary CLI input", () => {
  const root = path.resolve(".."), directory = mkdtempSync(path.join(os.tmpdir(), "etf-ai-runtime-proof-"));
  try {
    const sources = aiSourceFiles(root);
    for (const name of [...Object.keys(sources), "web/dist/ai-explanation.mjs", "web/dist/ai-explanation.manifest.json"]) {
      const file = path.join(directory, name); mkdirSync(path.dirname(file), { recursive: true }); cpSync(path.join(root, name), file);
    }
    const command = (args: string[]) => spawnSync(process.execPath, [path.join(directory, "web/scripts/run-ai-explanation.mjs"), ...args], { encoding: "utf8", timeout: 20000 });
    assert.equal(command(["--check"]).status, 0);
    const bundle = path.join(directory, "web/dist/ai-explanation.mjs"), original = readFileSync(bundle);
    writeFileSync(bundle, Buffer.concat([original, Buffer.from("\n")]));
    const changed = command(["--check"]); assert.equal(changed.status, 1); assert.equal(changed.stderr, "AI_RUNTIME_UNAVAILABLE\n");
    writeFileSync(bundle, original);
    const source = path.join(directory, "worker/ai_explanation/context.py"); writeFileSync(source, "# Fictional source tampering\n");
    assert.equal(command(["--check"]).status, 1);
    cpSync(path.join(root, "worker/ai_explanation/context.py"), source);
    // Bad CLI input is refused before it can open a database or execute a caller-selected command.
    const actual = spawnSync(process.execPath, ["scripts/run-ai-explanation.mjs", "--db", "/arbitrary"], { encoding: "utf8", timeout: 20000 });
    assert.equal(actual.status, 1); assert.equal(actual.stderr, "AI_RUNTIME_UNAVAILABLE\n");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the real fixed-owner executable clears an expired stored payload at startup with dispatch disabled", () => {
  const f = investorFixture(), actor = { id: "owner" }, now = "2026-01-03T12:00:00.000Z";
  try {
    assert.notEqual(actor.id, investorActor.id); saveSyntheticProfile(f, actor); const seed = seedSyntheticCandidate(f, "observe", actor);
    const workspace = (f.db.prepare("SELECT id FROM investor_workspaces WHERE owner_id=?").get(actor.id) as { id: string }).id;
    const context = aiMonitorContextSchema.parse({ schema_version: "ai-monitor-context-v1", deterministic_outcome: "observe", evaluated_at: now,
      evidence: [{ evidence_id: "derived:max_abs_target_gap", metric: "model.max_abs_target_gap", value: "0", as_of: now },
        { evidence_id: "derived:target_change_count", metric: "model.target_change_count", value: "0", as_of: now }],
      trigger_codes: ["FIXED_POLICY_WITHIN_CLASS_BANDS"], limitations: aiLimitations, strategy_gates: { investment_gate_passed: false, live_advice_eligible: false } });
    const b: AiRequestBinding = { workspace_id: workspace, actor_id: actor.id, observation_id: seed.observationId, source_binding_hash: hash("fictional-source"),
      context_hash: hash(context), config_hash: hash("fictional-config"), consent_hash: hash("fictional-consent"), implementation_hash: hash("fictional-implementation"),
      binding_hash: "", valid_until: "2026-01-04T12:00:00.000Z" };
    b.binding_hash = hash({ binding: b.source_binding_hash, context: b.context_hash, config: b.config_hash, consent: b.consent_hash,
      implementation: b.implementation_hash, valid_until: b.valid_until });
    const claim = claimDurableAiRequest(f.db, b, now)!;
    const review = { schema_version: "ai-research-review-v1" as const, facts: context.evidence, inferences: [], supporting_evidence: [], counter_evidence: [], risks: [],
      recommendation: "maintain_research" as const, reason: "Fictional executable retention component, not qualified research", unknowns: [], invalidation_conditions: [] };
    finishDurableAiRequest(f.db, b, claim, context, now, review, null);
    const rows = () => (f.db.prepare("SELECT count(*) n FROM investor_ai_payloads").get() as { n: number }).n;
    assert.equal(rows(), 1);
    const child = spawnSync(process.execPath, ["scripts/run-ai-explanation.mjs", "--once"], { encoding: "utf8", timeout: 60000,
      env: { ...process.env, WORKBENCH_DB_PATH: f.filename, WORKBENCH_DATA_DIR: f.directory, WORKBENCH_MODE: "ledger",
        WORKBENCH_AI_ENABLE_DISPATCH: "0", WORKBENCH_AI_CONFIG_FILE: "", WORKBENCH_AI_CONSENT_FILE: "", WORKBENCH_AI_PYTHON: "/no-ai-transport" } });
    assert.equal(child.status, 0, child.stderr); assert.equal(rows(), 0);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_dispatches").get() as { n: number }).n, 1);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_ai_outcomes").get() as { n: number }).n, 1);
  } finally { f.close(); }
});
