import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import common from "../../../../contracts/v1/common.schema.json";
import contract from "../../../../contracts/v1/listing-review.schema.json";
import { audit, canonical, hash } from "../ledger/service";
import { readMarketReferenceSource, referenceClock, referenceInstant, type ReferenceActor, type ReferenceOptions } from "../market-references/service";
import { assertWritableDatabase } from "../workbench-db";
import { parseStrictJson } from "../strict-json";
import { listingIdentitySchema, listingReviewFactsSchema, publishListingReviewSchema, reviewId, type ListingIdentity, type ListingReviewFacts } from "./schemas";
import type { ListingReviewDocument, ListingReviewReceipt, ListingReviewRow, ReviewedListing } from "./types";

const ajv = new Ajv2020({ strict: true, strictRequired: false }); addFormats(ajv); ajv.addSchema(common); const validDocument = ajv.compile(contract);
const invalid = () => new Error("LISTING_REVIEW_EVIDENCE_INVALID");
const clientErrors = new Set(["LISTING_REVIEW_INVALID_COMMAND", "LISTING_REVIEW_INVALID_QUERY", "LISTING_REVIEW_INVALID_CLOCK", "LISTING_REVIEW_PERMISSION_DENIED", "LISTING_REVIEW_OUT_OF_SCOPE", "LISTING_REVIEW_NOT_FOUND", "LISTING_REVIEW_PORTFOLIO_NOT_FOUND", "LISTING_REVIEW_VERSION_CONFLICT", "LISTING_REVIEW_IDENTITY_CONFLICT", "LISTING_REVIEW_SOURCE_CONFLICT", "LISTING_REVIEW_SOURCE_NOT_FOUND", "LISTING_REVIEW_SOURCE_OUT_OF_SCOPE", "LISTING_REVIEW_DUPLICATE_CONFLICT", "LISTING_REVIEW_CURSOR_STALE"]);
export const isListingReviewClientError = (code: string) => clientErrors.has(code);
type Head = { portfolio_id: string; listing_id: string; revision: number; version_id: string; updated_at: string };
type AuditRow = { id: string; actor_id: string; action: string; object_type: string; object_id: string; portfolio_id: string; ledger_revision: null; payload_json: string; created_at: string };
const human = (id: string) => reviewId.safeParse(id).success && !id.startsWith("system:");
export function listingReviewClock(options: ReferenceOptions = {}) { try { return referenceClock(options); } catch { throw new Error("LISTING_REVIEW_INVALID_CLOCK"); } }
function object(raw: string): Record<string, unknown> {
  try {
    if (Buffer.from(raw, "utf8").toString("utf8") !== raw || raw.startsWith("\uFEFF") || Buffer.byteLength(raw) > 4 * 1048576) throw invalid();
    const value = parseStrictJson(raw); if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(); return value as Record<string, unknown>;
  } catch { throw invalid(); }
}
function storedInstant(raw: string) {
  const value = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(raw);
  if (!value) throw invalid(); return referenceInstant(`${value[1]}.${(value[2] ?? "").padEnd(6, "0")}Z`);
}
export function currentListingIdentity(db: Database.Database, portfolio: string, listing: string): ListingIdentity {
  if (!reviewId.safeParse(portfolio).success || !reviewId.safeParse(listing).success) throw new Error("LISTING_REVIEW_INVALID_QUERY");
  if (!db.prepare("SELECT 1 FROM portfolios WHERE id=?").get(portfolio)) throw new Error("LISTING_REVIEW_PORTFOLIO_NOT_FOUND");
  if (!db.prepare("SELECT 1 FROM catalog_entries WHERE portfolio_id=? AND listing_id=?").get(portfolio, listing)) throw new Error("LISTING_REVIEW_OUT_OF_SCOPE");
  const row = db.prepare("SELECT id AS listing_id,instrument_id,market,exchange,ticker,currency FROM listings WHERE id=?").get(listing);
  const value = listingIdentitySchema.safeParse(row); if (!value.success) throw invalid(); return value.data;
}
function chronology(db: Database.Database, portfolio: string, listing: string, now: string) {
  const listingRow = db.prepare("SELECT created_at FROM listings WHERE id=?").get(listing) as { created_at: string };
  const entry = db.prepare("SELECT created_at FROM catalog_entries WHERE portfolio_id=? AND listing_id=?").get(portfolio, listing) as { created_at: string };
  if (storedInstant(listingRow.created_at) > referenceInstant(now) || storedInstant(entry.created_at) > referenceInstant(now)) throw invalid();
}
function localDate(now: string, market: ListingIdentity["market"]) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" }[market], year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  return ["year", "month", "day"].map(key => parts.find(p => p.type === key)!.value).join("-");
}
function validateFacts(facts: ListingReviewFacts, identity: ListingIdentity, now: string) {
  if (!listingReviewFactsSchema.safeParse(facts).success || (facts.source_effective_date !== null && facts.source_effective_date > localDate(now, identity.market))) throw new Error("LISTING_REVIEW_INVALID_COMMAND");
}
function headFor(db: Database.Database, portfolio: string, listing: string) {
  const latest = db.prepare("SELECT * FROM listing_review_versions WHERE portfolio_id=? AND listing_id=? ORDER BY revision DESC LIMIT 1").get(portfolio, listing) as ListingReviewRow | undefined;
  const head = db.prepare("SELECT * FROM listing_review_heads WHERE portfolio_id=? AND listing_id=?").get(portfolio, listing) as Head | undefined;
  if (latest ? !head || canonical(head) !== canonical({ portfolio_id: portfolio, listing_id: listing, revision: latest.revision, version_id: latest.id, updated_at: latest.known_at }) : !!head) throw invalid();
  return { latest, head };
}
function receipt(row: ListingReviewRow): Omit<ListingReviewReceipt, "audit_id"> { return { id: row.id, portfolio_id: row.portfolio_id, listing_id: row.listing_id, revision: row.revision, content_hash: row.content_hash, identity_hash: row.identity_hash, source_id: row.source_id, source_hash: row.source_hash, known_at: row.known_at, review_until: row.review_until, review_basis: "human_reviewed_not_provider_verified" }; }
export function readListingReviewVersion(db: Database.Database, portfolio: string, listing: string, versionId: string) {
  const identity = currentListingIdentity(db, portfolio, listing);
  const row = db.prepare("SELECT * FROM listing_review_versions WHERE id=?").get(versionId) as ListingReviewRow | undefined;
  if (!row) throw new Error("LISTING_REVIEW_NOT_FOUND");
  if (row.portfolio_id !== portfolio || row.listing_id !== listing) throw new Error("LISTING_REVIEW_OUT_OF_SCOPE");
  try {
    const document = object(row.document_json) as ListingReviewDocument;
    if (!validDocument(document) || !human(row.created_by) || hash(document) !== row.content_hash || canonical(document) !== row.document_json) throw invalid();
    for (const key of ["id", "portfolio_id", "listing_id", "revision", "source_id", "source_hash", "source_known_at", "identity_hash", "known_at", "created_by", "review_until", "reason"] as const) if (row[key] !== document[key]) throw invalid();
    if (canonical(document.identity_snapshot) !== row.identity_json || canonical(document.facts) !== row.facts_json || document.identity_snapshot.listing_id !== listing || hash(document.identity_snapshot) !== row.identity_hash || referenceInstant(row.review_until) <= referenceInstant(row.known_at)) throw invalid();
    validateFacts(document.facts, document.identity_snapshot, row.known_at); chronology(db, portfolio, listing, row.known_at);
    const source = readMarketReferenceSource(db, portfolio, row.source_id);
    if (!human(source.created_by) || source.content_hash !== row.source_hash || source.known_at !== row.source_known_at || referenceInstant(source.known_at) > referenceInstant(row.known_at)) throw invalid();
    const sourceAudit = db.prepare("SELECT * FROM audit_events WHERE action='store_market_reference_source' AND object_type='market_reference_source' AND object_id=?").get(source.id) as AuditRow;
    const reviews = db.prepare("SELECT * FROM audit_events WHERE object_type='listing_review' AND object_id=?").all(row.id) as AuditRow[];
    const event = reviews[0];
    if (reviews.length !== 1 || event.id !== row.audit_id || event.action !== "publish_listing_review" || event.actor_id !== row.created_by || event.portfolio_id !== portfolio || event.created_at !== row.known_at || event.ledger_revision !== null) throw invalid();
    const payload = object(event.payload_json) as Record<string, unknown>, input = publishListingReviewSchema.parse(payload.input);
    if (input.portfolio_id !== portfolio || input.listing_id !== listing || input.expected_review_revision !== row.revision - 1 || input.expected_identity_hash !== row.identity_hash || input.source_id !== source.id || input.source_hash !== source.content_hash || input.review_until !== row.review_until || input.reason !== row.reason || canonical(input.facts) !== row.facts_json || canonical(payload) !== canonical({ actor_kind: "human", input, result: receipt(row) })) throw invalid();
    const virtualHead: Head = { portfolio_id: portfolio, listing_id: listing, revision: row.revision, version_id: row.id, updated_at: row.known_at };
    const proof_hash = hash({ version_hash: hash(row), source_row_hash: hash(source), source_audit_hash: hash(sourceAudit), review_audit_hash: hash(event), head_hash: hash(virtualHead) });
    return { row, document, source, identity, proof_hash };
  } catch { throw invalid(); }
}
export function reviewedListingAt(db: Database.Database, input: { portfolio_id: string; listing_id: string; knowledge_at: string; now: string }): ReviewedListing {
  const { portfolio_id: portfolio, listing_id: listing, knowledge_at: known, now } = input;
  try { if (referenceInstant(known) > referenceInstant(now)) throw invalid(); } catch { throw new Error("LISTING_REVIEW_INVALID_CLOCK"); }
  return db.transaction((): ReviewedListing => {
    const identity = currentListingIdentity(db, portfolio, listing); headFor(db, portfolio, listing);
    const selected = db.prepare("SELECT id FROM listing_review_versions WHERE portfolio_id=? AND listing_id=? AND known_at<=? ORDER BY revision DESC LIMIT 1").get(portfolio, listing, known) as { id: string } | undefined;
    const base = { portfolio_id: portfolio, listing_id: listing, knowledge_at: known, checked_at: now };
    if (!selected) return { ...base, quality: "blocked", issues: ["LISTING_REVIEW_MISSING"], row: null, document: null, source: null, identity, proof_hash: null };
    const proof = readListingReviewVersion(db, portfolio, listing, selected.id), facts = proof.document.facts, issues: string[] = [];
    if (referenceInstant(now) >= referenceInstant(proof.row.review_until)) issues.push("LISTING_REVIEW_EXPIRED");
    if (canonical(identity) !== canonical(proof.document.identity_snapshot)) issues.push("LISTING_REVIEW_IDENTITY_CHANGED");
    if (facts.instrument_kind !== "ETF") issues.push("LISTING_REVIEW_NOT_ETF");
    if (facts.lifecycle_status !== "active") issues.push("LISTING_REVIEW_NOT_ACTIVE");
    if (facts.quantity_step === null || facts.price_step === null) issues.push("LISTING_REVIEW_TRADING_UNITS_MISSING");
    if (Object.values(facts.risk_classification).some(value => value === null)) issues.push("LISTING_REVIEW_RISK_CLASSIFICATION_MISSING");
    if (facts.product_structure.leverage === "leveraged" || facts.product_structure.direction === "inverse") issues.push("LISTING_REVIEW_PRODUCT_NOT_SUPPORTED");
    else if (facts.product_structure.leverage === "unknown" || facts.product_structure.direction === "unknown") issues.push("LISTING_REVIEW_PRODUCT_STRUCTURE_UNKNOWN");
    return { ...base, ...proof, quality: issues.length ? "blocked" : "complete", issues: issues.sort() };
  })();
}
export function publishListingReview(db: Database.Database, actor: ReferenceActor, raw: unknown, options: ReferenceOptions = {}): ListingReviewReceipt {
  if (actor?.kind !== "human" || !human(actor.id)) throw new Error("LISTING_REVIEW_PERMISSION_DENIED");
  const parsed = publishListingReviewSchema.safeParse(raw); if (!parsed.success) throw new Error("LISTING_REVIEW_INVALID_COMMAND");
  const input = parsed.data, now = listingReviewClock(options), { idempotency_key, ...semantic } = input, digest = hash(semantic), scope = `listing-review:${input.portfolio_id}:${actor.id}`;
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const prior = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (prior) {
      if (prior.payload_hash !== digest) throw new Error("LISTING_REVIEW_DUPLICATE_CONFLICT");
      const result = object(prior.result_json) as ListingReviewReceipt;
      const proof = readListingReviewVersion(db, input.portfolio_id, input.listing_id, result.id);
      const storedAudit = db.prepare("SELECT payload_json FROM audit_events WHERE id=?").get(proof.row.audit_id) as { payload_json: string };
      if (canonical(result) !== canonical({ ...receipt(proof.row), audit_id: proof.row.audit_id }) || canonical(object(storedAudit.payload_json).input) !== canonical(input)) throw invalid();
      assertWritableDatabase(db); return result;
    }
    const identity = currentListingIdentity(db, input.portfolio_id, input.listing_id);
    if (hash(identity) !== input.expected_identity_hash) throw new Error("LISTING_REVIEW_IDENTITY_CONFLICT");
    const { head, latest } = headFor(db, input.portfolio_id, input.listing_id);
    if ((head?.revision ?? 0) !== input.expected_review_revision) throw new Error("LISTING_REVIEW_VERSION_CONFLICT");
    if (latest) readListingReviewVersion(db, input.portfolio_id, input.listing_id, latest.id);
    if (referenceInstant(input.review_until) <= referenceInstant(now) || (head && referenceInstant(head.updated_at) > referenceInstant(now))) throw new Error("LISTING_REVIEW_INVALID_CLOCK");
    validateFacts(input.facts, identity, now); chronology(db, input.portfolio_id, input.listing_id, now);
    let source;
    try { source = readMarketReferenceSource(db, input.portfolio_id, input.source_id); } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (["REFERENCE_SOURCE_NOT_FOUND", "REFERENCE_SOURCE_OUT_OF_SCOPE"].includes(message)) throw new Error(message.replace("REFERENCE_", "LISTING_REVIEW_")); throw invalid();
    }
    if (!human(source.created_by)) throw new Error("LISTING_REVIEW_PERMISSION_DENIED");
    if (source.content_hash !== input.source_hash) throw new Error("LISTING_REVIEW_SOURCE_CONFLICT");
    if (referenceInstant(source.known_at) > referenceInstant(now)) throw new Error("LISTING_REVIEW_INVALID_CLOCK");
    const document: ListingReviewDocument = { schema_version: "listing-review-v1", id: randomUUID(), portfolio_id: input.portfolio_id, listing_id: input.listing_id, revision: input.expected_review_revision + 1, source_id: source.id, source_hash: source.content_hash, source_known_at: source.known_at, identity_snapshot: identity, identity_hash: hash(identity), known_at: now, created_by: actor.id, review_until: input.review_until, reason: input.reason, review_basis: "human_reviewed_not_provider_verified", facts: input.facts };
    if (!validDocument(document)) throw new Error("LISTING_REVIEW_INVALID_COMMAND");
    const row: ListingReviewRow = { id: document.id, portfolio_id: document.portfolio_id, listing_id: document.listing_id, revision: document.revision, source_id: document.source_id, source_hash: document.source_hash, source_known_at: document.source_known_at, identity_json: canonical(identity), identity_hash: document.identity_hash, known_at: now, created_by: actor.id, review_until: document.review_until, reason: document.reason, facts_json: canonical(document.facts), document_json: canonical(document), content_hash: hash(document), audit_id: "" };
    const result = receipt(row); row.audit_id = audit(db, actor, "publish_listing_review", "listing_review", row.id, row.portfolio_id, null, { actor_kind: "human", input, result }, now);
    const keys = Object.keys(row); db.prepare(`INSERT INTO listing_review_versions(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key as keyof ListingReviewRow]));
    if (head) { const changed = db.prepare("UPDATE listing_review_heads SET revision=?,version_id=?,updated_at=? WHERE portfolio_id=? AND listing_id=? AND revision=?").run(row.revision, row.id, now, row.portfolio_id, row.listing_id, input.expected_review_revision); if (changed.changes !== 1) throw new Error("LISTING_REVIEW_VERSION_CONFLICT"); }
    else db.prepare("INSERT INTO listing_review_heads(portfolio_id,listing_id,revision,version_id,updated_at) VALUES(?,?,?,?,?)").run(row.portfolio_id, row.listing_id, row.revision, row.id, now);
    const response = { ...result, audit_id: row.audit_id };
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, idempotency_key, digest, canonical(response), now);
    assertWritableDatabase(db); return response;
  }).immediate();
}
