import type Database from "better-sqlite3";
import path from "node:path";
import { z } from "zod";
import { canonical, hash } from "../ledger/service";
import { readJsonAttachment } from "../ledger/attachments";
import { capabilitiesSchema } from "../governance/schemas";
import { parseStrictJson } from "../strict-json";
import { assertCatalogEntry, assertCatalogPortfolio, catalogClock, catalogInstant, catalogReadOnly, catalogRevision, readCatalogSource } from "./service";
import { catalogIdSchema, etfProfileSchema, holdingsSnapshotSchema } from "./schemas";
import { compareHoldings, disclosureHash } from "./overlap";
import type { HoldingsOverlap, HoldingsSnapshot, ProfileVersion } from "./types";
export { readCatalogSource } from "./service";

const id = catalogIdSchema, market = z.enum(["CN", "HK", "US"]);
const workspaceSchema = z.object({ portfolio_id: id.optional(), market: market.optional(), query: z.string().trim().max(120).optional(), cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).optional(), now: z.string().optional() }).strict();
const detailSchema = z.object({ portfolio_id: id, listing_id: id, now: z.string().optional() }).strict();
export interface CatalogIdentity { listing_id: string; instrument_id: string; instrument_class: string; name: string; market: string; exchange: string; ticker: string; currency: string; status: string }
type ProfileRow = { id: string; portfolio_id: string; listing_id: string; version: number; source_id: string; as_of: string; known_at: string; profile_json: string; content_hash: string; created_by: string };
type HoldingsRow = Omit<ProfileRow, "profile_json"> & { snapshot_json: string };
const profileSelect = "SELECT * FROM etf_profile_versions WHERE portfolio_id=? AND listing_id=?";
const holdingsSelect = "SELECT * FROM etf_holdings_versions WHERE portfolio_id=? AND listing_id=?";
function readSnapshot<T>(db: Database.Database, effect: () => T) { return db.inTransaction ? effect() : db.transaction(effect).deferred(); }
function profileVersion(db: Database.Database, row: ProfileRow): ProfileVersion {
  const result = etfProfileSchema.safeParse(parseStrictJson(row.profile_json));
  if (!result.success) throw new Error("CATALOG_PROFILE_INTEGRITY_FAILED");
  const profile = result.data;
  if (hash({ portfolio_id: row.portfolio_id, listing_id: row.listing_id, version: row.version, source_id: row.source_id, as_of: row.as_of, known_at: row.known_at, profile }) !== row.content_hash) throw new Error("CATALOG_PROFILE_INTEGRITY_FAILED");
  const source = readCatalogSource(db, row.portfolio_id, row.source_id);
  if (catalogInstant(source.known_at) > catalogInstant(row.known_at) || row.as_of > row.known_at.slice(0, 10)) throw new Error("CATALOG_PROFILE_INTEGRITY_FAILED");
  return { id: row.id, portfolio_id: row.portfolio_id, listing_id: row.listing_id, version: row.version, source_id: row.source_id, as_of: row.as_of, known_at: row.known_at, profile, content_hash: row.content_hash, created_by: row.created_by };
}
function holdingsVersion(db: Database.Database, row: HoldingsRow): HoldingsSnapshot {
  const result = holdingsSnapshotSchema.safeParse(parseStrictJson(row.snapshot_json));
  if (!result.success) throw new Error("CATALOG_HOLDINGS_INTEGRITY_FAILED");
  const snapshot = result.data, digest = snapshot.content_hash;
  if (digest !== row.content_hash || disclosureHash(snapshot) !== digest || snapshot.snapshot_id !== row.id || snapshot.portfolio_id !== row.portfolio_id || snapshot.listing_id !== row.listing_id || snapshot.version !== row.version || snapshot.as_of !== row.as_of || snapshot.known_at !== row.known_at) throw new Error("CATALOG_HOLDINGS_INTEGRITY_FAILED");
  const source = readCatalogSource(db, row.portfolio_id, row.source_id);
  if (catalogInstant(source.known_at) > catalogInstant(row.known_at) || row.as_of > row.known_at.slice(0, 10)) throw new Error("CATALOG_HOLDINGS_INTEGRITY_FAILED");
  return snapshot;
}
export type HoldingsSummary = Omit<HoldingsSnapshot, "items"> & { item_count: number };
function holdingsSummary(snapshot: HoldingsSnapshot): HoldingsSummary { const { items, ...summary } = snapshot; return { ...summary, item_count: items.length }; }
export interface CatalogRow extends CatalogIdentity { profile: ProfileVersion | null; holdings: HoldingsSummary | null }
function identity(db: Database.Database, listing: string): CatalogIdentity {
  const value = db.prepare("SELECT l.id listing_id,l.instrument_id,i.asset_class instrument_class,i.name,l.market,l.exchange,l.ticker,l.currency,l.status FROM listings l JOIN instruments i ON i.id=l.instrument_id WHERE l.id=?").get(listing) as CatalogIdentity | undefined;
  if (!value) throw new Error("CATALOG_LISTING_NOT_FOUND");
  return value;
}
function current(db: Database.Database, portfolio: string, listing: string): CatalogRow {
  const profile = db.prepare(profileSelect + " ORDER BY version DESC LIMIT 1").get(portfolio, listing) as ProfileRow | undefined;
  const holdings = db.prepare(holdingsSelect + " ORDER BY version DESC LIMIT 1").get(portfolio, listing) as HoldingsRow | undefined;
  return { ...identity(db, listing), profile: profile ? profileVersion(db, profile) : null, holdings: holdings ? holdingsSummary(holdingsVersion(db, holdings)) : null };
}
export type CatalogWorkspaceInput = z.infer<typeof workspaceSchema>;
export function catalogWorkspace(db: Database.Database, raw: CatalogWorkspaceInput = {}) {
  const parsed = workspaceSchema.safeParse(raw);
  if (!parsed.success) throw new Error("CATALOG_INVALID_QUERY");
  const input = parsed.data, now = catalogClock({ now: input.now }), limit = input.limit ?? 50;
  return readSnapshot(db, () => {
    const portfolios = db.prepare("SELECT id,name FROM portfolios ORDER BY created_at,id").all() as { id: string; name: string }[];
    const portfolio = input.portfolio_id ?? (portfolios.length ? portfolios[0].id : null);
    const revision = portfolio ? catalogRevision(db, portfolio) : 0;
    const filters = { portfolio_id: portfolio, market: input.market ?? null, query: input.query ?? "", limit }, filterHash = hash(filters);
    let last = "";
    if (input.cursor) {
      let value: unknown;
      try { if (!/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error(); value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(input.cursor, "base64url"))); } catch { throw new Error("CATALOG_INVALID_CURSOR"); }
      const cursor = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), filter_hash: z.string(), last_id: id }).strict().safeParse(value);
      if (!cursor.success || cursor.data.filter_hash !== filterHash) throw new Error("CATALOG_INVALID_CURSOR");
      if (cursor.data.revision !== revision) throw new Error("CATALOG_CURSOR_STALE");
      last = cursor.data.last_id;
    }
    const query = `%${(input.query ?? "").replace(/[\\%_]/g, value => "\\" + value)}%`;
    const filter = "(? IS NULL OR l.market=?) AND (l.ticker LIKE ? ESCAPE '\\' OR i.name LIKE ? ESCAPE '\\')";
    const matches = portfolio ? db.prepare(`SELECT e.listing_id FROM catalog_entries e JOIN listings l ON l.id=e.listing_id JOIN instruments i ON i.id=l.instrument_id WHERE e.portfolio_id=? AND e.listing_id>? AND ${filter} ORDER BY e.listing_id LIMIT ?`).all(portfolio, last, input.market ?? null, input.market ?? null, query, query, limit + 1) as { listing_id: string }[] : [];
    const rows = matches.slice(0, limit).map(row => current(db, portfolio!, row.listing_id));
    const identities = db.prepare(`SELECT l.id listing_id,i.asset_class instrument_class,i.name,l.market,l.exchange,l.ticker,l.currency FROM listings l JOIN instruments i ON i.id=l.instrument_id WHERE ${filter} ORDER BY l.id LIMIT 1001`).all(input.market ?? null, input.market ?? null, query, query) as Pick<CatalogIdentity, "listing_id" | "instrument_class" | "name" | "market" | "exchange" | "ticker" | "currency">[];
    const next = matches.length > limit ? Buffer.from(canonical({ version: 1, revision, filter_hash: filterHash, last_id: rows.at(-1)!.listing_id })).toString("base64url") : null;
    return { portfolios, selected_portfolio_id: portfolio, catalog_revision: revision, read_only: catalogReadOnly(db), research_only: true as const, as_of: now,
      rows, next_cursor: next, identity_options: identities.slice(0, 1000), identity_options_truncated: identities.length > 1000,
      resource_hash: hash({ portfolio, revision, rows }) };
  });
}
export interface CapabilitySummary { account_id: string; account_name: string; account_status: string; buy: "unknown" | "expired" | "denied" | "verified_scope"; sell: "unknown" | "expired" | "denied" | "verified_scope"; capability_id: string | null; valid_until: string | null; reason: string; executable: false }
function capabilities(db: Database.Database, portfolio: string, listing: CatalogIdentity, now: string): CapabilitySummary[] {
  const accounts = db.prepare("SELECT id,name,status FROM accounts WHERE portfolio_id=? ORDER BY id LIMIT 1000").all(portfolio) as { id: string; name: string; status: string }[];
  return accounts.map(account => {
    const value: CapabilitySummary = { account_id: account.id, account_name: account.name, account_status: account.status, buy: "unknown", sell: "unknown", capability_id: null, valid_until: null, reason: "ACCOUNT_CAPABILITY_UNVERIFIED", executable: false };
    const rows = db.prepare("SELECT * FROM account_capabilities WHERE account_id=? AND market=? ORDER BY valid_from DESC,id LIMIT 1001").all(account.id, listing.market) as { id: string; rules_json: string; valid_from: string; valid_to: string | null; evidence_id: string; approved_by: string }[];
    let active: typeof rows;
    try { active = rows.filter(row => catalogInstant(row.valid_from) <= catalogInstant(now) && (row.valid_to === null || catalogInstant(row.valid_to) > catalogInstant(now))); }
    catch { value.reason = "ACCOUNT_CAPABILITY_EVIDENCE_UNVERIFIED"; return value; }
    if (!active.length) { if (rows.some(row => row.valid_to !== null && catalogInstant(row.valid_to) <= catalogInstant(now))) { value.buy = "expired"; value.sell = "expired"; value.reason = "ACCOUNT_CAPABILITY_EXPIRED"; } return value; }
    if (active.length !== 1 || rows.length > 1000) { value.reason = "ACCOUNT_CAPABILITY_AMBIGUOUS"; return value; }
    const row = active[0];
    try {
      const rules = capabilitiesSchema.parse(parseStrictJson(row.rules_json));
      if (!row.approved_by || !rules.currencies.includes(listing.currency) || !rules.listing_ids.includes(listing.listing_id)) return value;
      const approvals = db.prepare("SELECT actor_id,payload_json FROM audit_events WHERE portfolio_id=? AND action='approve_account_capability' AND object_type='governance' AND json_extract(payload_json,'$.result.id')=? LIMIT 2").all(portfolio, row.id) as { actor_id: string; payload_json: string }[];
      if (approvals.length !== 1) return value;
      const approval = parseStrictJson(approvals[0].payload_json) as { input?: Record<string, unknown>; result?: Record<string, unknown> };
      if (approvals[0].actor_id !== row.approved_by || approval.input?.portfolio_id !== portfolio || approval.input?.account_id !== account.id || approval.input?.market !== listing.market || approval.input?.attachment_id !== row.evidence_id || approval.input?.valid_until !== row.valid_to || canonical(approval.input?.rules) !== canonical(rules)) return value;
      readJsonAttachment(db, { id: "catalog-read" }, portfolio, row.evidence_id, { accountId: account.id, dataDir: process.env.WORKBENCH_DATA_DIR ?? path.dirname(db.name) });
      value.capability_id = row.id; value.valid_until = row.valid_to;
      value.buy = rules.buy ? "verified_scope" : "denied"; value.sell = rules.sell ? "verified_scope" : "denied";
      value.reason = "SCOPE_ONLY_NOT_TRADE_AUTHORIZATION";
    } catch { value.reason = "ACCOUNT_CAPABILITY_EVIDENCE_UNVERIFIED"; }
    return value;
  });
}
export function catalogDetail(db: Database.Database, raw: z.infer<typeof detailSchema>) {
  const parsed = detailSchema.safeParse(raw);
  if (!parsed.success) throw new Error("CATALOG_INVALID_QUERY");
  const input = parsed.data, now = catalogClock({ now: input.now });
  return readSnapshot(db, () => {
    assertCatalogPortfolio(db, input.portfolio_id); assertCatalogEntry(db, input.portfolio_id, input.listing_id);
    const row = current(db, input.portfolio_id, input.listing_id);
    const profiles = db.prepare(profileSelect + " ORDER BY version DESC LIMIT 101").all(input.portfolio_id, input.listing_id) as ProfileRow[];
    const holdings = db.prepare(holdingsSelect + " ORDER BY version DESC LIMIT 101").all(input.portfolio_id, input.listing_id) as HoldingsRow[];
    const sourceIds = db.prepare("SELECT id FROM catalog_sources WHERE portfolio_id=? ORDER BY known_at DESC,id LIMIT 101").all(input.portfolio_id) as { id: string }[];
    const sources = sourceIds.slice(0, 100).map(value => { const source = readCatalogSource(db, input.portfolio_id, value.id); return { id: source.id, reference: source.reference, content_hash: source.content_hash, known_at: source.known_at }; });
    const accountCapabilities = capabilities(db, input.portfolio_id, row, now);
    return { ...row, portfolio_id: input.portfolio_id, catalog_revision: catalogRevision(db, input.portfolio_id), read_only: catalogReadOnly(db), research_only: true as const,
      sources, sources_truncated: sourceIds.length > 100, profile_versions: profiles.slice(0, 100).map(value => profileVersion(db, value)), profile_versions_truncated: profiles.length > 100,
      holdings_versions: holdings.slice(0, 100).map(value => holdingsSummary(holdingsVersion(db, value))), holdings_versions_truncated: holdings.length > 100,
      account_capabilities: accountCapabilities, account_capabilities_truncated: !!db.prepare("SELECT 1 FROM accounts WHERE portfolio_id=? LIMIT 1 OFFSET 1000").get(input.portfolio_id), as_of: now, resource_hash: hash({ row, accountCapabilities }) };
  });
}

