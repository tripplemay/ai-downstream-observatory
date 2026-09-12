import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mapCsvImport, parseCsvMapping, CSV_MAPPING_VERSION, type CsvImportContext, type CsvMappedRow, type CsvMapping } from "./csv-mapping";
import { CSV_PARSER_VERSION, type CsvIssue } from "./csv";
import { readCsvAttachment, readJsonAttachment, storeJsonAttachment, type AttachmentOptions } from "./attachments";
import { canonical, hash, type Actor, type LedgerCommand } from "./service";
import type { CsvCandidateReview } from "./csv-review";

export interface CsvDryRun { kind: "new" | "already_recorded" | "same_file_row" | "link_only" | "invalid"; event_id?: string; prior_row?: number; warnings: string[] }
export interface CsvStoredRow { row: number; command: LedgerCommand | null; errors: string[]; source: CsvMappedRow; outcome: CsvDryRun }
export interface CsvManifest {
  schema_version: "csv-ledger-preview-v1"; original_filename: string; attachment_id: string; content_hash: string;
  mapping_version_id: string; mapping_id: string; mapping_version: number; mapping_hash: string; mapping_attachment_id: string;
  parser_version: string; mapper_version: string; context: CsvImportContext; context_hash: string; transformation_hash: string;
  headers: string[]; document_errors: CsvIssue[]; warnings: string[]; candidates: CsvCandidateReview[]; review_hash: string;
  required_review_rows: number[]; rows_hash: string; broker_format_verified: false;
}
export interface CsvBatch { id: string; portfolio_id: string; account_id: string; attachment_id: string; content_hash: string; parser_version: string; mapping_version: string; preview_hash: string; expected_revision: number; row_count: number; error_count: number; status: string }
interface MappingRow { id: string; portfolio_id: string; account_id: string; mapping_key: string; version: number; content_hash: string; attachment_id: string; definition_json: string }

export function csvContext(db: Database.Database, portfolio: string, account: string, mapping: CsvMapping): CsvImportContext {
  const ids = (binding: unknown): string[] => {
    const b = binding as { kind?: string; value?: string; entries?: { value: string }[] } | undefined;
    return b?.kind === "constant" ? [b.value!] : b?.kind === "lookup" ? b.entries!.map(row => row.value) : [];
  };
  const accounts = [...new Set([account, ...ids(mapping.account), ...mapping.rules.flatMap(rule => ids(rule.fields.target_account_id))])].sort();
  const listings = [...new Set(mapping.rules.flatMap(rule => ids(rule.fields.listing_id)))].sort();
  return { portfolio_id: portfolio, account_id: account,
    accounts: db.prepare("SELECT id,portfolio_id FROM accounts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id").all(canonical(accounts)) as CsvImportContext["accounts"],
    listings: db.prepare("SELECT id,currency FROM listings WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id").all(canonical(listings)) as CsvImportContext["listings"],
  };
}

