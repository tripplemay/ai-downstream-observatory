import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { evaluationObservation, type Publication } from "../src/server/governance/risk";
import type { Policy } from "../src/server/governance/schemas";

const now = "2026-01-05T12:00:00.000Z";
const policy = { execution: { max_price_age_seconds: 86400 } } as Policy;
const publications: Publication[] = [{ scope: "synthetic", batch_id: "b", manifest_hash: "a".repeat(64), revision: 1, published_at: now }];
function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE market_observations(id TEXT,listing_id TEXT,series_key TEXT,metric TEXT,value TEXT,
    source_id TEXT DEFAULT 'synthetic',revision_id TEXT DEFAULT 'synthetic-v1',unit TEXT DEFAULT 'CNY',observed_at TEXT DEFAULT '2026-01-05T01:00:00.000Z',
    ingested_at TEXT DEFAULT '2026-01-05T02:00:00.000Z',published_at TEXT,price_basis TEXT DEFAULT 'unadjusted',
    provenance TEXT DEFAULT 'live_observed',time_precision TEXT DEFAULT 'second',source_timezone TEXT DEFAULT 'UTC');
    CREATE TABLE market_batch_members(batch_id TEXT,observation_id TEXT);`);
  let count = 0;
  const add = (listing: string | null, series: string, metric = "close", value = "10", ingested = "2026-01-05T02:00:00.000Z") => {
    const id = `synthetic-${++count}`;
    db.prepare("INSERT INTO market_observations(id,listing_id,series_key,metric,value,price_basis,ingested_at) VALUES(?,?,?,?,?,?,?)").run(id, listing, series, metric, value, metric === "close" ? "unadjusted" : "not_applicable", ingested);
    db.prepare("INSERT INTO market_batch_members VALUES('b',?)").run(id);
    return id;
  };
  return { db, add, read: (listing: string, metric = "close") => evaluationObservation(db, publications, "synthetic", listing, metric, policy, now) };
}
test("price series aliases never substitute another listing identity or a missing listing binding", () => {
  const f = fixture(); try {
    f.add("OTHER", "TARGET"); f.add(null, "MISSING");
    assert.throws(() => f.read("TARGET"), /MARKET_OBSERVATION_UNAVAILABLE:close/);
    assert.throws(() => f.read("MISSING"), /MARKET_OBSERVATION_UNAVAILABLE:close/);
    assert.equal(f.read("OTHER").value, "10", "the listing binding, not the opaque provider series, identifies the security");
    f.add("GOOD", "PRICE:GOOD"); assert.equal(f.read("GOOD").value, "10");
    assert.throws(() => f.read("PRICE:GOOD"), /MARKET_OBSERVATION_UNAVAILABLE:close/);
    f.add("LEGACY", "LEGACY"); assert.equal(f.read("LEGACY").value, "10");
    f.add("CUSTOM", "SOURCE:CN:SYMBOL"); assert.equal(f.read("CUSTOM").value, "10");
  } finally { f.db.close(); }
});
for (const field of ["observed_at", "published_at", "ingested_at"]) test(`a future ${field} one microsecond ahead is not rounded back into current knowledge`, () => {
  const f = fixture(); try {
    const id = f.add("TARGET", "SOURCE:CN:TARGET");
    f.db.prepare(`UPDATE market_observations SET ${field}='2026-01-05T12:00:00.000001Z' WHERE id=?`).run(id);
    assert.throws(() => f.read("TARGET"), /MARKET_OBSERVATION_UNAVAILABLE:close/);
    assert.equal(evaluationObservation(f.db, publications, "synthetic", "TARGET", "close", policy, "2026-01-05T12:00:00.000001Z").id, id);
  } finally { f.db.close(); }
});
test("mixed UTC precision sorts by actual instants, including equal-time duplicate aliases", () => {
  const f = fixture(); try {
    const first = f.add("TARGET", "source-a");
    f.db.prepare("UPDATE market_observations SET observed_at='2026-01-05T12:00:00Z',ingested_at='2026-01-05T12:00:00.000Z' WHERE id=?").run(first);
    assert.equal(f.read("TARGET").id, first);
    const duplicate = f.add("TARGET", "source-b");
    f.db.prepare("UPDATE market_observations SET observed_at='2026-01-05T12:00:00.000000Z',ingested_at='2026-01-05T12:00:00Z' WHERE id=?").run(duplicate);
    assert.equal(f.read("TARGET").value, "10", "equivalent aliases are not conflicting prices");
    f.db.prepare("UPDATE market_observations SET value='11' WHERE id=?").run(duplicate);
    assert.throws(() => f.read("TARGET"), /MARKET_OBSERVATION_AMBIGUOUS/);
  } finally { f.db.close(); }
});
test("a known but impossible future bar blocks rather than silently falling back to an older bar", () => {
  const f = fixture(); try {
    f.add("TARGET", "historical"); const id = f.add("TARGET", "future");
    f.db.prepare("UPDATE market_observations SET observed_at='2026-01-05T12:00:00.0000001Z' WHERE id=?").run(id);
    assert.throws(() => f.read("TARGET"), /MARKET_OBSERVATION_UNAVAILABLE:close/);
  } finally { f.db.close(); }
});
test("equally timed duplicate price identities block instead of choosing a UUID winner", () => {
  const f = fixture(); try {
    f.add("TARGET", "TARGET"); f.add("TARGET", "PRICE:TARGET", "close", "11");
    assert.throws(() => f.read("TARGET"), /MARKET_OBSERVATION_AMBIGUOUS/);
    const latest = f.add("TARGET", "PRICE:TARGET", "close", "12", "2026-01-05T03:00:00.000Z");
    assert.equal(f.read("TARGET").id, latest);
  } finally { f.db.close(); }
});
test("FX keeps its own currency series and cannot consume a security-bound observation", () => {
  const f = fixture(); try {
    f.add("TARGET", "FX:USD", "fx_cny_per_unit", "999");
    assert.throws(() => f.read("FX:USD", "fx_cny_per_unit"), /MARKET_OBSERVATION_UNAVAILABLE:fx_cny_per_unit/);
    const id = f.add(null, "FX:USD", "fx_cny_per_unit", "7");
    assert.equal(f.read("FX:USD", "fx_cny_per_unit").id, id);
    assert.throws(() => f.read("FX:HKD", "fx_cny_per_unit"), /MARKET_OBSERVATION_UNAVAILABLE:fx_cny_per_unit/);
  } finally { f.db.close(); }
});