const comparisonSchema = z.object({ portfolio_id: id, expected_catalog_revision: z.number().int().nonnegative().safe(), selections: z.array(z.object({ listing_id: id, profile_version_id: id.optional(), holdings_version_id: id.optional() }).strict()).min(2).max(4) }).strict();
export function compareCatalog(db: Database.Database, raw: unknown, clock?: string) {
  const parsed = comparisonSchema.safeParse(raw);
  if (!parsed.success || new Set(parsed.data.selections.map(value => value.listing_id)).size !== parsed.data.selections.length) throw new Error("CATALOG_INVALID_COMPARISON");
  const input = parsed.data, now = catalogClock({ now: clock });
  return readSnapshot(db, () => {
    const revision = catalogRevision(db, input.portfolio_id);
    if (revision !== input.expected_catalog_revision) throw new Error("CATALOG_VERSION_CONFLICT");
    const snapshots = new Map<string, HoldingsSnapshot | null>();
    const rows = input.selections.map(selection => {
      assertCatalogEntry(db, input.portfolio_id, selection.listing_id);
      let profile: ProfileRow | undefined, holdings: HoldingsRow | undefined;
      if (selection.profile_version_id) {
        profile = db.prepare("SELECT * FROM etf_profile_versions WHERE id=?").get(selection.profile_version_id) as ProfileRow | undefined;
        if (!profile) throw new Error("CATALOG_VERSION_NOT_FOUND");
        if (profile.portfolio_id !== input.portfolio_id || profile.listing_id !== selection.listing_id) throw new Error("CATALOG_VERSION_OUT_OF_SCOPE");
      } else profile = db.prepare(profileSelect + " ORDER BY version DESC LIMIT 1").get(input.portfolio_id, selection.listing_id) as ProfileRow | undefined;
      if (selection.holdings_version_id) {
        holdings = db.prepare("SELECT * FROM etf_holdings_versions WHERE id=?").get(selection.holdings_version_id) as HoldingsRow | undefined;
        if (!holdings) throw new Error("CATALOG_VERSION_NOT_FOUND");
        if (holdings.portfolio_id !== input.portfolio_id || holdings.listing_id !== selection.listing_id) throw new Error("CATALOG_VERSION_OUT_OF_SCOPE");
      } else holdings = db.prepare(holdingsSelect + " ORDER BY version DESC LIMIT 1").get(input.portfolio_id, selection.listing_id) as HoldingsRow | undefined;
      for (const version of [profile, holdings]) if (version && (catalogInstant(version.known_at) > catalogInstant(now) || version.as_of > now.slice(0, 10))) throw new Error("CATALOG_FUTURE_DISCLOSURE");
      const snapshot = holdings ? holdingsVersion(db, holdings) : null;
      snapshots.set(selection.listing_id, snapshot);
      return { ...identity(db, selection.listing_id), profile: profile ? profileVersion(db, profile) : null, holdings: snapshot ? holdingsSummary(snapshot) : null };
    });
    const pairs: { listing_a: string; listing_b: string; overlap: HoldingsOverlap | null; issues: string[] }[] = [];
    for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) {
      const left = snapshots.get(rows[a].listing_id)!, right = snapshots.get(rows[b].listing_id)!;
      const overlap = left && right ? compareHoldings(left, right, now) : null;
      pairs.push({ listing_a: rows[a].listing_id, listing_b: rows[b].listing_id, overlap, issues: overlap?.issues ?? [!left ? "HOLDINGS_NOT_DISCLOSED:A" : "", !right ? "HOLDINGS_NOT_DISCLOSED:B" : ""].filter(Boolean) });
    }
    return { portfolio_id: input.portfolio_id, catalog_revision: revision, comparison_at: now, rows, pairs, research_only: true as const, resource_hash: hash({ portfolio_id: input.portfolio_id, revision, rows, pairs, comparison_at: now }) };
  });
}
export type CatalogWorkspace = ReturnType<typeof catalogWorkspace>;
export type CatalogDetail = ReturnType<typeof catalogDetail>;
export type CatalogComparison = ReturnType<typeof compareCatalog>;
