import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, revision, recordFact, hash, canonical } from "../src/server/ledger/service";
import { previewJsonImport, confirmImport, getImportPreview, type ImportPreview } from "../src/server/ledger/imports";
import { previewCsvImport } from "../src/server/ledger/csv-imports";
import { readCsvAttachment, readJsonAttachment } from "../src/server/ledger/attachments";
import type { CsvMapping } from "../src/server/ledger/csv-mapping";
import type { CsvRowResolution } from "../src/server/ledger/csv-review";

const now = "2026-09-12T00:00:00.000Z";
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "csv-import-")), filename = path.join(dir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "owner" };
  const portfolio = createPortfolio(db, actor, "Synthetic CSV"), account = createAccount(db, actor, portfolio, "A", "Synthetic", "CNY");
  const mapping = (missingSource = false): CsvMapping => ({
    schema_version: "csv-import-mapping-v1", mapping_id: "SYNTHETIC-DEPOSIT", version: 1, title: "Synthetic only",
    dialect: { encoding: "utf-8", delimiter: ",", record_separator: "either" }, expected_headers: ["date", "amount", "id", "note"], ignored_columns: missingSource ? ["id"] : [],
    account: { kind: "constant", value: account }, event_type: { kind: "constant", value: "deposit" }, source_id: "synthetic",
    source_event_id: missingSource ? null : { kind: "column", column: "id", trim: false, empty: "reject" },
    reason: { kind: "column", column: "note", trim: false, empty: "reject" }, effective_at: { column: "date", format: "YYYY-MM-DD", trim: false, source_timezone: "Asia/Shanghai" },
    rules: [{ event_type: "deposit", fields: { currency: { kind: "constant", value: "CNY" }, amount: { kind: "decimal", column: "amount", empty: "reject", format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false } } } }],
  });
  const csv = (rows = ["2026-01-01,100,s1,Initial"]) => Buffer.from("\ufeffdate,amount,id,note\r\n" + rows.join("\r\n") + "\r\n");
  const preview = (bytes = csv(), map = mapping(), name = "synthetic.csv") => previewCsvImport(db, actor, { portfolio_id: portfolio, account_id: account, expected_revision: revision(db, portfolio), mapping: JSON.stringify(map), filename: name, bytes }, { dataDir: dir, now });
  const review = (p: ImportPreview, rows: CsvRowResolution[] = []) => ({ acknowledge_unverified_mapping: true, review_hash: p.csv!.review_hash, rows });
  const confirm = (p: ImportPreview, input: unknown = review(p)) => confirmImport(db, actor, portfolio, p.id, p.preview_hash, p.expected_revision, now, { dataDir: dir }, input);
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  return { dir, db, actor, portfolio, account, mapping, csv, preview, review, confirm, count, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("CSV raw bytes, mapping and row locations survive atomic preview/confirmation and exact retry", () => {
  const f = fixture();
  try {
    const bytes = f.csv(['2026-01-01,100.123456789012345678,s1,"Line one\r\n中文"', "2026-01-02,50,s2,Second"]), p = f.preview(bytes);
    assert.equal(p.status, "preview"); assert.equal(p.parser_version, "csv-v1"); assert.equal(p.rows.length, 2);
    assert.equal(p.rows[0].source!.line_start, 2); assert.equal(p.rows[0].source!.line_end, 3); assert.equal(p.rows[1].source!.line_start, 4);
    assert.equal(p.rows[0].command!.fact.amount, "100.123456789012345678");
    assert.equal(p.csv!.content_hash, createHash("sha256").update(bytes).digest("hex"));
    assert.equal("context" in p.csv!, false);
    assert.deepEqual(readCsvAttachment(f.db, f.actor, f.portfolio, p.attachment_id, { dataDir: f.dir, accountId: f.account }).bytes, bytes);
    assert.deepEqual(JSON.parse(readJsonAttachment(f.db, f.actor, f.portfolio, p.csv!.mapping_attachment_id, { dataDir: f.dir, accountId: f.account }).bytes.toString()), f.mapping());
    assert.equal(f.count("ledger_events"), 0); assert.equal(revision(f.db, f.portfolio), 0);
    assert.equal(f.preview(bytes).id, p.id);
    assert.throws(() => confirmImport(f.db, f.actor, f.portfolio, p.id, p.preview_hash, 0, now, { dataDir: f.dir }), /CSV_REVIEW_INVALID/);
    const result = f.confirm(p, f.review(p));
    assert.equal(result.revision, 2); assert.equal(f.count("csv_import_outcomes"), 2);
    assert.equal((f.db.prepare("SELECT balance FROM account_projections WHERE ledger_account='cash_settled'").get() as { balance: string }).balance, "150.123456789012345678");
    assert.deepEqual(f.confirm(p), { ...result, duplicate: true });
    assert.equal(f.preview(bytes).id, p.id);
    assert.equal(f.count("ledger_events"), 2);
    assert.throws(() => confirmImport(f.db, f.actor, f.portfolio, p.id, "wrong", 0, now, { dataDir: f.dir }, f.review(p)), /PREVIEW_HASH_MISMATCH/);
  } finally { f.close(); }
});

test("missing IDs and cross-source candidates require explicit per-row dispositions; prior links never book twice", () => {
  const f = fixture();
  try {
    const p = f.preview(f.csv(["2026-01-01,100,,A", "2026-01-01,100,,B"]), f.mapping(true));
    assert.deepEqual(p.csv!.required_review_rows, [1, 2]);
    assert.throws(() => f.confirm(p), /CSV_REVIEW_ROWS_MISMATCH/);
    assert.throws(() => f.confirm(p, f.review(p, [{ row: 1, action: "record_distinct", reason: "Verified first" }, { row: 2, action: "link_existing", event_id: "foreign", reason: "Not valid" }])), /CSV_REVIEW_LINK_NOT_EXACT/);
    const review = f.review(p, [{ row: 1, action: "record_distinct", reason: "Verified first" }, { row: 2, action: "link_prior_row", prior_row: 1, reason: "Same occurrence" }]);
    const result = f.confirm(p, review);
    assert.equal(result.revision, 1); assert.equal(result.receipts[0].event_id, result.receipts[1].event_id); assert.equal(result.receipts[1].duplicate, true);
    assert.equal(f.confirm(p, review).duplicate, true);
    assert.throws(() => f.confirm(p, f.review(p, [{ row: 1, action: "record_distinct", reason: "Changed reason" }, { row: 2, action: "link_prior_row", prior_row: 1, reason: "Same occurrence" }])), /CSV_REVIEW_CONFLICT/);
    const p2 = f.preview(f.csv(["2026-01-01,100,,Next export"]), f.mapping(true));
    assert.deepEqual(p2.csv!.candidates[0].exact_event_ids, [result.receipts[0].event_id]);
    assert.equal(f.confirm(p2, f.review(p2, [{ row: 1, action: "link_existing", event_id: result.receipts[0].event_id, reason: "Verified overlap" }])).revision, 1);
    assert.equal(f.count("ledger_events"), 1);
  } finally { f.close(); }
});

test("trusted source dedup across JSON/CSV retains each row association; conflicting source contents block the whole file", () => {
  const f = fixture();
  try {
    const first = f.preview(), command = first.rows[0].command!;
    const jp = previewJsonImport(f.db, f.actor, f.portfolio, f.account, JSON.stringify([command]), now, { dataDir: f.dir });
    const jr = confirmImport(f.db, f.actor, f.portfolio, jp.id, jp.preview_hash, jp.expected_revision, now, { dataDir: f.dir });
    assert.throws(() => f.confirm(first), /VERSION_CONFLICT/);
    const p = f.preview(); assert.equal(p.rows[0].outcome!.kind, "already_recorded"); assert.deepEqual(p.csv!.required_review_rows, []);
    const r = f.confirm(p); assert.equal(r.revision, 1); assert.equal(r.receipts[0].event_id, jr.receipts[0].event_id);
    assert.equal((f.db.prepare("SELECT import_batch_id FROM ledger_events WHERE id=?").get(r.receipts[0].event_id) as { import_batch_id: string }).import_batch_id, jp.id);
    assert.equal((f.db.prepare("SELECT batch_id FROM csv_import_outcomes").get() as { batch_id: string }).batch_id, p.id);
    assert.equal(f.confirm(p).duplicate, true);
    const bad = f.preview(f.csv(["2026-01-01,101,s1,Conflicting original"]));
    assert.equal(bad.status, "invalid"); assert.ok(bad.rows[0].errors.includes("SOURCE_DUPLICATE_CONFLICT"));
    assert.throws(() => f.confirm(bad), /IMPORT_HAS_ERRORS/); assert.equal(f.count("ledger_events"), 1);
  } finally { f.close(); }
});

test("mapping versions are immutable; a confirmed raw CSV cannot acquire a new monetary interpretation", () => {
  const f = fixture();
  try {
    const p = f.preview(), changed = f.mapping(); changed.title = "changed";
    assert.throws(() => f.preview(f.csv(), changed), /CSV_MAPPING_VERSION_CONFLICT/);
    changed.version = 2;
    const p2 = f.preview(f.csv(), changed);
    assert.notEqual(p.id, p2.id); assert.notEqual(p.csv!.mapping_hash, p2.csv!.mapping_hash);
    f.confirm(p);
    assert.throws(() => f.preview(f.csv(), changed), /CSV_FILE_ALREADY_CONFIRMED/);
    assert.throws(() => f.confirm(p2), /VERSION_CONFLICT|CSV_FILE_ALREADY_CONFIRMED/);
    assert.throws(() => f.db.prepare("UPDATE csv_mapping_versions SET version=3").run(), /append-only/);
    assert.equal(f.count("ledger_events"), 1);
  } finally { f.close(); }
});

test("invalid rows and parser errors retain full evidence but prohibit a silently accepted subset", () => {
  const f = fixture();
  try {
    const p = f.preview(f.csv(["2026-01-01,100,s1,Valid", "2026-01-01,-1,s2,Invalid"]));
    assert.equal(p.status, "invalid"); assert.equal(p.rows.length, 2); assert.ok(p.rows[1].errors.length);
    assert.throws(() => f.confirm(p), /IMPORT_HAS_ERRORS/);
    const malformed = f.preview(f.csv(['2026-01-01,100,s1,"open quote']));
    assert.equal(malformed.status, "invalid"); assert.ok(malformed.csv!.document_errors.length);
    assert.throws(() => f.confirm(malformed), /IMPORT_HAS_ERRORS/);
    assert.equal(f.count("ledger_events"), 0);
  } finally { f.close(); }
});

test("frozen rows/manifests and confirmation coverage reject incomplete or contradictory DB writes", () => {
  const f = fixture();
  try {
    const p = f.preview();
    assert.throws(() => f.db.prepare("UPDATE import_rows SET normalized_json='{}' WHERE batch_id=?").run(p.id), /frozen/);
    assert.throws(() => f.db.prepare("DELETE FROM import_rows WHERE batch_id=?").run(p.id), /frozen/);
    assert.throws(() => f.db.prepare("UPDATE csv_import_manifests SET content_hash=? WHERE batch_id=?").run("a".repeat(64), p.id), /append-only/);
    assert.throws(() => f.db.prepare("UPDATE import_batches SET status='confirmed' WHERE id=?").run(p.id), /incomplete/);
    assert.throws(() => f.db.prepare("UPDATE import_batches SET confirmed_at=? WHERE id=?").run(now, p.id), /confirmed state/);
    assert.throws(() => f.db.prepare("UPDATE import_batches SET mapping_version='other' WHERE id=?").run(p.id), /frozen/);
    f.confirm(p);
    assert.throws(() => f.db.prepare("UPDATE csv_import_outcomes SET duplicate=1 WHERE batch_id=?").run(p.id), /append-only/);
    assert.throws(() => f.db.prepare("INSERT INTO csv_import_outcomes SELECT * FROM csv_import_outcomes WHERE batch_id=?").run(p.id), /scope mismatch/);
    assert.throws(() => f.db.prepare("UPDATE import_batches SET confirmed_revision=999 WHERE id=?").run(p.id), /immutable/);
  } finally { f.close(); }
});

test("attachment tampering fails closed on both first confirmation and confirmed retry", () => {
  for (const confirmed of [false, true]) {
    const f = fixture();
    try {
      const p = f.preview(); if (confirmed) f.confirm(p);
      writeFileSync(path.join(f.dir, "attachments", `${p.csv!.content_hash}.csv`), f.csv().toString().replace("100", "999"));
      assert.throws(() => f.confirm(p), /ATTACHMENT_HASH_MISMATCH/);
      assert.equal(f.count("ledger_events"), Number(confirmed));
    } finally { f.close(); }
  }
});

test("failed mid-batch confirmation rolls back events, outcomes and audits and retries the same evidence", () => {
  const f = fixture();
  try {
    const p = f.preview(f.csv(["2026-01-01,100,s1,First", "2026-01-02,50,s2,Second"]));
    f.db.exec("CREATE TRIGGER csv_test_fail BEFORE INSERT ON csv_import_outcomes WHEN NEW.row_number=2 BEGIN SELECT RAISE(ABORT,'test failure'); END");
    assert.throws(() => f.confirm(p), /test failure/);
    assert.equal(f.count("ledger_events"), 0); assert.equal(f.count("csv_import_outcomes"), 0); assert.equal(revision(f.db, f.portfolio), 0);
    assert.equal(getImportPreview(f.db, f.actor, f.portfolio, p.id).status, "preview");
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='record_fact'").get() as { n: number }).n, 0);
    f.db.exec("DROP TRIGGER csv_test_fail");
    assert.equal(f.confirm(p).revision, 2);
  } finally { f.close(); }
});

test("a pending preview pins parser methods and rejects a changed application parser", () => {
  const f = fixture();
  try {
    const p = f.preview();
    // Simulate a previously produced method version before the next application deployment.
    f.db.exec("DROP TRIGGER csv_manifest_no_update; DROP TRIGGER csv_batch_frozen");
    const stored = f.db.prepare("SELECT manifest_json FROM csv_import_manifests WHERE batch_id=?").get(p.id) as { manifest_json: string };
    const manifest = JSON.parse(stored.manifest_json); manifest.parser_version = "strict-csv-old-v0";
    const manifestHash = hash(manifest), previewHash = hash({ schema_version: "csv-ledger-preview-v1", portfolio_id: f.portfolio, account_id: f.account, expected_revision: 0, manifest_hash: manifestHash });
    f.db.prepare("UPDATE csv_import_manifests SET manifest_json=?,content_hash=? WHERE batch_id=?").run(canonical(manifest), manifestHash, p.id);
    f.db.prepare("UPDATE import_batches SET preview_hash=? WHERE id=?").run(previewHash, p.id);
    assert.throws(() => f.confirm({ ...p, preview_hash: previewHash }), /CSV_IMPORT_METHOD_CHANGED/);
    assert.equal(f.count("ledger_events"), 0);
  } finally { f.close(); }
});
