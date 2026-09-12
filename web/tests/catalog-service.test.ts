import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { canonical, createAccount, createPortfolio, revision } from "../src/server/ledger/service";
import { storeJsonAttachment } from "../src/server/ledger/attachments";
import { approveAccountCapability } from "../src/server/governance/service";
import { addCatalogEntry, catalogRevision, isCatalogClientError, publishCatalogHoldings, publishCatalogProfile, readCatalogSource, storeCatalogSource } from "../src/server/catalog/service";
import { catalogDetail, catalogWorkspace, compareCatalog } from "../src/server/catalog/queries";
import type { EtfProfile } from "../src/server/catalog/types";

const human = { id: "SYNTHETIC-CATALOG-HUMAN", kind: "human" as const };
const now = "2026-01-05T12:00:00.000Z";
const profile: EtfProfile = { issuer: "SYNTHETIC issuer", index_id: null, domicile: null, underlying_asset_class: "unknown", economic_regions: [], sectors: [], annual_expense_ratio: null, distribution: "unknown", replication: "unknown" };
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "etf-catalog-test-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, human, "SYNTHETIC catalog only", now);
  const other = createPortfolio(db, human, "SYNTHETIC other catalog", now);
  const account = createAccount(db, human, portfolio, "Synthetic account", "No broker", "CNY", now);
  for (const [id, market, ticker, currency] of [["a", "CN", "000001", "CNY"], ["b", "HK", "00002", "HKD"], ["c", "US", "TEST", "USD"]]) {
    db.prepare("INSERT INTO instruments(id,name,created_at) VALUES(?,?,?)").run(`i-${id}`, `SYNTHETIC ETF ${id}`, now);
    db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES(?,?,?,?,?,?,?)").run(id, `i-${id}`, market, `EX-${market}`, ticker, currency, now);
  }
  let serial = 0;
  const envelope = (scope = portfolio) => ({ portfolio_id: scope, expected_catalog_revision: catalogRevision(db, scope), idempotency_key: `catalog-${++serial}` });
  const add = (listing = "a", scope = portfolio) => addCatalogEntry(db, human, { ...envelope(scope), listing_id: listing }, { now });
  const source = (scope = portfolio, at = now) => storeCatalogSource(db, human, { ...envelope(scope), reference: "SYNTHETIC public disclosure; never fetched", document: { synthetic: true, issuer_record: "Not a real issuer document" } }, { now: at });
  const publish = (listing: string, sourceId: string, patch: Partial<EtfProfile> = {}) => publishCatalogProfile(db, human, { ...envelope(), listing_id: listing, expected_profile_version: (db.prepare("SELECT COALESCE(MAX(version),0) n FROM etf_profile_versions WHERE portfolio_id=? AND listing_id=?").get(portfolio, listing) as { n: number }).n, source_id: sourceId, as_of: "2026-01-01", profile: { ...profile, ...patch } }, { now });
  const holdings = (listing: string, sourceId: string, items = [{ security_id: "SYNTHETIC:ONE", weight: "1" }], complete = true, asOf = "2026-01-01", at = now) => publishCatalogHoldings(db, human, { ...envelope(), listing_id: listing, expected_holdings_version: (db.prepare("SELECT COALESCE(MAX(version),0) n FROM etf_holdings_versions WHERE portfolio_id=? AND listing_id=?").get(portfolio, listing) as { n: number }).n, source_id: sourceId, as_of: asOf, complete, coverage: complete ? "1" : "0.4", weight_basis: "net_assets_long_only", items }, { now: at });
  const detail = (listing = "a", at = now) => catalogDetail(db, { portfolio_id: portfolio, listing_id: listing, now: at });
  const compare = (selections: { listing_id: string; profile_version_id?: string; holdings_version_id?: string }[] = [{ listing_id: "a" }, { listing_id: "b" }]) => compareCatalog(db, { portfolio_id: portfolio, expected_catalog_revision: catalogRevision(db, portfolio), selections }, now);
  return { directory, filename, db, portfolio, other, account, envelope, add, source, publish, holdings, detail, compare, close: () => { db.close(); rmSync(directory, { force: true, recursive: true }); } };
}

