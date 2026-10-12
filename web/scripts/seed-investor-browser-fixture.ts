import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonical, hash } from "../src/server/ledger/service";
import { openWorkbench } from "../src/server/workbench-db";
import { getInvestorState } from "../src/server/investor/service";
import { observationSchema, referencePlanSchema } from "../src/server/investor/schemas";
import { computedBrowserObservation } from "./investor-model-fixture";

const [filename, mode] = process.argv.slice(2);
if (!filename || !["decision", "expired", "summary", "computed-observe", "computed-decision", "computed-stale"].includes(mode)) throw new Error("SYNTHETIC_BROWSER_MODE_REQUIRED");
const target = realpathSync(filename), temporary = realpathSync(os.tmpdir());
if (path.dirname(path.dirname(target)) !== temporary || !/^etf-browser-fixture-[A-Za-z0-9]+$/.test(path.basename(path.dirname(target)))
    || path.basename(target) !== "workbench.db") throw new Error("ONLY_TEMPORARY_BROWSER_FIXTURE_ALLOWED");
const db = openWorkbench(target);
try {
  if ((db.prepare("SELECT count(*) n FROM portfolios").get() as { n: number }).n !== 0) throw new Error("EMPTY_FINANCIAL_FIXTURE_REQUIRED");
  const now = new Date().toISOString(), state = getInvestorState(db, { id: "owner" }, now);
  if (mode !== "summary") {
    if (!state.profile) throw new Error("SYNTHETIC_UI_PROFILE_REQUIRED");
    const created = mode === "expired" ? new Date(Date.now() - 60000).toISOString() : now;
    const computed = mode.startsWith("computed-") ? computedBrowserObservation(state.profile, now, mode) : null;
    const plan = referencePlanSchema.parse({ schema_version: "investor-reference-plan-v1", profile_id: state.profile.id,
      strategy_version: "SYNTHETIC-BROWSER-CONTRACT-ONLY", strategy_evidence: "Synthetic fixture; not a real-data producer or investment evidence.",
      input_version: computed?.observation.input_version ?? hash({ synthetic_browser_fixture: true }), data_cutoff: computed?.observation.data_cutoff ?? created, created_at: created,
      valid_until: new Date(Date.now() + (mode === "expired" ? -1 : 86400000)).toISOString(), data_mode: "synthetic",
      targets: computed ? Object.entries(computed.weights).map(([listing_id, weight]) => ({ listing_id, weight, symbol: listing_id, name: "合成测试 " + listing_id,
        market: listing_id.slice(0, 2), currency: listing_id.startsWith("CN") ? "CNY" : listing_id.startsWith("HK") ? "HKD" : "USD",
        role: "Synthetic model fixture only", overlap_summary: "Not real issuer evidence" })) : [{ listing_id: "synthetic-a", symbol: "SYNTHETIC.A", name: "合成测试 ETF，不是真实方案", market: "CN", currency: "CNY", weight: "1",
        role: "Only tests the UI contract", overlap_summary: "Not a real holdings comparison" }],
      estimated_cost: "Synthetic cost fixture only", risk_scenarios: ["Synthetic scenario; not validated research"],
      benchmark_summary: "Synthetic baseline", counterarguments: ["Not investment evidence"], uncertainties: ["All fixture data is synthetic"], live_advice_eligible: false });
    const planId = randomUUID(), observationId = randomUUID();
    const observation = computed?.observation ?? observationSchema.parse({ schema_version: "investor-observation-v1", outcome: "decision_required",
      evaluated_at: now, data_cutoff: created, profile_id: state.profile.id, profile_version: state.profile.version,
      input_version: plan.input_version, gaps: [], reasons: ["Synthetic change card; tests human-review persistence, not a strategy result."],
      next_review_at: new Date(Date.now() + 86400000).toISOString(), next_conditions: ["Synthetic fixture update"],
      monitoring: "not_enabled", scope: "research_model", live_advice_eligible: false });
    db.transaction(() => {
      if (observation.outcome !== "insufficient_evidence") db.prepare("INSERT INTO investor_reference_plans(id,workspace_id,profile_id,document_json,content_hash,created_at) VALUES(?,?,?,?,?,?)")
        .run(planId, state.workspace_id, state.profile!.id, canonical(plan), hash(plan), created);
      db.prepare("INSERT INTO investor_observations(id,workspace_id,profile_id,candidate_plan_id,outcome,document_json,content_hash,input_version,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(observationId, state.workspace_id, state.profile!.id, observation.outcome === "insufficient_evidence" ? null : planId, observation.outcome, canonical(observation), hash(observation), observation.input_version, now);
    }).immediate();
  }
  const counts = Object.fromEntries(["portfolios", "accounts", "ledger_events", "approval_events", "activations", "reservations", "execution_reports", "investor_profiles", "investor_observations", "investor_decisions", "investor_plan_selections"]
    .map(table => [table, (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n]));
  console.log(JSON.stringify({ synthetic_fixture_only: true, mode, counts }));
} finally { db.close(); }
