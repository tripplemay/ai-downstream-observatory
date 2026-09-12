import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { parseCsvBytes, type CsvDialect } from "../src/server/ledger/csv";
import { CSV_INSPECTION_LIMITS, inspectCsvBytes, inspectCsvImport } from "../src/server/ledger/csv-inspection";
import type { CsvInspectionUpload } from "../src/server/ledger/csv-inspection-upload";
import type { CsvInspectionValues } from "../src/server/ledger/csv-inspection-types";

const dialect: CsvDialect = { encoding: "utf-8", delimiter: ",", record_separator: "either" };
const input = (bytes = Buffer.from("Code,Amount\n000001,12.30\n")): CsvInspectionUpload => ({ portfolio_id: "p", account_id: "a", expected_revision: 0, dialect, filename: "synthetic.csv", bytes });
const location = ({ record_number, line_start, line_end, byte_start, byte_end }: { record_number: number; line_start: number; line_end: number; byte_start: number; byte_end: number }) => ({ record_number, line_start, line_end, byte_start, byte_end });

test("inspection uses the existing parser's full-file bytes, headers, quoting and exact row locations", () => {
  const bytes = Buffer.from('\ufeffCode,Note\r\n000001,"line 1\r\nline 2, \"\"quoted\"\""\r\n');
  const parsed = parseCsvBytes(bytes, dialect), result = inspectCsvBytes(bytes, dialect);
  assert.equal(result.content_hash, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.byte_length, bytes.length); assert.equal(result.bom, true); assert.equal(result.parser_version, parsed.parser_version);
  assert.deepEqual(result.selected!.headers, parsed.headers); assert.deepEqual(result.selected!.header_location, location(parsed.header!));
  assert.deepEqual(result.selected!.sample_rows[0].cells.map(cell => cell.value), parsed.rows[0].cells);
  assert.deepEqual(location(result.selected!.sample_rows[0]), location(parsed.rows[0]));
  assert.equal(result.selected!.sample_rows[0].line_end, 3); assert.equal(result.selected!.valid, true);
});

test("auto only returns three syntax candidates and never silently chooses an ambiguous or single-column dialect", () => {
  for (const bytes of [Buffer.from("Code\n000001\n"), Buffer.from('Code;Note\n000001;"has,comma"\n')]) {
    const result = inspectCsvBytes(bytes, "auto");
    assert.deepEqual(result.candidates.map(candidate => candidate.dialect.delimiter), [",", ";", "\t"]);
    assert.equal(result.selected, null); assert.equal(result.values, null);
    for (const candidate of result.candidates) assert.equal(candidate.valid, parseCsvBytes(bytes, candidate.dialect).valid);
  }
  assert.throws(() => inspectCsvBytes(Buffer.from("Code\n1"), "auto", { column: "Code", trim: false, offset: 0, limit: 10 }), /CSV_INSPECTION_FIELDS_INVALID/);
});

test("bad tail records, duplicate headers, malformed quoting and UTF8 are reported, never hidden by sampling", () => {
  const rows = Array.from({ length: 110 }, () => "x"), bytes = Buffer.from(["a,b", "ok,1", ...rows].join("\n"));
  const selected = inspectCsvBytes(bytes, dialect).selected!;
  assert.equal(selected.valid, false); assert.equal(selected.row_count, 111); assert.equal(selected.row_error_count, 110);
  assert.equal(selected.row_errors.length, 100); assert.equal(selected.row_errors_truncated, true);
  for (const [raw, code] of [["a,a\nx,y", "CSV_DUPLICATE_HEADER"], ["a\n\"never closed", "CSV_UNCLOSED_QUOTE"], ["a\n\u0000", "CSV_CONTROL_CHARACTER"]]) {
    assert.ok(inspectCsvBytes(Buffer.from(raw), dialect).selected!.document_errors.some(error => error.code === code));
  }
  assert.equal(inspectCsvBytes(Buffer.from([0xff]), dialect).selected!.document_errors[0].code, "CSV_INVALID_UTF8");
  assert.throws(() => inspectCsvBytes(bytes, dialect, { column: "a", trim: false, offset: 0, limit: 10 }), /CSV_INSPECTION_VALUES_UNAVAILABLE/);
  assert.throws(() => inspectCsvBytes(Buffer.alloc(CSV_INSPECTION_LIMITS.file_bytes + 1), dialect), /CSV_TOO_LARGE/);
});

