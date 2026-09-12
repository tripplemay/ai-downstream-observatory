import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, revision } from "../src/server/ledger/service";
import { previewJsonImport } from "../src/server/ledger/imports";
import { CSV_MAPPING_MAX_BYTES, mapCsvImport, normalizeCsvDecimal, parseCsvMapping, type CsvImportContext, type CsvMapping } from "../src/server/ledger/csv-mapping";
import type { CsvBinding, CsvDecimalFormat } from "../src/server/ledger/csv-schemas";

const format: CsvDecimalFormat = { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false };
const numeric = (column: string): CsvBinding => ({ kind: "decimal", column, empty: "reject", format });
const text = (column: string): CsvBinding => ({ kind: "column", column, trim: false, empty: "reject" });
const context: CsvImportContext = { portfolio_id: "portfolio", account_id: "account", accounts: [{ id: "account", portfolio_id: "portfolio" }], listings: [{ id: "listing", currency: "CNY" }] };
const header = "event,account,code,date,currency,quantity,price,fee,amount,source_record,note";
const deposit = "入金,A,,2026/01/01,CNY,,,,1000.50,d-001,Initial deposit";
const buy = "买入,A,000001,2026/01/02,CNY,100,1.25,0.50,,b-001,Buy test";
const bytes = Buffer.from([header, deposit, buy].join("\n"));
function mapping(): CsvMapping {
  return { schema_version: "csv-import-mapping-v1", mapping_id: "SYNTHETIC-GENERIC-ONLY", version: 1, title: "Synthetic explicit mapping, not broker certification",
    dialect: { encoding: "utf-8", delimiter: ",", record_separator: "lf" }, expected_headers: header.split(","), ignored_columns: [],
    account: { kind: "lookup", column: "account", trim: false, entries: [{ input: "A", value: "account" }] },
    event_type: { kind: "lookup", column: "event", trim: false, entries: [{ input: "入金", value: "deposit" }, { input: "买入", value: "buy" }] },
    source_id: "SYNTHETIC-NOT-A-BROKER", source_event_id: { kind: "column", column: "source_record", trim: false, empty: "reject" },
    reason: { kind: "column", column: "note", trim: false, empty: "reject" }, effective_at: { column: "date", format: "YYYY/MM/DD", trim: false, source_timezone: "Asia/Shanghai" },
    rules: [{ event_type: "deposit", fields: { currency: text("currency"), amount: numeric("amount") } },
      { event_type: "buy", fields: { currency: text("currency"), listing_id: { kind: "lookup", column: "code", trim: false, entries: [{ input: "000001", value: "listing" }] }, quantity: numeric("quantity"), price: numeric("price"), fee: numeric("fee") } }],
  };
}

test("explicit versioned mapping preserves code identity and creates only standard preview candidates", () => {
  const result = mapCsvImport(bytes, mapping(), context);
  assert.equal(result.can_preview, true); assert.equal(result.status, "requires_ledger_preview"); assert.equal(result.broker_format_verified, false);
  assert.equal(result.rows[1].cells[2], "000001"); assert.equal(result.rows[1].record_number, 3);
  assert.equal(result.standard_rows![1].fact.listing_id, "listing"); assert.equal(result.standard_rows![0].fact.amount, "1000.5");
  assert.equal(result.standard_rows![1].fact.fee, "0.5"); assert.equal(result.standard_rows![1].effective_at, "2026-01-02");
  assert.equal(result.standard_rows![1].time_precision, "date"); assert.equal(result.standard_rows![1].source_timezone, "Asia/Shanghai");
  for (const field of ["portfolio_id", "expected_revision", "idempotency_key"]) assert.equal(field in result.standard_rows![0], false);
  assert.equal(mapCsvImport(bytes, mapping(), context).preview_hash, result.preview_hash);
  const revised = mapping(); revised.version = 2;
  assert.notEqual(mapCsvImport(bytes, revised, context).mapping_hash, result.mapping_hash);
  assert.notEqual(mapCsvImport(Buffer.concat([bytes, Buffer.from("\n")]), mapping(), context).content_hash, result.content_hash);
  assert.notEqual(mapCsvImport(bytes, mapping(), { ...context, listings: [...context.listings, { id: "unrelated-explicit-listing", currency: "USD" }] }).preview_hash, result.preview_hash);
});

