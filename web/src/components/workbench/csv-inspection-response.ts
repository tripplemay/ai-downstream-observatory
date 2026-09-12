import { z } from "zod";
import type { CsvInspectionResponse } from "../../server/ledger/csv-inspection-types";

// A versioned wire contract, deliberately independent of the server's Node-only parser.
const limits = {
  file_bytes: 4 * 1024 * 1024, data_rows: 10000, columns: 128, sample_rows: 5,
  sample_cell_bytes: 256, column_samples: 3, row_errors: 100, values_page: 100,
  values_page_bytes: 256 * 1024, context_items: 1000, context_list_bytes: 256 * 1024,
  response_bytes: 2 * 1024 * 1024,
} as const;
const fieldBytes = 64 * 1024;
const integer = (max = Number.MAX_SAFE_INTEGER, min = 0) => z.number().int().safe().min(min).max(max);
const text = (max: number, min = 0) => z.string().min(min).max(max);
const id = text(120, 1).refine(value => value.trim().length > 0);
const dialect = z.object({ encoding: z.literal("utf-8"), delimiter: z.enum([",", ";", "\t"]), record_separator: z.enum(["crlf", "lf", "either"]) }).strict();
const position = {
  record_number: integer(limits.data_rows + 3, 1), line_start: integer(limits.file_bytes + 1, 1), line_end: integer(limits.file_bytes + 1, 1),
  byte_start: integer(limits.file_bytes), byte_end: integer(limits.file_bytes),
};
const location = z.object(position).strict();
const issueFields = { code: text(128, 1).regex(/^CSV_[A-Z0-9_]+$/), column: integer(limits.columns, 1).optional(), field: text(fieldBytes).optional() };
const issue = z.object(issueFields).strict();
const documentIssue = z.object({ ...issueFields, ...location.partial().shape }).strict();
const sampleFields = { value: text(limits.sample_cell_bytes), byte_length: integer(fieldBytes), truncated: z.boolean(), formula_like: z.boolean() };
const sample = z.object(sampleFields).strict();
const candidateFields = {
  dialect, valid: z.boolean(), column_count: integer(limits.columns),
  // The parser retains the first excess row as evidence before reporting CSV_TOO_MANY_ROWS.
  row_count: integer(limits.data_rows + 1), document_errors: z.array(documentIssue).max(limits.columns * 2 + 1), row_error_count: integer(limits.data_rows + 1),
};
const candidate = z.object(candidateFields).strict();
const selected = z.object({
  ...candidateFields, headers: z.array(text(fieldBytes)).max(limits.columns), header_location: location.nullable(),
  sample_rows: z.array(z.object({ ...position, cells: z.array(sample).min(1).max(limits.columns), errors: z.array(issue).max(2) }).strict()).max(limits.sample_rows),
  columns: z.array(z.object({ index: integer(limits.columns, 1), header: text(fieldBytes), empty_count: integer(limits.data_rows + 1), distinct_count: integer(limits.data_rows + 1),
    samples: z.array(z.object({ ...sampleFields, record_number: integer(limits.data_rows + 2, 2) }).strict()).max(limits.column_samples) }).strict()).max(limits.columns),
  row_errors: z.array(z.object({ ...position, errors: z.array(issue).min(1).max(2) }).strict()).max(limits.row_errors), row_errors_truncated: z.boolean(),
}).strict();
const page = z.object({
  column: text(256, 1), trim: z.boolean(), offset: integer(limits.data_rows), limit: integer(limits.values_page, 1), total: integer(limits.data_rows, 1),
  items: z.array(z.object({ value: text(fieldBytes), count: integer(limits.data_rows, 1), first_record_number: integer(limits.data_rows + 1, 2), lookup_compatible: z.boolean(), formula_like: z.boolean() }).strict()).max(limits.values_page),
  next_offset: integer(limits.data_rows).nullable(),
}).strict();
const contextText = text(limits.context_list_bytes);
const account = z.object({ id: contextText.min(1), portfolio_id: contextText.min(1), name: contextText, base_currency: text(3, 3) }).strict();
const listing = z.object({ id: contextText.min(1), ticker: contextText, name: contextText, currency: text(3, 3), market: z.enum(["CN", "HK", "US"]), exchange: contextText }).strict();
const listFields = { total: integer(), limit: z.literal(limits.context_items), truncated: z.boolean() };
const responseSchema = z.object({
  schema_version: z.literal("csv-inspection-v1"), portfolio_id: id, account_id: id, ledger_revision: integer(),
  original_filename: text(200, 1).refine(value => !/[\u0000-\u001f\u007f]/.test(value)), content_hash: text(64, 64).regex(/^[a-f0-9]{64}$/),
  byte_length: integer(limits.file_bytes), bom: z.boolean(), parser_version: z.literal("strict-csv-utf8-v1"),
  candidates: z.array(candidate).min(1).max(3), selected: selected.nullable(), values: page.nullable(),
  context: z.object({ accounts: z.object({ ...listFields, items: z.array(account).max(limits.context_items) }).strict(),
    listings: z.object({ ...listFields, items: z.array(listing).max(limits.context_items) }).strict() }).strict(),
  limits: z.object({ file_bytes: z.literal(limits.file_bytes), data_rows: z.literal(limits.data_rows), columns: z.literal(limits.columns),
    sample_rows: z.literal(limits.sample_rows), sample_cell_bytes: z.literal(limits.sample_cell_bytes), column_samples: z.literal(limits.column_samples), row_errors: z.literal(limits.row_errors),
    values_page: z.literal(limits.values_page), values_page_bytes: z.literal(limits.values_page_bytes), context_items: z.literal(limits.context_items),
    context_list_bytes: z.literal(limits.context_list_bytes), response_bytes: z.literal(limits.response_bytes) }).strict(),
  state_written: z.literal(false), broker_format_verified: z.literal(false),
}).strict();
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;
const jsonBytes = (value: unknown) => bytes(JSON.stringify(value));
const formulaLike = (value: string) => /^[\t\r\n ]*[=+\-@]/.test(value);
function demand(condition: unknown): asserts condition { if (!condition) throw new Error("CSV_INSPECTION_RESPONSE_INVALID"); }
function same(value: unknown, other: unknown): boolean { return JSON.stringify(value) === JSON.stringify(other); }