test("catalog publication is private research metadata, not identity approval, a funding plan, or ledger facts", () => {
  const f = fixture();
  try {
    const identity = f.db.prepare("SELECT * FROM listings ORDER BY id").all(), instruments = f.db.prepare("SELECT * FROM instruments ORDER BY id").all();
    f.add(); const source = f.source(); f.publish("a", source.id); f.holdings("a", source.id);
    assert.equal(catalogRevision(f.db, f.portfolio), 4); assert.equal(revision(f.db, f.portfolio), 0);
    for (const table of ["ledger_events", "postings", "account_projections", "position_projections", "funding_plan_versions", "policy_versions", "account_capabilities", "attachments"]) assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
    assert.deepEqual(f.db.prepare("SELECT * FROM listings ORDER BY id").all(), identity); assert.deepEqual(f.db.prepare("SELECT * FROM instruments ORDER BY id").all(), instruments);
    const detail = f.detail(); assert.equal(detail.profile?.profile.annual_expense_ratio, null); assert.equal(detail.holdings?.item_count, 1);
    assert.equal("items" in detail.holdings!, false); assert.equal(detail.status, "unverified"); assert.equal(detail.account_capabilities[0].buy, "unknown");
    assert.equal(detail.account_capabilities[0].executable, false); assert.equal(detail.research_only, true);
    assert.equal(detail.instrument_class, "unknown");
    assert.equal(catalogWorkspace(f.db, { portfolio_id: f.other }).rows.length, 0);
    assert.throws(() => f.db.prepare("UPDATE catalog_sources SET reference='rewrite'").run(), /append-only/);
    assert.throws(() => f.db.prepare("DELETE FROM etf_profile_versions").run(), /append-only/);
    assert.throws(() => f.db.prepare("DELETE FROM etf_holdings_versions").run(), /append-only/);
    assert.throws(() => f.db.prepare("DELETE FROM catalog_entries").run(), /append-only/);
  } finally { f.close(); }
});

test("legacy instrument class is displayed without certifying ETF identity or mutating it", () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE instruments SET asset_class='equity' WHERE id='i-a'").run();
    f.add(); assert.equal(f.detail().instrument_class, "equity"); assert.equal(f.detail().status, "unverified");
    assert.equal(catalogWorkspace(f.db, { portfolio_id: f.portfolio }).identity_options.find(row => row.listing_id === "a")?.instrument_class, "equity");
  } finally { f.close(); }
});

test("human-only strict mutations have independent CAS, atomic audits and semantic idempotent retries", () => {
  const f = fixture();
  try {
    const command = { ...f.envelope(), listing_id: "a" };
    for (const kind of ["ai", "worker", "strategy"] as const) assert.throws(() => addCatalogEntry(f.db, { ...human, kind }, command, { now }), /CATALOG_PERMISSION_DENIED/);
    assert.throws(() => addCatalogEntry(f.db, human, { ...command, approved: true }, { now }), /CATALOG_INVALID_COMMAND/);
    const first = addCatalogEntry(f.db, human, command, { now });
    const audits = f.db.prepare("SELECT * FROM audit_events").all();
    assert.deepEqual(addCatalogEntry(f.db, human, { ...command, expected_catalog_revision: 999 }, { now }), { ...first, duplicate: true });
    assert.throws(() => addCatalogEntry(f.db, human, { ...command, listing_id: "b" }, { now }), /CATALOG_DUPLICATE_CONFLICT/);
    assert.throws(() => addCatalogEntry(f.db, human, { ...command, listing_id: "b", idempotency_key: "stale" }, { now }), /CATALOG_VERSION_CONFLICT/);
    assert.throws(() => f.add("missing"), /CATALOG_LISTING_NOT_FOUND/);
    assert.equal(catalogRevision(f.db, f.portfolio), 1); assert.deepEqual(f.db.prepare("SELECT * FROM audit_events").all(), audits);
    const source = f.source(), published = f.publish("a", source.id);
    assert.throws(() => publishCatalogProfile(f.db, human, { ...f.envelope(), listing_id: "a", expected_profile_version: 0, source_id: source.id, as_of: "2026-01-01", profile }, { now }), /CATALOG_VERSION_CONFLICT/);
    assert.equal(published.version, 1); assert.equal(catalogRevision(f.db, f.portfolio), 3);
  } finally { f.close(); }
});

