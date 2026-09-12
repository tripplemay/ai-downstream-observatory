import type Database from "better-sqlite3";
import { CSV_LIMITS, CSV_PARSER_VERSION, csvFormulaLike, parseCsvBytes, type CsvDialect, type CsvDocument, type CsvLocation } from "./csv";
import { csvInspectionRequestSchema, type CsvInspectionUpload } from "./csv-inspection-upload";
import type { CsvInspectionCandidate, CsvInspectionContext, CsvInspectionList, CsvInspectionResponse, CsvInspectionSample, CsvInspectionSelected, CsvInspectionValues, CsvInspectionValuesRequest } from "./csv-inspection-types";

export const CSV_INSPECTION_LIMITS = Object.freeze({
  file_bytes: CSV_LIMITS.bytes, data_rows: CSV_LIMITS.data_rows, columns: CSV_LIMITS.columns,
  sample_rows: 5, sample_cell_bytes: 256, column_samples: 3, row_errors: 100,
  values_page: 100, values_page_bytes: 256 * 1024,
  context_items: 1000, context_list_bytes: 256 * 1024, response_bytes: 2 * 1024 * 1024,
});
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
function location(row: CsvLocation): CsvLocation {
  const { record_number, line_start, line_end, byte_start, byte_end } = row;
  return { record_number, line_start, line_end, byte_start, byte_end };
}
function sample(value: string): CsvInspectionSample {
  const bytes = Buffer.byteLength(value, "utf8"); let display = value;
  if (bytes > CSV_INSPECTION_LIMITS.sample_cell_bytes) {
    display = ""; let size = 0;
    for (const character of value) {
      const length = Buffer.byteLength(character, "utf8");
      if (size + length > CSV_INSPECTION_LIMITS.sample_cell_bytes) break;
      display += character; size += length;
    }
  }
  return { value: display, byte_length: bytes, truncated: display !== value, formula_like: csvFormulaLike(value) };
}
function candidate(document: CsvDocument, dialect: CsvDialect): CsvInspectionCandidate {
  return { dialect, valid: document.valid, column_count: document.headers.length, row_count: document.rows.length,
    document_errors: document.errors, row_error_count: document.rows.filter(row => row.errors.length > 0).length };
}
function selected(document: CsvDocument, dialect: CsvDialect): CsvInspectionSelected {
  const rowErrors = document.rows.filter(row => row.errors.length > 0);
  return {
    ...candidate(document, dialect), headers: document.headers, header_location: document.header ? location(document.header) : null,
    sample_rows: document.rows.slice(0, CSV_INSPECTION_LIMITS.sample_rows).map(row => ({ ...location(row), cells: row.cells.map(sample), errors: row.errors })),
    columns: document.headers.map((header, index) => {
      const seen = new Set<string>(); let empty = 0;
      const samples: CsvInspectionSelected["columns"][number]["samples"] = [];
      for (const row of document.rows) {
        const value = row.cells[index]; if (value === undefined) continue;
        if (value === "") empty++;
        if (!seen.has(value) && samples.length < CSV_INSPECTION_LIMITS.column_samples) samples.push({ ...sample(value), record_number: row.record_number });
        seen.add(value);
      }
      return { index: index + 1, header, empty_count: empty, distinct_count: seen.size, samples };
    }),
    row_errors: rowErrors.slice(0, CSV_INSPECTION_LIMITS.row_errors).map(row => ({ ...location(row), errors: row.errors })),
    row_errors_truncated: rowErrors.length > CSV_INSPECTION_LIMITS.row_errors,
  };
}
function valuesPage(document: CsvDocument, request: CsvInspectionValuesRequest): CsvInspectionValues {
  if (!document.valid) throw new Error("CSV_INSPECTION_VALUES_UNAVAILABLE");
  const index = document.headers.indexOf(request.column);
  if (index < 0) throw new Error("CSV_COLUMN_NOT_FOUND");
  const entries = new Map<string, CsvInspectionValues["items"][number]>();
  for (const row of document.rows) {
    const raw = row.cells[index], value = request.trim ? raw.trim() : raw;
    const previous = entries.get(value);
    if (previous) previous.count++;
    else entries.set(value, { value, count: 1, first_record_number: row.record_number, lookup_compatible: value.length <= 256, formula_like: csvFormulaLike(value) });
  }
  if (request.offset > entries.size) throw new Error("CSV_INSPECTION_VALUES_INVALID");
  // First-occurrence order is stable for the exact original bytes, and preserves leading zeros and Unicode.
  const ordered = [...entries.values()], items: CsvInspectionValues["items"] = [];
  let size = 0;
  for (const entry of ordered.slice(request.offset, request.offset + request.limit)) {
    const length = byteLength(entry);
    if (length > CSV_INSPECTION_LIMITS.values_page_bytes) throw new Error("CSV_INSPECTION_VALUES_TOO_LARGE");
    if (size + length > CSV_INSPECTION_LIMITS.values_page_bytes) break;
    items.push(entry); size += length;
  }
  const next = request.offset + items.length;
  return { ...request, total: entries.size, items, next_offset: next < entries.size ? next : null };
}

