import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { storeCsvAttachment, type AttachmentOptions } from "./attachments";
import { audit, canonical, hash, recordFact, revision, sourceFingerprint, type Actor } from "./service";
import { getImportPreview } from "./imports";
import { mapCsvImport } from "./csv-mapping";
import { buildCsvReviewCandidates } from "./csv-review";
import { csvContext, csvPreviewHash, csvRowCommand, readCsvManifest, registerCsvMapping, type CsvManifest, type CsvStoredRow } from "./csv-import-evidence";
import type { CsvUpload } from "./csv-upload";

const ROLLBACK = new Error("CSV_ROLLBACK_PREVIEW");
const safeCode = (error: unknown) => {
  const code = error instanceof Error ? error.message.split(":", 1)[0] : "";
  return /^[A-Z][A-Z0-9_]{1,100}$/.test(code) ? code : "CSV_LEDGER_VALIDATION_FAILED";
};

export function previewCsvImport(db: Database.Database, actor: Actor, input: CsvUpload, options: AttachmentOptions = {}) {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  assertWritableDatabase(db);
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 || !input.filename || input.filename.length > 200 || /[\u0000-\u001f\u007f]/.test(input.filename)) throw new Error("CSV_UPLOAD_FIELDS_INVALID");
  const now = options.now ?? new Date().toISOString();
  return db.transaction(() => {
    assertWritableDatabase(db);
    if (!db.prepare("SELECT id FROM accounts WHERE id=? AND portfolio_id=?").get(input.account_id, input.portfolio_id)) throw new Error("ACCOUNT_OUT_OF_SCOPE");
    const rev = revision(db, input.portfolio_id);
    if (rev !== input.expected_revision) throw new Error("VERSION_CONFLICT");
    const mapping = registerCsvMapping(db, actor, input.portfolio_id, input.account_id, input.mapping, { ...options, now });
    const attachment = storeCsvAttachment(db, actor, { portfolio_id: input.portfolio_id, account_id: input.account_id, bytes: input.bytes }, { ...options, now });
    const context = csvContext(db, input.portfolio_id, input.account_id, mapping.definition);
    const mapped = mapCsvImport(input.bytes, mapping.definition, context);
    const previous = db.prepare("SELECT id,status,expected_revision FROM import_batches WHERE portfolio_id=? AND account_id=? AND content_hash=? AND parser_version='csv-v1' AND status IN ('preview','confirmed') ORDER BY created_at DESC,id DESC").all(input.portfolio_id, input.account_id, attachment.content_hash) as { id: string; status: string; expected_revision: number }[];
    for (const batch of previous.sort((a, b) => Number(b.status === "confirmed") - Number(a.status === "confirmed"))) {
      const meta = readCsvManifest(db, batch.id);
      if (batch.status === "confirmed" && meta.mapping_hash !== mapped.mapping_hash) throw new Error("CSV_FILE_ALREADY_CONFIRMED");
      if (meta.mapping_hash === mapped.mapping_hash && (batch.status === "confirmed" || (batch.expected_revision === rev && meta.context_hash === mapped.context_hash && meta.parser_version === mapped.parser_version && meta.mapper_version === mapped.mapping_engine_version))) {
        audit(db, actor, "repeat_csv_upload", "import_batch", batch.id, input.portfolio_id, rev, { original_filename: input.filename, attachment_id: attachment.id, mapping_attachment_id: mapping.uploaded_attachment_id }, now);
        assertWritableDatabase(db);
        return { ...getImportPreview(db, actor, input.portfolio_id, batch.id), duplicate: true };
      }
    }
    const rows: CsvStoredRow[] = mapped.rows.map((source, index) => ({ row: index + 1, source, command: csvRowCommand(source.command, input.portfolio_id, input.account_id, attachment.content_hash, index + 1, rev), errors: source.errors.map(error => error.code), outcome: { kind: "invalid", warnings: [] } }));
    const candidates = buildCsvReviewCandidates(db, input.portfolio_id, input.account_id, rows);
    const identities = new Map<string, string>();
    for (const row of rows) {
      if (!row.command?.source_event_id) continue;
      const identity = hash([row.command.source_id, row.command.source_event_id, row.command.fact.type]), fingerprint = sourceFingerprint(row.command);
      if (identities.has(identity) && identities.get(identity) !== fingerprint) row.errors.push("SOURCE_DUPLICATE_CONFLICT");
      else identities.set(identity, fingerprint);
    }
    if (mapped.can_preview) {
      try {
        db.transaction(() => {
          const generated = new Map<string, number>();
          for (const row of rows) {
            if (!row.command || row.errors.length) continue;
            try {
              const receipt = recordFact(db, actor, { ...row.command, expected_revision: revision(db, input.portfolio_id) }, now);
              const prior = generated.get(receipt.event_id);
              row.outcome = receipt.duplicate ? (prior ? { kind: "same_file_row", prior_row: prior, warnings: receipt.warnings } : { kind: "already_recorded", event_id: receipt.event_id, warnings: receipt.warnings }) : { kind: "new", warnings: receipt.warnings };
              if (!receipt.duplicate) generated.set(receipt.event_id, row.row);
            } catch (error) {
              const code = safeCode(error), candidate = candidates[row.row - 1];
              if (["CHRONOLOGY_REVIEW_REQUIRED", "OPENING_ALREADY_RECORDED", "OPENING_PERIOD_CLOSED", "INSUFFICIENT_CASH", "INSUFFICIENT_POSITION"].includes(code)
                && (candidate.exact_event_ids.length || candidate.exact_prior_rows.length)) row.outcome = { kind: "link_only", warnings: [code, "CSV_NEW_RECORD_BLOCKED_EXACT_LINK_REQUIRED"] };
              else row.errors.push(code);
            }
          }
          throw ROLLBACK;
        })();
      } catch (error) { if (error !== ROLLBACK) throw error; }
    }
    const required = candidates.filter(candidate => {
      const row = rows[candidate.row - 1];
      return row.command && row.outcome.kind !== "already_recorded" && row.outcome.kind !== "same_file_row" && (candidate.missing_source_id || candidate.exact_event_ids.length || candidate.possible_event_ids.length || candidate.exact_prior_rows.length || candidate.possible_prior_rows.length);
    }).map(candidate => candidate.row);
    const manifest: CsvManifest = {
      schema_version: "csv-ledger-preview-v1", original_filename: input.filename, attachment_id: attachment.id, content_hash: attachment.content_hash,
      mapping_version_id: mapping.id, mapping_id: mapped.mapping_id, mapping_version: mapped.mapping_version, mapping_hash: mapped.mapping_hash, mapping_attachment_id: mapping.uploaded_attachment_id,
      parser_version: mapped.parser_version, mapper_version: mapped.mapping_engine_version, context, context_hash: mapped.context_hash, transformation_hash: mapped.preview_hash,
      headers: mapped.document.headers, document_errors: [...mapped.document.errors, ...mapped.errors], warnings: ["GENERIC_MAPPING_NOT_BROKER_VERIFIED"], candidates, review_hash: hash(candidates), required_review_rows: required, rows_hash: hash(rows), broker_format_verified: false,
    };
    const id = randomUUID(), manifestHash = hash(manifest), previewHash = csvPreviewHash({ portfolio_id: input.portfolio_id, account_id: input.account_id, expected_revision: rev }, manifestHash);
    const errorCount = rows.filter(row => row.errors.length).length + Number(!mapped.can_preview || manifest.document_errors.length > 0);
    db.prepare("INSERT INTO import_batches(id,portfolio_id,account_id,attachment_id,content_hash,parser_version,mapping_version,status,preview_hash,expected_revision,row_count,error_count,created_by,created_at) VALUES(?,?,?,?,?,'csv-v1',?,?,?,?,?,?,?,?)")
      .run(id, input.portfolio_id, input.account_id, attachment.id, attachment.content_hash, mapping.id, errorCount ? "invalid" : "preview", previewHash, rev, rows.length, errorCount, actor.id, now);
    for (const row of rows) db.prepare("INSERT INTO import_rows(batch_id,row_number,raw_json,normalized_json,errors_json,source_event_id) VALUES(?,?,?,?,?,?)")
      .run(id, row.row, canonical({ source: row.source, outcome: row.outcome }), row.command ? canonical(row.command) : null, canonical(row.errors), row.command?.source_event_id ?? null);
    db.prepare("INSERT INTO csv_import_manifests(batch_id,mapping_version_id,manifest_json,content_hash,created_at) VALUES(?,?,?,?,?)").run(id, mapping.id, canonical(manifest), manifestHash, now);
    audit(db, actor, "preview_csv_import", "import_batch", id, input.portfolio_id, rev, { attachment_id: attachment.id, mapping_version_id: mapping.id, manifest_hash: manifestHash, preview_hash: previewHash, error_count: errorCount }, now);
    assertWritableDatabase(db);
    return getImportPreview(db, actor, input.portfolio_id, id);
  }).immediate();
}
