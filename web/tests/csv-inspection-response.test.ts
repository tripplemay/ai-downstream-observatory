import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { CSV_INSPECTION_LIMITS, inspectCsvBytes, inspectCsvImport } from "../src/server/ledger/csv-inspection";
import type { CsvInspectionResponse, CsvInspectionValuesRequest } from "../src/server/ledger/csv-inspection-types";
import type { CsvDialect } from "../src/server/ledger/csv";
import { assertCsvInspectionResponse } from "../src/components/workbench/csv-inspection-response";

const dialect: CsvDialect = { encoding: "utf-8", delimiter: ",", record_separator: "either" };
const normal = "Code,Note\n000001,Synthetic\n000002,=SUM(A1:A2)\n000001,Synthetic";
function response(raw: string | Uint8Array = normal, options: { dialect?: "auto" | CsvDialect; values?: CsvInspectionValuesRequest } = {}): CsvInspectionResponse {
  const bytes = typeof raw === "string" ? Buffer.from(raw) : raw;
  return {
    schema_version: "csv-inspection-v1", portfolio_id: "synthetic-p", account_id: "synthetic-a", ledger_revision: 0,
    original_filename: "synthetic-inspection.csv", ...inspectCsvBytes(bytes, options.dialect ?? dialect, options.values),
    context: { accounts: { items: [{ id: "synthetic-a", portfolio_id: "synthetic-p", name: "Synthetic account", base_currency: "CNY" }], total: 1, limit: 1000, truncated: false },
      listings: { items: [{ id: "synthetic-l", ticker: "000001", name: "Synthetic instrument", currency: "CNY", market: "CN", exchange: "SYN" }], total: 1, limit: 1000, truncated: false } },
    limits: CSV_INSPECTION_LIMITS, state_written: false, broker_format_verified: false,
  };
}
function rejects(value: unknown) {
  assert.throws(() => assertCsvInspectionResponse(value), error => error instanceof Error && error.message === "CSV_INSPECTION_RESPONSE_INVALID");
}
function mutations(original: CsvInspectionResponse, changes: ((value: CsvInspectionResponse) => void)[]) {
  for (const change of changes) { const value = structuredClone(original); change(value); rejects(value); }
}

test("actual parser auto, explicit, quoted BOM and values responses validate without rewriting", () => {
  for (const value of [response(), response(normal, { dialect: "auto" }), response('\ufeffCode,Note\r\n000001,"line 1\r\nline 2, \"\"quoted\"\""\r\n'),
    response(normal, { values: { column: "Code", trim: false, offset: 0, limit: 100 } })]) {
    const before = JSON.stringify(value); const input: unknown = JSON.parse(before);
    assertCsvInspectionResponse(input); assert.equal(input.schema_version, "csv-inspection-v1");
    assert.equal(JSON.stringify(input), before);
  }
});

test("empty, invalid UTF8, malformed headers and partial parse evidence are legitimate non-valid responses", () => {
  for (const raw of ["", Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0xff]), "a,a\nx,y", "a\n\"not closed", "a\n\u0000", "a\n", "\na", "a\nx,y", "a,b\n\n", "x".repeat(300) + "\na", "a\n" + "x".repeat(65537)]) {
    for (const mode of [dialect, "auto"] as const) {
      const value = response(raw, { dialect: mode }); assertCsvInspectionResponse(value);
      if (mode !== "auto") assert.equal(value.selected!.valid, false);
    }
  }
  const extraRow = response(["a", ...Array.from({ length: 10001 }, () => "x")].join("\n"));
  assert.equal(extraRow.selected!.row_count, 10001); assert.equal(extraRow.selected!.valid, false);
  assertCsvInspectionResponse(extraRow);
  const manyErrors = response(["a,b", ...Array.from({ length: 110 }, () => "x")].join("\n"));
  assert.equal(manyErrors.selected!.row_errors.length, 100); assert.equal(manyErrors.selected!.row_errors_truncated, true);
  assertCsvInspectionResponse(manyErrors);
});

