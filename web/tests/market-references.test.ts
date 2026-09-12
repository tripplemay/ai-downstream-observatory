import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { canonical, createPortfolio, hash } from "../src/server/ledger/service";
import { getMarketReferenceState } from "../src/server/market-references/queries";
import { enqueueWorkbenchTask } from "../src/server/workbench-commands";
import { storeMarketReferenceSource, publishMarketReference, readMarketReferenceSource, readMarketReferenceVersion, type ReferenceDocument } from "../src/server/market-references/service";

const actor = { id: "synthetic-reference-owner", kind: "human" as const };
const now = "2026-01-01T00:00:00.000000Z";
const mapping: ReferenceDocument = { kind: "mapping", facts: { provider: "longport", listing_id: "synthetic-listing", provider_symbol: "SYNTH.US", market: "US", exchange: "XNAS", currency: "USD", valid_from: "2025-01-01", valid_to: null } };
const calendar: ReferenceDocument = { kind: "calendar", facts: { market: "US", exchange: "XNAS", timezone: "America/New_York", range_start: "2025-01-01", range_end: "2025-01-03", days: [{ date: "2025-01-01", kind: "closed", close_at: null }, { date: "2025-01-02", kind: "full", close_at: "2025-01-02T21:00:00.000000Z" }, { date: "2025-01-03", kind: "half", close_at: "2025-01-03T18:00:00.000000Z" }] } };
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "market-references-")), filename = path.join(directory, "workbench.db"); migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic reference portfolio"), other = createPortfolio(db, actor, "Synthetic other portfolio");
  db.prepare("INSERT INTO instruments(id,name,asset_class,created_at) VALUES('synthetic-instrument','Synthetic ETF','ETF',?)").run(now);
  db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('synthetic-listing','synthetic-instrument','US','XNAS','SYNTH','USD',?)").run(now);
  db.prepare("INSERT INTO catalog_entries(portfolio_id,listing_id,created_at) VALUES(?,'synthetic-listing',?)").run(portfolio, now);
  const raw = '{\n "synthetic": true, "purpose": "human reference review only"\n}\n';
  const sourceInput = { portfolio_id: portfolio, idempotency_key: "source", reference: "Synthetic evidence, not a broker or provider certification", content_text: raw };
  const source = storeMarketReferenceSource(db, actor, sourceInput, { now });
  const command = (document: ReferenceDocument, idempotency_key = "publish", expected_version = 0) => ({ portfolio_id: portfolio, idempotency_key, expected_version, source_id: source.id, source_hash: source.content_hash, review_reason: "Synthetic manual review; does not authorize trading", acknowledgement: true as const, document });
  return { db, directory, portfolio, other, raw, sourceInput, source, command, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test("reference originals preserve exact UTF8 bytes privately; storing alone never reviews or creates financial state", () => {
  const f = fixture(); try {
    assert.equal(readMarketReferenceSource(f.db, f.portfolio, f.source.id).content_text, f.raw);
    assert.deepEqual(storeMarketReferenceSource(f.db, actor, f.sourceInput, { now }), f.source);
    assert.equal(getMarketReferenceState(f.db, { portfolio_id: f.portfolio }).versions.length, 0);
    assert.throws(() => readMarketReferenceSource(f.db, f.other, f.source.id), /REFERENCE_SOURCE_OUT_OF_SCOPE/);
    for (const table of ["ledger_events", "approval_events", "activations", "account_capabilities", "market_reference_versions", "market_reference_heads"]) assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
    assert.throws(() => storeMarketReferenceSource(f.db, actor, { ...f.sourceInput, content_text: '{"synthetic":true}' }, { now }), /REFERENCE_DUPLICATE_CONFLICT/);
  } finally { f.close(); }
});
test("human reviewed mapping and complete explicit calendar use independent heads and exact immutable source/audit hashes", () => {
  const f = fixture(); try {
    const result = publishMarketReference(f.db, actor, f.command(mapping), { now });
    const read = readMarketReferenceVersion(f.db, f.portfolio, result.id);
    assert.equal(result.verification_status, "human_reviewed_not_provider_verified"); assert.equal(read.document.source_known_at, now); assert.equal(hash(read.document), result.content_hash);
    const next = publishMarketReference(f.db, actor, f.command({ ...mapping, facts: { ...mapping.facts, valid_to: "2027-01-01" } }, "next", 1), { now: "2026-01-01T00:00:00.000001Z" });
    assert.equal(next.version, 2); assert.equal(readMarketReferenceVersion(f.db, f.portfolio, result.id).document.version, 1);
    assert.deepEqual(publishMarketReference(f.db, actor, f.command(mapping), { now }), result);
    assert.equal(publishMarketReference(f.db, actor, f.command(calendar, "calendar"), { now }).version, 1);
    const state = getMarketReferenceState(f.db, { portfolio_id: f.portfolio }); assert.equal(state.heads.length, 2); assert.equal(state.versions.length, 3); assert.equal(state.ledger_revision, 0);
    assert.doesNotMatch(JSON.stringify(state), /content_text|document_json|"days"/);
    assert.throws(() => f.db.prepare("UPDATE market_reference_versions SET content_hash=? WHERE id=?").run("a".repeat(64), result.id), /append-only/);
  } finally { f.close(); }
});
test("scope, head CAS, strict review acknowledgement and human authority fail atomically", () => {
  const f = fixture(); try {
    const count = () => f.db.prepare("SELECT total_changes() n").get();
    for (const input of [{ ...f.command(mapping), acknowledgement: false }, { ...f.command(mapping), review_reason: " " }, { ...f.command(mapping), verified: true }, { ...f.command(mapping), actor_id: actor.id }, { ...f.command(mapping), known_at: now }]) assert.throws(() => publishMarketReference(f.db, actor, input, { now }), /REFERENCE_INVALID_COMMAND/);
    assert.throws(() => publishMarketReference(f.db, { ...actor, kind: "ai" }, f.command(mapping), { now }), /REFERENCE_PERMISSION_DENIED/);
    assert.throws(() => publishMarketReference(f.db, actor, { ...f.command(calendar), portfolio_id: f.other }, { now }), /REFERENCE_SOURCE_OUT_OF_SCOPE/);
    assert.throws(() => publishMarketReference(f.db, actor, { ...f.command(mapping), source_hash: "a".repeat(64) }, { now }), /REFERENCE_SOURCE_CONFLICT/);
    const before = count(); assert.throws(() => publishMarketReference(f.db, actor, f.command(mapping, "stale", 2), { now }), /REFERENCE_VERSION_CONFLICT/); assert.deepEqual(count(), before);
    assert.equal(getMarketReferenceState(f.db, { portfolio_id: f.portfolio }).heads.length, 0);
  } finally { f.close(); }
});
test("mapping validates registered identity, explicit suffix, date range and portfolio catalog membership", () => {
  const f = fixture(); try {
    for (const patch of [{ market: "HK" }, { exchange: "XNYS" }, { currency: "HKD" }, { provider_symbol: "SYNTH.HK" }, { valid_to: "2024-12-31" }]) assert.throws(() => publishMarketReference(f.db, actor, f.command({ ...mapping, facts: { ...mapping.facts, ...patch } } as ReferenceDocument), { now }), /REFERENCE_INVALID_MAPPING/);
    assert.throws(() => publishMarketReference(f.db, actor, { ...f.command(mapping), portfolio_id: f.other }, { now }), /REFERENCE_CATALOG_ENTRY_REQUIRED/);
  } finally { f.close(); }
});
test("calendar cannot omit closed dates, duplicate days, invent local-day close times or replace timezone", () => {
  const f = fixture(); try {
    if (calendar.kind !== "calendar") throw new Error();
    for (const facts of [ { ...calendar.facts, days: calendar.facts.days.slice(1) }, { ...calendar.facts, days: [calendar.facts.days[0], calendar.facts.days[0], calendar.facts.days[2]] }, { ...calendar.facts, timezone: "UTC" }, { ...calendar.facts, days: calendar.facts.days.map((day, i) => i === 1 ? { ...day, close_at: "2025-01-02T01:00:00.000000Z" } : day) } ]) assert.throws(() => publishMarketReference(f.db, actor, f.command({ kind: "calendar", facts }), { now }), /REFERENCE_INVALID_CALENDAR/);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM market_reference_heads").get() as { n: number }).n, 0);
  } finally { f.close(); }
});
test("strict source originals reject BOM, duplicate keys, arrays, invalid Unicode and UTF8 overflow without fetching references", () => {
  const f = fixture(); try {
    for (const content of ["\uFEFF{}", '{"x":1,"x":2}', "[]", '{"x":"\uD800"}', '{"x":"' + "界".repeat(350000) + '"}']) assert.throws(() => storeMarketReferenceSource(f.db, actor, { ...f.sourceInput, idempotency_key: "bad", content_text: content }, { now }), /REFERENCE_INVALID_SOURCE|REFERENCE_SOURCE_TOO_LARGE/);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM market_reference_sources").get() as { n: number }).n, 1);
  } finally { f.close(); }
});
test("restore marker blocks exact retries and publication, while source/version/state reads remain zero-write", () => {
  const f = fixture(); try {
    const result = publishMarketReference(f.db, actor, f.command(mapping), { now });
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic read-only test\n");
    const before = f.db.prepare("SELECT total_changes() n").get();
    assert.throws(() => storeMarketReferenceSource(f.db, actor, f.sourceInput, { now }), /WORKBENCH_READ_ONLY/);
    assert.throws(() => publishMarketReference(f.db, actor, f.command(mapping), { now }), /WORKBENCH_READ_ONLY/);
    assert.equal(readMarketReferenceVersion(f.db, f.portfolio, result.id).document.id, result.id); assert.equal(getMarketReferenceState(f.db, { portfolio_id: f.portfolio }).read_only, true);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  } finally { f.close(); }
});
test("even self-rehashed reference documents cannot change reviewed facts without the matching immutable audit", () => {
  const f = fixture(); try {
    const result = publishMarketReference(f.db, actor, f.command(mapping), { now });
    const { document } = readMarketReferenceVersion(f.db, f.portfolio, result.id);
    f.db.exec("DROP TRIGGER market_reference_version_no_update");
    (document.facts as typeof mapping.facts).provider_symbol = "OTHER.US";
    f.db.prepare("UPDATE market_reference_versions SET document_json=?,content_hash=? WHERE id=?").run(canonical(document), hash(document), result.id);
    assert.throws(() => readMarketReferenceVersion(f.db, f.portfolio, result.id), /REFERENCE_VERSION_INTEGRITY_FAILED/);
  } finally { f.close(); }
});
test("common listing IDs retain legal punctuation, reject slash, and never guess legacy date-only instants", () => {
  const f = fixture(); try {
    for (const [id, listingCreated, catalogCreated] of [["synthetic:ETF_1-2.US", now, now], ["synthetic-legacy-listing", "2026-01-01", now], ["synthetic-legacy-catalog", now, "2026-01-01"], ["synthetic/invalid", now, now]]) {
      f.db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES(?,'synthetic-instrument','US','XNAS',?,'USD',?)").run(id, id, listingCreated);
      f.db.prepare("INSERT INTO catalog_entries(portfolio_id,listing_id,created_at) VALUES(?,?,?)").run(f.portfolio, id, catalogCreated);
      const command = f.command({ ...mapping, facts: { ...mapping.facts, listing_id: id } } as ReferenceDocument, id.replace("/", "-"));
      if (id === "synthetic:ETF_1-2.US") assert.equal(publishMarketReference(f.db, actor, command, { now }).scope_key, id);
      else if (id.includes("/")) assert.throws(() => publishMarketReference(f.db, actor, command, { now }), /REFERENCE_INVALID_COMMAND/);
      else assert.throws(() => publishMarketReference(f.db, actor, command, { now }), /REFERENCE_INVALID_MAPPING/);
    }
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM market_reference_versions").get() as { n: number }).n, 1);
  } finally { f.close(); }
});
test("price collection queues only explicit reviewed sets and retries exact bytes before rechecking changed heads", () => {
  const f = fixture(); try {
    const m = publishMarketReference(f.db, actor, f.command(mapping), { now }), c = publishMarketReference(f.db, actor, f.command(calendar, "calendar"), { now });
    const payload = { schema_version: "market-price-collect-v1", provider: "longport", mapping_version_ids: [m.id], calendar_version_ids: [c.id], start_date: "2025-01-01", end_date: "2025-01-03", expected_publication_revision: 0, publish: false };
    const command = { portfolio_id: f.portfolio, idempotency_key: "collect", expected_revision: 0, command_type: "market_collect_prices", payload };
    const result = enqueueWorkbenchTask(f.db, actor, command, now);
    assert.equal(result.status, "queued"); assert.equal(result.payload_hash, hash(payload));
    assert.equal((f.db.prepare("SELECT payload_json FROM command_requests WHERE id=?").get(result.request_id) as { payload_json: string }).payload_json, canonical(payload));
    publishMarketReference(f.db, actor, f.command(mapping, "mapping-next", 1), { now: "2026-01-01T00:00:00.000001Z" });
    assert.deepEqual(enqueueWorkbenchTask(f.db, actor, command, "2026-01-01T00:00:00.000002Z"), result);
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...command, idempotency_key: "stale-new" }, "2026-01-01T00:00:00.000002Z"), /REFERENCE_VERSION_CONFLICT/);
    for (const table of ["ledger_events", "approval_events", "activations", "account_capabilities", "market_sdk_captures", "market_batches"]) assert.equal((f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM command_requests").get() as { n: number }).n, 1);
  } finally { f.close(); }
});
test("price enqueue rejects unknown transports, cross-portfolio references, incomplete sets and stale ledger CAS without writes", () => {
  const f = fixture(); try {
    const m = publishMarketReference(f.db, actor, f.command(mapping), { now }), c = publishMarketReference(f.db, actor, f.command(calendar, "calendar"), { now });
    const extra = publishMarketReference(f.db, actor, f.command({ ...calendar, facts: { ...calendar.facts, exchange: "XNYS" } } as ReferenceDocument, "calendar-unused"), { now });
    const payload = { schema_version: "market-price-collect-v1", provider: "longport", mapping_version_ids: [m.id], calendar_version_ids: [c.id], start_date: "2025-01-01", end_date: "2025-01-03", expected_publication_revision: 0, publish: true };
    const command = { portfolio_id: f.portfolio, idempotency_key: "collect-invalid", expected_revision: 0, command_type: "market_collect_prices", payload };
    const before = f.db.prepare("SELECT total_changes() n").get();
    for (const patch of [{ url: "https://synthetic.invalid/not-used" }, { sdk_json: {} }, { verified: true }, { source_mode: "provider_observed" }, { mapping_version_ids: [m.id, m.id] }, { calendar_version_ids: [c.id, extra.id] }, { calendar_version_ids: [m.id] }, { start_date: "2024-12-01" }, { start_date: "2025-01-01", end_date: "2025-01-01" }]) {
      assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...command, payload: { ...payload, ...patch } }, now), /INVALID_MARKET_PRICE_COLLECT|REFERENCE_VERSION_CONFLICT/);
    }
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...command, portfolio_id: f.other }, now), /REFERENCE_VERSION_OUT_OF_SCOPE/);
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, { ...command, expected_revision: 1 }, now), /VERSION_CONFLICT/);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic read-only test\n");
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, command, now), /WORKBENCH_READ_ONLY/);
  } finally { f.close(); }
});
test("reviewed future calendars do not authorize collecting the market-local current day", () => {
  const f = fixture(); try {
    const m = publishMarketReference(f.db, actor, f.command(mapping), { now });
    const c = publishMarketReference(f.db, actor, f.command({ kind: "calendar", facts: { market: "US", exchange: "XNAS", timezone: "America/New_York", range_start: "2025-12-31", range_end: "2026-01-01", days: [{ date: "2025-12-31", kind: "full", close_at: "2025-12-31T21:00:00.000000Z" }, { date: "2026-01-01", kind: "closed", close_at: null }] } }, "year-boundary-calendar"), { now });
    const command = { portfolio_id: f.portfolio, idempotency_key: "local-today", expected_revision: 0, command_type: "market_collect_prices", payload: { schema_version: "market-price-collect-v1", provider: "longport", mapping_version_ids: [m.id], calendar_version_ids: [c.id], start_date: "2025-12-31", end_date: "2025-12-31", expected_publication_revision: 0, publish: false } };
    assert.throws(() => enqueueWorkbenchTask(f.db, actor, command, now), /INVALID_MARKET_PRICE_COLLECT/);
    assert.equal(enqueueWorkbenchTask(f.db, actor, command, "2026-01-01T05:00:00.000000Z").status, "queued");
  } finally { f.close(); }
});
