import { createHash, randomUUID } from "node:crypto";
import { parseStrictJson } from "../strict-json";
import type Database from "better-sqlite3";
import { assertLedgerCommand } from "../contracts";
import { audit, canonical, hash, recordFact, revision, type Actor, type LedgerCommand, type Receipt } from "./service";
import { readJsonAttachment, storeJsonAttachment, type AttachmentOptions } from "./attachments";
import { assertWritableDatabase } from "../workbench-db";
import { readCsvManifest, storedCsvRows, type CsvManifest, type CsvStoredRow } from "./csv-import-evidence";
import { confirmCsvImport } from "./csv-confirmation";

export interface ImportPreview {
  id: string; account_id: string; attachment_id: string; status: string; parser_version: string;
  preview_hash: string; expected_revision: number;
  rows: { row: number; command: LedgerCommand | null; errors: string[]; source?: CsvStoredRow["source"]; outcome?: CsvStoredRow["outcome"] }[];
  csv?: Omit<CsvManifest, "context" | "context_hash" | "transformation_hash" | "rows_hash" | "schema_version">;
  duplicate?: boolean;
}
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 10000;
const ROLLBACK_PREVIEW = new Error("ROLLBACK_PREVIEW");

function requireScope(db: Database.Database, actor: Actor, portfolioId: string, accountId: string): void {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  if (!db.prepare("SELECT id FROM accounts WHERE id=? AND portfolio_id=?").get(accountId, portfolioId)) throw new Error("ACCOUNT_OUT_OF_SCOPE");
}

export function getImportPreview(db: Database.Database, actor: Actor, portfolioId: string, batchId: string): ImportPreview {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  const batch = db.prepare("SELECT id,account_id,attachment_id,status,parser_version,preview_hash,expected_revision FROM import_batches WHERE id=? AND portfolio_id=?").get(batchId, portfolioId) as Omit<ImportPreview, "rows"> | undefined;
  if (!batch) throw new Error("IMPORT_NOT_FOUND");
  if (batch.parser_version === "csv-v1") {
    const manifest = readCsvManifest(db, batchId), rows = storedCsvRows(db, batchId);
    if (hash(rows) !== manifest.rows_hash) throw new Error("CSV_IMPORT_EVIDENCE_INVALID");
    const { context: _context, context_hash: _contextHash, transformation_hash: _transformationHash, rows_hash: _rowsHash, schema_version: _schemaVersion, ...csv } = manifest;
    return { ...batch, rows, csv };
  }
  if (batch.parser_version !== "json-v1") throw new Error("IMPORT_PARSER_UNSUPPORTED");
  const rows = db.prepare("SELECT row_number,normalized_json,errors_json FROM import_rows WHERE batch_id=? ORDER BY row_number").all(batchId) as { row_number: number; normalized_json: string | null; errors_json: string }[];
  return { ...batch, rows: rows.map(r => ({ row: r.row_number, command: r.normalized_json ? JSON.parse(r.normalized_json) : null, errors: JSON.parse(r.errors_json) })) };
}

