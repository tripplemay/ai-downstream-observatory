import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, recordFact, revision } from "../src/server/ledger/service";
import { inspectCsvImport } from "../src/server/ledger/csv-inspection";
import type { CsvInspectionResponse, CsvInspectionValues } from "../src/server/ledger/csv-inspection-types";
import { previewCsvImport } from "../src/server/ledger/csv-imports";
import { confirmImport, getImportPreview, type ImportPreview } from "../src/server/ledger/imports";
import { readCsvAttachment, readJsonAttachment } from "../src/server/ledger/attachments";
import type { CsvRowResolution } from "../src/server/ledger/csv-review";
import { compileCsvMappingDraft, createEmptyCsvMappingDraft, forkCsvMappingVersion,
  type CsvBinding, type CsvBuilderContext, type CsvMapping, type CsvMappingDraft } from "../src/components/workbench/csv-mapping-builder";

const now = "2026-09-12T00:00:00.000Z";
const dialect = { encoding: "utf-8", delimiter: ",", record_separator: "either" } as const;
const constant = (value: string): Extract<CsvBinding, { kind: "constant" }> => ({ kind: "constant", value });
const column = (name: string): Extract<CsvBinding, { kind: "column" }> => ({ kind: "column", column: name, trim: false, empty: "reject" });
const decimal = (name: string): Extract<CsvBinding, { kind: "decimal" }> => ({ kind: "decimal", column: name, empty: "reject", format: {
  decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false,
} });
const lookup = (name: string, entries: { input: string; value: string }[]): Extract<CsvBinding, { kind: "lookup" }> => ({ kind: "lookup", column: name, trim: false, entries });

function fixture(t: { after: (operation: () => void) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), "csv-wizard-flow-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "synthetic-owner" };
  const portfolio = createPortfolio(db, actor, "Synthetic wizard fixture");
  const account = createAccount(db, actor, portfolio, "Synthetic account", "Synthetic", "CNY");
  db.prepare("INSERT INTO instruments(id,name,created_at)VALUES('synthetic-instrument','Synthetic ETF',?)").run(now);
  db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at)VALUES('synthetic-listing','synthetic-instrument','CN','SYN','000001','CNY',?)").run(now);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const inspect = (bytes: Buffer, values?: { column: string; trim: boolean; offset: number; limit: number }) => inspectCsvImport(db, {
    portfolio_id: portfolio, account_id: account, expected_revision: revision(db, portfolio), dialect,
    bytes, filename: "synthetic-original.csv", ...(values ? { values } : {}),
  });
  const preview = (bytes: Buffer, mapping: CsvMapping) => previewCsvImport(db, actor, {
    portfolio_id: portfolio, account_id: account, expected_revision: revision(db, portfolio),
    bytes, filename: "synthetic-original.csv", mapping: JSON.stringify(mapping),
  }, { dataDir: directory, now });
  const review = (p: ImportPreview, rows: CsvRowResolution[] = []) => ({ acknowledge_unverified_mapping: true, review_hash: p.csv!.review_hash, rows });
  const confirm = (p: ImportPreview, input: unknown = review(p)) => confirmImport(db, actor, portfolio, p.id, p.preview_hash, p.expected_revision, now, { dataDir: directory }, input);
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  return { db, directory, actor, portfolio, account, inspect, preview, review, confirm, count };
}
function context(inspected: CsvInspectionResponse): CsvBuilderContext {
  assert.ok(inspected.selected?.valid);
  return { portfolio_id: inspected.portfolio_id, account_id: inspected.account_id, headers: inspected.selected.headers,
    accounts: inspected.context.accounts, listings: inspected.context.listings };
}
function draft(inspected: CsvInspectionResponse): CsvMappingDraft {
  const result = createEmptyCsvMappingDraft(inspected.account_id, inspected.selected!.headers);
  result.mapping_id = "SYNTHETIC-WIZARD"; result.title = "Synthetic manually verified generic mapping";
  result.dialect = inspected.selected!.dialect; result.source_id = "SYNTHETIC-SOURCE";
  result.source_event_id = inspected.selected!.headers.includes("Source") ? column("Source") : null;
  result.reason = inspected.selected!.headers.includes("Note") ? column("Note") : constant("Synthetic evidence");
  result.effective_at = { column: "Date", format: "YYYY-MM-DD", trim: false, source_timezone: "Asia/Shanghai" };
  result.event_type = constant("deposit");
  result.rules = [{ event_type: "deposit", fields: { currency: constant("CNY"), amount: decimal("Amount") } }];
  return result;
}
function compile(value: CsvMappingDraft, inspected: CsvInspectionResponse, previous?: CsvMapping): CsvMapping {
  const result = compileCsvMappingDraft(value, context(inspected), previous);
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.warnings.includes("CSV_SERVER_PREVIEW_REQUIRED"));
  assert.ok(result.warnings.includes("CSV_BROKER_FORMAT_UNVERIFIED"));
  return result.mapping;
}
function allTables(db: ReturnType<typeof openWorkbench>) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }));
}