test("source scope, known-at, strict JSON and evidence hashes are rechecked before publication", () => {
  const f = fixture();
  try {
    f.add(); const otherSource = f.source(f.other);
    assert.throws(() => f.publish("a", otherSource.id), /CATALOG_SOURCE_OUT_OF_SCOPE/);
    assert.throws(() => readCatalogSource(f.db, f.portfolio, otherSource.id), /CATALOG_SOURCE_OUT_OF_SCOPE/);
    const privateAttachment = storeJsonAttachment(f.db, human, { portfolio_id: f.portfolio, account_id: f.account, raw: '{"private":"account evidence"}' }, { dataDir: f.directory, now });
    assert.throws(() => f.publish("a", privateAttachment.id), /CATALOG_SOURCE_NOT_FOUND/);
    for (const document of [[], { n: Infinity }, { n: NaN }, { large: "x".repeat(1048576) }, JSON.parse('{"__proto__":{"polluted":true}}')]) assert.throws(() => storeCatalogSource(f.db, human, { ...f.envelope(), reference: "Synthetic", document }, { now }), /CATALOG_INVALID_COMMAND|CATALOG_SOURCE_TOO_LARGE/);
    const future = f.source(f.portfolio, "2026-01-06T00:00:00.000Z"); assert.throws(() => f.publish("a", future.id), /CATALOG_FUTURE_DISCLOSURE/);
    const source = f.source(), before = catalogRevision(f.db, f.portfolio);
    assert.equal(readCatalogSource(f.db, f.portfolio, source.id).known_at, now);
    f.db.exec("DROP TRIGGER catalog_source_no_update");
    f.db.prepare("UPDATE catalog_sources SET content_text='{}' WHERE id=?").run(source.id);
    assert.throws(() => f.publish("a", source.id), /CATALOG_SOURCE_INTEGRITY_FAILED/);
    assert.throws(() => f.holdings("a", source.id), /CATALOG_SOURCE_INTEGRITY_FAILED/);
    assert.equal(catalogRevision(f.db, f.portfolio), before);
    assert.equal(isCatalogClientError("CATALOG_SOURCE_INTEGRITY_FAILED"), false);
  } finally { f.close(); }
});

test("source instants normalize Z and millisecond form; future disclosures and malformed clocks are rejected", () => {
  const f = fixture();
  try {
    f.add(); const source = f.source(f.portfolio, "2026-01-05T12:00:00Z"); f.publish("a", source.id);
    assert.equal(f.detail().profile?.known_at, now);
    assert.throws(() => publishCatalogProfile(f.db, human, { ...f.envelope(), listing_id: "a", expected_profile_version: 1, source_id: source.id, as_of: "2026-01-06", profile }, { now }), /CATALOG_FUTURE_DISCLOSURE/);
    assert.throws(() => f.source(f.portfolio, "2026-02-30T00:00:00Z"), /CATALOG_INVALID_CLOCK/);
    assert.throws(() => f.source(f.portfolio, "2026-01-01"), /CATALOG_INVALID_CLOCK/);
  } finally { f.close(); }
});