test("full empty/formula/leading-zero and Unicode values are not truncated into lookup keys", () => {
  const long = "=" + "中".repeat(300), raw = `Code,Note\n000001,${long}\n,empty\n000001,again\n 000001 ,space\n+1,formula`;
  const value = response(raw, { values: { column: "Code", trim: false, offset: 0, limit: 100 } });
  assertCsvInspectionResponse(value);
  assert.equal(value.values!.items[0].value, "000001"); assert.equal(value.values!.items[0].count, 2);
  assert.ok(value.values!.items.some(item => item.value === ""));
  const notes = response(raw, { values: { column: "Note", trim: false, offset: 0, limit: 100 } });
  assertCsvInspectionResponse(notes); assert.equal(notes.values!.items[0].value, long); assert.equal(notes.values!.items[0].lookup_compatible, false);
  assert.equal(notes.selected!.sample_rows[0].cells[1].truncated, true);
  const trimmed = response(raw, { values: { column: "Code", trim: true, offset: 0, limit: 100 } });
  assertCsvInspectionResponse(trimmed); assert.equal(trimmed.values!.items[0].count, 3);
  mutations(value, [v => { v.values!.items[0].lookup_compatible = false; }, v => { v.values!.items[0].formula_like = true; },
    v => { v.selected!.sample_rows[0].cells[1].truncated = false; }, v => { v.selected!.columns[0].samples[0].byte_length = 99; }]);
});

test("exact values pages and byte-budget-short pages accept valid continuation and terminal offsets", () => {
  const raw = ["Code", ...Array.from({ length: 205 }, (_, index) => String(index).padStart(6, "0")), "000001"].join("\n");
  for (const offset of [0, 100, 200, 205]) assertCsvInspectionResponse(response(raw, { values: { column: "Code", trim: false, offset, limit: 100 } }));
  const large = ["Code", ...Array.from({ length: 70 }, (_, index) => `${index}:` + "x".repeat(6000))].join("\n");
  const first = response(large, { values: { column: "Code", trim: false, offset: 0, limit: 100 } });
  assert.ok(first.values!.items.length < 70 && first.values!.next_offset !== null); assertCsvInspectionResponse(first);
  const rest = response(large, { values: { column: "Code", trim: false, offset: first.values!.next_offset!, limit: 100 } }); assertCsvInspectionResponse(rest);
});

test("missing or malformed nested items, unknown keys and changed parser limits reject with one safe error", () => {
  const original = response(normal, { values: { column: "Code", trim: false, offset: 0, limit: 100 } });
  for (const [parent, key] of [["context.accounts", "items"], ["context.listings", "items"], ["values", "items"], ["selected", "sample_rows"], ["selected", "columns"], ["selected", "row_errors"]]) {
    for (const wrong of [undefined, null, {}, "not-an-array"]) {
      const value = structuredClone(original) as unknown as Record<string, unknown>;
      let node = value;
      for (const part of parent.split(".")) node = node[part] as Record<string, unknown>;
      node[key] = wrong; rejects(value);
    }
  }
  for (const parent of ["", "context", "context.accounts", "selected", "values", "limits", "candidates.0", "candidates.0.dialect", "selected.sample_rows.0.cells.0", "values.items.0"]) {
    const value = structuredClone(original) as unknown as Record<string, unknown>;
    let node = value;
    for (const part of parent ? parent.split(".") : []) node = node[part] as Record<string, unknown>;
    node.unrecognized = true; rejects(value);
  }
  mutations(original, [v => { v.parser_version = "unknown-parser"; }, v => { v.limits.values_page = 1000; }, v => { v.ledger_revision = Number.NaN; },
    v => { v.byte_length = Number.POSITIVE_INFINITY; }, v => { v.context.listings.items[0].name = "x".repeat(2 * 1024 * 1024); }]);
  rejects(null); rejects([]); rejects({}); const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; rejects(cyclic);
});

test("candidate and selected metadata must agree; malformed header, error and location evidence cannot appear valid", () => {
  mutations(response(), [v => { v.candidates[0].valid = false; }, v => { v.selected!.dialect = { ...v.selected!.dialect, delimiter: ";" }; },
    v => { v.selected!.column_count++; }, v => { v.selected!.headers.push("extra"); }, v => { v.selected!.columns[0].index = 0; },
    v => { v.selected!.columns[0].header = "other"; }, v => { v.selected!.header_location = null; },
    v => { v.selected!.sample_rows[0].byte_end = v.byte_length + 1; }, v => { v.selected!.sample_rows[0].line_end = 0; },
    v => { v.selected!.sample_rows[0].record_number = 1; }, v => { v.selected!.sample_rows.pop(); },
    v => { v.selected!.columns[0].distinct_count = 10000; }, v => { v.selected!.columns[0].samples[1].record_number = 2; },
    v => { v.selected!.sample_rows[0].cells[0].value = "中".repeat(200); }, v => { v.bom = true; }]);
  const invalid = response("a,b\nx\ny");
  mutations(invalid, [v => { v.selected!.row_errors_truncated = true; }, v => { v.selected!.row_errors = []; },
    v => { v.selected!.row_errors[0].errors = []; }, v => { v.selected!.row_errors[1].record_number = v.selected!.row_errors[0].record_number; }]);
  const automatic = response(normal, { dialect: "auto" });
  mutations(automatic, [v => { v.candidates.pop(); }, v => { v.candidates[1].dialect.delimiter = ","; },
    v => { v.values = response(normal, { values: { column: "Code", trim: false, offset: 0, limit: 100 } }).values; }]);
});

