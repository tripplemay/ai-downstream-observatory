import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openWorkbench } from "../src/server/workbench-db";
import { hash } from "../src/server/ledger/service";
import { verifiedMarketSource } from "../src/server/market-source";
import { getCollectionScheduleState, getCollectionSlot } from "../src/server/market-schedules/queries";
import { verifyScheduledCollectionRequest, type CollectionRequestRow } from "../src/server/market-schedules/verification";

// Actual migrated SQLite + discovery/job/lease/capture/publication reducers; only the fixed download is synthetic.
const script = String.raw`
import json,sys,sqlite3
from datetime import timedelta
from unittest.mock import patch
from tests.orchestration.test_collections import CollectionRuntimeTests,NOW,transport
from worker.orchestration.runtime import run_pending_once
from worker.orchestration.db import content_hash,stamp
t=CollectionRuntimeTests();t.setUp()
try:
 before={table:content_hash([dict(row) for row in t.db.execute('SELECT * FROM '+table)]) for table in ('ledger_events','postings','reservations','approval_events','activations')}
 with patch('worker.market.collection.download_ecb_xml',side_effect=transport()):
  job=run_pending_once(t.db,'synthetic-worker',clock=lambda:NOW)
 assert job['status']=='succeeded',job['result_json']
 result=json.loads(job['result_json'])
 t.status('paused',at=NOW+timedelta(seconds=1))
 result.update(known_at=stamp(NOW+timedelta(seconds=2)),financial_before=before,request_id=job['command_request_id'])
 target=sqlite3.connect(sys.argv[1]);t.db.backup(target);target.close()
 print(json.dumps(result))
finally:t.doCleanups()
`;
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "collection-cross-source-")), filename = path.join(directory, "workbench.db");
  try {
    const result = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.PYTHON ?? "python3", ["-c", script, filename], { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", maxBuffer: 1048576, timeout: 60000 })) as { batch_id: string; capture_id: string; request_id: string; known_at: string; financial_before: Record<string, string> };
    const db = openWorkbench(filename), request = db.prepare("SELECT * FROM command_requests WHERE id=?").get(result.request_id) as CollectionRequestRow;
    return { db, result, request, directory, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
test("real Python discovery-to-publish history independently verifies after pause, without false new rate dates or financial writes", () => {
  const f = fixture(); try {
    const binding = verifyScheduledCollectionRequest(f.db, f.request)!;
    assert.equal(binding.authorization.ended_at, "2026-04-09T12:00:01.000000Z");
    const source = verifiedMarketSource(f.db, f.result.batch_id, f.result.known_at);
    assert.equal(source.mode, "provider_observed"); assert.equal(source.capture_id, f.result.capture_id);
    const state = getCollectionScheduleState(f.db, { portfolio_id: "p" }, { now: f.result.known_at });
    assert.equal(state.schedules[0].status, "paused"); assert.equal(state.slots[0].period, "2026-04-09");
    assert.equal(state.slots[0].job?.status, "succeeded"); assert.equal(state.slots[0].capture?.rate_date, "2026-04-08");
    assert.equal(state.slots[0].capture?.received_at, "2026-04-09T12:00:00.000000Z");
    const detail = getCollectionSlot(f.db, { portfolio_id: "p", slot_id: state.slots[0].id }, { now: f.result.known_at });
    assert.equal(detail.attempts.length, 1); assert.equal(detail.attempts[0].status, "succeeded");
    assert.doesNotMatch(JSON.stringify(detail), /raw_body|<gesmes|normalized_json|receipt_json|payload_json|token|secret/);
    for (const [table, before] of Object.entries(f.result.financial_before)) assert.equal(hash(f.db.prepare(`SELECT * FROM ${table}`).all()), before);
    assert.ok((f.db.prepare("SELECT COUNT(*) n FROM market_observations WHERE published_at IS NULL").get() as { n: number }).n > 0);
  } finally { f.close(); }
});
test("completed source reads in restore mode remain zero-write and schedule capture timing cannot escape the original interval", () => {
  const f = fixture(); try {
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "Synthetic recovery marker\n");
    const changes = f.db.prepare("SELECT total_changes() n").get();
    assert.equal(getCollectionScheduleState(f.db, { portfolio_id: "p" }, { now: f.result.known_at }).read_only, true);
    const source = verifiedMarketSource(f.db, f.result.batch_id, f.result.known_at);
    assert.equal(source.mode, "provider_observed"); assert.equal(source.capture_id, f.result.capture_id);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
    f.db.prepare("UPDATE job_attempts SET finished_at='2026-04-09T12:00:01.000000Z' WHERE job_id=(SELECT job_id FROM market_provider_captures WHERE id=?)").run(f.result.capture_id);
    assert.throws(() => verifiedMarketSource(f.db, f.result.batch_id, f.result.known_at), /MARKET_PROVIDER_EVIDENCE_INVALID/);
  } finally { f.close(); }
});