test("keyset catalog pagination binds portfolio, filters and revision; identities retain leading zeroes", () => {
  const f = fixture();
  try {
    f.add("c"); f.add("a"); f.add("b");
    const first = catalogWorkspace(f.db, { portfolio_id: f.portfolio, limit: 1 }); assert.equal(first.rows[0].listing_id, "a"); assert.equal(first.rows[0].ticker, "000001");
    const second = catalogWorkspace(f.db, { portfolio_id: f.portfolio, limit: 1, cursor: first.next_cursor! }); assert.equal(second.rows[0].listing_id, "b");
    const third = catalogWorkspace(f.db, { portfolio_id: f.portfolio, limit: 1, cursor: second.next_cursor! }); assert.equal(third.rows[0].listing_id, "c"); assert.equal(third.next_cursor, null);
    assert.throws(() => catalogWorkspace(f.db, { portfolio_id: f.other, limit: 1, cursor: first.next_cursor! }), /CATALOG_INVALID_CURSOR/);
    assert.throws(() => catalogWorkspace(f.db, { portfolio_id: f.portfolio, limit: 1, market: "CN", cursor: first.next_cursor! }), /CATALOG_INVALID_CURSOR/);
    assert.equal(catalogWorkspace(f.db, { portfolio_id: f.portfolio, query: "%" }).rows.length, 0);
    assert.equal(catalogWorkspace(f.db, { portfolio_id: f.portfolio, market: "HK" }).rows[0].ticker, "00002");
    assert.throws(() => catalogWorkspace(f.db, { portfolio_id: f.portfolio, limit: 101 }), /CATALOG_INVALID_QUERY/);
    f.source(); assert.throws(() => catalogWorkspace(f.db, { portfolio_id: f.portfolio, limit: 1, cursor: first.next_cursor! }), /CATALOG_CURSOR_STALE/);
  } finally { f.close(); }
});

test("public identity options are explicitly bounded, even outside the private catalog", () => {
  const f = fixture();
  try {
    const insert = f.db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES(?,'i-a','CN','EX-CN',?,'CNY',?)");
    f.db.transaction(() => { for (let i = 0; i < 1001; i++) insert.run(`option-${i}`, `T${i}`, now); }).immediate();
    const state = catalogWorkspace(f.db, { portfolio_id: f.portfolio });
    assert.equal(state.rows.length, 0); assert.equal(state.identity_options.length, 1000); assert.equal(state.identity_options_truncated, true);
    f.add("option-999"); assert.equal(catalogWorkspace(f.db, { portfolio_id: f.portfolio }).rows[0].listing_id, "option-999");
  } finally { f.close(); }
});

test("comparison is explicitly unknown without disclosures and binds exact historical versions", () => {
  const f = fixture();
  try {
    f.add("a"); f.add("b"); const unknown = f.compare(); assert.equal(unknown.pairs[0].overlap, null); assert.equal(unknown.rows[0].profile, null);
    assert.deepEqual(unknown.pairs[0].issues, ["HOLDINGS_NOT_DISCLOSED:A", "HOLDINGS_NOT_DISCLOSED:B"]);
    const source = f.source(), first = f.holdings("a", source.id), second = f.holdings("b", source.id);
    assert.equal(f.compare().pairs[0].overlap?.quality, "exact"); assert.equal(f.compare().pairs[0].overlap?.known_overlap, "1");
    f.holdings("a", source.id, [{ security_id: "SYNTHETIC:OTHER", weight: "1" }]);
    const current = f.compare(), historical = f.compare([{ listing_id: "a", holdings_version_id: first.id }, { listing_id: "b", holdings_version_id: second.id }]);
    assert.equal(current.pairs[0].overlap?.known_overlap, "0"); assert.equal(historical.pairs[0].overlap?.known_overlap, "1");
    assert.notEqual(current.resource_hash, historical.resource_hash); assert.equal("items" in historical.rows[0].holdings!, false);
    assert.throws(() => f.compare([{ listing_id: "a", holdings_version_id: second.id }, { listing_id: "b" }]), /CATALOG_VERSION_OUT_OF_SCOPE/);
    assert.throws(() => f.compare([{ listing_id: "a", holdings_version_id: "missing" }, { listing_id: "b" }]), /CATALOG_VERSION_NOT_FOUND/);
    assert.throws(() => f.compare([{ listing_id: "a" }, { listing_id: "a" }]), /CATALOG_INVALID_COMPARISON/);
    assert.throws(() => compareCatalog(f.db, { portfolio_id: f.portfolio, expected_catalog_revision: 0, selections: [{ listing_id: "a" }, { listing_id: "b" }] }, now), /CATALOG_VERSION_CONFLICT/);
    assert.throws(() => compareCatalog(f.db, { portfolio_id: f.portfolio, expected_catalog_revision: catalogRevision(f.db, f.portfolio), selections: [{ listing_id: "a" }, { listing_id: "b" }], actor: human }, now), /CATALOG_INVALID_COMPARISON/);
  } finally { f.close(); }
});