test("money formatting is explicit, exact and rejects malformed grouping, exponents, symbols and excess precision", () => {
  const grouped = { ...format, grouping_separator: "," as const };
  assert.equal(normalizeCsvDecimal("1,234,567.123456789012345678", grouped), "1234567.123456789012345678");
  assert.equal(normalizeCsvDecimal("000001.2300", format), "1.23");
  assert.equal(normalizeCsvDecimal("1.234,56", { ...format, grouping_separator: ".", decimal_separator: "," }), "1234.56");
  assert.equal(normalizeCsvDecimal("(1 234,50)", { ...format, grouping_separator: " ", decimal_separator: ",", negative_style: "parentheses" }), "-1234.5");
  assert.equal(normalizeCsvDecimal(" +12.30 ", { ...format, allow_leading_plus: true, trim: true }), "12.3");
  assert.equal(normalizeCsvDecimal("-0.000", format), "0");
  for (const raw of ["1,23.45", "1234,567.89", "1,234.5,6", "1e3", "NaN", "Infinity", "12%", "$12", "- 12", " 12", "+12", "1.", ".5", "(12)", "1_234", "1\u00a0234", "١٢"]) assert.throws(() => normalizeCsvDecimal(raw, grouped), /CSV_DECIMAL/, raw);
  assert.throws(() => normalizeCsvDecimal("0.1234567890123456789", format), /CSV_DECIMAL_RANGE_OR_SYNTAX/);
  assert.throws(() => normalizeCsvDecimal("9".repeat(39), format), /CSV_DECIMAL_RANGE_OR_SYNTAX/);
  assert.throws(() => normalizeCsvDecimal("12", { ...format, grouping_separator: "." }), /CSV_DECIMAL_FORMAT_INVALID/);
});

test("all parsable row failures are retained; no implicit valid subset can be submitted", () => {
  const source = [header, deposit, buy.replace("000001", "1"), buy.replace("100,1.25", "1e2,1.25").replace("2026/01/02", "2026/02/30"), buy.replace("买入", "unknown"), buy].join("\n");
  const result = mapCsvImport(Buffer.from(source), mapping(), context);
  assert.equal(result.rows.length, 5); assert.equal(result.can_preview, false); assert.equal(result.standard_rows, null);
  assert.ok(result.rows[0].command); assert.ok(result.rows[4].command);
  assert.ok(result.rows[1].errors.some(error => error.code === "CSV_VALUE_NOT_MAPPED" && error.field === "listing_id"));
  assert.ok(result.rows[2].errors.some(error => error.field === "quantity")); assert.ok(result.rows[2].errors.some(error => error.field === "effective_at"));
  assert.ok(result.rows[3].errors.some(error => error.code === "CSV_EVENT_RULE_MISSING"));
  assert.deepEqual(result.rows.map(row => row.record_number), [2, 3, 4, 5, 6]);
});

