import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openWorkbench } from "../src/server/workbench-db";
import { canonical, hash } from "../src/server/ledger/service";
import { verifiedMarketSource } from "../src/server/market-source";
import { verifiedPriceCalendarSession, verifiedSdkMarketSource, priceInstant } from "../src/server/market-price-source";
import { publishMarketReference, readMarketReferenceVersion } from "../src/server/market-references/service";

const script = String.raw`
import json,sys,sqlite3
from tests.market.test_price_collection import PriceCollectionTests
from worker.orchestration.db import stamp,content_hash
t=PriceCollectionTests(); t.setUp()
try:
 financial={table:content_hash([dict(row) for row in t.db.execute('SELECT * FROM '+table)]) for table in ('ledger_events','approval_events','activations','reservations')}
 prepared,lease=t.prepare(); result=t.commit(prepared,lease)
 result.update(known_at=stamp(),mapping_id=t.mapping['id'],calendar_id=t.calendar['id'],financial_before=financial)
 target=sqlite3.connect(sys.argv[1]);t.db.backup(target);target.close()
 print(json.dumps(result))
finally:t.doCleanups()
`;
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sdk-price-web-")), filename = path.join(directory, "workbench.db");
  try {
    const result = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.PYTHON ?? "python3", ["-c", script, filename], { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", maxBuffer: 1048576 })) as { batch_id: string; capture_id: string; receipt_hash: string; known_at: string; mapping_id: string; calendar_id: string; financial_before: Record<string, string> };
    const db = openWorkbench(filename);
    return { db, result, directory, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
test("actual human Web review and Python SDK-capture chain independently verify exact projections and private portfolio origin", () => {
  const f = fixture(); try {
    const source = verifiedSdkMarketSource(f.db, f.result.batch_id, f.result.known_at);
    assert.equal(source.portfolio_id, "p"); assert.equal(source.provider, "longport"); assert.equal(source.capture_kind, "sdk_projection"); assert.equal(source.rate_kind, "market_price_not_executable");
    assert.equal(source.capture_id, f.result.capture_id); assert.deepEqual(verifiedMarketSource(f.db, f.result.batch_id, f.result.known_at), source);
    assert.doesNotMatch(JSON.stringify(source), /raw_body|"projections"|provider_symbol|secret|token/);
    const values = f.db.prepare("SELECT value,published_at,time_precision,revision_id FROM market_observations WHERE batch_id=? ORDER BY observed_at").all(f.result.batch_id) as { value: string; published_at: null; time_precision: string; revision_id: string }[];
    assert.equal(values.length, 2); assert.equal(values[0].value, "10.100000000000000001"); assert.equal(values[0].published_at, null); assert.equal(values[0].time_precision, "date");
    for (const [table, before] of Object.entries(f.result.financial_before)) assert.equal(hash(f.db.prepare(`SELECT * FROM ${table}`).all()), before);
  } finally { f.close(); }
});
test("reviewed full/half/closed calendar controls last completed session without creating a publication timestamp", () => {
  const f = fixture(); try {
    const session = (cutoff: string, portfolio = "p", listing = "CN:TEST") => verifiedPriceCalendarSession(f.db, f.result.batch_id, portfolio, listing, cutoff, f.result.known_at);
    assert.equal(session("2025-06-06T06:59:59.999999Z"), "2025-06-05"); assert.equal(session("2025-06-06T07:00:00Z"), "2025-06-06"); assert.equal(session("2025-06-08T06:00:00Z"), "2025-06-06");
    for (const cutoff of ["2025-06-05T06:00:00Z", "2025-06-09T06:00:00Z"]) assert.throws(() => session(cutoff), /PRICE_CALENDAR_EVIDENCE_INVALID/);
    assert.throws(() => session("2025-06-07T06:00:00Z", "another"), /PRICE_CALENDAR_EVIDENCE_INVALID/); assert.throws(() => session("2025-06-07T06:00:00Z", "p", "other"), /PRICE_CALENDAR_EVIDENCE_INVALID/);
  } finally { f.close(); }
});
test("a later reference version invalidates present proof but preserves the prior as-known proof", () => {
  const f = fixture(); try {
    const value = readMarketReferenceVersion(f.db, "p", f.result.calendar_id);
    const now = new Date(Date.now() + 1000).toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
    publishMarketReference(f.db, { id: "synthetic-human", kind: "human" }, { portfolio_id: "p", idempotency_key: "calendar-new-version", expected_version: 1, source_id: value.row.source_id, source_hash: value.row.source_hash, review_reason: "Synthetic later review", acknowledgement: true, document: { kind: "calendar", facts: value.document.facts } }, { now });
    assert.equal(verifiedSdkMarketSource(f.db, f.result.batch_id, f.result.known_at).capture_id, f.result.capture_id);
    assert.throws(() => verifiedSdkMarketSource(f.db, f.result.batch_id, now), /PRICE_PROVIDER_EVIDENCE_INVALID/);
  } finally { f.close(); }
});
test("capture authenticity has microsecond commit boundary and reads do not write during recovery", () => {
  const f = fixture(); try {
    const { updated_at: at } = f.db.prepare("SELECT updated_at FROM job_runs WHERE id=(SELECT job_id FROM market_sdk_captures)").get() as { updated_at: string };
    const micros = priceInstant(at) - 1n, before = new Date(Number(micros / 1000n)).toISOString().slice(0, 19) + "." + (micros % 1000000n).toString().padStart(6, "0") + "Z";
    assert.throws(() => verifiedSdkMarketSource(f.db, f.result.batch_id, before), /PRICE_PROVIDER_EVIDENCE_INVALID/);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic read-only evidence test\n"); const count = f.db.prepare("SELECT total_changes() n").get();
    assert.equal(verifiedSdkMarketSource(f.db, f.result.batch_id, at).capture_id, f.result.capture_id); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), count);
  } finally { f.close(); }
});
test("raw-byte, self-rehashed normalization, false job result and original reference tampering fail closed", () => {
  const f = fixture(); try {
    const original = f.db.prepare("SELECT raw_body,normalized_json,receipt_json,receipt_hash FROM market_sdk_captures").get() as { raw_body: Buffer; normalized_json: string; receipt_json: string; receipt_hash: string };
    f.db.exec("DROP TRIGGER sdk_capture_no_update");
    const modified = Buffer.from(original.raw_body); modified[0] ^= 1;
    f.db.prepare("UPDATE market_sdk_captures SET raw_body=?").run(modified); assert.throws(() => verifiedSdkMarketSource(f.db, f.result.batch_id), /PRICE_PROVIDER_EVIDENCE_INVALID/);
    f.db.prepare("UPDATE market_sdk_captures SET raw_body=?").run(original.raw_body);
    const normalized = JSON.parse(original.normalized_json), receipt = JSON.parse(original.receipt_json); normalized.segments[0].records[0].value = "999"; receipt.normalized_hash = hash(normalized);
    f.db.prepare("UPDATE market_sdk_captures SET normalized_json=?,receipt_json=?,receipt_hash=?").run(canonical(normalized), canonical(receipt), hash(receipt));
    assert.throws(() => verifiedSdkMarketSource(f.db, f.result.batch_id), /PRICE_PROVIDER_EVIDENCE_INVALID/);
    f.db.prepare("UPDATE market_sdk_captures SET normalized_json=?,receipt_json=?,receipt_hash=?").run(original.normalized_json, original.receipt_json, original.receipt_hash);
    f.db.prepare("UPDATE job_runs SET result_json='{}' WHERE id=(SELECT job_id FROM market_sdk_captures)").run(); assert.throws(() => verifiedSdkMarketSource(f.db, f.result.batch_id), /PRICE_PROVIDER_EVIDENCE_INVALID/);
  } finally { f.close(); }
});