test("partial/different-date holdings remain bounds and are not promoted to current exposures", () => {
  const f = fixture();
  try {
    f.add("a"); f.add("b"); const source = f.source();
    f.holdings("a", source.id, [{ security_id: "SYNTHETIC:ONE", weight: "0.4" }], false);
    f.holdings("b", source.id, [{ security_id: "SYNTHETIC:ONE", weight: "0.4" }], false, "2026-01-02");
    const overlap = f.compare().pairs[0].overlap!;
    assert.equal(overlap.quality, "different_dates"); assert.equal(overlap.known_overlap, "0.4"); assert.equal(overlap.conservative_upper_bound, "1");
    assert.equal(overlap.bound_scope, "the_two_disclosed_date_vectors");
    assert.throws(() => f.holdings("a", source.id, [{ security_id: "SYNTHETIC:ONE", weight: "0.4" }], true), /CATALOG_INVALID_COMMAND/);
    assert.throws(() => f.holdings("a", source.id, [{ security_id: "000001", weight: "1" }]), /CATALOG_INVALID_COMMAND/);
    assert.throws(() => f.holdings("a", source.id, [{ security_id: "SYNTHETIC:ONE", weight: "0.5" }, { security_id: "SYNTHETIC:ONE", weight: "0.5" }]), /CATALOG_INVALID_COMMAND/);
  } finally { f.close(); }
});

test("historical profiles remain private and tampered metadata cannot be displayed or compared", () => {
  const f = fixture();
  try {
    f.add("a"); f.add("b"); f.add("a", f.other); const source = f.source();
    const first = f.publish("a", source.id); f.publish("a", source.id, { annual_expense_ratio: "0.001" });
    const comparison = f.compare([{ listing_id: "a", profile_version_id: first.id }, { listing_id: "b" }]); assert.equal(comparison.rows[0].profile?.profile.annual_expense_ratio, null);
    assert.equal(f.detail().profile_versions.length, 2); assert.equal(f.detail().profile?.profile.annual_expense_ratio, "0.001");
    assert.equal(catalogDetail(f.db, { portfolio_id: f.other, listing_id: "a", now }).sources.length, 0);
    f.db.exec("DROP TRIGGER etf_profile_no_update");
    f.db.prepare("UPDATE etf_profile_versions SET profile_json=? WHERE id=?").run(canonical({ ...profile, issuer: "tampered" }), first.id);
    assert.throws(() => f.detail(), /CATALOG_PROFILE_INTEGRITY_FAILED/);
    assert.throws(() => f.compare([{ listing_id: "a", profile_version_id: first.id }, { listing_id: "b" }]), /CATALOG_PROFILE_INTEGRITY_FAILED/);
  } finally { f.close(); }
});