/** Validates only the response contract; the caller must also bind scope, revision and original-file SHA-256. */
export function assertCsvInspectionResponse(value: unknown): asserts value is CsvInspectionResponse {
  try {
    demand(jsonBytes(value) <= limits.response_bytes);
    const response = responseSchema.parse(value);
    demand(!response.bom || response.byte_length >= 3);
    const checkLocation = (at: Partial<z.infer<typeof location>>) => {
      if (at.byte_start !== undefined) demand(at.byte_start <= response.byte_length);
      if (at.byte_end !== undefined) demand(at.byte_end <= response.byte_length);
      if (at.byte_start !== undefined && at.byte_end !== undefined) demand(at.byte_start <= at.byte_end);
      if (at.line_start !== undefined) demand(at.line_start <= response.byte_length + 1);
      if (at.line_end !== undefined) demand(at.line_end <= response.byte_length + 1);
      if (at.line_start !== undefined && at.line_end !== undefined) demand(at.line_start <= at.line_end);
    };
    const checkSample = (cell: z.infer<typeof sample>) => {
      const size = bytes(cell.value);
      demand(size <= limits.sample_cell_bytes && size <= cell.byte_length);
      demand(cell.truncated === (size < cell.byte_length));
      if (!cell.truncated) demand(cell.formula_like === formulaLike(cell.value));
    };
    for (const item of response.candidates) {
      demand(item.row_error_count <= item.row_count);
      demand(item.valid === (!item.document_errors.length && !item.row_error_count && item.row_count > 0 && item.column_count > 0));
      if (item.valid) demand(item.row_count <= limits.data_rows);
      if (item.row_count > limits.data_rows) demand(item.document_errors.some(error => error.code === "CSV_TOO_MANY_ROWS"));
      for (const error of item.document_errors) checkLocation(error);
    }
    const selected = response.selected;
    if (!selected) {
      demand(response.values === null && response.candidates.length === 3);
      demand(same(response.candidates.map(item => item.dialect.delimiter), [",", ";", "\t"]));
      demand(response.candidates.every(item => item.dialect.record_separator === "either"));
    } else {
      demand(response.candidates.length === 1);
      const { headers: _headers, header_location: _header, sample_rows: _rows, columns: _columns, row_errors: _errors, row_errors_truncated: _truncated, ...base } = selected;
      void _headers; void _header; void _rows; void _columns; void _errors; void _truncated;
      demand(same(base, response.candidates[0]));
      demand(selected.headers.length === selected.column_count && selected.columns.length === selected.column_count);
      demand(selected.headers.every(header => bytes(header) <= fieldBytes));
      demand((selected.header_location !== null) === (selected.headers.length > 0));
      if (selected.header_location) {
        checkLocation(selected.header_location); demand(selected.header_location.record_number === 1);
        demand(selected.header_location.byte_start === (response.bom ? 3 : 0));
      }
      demand(selected.sample_rows.length === Math.min(limits.sample_rows, selected.row_count));
      for (const [index, row] of selected.sample_rows.entries()) {
        checkLocation(row); demand(row.record_number === index + 2); row.cells.forEach(checkSample);
        if (selected.valid) demand(!row.errors.length && row.cells.length === selected.column_count);
      }
      demand(selected.row_errors.length === Math.min(selected.row_error_count, limits.row_errors));
      demand(selected.row_errors_truncated === (selected.row_error_count > limits.row_errors));
      let previousError = 1;
      for (const row of selected.row_errors) {
        checkLocation(row); demand(row.record_number > previousError && row.record_number <= selected.row_count + 1); previousError = row.record_number;
        const sampleRow = selected.sample_rows.find(sample => sample.record_number === row.record_number);
        if (sampleRow) demand(same(sampleRow.errors, row.errors));
      }
      for (const row of selected.sample_rows) if (row.errors.length) demand(selected.row_errors.some(error => error.record_number === row.record_number));
      if (selected.valid) {
        const keys = selected.headers.map(header => header.normalize("NFC").trim());
        demand(new Set(keys).size === keys.length && keys.every(Boolean));
        demand(selected.headers.every(header => bytes(header) <= 256));
      }
      for (const [index, column] of selected.columns.entries()) {
        demand(column.index === index + 1 && column.header === selected.headers[index]);
        demand(column.empty_count <= selected.row_count && column.distinct_count <= selected.row_count);
        demand(column.samples.length === Math.min(limits.column_samples, column.distinct_count));
        let previousRecord = 1;
        for (const sample of column.samples) {
          checkSample(sample); demand(sample.record_number > previousRecord && sample.record_number <= selected.row_count + 1); previousRecord = sample.record_number;
        }
      }
    }
    for (const list of [response.context.accounts, response.context.listings]) {
      demand(list.items.length <= list.total && list.truncated === (list.items.length < list.total));
      demand(new Set(list.items.map(item => item.id)).size === list.items.length);
      demand(list.items.reduce((sum, item) => sum + jsonBytes(item), 0) <= limits.context_list_bytes);
    }
    demand(response.context.accounts.items.every(item => item.portfolio_id === response.portfolio_id));
    demand(response.context.accounts.total > 0);
    if (!response.context.accounts.truncated) demand(response.context.accounts.items.some(item => item.id === response.account_id));
    const values = response.values;
    if (values) {
      demand(selected?.valid && selected.headers.includes(values.column));
      demand(values.total <= selected.row_count && values.offset <= values.total && values.items.length <= values.limit);
      const distinct = selected.columns[selected.headers.indexOf(values.column)].distinct_count;
      demand(values.trim ? values.total <= distinct : values.total === distinct);
      const end = values.offset + values.items.length;
      demand(end <= values.total && values.next_offset === (end < values.total ? end : null));
      demand(values.offset === values.total || values.items.length > 0);
      demand(new Set(values.items.map(item => item.value)).size === values.items.length);
      demand(values.items.reduce((sum, item) => sum + jsonBytes(item), 0) <= limits.values_page_bytes);
      let previousRecord = 1, count = 0;
      for (const item of values.items) {
        demand(bytes(item.value) <= fieldBytes && item.lookup_compatible === (item.value.length <= 256));
        demand(item.formula_like === formulaLike(item.value) && (!values.trim || item.value === item.value.trim()));
        demand(item.first_record_number > previousRecord && item.first_record_number <= selected.row_count + 1);
        previousRecord = item.first_record_number; count += item.count;
      }
      demand(count <= selected.row_count);
      if (values.offset === 0 && values.next_offset === null) demand(count === selected.row_count);
    }
  } catch { throw new Error("CSV_INSPECTION_RESPONSE_INVALID"); }
}
