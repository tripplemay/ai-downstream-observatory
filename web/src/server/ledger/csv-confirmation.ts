import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import type { AttachmentOptions } from "./attachments";
import { audit, canonical, hash, recordFact, resolveSourceReceipt, revision, type Actor, type LedgerCommand, type Receipt } from "./service";
import { verifyCsvEvidence, type CsvBatch } from "./csv-import-evidence";
import { buildCsvReviewCandidates, csvEconomicHash, parseCsvReview } from "./csv-review";

interface Result { revision: number; receipts: Receipt[]; duplicate: boolean }

/** Called within the import confirmation's immediate transaction. */
export function confirmCsvImport(db: Database.Database, actor: Actor, portfolio: string, batchId: string, previewHash: string, expectedRevision: number, now: string, options: AttachmentOptions, reviewInput: unknown): Result {
  if (!db.inTransaction) throw new Error("CSV_CONFIRM_TRANSACTION_REQUIRED");
  const batch = db.prepare("SELECT * FROM import_batches WHERE id=? AND portfolio_id=?").get(batchId, portfolio) as CsvBatch & { confirmed_revision: number | null };
  if (!batch) throw new Error("IMPORT_NOT_FOUND");
  if (batch.preview_hash !== previewHash) throw new Error("PREVIEW_HASH_MISMATCH");
  const { manifest, rows } = verifyCsvEvidence(db, actor, batch, options, false);
  if (batch.status !== "confirmed" && (batch.status !== "preview" || batch.error_count || !rows.length || rows.some(row => row.errors.length || !row.command))) throw new Error("IMPORT_HAS_ERRORS");
  const resolutions = parseCsvReview(reviewInput, manifest.required_review_rows, manifest.candidates, manifest.review_hash);
  if (rows.some(row => row.outcome.kind === "link_only" && (!resolutions.has(row.row) || resolutions.get(row.row)!.action === "record_distinct"))) throw new Error("CSV_ROW_REQUIRES_LINK");
  const review = { acknowledge_unverified_mapping: true, review_hash: manifest.review_hash, rows: [...resolutions.values()].sort((a, b) => a.row - b.row) };
  const reviewHash = hash(review);
  if (batch.status === "confirmed") {
    const audits = db.prepare("SELECT payload_json FROM audit_events WHERE action='confirm_import' AND object_id=? AND portfolio_id=?").all(batchId, portfolio) as { payload_json: string }[];
    if (audits.length !== 1) throw new Error("CSV_IMPORT_OUTCOMES_INVALID");
    const old = JSON.parse(audits[0].payload_json) as Result & { csv_review_hash: string; csv_review: unknown; manifest_hash: string };
    if (old.csv_review_hash !== reviewHash) throw new Error("CSV_REVIEW_CONFLICT");
    const outcomes = db.prepare("SELECT o.*,e.portfolio_id,e.account_id FROM csv_import_outcomes o JOIN ledger_events e ON e.id=o.event_id WHERE o.batch_id=? ORDER BY o.row_number").all(batchId) as { row_number: number; event_id: string; duplicate: number; result_json: string; portfolio_id: string; account_id: string }[];
    if (old.csv_review_hash !== hash(old.csv_review) || old.manifest_hash !== hash(manifest) || old.revision !== batch.confirmed_revision || outcomes.length !== rows.length || old.receipts.length !== rows.length) throw new Error("CSV_IMPORT_OUTCOMES_INVALID");
    for (let i = 0; i < rows.length; i++) {
      const outcome = outcomes[i], stored = JSON.parse(outcome.result_json) as { receipt: Receipt; resolution: unknown };
      if (outcome.row_number !== rows[i].row || outcome.portfolio_id !== portfolio || outcome.account_id !== batch.account_id || outcome.event_id !== stored.receipt.event_id
        || outcome.duplicate !== Number(!!stored.receipt.duplicate) || canonical(stored.receipt) !== canonical(old.receipts[i]) || canonical(stored.resolution) !== canonical(resolutions.get(rows[i].row) ?? null)) throw new Error("CSV_IMPORT_OUTCOMES_INVALID");
    }
    assertWritableDatabase(db);
    return { revision: old.revision, receipts: old.receipts, duplicate: true };
  }
  if (batch.expected_revision !== expectedRevision || revision(db, portfolio) !== expectedRevision) throw new Error("VERSION_CONFLICT");
  if (db.prepare("SELECT id FROM import_batches WHERE portfolio_id=? AND account_id=? AND content_hash=? AND parser_version='csv-v1' AND status='confirmed' AND id<>? LIMIT 1").get(portfolio, batch.account_id, batch.content_hash, batchId)) throw new Error("CSV_FILE_ALREADY_CONFIRMED");
  verifyCsvEvidence(db, actor, batch, options, true);
  const candidates = buildCsvReviewCandidates(db, portfolio, batch.account_id, rows);
  if (hash(candidates) !== manifest.review_hash) throw new Error("CSV_REVIEW_HASH_MISMATCH");
  const receipts: Receipt[] = [], byRow = new Map<number, Receipt>(), bySource = new Map<string, string>();
  for (const row of rows) {
    const command = row.command!, resolution = resolutions.get(row.row);
    let receipt: Receipt;
    if ((resolution && resolution.action !== "record_distinct") || row.outcome.kind === "same_file_row") {
      // Reliable source duplicates follow the actual first-row outcome, including a manual link.
      const eventId = resolution?.action === "link_existing" ? resolution.event_id : byRow.get(resolution?.action === "link_prior_row" ? resolution.prior_row : row.outcome.prior_row!)?.event_id;
      const source = resolveSourceReceipt(db, command);
      if (source && source.event_id !== eventId) throw new Error("CSV_SOURCE_LINK_CONFLICT");
      const event = eventId ? db.prepare("SELECT e.payload_json,e.ledger_revision FROM ledger_events e WHERE e.id=? AND e.portfolio_id=? AND e.account_id=? AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ledger_events r WHERE r.reversal_of=e.id)").get(eventId, portfolio, batch.account_id) as { payload_json: string; ledger_revision: number } | undefined : undefined;
      if (!event || csvEconomicHash(JSON.parse(event.payload_json) as LedgerCommand) !== csvEconomicHash(command)) throw new Error("CSV_REVIEW_LINK_NOT_EXACT");
      const auditId = audit(db, actor, "link_csv_row", "import_batch", batchId, portfolio, revision(db, portfolio), { row: row.row, event_id: eventId, resolution: resolution ?? { action: "source_duplicate_prior_row", prior_row: row.outcome.prior_row }, preview_hash: previewHash }, now);
      receipt = { event_id: eventId!, revision: event.ledger_revision, audit_id: auditId, warnings: [resolution ? "CSV_ROW_MANUALLY_LINKED" : "CSV_SOURCE_DUPLICATE_PRIOR_ROW"], duplicate: true };
    } else receipt = recordFact(db, actor, { ...command, expected_revision: revision(db, portfolio) }, now, { importBatchId: batchId });
    if (command.source_event_id) {
      const identity = canonical([portfolio, command.fact.account_id, command.source_id, command.source_event_id, command.fact.type]);
      const priorEvent = bySource.get(identity);
      if (priorEvent && priorEvent !== receipt.event_id) throw new Error("CSV_SOURCE_LINK_CONFLICT");
      bySource.set(identity, receipt.event_id);
    }
    receipts.push(receipt); byRow.set(row.row, receipt);
    db.prepare("INSERT INTO csv_import_outcomes(batch_id,row_number,event_id,duplicate,result_json,actor_id,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(batchId, row.row, receipt.event_id, Number(!!receipt.duplicate), canonical({ receipt, resolution: resolution ?? null }), actor.id, now);
  }
  const endRevision = revision(db, portfolio);
  db.prepare("UPDATE import_batches SET status='confirmed',confirmed_at=?,confirmed_revision=? WHERE id=? AND status='preview'").run(now, endRevision, batchId);
  const result = { revision: endRevision, receipts, duplicate: false };
  audit(db, actor, "confirm_import", "import_batch", batchId, portfolio, endRevision, { ...result, csv_review: review, csv_review_hash: reviewHash, manifest_hash: hash(manifest) }, now);
  assertWritableDatabase(db);
  return result;
}
