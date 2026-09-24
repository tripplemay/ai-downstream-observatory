import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, recordFact, revision, hash, canonical } from "../src/server/ledger/service";
import { confirmImport, getImportPreview } from "../src/server/ledger/imports";
import { previewCsvImport } from "../src/server/ledger/csv-imports";
import { saveCsvConfirmationAttempt } from "../src/server/ledger/csv-confirmation-recovery";
import { requestCsvBackgroundPreview, requestCsvBackgroundConfirmation, cancelCsvBackgroundRequest } from "../src/server/csv-background/service";
import { csvBackgroundCommand, readCsvBackgroundRequest, readCsvBackgroundResult } from "../src/server/csv-background/binding";
import { publishCsvBackground } from "../src/server/csv-background/publisher";
import type { CsvBackgroundPreviewInput } from "../src/server/csv-background/types";

const now = "2026-09-12T00:00:00.000000Z", execution = "2026-09-12T00:00:01.000000Z";
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "csv-background-")), filename = path.join(dir, "workbench.db"); migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "owner" }, principal = { actorId: actor.id, sessionHash: "a".repeat(64) };
  const portfolio = createPortfolio(db, actor, "Synthetic background"), account = createAccount(db, actor, portfolio, "A", "Synthetic", "CNY");
  const mapping = JSON.stringify({ schema_version: "csv-import-mapping-v1", mapping_id: "SYNTHETIC-DEPOSIT", version: 1, title: "Synthetic only",
    dialect: { encoding: "utf-8", delimiter: ",", record_separator: "either" }, expected_headers: ["date", "amount", "id", "note"], ignored_columns: [],
    account: { kind: "constant", value: account }, event_type: { kind: "constant", value: "deposit" }, source_id: "synthetic",
    source_event_id: { kind: "column", column: "id", trim: false, empty: "reject" }, reason: { kind: "column", column: "note", trim: false, empty: "reject" },
    effective_at: { column: "date", format: "YYYY-MM-DD", trim: false, source_timezone: "Asia/Shanghai" },
    rules: [{ event_type: "deposit", fields: { currency: { kind: "constant", value: "CNY" }, amount: { kind: "decimal", column: "amount", empty: "reject", format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false } } } }] });
  const bytes = Buffer.from("date,amount,id,note\n2026-01-01,100,s1,Initial\n2026-01-02,50,s2,Second\n");
  const options = { now, dataDir: dir };
  const input: CsvBackgroundPreviewInput = { portfolio_id: portfolio, account_id: account, expected_revision: 0, idempotency_key: "preview-1", mapping, bytes, filename: "synthetic.csv", acknowledge_background_execution: true };
  const enqueue = (patch: Partial<CsvBackgroundPreviewInput> = {}) => requestCsvBackgroundPreview(db, principal, { ...input, ...patch }, options);
  const claim = (requestId: string) => {
    const binding = readCsvBackgroundRequest(db, requestId), jobId = randomUUID(), attemptId = randomUUID();
    db.prepare("INSERT INTO job_runs(id,command_request_id,job_type,scope,period,input_version,status,max_attempts,not_before,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',3,?,?,?)")
      .run(jobId, requestId, `csv_import_${binding.row.operation}_v1`, portfolio, now.slice(0, 10), `${requestId}:${hash(csvBackgroundCommand(binding.row))}`, execution, execution, execution);
    db.prepare("UPDATE job_runs SET status='running',attempt_count=1,fencing_token=1,lease_owner='synthetic-worker',lease_until='2026-09-12T00:05:00.000000Z',updated_at=? WHERE id=?").run(execution, jobId);
    db.prepare("INSERT INTO job_attempts(id,job_id,attempt,fencing_token,status,started_at) VALUES(?,?,1,1,'running',?)").run(attemptId, jobId, execution);
    return { job_id: jobId, owner: "synthetic-worker", fencing_token: 1, attempt: 1 };
  };
  const publish = (requestId: string) => { const lease = claim(requestId); publishCsvBackground(db, lease, { now: execution, dataDir: dir }); return readCsvBackgroundResult(db, requestId, options)!; };
  const payload = (batchId: string) => { const p = getImportPreview(db, actor, portfolio, batchId); return JSON.stringify({ action: "confirm_import", portfolio_id: portfolio, batch_id: p.id, preview_hash: p.preview_hash, expected_revision: p.expected_revision, csv_review: { acknowledge_unverified_mapping: true, review_hash: p.csv!.review_hash, rows: [] } }); };
  const confirm = (batchId: string) => requestCsvBackgroundConfirmation(db, principal, { portfolio_id: portfolio, account_id: account, idempotency_key: "confirm-1", payload_text: payload(batchId), acknowledge_background_execution: true }, { ...options, now: execution });
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  return { db, dir, actor, principal, portfolio, account, options, input, bytes, enqueue, claim, publish, payload, confirm, count, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("background preview and human confirmation publish real atomic domain receipts, not queue acceptance", () => {
  const f = fixture(); try {
    const request = f.enqueue(); assert.equal(f.count("import_batches"), 0); assert.equal(f.count("job_runs"), 0);
    const preview = f.publish(request.request_id); assert.equal(preview.row_count, 2); assert.equal(preview.batch_status, "preview"); assert.equal(revision(f.db, f.portfolio), 0);
    assert.throws(() => confirmImport(f.db, f.actor, "foreign-portfolio", preview.batch_id, preview.preview_hash, 0, execution, f.options), /IMPORT_NOT_FOUND/);
    assert.throws(() => confirmImport(f.db, f.actor, f.portfolio, preview.batch_id, preview.preview_hash, 0, execution, f.options, JSON.parse(f.payload(preview.batch_id)).csv_review), /CSV_BACKGROUND_CONFIRM_REQUIRED/);
    const confirm = f.confirm(preview.batch_id); assert.equal(f.count("ledger_events"), 0);
    const result = f.publish(confirm.request_id); assert.equal(result.confirmed_revision, 2); assert.equal(f.count("ledger_events"), 2); assert.equal(f.count("csv_import_outcomes"), 2);
    assert.equal(result.receipts_hash?.length, 64); assert.deepEqual(readCsvBackgroundResult(f.db, request.request_id, f.options), preview);
    assert.deepEqual(f.confirm(preview.batch_id), confirm); assert.equal(f.count("csv_background_requests"), 2);
    assert.throws(() => cancelCsvBackgroundRequest(f.db, f.principal, { portfolio_id: f.portfolio, request_id: confirm.request_id, reason: "too late" }, { now: execution }), /ALREADY_TERMINAL/);
  } finally { f.close(); }
});

test("legacy background rejection is scoped and precedes loading the entire batch evidence", () => {
  const f = fixture(); try {
    const preview = f.publish(f.enqueue().request_id);
    f.db.exec("DROP TRIGGER csv_manifest_no_update");
    f.db.prepare("UPDATE csv_import_manifests SET content_hash=? WHERE batch_id=?").run("0".repeat(64), preview.batch_id);
    assert.throws(() => confirmImport(f.db, f.actor, "foreign", preview.batch_id, preview.preview_hash, 0, execution, f.options), /IMPORT_NOT_FOUND/);
    assert.throws(() => confirmImport(f.db, f.actor, f.portfolio, preview.batch_id, preview.preview_hash, 0, execution, f.options), /CSV_BACKGROUND_CONFIRM_REQUIRED/);
    assert.equal(f.count("ledger_events"), 0);
  } finally { f.close(); }
});

test("exact input replay keeps original deadline and bytes; changed input conflicts", () => {
  const f = fixture(); try {
    const original = f.enqueue(), first = readCsvBackgroundRequest(f.db, original.request_id).row;
    assert.deepEqual(requestCsvBackgroundPreview(f.db, f.principal, f.input, { now: "2026-09-13T00:00:00Z" }), original);
    assert.equal(readCsvBackgroundRequest(f.db, original.request_id).row.expires_at, first.expires_at);
    for (const change of [{ filename: "other.csv" }, { mapping: ` ${f.input.mapping}` }, { bytes: Buffer.from(f.bytes.toString().replace("100", "101")) }, { expected_revision: 1 }]) assert.throws(() => f.enqueue(change), /IDEMPOTENCY_CONFLICT/);
    f.bytes.fill(0); assert.notDeepEqual(readCsvBackgroundRequest(f.db, original.request_id).row.csv_bytes, f.bytes);
  } finally { f.close(); }
});

test("archive alone never approves or dispatches, and missing manual acknowledgement stays unapproved", () => {
  const f = fixture(); try {
    const preview = previewCsvImport(f.db, f.actor, f.input, f.options), raw = f.payload(preview.id);
    saveCsvConfirmationAttempt(f.db, f.principal, raw, f.options); assert.equal(f.count("command_requests"), 0); assert.equal(f.count("csv_background_requests"), 0);
    assert.throws(() => requestCsvBackgroundConfirmation(f.db, f.principal, { portfolio_id: f.portfolio, account_id: f.account, idempotency_key: "confirm-1", payload_text: raw, acknowledge_background_execution: false } as never, f.options), /INPUT_INVALID/);
    const invalid = JSON.stringify({ ...JSON.parse(raw), csv_review: undefined });
    assert.throws(() => requestCsvBackgroundConfirmation(f.db, f.principal, { portfolio_id: f.portfolio, account_id: f.account, idempotency_key: "confirm-1", payload_text: invalid, acknowledge_background_execution: true }, f.options), /CSV_REVIEW_INVALID/);
    assert.equal(f.count("csv_confirmation_attempts"), 2); assert.equal(f.count("command_requests"), 0);
  } finally { f.close(); }
});

test("current owner may cancel from a new session, not another actor or portfolio", () => {
  const f = fixture(); try {
    const request = f.enqueue(), input = { portfolio_id: f.portfolio, request_id: request.request_id, reason: "explicit cancellation" };
    assert.throws(() => cancelCsvBackgroundRequest(f.db, { ...f.principal, actorId: "other" }, input, f.options), /NOT_FOUND/);
    assert.throws(() => cancelCsvBackgroundRequest(f.db, f.principal, { ...input, portfolio_id: "foreign" }, f.options), /NOT_FOUND/);
    const receipt = cancelCsvBackgroundRequest(f.db, { ...f.principal, sessionHash: "b".repeat(64) }, input, f.options);
    assert.equal(receipt.status, "cancelled"); assert.deepEqual(cancelCsvBackgroundRequest(f.db, f.principal, input, f.options), receipt);
    assert.throws(() => f.publish(request.request_id), /CSV_BACKGROUND_CANCELLED/); assert.equal(f.count("import_batches"), 0);
  } finally { f.close(); }
});

for (const failure of ["deadline", "lease", "recovery", "throw"] as const) test(`final ${failure} rolls back every preview effect and result`, () => {
  const f = fixture(); try {
    const request = f.enqueue(), lease = f.claim(request.request_id); let calls = 0;
    const clock = () => calls++ ? failure === "deadline" ? "2026-09-12T00:15:00Z" : failure === "lease" ? "2026-09-12T00:05:00Z" : execution : execution;
    assert.throws(() => publishCsvBackground(f.db, lease, { dataDir: f.dir, clock, beforeCommit: () => {
      if (failure === "recovery") writeFileSync(path.join(f.dir, "RESTORE_PENDING_REVIEW"), "synthetic");
      if (failure === "throw") throw new Error("synthetic failure");
    } }));
    for (const table of ["import_batches", "import_rows", "csv_import_manifests", "ledger_events", "csv_background_results"]) assert.equal(f.count(table), 0, table);
    assert.equal((f.db.prepare("SELECT status FROM job_runs").get() as { status: string }).status, "running");
  } finally { f.close(); }
});

test("confirm final failure rolls back facts, posting/outcome rows and revision as one batch", () => {
  const f = fixture(); try {
    const preview = f.publish(f.enqueue().request_id), request = f.confirm(preview.batch_id), lease = f.claim(request.request_id);
    assert.throws(() => publishCsvBackground(f.db, lease, { dataDir: f.dir, now: execution, beforeCommit: () => { throw new Error("before commit"); } }), /before commit/);
    for (const table of ["ledger_events", "postings", "csv_import_outcomes"]) assert.equal(f.count(table), 0);
    assert.equal(revision(f.db, f.portfolio), 0); assert.equal(readCsvBackgroundResult(f.db, request.request_id), null);
    publishCsvBackground(f.db, lease, { now: execution, dataDir: f.dir }); assert.equal(revision(f.db, f.portfolio), 2);
  } finally { f.close(); }
});

test("stale fence, wrong owner and changed revision cannot execute", () => {
  const f = fixture(); try {
    const request = f.enqueue(), lease = f.claim(request.request_id);
    for (const change of [{ owner: "foreign" }, { fencing_token: 2 }, { attempt: 2 }]) assert.throws(() => publishCsvBackground(f.db, { ...lease, ...change }, { now: execution, dataDir: f.dir }), /STALE_LEASE/);
    const preview = previewCsvImport(f.db, f.actor, f.input, f.options);
    recordFact(f.db, f.actor, preview.rows[0].command!, execution);
    assert.throws(() => publishCsvBackground(f.db, lease, { now: execution, dataDir: f.dir }), /VERSION_CONFLICT/);
    assert.equal(f.count("import_batches"), 1); assert.equal(f.count("csv_background_results"), 0);
  } finally { f.close(); }
});

test("proof time is inside the final lease/deadline boundary, not an unguarded post-check", () => {
  for (const boundary of ["lease", "deadline"]) {
    const f = fixture(); try {
      const request = f.enqueue(), lease = f.claim(request.request_id); let calls = 0;
      if (boundary === "deadline") f.db.prepare("UPDATE job_runs SET lease_until='2026-09-12T00:20:00.000000Z' WHERE id=?").run(lease.job_id);
      const late = boundary === "lease" ? "2026-09-12T00:05:00Z" : "2026-09-12T00:15:00Z";
      assert.throws(() => publishCsvBackground(f.db, lease, { dataDir: f.dir, clock: () => ++calls < 3 ? execution : late }), boundary === "lease" ? /STALE_LEASE/ : /EXPIRED/);
      assert.equal(calls, 3); assert.equal(f.count("import_batches"), 0); assert.equal(f.count("csv_background_results"), 0);
      assert.equal((f.db.prepare("SELECT status FROM job_runs").get() as { status: string }).status, "running");
    } finally { f.close(); }
  }
});

test("publisher cannot return a successful receipt inside somebody else's uncommitted transaction", () => {
  const f = fixture(); try {
    const request = f.enqueue(), lease = f.claim(request.request_id);
    f.db.transaction(() => {
      assert.throws(() => publishCsvBackground(f.db, lease, { dataDir: f.dir, now: execution }), /CSV_BACKGROUND_INDEPENDENT_TRANSACTION_REQUIRED/);
      assert.equal(f.count("csv_background_results"), 0); assert.equal(f.count("import_batches"), 0);
    }).immediate();
  } finally { f.close(); }
});

test("duplicate previews bind the current upload filename; confirmed historical uploads cannot borrow a fresh CAS", () => {
  const f = fixture(); try {
    const first = f.publish(f.enqueue().request_id), other = f.enqueue({ idempotency_key: "preview-2", filename: "renamed.csv" });
    assert.equal(f.publish(other.request_id).batch_id, first.batch_id);
    f.publish(f.confirm(first.batch_id).request_id);
    const historical = f.enqueue({ idempotency_key: "preview-3", expected_revision: 2 });
    assert.throws(() => f.publish(historical.request_id), /CSV_FILE_ALREADY_CONFIRMED/);
    assert.equal(f.count("import_batches"), 1); assert.equal(revision(f.db, f.portfolio), 2);
  } finally { f.close(); }
});

test("queued domain-review conflicts fail in executor without putting full evidence work on submission", () => {
  const f = fixture(); try {
    const preview = f.publish(f.enqueue().request_id), payload = JSON.parse(f.payload(preview.batch_id));
    payload.csv_review.review_hash = "f".repeat(64);
    const request = requestCsvBackgroundConfirmation(f.db, f.principal, { portfolio_id: f.portfolio, account_id: f.account, idempotency_key: "confirm-bad", payload_text: JSON.stringify(payload), acknowledge_background_execution: true }, { ...f.options, now: execution });
    assert.equal(request.status, "queued"); assert.throws(() => f.publish(request.request_id), /CSV_REVIEW_HASH_MISMATCH/);
    assert.equal(f.count("ledger_events"), 0); assert.equal(f.count("csv_import_outcomes"), 0); assert.equal(readCsvBackgroundResult(f.db, request.request_id), null);
  } finally { f.close(); }
});

test("two prior human confirmations may resolve one real receipt without booking the batch twice", () => {
  const f = fixture(); try {
    const preview = f.publish(f.enqueue().request_id), first = f.confirm(preview.batch_id);
    const second = requestCsvBackgroundConfirmation(f.db, f.principal, { portfolio_id: f.portfolio, account_id: f.account, idempotency_key: "confirm-2", payload_text: f.payload(preview.batch_id), acknowledge_background_execution: true }, { ...f.options, now: execution });
    const a = f.publish(first.request_id), b = f.publish(second.request_id);
    assert.notEqual(first.request_id, second.request_id); assert.equal(a.receipts_hash, b.receipts_hash); assert.equal(a.confirmed_revision, b.confirmed_revision);
    assert.equal(a.row_count, 2); assert.equal(b.row_count, 2); assert.equal(f.count("ledger_events"), 2); assert.equal(f.count("csv_import_outcomes"), 2); assert.equal(revision(f.db, f.portfolio), 2);
    assert.throws(() => requestCsvBackgroundConfirmation(f.db, f.principal, { portfolio_id: f.portfolio, account_id: f.account, idempotency_key: "confirm-3", payload_text: f.payload(preview.batch_id), acknowledge_background_execution: true }, { ...f.options, now: execution }), /CSV_FILE_ALREADY_CONFIRMED/);
  } finally { f.close(); }
});

test("per-session acceptance budget stops only new requests, not exact retry or a new session", () => {
  const f = fixture(); try {
    const first = f.enqueue();
    for (let i = 1; i < 128; i++) f.enqueue({ idempotency_key: `preview-${i + 1}` });
    assert.throws(() => f.enqueue({ idempotency_key: "overflow" }), /BUDGET_EXCEEDED/);
    assert.deepEqual(f.enqueue(), first);
    assert.notEqual(requestCsvBackgroundPreview(f.db, { ...f.principal, sessionHash: "b".repeat(64) }, f.input, f.options).request_id, first.request_id);
    assert.equal(f.count("csv_background_requests"), 129);
  } finally { f.close(); }
});

test("background strict fields, acknowledgement, human identity and UTF-8 limits reject early", () => {
  const f = fixture(); try {
    for (const change of [{ acknowledge_background_execution: false }, { extra: true }, { expected_revision: true }, { filename: "\ud800" }, { idempotency_key: "has spaces" }, { bytes: Buffer.alloc(4 * 1024 * 1024 + 1) }]) assert.throws(() => f.enqueue(change as never), /INPUT_INVALID/);
    for (const actorId of ["system", "SYSTEM:owner", "", "has spaces"]) assert.throws(() => requestCsvBackgroundPreview(f.db, { ...f.principal, actorId }, f.input, f.options), /PRINCIPAL_INVALID/);
    assert.equal(f.count("csv_background_requests"), 0);
  } finally { f.close(); }
});

test("domain reader rejects tampered immutable result even with a recomputed JSON hash", () => {
  const f = fixture(); try {
    const request = f.enqueue(), result = f.publish(request.request_id);
    f.db.exec("DROP TRIGGER csv_background_result_no_update");
    const corrupt = { ...result, row_count: result.row_count + 1 };
    f.db.prepare("UPDATE csv_background_results SET result_json=?,result_hash=? WHERE request_id=?").run(canonical(corrupt), hash(corrupt), request.request_id);
    assert.throws(() => readCsvBackgroundResult(f.db, request.request_id, f.options), /EVIDENCE_INVALID/);
  } finally { f.close(); }
});
