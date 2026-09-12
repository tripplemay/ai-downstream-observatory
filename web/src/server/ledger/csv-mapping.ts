import { assertLedgerCommand } from "../contracts";
import { parseStrictJson } from "../strict-json";
import { canonical, hash, type LedgerCommand } from "./service";
import { amount, exact } from "./decimal";
import { CSV_PARSER_VERSION, parseCsvBytes, type CsvDocument, type CsvIssue, type CsvRecord } from "./csv";
import { CSV_DECIMAL_FIELDS, csvContextSchema, csvDecimalFormatSchema, csvMappingSchema, type CsvBinding, type CsvDecimalFormat, type CsvImportContext, type CsvMapping } from "./csv-schemas";

export { csvMappingSchema, type CsvMapping, type CsvImportContext } from "./csv-schemas";
export const CSV_MAPPING_VERSION = "explicit-csv-mapping-v1";
export const CSV_MAPPING_MAX_BYTES = 256 * 1024;
export type CsvImportRow = Omit<LedgerCommand, "portfolio_id" | "expected_revision" | "idempotency_key">;
export interface CsvMappedRow extends CsvRecord { command: CsvImportRow | null; warnings: CsvIssue[] }
export interface CsvMappingResult {
  parser_version: string; mapping_engine_version: string; content_hash: string; mapping_hash: string; context_hash: string; preview_hash: string;
  mapping_id: string; mapping_version: number; status: "parse_error" | "mapping_errors" | "requires_ledger_preview";
  document: CsvDocument; rows: CsvMappedRow[]; errors: CsvIssue[]; warnings: string[];
  standard_rows: CsvImportRow[] | null; can_preview: boolean; broker_format_verified: false;
}

export function parseCsvMapping(raw: string): CsvMapping {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > CSV_MAPPING_MAX_BYTES) throw new Error("CSV_MAPPING_TOO_LARGE");
  let parsed: unknown;
  try { parsed = parseStrictJson(raw); } catch { throw new Error("CSV_MAPPING_JSON_INVALID"); }
  const result = csvMappingSchema.safeParse(parsed);
  if (!result.success) throw new Error("CSV_MAPPING_INVALID");
  return result.data;
}

/** Formatting rules are declared by a human. No locale, currency symbol or sign is inferred. */
export function normalizeCsvDecimal(raw: string, suppliedFormat: CsvDecimalFormat): string {
  const parsed = csvDecimalFormatSchema.safeParse(suppliedFormat);
  if (!parsed.success || typeof raw !== "string") throw new Error("CSV_DECIMAL_FORMAT_INVALID");
  const format = parsed.data;
  let value = format.trim ? raw.trim() : raw, negative = false;
  if (value.startsWith("(") || value.endsWith(")")) {
    if (format.negative_style === "minus" || !value.startsWith("(") || !value.endsWith(")")) throw new Error("CSV_DECIMAL_INVALID");
    negative = true; value = value.slice(1, -1);
  } else if (value.startsWith("-")) {
    if (format.negative_style === "parentheses") throw new Error("CSV_DECIMAL_INVALID");
    negative = true; value = value.slice(1);
  } else if (value.startsWith("+")) {
    if (!format.allow_leading_plus) throw new Error("CSV_DECIMAL_INVALID");
    value = value.slice(1);
  }
  const parts = value.split(format.decimal_separator);
  if (parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) throw new Error("CSV_DECIMAL_INVALID");
  let integer = parts[0];
  if (!/^\d+$/.test(integer)) {
    if (format.grouping_separator === "none") throw new Error("CSV_DECIMAL_INVALID");
    const groups = integer.split(format.grouping_separator);
    if (groups.length < 2 || !/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some(group => !/^\d{3}$/.test(group))) throw new Error("CSV_DECIMAL_INVALID");
    integer = groups.join("");
  }
  const normalized = `${negative ? "-" : ""}${integer.replace(/^0+(?=\d)/, "")}${parts.length === 2 ? "." + parts[1] : ""}`;
  try { return exact(amount(normalized)); } catch { throw new Error("CSV_DECIMAL_RANGE_OR_SYNTAX"); }
}