export function previewJsonImport(db: Database.Database, actor: Actor, portfolioId: string, accountId: string, raw: string, now = new Date().toISOString(), options: AttachmentOptions = {}): ImportPreview {
  requireScope(db, actor, portfolioId, accountId);
  assertWritableDatabase(db);
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) throw new Error("IMPORT_TOO_LARGE");
  const attachment = storeJsonAttachment(db, actor, { portfolio_id: portfolioId, account_id: accountId, raw }, { ...options, now });
  let values: unknown;
  try { values = parseStrictJson(raw); } catch { throw new Error("INVALID_JSON_IMPORT"); }
  if (!Array.isArray(values) || !values.length || values.length > MAX_ROWS) throw new Error("INVALID_IMPORT_ROW_COUNT");
  const contentHash = createHash("sha256").update(raw).digest("hex");
  return db.transaction(() => {
    assertWritableDatabase(db);
    const startRevision = revision(db, portfolioId);
    const previous = db.prepare("SELECT id,status,expected_revision FROM import_batches WHERE portfolio_id=? AND account_id=? AND content_hash=? AND parser_version='json-v1' AND status IN ('preview','confirmed') ORDER BY created_at DESC LIMIT 1").get(portfolioId, accountId, contentHash) as { id: string; status: string; expected_revision: number } | undefined;
    if (previous && (previous.status === "confirmed" || previous.expected_revision === startRevision)) {
      db.prepare("UPDATE import_batches SET attachment_id=? WHERE id=? AND attachment_id IS NULL").run(attachment.id, previous.id);
      assertWritableDatabase(db);
      return { ...getImportPreview(db, actor, portfolioId, previous.id), duplicate: true };
    }
    if (previous) {
      db.prepare("UPDATE import_batches SET status='cancelled' WHERE id=? AND status='preview'").run(previous.id);
      audit(db, actor, "supersede_preview", "import_batch", previous.id, portfolioId, startRevision, { reason: "ledger_revision_changed" }, now);
    }
    const rows = (values as unknown[]).map((value, index) => {
      const row: ImportPreview["rows"][number] = { row: index + 1, command: null, errors: [] };
      try {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_IMPORT_ROW");
        // Import routing is explicit; a file cannot silently choose a different account.
        const source = value as Record<string, unknown>;
        const command = { ...source, portfolio_id: portfolioId, expected_revision: startRevision, idempotency_key: `import:${contentHash}:${index + 1}` } as unknown as LedgerCommand;
        assertLedgerCommand(command);
        if (command.fact.account_id !== accountId || (source.portfolio_id && source.portfolio_id !== portfolioId)) throw new Error("ACCOUNT_OUT_OF_SCOPE");
        row.command = command;
      } catch (error) { row.errors.push(error instanceof Error ? error.message : "INVALID_IMPORT_ROW"); }
      return row;
    });
    // Exercise exactly the recording path under a savepoint, then discard all facts.
    try {
      db.transaction(() => {
        for (const row of rows) {
          if (!row.command || row.errors.length) continue;
          try { recordFact(db, actor, { ...row.command, expected_revision: revision(db, portfolioId) }, now); }
          catch (error) { row.errors.push(error instanceof Error ? error.message : "INVALID_IMPORT_ROW"); }
        }
        throw ROLLBACK_PREVIEW;
      })();
    } catch (error) { if (error !== ROLLBACK_PREVIEW) throw error; }
    const id = randomUUID(), errorCount = rows.filter(r => r.errors.length).length;
    const previewHash = hash({ rows, startRevision, contentHash, parser: "json-v1" });
    db.prepare("INSERT INTO import_batches(id,portfolio_id,account_id,attachment_id,content_hash,parser_version,status,preview_hash,expected_revision,row_count,error_count,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, portfolioId, accountId, attachment.id, contentHash, "json-v1", errorCount ? "invalid" : "preview", previewHash, startRevision, rows.length, errorCount, actor.id, now);
    const insert = db.prepare("INSERT INTO import_rows(batch_id,row_number,raw_json,normalized_json,errors_json,source_event_id) VALUES(?,?,?,?,?,?)");
    for (const row of rows) insert.run(id, row.row, canonical((values as unknown[])[row.row - 1]), row.command ? canonical(row.command) : null, canonical(row.errors), row.command?.source_event_id ?? null);
    audit(db, actor, "preview_import", "import_batch", id, portfolioId, startRevision, { contentHash, rows: rows.length, errorCount }, now);
    assertWritableDatabase(db);
    return getImportPreview(db, actor, portfolioId, id);
  }).immediate();
}

export function confirmImport(db: Database.Database, actor: Actor, portfolioId: string, batchId: string, previewHash: string, expectedRevision: number, now = new Date().toISOString(), options: AttachmentOptions = {}, csvReview?: unknown): { revision: number; receipts: Receipt[]; duplicate: boolean } {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const metadata = db.prepare("SELECT parser_version FROM import_batches WHERE id=? AND portfolio_id=?").get(batchId, portfolioId) as { parser_version: string } | undefined;
    if (!metadata) throw new Error("IMPORT_NOT_FOUND");
    if (metadata.parser_version === "csv-v1" && db.prepare("SELECT 1 FROM csv_background_requests WHERE batch_id=? UNION ALL SELECT 1 FROM csv_background_results WHERE batch_id=? LIMIT 1").get(batchId, batchId)) throw new Error("CSV_BACKGROUND_CONFIRM_REQUIRED");
    const batch = getImportPreview(db, actor, portfolioId, batchId);
    if (batch.parser_version === "csv-v1") {
      return confirmCsvImport(db, actor, portfolioId, batchId, previewHash, expectedRevision, now, options, csvReview);
    }
    if (csvReview !== undefined) throw new Error("CSV_REVIEW_NOT_APPLICABLE");
    if (!batch.attachment_id) throw new Error("IMPORT_ATTACHMENT_REQUIRED");
    readJsonAttachment(db, actor, portfolioId, batch.attachment_id, { ...options, accountId: batch.account_id });
    if (batch.preview_hash !== previewHash) throw new Error("PREVIEW_HASH_MISMATCH");
    if (batch.status === "confirmed") {
      const old = db.prepare("SELECT payload_json FROM audit_events WHERE action='confirm_import' AND object_id=?").get(batchId) as { payload_json: string };
      assertWritableDatabase(db);
      return { ...JSON.parse(old.payload_json), duplicate: true };
    }
    if (batch.status !== "preview" || batch.rows.some(r => r.errors.length || !r.command)) throw new Error("IMPORT_HAS_ERRORS");
    if (batch.expected_revision !== expectedRevision || revision(db, portfolioId) !== expectedRevision) throw new Error("VERSION_CONFLICT");
    const receipts = batch.rows.map(row => recordFact(db, actor, { ...row.command!, expected_revision: revision(db, portfolioId) }, now, { importBatchId: batchId }));
    const endRevision = revision(db, portfolioId);
    db.prepare("UPDATE import_batches SET status='confirmed',confirmed_at=?,confirmed_revision=? WHERE id=? AND status='preview'").run(now, endRevision, batchId);
    const result = { revision: endRevision, receipts, duplicate: false };
    audit(db, actor, "confirm_import", "import_batch", batchId, portfolioId, endRevision, result, now);
    assertWritableDatabase(db);
    return result;
  }).immediate();
}
