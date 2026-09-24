import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import common from "../../../contracts/v1/common.schema.json";
import observation from "../../../contracts/v1/market-observation.schema.json";
import manualBatch from "../../../contracts/v1/market-batch.schema.json";
import facts from "../../../contracts/v1/market-reference-facts.schema.json";
import collect from "../../../contracts/v1/market-price-collect.schema.json";
import captureSchema from "../../../contracts/v1/market-sdk-capture.schema.json";
import batchSchema from "../../../contracts/v1/market-price-provider-batch.schema.json";
import { canonical, hash } from "./ledger/service";
import { amount } from "./ledger/decimal";
import { parseStrictJson } from "./strict-json";
import { readMarketReferenceVersion, type MappingFacts, type CalendarFacts, type PriceCollectRequest } from "./market-references/service";
import { verifyScheduledPriceCollectionRequest, type PriceCollectionRequestRow } from "./price-schedules/verification";

type Obj = Record<string, unknown>;
export type SdkMarketSource = { mode: "provider_observed"; provider: "longport"; portfolio_id: string; capture_id: string; receipt_hash: string; rate_kind: "market_price_not_executable"; capture_kind: "sdk_projection"; received_at: string };
const ajv = new Ajv2020({ strict: true, strictRequired: false }); addFormats(ajv); ajv.addSchema(common); ajv.addSchema(observation); ajv.addSchema(manualBatch); ajv.addSchema(facts);
const validCollect = ajv.compile(collect), validCapture = ajv.compile(captureSchema), validDocument = ajv.compile(batchSchema);
function requireTrue(value: unknown): asserts value { if (!value) throw new Error("PRICE_PROVIDER_EVIDENCE_INVALID"); }
function obj(value: unknown): Obj { requireTrue(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function array(value: unknown, maximum: number): unknown[] { requireTrue(Array.isArray(value) && value.length <= maximum); return value; }
function parse(value: unknown, maximum = 4194304): Obj { requireTrue(typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum); return obj(parseStrictJson(value)); }
function equal(a: unknown, b: unknown) { requireTrue(canonical(a) === canonical(b)); }
export function priceInstant(value: unknown): bigint {
  requireTrue(typeof value === "string"); const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  requireTrue(match && !value.startsWith("0000")); const millis = Date.parse(match[1] + "Z");
  requireTrue(Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 19) === match[1]);
  return BigInt(millis) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
function utc6(value: string) { priceInstant(value); return value.replace(/(?:\.(\d{1,6}))?Z$/, (_, fraction: string | undefined) => "." + (fraction ?? "").padEnd(6, "0") + "Z"); }
function localDate(value: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}
const zones = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" };
function selectedReferences(db: Database.Database, portfolio: string, input: PriceCollectRequest, knownAt: string) {
  const days = (Date.parse(input.end_date + "T00:00:00Z") - Date.parse(input.start_date + "T00:00:00Z")) / 86400000 + 1;
  requireTrue(days >= 1 && days <= 31);
  const load = (id: string, kind: "mapping" | "calendar") => {
    const value = readMarketReferenceVersion(db, portfolio, id), row = value.row;
    const latest = db.prepare("SELECT id FROM market_reference_versions WHERE portfolio_id=? AND kind=? AND scope_key=? AND known_at<=? ORDER BY version DESC LIMIT 1").get(portfolio, kind, row.scope_key, utc6(knownAt)) as { id: string } | undefined;
    requireTrue(row.kind === kind && priceInstant(row.known_at) <= priceInstant(knownAt) && latest?.id === id);
    const sourceAudit = db.prepare("SELECT * FROM audit_events WHERE action='store_market_reference_source' AND object_type='market_reference_source' AND object_id=?").get(value.source.id);
    return { ...value, proof: { version_id: id, version_hash: hash(row), source_row_hash: hash(value.source), source_audit_hash: hash(sourceAudit), review_audit_hash: hash(value.audit) }, head: { portfolio_id: portfolio, kind, scope_key: row.scope_key, version: row.version, version_id: id, updated_at: row.known_at } };
  };
  const mappings = input.mapping_version_ids.map(id => load(id, "mapping")).sort((a, b) => a.row.scope_key < b.row.scope_key ? -1 : a.row.scope_key > b.row.scope_key ? 1 : 0);
  const calendars = input.calendar_version_ids.map(id => load(id, "calendar"));
  const market = mappings[0].document.facts.market, used = new Set<string>(), identities = new Set<string>();
  requireTrue(input.end_date < localDate(knownAt, zones[market]));
  requireTrue(calendars.every(row => row.document.facts.market === market));
  const mappingProofs = mappings.map(value => {
    const f = value.document.facts as MappingFacts;
    requireTrue(f.market === market && !identities.has(f.listing_id) && f.valid_from <= input.start_date && (f.valid_to === null || input.end_date < f.valid_to)); identities.add(f.listing_id);
    const listing = db.prepare("SELECT id,market,exchange,currency,created_at FROM listings WHERE id=?").get(f.listing_id) as Obj | undefined;
    const entry = db.prepare("SELECT * FROM catalog_entries WHERE portfolio_id=? AND listing_id=?").get(portfolio, f.listing_id) as Obj | undefined;
    requireTrue(listing && entry && priceInstant(listing.created_at) <= priceInstant(knownAt) && priceInstant(entry.created_at) <= priceInstant(knownAt));
    const matches = calendars.filter(row => row.document.facts.exchange === f.exchange); requireTrue(matches.length === 1);
    const calendar = matches[0], c = calendar.document.facts as CalendarFacts; requireTrue(c.range_start <= input.start_date && input.end_date <= c.range_end);
    const expected = c.days.filter(day => day.kind !== "closed" && input.start_date <= day.date && day.date <= input.end_date).map(day => day.date); requireTrue(expected.length > 0);
    used.add(calendar.row.id);
    return { ...value.proof, listing_id: f.listing_id, listing_identity_hash: hash(listing), catalog_entry_hash: hash(entry), calendar_version_id: calendar.row.id, expected_dates: expected };
  });
  requireTrue(used.size === calendars.length);
  const proof = { schema_version: "market-reference-selection-v1", portfolio_id: portfolio, market, start_date: input.start_date, end_date: input.end_date, known_at: utc6(knownAt), mappings: mappingProofs,
    calendars: calendars.map(row => row.proof).sort((a, b) => a.version_id < b.version_id ? -1 : 1),
    heads: [...mappings, ...calendars].map(row => row.head).sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.scope_key < b.scope_key ? -1 : a.scope_key > b.scope_key ? 1 : 0) };
  return { proof: { ...proof, binding_id: hash(proof) }, mappings };
}
function replayProjection(raw: unknown, mapping: MappingFacts, expectedDates: string[], input: PriceCollectRequest) {
  const projection = obj(raw), source = obj(projection.source), started = String(source.call_started_at), returned = String(source.call_returned_at), zone = zones[mapping.market];
  requireTrue(utc6(started) === started && utc6(returned) === returned && priceInstant(started) <= priceInstant(returned));
  const today = localDate(started, zone); requireTrue(input.end_date < today);
  equal(source, { provider: "longport", capture_kind: "sdk_projection", sdk_version: "4.3.7", adapter_version: "longport-sdk-candles-v1", call_started_at: started, call_returned_at: returned, source_timezone: zone, sdk_datetime_basis: "runtime_utc_from_unix_timestamp", collector_runtime: "isolated_official_sdk", publication_time_status: "not_supplied", provider_revision_status: "not_supplied", network_bytes_preserved: false, calendar_verified_by_adapter: false, mapping_verified_by_adapter: false, coverage_status: "matches_caller_expected_dates_only", account_buyability_verified: false, timestamp_semantics: "provider_bar_timestamp_not_confirmed_close", volume_encoding: "int64_decimal_string" });
  const request = { mapping: { listing_id: mapping.listing_id, provider_symbol: mapping.provider_symbol, market: mapping.market, currency: mapping.currency }, start_date: input.start_date, end_date: input.end_date, period: "day", adjust_type: "none", trade_session: "regular", expected_dates: expectedDates };
  equal(projection.request, request);
  const candles = array(projection.candlesticks, 31); requireTrue(candles.length > 0);
  const seen = new Set<string>();
  const records = candles.map((value, index) => {
    const row = obj(value); const decimal = (key: string) => { requireTrue(typeof row[key] === "string" && !String(row[key]).startsWith("-")); const value = amount(String(row[key])); requireTrue(value.gte(0)); return value; };
    const open = decimal("open"), high = decimal("high"), low = decimal("low"), close = decimal("close"); decimal("turnover");
    requireTrue(close.gt(0) && low.lte(open) && low.lte(close) && high.gte(open) && high.gte(close));
    requireTrue(typeof row.volume === "string" && /^(0|[1-9][0-9]{0,18})$/.test(row.volume) && BigInt(row.volume) <= 9223372036854775807n && row.trade_session === 0);
    const timestamp = String(row.timestamp); requireTrue(utc6(timestamp) === timestamp && priceInstant(timestamp) <= priceInstant(returned));
    const day = localDate(timestamp, zone); requireTrue(!seen.has(day) && input.start_date <= day && day <= input.end_date && day < today); seen.add(day);
    equal(row, { open: row.open, high: row.high, low: row.low, close: row.close, turnover: row.turnover, volume: row.volume, timestamp, trade_session: 0 });
    return { listing_id: mapping.listing_id, currency: mapping.currency, observed_at: day, time_precision: "date", value: row.close, metric: "close", price_basis: "unadjusted", published_at: null, provider_revision: null, ingested_at: returned, source_timezone: zone, provenance: "live_observed", provider_timestamp: timestamp, projection_row: index };
  });
  equal([...seen].sort(), expectedDates);
  equal(projection, { schema_version: "longport-candles-projection-v1", source, request, candlesticks: candles });
  const digest = hash(projection);
  return { records: records.map(row => ({ ...row, projection_sha256: digest })).sort((a, b) => a.observed_at < b.observed_at ? -1 : 1), digest, started, returned };
}
function verify(db: Database.Database, batchId: string, knownAt: string) {
  const capture = db.prepare("SELECT * FROM market_sdk_captures WHERE batch_id=?").get(batchId) as Obj | undefined;
  requireTrue(capture && Buffer.isBuffer(capture.raw_body));
  const receipt = parse(capture.receipt_json, 16384), normalized = parse(capture.normalized_json), document = parse(capture.document_json);
  requireTrue(validCapture(receipt) && validDocument(document) && hash(receipt) === capture.receipt_hash && hash(normalized) === receipt.normalized_hash && hash(document) === receipt.document_hash);
  requireTrue(capture.raw_body.length === receipt.raw_bytes && capture.raw_body.length <= 2097152 && createHash("sha256").update(capture.raw_body).digest("hex") === receipt.raw_sha256);
  const rawText = new TextDecoder("utf-8", { fatal: true }).decode(capture.raw_body), raw = parse(rawText, 2097152); requireTrue(canonical(raw) === rawText);
  const projections = array(raw.projections, 4); equal(raw, { schema_version: "longport-batch-projection-v1", projections });
  const request = db.prepare("SELECT * FROM command_requests WHERE id=?").get(capture.command_request_id) as Obj | undefined;
  requireTrue(request && request.command_type === "market_collect_prices" && typeof request.actor_id === "string" && request.actor_id.trim());
  const scheduled = verifyScheduledPriceCollectionRequest(db, request as unknown as PriceCollectionRequestRow);
  const payload = parse(request.payload_json, 16384); requireTrue(validCollect(payload) && hash(payload) === request.payload_hash && request.payload_hash === receipt.request_hash && payload.publish === true);
  const input = payload as unknown as PriceCollectRequest, portfolio = String(request.portfolio_id), started = String(receipt.request_started_at);
  const original = selectedReferences(db, portfolio, input, started), current = selectedReferences(db, portfolio, input, knownAt);
  equal(current.proof.heads, original.proof.heads); equal(normalized.references, original.proof); requireTrue(hash(original.proof) === receipt.references_hash);
  const job = db.prepare("SELECT * FROM job_runs WHERE id=?").get(capture.job_id) as Obj | undefined;
  const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=?").get(capture.job_id, capture.attempt) as Obj | undefined;
  requireTrue(job && attempt && job.job_type === "market_collect_prices" && job.command_request_id === request.id && job.scope === portfolio && job.status === "succeeded" && attempt.status === "succeeded" && job.attempt_count === capture.attempt && job.fencing_token === receipt.fencing_token && attempt.fencing_token === receipt.fencing_token);
  requireTrue(receipt.id === capture.id && receipt.batch_id === batchId && receipt.command_request_id === request.id && receipt.job_id === job.id && receipt.attempt === capture.attempt);
  requireTrue(priceInstant(request.created_at) <= priceInstant(attempt.started_at) && priceInstant(attempt.started_at) <= priceInstant(started) && priceInstant(started) <= priceInstant(receipt.received_at) && priceInstant(receipt.received_at) <= priceInstant(capture.created_at) && priceInstant(capture.created_at) <= priceInstant(attempt.finished_at) && priceInstant(attempt.finished_at) <= priceInstant(job.updated_at) && priceInstant(job.updated_at) <= priceInstant(knownAt));
  if (scheduled) {
    const { slot, definition, authorization } = scheduled;
    requireTrue(job.period === slot.period && job.max_attempts === definition.max_attempts && job.input_version === request.id + ":" + request.payload_hash);
    for (const time of [attempt.started_at, started, receipt.received_at, capture.created_at, attempt.finished_at, job.updated_at]) {
      requireTrue(priceInstant(time) >= priceInstant(slot.scheduled_at) && priceInstant(time) < priceInstant(slot.deadline_at)
        && priceInstant(time) >= priceInstant(authorization.created_at) && (authorization.ended_at === null || priceInstant(time) < priceInstant(authorization.ended_at)));
    }
  }
  requireTrue(projections.length === original.mappings.length);
  let previous = started;
  const segments = original.mappings.map((reference, index) => {
    const proof = original.proof.mappings[index], replay = replayProjection(projections[index], reference.document.facts as MappingFacts, proof.expected_dates, input);
    requireTrue(priceInstant(previous) <= priceInstant(replay.started)); previous = replay.returned;
    return { listing_id: proof.listing_id, mapping_version_id: proof.version_id, calendar_version_id: proof.calendar_version_id, projection_sha256: replay.digest, records: replay.records };
  });
  requireTrue(priceInstant(previous) <= priceInstant(receipt.received_at));
  equal(normalized, { schema_version: "longport-price-batch-v1", portfolio_id: portfolio, market: original.proof.market, start_date: input.start_date, end_date: input.end_date, references: original.proof, segments });
  const observations = segments.flatMap(segment => segment.records.map(row => ({ id: "observation:" + hash([receipt.id, row.listing_id, row.observed_at]), batch_id: batchId, source_id: "provider:longport:prices", listing_id: row.listing_id, series_key: "PRICE:" + row.listing_id, metric: "close", value: row.value, unit: row.currency, observed_at: row.observed_at, ingested_at: receipt.received_at, source_timezone: row.source_timezone, time_precision: "date", price_basis: "unadjusted", revision_id: receipt.id, raw_hash: receipt.raw_sha256, parser_version: "longport-price-collection-v1", provenance: "live_observed" })));
  const scope = "provider:longport:prices:" + hash({ portfolio_id: portfolio, market: original.proof.market, listing_ids: original.proof.mappings.map(row => row.listing_id).sort() });
  const plan = { id: batchId, source_id: "provider:longport:prices", scope, batch_type: "prices", expected_pages: 1, expected_rows: observations.length, source_mode: "provider_observed", expected_publication_revision: input.expected_publication_revision, provider_capture_id: receipt.id };
  equal(document, { schema_version: "market-price-provider-batch-v1", batch: plan, pages: [{ page_number: 1, observations }] });
  const batch = db.prepare("SELECT * FROM market_batches WHERE id=?").get(batchId) as Obj | undefined;
  requireTrue(batch && batch.source_id === plan.source_id && batch.scope === scope && batch.batch_type === "prices" && batch.status === "published" && batch.expected_pages === 1 && batch.received_pages === 1 && batch.row_count === observations.length);
  const pages = db.prepare("SELECT page_number,payload_hash,received_at,observations_json FROM market_batch_pages WHERE batch_id=?").all(batchId) as Obj[];
  requireTrue(pages.length === 1); equal(pages[0], { page_number: 1, payload_hash: hash(observations), received_at: receipt.received_at, observations_json: canonical(observations) });
  const members = db.prepare("SELECT o.* FROM market_batch_members m JOIN market_observations o ON o.id=m.observation_id WHERE m.batch_id=? ORDER BY o.id LIMIT 125").all(batchId) as Obj[];
  equal(members.map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))), [...observations].sort((a, b) => a.id < b.id ? -1 : 1));
  const providerCapture = { id: receipt.id, receipt_hash: capture.receipt_hash, raw_sha256: receipt.raw_sha256, normalized_hash: receipt.normalized_hash, document_hash: receipt.document_hash, rate_kind: receipt.rate_kind, capture_kind: receipt.capture_kind };
  const manifest = { schema_version: "market-publication-v2", plan, pages: [{ page_number: 1, payload_hash: hash(observations), received_at: receipt.received_at }], observation_ids: observations.map(row => row.id).sort(), provider_capture: providerCapture };
  const validation = parse(batch.validation_json); equal(validation.plan, plan); equal(validation.issues, []); equal(validation.manifest, manifest); requireTrue(hash(manifest) === batch.manifest_hash);
  const result = parse(job.result_json); requireTrue(result.batch_id === batchId && result.batch_status === "published" && result.capture_id === receipt.id && result.receipt_hash === capture.receipt_hash && result.manifest_hash === batch.manifest_hash);
  const publication = db.prepare("SELECT * FROM market_publication_events WHERE batch_id=? AND scope=?").get(batchId, scope) as Obj | undefined;
  requireTrue(publication && publication.revision === input.expected_publication_revision + 1 && publication.manifest_hash === batch.manifest_hash && priceInstant(publication.published_at) >= priceInstant(receipt.received_at) && priceInstant(publication.published_at) <= priceInstant(job.updated_at));
  return { source: { mode: "provider_observed", provider: "longport", portfolio_id: portfolio, capture_id: String(capture.id), receipt_hash: String(capture.receipt_hash), rate_kind: "market_price_not_executable", capture_kind: "sdk_projection", received_at: String(receipt.received_at) } as SdkMarketSource, references: original.proof };
}
export function verifiedSdkMarketSource(db: Database.Database, batchId: string, knownAt = new Date().toISOString()): SdkMarketSource {
  try { return verify(db, batchId, knownAt).source; } catch { throw new Error("PRICE_PROVIDER_EVIDENCE_INVALID"); }
}
export function verifiedPriceCalendarSession(db: Database.Database, batchId: string, portfolioId: string, listingId: string, cutoffAt: string, knownAt: string): string {
  try {
    const proof = verify(db, batchId, knownAt); requireTrue(proof.source.portfolio_id === portfolioId && priceInstant(cutoffAt) <= priceInstant(knownAt));
    const match = proof.references.mappings.filter(row => row.listing_id === listingId); requireTrue(match.length === 1);
    const mapping = readMarketReferenceVersion(db, portfolioId, match[0].version_id).document.facts as MappingFacts;
    const calendar = readMarketReferenceVersion(db, portfolioId, match[0].calendar_version_id).document.facts as CalendarFacts;
    const day = localDate(cutoffAt, calendar.timezone);
    requireTrue(mapping.valid_from <= day && (mapping.valid_to === null || day < mapping.valid_to) && calendar.range_start <= day && day <= calendar.range_end);
    const available = calendar.days.filter(row => row.kind !== "closed" && row.close_at && mapping.valid_from <= row.date && (mapping.valid_to === null || row.date < mapping.valid_to) && priceInstant(row.close_at) <= priceInstant(cutoffAt)); requireTrue(available.length > 0);
    return available.at(-1)!.date;
  } catch { throw new Error("PRICE_CALENDAR_EVIDENCE_INVALID"); }
}
