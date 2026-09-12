import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createPortfolio, createAccount, recordFact, hash } from "../src/server/ledger/service";
import { workbenchState } from "../src/server/ledger/queries";
import { enqueueWorkbenchTask, registerListing } from "../src/server/workbench-commands";
import { ledgerFactQualityAt } from "../src/server/ledger/fact-quality-db";

const actor = { id: "synthetic-owner" };
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "etf-commands-"));
  const filename = path.join(dir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic");
  const base = { portfolio_id: portfolio, expected_revision: 0, idempotency_key: "synthetic-command" };
  return { db, dir, portfolio, base, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const rules = { schema_version: "valuation-rules-v1", approved: false, price_scope_by_market: {}, expected_sessions: {}, corporate_actions_complete: {}, max_fx_age_seconds: 0 };
const valuation = { command_type: "valuation", payload: { cutoff_at: "2026-01-01T00:00:00Z", rules } };

test("registering a listing records evidence but never grants trading access", () => {
  const f = fixture();
  try {
    const input = { ...f.base, name: "Synthetic ETF", market: "US", exchange: "SYNTH", ticker: "TEST", currency: "USD", asset_class: "equity", quantity_step: "1", source_evidence: "Synthetic fixture" };
    const receipt = registerListing(f.db, actor, input);
    assert.equal(receipt.status, "unverified");
    assert.deepEqual(registerListing(f.db, actor, input), receipt);
    assert.throws(() => registerListing(f.db, actor, { ...input, name: "Changed" }), /DUPLICATE_CONFLICT/);
    assert.equal(workbenchState(f.db, actor, f.portfolio).listings[0].id, receipt.listing_id);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM account_capabilities").get() as { n: number }).n, 0);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM ledger_events").get() as { n: number }).n, 0);
    assert.throws(() => registerListing(f.db, actor, { ...input, idempotency_key: "other" }), /LISTING_ALREADY_EXISTS/);
    assert.throws(() => registerListing(f.db, actor, { ...input, idempotency_key: "zero-step", ticker: "ZERO", quantity_step: "0" }));
  } finally { f.close(); }
});

test("worker requests have canonical payload hash and authenticated immutable context", () => {
  const f = fixture();
  try {
    const input = { ...f.base, ...valuation };
    const receipt = enqueueWorkbenchTask(f.db, actor, input);
    assert.deepEqual(enqueueWorkbenchTask(f.db, actor, input), receipt);
    assert.equal(receipt.payload_hash, hash(valuation.payload));
    const row = f.db.prepare("SELECT * FROM command_requests").get() as { actor_id: string; payload_json: string };
    assert.equal(row.actor_id, actor.id);
    assert.deepEqual(JSON.parse(row.payload_json), valuation.payload);
    assert.equal(workbenchState(f.db, actor, f.portfolio).tasks[0].status, "queued");
    assert.equal(workbenchState(f.db, actor, f.portfolio).advice_status, "blocked");
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...input, actor_id: "ai" }));
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...input, payload: { ...valuation.payload, mode: "restated" } }), /DUPLICATE_CONFLICT/);
  } finally { f.close(); }
});

test("unsupported jobs, malformed evidence, future valuation and unknown fields are refused", () => {
  const f = fixture();
  try {
    for (const extra of [
      { command_type: "place_order", payload: {} },
      { command_type: "market_ingest", payload: { document: {}, publish: true } },
      { command_type: "valuation", payload: { ...valuation.payload, rules: { ...rules, approved: true } } },
      { command_type: "valuation", payload: { ...valuation.payload, cutoff_at: "2099-01-01T00:00:00Z" } },
      { command_type: "valuation", payload: { ...valuation.payload, bypass: true } },
    ]) assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...f.base, ...extra }));
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM command_requests").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test("stale revisions, scope, missing actor and restore freeze prevent task writes", () => {
  const f = fixture();
  try {
    const input = { ...f.base, ...valuation };
    assert.throws(() => enqueueWorkbenchTask(f.db, { id: "" }, input), /UNAUTHENTICATED/);
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...input, portfolio_id: "missing" }), /PORTFOLIO_NOT_FOUND/);
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...input, expected_revision: 1 }), /VERSION_CONFLICT/);
    writeFileSync(path.join(f.dir, "RESTORE_PENDING_REVIEW"), "Synthetic\n");
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, input), /WORKBENCH_READ_ONLY/);
  } finally { f.close(); }
});