test("real inspector and builder use complete exact lookup pages without persisting samples or changing ledger state", t => {
  const f = fixture(t), codes = [...Array.from({ length: 204 }, (_, i) => String(i).padStart(6, "0")), "0"];
  const bytes = Buffer.from("\ufeffDate,Code,Amount,Source\r\n" + codes.map((code, i) => `2026-01-02,${code},${i + 1},S${i}`).join("\r\n") + "\r\n");
  const before = allTables(f.db), files = readdirSync(f.directory), changes = f.db.prepare("SELECT total_changes() n").get();
  const inspected = f.inspect(bytes), entries: { input: string; value: string }[] = [];
  assert.equal(inspected.state_written, false); assert.equal(inspected.selected!.columns[1].samples.length, 3);
  assert.equal(inspected.selected!.columns[1].distinct_count, 205);
  let offset: number | null = 0;
  while (offset !== null) {
    const page: CsvInspectionValues = f.inspect(bytes, { column: "Code", trim: false, offset, limit: 100 }).values!;
    assert.equal(page.total, 205); entries.push(...page.items.map(item => ({ input: item.value, value: item.value === "0" ? "USD" : "CNY" }))); offset = page.next_offset;
  }
  assert.deepEqual(entries.map(entry => entry.input), codes);
  assert.deepEqual(allTables(f.db), before); assert.deepEqual(readdirSync(f.directory), files);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
  const value = draft(inspected); value.rules[0].fields.currency = lookup("Code", entries);
  const mapping = compile(value, inspected), p = f.preview(bytes, mapping);
  assert.equal(p.status, "preview"); assert.equal(p.rows.length, 205); assert.equal(p.csv!.content_hash, inspected.content_hash);
  assert.equal(p.rows.at(-1)!.command!.fact.amount, "205"); assert.equal(p.rows.at(-1)!.command!.fact.currency, "USD");
  assert.equal(p.rows[0].command!.fact.currency, "CNY");
  assert.deepEqual(p.rows.map(row => row.source!.cells[1]), codes);
  assert.equal(f.count("ledger_events"), 0); assert.equal(revision(f.db, f.portfolio), 0);
});

test("missing fee or tax is rejected by both visual builder and real server, never silently replaced with zero", t => {
  for (const [type, field, code] of [["buy", "fee", "CSV_EXPLICIT_FEE_REQUIRED"], ["dividend", "tax", "CSV_EXPLICIT_TAX_REQUIRED"]] as const) {
    const f = fixture(t), bytes = Buffer.from("Date,Source\n2026-01-02,SYNTHETIC-1\n"), inspected = f.inspect(bytes), value = draft(inspected);
    value.event_type = constant(type);
    value.rules = [{ event_type: type, fields: type === "buy"
      ? { currency: constant("CNY"), listing_id: constant("synthetic-listing"), quantity: constant("1"), price: constant("2") }
      : { currency: constant("CNY"), amount: constant("2") } }];
    const missing = compileCsvMappingDraft(value, context(inspected));
    assert.equal(missing.ok, false); if (!missing.ok) assert.ok(missing.errors.some(error => error.code === code));
    const p = f.preview(bytes, value as CsvMapping);
    assert.equal(p.status, "invalid"); assert.ok(p.csv!.document_errors.some(error => error.code === code));
    assert.throws(() => f.confirm(p), /IMPORT_HAS_ERRORS/);
    assert.equal(field in value.rules[0].fields, false); assert.equal(f.count("ledger_events"), 0);
    const fixed = forkCsvMappingVersion(value as CsvMapping); fixed.rules[0].fields[field] = constant("0");
    const explicit = compile(fixed, inspected, value as CsvMapping);
    assert.deepEqual(explicit.rules[0].fields[field], constant("0"));
    if (type === "dividend") {
      const final = f.preview(bytes, explicit);
      assert.equal(final.status, "preview"); assert.equal(final.rows[0].command!.fact.tax, "0");
      assert.equal(f.confirm(final).revision, 1);
    }
  }
});

