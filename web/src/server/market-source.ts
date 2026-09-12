import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { z } from "zod";
import common from "../../../contracts/v1/common.schema.json";
import observationSchema from "../../../contracts/v1/market-observation.schema.json";
import batchSchema from "../../../contracts/v1/market-batch.schema.json";
import collectSchema from "../../../contracts/v1/market-collect.schema.json";
import captureSchema from "../../../contracts/v1/market-provider-capture.schema.json";
import providerBatchSchema from "../../../contracts/v1/market-provider-batch.schema.json";
import { canonical, hash } from "./ledger/service";
import { amount } from "./ledger/decimal";
import { parseStrictJson } from "./strict-json";

type JsonObject = Record<string, unknown>;
type Batch = { id: string; source_id: string; scope: string; batch_type: string; status: string; expected_pages: number; received_pages: number; row_count: number; manifest_hash: string | null; validation_json: string; started_at: string; completed_at: string | null };
type Capture = { id: string; batch_id: string; command_request_id: string; job_id: string; attempt: number; raw_body: Buffer; receipt_json: string; receipt_hash: string; normalized_json: string; document_json: string; created_at: string };
type RequestRow = { id: string; portfolio_id: string; actor_id: string; command_type: string; payload_hash: string; payload_json: string; created_at: string };
type Job = { id: string; command_request_id: string; job_type: string; scope: string; status: string; attempt_count: number; fencing_token: number; result_json: string; updated_at: string };
type Attempt = { status: string; fencing_token: number; started_at: string; finished_at: string | null };
type Receipt = { id: string; batch_id: string; command_request_id: string; job_id: string; attempt: number; fencing_token: number; request_hash: string; request_started_at: string; received_at: string; endpoint: string; raw_sha256: string; raw_bytes: number; normalized_hash: string; document_hash: string; parser_version: string; rate_kind: "reference_not_executable"; capture_kind: "http_response_bytes" };
export type MarketCollectRequest = { provider: "ecb"; feed: "daily" | "hist_90d"; currencies: string[]; expected_publication_revision: number; publish: boolean };
export type MarketSource = { mode: "manual_verified"; source_evidence: unknown } | { mode: "provider_observed"; provider: "ecb"; capture_id: string; receipt_hash: string; rate_kind: "reference_not_executable"; capture_kind: "http_response_bytes"; received_at: string };

const ajv = new Ajv2020({ strict: true, strictRequired: false });
addFormats(ajv);
ajv.addSchema(common); ajv.addSchema(observationSchema); ajv.addSchema(batchSchema);
const validCollect = ajv.compile(collectSchema), validCapture = ajv.compile(captureSchema), validDocument = ajv.compile(providerBatchSchema);
const endpoints = { daily: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", hist_90d: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml" };
const positive = z.string().max(80).refine(value => { try { return amount(value).gt(0); } catch { return false; } });
const recordSchema = z.object({ rate_date: z.string().date(), currency: z.string().regex(/^[A-Z]{3}$/), value_cny_per_unit: positive, time_precision: z.literal("date"), published_at: z.null(), raw_sha256: z.string().regex(/^[a-f0-9]{64}$/), cross: z.object({ formula: z.literal("CNY_per_EUR / currency_per_EUR"), numerator: z.object({ currency: z.literal("CNY"), rate: positive, implicit_eur: z.literal(false) }).strict(), denominator: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), rate: positive, implicit_eur: z.boolean() }).strict() }).strict() }).strict();
const normalizedSchema = z.object({ schema_version: z.literal("ecb-reference-rates-v1"), source: z.object({ provider: z.literal("ecb"), feed: z.enum(["daily", "hist_90d"]), url: z.string(), parser_version: z.literal("ecb-reference-xml-v1"), raw_sha256: z.string(), raw_bytes: z.number().int().positive().max(2097152), retrieved_at: z.string(), source_timezone: z.literal("Europe/Berlin"), rate_kind: z.literal("reference_not_executable"), base_currency: z.literal("EUR"), publication_time_status: z.literal("not_supplied"), network_origin_verified_by_parser: z.literal(false), freshness_status: z.literal("not_assessed"), requested_currencies: z.array(z.string()).min(1).max(8), first_rate_date: z.string().date(), last_rate_date: z.string().date(), rate_date_count: z.number().int().min(1).max(100), rounding: z.object({ arithmetic: z.literal("exact_rational"), method: z.literal("ROUND_HALF_EVEN"), scale: z.literal(18) }).strict() }).strict(), records: z.array(recordSchema).min(1).max(800) }).strict();

