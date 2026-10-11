import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { canonical, hash } from "../src/server/ledger/service";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { observationSchema, referencePlanSchema, type InvestorProfile } from "../src/server/investor/schemas";

export const investorActor = { id: "synthetic-investor" };
export const investorNow = "2026-01-02T12:00:00.000Z";
export const syntheticProfile: InvestorProfile = { schema_version: "investor-profile-v1", horizon_years: 12,
  loss_tolerance: null, liquidity_need: "none_in_horizon", markets: ["CN", "HK", "US"],
  product_scope: "unleveraged_long_only_etfs", research_direction: "system_design", exclusions: [],
  illustrative_budget_cny: null, planned_annual_contribution_cny: null };
export function investorFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "etf-investor-synthetic-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename);
  const f = { db, directory, filename, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
  return f;
}
export function saveSyntheticProfile(f: ReturnType<typeof investorFixture>, actor = investorActor, profile = syntheticProfile) {
  return executeInvestorCommand(f.db, actor, { action: "save_profile", expected_revision: 0, idempotency_key: randomUUID(), profile }, investorNow);
}

// Direct SQL is restricted to tests: this exercises the read/review contract, not a real-data producer.
export function seedSyntheticCandidate(f: ReturnType<typeof investorFixture>, outcome: "observe" | "decision_required" = "decision_required", actor = investorActor,
  options: { validUntil?: string; nextReview?: string; inputVersion?: string; rowCreatedAt?: string; observationInputVersion?: string } = {}) {
  const state = getInvestorState(f.db, actor, "2026-01-02T12:00:02.000Z"), profile = state.profile!;
  const planId = randomUUID(), observationId = randomUUID(), inputVersion = options.inputVersion ?? hash({ fixture: "not-live-evidence", profile: profile.content_hash });
  const createdAt = "2026-01-02T12:00:01.000Z";
  const plan = referencePlanSchema.parse({ schema_version: "investor-reference-plan-v1", profile_id: profile.id,
    strategy_version: "synthetic-contract-only-v1", strategy_evidence: "Synthetic fixture, not validated research or a real portfolio",
    input_version: inputVersion, data_cutoff: "2026-01-01T08:00:00.000Z", created_at: createdAt,
    valid_until: options.validUntil ?? "2026-01-05T12:00:00.000Z", data_mode: "synthetic",
    targets: [{ listing_id: "synthetic-cn", symbol: "SYNTHETIC.CN", name: "Synthetic ETF A", market: "CN", currency: "CNY", weight: "0.6", role: "Synthetic role", overlap_summary: "Synthetic overlap" },
      { listing_id: "synthetic-us", symbol: "SYNTHETIC.US", name: "Synthetic ETF B", market: "US", currency: "USD", weight: "0.4", role: "Synthetic role", overlap_summary: "Synthetic overlap" }],
    estimated_cost: "Synthetic costs only", risk_scenarios: ["Synthetic loss scenario"], benchmark_summary: "Synthetic baseline only",
    counterarguments: ["Not investment evidence"], uncertainties: ["No real quotes used"], live_advice_eligible: false });
  f.db.prepare("INSERT INTO investor_reference_plans(id,workspace_id,profile_id,document_json,content_hash,created_at) VALUES(?,?,?,?,?,?)")
    .run(planId, state.workspace_id, profile.id, canonical(plan), hash(plan), options.rowCreatedAt ?? createdAt);
  const observation = observationSchema.parse({ schema_version: "investor-observation-v1", outcome, evaluated_at: createdAt,
    data_cutoff: plan.data_cutoff, profile_id: profile.id, profile_version: profile.version,
    input_version: options.observationInputVersion ?? inputVersion, gaps: [], reasons: ["Synthetic test observation only"],
    next_review_at: options.nextReview ?? "2026-01-04T12:00:00.000Z", next_conditions: ["Synthetic update"], monitoring: "active", scope: "research_model", live_advice_eligible: false });
  f.db.prepare("INSERT INTO investor_observations(id,workspace_id,profile_id,candidate_plan_id,outcome,document_json,content_hash,input_version,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(observationId, state.workspace_id, profile.id, planId, outcome, canonical(observation), hash(observation), observation.input_version, createdAt);
  return { planId, observationId, plan, observation };
}