test("holdings hashes are independently rechecked and history IDs cannot cross portfolios", () => {
  const f = fixture();
  try {
    f.add("a"); f.add("b"); f.add("a", f.other); const source = f.source();
    const original = f.holdings("a", source.id); f.holdings("b", source.id);
    const otherSource = f.source(f.other);
    const otherProfile = publishCatalogProfile(f.db, human, { ...f.envelope(f.other), listing_id: "a", expected_profile_version: 0, source_id: otherSource.id, as_of: "2026-01-01", profile }, { now });
    assert.throws(() => f.compare([{ listing_id: "a", profile_version_id: otherProfile.id }, { listing_id: "b" }]), /CATALOG_VERSION_OUT_OF_SCOPE/);
    assert.throws(() => compareCatalog(f.db, { portfolio_id: f.portfolio, expected_catalog_revision: catalogRevision(f.db, f.portfolio), selections: [{ listing_id: "a" }, { listing_id: "b" }] }, "2026-01-05T11:59:59.999Z"), /CATALOG_FUTURE_DISCLOSURE/);
    const row = f.db.prepare("SELECT snapshot_json FROM etf_holdings_versions WHERE id=?").get(original.id) as { snapshot_json: string };
    const changed = JSON.parse(row.snapshot_json); changed.items[0].security_id = "SYNTHETIC:REWRITTEN";
    f.db.exec("DROP TRIGGER etf_holdings_no_update");
    f.db.prepare("UPDATE etf_holdings_versions SET snapshot_json=? WHERE id=?").run(canonical(changed), original.id);
    assert.throws(() => f.compare(), /CATALOG_HOLDINGS_INTEGRITY_FAILED/); assert.throws(() => f.detail(), /CATALOG_HOLDINGS_INTEGRITY_FAILED/);
    assert.throws(() => catalogWorkspace(f.db, { portfolio_id: f.portfolio }), /CATALOG_HOLDINGS_INTEGRITY_FAILED/);
  } finally { f.close(); }
});