function fail(): never { throw new Error("MARKET_PROVIDER_EVIDENCE_INVALID"); }
function requireTrue(value: unknown): asserts value { if (!value) fail(); }
function object(value: unknown): JsonObject { requireTrue(value !== null && typeof value === "object" && !Array.isArray(value)); return value as JsonObject; }
function parsed(text: string): JsonObject { requireTrue(typeof text === "string" && Buffer.byteLength(text) <= 4 * 1024 * 1024); return object(parseStrictJson(text)); }
function instant(value: unknown): bigint {
  requireTrue(typeof value === "string");
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  requireTrue(m && !value.startsWith("0000"));
  const ms = Date.parse(m[1] + "Z");
  requireTrue(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === m[1]);
  return BigInt(ms) * 1000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}
function same(a: unknown, b: unknown) { return canonical(a) === canonical(b); }
function ratio(numerator: string, denominator: string): string {
  const rational = (text: string) => { const [whole, fraction = ""] = text.split("."); return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)] as const; };
  const [n, ns] = rational(numerator), [d, ds] = rational(denominator), scaled = n * ds * 10n ** 18n, divisor = d * ns;
  let q = scaled / divisor; const r = scaled % divisor;
  if (r * 2n > divisor || (r * 2n === divisor && q % 2n)) q += 1n;
  const digits = q.toString().padStart(19, "0");
  return (digits.slice(0, -18) + "." + digits.slice(-18)).replace(/0+$/, "").replace(/\.$/, "");
}
export function isReservedMarketSource(value: unknown): boolean { return typeof value === "string" && value.toLowerCase().startsWith("provider:"); }
export function marketCollectScope(request: MarketCollectRequest): string { return `provider:ecb:fx:${request.feed}:${[...request.currencies].sort().join("-")}`; }