test("an unmapped tail value seals an invalid preview version; explicit version fork fixes it without overwriting evidence", t => {
  const f = fixture(t), codes = ["000001", "1", "000003", "000004", "000005", "000006"];
  const bytes = Buffer.from("Date,Code,Amount,Source\n" + codes.map((code, i) => `2026-01-02,${code},${i + 1},S${i}`).join("\n"));
  const inspected = f.inspect(bytes, { column: "Code", trim: false, offset: 0, limit: 100 }), value = draft(inspected);
  value.rules[0].fields.currency = lookup("Code", codes.slice(0, 5).map(input => ({ input, value: "CNY" })));
  const initial = compile(value, inspected), invalid = f.preview(bytes, initial);
  assert.equal(invalid.status, "invalid"); assert.ok(invalid.rows[5].errors.includes("CSV_VALUE_NOT_MAPPED"));
  assert.equal(f.count("csv_mapping_versions"), 1); assert.throws(() => f.confirm(invalid), /IMPORT_HAS_ERRORS/);
  const corrected = structuredClone(initial);
  corrected.rules[0].fields.currency = lookup("Code", inspected.values!.items.map(item => ({ input: item.value, value: "CNY" })));
  const local = compileCsvMappingDraft(corrected, context(inspected), initial);
  assert.equal(local.ok, false); if (!local.ok) assert.ok(local.errors.some(error => error.code === "CSV_MAPPING_NEW_VERSION_REQUIRED"));
  assert.throws(() => f.preview(bytes, corrected), /CSV_MAPPING_VERSION_CONFLICT/);
  const fixed = compile(forkCsvMappingVersion(corrected), inspected, initial), p = f.preview(bytes, fixed);
  assert.equal(p.status, "preview"); assert.notEqual(p.id, invalid.id); assert.equal(p.csv!.mapping_version, 2);
  assert.equal(p.csv!.content_hash, invalid.csv!.content_hash); assert.notEqual(p.csv!.mapping_hash, invalid.csv!.mapping_hash);
  assert.equal(getImportPreview(f.db, f.actor, f.portfolio, invalid.id).status, "invalid");
  assert.equal(f.count("csv_mapping_versions"), 2); assert.equal(f.count("ledger_events"), 0);
  assert.equal(f.confirm(p).revision, 6); assert.equal(f.count("ledger_events"), 6);
  assert.deepEqual(JSON.parse(readJsonAttachment(f.db, f.actor, f.portfolio, invalid.csv!.mapping_attachment_id, { dataDir: f.directory, accountId: f.account }).bytes.toString()), initial);
});

test("wizard-generated missing-source rows require explicit review and an exact prior link before one economic fact is recorded", t => {
  const f = fixture(t), amount = "10.123456789012345678";
  const bytes = Buffer.from(`Date,Amount,Note\n2026-01-02,${amount},First copy\n2026-01-02,${amount},Second copy\n`);
  const inspected = f.inspect(bytes), mapping = compile(draft(inspected), inspected), p = f.preview(bytes, mapping);
  assert.equal(mapping.source_event_id, null); assert.deepEqual(p.csv!.required_review_rows, [1, 2]);
  assert.deepEqual(p.csv!.candidates[1].exact_prior_rows, [1]);
  assert.throws(() => confirmImport(f.db, f.actor, f.portfolio, p.id, p.preview_hash, p.expected_revision, now, { dataDir: f.directory }), /CSV_REVIEW_INVALID/);
  assert.throws(() => f.confirm(p, undefined), /CSV_REVIEW_ROWS_MISMATCH/);
  assert.throws(() => f.confirm(p, { acknowledge_unverified_mapping: false, review_hash: p.csv!.review_hash, rows: [] }), /CSV_REVIEW_INVALID/);
  assert.equal(f.count("ledger_events"), 0);
  const review = f.review(p, [
    { row: 1, action: "record_distinct", reason: "Synthetic original occurrence explicitly checked" },
    { row: 2, action: "link_prior_row", prior_row: 1, reason: "Synthetic duplicate of that same occurrence" },
  ]);
  const result = f.confirm(p, review);
  assert.equal(result.revision, 1); assert.equal(result.receipts.length, 2); assert.equal(result.receipts[0].event_id, result.receipts[1].event_id);
  assert.equal(result.receipts[1].duplicate, true); assert.equal(f.count("ledger_events"), 1); assert.equal(f.count("csv_import_outcomes"), 2);
  assert.equal((f.db.prepare("SELECT balance FROM account_projections WHERE account_id=? AND ledger_account='cash_settled'").get(f.account) as { balance: string }).balance, amount);
  assert.deepEqual(f.confirm(p, review), { ...result, duplicate: true }); assert.equal(f.count("ledger_events"), 1);
});

