import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { z } from "zod";
import common from "../../../../contracts/v1/common.schema.json";
import factsSchema from "../../../../contracts/v1/market-reference-facts.schema.json";
import versionSchema from "../../../../contracts/v1/market-reference-version.schema.json";
import collectSchema from "../../../../contracts/v1/market-price-collect.schema.json";
import { audit, canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { assertWritableDatabase } from "../workbench-db";

export type ReferenceActor = { id: string; kind: "human" | "ai" | "worker" | "strategy" };
export type ReferenceOptions = { now?: string };
export type MappingFacts = { provider: "longport"; listing_id: string; provider_symbol: string; market: "CN" | "HK" | "US"; exchange: string; currency: string; valid_from: string; valid_to: string | null };
export type CalendarFacts = { market: "CN" | "HK" | "US"; exchange: string; timezone: string; range_start: string; range_end: string; days: { date: string; kind: "full" | "half" | "closed"; close_at: string | null }[] };
export type ReferenceDocument = { kind: "mapping"; facts: MappingFacts } | { kind: "calendar"; facts: CalendarFacts };
export type ReferenceVersionDocument = { schema_version: "market-reference-version-v1"; id: string; portfolio_id: string; kind: "mapping" | "calendar"; scope_key: string; version: number; source_id: string; source_hash: string; source_known_at: string; known_at: string; created_by: string; review_reason: string; review_basis: "human_reviewed_not_provider_verified"; facts: MappingFacts | CalendarFacts };
export type ReferenceSource = { id: string; portfolio_id: string; reference: string; content_text: string; content_hash: string; known_at: string; created_by: string };
export type ReferenceVersion = { id: string; portfolio_id: string; kind: "mapping" | "calendar"; scope_key: string; version: number; source_id: string; source_hash: string; known_at: string; document_json: string; content_hash: string; audit_id: string; created_by: string };
type AuditRow = { id: string; actor_id: string; action: string; object_type: string; object_id: string; portfolio_id: string; ledger_revision: null; payload_json: string; created_at: string };
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const text = z.string().min(1).max(2000).refine(value => value.trim().length > 0);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const storeReferenceSchema = z.object({ portfolio_id: id, idempotency_key: id, reference: text, content_text: z.string().min(1).max(1048576) }).strict();
export const publishReferenceSchema = z.object({ portfolio_id: id, idempotency_key: id, expected_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), source_id: id, source_hash: sha, review_reason: text, acknowledgement: z.literal(true), document: z.unknown() }).strict();
const ajv = new Ajv2020({ strict: true, strictRequired: false }); addFormats(ajv); ajv.addSchema(common); ajv.addSchema(factsSchema);
const validFacts = ajv.getSchema(factsSchema.$id)!, validVersion = ajv.compile(versionSchema);
const validCollect = ajv.compile(collectSchema);
const CLIENT_ERRORS = new Set(["REFERENCE_PERMISSION_DENIED", "REFERENCE_INVALID_COMMAND", "REFERENCE_INVALID_CLOCK", "REFERENCE_INVALID_SOURCE", "REFERENCE_SOURCE_TOO_LARGE", "REFERENCE_PORTFOLIO_NOT_FOUND", "REFERENCE_SOURCE_NOT_FOUND", "REFERENCE_VERSION_NOT_FOUND", "REFERENCE_SOURCE_OUT_OF_SCOPE", "REFERENCE_VERSION_OUT_OF_SCOPE", "REFERENCE_VERSION_CONFLICT", "REFERENCE_DUPLICATE_CONFLICT", "REFERENCE_SOURCE_CONFLICT", "REFERENCE_INVALID_MAPPING", "REFERENCE_INVALID_CALENDAR", "REFERENCE_LISTING_NOT_FOUND", "REFERENCE_CATALOG_ENTRY_REQUIRED", "REFERENCE_INVALID_QUERY"]);
export const isReferenceClientError = (code: string) => CLIENT_ERRORS.has(code);
const bytesHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export function referenceInstant(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(value);
  if (!match || value.startsWith("0000")) throw new Error("REFERENCE_INVALID_CLOCK");
  const millis = Date.parse(match[1] + "Z");
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== match[1]) throw new Error("REFERENCE_INVALID_CLOCK");
  return BigInt(millis) * 1000n + BigInt(match[2]);
}
export function referenceClock(options: ReferenceOptions = {}) {
  const value = options.now ?? new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
  referenceInstant(value); return value;
}
export function referenceReadOnly(db: Database.Database) {
  try { assertWritableDatabase(db); return false; } catch (error) { if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") return true; throw error; }
}
function requirePortfolio(db: Database.Database, portfolio: string) {
  if (!db.prepare("SELECT 1 FROM portfolios WHERE id=?").get(portfolio)) throw new Error("REFERENCE_PORTFOLIO_NOT_FOUND");
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T { const value = schema.safeParse(raw); if (!value.success) throw new Error("REFERENCE_INVALID_COMMAND"); return value.data; }
function sourceDocument(content: string) {
  if (Buffer.byteLength(content, "utf8") > 1048576) throw new Error("REFERENCE_SOURCE_TOO_LARGE");
  if (Buffer.from(content, "utf8").toString("utf8") !== content || content.startsWith("\uFEFF")) throw new Error("REFERENCE_INVALID_SOURCE");
  let value: unknown; try { value = parseStrictJson(content); } catch { throw new Error("REFERENCE_INVALID_SOURCE"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("REFERENCE_INVALID_SOURCE");
  return value;
}
export function referenceScope(document: ReferenceDocument) { return document.kind === "mapping" ? document.facts.listing_id : `${document.facts.market}:${document.facts.exchange}`; }
const zones = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" };
function localDate(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}
export function validateReferenceDocument(db: Database.Database, portfolio: string, raw: unknown): ReferenceDocument {
  if (!validFacts(raw)) throw new Error("REFERENCE_INVALID_COMMAND");
  const document = raw as ReferenceDocument;
  if (document.kind === "mapping") {
    const f = document.facts;
    const listing = db.prepare("SELECT market,exchange,currency,created_at FROM listings WHERE id=?").get(f.listing_id) as { market: string; exchange: string; currency: string; created_at: string } | undefined;
    if (!listing) throw new Error("REFERENCE_LISTING_NOT_FOUND");
    const entry = db.prepare("SELECT created_at FROM catalog_entries WHERE portfolio_id=? AND listing_id=?").get(portfolio, f.listing_id) as { created_at: string } | undefined;
    if (!entry) throw new Error("REFERENCE_CATALOG_ENTRY_REQUIRED");
    for (const value of [listing.created_at, entry.created_at]) {
      const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
      if (!match) throw new Error("REFERENCE_INVALID_MAPPING");
      try { referenceInstant(`${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`); } catch { throw new Error("REFERENCE_INVALID_MAPPING"); }
    }
    const symbols = { CN: /^[0-9]{6}\.(SH|SZ)$/, HK: /^[0-9]{1,5}\.HK$/, US: /^[A-Z][A-Z0-9]{0,14}(?:[.-][A-Z0-9]{1,5})?\.US$/ };
    const currencies = { CN: ["CNY"], HK: ["HKD", "CNY", "USD"], US: ["USD"] };
    if (listing.market !== f.market || listing.exchange !== f.exchange || listing.currency !== f.currency || (f.valid_to !== null && f.valid_to <= f.valid_from)
      || !symbols[f.market].test(f.provider_symbol) || !currencies[f.market].includes(f.currency)) throw new Error("REFERENCE_INVALID_MAPPING");
  } else {
    const f = document.facts;
    if (f.timezone !== zones[f.market] || f.range_end < f.range_start) throw new Error("REFERENCE_INVALID_CALENDAR");
    const count = (Date.parse(f.range_end + "T00:00:00Z") - Date.parse(f.range_start + "T00:00:00Z")) / 86400000 + 1;
    if (count !== f.days.length) throw new Error("REFERENCE_INVALID_CALENDAR");
    for (let i = 0; i < count; i++) {
      const day = f.days[i], expected = new Date(Date.parse(f.range_start + "T00:00:00Z") + i * 86400000).toISOString().slice(0, 10);
      if (day.date !== expected || (day.kind === "closed" ? day.close_at !== null : !day.close_at || localDate(day.close_at, f.timezone) !== day.date)) throw new Error("REFERENCE_INVALID_CALENDAR");
      if (day.close_at !== null) referenceInstant(day.close_at);
    }
  }
  if (!id.safeParse(referenceScope(document)).success) throw new Error("REFERENCE_INVALID_COMMAND");
  return document;
}
function transact<T>(db: Database.Database, actor: ReferenceActor, operation: string, portfolio: string, key: string, semantic: unknown, options: ReferenceOptions, effect: (now: string) => T): T {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  if (actor.kind !== "human") throw new Error("REFERENCE_PERMISSION_DENIED");
  assertWritableDatabase(db);
  const now = referenceClock(options), digest = hash(semantic), scope = `market-reference:${portfolio}:${actor.id}:${operation}`;
  return db.transaction(() => {
    assertWritableDatabase(db); requirePortfolio(db, portfolio);
    const previous = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, key) as { payload_hash: string; result_json: string } | undefined;
    if (previous) { if (previous.payload_hash !== digest) throw new Error("REFERENCE_DUPLICATE_CONFLICT"); assertWritableDatabase(db); return JSON.parse(previous.result_json) as T; }
    const result = effect(now);
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, key, digest, canonical(result), now);
    assertWritableDatabase(db); return result;
  }).immediate();
}
export function storeMarketReferenceSource(db: Database.Database, actor: ReferenceActor, raw: unknown, options: ReferenceOptions = {}) {
  const input = parse(storeReferenceSchema, raw); sourceDocument(input.content_text);
  const { idempotency_key, ...semantic } = input;
  return transact(db, actor, "store_source", input.portfolio_id, idempotency_key, semantic, options, now => {
    const result = { id: randomUUID(), portfolio_id: input.portfolio_id, reference: input.reference, content_hash: bytesHash(input.content_text), known_at: now };
    db.prepare("INSERT INTO market_reference_sources(id,portfolio_id,reference,content_text,content_hash,known_at,created_by) VALUES(?,?,?,?,?,?,?)").run(result.id, result.portfolio_id, result.reference, input.content_text, result.content_hash, now, actor.id);
    const auditId = audit(db, actor, "store_market_reference_source", "market_reference_source", result.id, input.portfolio_id, null, { actor_kind: "human", input_hash: hash(semantic), result }, now);
    return { ...result, audit_id: auditId, verification_status: "unreviewed" as const };
  });
}
export function readMarketReferenceSource(db: Database.Database, portfolio: string, id: string): ReferenceSource {
  requirePortfolio(db, portfolio);
  const row = db.prepare("SELECT * FROM market_reference_sources WHERE id=?").get(id) as ReferenceSource | undefined;
  if (!row) throw new Error("REFERENCE_SOURCE_NOT_FOUND");
  if (row.portfolio_id !== portfolio) throw new Error("REFERENCE_SOURCE_OUT_OF_SCOPE");
  try {
    sourceDocument(row.content_text); referenceInstant(row.known_at);
    const event = db.prepare("SELECT * FROM audit_events WHERE action='store_market_reference_source' AND object_type='market_reference_source' AND object_id=?").all(id) as AuditRow[];
    const result = { id: row.id, portfolio_id: portfolio, reference: row.reference, content_hash: row.content_hash, known_at: row.known_at };
    if (bytesHash(row.content_text) !== row.content_hash || event.length !== 1 || event[0].actor_id !== row.created_by || event[0].portfolio_id !== portfolio || event[0].created_at !== row.known_at || event[0].ledger_revision !== null || canonical(parseStrictJson(event[0].payload_json)) !== canonical({ actor_kind: "human", input_hash: hash({ portfolio_id: portfolio, reference: row.reference, content_text: row.content_text }), result })) throw new Error();
    return row;
  } catch { throw new Error("REFERENCE_SOURCE_INTEGRITY_FAILED"); }
}
export function publishMarketReference(db: Database.Database, actor: ReferenceActor, raw: unknown, options: ReferenceOptions = {}) {
  const input = parse(publishReferenceSchema, raw);
  if (!validFacts(input.document)) throw new Error("REFERENCE_INVALID_COMMAND");
  const { expected_version: ignored, idempotency_key, ...semantic } = input; void ignored;
  return transact(db, actor, "publish_reference", input.portfolio_id, idempotency_key, semantic, options, now => {
    const document = validateReferenceDocument(db, input.portfolio_id, input.document), scope = referenceScope(document);
    const head = db.prepare("SELECT version,updated_at FROM market_reference_heads WHERE portfolio_id=? AND kind=? AND scope_key=?").get(input.portfolio_id, document.kind, scope) as { version: number; updated_at: string } | undefined;
    if ((head?.version ?? 0) !== input.expected_version) throw new Error("REFERENCE_VERSION_CONFLICT");
    const source = readMarketReferenceSource(db, input.portfolio_id, input.source_id);
    if (source.content_hash !== input.source_hash) throw new Error("REFERENCE_SOURCE_CONFLICT");
    if (referenceInstant(source.known_at) > referenceInstant(now) || (head && referenceInstant(head.updated_at) > referenceInstant(now))) throw new Error("REFERENCE_INVALID_CLOCK");
    const id = randomUUID(), version = input.expected_version + 1;
    const wrapper: ReferenceVersionDocument = { schema_version: "market-reference-version-v1", id, portfolio_id: input.portfolio_id, kind: document.kind, scope_key: scope, version, source_id: source.id, source_hash: source.content_hash, source_known_at: source.known_at, known_at: now, created_by: actor.id, review_reason: input.review_reason, review_basis: "human_reviewed_not_provider_verified", facts: document.facts };
    if (!validVersion(wrapper)) throw new Error("REFERENCE_INVALID_COMMAND");
    const result = { id, portfolio_id: input.portfolio_id, kind: document.kind, scope_key: scope, version, source_id: source.id, source_hash: source.content_hash, known_at: now, content_hash: hash(wrapper), verification_status: "human_reviewed_not_provider_verified" as const };
    const auditId = audit(db, actor, "publish_market_reference", "market_reference", id, input.portfolio_id, null, { actor_kind: "human", input, result }, now);
    db.prepare("INSERT INTO market_reference_versions(id,portfolio_id,kind,scope_key,version,source_id,source_hash,known_at,document_json,content_hash,audit_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, input.portfolio_id, document.kind, scope, version, source.id, source.content_hash, now, canonical(wrapper), result.content_hash, auditId, actor.id);
    if (head) db.prepare("UPDATE market_reference_heads SET version=?,version_id=?,updated_at=? WHERE portfolio_id=? AND kind=? AND scope_key=? AND version=?").run(version, id, now, input.portfolio_id, document.kind, scope, input.expected_version);
    else db.prepare("INSERT INTO market_reference_heads(portfolio_id,kind,scope_key,version,version_id,updated_at) VALUES(?,?,?,?,?,?)").run(input.portfolio_id, document.kind, scope, version, id, now);
    return { ...result, audit_id: auditId };
  });
}
export function readMarketReferenceVersion(db: Database.Database, portfolio: string, id: string) {
  requirePortfolio(db, portfolio);
  const row = db.prepare("SELECT * FROM market_reference_versions WHERE id=?").get(id) as ReferenceVersion | undefined;
  if (!row) throw new Error("REFERENCE_VERSION_NOT_FOUND");
  if (row.portfolio_id !== portfolio) throw new Error("REFERENCE_VERSION_OUT_OF_SCOPE");
  try {
    const document = parseStrictJson(row.document_json) as ReferenceVersionDocument;
    if (!validVersion(document) || hash(document) !== row.content_hash) throw new Error();
    const source = readMarketReferenceSource(db, portfolio, row.source_id);
    const fields = ["id", "portfolio_id", "kind", "scope_key", "version", "source_id", "source_hash", "known_at", "created_by"] as const;
    if (fields.some(key => document[key] !== row[key]) || document.source_known_at !== source.known_at || document.source_hash !== source.content_hash || referenceInstant(source.known_at) > referenceInstant(row.known_at)) throw new Error();
    const input = validateReferenceDocument(db, portfolio, { kind: document.kind, facts: document.facts });
    if (referenceScope(input) !== row.scope_key) throw new Error();
    const event = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as AuditRow | undefined;
    if (!event || event.action !== "publish_market_reference" || event.object_type !== "market_reference" || event.object_id !== row.id || event.actor_id !== row.created_by || event.portfolio_id !== portfolio || event.created_at !== row.known_at || event.ledger_revision !== null) throw new Error();
    const payload = parseStrictJson(event.payload_json) as Record<string, unknown>;
    const command = parse(publishReferenceSchema, payload.input);
    const result = { id: row.id, portfolio_id: portfolio, kind: row.kind, scope_key: row.scope_key, version: row.version, source_id: row.source_id, source_hash: row.source_hash, known_at: row.known_at, content_hash: row.content_hash, verification_status: "human_reviewed_not_provider_verified" };
    if (command.portfolio_id !== portfolio || command.expected_version !== row.version - 1 || command.source_id !== source.id || command.source_hash !== source.content_hash || command.review_reason !== document.review_reason || canonical(command.document) !== canonical(input) || canonical(payload) !== canonical({ actor_kind: "human", input: command, result })) throw new Error();
    return { row, document, source, audit: event };
  } catch { throw new Error("REFERENCE_VERSION_INTEGRITY_FAILED"); }
}
export type PriceCollectRequest = { schema_version: "market-price-collect-v1"; provider: "longport"; mapping_version_ids: string[]; calendar_version_ids: string[]; start_date: string; end_date: string; expected_publication_revision: number; publish: boolean };
export function validatePriceCollectRequest(db: Database.Database, portfolio: string, raw: unknown, knownAt: string): PriceCollectRequest {
  if (!validCollect(raw)) throw new Error("INVALID_MARKET_PRICE_COLLECT");
  const input = raw as PriceCollectRequest;
  const count = (Date.parse(input.end_date + "T00:00:00Z") - Date.parse(input.start_date + "T00:00:00Z")) / 86400000 + 1;
  if (count < 1 || count > 31) throw new Error("INVALID_MARKET_PRICE_COLLECT");
  const now = knownAt.replace(/\.(\d{3})Z$/, ".$1000Z"); referenceInstant(now);
  const load = (id: string, kind: string) => {
    const proof = readMarketReferenceVersion(db, portfolio, id);
    const head = db.prepare("SELECT version_id FROM market_reference_heads WHERE portfolio_id=? AND kind=? AND scope_key=?").get(portfolio, kind, proof.row.scope_key) as { version_id: string } | undefined;
    if (proof.row.kind !== kind || head?.version_id !== id || referenceInstant(proof.row.known_at) > referenceInstant(now)) throw new Error("REFERENCE_VERSION_CONFLICT");
    return proof;
  };
  const mappings = input.mapping_version_ids.map(id => load(id, "mapping")), calendars = input.calendar_version_ids.map(id => load(id, "calendar"));
  const market = mappings[0].document.facts.market, used = new Set<string>(), listings = new Set<string>();
  if (input.end_date >= localDate(now, zones[market])) throw new Error("INVALID_MARKET_PRICE_COLLECT");
  for (const mapping of mappings) {
    const facts = mapping.document.facts as MappingFacts;
    if (facts.market !== market || listings.has(facts.listing_id) || facts.valid_from > input.start_date || (facts.valid_to !== null && facts.valid_to <= input.end_date)) throw new Error("INVALID_MARKET_PRICE_COLLECT");
    listings.add(facts.listing_id);
    const candidates = calendars.filter(row => row.document.facts.market === market && row.document.facts.exchange === facts.exchange);
    if (candidates.length !== 1) throw new Error("INVALID_MARKET_PRICE_COLLECT");
    const calendar = candidates[0].document.facts as CalendarFacts;
    if (calendar.range_start > input.start_date || calendar.range_end < input.end_date || !calendar.days.some(day => day.date >= input.start_date && day.date <= input.end_date && day.kind !== "closed")) throw new Error("INVALID_MARKET_PRICE_COLLECT");
    used.add(candidates[0].row.id);
  }
  if (used.size !== calendars.length) throw new Error("INVALID_MARKET_PRICE_COLLECT");
  return input;
}