test("scope and raw column coverage reject ambiguous IDs, implicit costs and silently dropped columns", () => {
  const scenarios: [string, (value: CsvMapping) => void][] = [
    ["CSV_ACCOUNT_OUT_OF_SCOPE", value => { value.account = { kind: "constant", value: "foreign" }; value.ignored_columns.push("account"); }],
    ["CSV_ID_MAPPING_REQUIRED", value => { value.rules[1].fields.listing_id = text("code"); }],
    ["CSV_DECIMAL_RULE_REQUIRED", value => { value.rules[1].fields.price = text("price"); }],
    ["CSV_EXPLICIT_FEE_REQUIRED", value => { delete value.rules[1].fields.fee; value.ignored_columns.push("fee"); }],
    ["CSV_CHARGES_CANNOT_BE_OMITTED", value => { value.rules[1].fields.fee = { kind: "decimal", column: "fee", empty: "omit", format }; }],
    ["CSV_LOOKUP_AMBIGUOUS", value => { value.account = { kind: "lookup", column: "account", trim: true, entries: [{ input: "A", value: "account" }, { input: " A ", value: "foreign" }] }; }],
    ["CSV_UNMAPPED_COLUMN", value => { value.reason = { kind: "constant", value: "Synthetic" }; }],
    ["CSV_IGNORED_COLUMN_INVALID", value => { value.ignored_columns.push("price"); }],
    ["CSV_MAPPING_DUPLICATE_RULE", value => { value.rules.push(value.rules[0]); }],
  ];
  for (const [code, change] of scenarios) {
    const value = mapping(); change(value); const result = mapCsvImport(bytes, value, context);
    assert.equal(result.can_preview, false, code); assert.ok([...result.errors, ...result.rows.flatMap(row => row.errors)].some(error => error.code === code), code);
  }
  assert.equal(mapCsvImport(bytes, mapping(), { ...context, listings: [{ id: "listing", currency: "USD" }] }).rows[1].errors.some(error => error.code === "CSV_LISTING_CURRENCY_OR_SCOPE_INVALID"), true);
  assert.ok(mapCsvImport(bytes, mapping(), { ...context, accounts: [{ id: "account", portfolio_id: "other" }] }).errors.some(error => error.code === "CSV_ACCOUNT_OUT_OF_SCOPE"));
  assert.ok(mapCsvImport(bytes, mapping(), { ...context, listings: [context.listings[0], context.listings[0]] }).errors.some(error => error.code === "CSV_CONTEXT_AMBIGUOUS"));
});

test("headers, dialects, mapping JSON and provenance cannot be guessed or injected", () => {
  const value = mapping();
  assert.deepEqual(parseCsvMapping(JSON.stringify(value)), value);
  assert.throws(() => parseCsvMapping('{"schema_version":"x","schema_version":"csv-import-mapping-v1"}'), /CSV_MAPPING_JSON_INVALID/);
  assert.throws(() => parseCsvMapping(" ".repeat(CSV_MAPPING_MAX_BYTES + 1)), /CSV_MAPPING_TOO_LARGE/);
  assert.throws(() => mapCsvImport(bytes, { ...value, huge: "x".repeat(CSV_MAPPING_MAX_BYTES) }, context), /CSV_MAPPING_TOO_LARGE/);
  assert.throws(() => mapCsvImport(bytes, { ...value, approved: true, broker_format_verified: true }, context), /CSV_MAPPING_INVALID/);
  assert.throws(() => mapCsvImport(bytes, { ...value, source_timezone: "UTC" }, context), /CSV_MAPPING_INVALID/);
  assert.ok(mapCsvImport(Buffer.from(bytes.toString().replace("quantity", "qty")), value, context).errors.some(error => error.code === "CSV_HEADERS_CHANGED"));
  const noGuess = mapping(); noGuess.effective_at.source_timezone = "";
  assert.throws(() => mapCsvImport(bytes, noGuess, context), /CSV_MAPPING_INVALID/);
  const malformed = mapCsvImport(Buffer.from(header + '\n"unterminated'), value, context);
  assert.equal(malformed.status, "parse_error"); assert.equal(malformed.standard_rows, null);
});

test("10,000 rows and a declared lookup table remain bounded and preserve every original row", () => {
  const value = mapping();
  value.rules[1].fields.listing_id = { kind: "lookup", column: "code", trim: false, entries: [
    ...Array.from({ length: 1000 }, (_, index) => ({ input: `code-${index}`, value: `listing-${index}` })), { input: "000001", value: "listing" },
  ] };
  const input = Buffer.from([header, ...Array.from({ length: 10000 }, (_, index) => buy.replace("b-001", `source-${index}`))].join("\n"));
  const result = mapCsvImport(input, value, context);
  assert.equal(result.can_preview, true); assert.equal(result.standard_rows!.length, 10000); assert.equal(result.rows[9999].record_number, 10001);
  assert.equal(result.standard_rows![9999].source_event_id, "source-9999"); assert.equal(result.rows[9999].byte_end, input.length);
});