test("registered listing lookup, explicit fee, original CSV bytes, multiline locations and mapping remain traceable after confirmation", t => {
  const f = fixture(t);
  recordFact(f.db, f.actor, { portfolio_id: f.portfolio, expected_revision: 0, idempotency_key: "synthetic-funding", source_id: "synthetic-funding",
    effective_at: "2026-01-01", time_precision: "date", source_timezone: "Asia/Shanghai", reason: "Synthetic seed only",
    fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: "100" } }, now);
  const rawRow = '2026-01-02,000001,4,2,0.25,SYNTHETIC-BUY,"=literal text\r\nsecond line"';
  const bytes = Buffer.from("\ufeffDate,Code,Quantity,Price,Fee,Source,Note\r\n" + rawRow + "\r\n");
  const inspected = f.inspect(bytes, { column: "Code", trim: false, offset: 0, limit: 100 }), value = draft(inspected);
  assert.deepEqual(inspected.values!.items.map(item => item.value), ["000001"]);
  assert.equal(inspected.context.listings.items[0].id, "synthetic-listing");
  value.event_type = constant("buy"); value.rules = [{ event_type: "buy", fields: {
    currency: constant("CNY"), listing_id: lookup("Code", [{ input: inspected.values!.items[0].value, value: inspected.context.listings.items[0].id }]),
    quantity: decimal("Quantity"), price: decimal("Price"), fee: decimal("Fee"),
  } }];
  const mapping = compile(value, inspected), p = f.preview(bytes, mapping), row = p.rows[0];
  assert.equal(p.status, "preview"); assert.equal(p.expected_revision, 1); assert.equal(row.command!.fact.listing_id, "synthetic-listing");
  assert.equal(row.command!.fact.fee, "0.25"); assert.equal(row.command!.reason, "=literal text\r\nsecond line");
  assert.equal(row.source!.line_start, 2); assert.equal(row.source!.line_end, 3);
  assert.equal(bytes.subarray(row.source!.byte_start, row.source!.byte_end).toString(), rawRow);
  assert.equal(p.csv!.content_hash, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(p.csv!.content_hash, inspected.content_hash); assert.equal(f.count("ledger_events"), 1);
  const result = f.confirm(p); assert.equal(result.revision, 2);
  const event = f.db.prepare("SELECT import_batch_id,payload_json FROM ledger_events WHERE id=?").get(result.receipts[0].event_id) as { import_batch_id: string; payload_json: string };
  assert.equal(event.import_batch_id, p.id); assert.equal(JSON.parse(event.payload_json).fact.fee, "0.25");
  const position = f.db.prepare("SELECT quantity,cost_amount FROM position_projections WHERE account_id=? AND listing_id='synthetic-listing'").get(f.account);
  assert.deepEqual(position, { quantity: "4", cost_amount: "8" });
  assert.equal((f.db.prepare("SELECT amount FROM postings WHERE event_id=? AND ledger_account='expense'").get(result.receipts[0].event_id) as { amount: string }).amount, "0.25");
  const attachmentOptions = { dataDir: f.directory, accountId: f.account };
  assert.deepEqual(readCsvAttachment(f.db, f.actor, f.portfolio, p.attachment_id, attachmentOptions).bytes, bytes);
  assert.deepEqual(JSON.parse(readJsonAttachment(f.db, f.actor, f.portfolio, p.csv!.mapping_attachment_id, attachmentOptions).bytes.toString()), mapping);
  assert.equal(getImportPreview(f.db, f.actor, f.portfolio, p.id).status, "confirmed");
  assert.deepEqual(f.confirm(p), { ...result, duplicate: true }); assert.equal(f.count("ledger_events"), 2);
});
