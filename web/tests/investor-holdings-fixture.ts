import { execFileSync } from "node:child_process";
import path from "node:path";
import { canonical, hash, createAccount, recordFact, revision, type LedgerCommand } from "../src/server/ledger/service";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { reconcileAccount, RECONCILIATION_BALANCES, type AccountStatement } from "../src/server/ledger/reconciliation";
import { registerListing } from "../src/server/workbench-commands";
import { addCatalogEntry } from "../src/server/catalog/service";
import { publishMarketReference, storeMarketReferenceSource } from "../src/server/market-references/service";
import { currentListingIdentity, publishListingReview } from "../src/server/listing-reviews/service";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { investorActor, investorFixture, syntheticProfile } from "./investor-fixture";

export const holdingsNow = "2026-01-02T12:00:20.000Z";
export function holdingsPython(f: { filename: string }, module: string, args: string[] = [], input?: unknown) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
    cwd: path.resolve(process.cwd(), ".."), input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 60000, maxBuffer: 65536,
  }));
}
export function investorHoldingsFixture(options: { securities?: boolean; reference?: boolean; twoAccounts?: boolean; transit?: boolean;
  fixture?: ReturnType<typeof investorFixture>; actor?: { id: string }; now?: string } = {}) {
  const f = options.fixture ?? investorFixture(), actor = options.actor ?? investorActor;
  const base = Date.parse(options.now ?? holdingsNow) - 20000;
  const at = (second: number) => new Date(base + second * 1000).toISOString(), day = at(0).slice(0, 10);
  const observed = new Date(base - 1000).toISOString();
  try {
    executeInvestorCommand(f.db, actor, { action: "save_profile", expected_revision: 0, idempotency_key: "fictional-holdings-profile",
      profile: options.reference ? { ...syntheticProfile, loss_tolerance: "0.30" } : syntheticProfile }, at(0));
    if (options.reference) { holdingsPython(f, "tests.investor.evidence_fixture", ["--now", at(3)]); holdingsPython(f, "tests.investor.queue_fixture", ["--mode", "core", "--now", at(3)]); }
    executeInvestorCommand(f.db, actor, { action: "create_account_book", expected_revision: getInvestorState(f.db, actor, at(5)).revision,
      idempotency_key: "fictional-holdings-setup", book_name: "Fictional holdings comparison ledger", account: { name: "Fictional first", broker: "Fictional broker", currency: "CNY" } }, at(5));
    const portfolio = (f.db.prepare("SELECT id FROM portfolios").get() as { id: string }).id;
    const account = (f.db.prepare("SELECT id FROM accounts").get() as { id: string }).id;
    const second = options.twoAccounts ? createAccount(f.db, actor, portfolio, "Fictional second", "Fictional broker", "CNY", at(5)) : null;
    let sequence = 0;
    const record = (fact: LedgerCommand["fact"], time = at(6)) => recordFact(f.db, actor, { portfolio_id: portfolio, expected_revision: revision(f.db, portfolio),
      idempotency_key: `fictional-holdings-${++sequence}`, source_id: "FICTIONAL-STATEMENT", source_event_id: String(sequence), effective_at: new Date(base - 86400000).toISOString().slice(0, 10),
      time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Fictional software test only, not real funds", fact }, time);
    record({ type: "opening_cash", account_id: account, currency: "CNY", amount: "100" });
    if (second) record({ type: "opening_cash", account_id: second, currency: "CNY", amount: "50" });
    const human = { ...actor, kind: "human" as const }, micros = at(7).replace("Z", "000Z");
    const listing = (ticker: string) => registerListing(f.db, actor, { portfolio_id: portfolio, expected_revision: revision(f.db, portfolio), idempotency_key: "fixture-listing-" + ticker,
      market: "CN", exchange: "SSE", ticker, currency: "CNY", name: "Fictional ETF " + ticker, asset_class: "unknown", source_evidence: "Fictional software fixture" }, at(5)).listing_id;
    const alpha = options.securities ? listing("501998") : null, outside = options.securities ? listing("501997") : null;
    const beta = options.reference ? listing("501999") : null;
    let transfer: string | null = null;
    if (alpha && outside) {
      record({ type: "opening_cash", account_id: account, currency: "USD", amount: "10" });
      record({ type: "opening_position", account_id: account, listing_id: alpha, currency: "CNY", quantity: "5", cost_amount: "50" });
      record({ type: "opening_position", account_id: account, listing_id: outside, currency: "CNY", quantity: "2", cost_amount: "40" });
      record({ type: "buy", account_id: account, listing_id: alpha, currency: "CNY", quantity: "1", price: "10" });
      if (options.transit && second) transfer = record({ type: "security_transfer_out", account_id: account, target_account_id: second, listing_id: alpha, currency: "CNY", quantity: "2" }).event_id;
    }
    const mappings: { listing: string; symbol: string; reviewId: string; mappingId: string }[] = [];
    if (options.reference && alpha && beta) {
      for (const [index, id] of [alpha, beta].entries()) {
        addCatalogEntry(f.db, human, { portfolio_id: portfolio, listing_id: id, expected_catalog_revision: index, idempotency_key: "fixture-catalog-" + index }, { now: micros });
        const source = storeMarketReferenceSource(f.db, human, { portfolio_id: portfolio, idempotency_key: "fixture-source-" + index,
          reference: "Fictional identity mapping source", content_text: canonical({ fictional: true, listing: id }) }, { now: micros });
        const symbol = index === 0 ? "501998.SH" : "501999.SH";
        const mapping = publishMarketReference(f.db, human, { portfolio_id: portfolio, idempotency_key: "fixture-mapping-" + index, expected_version: 0,
          source_id: source.id, source_hash: source.content_hash, acknowledgement: true, review_reason: "Fictional explicit mapping, not provider certification",
          document: { kind: "mapping", facts: { provider: "longport", listing_id: id, provider_symbol: symbol, market: "CN", exchange: "SSE", currency: "CNY", valid_from: "2025-01-01", valid_to: null } } }, { now: micros });
        const review = publishListingReview(f.db, human, { portfolio_id: portfolio, listing_id: id, expected_review_revision: 0,
          expected_identity_hash: hash(currentListingIdentity(f.db, portfolio, id)), source_id: source.id, source_hash: source.content_hash,
          facts: { instrument_kind: "ETF", lifecycle_status: "active", quantity_step: "1", price_step: "0.01", source_effective_date: "2026-01-01",
            fund_identifier: "FICTIONAL-FUND", share_class_identifier: null, product_structure: { leverage: "unleveraged", direction: "long_only" },
            risk_classification: { index_id: "FICTIONAL-INDEX", region: "Fictional", sector: "Fictional" } },
          review_until: "2026-12-01T00:00:00.000000Z", reason: "Fictional identity review", acknowledgement: true, idempotency_key: "fixture-review-" + index }, { now: micros });
        mappings.push({ listing: id, symbol, reviewId: review.id, mappingId: mapping.id });
      }
    }
    const statement = (id = account): AccountStatement => {
      const first = id === account, currencies = first && options.securities ? ["CNY", "USD"] : ["CNY"];
      return { schema_version: 1, portfolio_id: portfolio, account_id: id, cutoff_at: at(10),
        coverage: { currencies, ledger_accounts: [...RECONCILIATION_BALANCES], positions_complete: true, balances_complete: true, security_transits_complete: true },
        balances: currencies.flatMap(currency => RECONCILIATION_BALANCES.map(ledger_account => ({ currency, ledger_account,
          balance: ledger_account === "cash_settled" ? first ? currency === "CNY" ? "100" : "10" : "50"
            : first && options.securities && currency === "CNY" && ledger_account === "trade_payable" ? "-10" : "0" }))),
        positions: first && alpha && outside ? [{ listing_id: alpha, currency: "CNY", quantity: transfer ? "4" : "6" }, { listing_id: outside, currency: "CNY", quantity: "2" }] : [],
        security_transits: transfer && second && alpha ? [{ transfer_event_id: transfer, source_account_id: account, target_account_id: second, listing_id: alpha, currency: "CNY", quantity: "2" }] : [],
      };
    };
    const reconcile = (id = account) => {
      const attachment = storeJsonAttachment(f.db, actor, { portfolio_id: portfolio, account_id: id, raw: JSON.stringify(statement(id)) }, { dataDir: f.directory, now: at(11) });
      return reconcileAccount(f.db, actor, { portfolio_id: portfolio, account_id: id, expected_revision: revision(f.db, portfolio), attachment_id: attachment.id }, { dataDir: f.directory, now: at(11) });
    };
    const publish = () => {
      const document = (id: string, scope: string, batch_type: string, rows: Record<string, unknown>[]) => ({ schema_version: "market-batch-v1",
        batch: { id, scope, source_id: "FICTIONAL", batch_type, expected_pages: 1, expected_rows: rows.length, expected_publication_revision: 0,
          source_mode: "manual_verified", source_evidence: "FICTIONAL SOFTWARE TEST ONLY, NOT PROVIDER EVIDENCE" }, pages: [{ page_number: 1, observations: rows.map((row, i) => ({
            id: id + ":row:" + i, batch_id: id, source_id: "FICTIONAL", ingested_at: at(8), observed_at: observed, published_at: observed,
            source_timezone: "Asia/Shanghai", time_precision: "second", revision_id: "fictional-v1", raw_hash: hash(row), parser_version: "fictional-v1", provenance: "live_observed", ...row,
          })) }] });
      const documents = alpha && outside ? [document("fixture:prices", "fixture:CN", "prices", [
        { listing_id: alpha, series_key: alpha, metric: "close", price_basis: "unadjusted", unit: "CNY", value: "10" },
        { listing_id: outside, series_key: outside, metric: "close", price_basis: "unadjusted", unit: "CNY", value: "20" }]),
      document("fixture:fx", "fixture:FX", "fx", [{ series_key: "FX:USD", metric: "fx_cny_per_unit", price_basis: "not_applicable", unit: "CNY_per_unit_currency", value: "7" }])] : [];
      return holdingsPython(f, "tests.investor.holdings_fixture", [], { portfolio_id: portfolio, now: at(12), cutoff: at(9), documents,
        rules: { schema_version: "valuation-rules-v1", approved: true, approval_evidence: "Fictional valuation rules only",
          price_scope_by_market: alpha ? { CN: "fixture:CN" } : {}, expected_sessions: alpha ? { CN: day } : {},
          corporate_actions_complete: alpha && outside ? { [alpha]: true, [outside]: true } : {}, max_fx_age_seconds: 86400,
          ...(alpha ? { fx_scope: "fixture:FX" } : {}) } });
    };
    return { ...f, actor, portfolio, account, second, alpha, beta, outside, transfer, mappings, record, statement, reconcile, publish,
      readOptions: { dataDir: f.directory } };
  } catch (error) { f.close(); throw error; }
}