test("values pagination, distinct keys, counts, ordering and trim flags cannot contradict the full-file inspection", () => {
  const original = response(normal, { values: { column: "Code", trim: false, offset: 0, limit: 100 } });
  mutations(original, [v => { v.values!.limit = 0; }, v => { v.values!.limit = 101; }, v => { v.values!.column = "absent"; },
    v => { v.values!.offset = 3; }, v => { v.values!.offset = 0.5; }, v => { v.values!.total = 10000; },
    v => { v.selected!.columns[0].distinct_count = 3; v.selected!.columns[0].samples.push({ ...v.selected!.columns[0].samples[0], record_number: 4 }); },
    v => { v.values!.next_offset = 0; }, v => { v.values!.next_offset = 1; }, v => { v.values!.items = []; },
    v => { v.values!.items[1].value = v.values!.items[0].value; }, v => { v.values!.items[0].count = 0; },
    v => { v.values!.items[0].count = 10000; }, v => { v.values!.items[0].count = 1; },
    v => { v.values!.items[0].first_record_number = 1; }, v => { v.values!.items[1].first_record_number = 2; },
    v => { v.values!.trim = true; v.values!.items[0].value = " 000001"; }]);
});

test("context scope, unique IDs, declared truncation and byte budgets are validated without requiring truncated IDs to be present", () => {
  mutations(response(), [v => { v.context.accounts.items[0].portfolio_id = "other"; }, v => { v.context.accounts.items[0].id = "other"; },
    v => { v.context.accounts.items.push(v.context.accounts.items[0]); v.context.accounts.total = 2; },
    v => { v.context.listings.items.push(v.context.listings.items[0]); v.context.listings.total = 2; },
    v => { v.context.listings.truncated = true; }, v => { v.context.accounts.total = 0; }, v => { v.context.listings.limit = 999; },
    v => { v.context.listings.items[0].name = "中".repeat(100000); }]);
  const truncated = response(); truncated.context.accounts.items = []; truncated.context.accounts.truncated = true;
  truncated.context.listings.items = []; truncated.context.listings.total = 1002; truncated.context.listings.truncated = true;
  assertCsvInspectionResponse(truncated);
});

test("real inspectCsvImport DB response remains read-only, including context byte truncation", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "csv-response-contract-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename); const db = openWorkbench(filename), now = "2026-01-01T00:00:00Z";
  try {
    db.prepare("INSERT INTO portfolios(id,name,created_at) VALUES('p','Synthetic',?)").run(now);
    db.prepare("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('a','p','Synthetic','Synthetic','CNY',?)").run(now);
    db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('i','Synthetic instrument',?)").run(now);
    db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('l','i','CN','SYN','000001','CNY',?)").run(now);
    const input = { portfolio_id: "p", account_id: "a", expected_revision: 0, dialect, filename: "synthetic.csv", bytes: Buffer.from(normal) };
    const changes = db.prepare("SELECT total_changes() n").get();
    assertCsvInspectionResponse(inspectCsvImport(db, input));
    assertCsvInspectionResponse(inspectCsvImport(db, { ...input, dialect: "auto" }));
    assertCsvInspectionResponse(inspectCsvImport(db, { ...input, bytes: Buffer.alloc(0) }));
    assert.deepEqual(db.prepare("SELECT total_changes() n").get(), changes);
    db.prepare("UPDATE instruments SET name=? WHERE id='i'").run("x".repeat(300000));
    const bounded = inspectCsvImport(db, input); assert.equal(bounded.context.listings.items.length, 0); assertCsvInspectionResponse(bounded);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("response validator imports only browser-safe runtime dependencies", () => {
  const source = readFileSync(path.resolve("src/components/workbench/csv-inspection-response.ts"), "utf8");
  assert.deepEqual([...source.matchAll(/^import (?!type )[^\n]*from "([^"]+)"/gm)].map(match => match[1]), ["zod"]);
  assert.doesNotMatch(source, /node:|server-only|\bBuffer\b|require\s*\(|import\s*\(/);
});
