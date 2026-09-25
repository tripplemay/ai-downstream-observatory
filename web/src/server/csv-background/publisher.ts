import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { canonical, hash } from "../ledger/service";
import { previewCsvImport } from "../ledger/csv-imports";
import { confirmCsvImportWithReview } from "../ledger/csv-confirmation";
import type { CsvBatch } from "../ledger/csv-import-evidence";
import { assertCsvBackgroundLease, csvBackgroundStamp, readCsvBackgroundResult } from "./binding";
import { runCsvTransaction } from "./transaction-timing";
import type { CsvBackgroundLease, CsvBackgroundPublishOptions, CsvBackgroundPreviewData, CsvBackgroundResult, CsvBackgroundJobResult } from "./types";

/** Domain effects, the receipt and the fenced terminal transition have one commit point. */
export function publishCsvBackground(db: Database.Database, lease: CsvBackgroundLease, options: CsvBackgroundPublishOptions = {}): CsvBackgroundJobResult {
  if (db.inTransaction) throw new Error("CSV_BACKGROUND_INDEPENDENT_TRANSACTION_REQUIRED");
  const clock = () => csvBackgroundStamp(options.clock?.() ?? options.now);
  assertWritableDatabase(db);
  return runCsvTransaction(db, () => {
    assertWritableDatabase(db);
    const started = clock(), binding = assertCsvBackgroundLease(db, lease, started), request = binding.row, actor = { id: request.actor_id };
    let batchId: string, review: { review_hash: string; required_review_count: number };
    let confirmed: ReturnType<typeof confirmCsvImportWithReview>["result"] | null = null;
    if (request.operation === "preview") {
      const input = binding.input as CsvBackgroundPreviewData;
      const preview = previewCsvImport(db, actor, { portfolio_id: request.portfolio_id, account_id: request.account_id, expected_revision: request.expected_revision,
        filename: input.filename, mapping: input.mapping, bytes: request.csv_bytes! }, { ...options, now: started });
      if (preview.status === "confirmed") throw new Error("CSV_FILE_ALREADY_CONFIRMED");
      batchId = preview.id; review = { review_hash: preview.csv!.review_hash, required_review_count: preview.csv!.required_review_rows.length };
    } else {
      const payload = binding.confirmation!.payload;
      const confirmation = confirmCsvImportWithReview(db, actor, request.portfolio_id, payload.batch_id, payload.preview_hash, request.expected_revision, started, { ...options, now: started }, payload.csv_review);
      confirmed = confirmation.result; review = confirmation.review;
      batchId = payload.batch_id;
    }
    const batch = db.prepare("SELECT * FROM import_batches WHERE id=?").get(batchId) as CsvBatch & { confirmed_revision: number | null };
    const result: CsvBackgroundResult = { schema_version: "csv-background-result-v1", request_id: request.id, operation: request.operation, input_hash: request.input_hash,
      batch_id: batch.id, preview_hash: batch.preview_hash, expected_revision: request.expected_revision, batch_status: batch.status as CsvBackgroundResult["batch_status"],
      row_count: batch.row_count, error_count: batch.error_count, review_hash: review.review_hash, required_review_count: review.required_review_count,
      confirmed_revision: confirmed?.revision ?? null, receipts_hash: confirmed ? hash(confirmed.receipts) : null };
    const resultHash = hash(result), envelope: CsvBackgroundJobResult = { schema_version: "csv-background-job-result-v1", request_id: request.id, operation: request.operation, batch_id: batchId, result_hash: resultHash };
    options.beforeCommit?.();
    const completed = clock();
    if (completed < started) throw new Error("CSV_BACKGROUND_INVALID_CLOCK");
    assertWritableDatabase(db); assertCsvBackgroundLease(db, lease, completed);
    db.prepare("INSERT INTO csv_background_results(request_id,job_id,job_attempt_id,batch_id,result_json,result_hash,completed_at) VALUES(?,?,?,?,?,?,?)")
      .run(request.id, lease.job_id, binding.attempt.id, batchId, canonical(result), resultHash, completed);
    const attempt = db.prepare("UPDATE job_attempts SET status='succeeded',finished_at=?,error_json=NULL WHERE id=? AND status='running' AND fencing_token=?")
      .run(completed, binding.attempt.id, lease.fencing_token);
    const job = db.prepare("UPDATE job_runs SET status='succeeded',result_json=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_owner=? AND fencing_token=? AND attempt_count=?")
      .run(canonical(envelope), completed, lease.job_id, lease.owner, lease.fencing_token, lease.attempt);
    if (attempt.changes !== 1 || job.changes !== 1) throw new Error("CSV_BACKGROUND_STALE_LEASE");
    if (!readCsvBackgroundResult(db, request.id, options)) throw new Error("CSV_BACKGROUND_EVIDENCE_INVALID");
    const commitAt = clock();
    if (commitAt < completed) throw new Error("CSV_BACKGROUND_INVALID_CLOCK");
    if (commitAt >= csvBackgroundStamp(binding.job.lease_until!)) throw new Error("CSV_BACKGROUND_STALE_LEASE");
    if (commitAt >= request.expires_at) throw new Error("CSV_BACKGROUND_EXPIRED");
    assertWritableDatabase(db); return envelope;
  }, options.onTransactionTiming);
}
