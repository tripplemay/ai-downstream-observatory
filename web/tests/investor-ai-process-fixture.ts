import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkbench } from "../src/server/workbench-db";
import { readInvestorAiExplanation, explainInvestorObservation } from "../src/server/investor/ai-explanation";
import { runInvestorAiBackgroundPass } from "../src/server/investor/ai-explanation-background";
import { hash } from "../src/server/ledger/service";
import type { AiMonitorContext } from "../src/server/investor/ai-explanation-schemas";

async function main() {
  const [mode, filename, config_file, consent_file, now, observation_id, binding_hash] = process.argv.slice(2);
  const file = realpathSync(filename), parent = path.dirname(file);
  assert.equal(path.dirname(parent), realpathSync(os.tmpdir())); assert.ok(path.basename(parent).startsWith("etf-investor-synthetic-"));
  assert.equal(path.basename(file), "workbench.db");
  for (const value of [config_file, consent_file]) assert.equal(path.dirname(realpathSync(value)), parent);
  assert.ok(["read", "duplicate", "crash", "race", "background", "maintenance"].includes(mode));
  const db = openWorkbench(file); let calls = 0;
  try {
    const options = { config_file, consent_file, clock: () => now };
    const local = { ...options, transport: async (context: AiMonitorContext) => {
        calls++;
        if (mode === "crash") process.exit(73);
        if (mode === "race" || mode === "background") {
          const review = { schema_version: "ai-research-review-v1" as const, facts: context.evidence, inferences: [], supporting_evidence: [], counter_evidence: [], risks: [],
            recommendation: "maintain_research" as const, reason: "Fictional concurrent transport", unknowns: [], invalidation_conditions: [] };
          return { review, review_hash: hash(review), context_hash: hash(context), reported_model_hash: hash("fictional-model"), usage: null };
        }
        throw new Error("FICTIONAL_TRANSPORT_MUST_NOT_BE_INVOKED");
      } };
    if (mode === "background" || mode === "maintenance") {
      const value = await runInvestorAiBackgroundPass(db, { id: "synthetic-investor" }, mode === "background", local);
      console.log(JSON.stringify({ ...value, calls })); return;
    }
    const result = mode === "read" ? readInvestorAiExplanation(db, { id: "synthetic-investor" }, options)
      : await explainInvestorObservation(db, { id: "synthetic-investor" }, { observation_id, binding_hash }, local);
    console.log(JSON.stringify({ status: result.status, reason_code: result.reason_code, review_hash: result.review ? hash(result.review) : null, calls }));
  } finally { db.close(); }
}
void main();
