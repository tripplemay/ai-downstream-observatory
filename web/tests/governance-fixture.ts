import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { canonical, createAccount, createPortfolio, hash, recordFact, revision, type LedgerCommand } from "../src/server/ledger/service";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { reconcileAccount, RECONCILIATION_BALANCES } from "../src/server/ledger/reconciliation";
import { amount, exact } from "../src/server/ledger/decimal";
import { activatePolicy, approveAccountCapability, approveProposal, createPolicyVersion, createProposal, createStrategyVersion, type GovernanceActor } from "../src/server/governance/service";
import type { Policy, Strategy } from "../src/server/governance/schemas";
import { registerCompletedVerification } from "../src/server/governance/verification";
import { ledgerFactQualityAt } from "../src/server/ledger/fact-quality-db";

export const human: GovernanceActor = { id: "SYNTHETIC-HUMAN-ONLY", kind: "human" };
export const now = "2026-01-05T12:00:00.000Z";
export function governanceFixture(patch?: (policy: Policy) => void, positionQuantity = "0", cash = "100000", activate = true, currency = "CNY") {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "etf-governance-")), filename = path.join(dataDir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, human, "SYNTHETIC TEST - NOT LIVE AUTHORIZATION", now);
  const sourceManifest = { format_version: 1, application_ref: "SYNTHETIC-IN-MEMORY-VERIFIER-FIXTURE", files: Object.fromEntries(["web/src/server/governance/risk.ts", "web/src/server/ledger/engine.ts", "worker/market/valuation.py"].map(file => [file, createHash("sha256").update(readFileSync(path.resolve("..", file))).digest("hex")])) };
  const account = createAccount(db, human, portfolio, "Synthetic", "No actual broker", currency, now), options = { dataDir, now, releaseHash: hash(sourceManifest) };
  let counter = 0;
  const envelope = () => ({ portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `synthetic-${++counter}`, reason: "SYNTHETIC TEST DATA: does not certify real G/S readiness" });
  db.prepare("INSERT INTO instruments(id,name,asset_class,index_id,exposure_json,created_at) VALUES('i','Synthetic ETF','ETF','synthetic-index',?,?)").run(canonical({ region: "CN", sector: "broad" }), now);
  for (const id of ["l", "l2"]) db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,quantity_step,price_step,status,verified_at,created_at) VALUES(?,'i','CN','SSE',?,?,'100','0.01','active',?,?)").run(id, id, currency, now, now);
  const command = (fact: LedgerCommand["fact"], date = "2026-01-01"): LedgerCommand => ({ ...envelope(), source_id: "synthetic-broker", source_event_id: `fact-${counter}`, effective_at: date, time_precision: "date", source_timezone: "Asia/Shanghai", fact });
  recordFact(db, human, command({ type: "opening_cash", account_id: account, currency, amount: cash }), now);
  if (amount(positionQuantity).gt(0)) recordFact(db, human, command({ type: "opening_position", account_id: account, currency, listing_id: "l", quantity: positionQuantity, cost_amount: exact(amount(positionQuantity).mul(100)) }), now);
  const attach = (raw: unknown) => storeJsonAttachment(db, human, { portfolio_id: portfolio, account_id: account, raw: JSON.stringify(raw) }, options).id;
  const statement = { schema_version: 1, portfolio_id: portfolio, account_id: account, cutoff_at: "2026-01-04T00:00:00.000Z", coverage: { currencies: [currency], ledger_accounts: [...RECONCILIATION_BALANCES], positions_complete: true, balances_complete: true }, balances: RECONCILIATION_BALANCES.map(ledger_account => ({ currency, ledger_account, balance: ledger_account === "cash_settled" ? cash : "0" })), positions: amount(positionQuantity).gt(0) ? [{ listing_id: "l", currency, quantity: positionQuantity }] : [] };
  reconcileAccount(db, human, { portfolio_id: portfolio, account_id: account, expected_revision: revision(db, portfolio), attachment_id: attach(statement) }, options);
  const sourceEvidence = attach({ synthetic: true, fixture_purpose: "Permission and execution evidence only; not a live brokerage document" });
  approveAccountCapability(db, human, { ...envelope(), account_id: account, market: "CN", valid_until: "2026-02-01T00:00:00.000Z", attachment_id: sourceEvidence, rules: { listing_ids: ["l", "l2"], currencies: [currency], buy: true, sell: true, cash_holds_exclude_workbench_reservations: true, cash_holds_exclude_trade_payables: true } }, options);
  const publish = (sourceMode = "manual_verified", price = "100") => {
    const batchId = randomUUID(), manifest = hash({ batchId, sourceMode, price });
    db.prepare("INSERT INTO market_batches(id,source_id,batch_type,scope,status,expected_pages,validation_json,started_at) VALUES(?,'synthetic-fixture','prices','CN','staging',1,?,?)").run(batchId, canonical({ plan: { source_mode: sourceMode } }), now);
    for (const listing of ["l", "l2"]) for (const [metric, value, unit] of [["close", price, currency], ["spread_bps", "1", "bps"], ["premium_bps", "0", "bps"], ["turnover", "10000000", currency], ["volume", "100000", "shares"]]) {
      const id = randomUUID();
      db.prepare("INSERT INTO market_observations(id,batch_id,source_id,listing_id,series_key,metric,value,unit,observed_at,published_at,ingested_at,time_precision,price_basis,revision_id,raw_hash,parser_version,provenance) VALUES(?,?,'synthetic-fixture',?,?,?,?,?,'2026-01-05T00:00:00.000Z','2026-01-05T01:00:00.000Z','2026-01-05T01:00:00.000Z','second',?,?,?,'fixture','live_observed')")
        .run(id, batchId, listing, listing, metric, value, unit, metric === "close" ? "unadjusted" : "not_applicable", batchId, "a".repeat(64));
      db.prepare("INSERT INTO market_batch_members(batch_id,observation_id) VALUES(?,?)").run(batchId, id);
    }
    db.prepare("UPDATE market_batches SET status='validated',manifest_hash=? WHERE id=?").run(manifest, batchId);
    const next = (db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM market_publication_events WHERE scope='CN'").get() as { revision: number }).revision;
    const publication = { scope: "CN", batch_id: batchId, manifest_hash: manifest, revision: next, published_at: "2026-01-05T01:00:00.000Z" };
    db.prepare("INSERT INTO market_publication_events(scope,revision,batch_id,manifest_hash,published_at) VALUES('CN',?,?,?,?)").run(next, batchId, manifest, publication.published_at);
    db.prepare("INSERT INTO market_publications(scope,revision,batch_id,manifest_hash,published_at) VALUES('CN',?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,batch_id=excluded.batch_id,manifest_hash=excluded.manifest_hash,published_at=excluded.published_at").run(next, batchId, manifest, publication.published_at);
    return publication;
  };
  const publication = publish();
  const fxRate = currency === "CNY" ? "1" : "7", fxId = randomUUID(), fxBatch = randomUUID();
  const publications: Record<string, typeof publication> = { CN: publication };
  if (currency !== "CNY") {
    const manifest = hash({ fxBatch, currency, fxRate });
    db.prepare("INSERT INTO market_batches(id,source_id,batch_type,scope,status,expected_pages,validation_json,started_at) VALUES(?,'synthetic-fixture','fx','FX','staging',1,?,?)").run(fxBatch, canonical({ plan: { source_mode: "manual_verified", source_evidence: "Synthetic fixture only, not actual data verification" } }), now);
    db.prepare("INSERT INTO market_observations(id,batch_id,source_id,series_key,metric,value,unit,observed_at,published_at,ingested_at,time_precision,source_timezone,price_basis,revision_id,raw_hash,parser_version,provenance) VALUES(?,?,'synthetic-fixture',?,'fx_cny_per_unit',?,'CNY_per_unit_currency','2026-01-05T00:00:00.000Z','2026-01-05T01:00:00.000Z','2026-01-05T01:00:00.000Z','second','UTC','not_applicable',?,?,'fixture','live_observed')").run(fxId, fxBatch, `FX:${currency}`, fxRate, fxBatch, "a".repeat(64));
    db.prepare("INSERT INTO market_batch_members(batch_id,observation_id) VALUES(?,?)").run(fxBatch, fxId);
    db.prepare("UPDATE market_batches SET status='validated',manifest_hash=? WHERE id=?").run(manifest, fxBatch);
    publications.FX = { scope: "FX", batch_id: fxBatch, manifest_hash: manifest, revision: 1, published_at: publication.published_at };
    for (const table of ["market_publication_events", "market_publications"]) db.prepare(`INSERT INTO ${table}(scope,revision,batch_id,manifest_hash,published_at) VALUES('FX',1,?,?,?)`).run(fxBatch, manifest, publication.published_at);
  }
  const valuationRules = { schema_version: "valuation-rules-v1", approved: true, approval_evidence: "Synthetic fixture only; does not approve user valuation policy", price_scope_by_market: { CN: "CN" }, expected_sessions: { CN: "2026-01-05" }, corporate_actions_complete: { l: true, l2: true }, fx_scope: "FX", max_fx_age_seconds: 86400 };
  const valuationId = randomUUID(), nav = exact(amount(cash).add(amount(positionQuantity).mul(100)).mul(fxRate));
  const ledger_fact_quality = ledgerFactQualityAt(db, portfolio, "2026-01-05T02:00:00.000Z", now, "restated");
  db.prepare("INSERT INTO valuation_runs(id,portfolio_id,ledger_revision,market_manifest,method_version,cutoff_at,quality,nav_cny,created_at) VALUES(?,?,?,?,?,'2026-01-05T02:00:00.000Z','complete',?,?)").run(valuationId, portfolio, revision(db, portfolio), canonical({ schema_version: "valuation-input-v3", mode: "restated", rules: valuationRules, rules_hash: hash(valuationRules), publications, ledger_fact_quality }), "decimal-nav-cny-v4:restated", nav, now);
  const refs = { ledger_revision: revision(db, portfolio), ...(currency === "CNY" ? {} : { fx_observation_id: fxId }) };
  if (!amount(cash).isZero()) db.prepare("INSERT INTO valuation_items(id,run_id,account_id,item_type,currency,amount,fx_rate,value_cny,quality,evidence_json) VALUES(?,?,?,'cash_settled',?,?,?,?,'complete',?)").run(randomUUID(), valuationId, account, currency, cash, fxRate, exact(amount(cash).mul(fxRate)), canonical(refs));
  if (amount(positionQuantity).gt(0)) {
    const price = db.prepare("SELECT o.id FROM market_observations o JOIN market_batch_members m ON m.observation_id=o.id WHERE m.batch_id=? AND o.listing_id='l' AND o.metric='close'").get(publication.batch_id) as { id: string };
    db.prepare("INSERT INTO valuation_items(id,run_id,account_id,listing_id,item_type,currency,amount,fx_rate,value_cny,quality,evidence_json) VALUES(?,?,?,'l','security_market_value',?,?,?,?,'complete',?)").run(randomUUID(), valuationId, account, currency, exact(amount(positionQuantity).mul(100)), fxRate, exact(amount(positionQuantity).mul(100).mul(fxRate)), canonical({ ...refs, quantity: positionQuantity, price_observation_id: price.id }));
  }
  const policy: Policy = { schema_version: 1, mandate_version: "SYNTHETIC-v1", approved_decisions: ["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07", "D-08"], account_ids: [account], listing_ids: ["l", "l2"], allocation: { core: "0", strategy: "1", defensive: "0" }, limits: { listing_weight: "1", index_weight: "1", market_weight: "1", currency_weight: "1", region_weight: "1", sector_weight: "1", strategy_weight: "1", min_cash_weight: "0", max_order_cny: "1000000" }, execution: { proposal_ttl_seconds: 3600, max_price_age_seconds: 86400, max_valuation_age_seconds: 86400, max_reconciliation_age_seconds: 604800, price_buffer_bps: "0", max_price_deviation_bps: "100", fee_rate_bps: "0", max_fee_bps: "100", minimum_fee_by_currency: { CNY: "0" }, max_spread_bps: "10", max_premium_bps: "100", min_turnover: "1000000", max_participation: "0.1" }, price_scope_by_market: { CN: "CN" }, fx_scope: "FX", benchmark: "SYNTHETIC-CNY-BASELINE", evaluation_window: "Synthetic declared horizon", contribution_rule: "Only confirmed settled funds", emergency_rule: "Stop new advice and require human review", review_after: "2026-02-01T00:00:00.000Z", ai_mode: "not_required" };
  policy.execution.minimum_fee_by_currency = { [currency]: "0" };
  patch?.(policy);
  const policyVersion = createPolicyVersion(db, human, { ...envelope(), policy }, options);
  const strategy: Strategy = { schema_version: 1, strategy_key: "synthetic-manual", algorithm: "manual_target_v1", universe: ["l", "l2"], budget_weight: policy.limits.strategy_weight, evaluation_frequency: "monthly", benchmark: policy.benchmark, economic_rationale: "Synthetic policy-state-machine fixture, not investment evidence", invalidation_conditions: "Any input revision change", admission_thresholds: { min_out_of_sample_observations: 12, min_forward_observations: 6, min_trades: 3, max_drawdown: "0.2", min_net_excess_return: "0.01" } };
  const strategyVersion = createStrategyVersion(db, human, { ...envelope(), strategy }, options);
  const researchId = randomUUID();
  const admissionMetrics = { out_of_sample_observations: 12, forward_observations: 6, trades: 3, max_drawdown: "0.1", net_excess_return: "0.02" };
  db.prepare("INSERT INTO research_runs(id,portfolio_id,environment,strategy_version_id,policy_version_id,input_manifest,experiment_plan_json,status,result_json,created_at,completed_at) VALUES(?,?,'simulation',?,?,'{}','{}','succeeded',?,'2026-01-01T00:00:00.000Z','2026-01-04T00:00:00.000Z')").run(researchId, portfolio, strategyVersion.id, policyVersion.id, canonical({ admission_grade: "formal_verified", admission_metrics: admissionMetrics }));
  // These trusted-job rows are deliberately seeded only into this disposable test DB; no public API can create them.
  const seedVerification = (gate: "G-03" | "G-04", provenance = "authoritative", checkStatus = "pass") => {
    const requestId = randomUUID(), jobId = randomUUID();
    const request = { gate, policy_hash: policyVersion.content_hash, strategy_hash: strategyVersion.content_hash, source_manifest_hash: options.releaseHash };
    const manifest = { format_version: 1, ...request, portfolio_id: portfolio, suite_version: "SYNTHETIC-TEST-ONLY-v1", tool_version: process.version, environment: "actual", provenance, started_at: "2026-01-04T00:00:00.000Z", finished_at: "2026-01-05T00:00:00.000Z", checks: Array.from({ length: gate === "G-03" ? 32 : 10 }, (_, index) => ({ id: `${gate === "G-03" ? "E" : "S"}-${String(index + 1).padStart(2, "0")}`, status: checkStatus, artifact_hash: "b".repeat(64) })), ...(gate === "G-04" ? { research_run_id: researchId, metrics: admissionMetrics } : {}) };
    db.prepare("INSERT INTO command_requests(id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at) VALUES(?,?,'governance_verification',?,?,?,'system:governance-verifier',?)").run(requestId, portfolio, requestId, hash(request), canonical(request), now);
    db.prepare("INSERT INTO job_runs(id,command_request_id,job_type,scope,period,input_version,status,not_before,result_json,created_at,updated_at) VALUES(?,?,'governance_verification',?,?,'synthetic-v1','succeeded',?,?,?,?)").run(jobId, requestId, portfolio, jobId, now, canonical({ manifest_hash: hash(manifest), manifest, source_manifest: sourceManifest }), now, now);
    return registerCompletedVerification(db, jobId, now);
  };
  const verificationIds = { "G-03": seedVerification("G-03"), "G-04": seedVerification("G-04") };
  const gateDocument = (gate: "G-01" | "G-03" | "G-04") => ({ schema_version: 1, kind: "governance_gate_evidence", portfolio_id: portfolio, gate, policy_hash: policyVersion.content_hash, strategy_hash: strategyVersion.content_hash, source_mode: "manual_verified", reviewed_at: "2026-01-05T00:00:00.000Z", valid_until: "2026-02-01T00:00:00.000Z", checks: (gate === "G-01" ? ["D-01", "D-02", "D-03", "D-05"] : Array.from({ length: gate === "G-03" ? 32 : 10 }, (_, index) => `${gate === "G-03" ? "E" : "S"}-${String(index + 1).padStart(2, "0")}`)).map(id => ({ id, status: "pass", evidence: "SYNTHETIC TEST FIXTURE - NOT A REAL PASS CLAIM" })), ...(gate !== "G-01" ? { verification_ids: [verificationIds[gate]] } : {}), ...(gate === "G-04" ? { research_run_id: researchId, metrics: admissionMetrics } : {}) });
  const gates = { "G-01": attach(gateDocument("G-01")), "G-03": attach(gateDocument("G-03")), "G-04": attach(gateDocument("G-04")) };
  const activationCommand = () => ({ ...envelope(), policy_version_id: policyVersion.id, strategy_version_id: strategyVersion.id, valuation_id: valuationId, gate_attachments: gates });
  const activated = activate ? activatePolicy(db, human, activationCommand(), options) : undefined;
  const proposal = (quantity = "600", side: "buy" | "sell" = "buy", extra: Record<string, unknown> = {}) => createProposal(db, human, { ...envelope(), activation_id: activated!.id, valuation_id: valuationId, expires_at: "2026-01-05T12:30:00.000Z", items: [{ account_id: account, listing_id: "l", side, currency, quantity, limit_price: "100", estimated_fees: "0", ...extra }] }, options);
  const approvalCommand = (proposal: ReturnType<typeof createProposal>) => ({ ...envelope(), proposal_id: proposal.id, risk_run_id: proposal.risk.id, expected_input_hash: proposal.risk.input_hash });
  const approve = (p: ReturnType<typeof createProposal>) => approveProposal(db, human, approvalCommand(p), options);
  return { db, filename, dataDir, account, portfolio, options, envelope, command, attach, sourceEvidence, policy, policyVersion, strategy, strategyVersion, valuationId, gates, gateDocument, seedVerification, activationCommand, activated, proposal, approvalCommand, approve, publish, close: () => { db.close(); rmSync(dataDir, { force: true, recursive: true }); } };
}
