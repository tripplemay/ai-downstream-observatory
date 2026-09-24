import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openWorkbench } from "../src/server/workbench-db";
import { hash } from "../src/server/ledger/service";
import { verifiedSdkMarketSource } from "../src/server/market-price-source";
import { publishMarketReference, readMarketReferenceVersion } from "../src/server/market-references/service";
import { getPriceCollectionScheduleState, getPriceCollectionSlot } from "../src/server/price-schedules/queries";
import { verifyScheduledPriceCollectionRequest, type PriceCollectionRequestRow } from "../src/server/price-schedules/verification";

// Only SDK transport is synthetic; human service, discovery, isolated child and publication are real reducers.
const script = String.raw`
import json,sqlite3,sys
from tests.orchestration.test_price_collections import PriceScheduleTests
from worker.orchestration.runtime import run_pending_once
from worker.orchestration.db import content_hash,stamp
t=PriceScheduleTests();t.setUp()
try:
 before={name:content_hash([dict(row) for row in t.db.execute('SELECT * FROM '+name)]) for name in ('ledger_events','postings','reservations','approval_events','activations')}
 t.enable()
 with t.transport():job=run_pending_once(t.db,'synthetic-provider',role='longport')
 assert job['status']=='succeeded',job['result_json']
 result=json.loads(job['result_json']);t.status('paused',stamp())
 slot=t.slots()[0]
 result.update(known_at=stamp(),financial_before=before,request_id=job['command_request_id'],slot_id=slot['id'],period=slot['period'],deadline_at=slot['deadline_at'])
 target=sqlite3.connect(sys.argv[1]);t.db.backup(target);target.close()
 print(json.dumps(result))
finally:t.doCleanups()
`;
type Result = { batch_id: string; capture_id: string; request_id: string; slot_id: string; known_at: string; period: string; deadline_at: string; financial_before: Record<string, string> };
let baseline: { bytes: Buffer; result: Result } | undefined;
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "price-schedule-source-")), filename = path.join(directory, "workbench.db");
  try {
    if (!baseline) {
      const result = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.PYTHON ?? "python3", ["-c", script, filename], { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", maxBuffer: 1048576, timeout: 60000 })) as Result;
      baseline = { bytes: readFileSync(filename), result };
    } else writeFileSync(filename, baseline.bytes);
    const db = openWorkbench(filename), result = baseline.result;
    const request = db.prepare("SELECT * FROM command_requests WHERE id=?").get(result.request_id) as PriceCollectionRequestRow;
    const unguard = (table: string) => {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as { name: string }[]) db.exec(`DROP TRIGGER "${row.name}"`);
    };
    return { db, result, request, directory, unguard, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
test("real recurring isolated SDK publication remains independently verifiable after human pause without financial writes", () => {
  const f = fixture(); try {
    const binding = verifyScheduledPriceCollectionRequest(f.db, f.request)!;
    assert.ok(binding.authorization.ended_at);
    const source = verifiedSdkMarketSource(f.db, f.result.batch_id, f.result.known_at);
    assert.equal(source.capture_id, f.result.capture_id); assert.equal(source.capture_kind, "sdk_projection");
    const state = getPriceCollectionScheduleState(f.db, { portfolio_id: "p" }, { now: f.result.known_at });
    assert.equal(state.schedules[0].status, "paused"); assert.equal(state.slots[0].period, f.result.period);
    assert.equal(state.slots[0].job?.status, "succeeded"); assert.equal(state.slots[0].capture?.id, f.result.capture_id);
    const detail = getPriceCollectionSlot(f.db, { portfolio_id: "p", slot_id: f.result.slot_id }, { now: f.result.known_at });
    assert.equal(detail.attempts.length, 1); assert.equal(detail.attempts[0].status, "succeeded");
    assert.doesNotMatch(JSON.stringify(detail), /raw_body|normalized_json|receipt_json|payload_json|fixture-only/);
    for (const [name, before] of Object.entries(f.result.financial_before)) assert.equal(hash(f.db.prepare(`SELECT * FROM ${name}`).all()), before);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM market_observations WHERE published_at IS NULL").get() as { n: number }).n, 1);
  } finally { f.close(); }
});
test("restore reads are zero-write and original schedule authority survives a newer current reference head", () => {
  const f = fixture(); try {
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic restore marker\n");
    const before = f.db.prepare("SELECT total_changes() n").get();
    assert.equal(getPriceCollectionScheduleState(f.db, { portfolio_id: "p" }, { now: f.result.known_at }).read_only, true);
    assert.equal(verifiedSdkMarketSource(f.db, f.result.batch_id, f.result.known_at).capture_id, f.result.capture_id);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    rmSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"));
    const id = (f.db.prepare("SELECT version_id FROM market_reference_heads WHERE kind='mapping'").get() as { version_id: string }).version_id;
    const reference = readMarketReferenceVersion(f.db, "p", id), now = new Date(Date.parse(f.result.known_at) + 1000).toISOString().replace(/Z$/, "000Z");
    publishMarketReference(f.db, { id: "synthetic-human", kind: "human" }, { portfolio_id: "p", idempotency_key: "later-human-reference", expected_version: reference.row.version,
      source_id: reference.source.id, source_hash: reference.source.content_hash, review_reason: "Synthetic later explicit human review", acknowledgement: true,
      document: { kind: reference.document.kind, facts: reference.document.facts } }, { now });
    const state = getPriceCollectionScheduleState(f.db, { portfolio_id: "p" }, { now });
    assert.equal(state.schedules[0].reference_status, "changed"); assert.equal(state.slots[0].capture?.id, f.result.capture_id);
  } finally { f.close(); }
});
for (const [label, mutate] of [
  ["reserved actor without its immutable slot", (f: ReturnType<typeof fixture>) => { f.unguard("price_collection_schedule_slots"); f.db.prepare("DELETE FROM price_collection_schedule_slots").run(); }],
  ["wrong scheduled job input version", (f: ReturnType<typeof fixture>) => { f.unguard("job_runs"); f.db.prepare("UPDATE job_runs SET input_version='synthetic-other'").run(); }],
  ["wrong scheduled job target date", (f: ReturnType<typeof fixture>) => { f.unguard("job_runs"); f.db.prepare("UPDATE job_runs SET period='2000-01-01'").run(); }],
  ["wrong scheduled retry bound", (f: ReturnType<typeof fixture>) => { f.unguard("job_runs"); f.db.prepare("UPDATE job_runs SET max_attempts=5").run(); }],
  ["attempt started outside the original window", (f: ReturnType<typeof fixture>) => { f.unguard("job_attempts"); f.db.prepare("UPDATE job_attempts SET started_at='2000-01-01T00:00:00.000000Z'").run(); }],
  ["finalization exactly at deadline", (f: ReturnType<typeof fixture>) => { f.unguard("job_runs"); f.db.prepare("UPDATE job_runs SET updated_at=?").run(f.result.deadline_at); }],
  ["finalization exactly at pause", (f: ReturnType<typeof fixture>) => { const end = verifyScheduledPriceCollectionRequest(f.db, f.request)!.authorization.ended_at; f.unguard("job_runs"); f.db.prepare("UPDATE job_runs SET updated_at=?").run(end); }],
] as const) test(`old price consumer and new historical query reject ${label}`, () => {
  const f = fixture(); try {
    mutate(f);
    assert.throws(() => verifiedSdkMarketSource(f.db, f.result.batch_id, "2099-01-01T00:00:00.000000Z"), /PRICE_PROVIDER_EVIDENCE_INVALID/);
    assert.throws(() => getPriceCollectionSlot(f.db, { portfolio_id: "p", slot_id: f.result.slot_id }, { now: "2099-01-01T00:00:00.000000Z" }), /PRICE_COLLECTION_(?:EVIDENCE_INVALID|SLOT_NOT_FOUND)/);
  } finally { f.close(); }
});