export function registerCsvMapping(db: Database.Database, actor: Actor, portfolio: string, account: string, raw: string, options: AttachmentOptions) {
  const definition = parseCsvMapping(raw), contentHash = hash(definition);
  const existing = db.prepare("SELECT * FROM csv_mapping_versions WHERE portfolio_id=? AND account_id=? AND mapping_key=? AND version=?").get(portfolio, account, definition.mapping_id, definition.version) as MappingRow | undefined;
  if (existing && (existing.content_hash !== contentHash || hash(JSON.parse(existing.definition_json)) !== contentHash)) throw new Error("CSV_MAPPING_VERSION_CONFLICT");
  const attachment = storeJsonAttachment(db, actor, { portfolio_id: portfolio, account_id: account, raw }, options);
  const id = existing?.id ?? randomUUID();
  if (!existing) db.prepare("INSERT INTO csv_mapping_versions(id,portfolio_id,account_id,mapping_key,version,content_hash,attachment_id,definition_json,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, portfolio, account, definition.mapping_id, definition.version, contentHash, attachment.id, canonical(definition), actor.id, options.now ?? new Date().toISOString());
  return { id, definition, content_hash: contentHash, uploaded_attachment_id: attachment.id };
}

export function csvRowCommand(command: CsvMappedRow["command"], portfolio: string, account: string, contentHash: string, row: number, revision: number): LedgerCommand | null {
  return command ? { ...command, portfolio_id: portfolio, expected_revision: revision, idempotency_key: `csv:${hash({ portfolio, account, contentHash, row })}` } : null;
}
export function csvPreviewHash(batch: Pick<CsvBatch, "portfolio_id" | "account_id" | "expected_revision">, manifestHash: string) {
  return hash({ schema_version: "csv-ledger-preview-v1", portfolio_id: batch.portfolio_id, account_id: batch.account_id, expected_revision: batch.expected_revision, manifest_hash: manifestHash });
}
export function storedCsvRows(db: Database.Database, batch: string): CsvStoredRow[] {
  return (db.prepare("SELECT row_number,raw_json,normalized_json,errors_json FROM import_rows WHERE batch_id=? ORDER BY row_number").all(batch) as { row_number: number; raw_json: string; normalized_json: string | null; errors_json: string }[]).map(row => {
    const raw = JSON.parse(row.raw_json) as { source: CsvMappedRow; outcome: CsvDryRun };
    return { row: row.row_number, source: raw.source, outcome: raw.outcome, command: row.normalized_json ? JSON.parse(row.normalized_json) : null, errors: JSON.parse(row.errors_json) };
  });
}
export function readCsvManifest(db: Database.Database, batch: string): CsvManifest {
  const row = db.prepare("SELECT manifest_json,content_hash FROM csv_import_manifests WHERE batch_id=?").get(batch) as { manifest_json: string; content_hash: string } | undefined;
  if (!row) throw new Error("CSV_IMPORT_EVIDENCE_MISSING");
  const manifest = JSON.parse(row.manifest_json) as CsvManifest;
  if (manifest.schema_version !== "csv-ledger-preview-v1" || hash(manifest) !== row.content_hash) throw new Error("CSV_IMPORT_EVIDENCE_INVALID");
  return manifest;
}

/** Confirmed retries authenticate retained evidence, but never claim to rerun a newer parser. */
export function verifyCsvEvidence(db: Database.Database, actor: Actor, batch: CsvBatch, options: AttachmentOptions, live: boolean): { manifest: CsvManifest; rows: CsvStoredRow[] } {
  const manifest = readCsvManifest(db, batch.id), rows = storedCsvRows(db, batch.id);
  const mapping = db.prepare("SELECT * FROM csv_mapping_versions WHERE id=?").get(manifest.mapping_version_id) as MappingRow | undefined;
  const association = db.prepare("SELECT mapping_version_id FROM csv_import_manifests WHERE batch_id=?").get(batch.id) as { mapping_version_id: string };
  if (!mapping || association.mapping_version_id !== mapping.id || batch.mapping_version !== mapping.id || mapping.portfolio_id !== batch.portfolio_id || mapping.account_id !== batch.account_id
    || mapping.mapping_key !== manifest.mapping_id || mapping.version !== manifest.mapping_version || mapping.content_hash !== manifest.mapping_hash
    || manifest.attachment_id !== batch.attachment_id || manifest.content_hash !== batch.content_hash || batch.parser_version !== "csv-v1"
    || hash(manifest.context) !== manifest.context_hash || hash(manifest.candidates) !== manifest.review_hash || hash(rows) !== manifest.rows_hash
    || rows.length !== batch.row_count || csvPreviewHash(batch, hash(manifest)) !== batch.preview_hash) throw new Error("CSV_IMPORT_EVIDENCE_INVALID");
  const { bytes } = readCsvAttachment(db, actor, batch.portfolio_id, batch.attachment_id, { ...options, accountId: batch.account_id });
  const pinned = readJsonAttachment(db, actor, batch.portfolio_id, mapping.attachment_id, { ...options, accountId: batch.account_id });
  const uploaded = readJsonAttachment(db, actor, batch.portfolio_id, manifest.mapping_attachment_id, { ...options, accountId: batch.account_id });
  const definition = parseCsvMapping(pinned.bytes.toString("utf8"));
  if (hash(definition) !== manifest.mapping_hash || hash(parseCsvMapping(uploaded.bytes.toString("utf8"))) !== manifest.mapping_hash || canonical(definition) !== mapping.definition_json) throw new Error("CSV_IMPORT_EVIDENCE_INVALID");
  if (!live) return { manifest, rows };
  if (manifest.parser_version !== CSV_PARSER_VERSION || manifest.mapper_version !== CSV_MAPPING_VERSION) throw new Error("CSV_IMPORT_METHOD_CHANGED");
  const context = csvContext(db, batch.portfolio_id, batch.account_id, definition);
  if (hash(context) !== manifest.context_hash) throw new Error("CSV_IMPORT_CONTEXT_CHANGED");
  const mapped = mapCsvImport(bytes, definition, context);
  if (mapped.preview_hash !== manifest.transformation_hash || mapped.rows.length !== rows.length || !mapped.can_preview) throw new Error("CSV_IMPORT_EVIDENCE_INVALID");
  for (const row of rows) {
    const source = mapped.rows[row.row - 1];
    if (canonical(source) !== canonical(row.source) || canonical(csvRowCommand(source.command, batch.portfolio_id, batch.account_id, batch.content_hash, row.row, batch.expected_revision)) !== canonical(row.command)) throw new Error("CSV_IMPORT_EVIDENCE_INVALID");
  }
  return { manifest, rows };
}
