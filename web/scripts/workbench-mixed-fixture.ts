import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { canonical, createAccount, createPortfolio, hash, recordFact, revision, type LedgerCommand } from "../src/server/ledger/service";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { reconcileAccount, RECONCILIATION_BALANCES } from "../src/server/ledger/reconciliation";
import { addCatalogEntry, catalogRevision } from "../src/server/catalog/service";
import { storeMarketReferenceSource } from "../src/server/market-references/service";
import { publishListingReview } from "../src/server/listing-reviews/service";
import { approveAccountCapability, createPolicyVersion, createStrategyVersion } from "../src/server/governance/service";
import { registerCompletedVerification } from "../src/server/governance/verification";
import { registerListing } from "../src/server/workbench-commands";
import type { Policy, Strategy } from "../src/server/governance/schemas";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const human = { id: "owner", kind: "human" as const };
const notice = "SYNTHETIC MIXED BENCHMARK ONLY: not real gate evidence, market verification or investment permission";
const utc6 = (value: string) => value.replace(/\.(\d{3})Z$/, (_, milliseconds: string) => `.${milliseconds}000Z`);
const integer = (value: number, minimum: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("MIXED_FIXTURE_INVALID_SIZE");
  return value;
};
const within = (parent: string, child: string) => { const relative = path.relative(parent, child); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

export interface MixedFixtureOptions { filename: string; dataDir: string; now?: string; history?: number; listings?: number; marketRows?: number }

/** Only a fresh disposable temp database. Normal operations below retain their real audit and ledger semantics. */
export function createWorkbenchMixedFixture(input: MixedFixtureOptions) {
  const history = integer(input.history ?? 50000, 6, 50000), listingCount = integer(input.listings ?? 1000, 2, 1000);
  const marketRows = integer(input.marketRows ?? 2000000, 0, 2000000);
  const now = input.now ?? new Date().toISOString();
  if (new Date(now).toISOString() !== now || Math.abs(Date.now() - Date.parse(now)) > 60000) throw new Error("MIXED_FIXTURE_CURRENT_CLOCK_REQUIRED");
  if (!path.isAbsolute(input.filename) || !path.isAbsolute(input.dataDir)) throw new Error("MIXED_FIXTURE_TEMP_PATH_REQUIRED");
  const directory = realpathSync(path.dirname(input.filename));
  const tempRoots = [...new Set([realpathSync(tmpdir()), realpathSync("/tmp")])];
  if (!tempRoots.some(parent => within(parent, directory))) throw new Error("MIXED_FIXTURE_TEMP_PATH_REQUIRED");
  const filename = path.join(directory, path.basename(input.filename));
  if (existsSync(filename) || existsSync(`${filename}-wal`) || existsSync(`${filename}-shm`)) throw new Error("MIXED_FIXTURE_FRESH_DATABASE_REQUIRED");
  const suppliedDirectory = path.dirname(path.resolve(input.filename));
  if (!within(suppliedDirectory, path.resolve(input.dataDir))) throw new Error("MIXED_FIXTURE_TEMP_PATH_REQUIRED");
  const dataDir = path.join(directory, path.relative(suppliedDirectory, path.resolve(input.dataDir)));
  let ancestor = directory;
  for (const part of path.relative(directory, dataDir).split(path.sep)) {
    ancestor = path.join(ancestor, part);
    if (existsSync(ancestor) && (lstatSync(ancestor).isSymbolicLink() || !lstatSync(ancestor).isDirectory())) throw new Error("MIXED_FIXTURE_TEMP_PATH_REQUIRED");
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (lstatSync(dataDir).isSymbolicLink() || !within(directory, realpathSync(dataDir))) throw new Error("MIXED_FIXTURE_TEMP_PATH_REQUIRED");
  closeSync(openSync(filename, "wx", 0o600));
  const migration = migrateWorkbench(filename), db = openWorkbench(filename);
  const at = new Date(Date.parse(now) - 300000).toISOString(), observedAt = new Date(Date.parse(now) - 120000).toISOString();
  const effectiveDate = new Date(Date.parse(now) - 86400000).toISOString().slice(0, 10);
  const validUntil = new Date(Date.parse(now) + 86400000).toISOString();
  const options = { dataDir, now: at };
  try {
    const portfolios = Object.fromEntries(["csv", "ledger", "approval", "valuation"].map(kind => [kind, createPortfolio(db, human, `Synthetic mixed ${kind}`, at)])) as Record<"csv" | "ledger" | "approval" | "valuation", string>;
    const csvAccounts = Array.from({ length: 7 }, (_, i) => createAccount(db, human, portfolios.csv, `Synthetic CSV ${i + 1}`, "Synthetic fixture", "CNY", at));
    const ledgerAccount = createAccount(db, human, portfolios.ledger, "Synthetic small ledger", "Synthetic fixture", "CNY", at);
    const approvalAccount = createAccount(db, human, portfolios.approval, "Synthetic approvals", "Synthetic fixture", "CNY", at);
    const valuationAccount = createAccount(db, human, portfolios.valuation, "Synthetic USD valuation", "Synthetic fixture", "USD", at);
    const listingIds: string[] = [];
    db.transaction(() => {
      for (let i = 0; i < listingCount; i++) {
        const foreign = i === 1;
        listingIds.push(registerListing(db, human, { portfolio_id: portfolios.csv, expected_revision: 0, idempotency_key: `mixed-listing:${i}`,
          name: `Synthetic mixed ETF ${i}`, market: foreign ? "US" : "CN", exchange: "SYNTHETIC", ticker: `MIX${String(i).padStart(6, "0")}`,
          currency: foreign ? "USD" : "CNY", asset_class: "equity", source_evidence: notice }, at).listing_id);
      }
      if (marketRows) {
        db.prepare("INSERT INTO market_batches(id,source_id,batch_type,scope,status,started_at) VALUES('mixed-padding','synthetic-mixed-padding','prices','mixed:padding','staging',?)").run(at);
        const put = db.prepare(`INSERT INTO market_observations(id,batch_id,source_id,listing_id,series_key,metric,value,unit,observed_at,ingested_at,price_basis,revision_id,raw_hash,parser_version,provenance)
          VALUES(?,'mixed-padding','synthetic-mixed-padding',?,?,'close','1',?,?,?,'unadjusted',?,?,'synthetic-padding-v1','reconstructed')`);
        const rawHash = hash({ fixture: "mixed-padding-v1", not_valuation_evidence: true });
        for (let i = 0; i < marketRows; i++) {
          const index = i % listingCount, listing = listingIds[index];
          const day = new Date(Date.parse(at) - (Math.floor(i / listingCount) % 3650 + 1) * 86400000).toISOString();
          put.run(`mixed-padding:${i}`, listing, listing, index === 1 ? "USD" : "CNY", day, at, `padding:${Math.floor(i / (listingCount * 3650))}`, rawHash);
        }
      }
    }).immediate();
    let factSequence = 0;
    const fact = (portfolio: string, value: LedgerCommand["fact"], source = "synthetic-mixed-prerequisite") => recordFact(db, human, {
      portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: `mixed-seed:${++factSequence}`,
      source_id: source, source_event_id: `mixed-seed:${factSequence}`, effective_at: effectiveDate, time_precision: "date", source_timezone: "UTC", reason: notice, fact: value,
    }, at);
    const approvalCash = "10000000000";
    fact(portfolios.approval, { type: "opening_cash", account_id: approvalAccount, currency: "CNY", amount: approvalCash });
    fact(portfolios.ledger, { type: "opening_cash", account_id: ledgerAccount, currency: "CNY", amount: "100" });
    fact(portfolios.valuation, { type: "opening_cash", account_id: valuationAccount, currency: "USD", amount: "5000" });
    const buy = fact(portfolios.valuation, { type: "buy", account_id: valuationAccount, currency: "USD", listing_id: listingIds[1], quantity: "10", price: "10", consideration: "100", fee: "1" });
    fact(portfolios.valuation, { type: "settlement", account_id: valuationAccount, currency: "USD", direction: "buy", related_event_id: buy.event_id, amount: "101" });
    const csvHistory = history - 5;
    db.transaction(() => {
      for (let i = 0; i < csvHistory; i++) fact(portfolios.csv, { type: "deposit", account_id: csvAccounts[i % csvAccounts.length], currency: "CNY", amount: String(i + 1) }, "synthetic-mixed-history");
    }).immediate();
    const attach = (value: unknown) => storeJsonAttachment(db, human, { portfolio_id: portfolios.approval, account_id: approvalAccount, raw: canonical(value) }, options).id;
    for (const [portfolio, listing] of [[portfolios.approval, listingIds[0]], [portfolios.valuation, listingIds[1]]]) {
      addCatalogEntry(db, human, { portfolio_id: portfolio, listing_id: listing, expected_catalog_revision: catalogRevision(db, portfolio), idempotency_key: `mixed-catalog:${listing}` }, options);
      const source = storeMarketReferenceSource(db, human, { portfolio_id: portfolio, idempotency_key: `mixed-review-source:${listing}`, reference: notice,
        content_text: canonical({ fixture_only: true, listing_id: listing, statement: notice }) }, { now: utc6(at) });
      const identity = db.prepare("SELECT id listing_id,instrument_id,market,exchange,ticker,currency FROM listings WHERE id=?").get(listing);
      publishListingReview(db, human, { portfolio_id: portfolio, listing_id: listing, expected_review_revision: 0, expected_identity_hash: hash(identity),
        source_id: source.id, source_hash: source.content_hash, reason: notice, acknowledgement: true, idempotency_key: `mixed-review:${listing}`, review_until: utc6(validUntil),
        facts: { instrument_kind: "ETF", lifecycle_status: "active", quantity_step: "100", price_step: "0.01", source_effective_date: effectiveDate,
          fund_identifier: null, share_class_identifier: null, product_structure: { leverage: "unleveraged", direction: "long_only" },
          risk_classification: { index_id: "synthetic-mixed-index", region: portfolio === portfolios.approval ? "CN" : "US", sector: "broad" } } }, { now: utc6(at) });
    }
    const envelope = (key: string) => ({ portfolio_id: portfolios.approval, expected_revision: 1, idempotency_key: key, reason: notice });
    const cutoff = new Date(Date.parse(at) - 1000).toISOString();
    reconcileAccount(db, human, { portfolio_id: portfolios.approval, account_id: approvalAccount, expected_revision: 1,
      attachment_id: attach({ schema_version: 1, portfolio_id: portfolios.approval, account_id: approvalAccount, cutoff_at: cutoff,
        coverage: { currencies: ["CNY"], ledger_accounts: [...RECONCILIATION_BALANCES], positions_complete: true, balances_complete: true },
        balances: RECONCILIATION_BALANCES.map(ledger_account => ({ currency: "CNY", ledger_account, balance: ledger_account === "cash_settled" ? approvalCash : "0" })), positions: [] }) }, options);
    approveAccountCapability(db, human, { ...envelope("mixed-capability"), account_id: approvalAccount, market: "CN", valid_until: validUntil,
      attachment_id: attach({ synthetic_only: true, notice }), rules: { listing_ids: [listingIds[0]], currencies: ["CNY"], buy: true, sell: true,
        cash_holds_exclude_workbench_reservations: true, cash_holds_exclude_trade_payables: true } }, options);
    const scopes = { approval: "mixed:approval:prices", valuation: "mixed:valuation:prices", fx: "mixed:valuation:fx" };
    const policy: Policy = { schema_version: 1, mandate_version: "SYNTHETIC-MIXED-v1", approved_decisions: ["D-01", "D-02", "D-03", "D-04", "D-05", "D-06", "D-07", "D-08"],
      account_ids: [approvalAccount], listing_ids: [listingIds[0]], allocation: { core: "0", strategy: "1", defensive: "0" },
      limits: { listing_weight: "1", index_weight: "1", market_weight: "1", currency_weight: "1", region_weight: "1", sector_weight: "1", strategy_weight: "1", min_cash_weight: "0", max_order_cny: "1000000" },
      execution: { proposal_ttl_seconds: 3600, max_price_age_seconds: 86400, max_valuation_age_seconds: 86400, max_reconciliation_age_seconds: 86400,
        price_buffer_bps: "0", max_price_deviation_bps: "100", fee_rate_bps: "0", max_fee_bps: "100", minimum_fee_by_currency: { CNY: "0" }, max_spread_bps: "10", max_premium_bps: "100", min_turnover: "1000000", max_participation: "0.1" },
      price_scope_by_market: { CN: scopes.approval }, fx_scope: "mixed:approval:unused-fx", benchmark: "SYNTHETIC-CNY-BASELINE", evaluation_window: notice,
      contribution_rule: "Confirmed synthetic settled cash only", emergency_rule: "Stop synthetic benchmark", review_after: validUntil, ai_mode: "not_required" };
    const policyVersion = createPolicyVersion(db, human, { ...envelope("mixed-policy"), policy }, options);
    const strategy: Strategy = { schema_version: 1, strategy_key: "synthetic-mixed-manual", algorithm: "manual_target_v1", universe: [listingIds[0]], budget_weight: "1",
      evaluation_frequency: "monthly", benchmark: policy.benchmark, economic_rationale: notice, invalidation_conditions: "Any input revision change",
      admission_thresholds: { min_out_of_sample_observations: 12, min_forward_observations: 6, min_trades: 3, max_drawdown: "0.2", min_net_excess_return: "0.01" } };
    const strategyVersion = createStrategyVersion(db, human, { ...envelope("mixed-strategy"), strategy }, options);
    const sourceManifest = { format_version: 1, application_ref: "SYNTHETIC-MIXED-PREREQUISITES-NOT-A-GATE-RUN", files: Object.fromEntries([
      "web/src/server/governance/risk.ts", "web/src/server/ledger/engine.ts", "worker/market/valuation.py",
    ].map(file => [file, createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex")])) };
    const releaseHash = hash(sourceManifest), researchId = randomUUID();
    const metrics = { out_of_sample_observations: 12, forward_observations: 6, trades: 3, max_drawdown: "0.1", net_excess_return: "0.02" };
    // Deliberate isolated legacy admission scaffolding, never evidence that real G/S gates passed.
    db.prepare("INSERT INTO research_runs(id,portfolio_id,environment,strategy_version_id,policy_version_id,input_manifest,experiment_plan_json,status,result_json,created_at,completed_at) VALUES(?,?,'simulation',?,?,'{}',?,'succeeded',?,?,?)")
      .run(researchId, portfolios.approval, strategyVersion.id, policyVersion.id, canonical({ fixture_only: true, notice }), canonical({ admission_grade: "formal_verified", admission_metrics: metrics }), at, at);
    const prerequisiteJobs: string[] = [], prerequisiteRequests: string[] = [];
    const checks = (gate: "G-01" | "G-03" | "G-04") => gate === "G-01" ? ["D-01", "D-02", "D-03", "D-05"] : Array.from({ length: gate === "G-03" ? 32 : 10 }, (_, i) => `${gate === "G-03" ? "E" : "S"}-${String(i + 1).padStart(2, "0")}`);
    const verificationIds = Object.fromEntries((["G-03", "G-04"] as const).map(gate => {
      const requestId = randomUUID(), jobId = randomUUID(); prerequisiteJobs.push(jobId); prerequisiteRequests.push(requestId);
      const request = { gate, policy_hash: policyVersion.content_hash, strategy_hash: strategyVersion.content_hash, source_manifest_hash: releaseHash };
      const manifest = { format_version: 1, ...request, portfolio_id: portfolios.approval, suite_version: "SYNTHETIC-PREREQUISITE-NOT-REAL-VERIFICATION-v1", tool_version: process.version,
        environment: "actual", provenance: "authoritative", started_at: at, finished_at: at,
        checks: checks(gate).map(id => ({ id, status: "pass", artifact_hash: hash({ fixture_only: true, gate, id, notice }) })), ...(gate === "G-04" ? { research_run_id: researchId, metrics } : {}) };
      db.prepare("INSERT INTO command_requests(id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at) VALUES(?,?,'governance_verification',?,?,?,'system:governance-verifier',?)")
        .run(requestId, portfolios.approval, requestId, hash(request), canonical(request), at);
      db.prepare("INSERT INTO job_runs(id,command_request_id,job_type,scope,period,input_version,status,not_before,result_json,created_at,updated_at) VALUES(?,?,'governance_verification',?,?,'synthetic-prerequisite-only','succeeded',?,?,?,?)")
        .run(jobId, requestId, portfolios.approval, jobId, at, canonical({ manifest_hash: hash(manifest), manifest, source_manifest: sourceManifest }), at, at);
      return [gate, registerCompletedVerification(db, jobId, at)];
    })) as Record<"G-03" | "G-04", string>;
    const gates = Object.fromEntries((["G-01", "G-03", "G-04"] as const).map(gate => [gate, attach({ schema_version: 1, kind: "governance_gate_evidence",
      portfolio_id: portfolios.approval, gate, policy_hash: policyVersion.content_hash, strategy_hash: strategyVersion.content_hash, source_mode: "manual_verified",
      reviewed_at: at, valid_until: validUntil, checks: checks(gate).map(id => ({ id, status: "pass", evidence: notice })),
      ...(gate === "G-01" ? {} : { verification_ids: [verificationIds[gate]] }), ...(gate === "G-04" ? { research_run_id: researchId, metrics } : {}) })])) as Record<"G-01" | "G-03" | "G-04", string>;
    const counts = Object.fromEntries(["portfolios", "accounts", "listings", "ledger_events", "market_observations", "market_publications", "valuation_runs", "activations", "proposals", "risk_runs", "approval_events", "reservations", "csv_background_results"].map(table => [table, (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n]));
    return { schema_version: "workbench-mixed-fixture-v1" as const, synthetic_only: true as const, filename, dataDir, releaseHash, sourceManifest,
      clock: { now, seeded_at: at, observed_at: observedAt, effective_date: effectiveDate, valid_until: validUntil }, scopes,
      ids: { csv: { portfolio_id: portfolios.csv, account_ids: csvAccounts }, ledger: { portfolio_id: portfolios.ledger, account_id: ledgerAccount },
        approval: { portfolio_id: portfolios.approval, account_id: approvalAccount, listing_id: listingIds[0], policy_version_id: policyVersion.id, strategy_version_id: strategyVersion.id, gate_attachments: gates },
        valuation: { portfolio_id: portfolios.valuation, account_id: valuationAccount, listing_id: listingIds[1] } },
      revisions: { csv: csvHistory, ledger: 1, approval: 1, valuation: 3 }, counts, schema: migration.version,
      prerequisites: { fixture_only: true as const, real_gate_verified: false as const, notice, research_run_id: researchId, job_ids: prerequisiteJobs, command_request_ids: prerequisiteRequests, verification_ids: verificationIds },
      expected: { seed_facts: history, csv_history_facts: csvHistory, csv_cash_cny: String(BigInt(csvHistory) * BigInt(csvHistory + 1) / 2n),
        ledger_cash_cny: "100", approval_cash_cny: approvalCash, valuation_cash_usd: "4899", valuation_quantity: "10", valuation_cost_usd: "100",
        approval_price_cny: "100", valuation_price_usd: "12", usd_cny: "7.5", valuation_nav_cny: "37642.5",
        small_fact_source: "synthetic-mixed-small", small_fact_key_prefix: "mixed-small:", history_source: "synthetic-mixed-history",
        padding_source: "synthetic-mixed-padding", padding_is_valuation_evidence: false as const },
    };
  } finally { db.close(); }
}

export type WorkbenchMixedFixture = ReturnType<typeof createWorkbenchMixedFixture>;
type ValuationKind = "approval" | "valuation";
type MarketKind = ValuationKind | "fx";
const governance = (operation: string, command: unknown) => ({ action: "governance" as const, command: { operation, command } });
const approvalEnvelope = (fixture: WorkbenchMixedFixture, key: string) => ({ portfolio_id: fixture.ids.approval.portfolio_id, expected_revision: fixture.revisions.approval, idempotency_key: key, reason: notice });

export function mixedMarketRequest(fixture: WorkbenchMixedFixture, kind: MarketKind, sequence: number, expectedPublicationRevision = 0) {
  integer(sequence, 0, 1000000); integer(expectedPublicationRevision, 0, Number.MAX_SAFE_INTEGER);
  const target = kind === "approval" ? fixture.ids.approval : fixture.ids.valuation;
  const batchId = `mixed-market:${kind}:${sequence}`, source = "synthetic-mixed-manual", at = fixture.clock.observed_at;
  const metrics = kind === "fx" ? [["fx_cny_per_unit", fixture.expected.usd_cny, "CNY_per_unit_currency"]]
    : kind === "approval" ? [["close", "100", "CNY"], ["spread_bps", "1", "bps"], ["premium_bps", "0", "bps"], ["turnover", "10000000", "CNY"], ["volume", "100000", "shares"]]
      : [["close", fixture.expected.valuation_price_usd, "USD"]];
  const observations = metrics.map(([metric, value, unit], i) => ({ id: `${batchId}:row:${i}`, batch_id: batchId, source_id: source,
    ...(kind === "fx" ? {} : { listing_id: target.listing_id }), series_key: kind === "fx" ? "FX:USD" : target.listing_id,
    metric, value, unit, observed_at: at, published_at: at, ingested_at: at, source_timezone: "UTC", time_precision: "second", price_basis: metric === "close" ? "unadjusted" : "not_applicable",
    revision_id: batchId, raw_hash: hash({ fixture_only: true, batchId, metric, value, at }), parser_version: "synthetic-mixed-manual-v1", provenance: "live_observed" }));
  return { action: "enqueue_task" as const, command: { portfolio_id: target.portfolio_id, expected_revision: fixture.revisions[kind === "approval" ? "approval" : "valuation"],
    idempotency_key: batchId, command_type: "market_ingest" as const, payload: { document: { schema_version: "market-batch-v1", batch: { id: batchId, source_id: source,
      batch_type: kind === "fx" ? "fx" : "prices", scope: fixture.scopes[kind], expected_pages: 1, expected_rows: observations.length, expected_publication_revision: expectedPublicationRevision,
      source_mode: "manual_verified", source_evidence: notice }, pages: [{ page_number: 1, observations }] }, publish: true } } };
}

export function mixedValuationRequest(fixture: WorkbenchMixedFixture, kind: ValuationKind, sequence: number, cutoffAt = new Date().toISOString()) {
  integer(sequence, 0, 1000000);
  const target = fixture.ids[kind], approval = kind === "approval";
  return { action: "enqueue_task" as const, command: { portfolio_id: target.portfolio_id, expected_revision: fixture.revisions[kind], idempotency_key: `mixed-valuation:${kind}:${sequence}`,
    command_type: "valuation" as const, payload: { cutoff_at: cutoffAt, mode: "restated", rules: { schema_version: "valuation-rules-v1", approved: true, approval_evidence: notice,
      price_scope_by_market: { [approval ? "CN" : "US"]: fixture.scopes[kind] }, expected_sessions: { [approval ? "CN" : "US"]: fixture.clock.observed_at.slice(0, 10) },
      corporate_actions_complete: { [target.listing_id]: true }, fx_scope: approval ? "mixed:approval:unused-fx" : fixture.scopes.fx, max_fx_age_seconds: 86400 } } } };
}

export function mixedActivationRequest(fixture: WorkbenchMixedFixture, valuationId: string) {
  return governance("activate_policy", { ...approvalEnvelope(fixture, "mixed-activation"), policy_version_id: fixture.ids.approval.policy_version_id,
    strategy_version_id: fixture.ids.approval.strategy_version_id, valuation_id: valuationId, gate_attachments: fixture.ids.approval.gate_attachments });
}

export function mixedProposalRequest(fixture: WorkbenchMixedFixture, activationId: string, valuationId: string, sequence: number, now = new Date().toISOString()) {
  integer(sequence, 0, 1000000);
  return governance("create_proposal", { ...approvalEnvelope(fixture, `mixed-proposal:${sequence}`), activation_id: activationId, valuation_id: valuationId,
    expires_at: new Date(Date.parse(now) + 1800000).toISOString(), items: [{ account_id: fixture.ids.approval.account_id, listing_id: fixture.ids.approval.listing_id,
      side: "buy", currency: "CNY", quantity: "100", limit_price: "100", estimated_fees: "0" }] });
}

export function mixedApprovalRequest(fixture: WorkbenchMixedFixture, proposal: { id: string; risk: { id: string; input_hash: string } }, sequence: number) {
  integer(sequence, 0, 1000000);
  return governance("approve_proposal", { ...approvalEnvelope(fixture, `mixed-approve:${sequence}`), proposal_id: proposal.id, risk_run_id: proposal.risk.id, expected_input_hash: proposal.risk.input_hash });
}

export function mixedCancelRequest(fixture: WorkbenchMixedFixture, proposalId: string, sequence: number) {
  integer(sequence, 0, 1000000);
  return governance("cancel_remainder", { ...approvalEnvelope(fixture, `mixed-cancel:${sequence}`), proposal_id: proposalId });
}

export function mixedLedgerRequest(fixture: WorkbenchMixedFixture, sequence: number, expectedRevision: number) {
  integer(sequence, 0, 1000000); integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER);
  return { action: "record_fact" as const, command: { portfolio_id: fixture.ids.ledger.portfolio_id, expected_revision: expectedRevision,
    idempotency_key: `mixed-small:${sequence}`, source_id: fixture.expected.small_fact_source, source_event_id: `mixed-small:${sequence}`,
    effective_at: fixture.clock.effective_date, time_precision: "date" as const, source_timezone: "UTC", reason: notice,
    fact: { type: "deposit" as const, account_id: fixture.ids.ledger.account_id, currency: "CNY", amount: "1" } } };
}
