import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { csvBackgroundCommand, readCsvBackgroundRequest, readCsvBackgroundResult } from "../src/server/csv-background/binding";
import { publishCsvBackground } from "../src/server/csv-background/publisher";
import { requestCsvBackgroundConfirmation } from "../src/server/csv-background/service";
import { readConfirmedCsvImport, readConfirmedCsvImportEvidence } from "../src/server/ledger/csv-confirmation";
import { hash, revision } from "../src/server/ledger/service";
import { csvBackgroundQueryFixture } from "./csv-background-query-fixture";

type Fixture = ReturnType<typeof csvBackgroundQueryFixture>;
function claim(f: Fixture, requestId: string) {
  const binding = readCsvBackgroundRequest(f.db, requestId), jobId = randomUUID(), attemptId = randomUUID();
  f.db.prepare("INSERT INTO job_runs(id,command_request_id,job_type,scope,period,input_version,status,max_attempts,not_before,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',3,?,?,?)")
    .run(jobId, requestId, `csv_import_${binding.row.operation}_v1`, f.portfolio, f.now.slice(0, 10), `${requestId}:${hash(csvBackgroundCommand(binding.row))}`, f.execution, f.execution, f.execution);
  f.db.prepare("UPDATE job_runs SET status='running',attempt_count=1,fencing_token=1,lease_owner='synthetic-worker',lease_until='2026-09-12T00:05:00.000000Z',updated_at=? WHERE id=?").run(f.execution, jobId);
  f.db.prepare("INSERT INTO job_attempts(id,job_id,attempt,fencing_token,status,started_at) VALUES(?,?,1,1,'running',?)").run(attemptId, jobId, f.execution);
  return { job_id: jobId, owner: "synthetic-worker", fencing_token: 1, attempt: 1 };
}
function count(f: Fixture, table: string) {
  return (f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
}

test("fresh confirmation and retained retry each read full rows only at preflight and independent final proof", t => {
  const f = csvBackgroundQueryFixture(t, 3), preview = f.publish(f.enqueue().request_id), first = f.confirm(preview.batch_id);
  const payload = readCsvBackgroundRequest(f.db, first.request_id).confirmation!.payload_text;
  const retry = requestCsvBackgroundConfirmation(f.db, f.principal, { portfolio_id: f.portfolio, account_id: f.account,
    idempotency_key: "confirm-retry", payload_text: payload, acknowledge_background_execution: true }, { ...f.options, now: f.execution });
  const original = f.db.prepare.bind(f.db), observed: string[] = [];
  let currentJob = "";
  f.db.prepare = ((sql: string) => {
    const statement = original(sql);
    if (/^SELECT row_number,raw_json,normalized_json,errors_json FROM import_rows WHERE batch_id=\? ORDER BY row_number$/.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = ((...args: unknown[]) => {
        observed.push((original("SELECT status FROM job_runs WHERE id=?").get(currentJob) as { status: string }).status);
        return all(...args);
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof f.db.prepare;
  const results = [];
  for (const request of [first, retry]) {
    const lease = claim(f, request.request_id); currentJob = lease.job_id; observed.length = 0;
    publishCsvBackground(f.db, lease, { dataDir: f.dir, now: f.execution });
    assert.deepEqual(observed, ["running", "succeeded"]);
    observed.length = 0;
    results.push(readCsvBackgroundResult(f.db, request.request_id, f.options)!);
    assert.deepEqual(observed, ["succeeded"], "An independent history read performs its own complete proof once");
  }
  assert.equal(results[0].receipts_hash, results[1].receipts_hash);
  assert.equal(count(f, "ledger_events"), 3); assert.equal(count(f, "csv_import_outcomes"), 3); assert.equal(revision(f.db, f.portfolio), 3);
});

for (const corruption of ["last_row", "manifest", "last_outcome", "csv_attachment", "mapping_attachment"] as const) {
  test(`final confirmation proof freshly rejects ${corruption} changed after preflight and rolls back all facts`, t => {
    const f = csvBackgroundQueryFixture(t), preview = f.publish(f.enqueue().request_id), request = f.confirm(preview.batch_id), lease = claim(f, request.request_id);
    let mutated = false;
    assert.throws(() => publishCsvBackground(f.db, lease, { dataDir: f.dir, now: f.execution, beforeCommit: () => {
      mutated = true;
      assert.equal(revision(f.db, f.portfolio), 27);
      if (corruption === "last_row") {
        f.db.exec("DROP TRIGGER csv_rows_no_update");
        f.db.prepare("UPDATE import_rows SET errors_json='[\"SYNTHETIC_CORRUPTION\"]' WHERE batch_id=? AND row_number=27").run(preview.batch_id);
      } else if (corruption === "manifest") {
        f.db.exec("DROP TRIGGER csv_manifest_no_update");
        f.db.prepare("UPDATE csv_import_manifests SET content_hash=? WHERE batch_id=?").run("0".repeat(64), preview.batch_id);
      } else if (corruption === "last_outcome") {
        f.db.exec("DROP TRIGGER csv_outcomes_no_update");
        f.db.prepare("UPDATE csv_import_outcomes SET result_json='{}' WHERE batch_id=? AND row_number=27").run(preview.batch_id);
      } else {
        const extension = corruption === "csv_attachment" ? ".csv" : ".json";
        const attachment = f.db.prepare("SELECT storage_key FROM attachments WHERE storage_key LIKE ?").get(`%${extension}`) as { storage_key: string };
        writeFileSync(path.join(f.dir, attachment.storage_key), "corrupt");
      }
    } }), /CSV_BACKGROUND_EVIDENCE_INVALID/);
    assert.equal(mutated, true);
    for (const table of ["ledger_events", "postings", "csv_import_outcomes"]) assert.equal(count(f, table), 0, table);
    assert.equal(revision(f.db, f.portfolio), 0);
    assert.equal(readCsvBackgroundResult(f.db, request.request_id, f.options), null);
    assert.equal((f.db.prepare("SELECT status FROM import_batches WHERE id=?").get(preview.batch_id) as { status: string }).status, "preview");
    assert.equal((f.db.prepare("SELECT status FROM job_runs WHERE id=?").get(lease.job_id) as { status: string }).status, "running");
    assert.equal((f.db.prepare("SELECT status FROM job_attempts WHERE job_id=?").get(lease.job_id) as { status: string }).status, "running");
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='confirm_import'").get() as { n: number }).n, 0);
  });
}

test("the enriched confirmed reader preserves the public receipt and never reuses an earlier proof", t => {
  const f = csvBackgroundQueryFixture(t, 3), preview = f.publish(f.enqueue().request_id);
  f.publish(f.confirm(preview.batch_id).request_id);
  const first = readConfirmedCsvImportEvidence(f.db, f.actor, f.portfolio, preview.batch_id, f.options);
  assert.deepEqual(readConfirmedCsvImport(f.db, f.actor, f.portfolio, preview.batch_id, f.options), first.result);
  assert.deepEqual(Object.keys(first.result).sort(), ["csv_review_hash", "duplicate", "receipts", "revision"]);
  first.rows[0].errors.push("Caller-owned mutation"); first.manifest.review_hash = "0".repeat(64);
  const second = readConfirmedCsvImportEvidence(f.db, f.actor, f.portfolio, preview.batch_id, f.options);
  assert.deepEqual(second.rows[0].errors, []); assert.notEqual(second.manifest.review_hash, first.manifest.review_hash);
  assert.throws(() => readConfirmedCsvImportEvidence(f.db, f.actor, "foreign", preview.batch_id, f.options), /IMPORT_NOT_FOUND/);
  f.db.exec("DROP TRIGGER csv_rows_no_update");
  f.db.prepare("UPDATE import_rows SET errors_json='[\"Changed\"]' WHERE batch_id=? AND row_number=3").run(preview.batch_id);
  assert.throws(() => readConfirmedCsvImport(f.db, f.actor, f.portfolio, preview.batch_id, f.options), /CSV_IMPORT_EVIDENCE_INVALID/);
});