test("samples are bounded Unicode text with truncation/formula markers, not lookup values", () => {
  const full = "=" + "中".repeat(300), bytes = Buffer.from(`Code,Note\n000001,${full}\n`);
  const result = inspectCsvBytes(bytes, dialect, { column: "Note", trim: false, offset: 0, limit: 100 });
  const cell = result.selected!.sample_rows[0].cells[1];
  assert.equal(cell.truncated, true); assert.equal(cell.byte_length, Buffer.byteLength(full)); assert.equal(cell.formula_like, true);
  assert.ok(Buffer.byteLength(cell.value) <= 256); assert.equal(cell.value.includes("\ufffd"), false);
  assert.equal(result.values!.items[0].value, full); assert.equal(result.values!.items[0].lookup_compatible, false);
  assert.equal(result.values!.items[0].formula_like, true); assert.equal(result.selected!.columns[0].samples[0].value, "000001");
});

test("complete lookup values page in original first-occurrence order with exact counts and explicit trim semantics", () => {
  const bytes = Buffer.from(["Code", ...Array.from({ length: 205 }, (_, i) => String(i).padStart(6, "0")), "000001"].join("\n"));
  const all: string[] = []; let offset: number | null = 0;
  while (offset !== null) {
    const page: CsvInspectionValues = inspectCsvBytes(bytes, dialect, { column: "Code", trim: false, offset, limit: 100 }).values!;
    assert.equal(page.total, 205); assert.ok(page.items.length <= 100); all.push(...page.items.map(row => row.value)); offset = page.next_offset;
    if (page.offset === 0) assert.deepEqual(page.items[1], { value: "000001", count: 2, first_record_number: 3, lookup_compatible: true, formula_like: false });
  }
  assert.equal(new Set(all).size, 205); assert.equal(all[204], "000204");
  const spaces = Buffer.from("Code\n 001\n001 \n002\n");
  assert.equal(inspectCsvBytes(spaces, dialect, { column: "Code", trim: false, offset: 0, limit: 100 }).values!.total, 3);
  const trimmed = inspectCsvBytes(spaces, dialect, { column: "Code", trim: true, offset: 0, limit: 100 }).values!;
  assert.equal(trimmed.total, 2); assert.equal(trimmed.items[0].count, 2); assert.equal(trimmed.items[0].value, "001");
  assert.throws(() => inspectCsvBytes(bytes, dialect, { column: "Nope", trim: false, offset: 0, limit: 100 }), /CSV_COLUMN_NOT_FOUND/);
  assert.throws(() => inspectCsvBytes(bytes, dialect, { column: "Code", trim: false, offset: 206, limit: 100 }), /CSV_INSPECTION_VALUES_INVALID/);
  assert.deepEqual(inspectCsvBytes(bytes, dialect, { column: "Code", trim: false, offset: 205, limit: 100 }).values!.items, []);
});

test("large exact lookup values obey a byte budget with a resumable offset, never partial strings", () => {
  const originals = Array.from({ length: 70 }, (_, i) => `${i}:` + "x".repeat(6000)), bytes = Buffer.from(["Code", ...originals].join("\n"));
  const first = inspectCsvBytes(bytes, dialect, { column: "Code", trim: false, offset: 0, limit: 100 }).values!;
  assert.ok(first.items.length > 0 && first.items.length < 70); assert.equal(first.next_offset, first.items.length);
  const rest = inspectCsvBytes(bytes, dialect, { column: "Code", trim: false, offset: first.next_offset!, limit: 100 }).values!;
  assert.deepEqual([...first.items, ...rest.items].map(row => row.value), originals); assert.equal(rest.next_offset, null);
});