function dateValue(raw: string, definition: CsvMapping["effective_at"]): { effective_at: string; time_precision: "date" | "second"; source_timezone: string } {
  const value = definition.trim ? raw.trim() : raw;
  let match: RegExpExecArray | null;
  if (definition.format === "ISO8601_OFFSET") match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  else match = (definition.format === "YYYY-MM-DD" ? /^(\d{4})-(\d{2})-(\d{2})$/ : definition.format === "YYYY/MM/DD" ? /^(\d{4})\/(\d{2})\/(\d{2})$/ : /^(\d{4})(\d{2})(\d{2})$/).exec(value);
  if (!match) throw new Error("CSV_DATE_FORMAT_MISMATCH");
  const day = `${match[1]}-${match[2]}-${match[3]}`, parsedDay = new Date(day + "T00:00:00.000Z");
  if (match[1] === "0000" || !Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) throw new Error("CSV_DATE_INVALID");
  if (definition.format !== "ISO8601_OFFSET") return { effective_at: day, time_precision: "date", source_timezone: definition.source_timezone };
  const offset = match[8];
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 || (offset !== "Z" && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59 || (offset.slice(1, 3) === "14" && offset.slice(4) !== "00")))) throw new Error("CSV_DATE_INVALID");
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("CSV_DATE_INVALID");
  return { effective_at: instant.toISOString(), time_precision: "second", source_timezone: definition.source_timezone };
}

function bindings(mapping: CsvMapping): [string, CsvBinding][] {
  return [["account", mapping.account], ["event_type", mapping.event_type], ["reason", mapping.reason], ...(mapping.source_event_id ? [["source_event_id", mapping.source_event_id] as [string, CsvBinding]] : []), ...mapping.rules.flatMap(rule => Object.entries(rule.fields).map(([field, binding]) => [`${rule.event_type}.${field}`, binding] as [string, CsvBinding]))];
}
function inspectMapping(mapping: CsvMapping, context: CsvImportContext, headers: string[]): CsvIssue[] {
  const errors: CsvIssue[] = [], seenColumns = new Set([mapping.effective_at.column]);
  if (canonical(headers) !== canonical(mapping.expected_headers)) errors.push({ code: "CSV_HEADERS_CHANGED" });
  if (new Set(mapping.expected_headers).size !== mapping.expected_headers.length || new Set(mapping.ignored_columns).size !== mapping.ignored_columns.length) errors.push({ code: "CSV_MAPPING_DUPLICATE_COLUMN" });
  if (new Set(mapping.rules.map(rule => rule.event_type)).size !== mapping.rules.length) errors.push({ code: "CSV_MAPPING_DUPLICATE_RULE" });
  if (new Set(context.accounts.map(row => row.id)).size !== context.accounts.length || new Set(context.listings.map(row => row.id)).size !== context.listings.length) errors.push({ code: "CSV_CONTEXT_AMBIGUOUS" });
  if (!context.accounts.some(row => row.id === context.account_id && row.portfolio_id === context.portfolio_id)) errors.push({ code: "CSV_ACCOUNT_OUT_OF_SCOPE" });
  for (const [field, binding] of bindings(mapping)) {
    if (binding.kind !== "constant") seenColumns.add(binding.column);
    if (binding.kind === "lookup") {
      const keys = binding.entries.map(entry => binding.trim ? entry.input.trim() : entry.input);
      if (new Set(keys).size !== keys.length) errors.push({ code: "CSV_LOOKUP_AMBIGUOUS", field });
    }
    const name = field.split(".").at(-1)!;
    if ((CSV_DECIMAL_FIELDS as readonly string[]).includes(name) && !["constant", "decimal"].includes(binding.kind)) errors.push({ code: "CSV_DECIMAL_RULE_REQUIRED", field });
    if (["listing_id", "target_account_id", "related_event_id"].includes(name) && !["constant", "lookup"].includes(binding.kind)) errors.push({ code: "CSV_ID_MAPPING_REQUIRED", field });
    if (!(CSV_DECIMAL_FIELDS as readonly string[]).includes(name) && binding.kind === "decimal") errors.push({ code: "CSV_TEXT_RULE_REQUIRED", field });
  }
  for (const rule of mapping.rules) {
    if (["buy", "sell", "fx", "transfer_out"].includes(rule.event_type) && !rule.fields.fee) errors.push({ code: "CSV_EXPLICIT_FEE_REQUIRED", field: rule.event_type + ".fee" });
    if (["dividend", "dividend_accrual"].includes(rule.event_type) && !rule.fields.tax) errors.push({ code: "CSV_EXPLICIT_TAX_REQUIRED", field: rule.event_type + ".tax" });
    for (const field of ["fee", "tax"] as const) {
      const binding = rule.fields[field];
      if (binding && "empty" in binding && binding.empty === "omit") errors.push({ code: "CSV_CHARGES_CANNOT_BE_OMITTED", field: rule.event_type + "." + field });
    }
  }
  for (const name of seenColumns) if (!headers.includes(name)) errors.push({ code: "CSV_COLUMN_NOT_FOUND", field: name });
  for (const name of mapping.ignored_columns) if (!headers.includes(name) || seenColumns.has(name)) errors.push({ code: "CSV_IGNORED_COLUMN_INVALID", field: name });
  for (const name of headers) if (!seenColumns.has(name) && !mapping.ignored_columns.includes(name)) errors.push({ code: "CSV_UNMAPPED_COLUMN", field: name });
  return errors;
}