test("new facts mark previous valuation stale and do not expose another portfolio tasks", () => {
  const f = fixture();
  try {
    enqueueWorkbenchTask(f.db, actor, { ...f.base, ...valuation });
    const other = createPortfolio(f.db, actor, "Other");
    assert.deepEqual(workbenchState(f.db, actor, other).tasks, []);
    const account = createAccount(f.db, actor, f.portfolio, "Synthetic", "Synthetic", "CNY");
    const valuationRules = { ...rules, approved: true, approval_evidence: "Synthetic zero cash snapshot" };
    recordFact(f.db, actor, { ...f.base, idempotency_key: "synthetic-opening", source_id: "synthetic", source_event_id: "opening", effective_at: "2025-12-31T00:00:00Z", time_precision: "second", source_timezone: "UTC", reason: "Synthetic zero opening", fact: { type: "opening_cash", account_id: account, currency: "CNY", amount: "0" } }, "2025-12-31T00:00:00Z");
    const ledger_fact_quality = ledgerFactQualityAt(f.db, f.portfolio, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "as_known");
    const manifest = { schema_version: "valuation-input-v3", mode: "as_known", rules: valuationRules, rules_hash: hash(valuationRules), publications: {}, ledger_fact_quality };
    f.db.prepare("INSERT INTO valuation_runs(id,portfolio_id,ledger_revision,market_manifest,method_version,cutoff_at,quality,nav_cny,created_at) VALUES('v',?,1,?, 'decimal-nav-cny-v4:as_known','2026-01-01T00:00:00Z','complete','0','2026-01-01T00:00:00Z')").run(f.portfolio, JSON.stringify(manifest));
    assert.equal(workbenchState(f.db, actor, f.portfolio).valuation_status, "complete");
    recordFact(f.db, actor, { ...f.base, expected_revision: 1, source_id: "synthetic", source_event_id: "cash", effective_at: "2026-01-01", time_precision: "date", source_timezone: "UTC", reason: "Synthetic", fact: { type: "deposit", account_id: account, currency: "CNY", amount: "1" } });
    assert.equal(workbenchState(f.db, actor, f.portfolio).valuation_status, "stale");
  } finally { f.close(); }
});

test("performance requests accept explicit FX quality rules but never client-selected conversion values", () => {
  const f = fixture();
  try {
    for (const [id, date] of [["flow-start", "2026-01-01T00:00:00Z"], ["flow-end", "2026-01-02T00:00:00Z"]]) f.db.prepare("INSERT INTO valuation_runs(id,portfolio_id,ledger_revision,market_manifest,method_version,cutoff_at,quality,nav_cny,created_at) VALUES(?,?,0,'{}','decimal-nav-cny-v2:as_known',?,'blocked',NULL,'2026-01-01T00:00:00Z')").run(id, f.portfolio, date);
    const flowRules = { schema_version: "flow-fx-rules-v1", approved: true, approval_evidence: "SYNTHETIC quality rules only", fx_scope: "FX", max_fx_age_seconds: 60, time_policy: "event_second_strict" };
    const payload = { valuation_ids: ["flow-start", "flow-end"], evaluation_timezone: "UTC", flow_fx_rules: flowRules };
    const input = { ...f.base, command_type: "performance", payload };
    const receipt = enqueueWorkbenchTask(f.db, actor, input);
    assert.deepEqual(enqueueWorkbenchTask(f.db, actor, input), receipt);
    const stored = f.db.prepare("SELECT payload_json,actor_id FROM command_requests WHERE id=?").get(receipt.request_id) as { payload_json: string; actor_id: string };
    assert.deepEqual(JSON.parse(stored.payload_json), payload);
    assert.equal(stored.actor_id, actor.id);
    for (const patch of [
      { fx_rate: "7" }, { observation_id: "arbitrary-price" }, { amount_cny: "700" },
      { time_policy: "use_period_end_rate" }, { max_fx_age_seconds: -1 },
      { approved: true, approval_evidence: "" },
    ]) assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...input, idempotency_key: "invalid-rule", payload: { ...payload, flow_fx_rules: { ...flowRules, ...patch } } }), /INVALID_PERFORMANCE_COMMAND/);
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...input, idempotency_key: "forged-evidence", payload: { ...payload, external_flow_evidence: [] } }), /INVALID_PERFORMANCE_COMMAND/);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM ledger_events").get() as { n: number }).n, 0);
  } finally { f.close(); }
});
