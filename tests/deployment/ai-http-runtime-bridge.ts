import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { openWorkbench } from "../../web/src/server/workbench-db";
import { canonical, hash } from "../../web/src/server/ledger/service";
import { executeInvestorCommand, getInvestorState } from "../../web/src/server/investor/service";

const directory = "/tmp/etf-investor-synthetic-ai-http-runtime", actor = { id: "owner" };
assert.equal(process.env.WORKBENCH_DB_PATH, path.join(directory, "workbench.db"));
const mode = process.argv[2], now = process.argv[3] ?? new Date().toISOString();
assert.ok(["init", "profile", "save", "inspect", "withdraw"].includes(mode));
if (mode === "init") {
  const config = { schema_version: "readonly-ai-gateway-config-v2", base_url: "https://ai-gateway/v1", api_key: "FICTIONAL_PRIVATE_KEY",
    model: "deepseek-flash", max_output_tokens: 1024, request_profile: "deepseek_non_thinking" };
  const consent = { schema_version: "investor-ai-sharing-consent-v1", principal_id: actor.id,
    gateway_audience_hash: hash({ base_url: config.base_url, model: config.model, request_profile: config.request_profile }), decision: "allow",
    allowed_categories: ["model_ratios", "target_deviation", "strategy_trigger_codes"], source: "explicit_user_confirmation",
    valid_from: new Date(Date.parse(now) - 60000).toISOString(), valid_until: new Date(Date.parse(now) + 86400000).toISOString() };
  for (const [name, value] of [["ai.json", config], ["consent.json", consent]] as const)
    writeFileSync(path.join(directory, name), canonical(value), { mode: 0o600, flag: "wx" });
  writeFileSync("/fixture-certs/ca-certificates.crt", Buffer.concat([
    readFileSync("/etc/ssl/certs/ca-certificates.crt"), readFileSync(path.join(directory, "support/gateway.pem")),
  ]), { mode: 0o644 });
  console.log(JSON.stringify({ status: "fictional_config_created" }));
} else if (mode === "withdraw") {
  const filename = path.join(directory, "consent.json"), consent = JSON.parse(readFileSync(filename, "utf8"));
  writeFileSync(filename, canonical({ ...consent, valid_until: now }), { mode: 0o600 });
  console.log(JSON.stringify({ status: "fictional_consent_expired" }));
} else {
  const db = openWorkbench();
  try {
    if (mode === "profile") executeInvestorCommand(db, actor, { action: "save_profile", expected_revision: 0, idempotency_key: randomUUID(),
      profile: { schema_version: "investor-profile-v1", horizon_years: 12, loss_tolerance: "0.30", liquidity_need: "none_in_horizon",
        markets: ["CN", "HK", "US"], product_scope: "unleveraged_long_only_etfs", research_direction: "system_design", exclusions: [],
        illustrative_budget_cny: null, planned_annual_contribution_cny: null } }, now);
    if (mode === "save") {
      const state = getInvestorState(db, actor, now);
      assert.ok(state.plan, JSON.stringify(state.research_task));
      executeInvestorCommand(db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision, idempotency_key: randomUUID() }, now);
    }
    const tables = ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"];
    const finance = Object.fromEntries(tables.map(table => [table, (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n]));
    assert.ok(Object.values(finance).every(n => n === 0));
    const protectedTables = ["investor_workspaces", "investor_profiles", "investor_observations", "investor_models", "investor_model_controls"];
    const protectedHash = hash(Object.fromEntries(protectedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
    const counts = Object.fromEntries(["investor_ai_requests", "investor_ai_dispatches", "investor_ai_outcomes", "investor_ai_payloads", "investor_ai_purges"]
      .map(table => [table, (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n]));
    console.log(JSON.stringify({ status: mode, finance, protected_hash: protectedHash, counts }));
  } finally { db.close(); }
}
