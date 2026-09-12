import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { assertWritableDatabase } from "../workbench-db";
import { audit, canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { addCatalogEntrySchema, catalogInstantSchema, storeCatalogSourceSchema, publishEtfProfileSchema, publishEtfHoldingsSchema } from "./schemas";
import { disclosureHash } from "./overlap";

export interface CatalogActor { id: string; kind: "human" | "ai" | "worker" | "strategy" }
export interface CatalogOptions { now?: string }
export const CATALOG_CLIENT_ERRORS = new Set([
  "CATALOG_PERMISSION_DENIED", "CATALOG_INVALID_COMMAND", "CATALOG_INVALID_CLOCK", "CATALOG_INVALID_SOURCE", "CATALOG_SOURCE_TOO_LARGE",
  "CATALOG_PORTFOLIO_NOT_FOUND", "CATALOG_LISTING_NOT_FOUND", "CATALOG_ENTRY_NOT_FOUND", "CATALOG_SOURCE_NOT_FOUND", "CATALOG_VERSION_NOT_FOUND",
  "CATALOG_SOURCE_OUT_OF_SCOPE", "CATALOG_VERSION_OUT_OF_SCOPE", "CATALOG_VERSION_CONFLICT", "CATALOG_DUPLICATE_CONFLICT", "CATALOG_ENTRY_CONFLICT",
  "CATALOG_CURSOR_STALE", "CATALOG_INVALID_CURSOR", "CATALOG_INVALID_QUERY", "CATALOG_INVALID_COMPARISON", "CATALOG_FUTURE_DISCLOSURE",
  "CATALOG_INVALID_PROFILE", "CATALOG_INVALID_HOLDINGS",
]);
export function isCatalogClientError(code: string) { return CATALOG_CLIENT_ERRORS.has(code); }
export function catalogClock(options: CatalogOptions = {}) {
  if (options.now !== undefined && !catalogInstantSchema.safeParse(options.now).success) throw new Error("CATALOG_INVALID_CLOCK");
  const date = new Date(options.now ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("CATALOG_INVALID_CLOCK");
  return date.toISOString();
}
export function catalogInstant(value: string): bigint {
  if (!catalogInstantSchema.safeParse(value).success) throw new Error("CATALOG_INVALID_CLOCK");
  return BigInt(Date.parse(`${value.slice(0, 19)}Z`)) * 1000n + BigInt((value.match(/\.([0-9]+)Z$/)?.[1] ?? "").padEnd(6, "0"));
}
export function assertCatalogPortfolio(db: Database.Database, portfolio: string) {
  if (!db.prepare("SELECT 1 FROM portfolios WHERE id=?").get(portfolio)) throw new Error("CATALOG_PORTFOLIO_NOT_FOUND");
}
export function catalogRevision(db: Database.Database, portfolio: string) {
  assertCatalogPortfolio(db, portfolio);
  return (db.prepare("SELECT revision FROM catalog_heads WHERE portfolio_id=?").get(portfolio) as { revision: number } | undefined)?.revision ?? 0;
}
export function assertCatalogEntry(db: Database.Database, portfolio: string, listing: string) {
  if (!db.prepare("SELECT 1 FROM catalog_entries WHERE portfolio_id=? AND listing_id=?").get(portfolio, listing)) throw new Error("CATALOG_ENTRY_NOT_FOUND");
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error("CATALOG_INVALID_COMMAND");
  return result.data;
}
type Envelope = { portfolio_id: string; expected_catalog_revision: number; idempotency_key: string };
function transact<T extends Envelope, R extends { id: string }>(db: Database.Database, actor: CatalogActor, operation: string, input: T, options: CatalogOptions, effect: (now: string) => R): R & { catalog_revision: number; audit_id: string; research_only: true; duplicate?: true } {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  if (actor.kind !== "human") throw new Error("CATALOG_PERMISSION_DENIED");
  assertWritableDatabase(db);
  const now = catalogClock(options), semantic = { ...input } as Record<string, unknown>;
  for (const key of ["expected_catalog_revision", "expected_profile_version", "expected_holdings_version", "idempotency_key"]) delete semantic[key];
  const digest = hash(semantic), scope = `catalog:${input.portfolio_id}:${operation}`;
  return db.transaction(() => {
    assertWritableDatabase(db);
    const head = catalogRevision(db, input.portfolio_id);
    const previous = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, input.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (previous) {
      if (previous.payload_hash !== digest) throw new Error("CATALOG_DUPLICATE_CONFLICT");
      assertWritableDatabase(db);
      return { ...JSON.parse(previous.result_json), duplicate: true };
    }
    if (head !== input.expected_catalog_revision) throw new Error("CATALOG_VERSION_CONFLICT");
    const outcome = effect(now), next = head + 1;
    db.prepare("INSERT INTO catalog_heads(portfolio_id,revision,updated_at) VALUES(?,?,?) ON CONFLICT(portfolio_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at").run(input.portfolio_id, next, now);
    const result = { ...outcome, catalog_revision: next, research_only: true as const };
    const auditId = audit(db, actor, operation, "catalog", outcome.id, input.portfolio_id, null, { input_hash: digest, result }, now);
    const receipt = { ...result, audit_id: auditId };
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, input.idempotency_key, digest, canonical(receipt), now);
    assertWritableDatabase(db);
    return receipt;
  }).immediate();
}
export function addCatalogEntry(db: Database.Database, actor: CatalogActor, raw: unknown, options: CatalogOptions = {}) {
  const input = parse(addCatalogEntrySchema, raw);
  return transact(db, actor, "add_catalog_entry", input, options, now => {
    if (!db.prepare("SELECT 1 FROM listings WHERE id=?").get(input.listing_id)) throw new Error("CATALOG_LISTING_NOT_FOUND");
    if (db.prepare("SELECT 1 FROM catalog_entries WHERE portfolio_id=? AND listing_id=?").get(input.portfolio_id, input.listing_id)) throw new Error("CATALOG_ENTRY_CONFLICT");
    db.prepare("INSERT INTO catalog_entries(portfolio_id,listing_id,created_at) VALUES(?,?,?)").run(input.portfolio_id, input.listing_id, now);
    return { id: input.listing_id, listing_id: input.listing_id };
  });
}
const sourceHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export interface CatalogSource { id: string; portfolio_id: string; reference: string; media_type: string; content_text: string; content_hash: string; known_at: string; created_by: string }
export function readCatalogSource(db: Database.Database, portfolio: string, id: string): CatalogSource {
  assertCatalogPortfolio(db, portfolio);
  const row = db.prepare("SELECT * FROM catalog_sources WHERE id=?").get(id) as CatalogSource | undefined;
  if (!row) throw new Error("CATALOG_SOURCE_NOT_FOUND");
  if (row.portfolio_id !== portfolio) throw new Error("CATALOG_SOURCE_OUT_OF_SCOPE");
  let document: unknown;
  try { document = parseStrictJson(row.content_text); } catch { throw new Error("CATALOG_SOURCE_INTEGRITY_FAILED"); }
  if (!document || typeof document !== "object" || Array.isArray(document) || row.media_type !== "application/json" || sourceHash(row.content_text) !== row.content_hash || Buffer.byteLength(row.content_text, "utf8") > 1048576 || !catalogInstantSchema.safeParse(row.known_at).success || !row.created_by?.trim() || !row.reference?.trim()) throw new Error("CATALOG_SOURCE_INTEGRITY_FAILED");
  return row;
}
export function storeCatalogSource(db: Database.Database, actor: CatalogActor, raw: unknown, options: CatalogOptions = {}) {
  const input = parse(storeCatalogSourceSchema, raw);
  const content = canonical(input.document);
  if (Buffer.byteLength(content, "utf8") > 1048576) throw new Error("CATALOG_SOURCE_TOO_LARGE");
  try { parseStrictJson(content); } catch { throw new Error("CATALOG_INVALID_SOURCE"); }
  return transact(db, actor, "store_catalog_source", input, options, now => {
    const id = randomUUID(), digest = sourceHash(content);
    db.prepare("INSERT INTO catalog_sources(id,portfolio_id,reference,media_type,content_text,content_hash,known_at,created_by) VALUES(?,?,?,'application/json',?,?,?,?)").run(id, input.portfolio_id, input.reference, content, digest, now, actor.id);
    return { id, source_id: id, content_hash: digest, known_at: now };
  });
}
function checkPublication(db: Database.Database, portfolio: string, listing: string, source: string, asOf: string, now: string) {
  assertCatalogEntry(db, portfolio, listing);
  const evidence = readCatalogSource(db, portfolio, source);
  if (asOf > now.slice(0, 10) || catalogInstant(evidence.known_at) > catalogInstant(now)) throw new Error("CATALOG_FUTURE_DISCLOSURE");
}
export function publishCatalogProfile(db: Database.Database, actor: CatalogActor, raw: unknown, options: CatalogOptions = {}) {
  const input = parse(publishEtfProfileSchema, raw);
  return transact(db, actor, "publish_catalog_profile", input, options, now => {
    checkPublication(db, input.portfolio_id, input.listing_id, input.source_id, input.as_of, now);
    const previous = (db.prepare("SELECT MAX(version) version FROM etf_profile_versions WHERE portfolio_id=? AND listing_id=?").get(input.portfolio_id, input.listing_id) as { version: number | null }).version ?? 0;
    if (previous !== input.expected_profile_version) throw new Error("CATALOG_VERSION_CONFLICT");
    const id = randomUUID(), version = previous + 1;
    const digest = hash({ portfolio_id: input.portfolio_id, listing_id: input.listing_id, version, source_id: input.source_id, as_of: input.as_of, known_at: now, profile: input.profile });
    db.prepare("INSERT INTO etf_profile_versions(id,portfolio_id,listing_id,version,source_id,as_of,known_at,profile_json,content_hash,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, input.portfolio_id, input.listing_id, version, input.source_id, input.as_of, now, canonical(input.profile), digest, actor.id);
    return { id, listing_id: input.listing_id, version, content_hash: digest };
  });
}
export function publishCatalogHoldings(db: Database.Database, actor: CatalogActor, raw: unknown, options: CatalogOptions = {}) {
  const input = parse(publishEtfHoldingsSchema, raw);
  return transact(db, actor, "publish_catalog_holdings", input, options, now => {
    checkPublication(db, input.portfolio_id, input.listing_id, input.source_id, input.as_of, now);
    const previous = (db.prepare("SELECT MAX(version) version FROM etf_holdings_versions WHERE portfolio_id=? AND listing_id=?").get(input.portfolio_id, input.listing_id) as { version: number | null }).version ?? 0;
    if (previous !== input.expected_holdings_version) throw new Error("CATALOG_VERSION_CONFLICT");
    const id = randomUUID(), version = previous + 1;
    const snapshot = { schema_version: "holdings-disclosure-v1", snapshot_id: id, portfolio_id: input.portfolio_id, listing_id: input.listing_id, version, as_of: input.as_of, known_at: now, weight_basis: input.weight_basis, complete: input.complete, coverage: input.coverage, items: [...input.items].sort((a, b) => a.security_id < b.security_id ? -1 : a.security_id > b.security_id ? 1 : 0) };
    const digest = disclosureHash({ ...snapshot, content_hash: null }), document = { ...snapshot, content_hash: digest };
    db.prepare("INSERT INTO etf_holdings_versions(id,portfolio_id,listing_id,version,source_id,as_of,known_at,snapshot_json,content_hash,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, input.portfolio_id, input.listing_id, version, input.source_id, input.as_of, now, canonical(document), digest, actor.id);
    return { id, listing_id: input.listing_id, version, content_hash: digest };
  });
}
export function catalogReadOnly(db: Database.Database) {
  try { assertWritableDatabase(db); return false; } catch (error) {
    if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") return true;
    throw error;
  }
}