function readBinding(binding: CsvBinding, row: CsvRecord, indices: Map<string, number>, lookups: WeakMap<object, Map<string, string>>): string | undefined {
  if (binding.kind === "constant") return binding.value;
  const index = indices.get(binding.column), raw = index === undefined ? undefined : row.cells[index];
  if (raw === undefined) throw new Error("CSV_COLUMN_NOT_FOUND");
  if (binding.kind === "decimal") {
    const empty = binding.format.trim ? raw.trim() === "" : raw === "";
    if (empty && binding.empty === "omit") return;
    return normalizeCsvDecimal(raw, binding.format);
  }
  const value = binding.trim ? raw.trim() : raw;
  if (binding.kind === "lookup") {
    if (!lookups.has(binding)) lookups.set(binding, new Map(binding.entries.map(entry => [binding.trim ? entry.input.trim() : entry.input, entry.value])));
    const matched = lookups.get(binding)!.get(value);
    if (matched === undefined) throw new Error("CSV_VALUE_NOT_MAPPED");
    return matched;
  }
  if (!value) {
    if (binding.empty === "omit") return;
    throw new Error("CSV_EMPTY_VALUE");
  }
  return value;
}

/** Produces only a structurally validated preview candidate; callers must retain bytes/mapping and run ledger preview. */
export function mapCsvImport(bytes: Uint8Array, rawMapping: unknown, rawContext: CsvImportContext): CsvMappingResult {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(rawMapping); } catch { throw new Error("CSV_MAPPING_INVALID"); }
  if (serialized && Buffer.byteLength(serialized, "utf8") > CSV_MAPPING_MAX_BYTES) throw new Error("CSV_MAPPING_TOO_LARGE");
  const parsedMapping = csvMappingSchema.safeParse(rawMapping), parsedContext = csvContextSchema.safeParse(rawContext);
  if (!parsedMapping.success) throw new Error("CSV_MAPPING_INVALID");
  if (!parsedContext.success) throw new Error("CSV_CONTEXT_INVALID");
  const mapping = parsedMapping.data, context = parsedContext.data, document = parseCsvBytes(bytes, mapping.dialect);
  const indices = new Map(document.headers.map((header, index) => [header, index])), lookups = new WeakMap<object, Map<string, string>>();
  const allowedAccounts = new Set(context.accounts.filter(row => row.portfolio_id === context.portfolio_id).map(row => row.id));
  const listings = new Map(context.listings.map(row => [row.id, row.currency])), rules = new Map(mapping.rules.map(rule => [String(rule.event_type), rule]));
  const errors = inspectMapping(mapping, context, document.headers);
  if (document.errors.length) errors.push({ code: "CSV_STRUCTURE_INVALID" });
  const rows = document.rows.map((row): CsvMappedRow => {
    const errorsForRow = [...row.errors], warnings = row.formula_columns.map(column => ({ code: "CSV_FORMULA_LIKE_TEXT_NOT_EXECUTED", column }));
    const output: CsvMappedRow = { ...row, errors: errorsForRow, warnings, command: null };
    if (errors.length) { errorsForRow.push({ code: "CSV_FILE_OR_MAPPING_INVALID" }); return output; }
    const read = (field: string, binding: CsvBinding) => {
      try {
        const value = readBinding(binding, row, indices, lookups);
        if (value === undefined) warnings.push({ code: "CSV_EMPTY_FIELD_EXPLICITLY_OMITTED", column: "column" in binding ? document.headers.indexOf(binding.column) + 1 : 0 });
        return value;
      } catch (error) { errorsForRow.push({ code: error instanceof Error ? error.message : "CSV_VALUE_INVALID", field }); }
    };
    const account = read("account", mapping.account), eventType = read("event_type", mapping.event_type), reason = read("reason", mapping.reason);
    const sourceEventId = mapping.source_event_id ? read("source_event_id", mapping.source_event_id) : undefined;
    const fact: Record<string, unknown> = { type: eventType, account_id: account };
    if (account !== context.account_id || !account || !allowedAccounts.has(account)) errorsForRow.push({ code: "CSV_ACCOUNT_OUT_OF_SCOPE", field: "account" });
    const rule = eventType ? rules.get(eventType) : undefined;
    if (!rule) errorsForRow.push({ code: "CSV_EVENT_RULE_MISSING", field: "event_type" });
    else for (const [field, binding] of Object.entries(rule.fields)) {
      const value = read(field, binding);
      if (value !== undefined) fact[field] = value;
    }
    if (fact.target_account_id && !allowedAccounts.has(String(fact.target_account_id))) errorsForRow.push({ code: "CSV_ACCOUNT_OUT_OF_SCOPE", field: "target_account_id" });
    if (fact.listing_id && listings.get(String(fact.listing_id)) !== fact.currency) errorsForRow.push({ code: "CSV_LISTING_CURRENCY_OR_SCOPE_INVALID", field: "listing_id" });
    let date: ReturnType<typeof dateValue> | undefined;
    try { date = dateValue(row.cells[document.headers.indexOf(mapping.effective_at.column)] ?? "", mapping.effective_at); }
    catch (error) { errorsForRow.push({ code: error instanceof Error ? error.message : "CSV_DATE_INVALID", field: "effective_at" }); }
    if (!sourceEventId) warnings.push({ code: "CSV_RELIABLE_SOURCE_ID_MISSING", column: 0 });
    if (eventType === "opening_position" && fact.cost_amount === undefined) warnings.push({ code: "CSV_OPENING_COST_UNKNOWN", column: 0 });
    if (!errorsForRow.length && date) {
      const command = { ...date, source_id: mapping.source_id, ...(sourceEventId ? { source_event_id: sourceEventId } : {}), reason, fact };
      try {
        assertLedgerCommand({ ...command, portfolio_id: context.portfolio_id, expected_revision: 0, idempotency_key: "csv-structural-validation-only" });
        output.command = command as unknown as CsvImportRow;
      } catch { errorsForRow.push({ code: "CSV_STANDARD_ROW_INVALID" }); }
    }
    return output;
  });
  const can_preview = !errors.length && rows.length > 0 && rows.every(row => row.command && !row.errors.length);
  const mapping_hash = hash(mapping), context_hash = hash(context);
  const preview_hash = hash({ content_hash: document.content_hash, mapping_hash, context_hash, parser: CSV_PARSER_VERSION, mapper: CSV_MAPPING_VERSION, rows });
  return { parser_version: CSV_PARSER_VERSION, mapping_engine_version: CSV_MAPPING_VERSION, content_hash: document.content_hash, mapping_hash, context_hash, preview_hash, mapping_id: mapping.mapping_id, mapping_version: mapping.version,
    status: !document.valid ? "parse_error" : can_preview ? "requires_ledger_preview" : "mapping_errors", document, rows, errors,
    warnings: ["GENERIC_MAPPING_NOT_BROKER_VERIFIED", "LEDGER_PREVIEW_REQUIRED", "ORIGINAL_CSV_AND_MAPPING_MUST_BE_RETAINED"],
    standard_rows: can_preview ? rows.map(row => row.command!) : null, can_preview, broker_format_verified: false };
}
