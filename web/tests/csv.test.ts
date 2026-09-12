import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CSV_LIMITS, csvFormulaLike, parseCsvBytes, type CsvDialect } from "../src/server/ledger/csv";

const dialect: CsvDialect = { encoding: "utf-8", delimiter: ",", record_separator: "either" };
const parse = (value: string) => parseCsvBytes(Buffer.from(value), dialect);

test("CSV preserves BOM bytes, quoted commas/quotes/newlines and exact physical/byte row locations", () => {
  const bytes = Buffer.from('\ufeffcode,note,amount\r\n000001,"中文,""quote""\r\nnext",12.00\r\n000002,last,0');
  const result = parseCsvBytes(bytes, dialect);
  assert.equal(result.valid, true); assert.equal(result.bom, true); assert.equal(result.header!.byte_start, 3);
  assert.equal(result.content_hash, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(result.rows[0].cells, ["000001", '中文,"quote"\r\nnext', "12.00"]);
  assert.equal(result.rows[0].record_number, 2); assert.equal(result.rows[0].line_start, 2); assert.equal(result.rows[0].line_end, 3);
  assert.equal(bytes.subarray(result.rows[0].byte_start, result.rows[0].byte_end).toString(), '000001,"中文,""quote""\r\nnext",12.00');
  assert.equal(result.rows[1].line_start, 4); assert.equal(result.rows[1].byte_end, bytes.length);
});

test("CSV uses explicit delimiter/newline dialects and never guesses tab, locale or missing headers", () => {
  assert.equal(parseCsvBytes(Buffer.from("a;b\n1;2"), { ...dialect, delimiter: ";", record_separator: "lf" }).valid, true);
  assert.deepEqual(parseCsvBytes(Buffer.from("a\tb\r\n001\t2"), { ...dialect, delimiter: "\t", record_separator: "crlf" }).rows[0].cells, ["001", "2"]);
  assert.equal(parseCsvBytes(Buffer.from("a,b\n1,2"), { ...dialect, record_separator: "crlf" }).errors[0].code, "CSV_RECORD_SEPARATOR_MISMATCH");
  assert.equal(parseCsvBytes(Buffer.from("a,b\r\n1,2"), { ...dialect, record_separator: "lf" }).errors[0].code, "CSV_RECORD_SEPARATOR_MISMATCH");
  assert.equal(parse("a,b\r1,2").errors[0].code, "CSV_RECORD_SEPARATOR_MISMATCH");
  assert.equal(parse("a,b").errors[0].code, "CSV_NO_DATA_ROWS");
  assert.equal(parse("").errors[0].code, "CSV_EMPTY");
  assert.equal(parse("\ufeff").errors[0].code, "CSV_EMPTY");
  assert.throws(() => parseCsvBytes(Buffer.from("a\n1"), { ...dialect, encoding: "gb18030" } as unknown as CsvDialect), /CSV_DIALECT_INVALID/);
});

test("CSV rejects malformed quotes, duplicate/ambiguous headers, controls and wrong-width rows", () => {
  for (const [raw, code] of [['a,b\n"x,y', "CSV_UNCLOSED_QUOTE"], ['a,b\nx"y,z', "CSV_QUOTE_IN_UNQUOTED_FIELD"], ['a,b\n"x" ,y', "CSV_DATA_AFTER_CLOSING_QUOTE"], ['a,a\n1,2', "CSV_DUPLICATE_HEADER"], ['a, a \n1,2', "CSV_DUPLICATE_HEADER"], ['é,e\u0301\n1,2', "CSV_DUPLICATE_HEADER"], ['a,\n1,2', "CSV_INVALID_HEADER"], ['a,b\nx\u0000,y', "CSV_CONTROL_CHARACTER"]]) {
    const result = parse(raw); assert.equal(result.valid, false, raw); assert.ok(result.errors.some(error => error.code === code), raw);
  }
  const wrong = parse("a,b\n1,2,3\n4\n5,6\n\n7,8\n");
  assert.equal(wrong.rows.length, 5); assert.equal(wrong.rows[0].errors[0].code, "CSV_COLUMN_COUNT_MISMATCH");
  assert.equal(wrong.rows[1].errors[0].code, "CSV_COLUMN_COUNT_MISMATCH"); assert.equal(wrong.rows[2].errors.length, 0);
  assert.ok(wrong.rows[3].errors.some(error => error.code === "CSV_BLANK_RECORD")); assert.equal(wrong.rows[4].cells[0], "7");
  assert.equal(parse("a,b\n1,\n").valid, true);
});

test("CSV rejects malformed UTF-8 and binary encodings without lossy replacement", () => {
  for (const bytes of [Buffer.from([0xff, 0xfe, 0x61, 0]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82])]) {
    assert.equal(parseCsvBytes(bytes, dialect).errors[0].code, "CSV_INVALID_UTF8");
  }
  assert.equal(parseCsvBytes(Buffer.from("a\n1", "utf16le"), dialect).errors[0].code, "CSV_CONTROL_CHARACTER");
  assert.equal(parse("a\nreplacement�text").rows[0].cells[0], "replacement�text");
});

test("CSV hard limits stop oversized bytes, fields, records, columns and row counts", () => {
  assert.throws(() => parseCsvBytes(Buffer.alloc(CSV_LIMITS.bytes + 1, 65), dialect), /CSV_TOO_LARGE/);
  assert.ok(parse("a\n" + "x".repeat(CSV_LIMITS.field_bytes + 1)).errors.some(error => error.code === "CSV_FIELD_TOO_LARGE"));
  assert.ok(parse("h".repeat(CSV_LIMITS.header_bytes + 1) + "\n1").errors.some(error => error.code === "CSV_INVALID_HEADER"));
  const columns = Array.from({ length: CSV_LIMITS.columns + 1 }, (_, index) => `c${index}`).join(",");
  assert.ok(parse(columns + "\n1").errors.some(error => error.code === "CSV_TOO_MANY_COLUMNS"));
  const record = Array(8).fill("x".repeat(40000)).join(",");
  assert.ok(parse("a,b,c,d,e,f,g,h\n" + record).errors.some(error => error.code === "CSV_RECORD_TOO_LARGE"));
  assert.ok(parse("a\n" + "1\n".repeat(CSV_LIMITS.data_rows + 1)).errors.some(error => error.code === "CSV_TOO_MANY_ROWS"));
  const exact = parse("a\n" + "1\n".repeat(CSV_LIMITS.data_rows)); assert.equal(exact.valid, true); assert.equal(exact.rows.length, CSV_LIMITS.data_rows);
});

test("formula-like cells remain inert original text and are explicitly flagged, not evaluated", () => {
  const input = 'code,note,amount\n000001,"=HYPERLINK(""https://invalid.example"",""x"")",-1\n000002,+SUM(A1:A2),1';
  const result = parse(input); assert.equal(result.valid, true);
  assert.deepEqual(result.rows[0].formula_columns, [2, 3]); assert.equal(result.rows[1].cells[1], "+SUM(A1:A2)");
  assert.equal(csvFormulaLike(" \t@cmd"), true); assert.equal(csvFormulaLike("000001"), false);
});