test("fresh empty database returns an explicit null portfolio without initializing private state", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "etf-catalog-empty-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename); const db = openWorkbench(filename);
  try {
    const state = catalogWorkspace(db); assert.equal(state.selected_portfolio_id, null); assert.equal(state.catalog_revision, 0);
    assert.deepEqual(state.portfolios, []); assert.deepEqual(state.rows, []); assert.deepEqual(state.identity_options, []);
    assert.equal((db.prepare("SELECT count(*) n FROM catalog_heads").get() as { n: number }).n, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("recovery marker permits read-only catalog/source queries but prevents writes and idempotent write retries", () => {
  const f = fixture();
  try {
    const command = { ...f.envelope(), listing_id: "a" }; addCatalogEntry(f.db, human, command, { now }); const source = f.source();
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "SYNTHETIC restore guard", { mode: 0o600 });
    assert.equal(catalogWorkspace(f.db, { portfolio_id: f.portfolio }).read_only, true); assert.equal(f.detail().read_only, true);
    assert.equal(readCatalogSource(f.db, f.portfolio, source.id).content_hash, source.content_hash);
    assert.throws(() => addCatalogEntry(f.db, human, command, { now }), /WORKBENCH_READ_ONLY/); assert.throws(() => f.publish("a", source.id), /WORKBENCH_READ_ONLY/);
    const readonly = openWorkbench(f.filename); try { assert.equal(catalogWorkspace(readonly, { portfolio_id: f.portfolio }).read_only, true); } finally { readonly.close(); }
  } finally { f.close(); }
});

test("a restore marker appearing within the catalog transaction rolls back head, metadata, audit and dedup", () => {
  const f = fixture();
  try {
    f.db.function("catalog_restore_marker", () => { writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "SYNTHETIC mid-transaction guard", { mode: 0o600 }); return 1; });
    f.db.exec("CREATE TEMP TRIGGER test_restore AFTER INSERT ON catalog_entries BEGIN SELECT catalog_restore_marker(); END");
    const audits = f.db.prepare("SELECT * FROM audit_events").all(); assert.throws(() => f.add(), /WORKBENCH_READ_ONLY/);
    assert.equal(catalogRevision(f.db, f.portfolio), 0); assert.equal(catalogWorkspace(f.db, { portfolio_id: f.portfolio }).rows.length, 0);
    assert.deepEqual(f.db.prepare("SELECT * FROM audit_events").all(), audits); assert.equal((f.db.prepare("SELECT count(*) n FROM command_dedup WHERE scope LIKE 'catalog:%'").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test("buyability summaries bind human approval, account attachment, listing/currency scope and expiry without trade authorization", () => {
  const f = fixture();
  try {
    f.add("a"); f.add("b");
    const evidence = storeJsonAttachment(f.db, human, { portfolio_id: f.portfolio, account_id: f.account, raw: '{"synthetic":true,"not_live_evidence":true}' }, { dataDir: f.directory, now });
    const command = { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: "capability", reason: "Synthetic permission fixture only", account_id: f.account, market: "CN", valid_until: "2026-01-06T00:00:00.000Z", attachment_id: evidence.id, rules: { listing_ids: ["a"], currencies: ["CNY"], buy: true, sell: false, cash_holds_exclude_workbench_reservations: true, cash_holds_exclude_trade_payables: true } };
    approveAccountCapability(f.db, human, command, { dataDir: f.directory, now });
    assert.equal(f.detail().account_capabilities[0].buy, "verified_scope"); assert.equal(f.detail().account_capabilities[0].sell, "denied");
    assert.equal(f.detail().account_capabilities[0].executable, false); assert.equal(f.detail("b").account_capabilities[0].buy, "unknown");
    assert.equal(f.detail("a", "2026-01-06T00:00:00.000Z").account_capabilities[0].buy, "expired");
    assert.equal(f.detail("a", "2026-01-04T00:00:00.000Z").account_capabilities[0].buy, "unknown");
    const detail = JSON.stringify(f.detail()); assert.equal(detail.includes(evidence.id), false); assert.equal(detail.includes("attachments/"), false);
    writeFileSync(path.join(f.directory, evidence.storage_key), "{}", { mode: 0o600 });
    assert.equal(f.detail().account_capabilities[0].buy, "unknown");
  } finally { f.close(); }
});

test("one account's capability is never generalized to another account or rewritten without matching approval", () => {
  const f = fixture();
  try {
    f.add(); const second = createAccount(f.db, human, f.portfolio, "Another synthetic account", "No broker", "CNY", now);
    const evidence = storeJsonAttachment(f.db, human, { portfolio_id: f.portfolio, account_id: f.account, raw: '{"synthetic":true}' }, { dataDir: f.directory, now });
    const rules = { listing_ids: ["a"], currencies: ["CNY"], buy: false, sell: true, cash_holds_exclude_workbench_reservations: true, cash_holds_exclude_trade_payables: true };
    const approval = approveAccountCapability(f.db, human, { portfolio_id: f.portfolio, expected_revision: 0, idempotency_key: "one-account", reason: "Synthetic only", account_id: f.account, market: "CN", valid_until: "2026-02-01T00:00:00Z", attachment_id: evidence.id, rules }, { dataDir: f.directory, now });
    assert.equal(f.detail().account_capabilities.find(row => row.account_id === f.account)?.buy, "denied");
    assert.equal(f.detail().account_capabilities.find(row => row.account_id === second)?.buy, "unknown");
    // The old capability table is mutable; the summary must still match its append-only approval input.
    f.db.prepare("UPDATE account_capabilities SET rules_json=? WHERE id=?").run(canonical({ ...rules, buy: true }), approval.id);
    assert.equal(f.detail().account_capabilities.find(row => row.account_id === f.account)?.buy, "unknown");
  } finally { f.close(); }
});