export type CsvBytesInspection = Pick<CsvInspectionResponse, "content_hash" | "byte_length" | "bom" | "parser_version" | "candidates" | "selected" | "values">;

/** Auto mode supplies syntax candidates only. It never chooses a delimiter or invents mapping semantics. */
export function inspectCsvBytes(bytes: Uint8Array, dialect: "auto" | CsvDialect, values?: CsvInspectionValuesRequest): CsvBytesInspection {
  const parsed = csvInspectionRequestSchema.safeParse({ portfolio_id: "inspection", account_id: "inspection", expected_revision: 0, dialect, ...(values === undefined ? {} : { values }) });
  if (!parsed.success) throw new Error("CSV_INSPECTION_FIELDS_INVALID");
  const dialects: CsvDialect[] = dialect === "auto" ? ([",", ";", "\t"] as const).map(delimiter => ({ encoding: "utf-8", delimiter, record_separator: "either" })) : [dialect];
  let first: CsvDocument | undefined;
  const candidates = dialects.map(value => { const document = parseCsvBytes(bytes, value); first ??= document; return candidate(document, value); });
  return { content_hash: first!.content_hash, byte_length: first!.byte_length, bom: first!.bom, parser_version: CSV_PARSER_VERSION,
    candidates, selected: dialect === "auto" ? null : selected(first!, dialect),
    values: values ? valuesPage(first!, values) : null };
}

function contextList<T>(rows: Iterable<T>, total: number): CsvInspectionList<T> {
  const items: T[] = []; let size = 0;
  for (const row of rows) {
    const length = byteLength(row);
    if (size + length > CSV_INSPECTION_LIMITS.context_list_bytes) break;
    items.push(row); size += length;
  }
  return { items, total, limit: CSV_INSPECTION_LIMITS.context_items, truncated: items.length < total };
}
function context(db: Database.Database, portfolio: string): CsvInspectionContext {
  const limit = CSV_INSPECTION_LIMITS.context_items;
  const accounts = db.prepare("SELECT id,portfolio_id,name,base_currency FROM accounts WHERE portfolio_id=? ORDER BY id LIMIT ?").iterate(portfolio, limit) as Iterable<CsvInspectionContext["accounts"]["items"][number]>;
  const listings = db.prepare("SELECT l.id,l.ticker,i.name,l.currency,l.market,l.exchange FROM listings l JOIN instruments i ON i.id=l.instrument_id ORDER BY l.id LIMIT ?").iterate(limit) as Iterable<CsvInspectionContext["listings"]["items"][number]>;
  return { accounts: contextList(accounts, (db.prepare("SELECT COUNT(*) n FROM accounts WHERE portfolio_id=?").get(portfolio) as { n: number }).n),
    listings: contextList(listings, (db.prepare("SELECT COUNT(*) n FROM listings l JOIN instruments i ON i.id=l.instrument_id").get() as { n: number }).n) };
}

/** A consistent read transaction only: no attachments, mappings, previews, audits or ledger writes. */
export function inspectCsvImport(db: Database.Database, input: CsvInspectionUpload): CsvInspectionResponse {
  const { filename, bytes, ...request } = input;
  if (!csvInspectionRequestSchema.safeParse(request).success) throw new Error("CSV_INSPECTION_FIELDS_INVALID");
  if (typeof filename !== "string" || !filename || filename.length > 200 || /[\u0000-\u001f\u007f]/.test(filename)) throw new Error("CSV_FILENAME_INVALID");
  const read = (): CsvInspectionResponse => {
    if (!db.prepare("SELECT 1 FROM portfolios WHERE id=?").get(input.portfolio_id)) throw new Error("PORTFOLIO_NOT_FOUND");
    if (!db.prepare("SELECT 1 FROM accounts WHERE id=? AND portfolio_id=?").get(input.account_id, input.portfolio_id)) throw new Error("ACCOUNT_OUT_OF_SCOPE");
    const revision = (db.prepare("SELECT revision FROM ledger_heads WHERE portfolio_id=?").get(input.portfolio_id) as { revision: number } | undefined)?.revision ?? 0;
    if (revision !== input.expected_revision) throw new Error("VERSION_CONFLICT");
    const result: CsvInspectionResponse = {
      schema_version: "csv-inspection-v1", portfolio_id: input.portfolio_id, account_id: input.account_id, ledger_revision: revision,
      original_filename: filename, ...inspectCsvBytes(bytes, input.dialect, input.values), context: context(db, input.portfolio_id),
      limits: CSV_INSPECTION_LIMITS, state_written: false, broker_format_verified: false,
    };
    if (byteLength(result) > CSV_INSPECTION_LIMITS.response_bytes) throw new Error("CSV_INSPECTION_RESPONSE_TOO_LARGE");
    return result;
  };
  return db.inTransaction ? read() : db.transaction(read).deferred();
}