/** Only receipts from the fixed worker path establish provider origin; labels do not. */
function capturedSource(db: Database.Database, batch: Batch, validation: JsonObject, knownAt?: string): MarketSource {
  const plan = object(validation.plan), capture = db.prepare("SELECT * FROM market_provider_captures WHERE id=? AND batch_id=?").get(plan.provider_capture_id, batch.id) as Capture | undefined;
  requireTrue(capture && Buffer.isBuffer(capture.raw_body));
  const receiptObject = parsed(capture.receipt_json); requireTrue(validCapture(receiptObject));
  const receipt = receiptObject as unknown as Receipt;
  requireTrue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(receipt.received_at) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(receipt.request_started_at));
  requireTrue(hash(receiptObject) === capture.receipt_hash && receipt.id === capture.id && receipt.batch_id === batch.id && receipt.command_request_id === capture.command_request_id && receipt.job_id === capture.job_id && receipt.attempt === capture.attempt);
  requireTrue(capture.raw_body.length === receipt.raw_bytes && createHash("sha256").update(capture.raw_body).digest("hex") === receipt.raw_sha256);
  const normalizedValue = parsed(capture.normalized_json), normalizedResult = normalizedSchema.safeParse(normalizedValue);
  requireTrue(normalizedResult.success && hash(normalizedValue) === receipt.normalized_hash);
  const normalized = normalizedResult.data, source = normalized.source;
  const document = parsed(capture.document_json); requireTrue(validDocument(document) && hash(document) === receipt.document_hash && same(document.batch, plan));
  const request = db.prepare("SELECT * FROM command_requests WHERE id=?").get(capture.command_request_id) as RequestRow | undefined;
  requireTrue(request && request.command_type === "market_collect" && request.actor_id.trim());
  const inputObject = parsed(request.payload_json); requireTrue(validCollect(inputObject));
  const input = inputObject as unknown as MarketCollectRequest;
  requireTrue(hash(inputObject) === request.payload_hash && request.payload_hash === receipt.request_hash && receipt.endpoint === endpoints[input.feed]);
  const job = db.prepare("SELECT * FROM job_runs WHERE id=?").get(capture.job_id) as Job | undefined;
  const attempt = db.prepare("SELECT * FROM job_attempts WHERE job_id=? AND attempt=?").get(capture.job_id, capture.attempt) as Attempt | undefined;
  requireTrue(job && attempt && job.command_request_id === request.id && job.job_type === "market_collect" && job.scope === request.portfolio_id && job.status === "succeeded" && attempt.status === "succeeded" && job.attempt_count === capture.attempt && job.fencing_token === receipt.fencing_token && attempt.fencing_token === receipt.fencing_token);
  const result = parsed(job.result_json);
  requireTrue(input.publish === true && result.batch_status === "published" && result.capture_id === capture.id && result.receipt_hash === capture.receipt_hash && result.batch_id === batch.id && result.manifest_hash === batch.manifest_hash);
  requireTrue(instant(request.created_at) <= instant(attempt.started_at) && instant(attempt.started_at) <= instant(receipt.request_started_at) && instant(receipt.request_started_at) <= instant(receipt.received_at) && instant(receipt.received_at) <= instant(capture.created_at) && instant(capture.created_at) <= instant(attempt.finished_at) && instant(attempt.finished_at) <= instant(job.updated_at));
  if (knownAt !== undefined) requireTrue(instant(job.updated_at) <= instant(knownAt));
  requireTrue(batch.status === "published" && batch.source_id === "provider:ecb:reference-fx" && batch.scope === marketCollectScope(input) && batch.batch_type === "fx" && batch.expected_pages === 1 && batch.received_pages === 1 && batch.row_count === normalized.records.length);
  requireTrue(plan.expected_publication_revision === input.expected_publication_revision && plan.expected_rows === normalized.records.length && plan.source_mode === "provider_observed");
  requireTrue(source.feed === input.feed && source.url === receipt.endpoint && source.parser_version === receipt.parser_version && source.raw_sha256 === receipt.raw_sha256 && source.raw_bytes === receipt.raw_bytes && source.retrieved_at === receipt.received_at && same(source.requested_currencies, [...input.currencies].sort()));
  const dates = [...new Set(normalized.records.map(row => row.rate_date))].sort();
  requireTrue(dates.length === source.rate_date_count && dates[0] === source.first_rate_date && dates.at(-1) === source.last_rate_date && (input.feed !== "daily" || dates.length === 1));
  const ordered = [...normalized.records].sort((a, b) => a.rate_date.localeCompare(b.rate_date) || a.currency.localeCompare(b.currency));
  requireTrue(same(ordered, normalized.records) && normalized.records.length === dates.length * input.currencies.length);
  const observations: JsonObject[] = [];
  for (const day of dates) {
    const records = normalized.records.filter(row => row.rate_date === day);
    requireTrue(same(records.map(row => row.currency), [...input.currencies].sort()) && new Set(records.map(row => row.cross.numerator.rate)).size === 1);
  }
  for (const row of normalized.records) {
    requireTrue(row.raw_sha256 === receipt.raw_sha256 && row.cross.denominator.currency === row.currency && row.cross.denominator.implicit_eur === (row.currency === "EUR") && (row.currency !== "EUR" || row.cross.denominator.rate === "1") && row.value_cny_per_unit === ratio(row.cross.numerator.rate, row.cross.denominator.rate));
    if (row.currency === "CNY") requireTrue(row.value_cny_per_unit === "1" && row.cross.numerator.rate === row.cross.denominator.rate);
    observations.push({ id: "observation:" + hash([capture.id, row.rate_date, row.currency]), batch_id: batch.id, source_id: batch.source_id, series_key: "FX:" + row.currency, metric: "fx_cny_per_unit", value: row.value_cny_per_unit, unit: "CNY_per_unit_currency", observed_at: row.rate_date, ingested_at: receipt.received_at, source_timezone: "Europe/Berlin", time_precision: "date", price_basis: "not_applicable", revision_id: capture.id, raw_hash: receipt.raw_sha256, parser_version: receipt.parser_version, provenance: "live_observed" });
  }
  requireTrue(same(document.pages, [{ page_number: 1, observations }]));
  const pages = db.prepare("SELECT page_number,payload_hash,observations_json,received_at FROM market_batch_pages WHERE batch_id=? ORDER BY page_number").all(batch.id) as { page_number: number; payload_hash: string; observations_json: string; received_at: string }[];
  requireTrue(pages.length === 1 && pages[0].page_number === 1 && pages[0].payload_hash === hash(observations) && pages[0].received_at === receipt.received_at && same(parseStrictJson(pages[0].observations_json), observations));
  const members = db.prepare("SELECT o.* FROM market_batch_members m JOIN market_observations o ON o.id=m.observation_id WHERE m.batch_id=? ORDER BY o.id LIMIT 801").all(batch.id) as JsonObject[];
  requireTrue(same(members.map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))), [...observations].sort((a, b) => String(a.id).localeCompare(String(b.id)))));
  const manifest = { schema_version: "market-publication-v2", plan, pages: [{ page_number: 1, payload_hash: hash(observations), received_at: receipt.received_at }], observation_ids: observations.map(row => String(row.id)).sort(), provider_capture: { id: capture.id, receipt_hash: capture.receipt_hash, raw_sha256: receipt.raw_sha256, normalized_hash: receipt.normalized_hash, document_hash: receipt.document_hash, rate_kind: receipt.rate_kind, capture_kind: receipt.capture_kind } };
  requireTrue(same(validation.issues, []) && same(validation.manifest, manifest) && hash(manifest) === batch.manifest_hash);
  const publication = db.prepare("SELECT * FROM market_publication_events WHERE batch_id=? AND scope=?").get(batch.id, batch.scope) as { revision: number; manifest_hash: string; published_at: string } | undefined;
  requireTrue(publication && publication.revision === input.expected_publication_revision + 1 && publication.manifest_hash === batch.manifest_hash && instant(publication.published_at) >= instant(receipt.received_at));
  return { mode: "provider_observed", provider: "ecb", capture_id: capture.id, receipt_hash: capture.receipt_hash, rate_kind: receipt.rate_kind, capture_kind: receipt.capture_kind, received_at: receipt.received_at };
}

/** Legacy manual records keep their existing meaning, never a provider attestation. */
export function verifiedMarketSource(db: Database.Database, batchId: string, knownAt?: string): MarketSource {
  try {
    const batch = db.prepare("SELECT * FROM market_batches WHERE id=?").get(batchId) as Batch | undefined;
    requireTrue(batch);
    const validation = parsed(batch.validation_json), plan = object(validation.plan);
    if (isReservedMarketSource(batch.source_id) || isReservedMarketSource(batch.scope) || isReservedMarketSource(plan.source_id) || isReservedMarketSource(plan.scope) || plan.source_mode === "provider_observed") return capturedSource(db, batch, validation, knownAt);
    requireTrue(plan.source_mode === "manual_verified");
    return { mode: "manual_verified", source_evidence: plan.source_evidence ?? null };
  } catch { fail(); }
}