function fixture(t: { after: (operation: () => void) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), "csv-inspection-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename); const db = openWorkbench(filename), now = "2026-01-01T00:00:00Z";
  for (const id of ["p", "q"]) db.prepare("INSERT INTO portfolios(id,name,created_at)VALUES(?,?,?)").run(id, "Synthetic", now);
  for (const [id, portfolio] of [["a", "p"], ["b", "q"]]) db.prepare("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at)VALUES(?,?,?,'Synthetic','CNY',?)").run(id, portfolio, "Synthetic", now);
  db.prepare("INSERT INTO instruments(id,name,created_at)VALUES('i','Synthetic ETF',?)").run(now);
  db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at)VALUES('l','i','CN','SYN','000001','CNY',?)").run(now);
  t.after(() => { if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, directory, filename, now };
}
function state(db: ReturnType<typeof openWorkbench>) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }));
}

test("account/portfolio scope and integer CAS guard inspection; success, parse error and failure cause zero DB or evidence writes", t => {
  const f = fixture(t), before = state(f.db), files = readdirSync(f.directory), changes = f.db.prepare("SELECT total_changes() n").get();
  const result = inspectCsvImport(f.db, input());
  assert.equal(result.state_written, false); assert.equal(result.broker_format_verified, false); assert.equal(result.ledger_revision, 0);
  assert.deepEqual(result.context.accounts.items.map(row => row.id), ["a"]); assert.deepEqual(result.context.listings.items.map(row => row.id), ["l"]);
  assert.equal(result.context.accounts.truncated, false); assert.equal(result.context.accounts.total, 1);
  assert.equal(inspectCsvImport(f.db, { ...input(), dialect: "auto" }).selected, null);
  assert.equal(inspectCsvImport(f.db, input(Buffer.from("a,a\nx,y"))).selected!.valid, false);
  for (const [patch, error] of [[{ account_id: "b" }, /ACCOUNT_OUT_OF_SCOPE/], [{ portfolio_id: "absent" }, /PORTFOLIO_NOT_FOUND/], [{ expected_revision: 1 }, /VERSION_CONFLICT/], [{ expected_revision: 0.1 }, /CSV_INSPECTION_FIELDS_INVALID/]] as const) assert.throws(() => inspectCsvImport(f.db, { ...input(), ...patch }), error);
  assert.deepEqual(state(f.db), before); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes); assert.deepEqual(readdirSync(f.directory), files);
});

test("inspection remains a read during RESTORE_PENDING_REVIEW and explicit read-only connections", t => {
  const f = fixture(t); f.db.close(); writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "synthetic pending review", { mode: 0o600 });
  const db = openWorkbench(f.filename);
  try {
    assert.equal(db.readonly, true); const before = state(db);
    assert.equal(inspectCsvImport(db, input()).selected!.valid, true); assert.deepEqual(state(db), before);
    assert.equal((db.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test("registered identity hints explicitly report count and byte truncation without returning other portfolio accounts", t => {
  const f = fixture(t);
  const insert = f.db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at)VALUES(?,'i','CN','SYN',?,'CNY',?)");
  f.db.transaction(() => { for (let i = 0; i < 1001; i++) insert.run(`l-${String(i).padStart(4, "0")}`, `T${i}`, f.now); })();
  const result = inspectCsvImport(f.db, input());
  assert.equal(result.context.listings.items.length, 1000); assert.equal(result.context.listings.total, 1002); assert.equal(result.context.listings.truncated, true);
  assert.deepEqual(result.context.accounts.items.map(row => row.id), ["a"]);
  f.db.prepare("UPDATE instruments SET name=? WHERE id='i'").run("x".repeat(300000));
  const bounded = inspectCsvImport(f.db, input());
  assert.equal(bounded.context.listings.items.length, 0); assert.equal(bounded.context.listings.truncated, true); assert.equal(bounded.context.listings.total, 1002);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= CSV_INSPECTION_LIMITS.response_bytes);
});