test("date formats and offset timestamps are explicit; invalid days, leap seconds and lost precision fail", () => {
  for (const [formatName, sourceDate, expected] of [["YYYY-MM-DD", "2026-01-02", "2026-01-02"], ["YYYYMMDD", "20260102", "2026-01-02"], ["ISO8601_OFFSET", "2026-01-02T10:00:00.123+08:00", "2026-01-02T02:00:00.123Z"]] as const) {
    const value = mapping(); value.effective_at.format = formatName;
    const data = Buffer.from(header + "\n" + buy.replace("2026/01/02", sourceDate));
    assert.equal(mapCsvImport(data, value, context).standard_rows![0].effective_at, expected);
  }
  const value = mapping(); value.effective_at.format = "ISO8601_OFFSET";
  for (const sourceDate of ["2026-01-02T10:00:00", "2026-02-30T10:00:00Z", "2026-01-02T24:00:00Z", "2026-01-02T10:00:60Z", "2026-01-02T10:00:00.1234Z", "2026-01-02T10:00:00+14:30", "0000-01-02T10:00:00Z"]) {
    const result = mapCsvImport(Buffer.from(header + "\n" + buy.replace("2026/01/02", sourceDate)), value, context);
    assert.equal(result.can_preview, false, sourceDate); assert.ok(result.rows[0].errors.some(error => error.field === "effective_at"));
  }
});

test("missing source IDs keep distinct rows and warn; formula text is inert while numeric formulas fail", () => {
  const value = mapping(); value.source_event_id = null; value.ignored_columns.push("source_record");
  const duplicated = Buffer.from([header, deposit, deposit].join("\n")), result = mapCsvImport(duplicated, value, context);
  assert.equal(result.can_preview, true); assert.equal(result.standard_rows!.length, 2);
  assert.ok(result.rows.every(row => row.warnings.some(warning => warning.code === "CSV_RELIABLE_SOURCE_ID_MISSING")));
  const memo = mapCsvImport(Buffer.from(header + "\n" + buy.replace("Buy test", "=1+2")), mapping(), context);
  assert.equal(memo.can_preview, true); assert.equal(memo.standard_rows![0].reason, "=1+2");
  assert.ok(memo.rows[0].warnings.some(warning => warning.code === "CSV_FORMULA_LIKE_TEXT_NOT_EXECUTED"));
  assert.equal(mapCsvImport(Buffer.from(header + "\n" + buy.replace("1.25", "=SUM(1)")), mapping(), context).can_preview, false);
});

test("mapped standard rows exercise the existing ledger preview with no actual facts or cash writes", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "csv-import-preview-")), filename = path.join(dataDir, "workbench.db");
  migrateWorkbench(filename); const db = openWorkbench(filename), actor = { id: "SYNTHETIC-CSV-TEST" }, now = "2026-02-01T00:00:00.000Z";
  try {
    const portfolio = createPortfolio(db, actor, "Synthetic CSV preview only", now), account = createAccount(db, actor, portfolio, "Synthetic A", "No broker", "CNY", now);
    db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('synthetic-i','Synthetic ETF',?)").run(now);
    db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('listing','synthetic-i','CN','SSE','000001','CNY',?)").run(now);
    const value = mapping(); value.account = { kind: "lookup", column: "account", trim: false, entries: [{ input: "A", value: account }] };
    const mapped = mapCsvImport(bytes, value, { ...context, portfolio_id: portfolio, account_id: account, accounts: [{ id: account, portfolio_id: portfolio }] });
    assert.equal(mapped.can_preview, true);
    const preview = previewJsonImport(db, actor, portfolio, account, JSON.stringify(mapped.standard_rows), now, { dataDir });
    assert.equal(preview.status, "preview"); assert.equal(preview.rows.length, 2); assert.ok(preview.rows.every(row => row.errors.length === 0));
    assert.equal(revision(db, portfolio), 0); assert.equal((db.prepare("SELECT COUNT(*) n FROM ledger_events").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM account_projections").get() as { n: number }).n, 0);
    // This test intentionally does not confirm: production CSV original/mapping retention is a separate integration gate.
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
