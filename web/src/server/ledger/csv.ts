import { createHash } from "node:crypto";

export const CSV_PARSER_VERSION = "strict-csv-utf8-v1";
export const CSV_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, data_rows: 10000, columns: 128, field_bytes: 64 * 1024, record_bytes: 256 * 1024, header_bytes: 256 });
export interface CsvDialect { encoding: "utf-8"; delimiter: "," | ";" | "\t"; record_separator: "crlf" | "lf" | "either" }
export interface CsvLocation { record_number: number; line_start: number; line_end: number; byte_start: number; byte_end: number }
export interface CsvIssue { code: string; column?: number; field?: string }
export interface CsvRecord extends CsvLocation { cells: string[]; formula_columns: number[]; errors: CsvIssue[] }
export interface CsvDocument { parser_version: string; content_hash: string; byte_length: number; bom: boolean; headers: string[]; header: CsvRecord | null; rows: CsvRecord[]; errors: (CsvIssue & Partial<CsvLocation>)[]; valid: boolean }

/** This flag is for safe rendering/export, never an instruction to evaluate or alter original cells. */
export const csvFormulaLike = (value: string) => /^[\t\r\n ]*[=+\-@]/.test(value);

/** RFC4180-style quoting with an explicit delimiter/newline dialect; UTF-8 is never guessed. */
export function parseCsvBytes(input: Uint8Array, dialect: CsvDialect): CsvDocument {
  if (!(input instanceof Uint8Array)) throw new Error("CSV_BYTES_REQUIRED");
  if (!dialect || dialect.encoding !== "utf-8" || ![",", ";", "\t"].includes(dialect.delimiter) || !["crlf", "lf", "either"].includes(dialect.record_separator) || Object.keys(dialect).some(key => !["encoding", "delimiter", "record_separator"].includes(key))) throw new Error("CSV_DIALECT_INVALID");
  if (input.byteLength > CSV_LIMITS.bytes) throw new Error("CSV_TOO_LARGE");
  const bytes = Buffer.from(input), content_hash = createHash("sha256").update(bytes).digest("hex");
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const result: CsvDocument = { parser_version: CSV_PARSER_VERSION, content_hash, byte_length: bytes.length, bom, headers: [], header: null, rows: [], errors: [], valid: false };
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { result.errors.push({ code: "CSV_INVALID_UTF8" }); return result; }
  const start = bom ? 3 : 0, delimiter = dialect.delimiter.charCodeAt(0);
  if (bytes.length === start) { result.errors.push({ code: "CSV_EMPTY" }); return result; }
  const records: CsvRecord[] = [];
  let offset = start, line = 1, recordStart = start, lineStart = 1, fieldStart = start;
  let state: "start" | "plain" | "quoted" | "closed" = "start", cells: string[] = [];
  const abort = (code: string) => { result.errors.push({ code, record_number: records.length + 1, line_start: lineStart, line_end: line, byte_start: recordStart, byte_end: offset }); };
  const pushField = (end: number) => {
    if (end - fieldStart > CSV_LIMITS.field_bytes) { abort("CSV_FIELD_TOO_LARGE"); return false; }
    const raw = bytes.subarray(fieldStart, end).toString("utf8");
    cells.push(state === "closed" ? raw.slice(1, -1).replace(/""/g, '"') : raw);
    if (cells.length > CSV_LIMITS.columns) { abort("CSV_TOO_MANY_COLUMNS"); return false; }
    return true;
  };
  const pushRecord = (end: number) => {
    const errors: CsvIssue[] = [];
    if (records.length && cells.length !== records[0].cells.length) errors.push({ code: "CSV_COLUMN_COUNT_MISMATCH" });
    if (cells.length === 1 && cells[0] === "") errors.push({ code: "CSV_BLANK_RECORD" });
    records.push({ record_number: records.length + 1, line_start: lineStart, line_end: line, byte_start: recordStart, byte_end: end, cells, errors, formula_columns: cells.flatMap((cell, index) => csvFormulaLike(cell) ? [index + 1] : []) });
    cells = [];
    if (records.length > CSV_LIMITS.data_rows + 1) { abort("CSV_TOO_MANY_ROWS"); return false; }
    return true;
  };
  while (offset < bytes.length && !result.errors.length) {
    if (offset - recordStart >= CSV_LIMITS.record_bytes) { abort("CSV_RECORD_TOO_LARGE"); break; }
    if (offset - fieldStart >= CSV_LIMITS.field_bytes && bytes[offset] !== delimiter && bytes[offset] !== 10 && bytes[offset] !== 13) { abort("CSV_FIELD_TOO_LARGE"); break; }
    const byte = bytes[offset];
    if ((byte < 32 && ![9, 10, 13].includes(byte)) || byte === 127) { abort("CSV_CONTROL_CHARACTER"); break; }
    if (state === "quoted") {
      if (byte === 34) {
        if (bytes[offset + 1] === 34) { offset += 2; continue; }
        state = "closed";
      } else if (byte === 10) line++;
      else if (byte === 13 && bytes[offset + 1] !== 10) line++;
      offset++; continue;
    }
    if (byte === delimiter) {
      if (!pushField(offset)) break;
      offset++; fieldStart = offset; state = "start"; continue;
    }
    if (byte === 10 || byte === 13) {
      const crlf = byte === 13 && bytes[offset + 1] === 10;
      if ((byte === 13 && !crlf) || (crlf && dialect.record_separator === "lf") || (!crlf && dialect.record_separator === "crlf")) { abort("CSV_RECORD_SEPARATOR_MISMATCH"); break; }
      if (!pushField(offset) || !pushRecord(offset)) break;
      offset += crlf ? 2 : 1; line++; recordStart = offset; lineStart = line; fieldStart = offset; state = "start"; continue;
    }
    if (state === "closed") { abort("CSV_DATA_AFTER_CLOSING_QUOTE"); break; }
    if (byte === 34) {
      if (state !== "start") { abort("CSV_QUOTE_IN_UNQUOTED_FIELD"); break; }
      state = "quoted";
    } else state = "plain";
    offset++;
  }
  if (!result.errors.length) {
    if (state === "quoted") abort("CSV_UNCLOSED_QUOTE");
    else if (recordStart < bytes.length) {
      if (bytes.length - recordStart > CSV_LIMITS.record_bytes) abort("CSV_RECORD_TOO_LARGE");
      else if (pushField(bytes.length)) pushRecord(bytes.length);
    }
  }
  result.header = records[0] ?? null; result.headers = result.header?.cells ?? []; result.rows = records.slice(1);
  if (result.header) {
    const seen = new Set<string>();
    result.headers.forEach((header, index) => {
      const normalized = header.normalize("NFC").trim();
      if (!normalized || Buffer.byteLength(header, "utf8") > CSV_LIMITS.header_bytes) result.errors.push({ code: "CSV_INVALID_HEADER", column: index + 1 });
      if (seen.has(normalized)) result.errors.push({ code: "CSV_DUPLICATE_HEADER", column: index + 1 });
      seen.add(normalized);
    });
  }
  if (!result.rows.length && !result.errors.length) result.errors.push({ code: "CSV_NO_DATA_ROWS" });
  result.valid = !result.errors.length && !result.rows.some(row => row.errors.length);
  return result;
}
