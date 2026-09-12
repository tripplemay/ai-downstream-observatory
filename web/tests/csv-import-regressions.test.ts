import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, recordFact, resolveSourceReceipt, revision, type LedgerCommand } from "../src/server/ledger/service";
import { previewCsvImport } from "../src/server/ledger/csv-imports";
import { confirmImport, previewJsonImport, type ImportPreview } from "../src/server/ledger/imports";
import type { CsvMapping } from "../src/server/ledger/csv-mapping";

const actor = { id: "synthetic-review-owner" }, now = "2026-01-03T00:00:00.000Z";

function fixture() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "csv-import-regressions-")), filename = path.join(dataDir, "workbench.db");
  migrateWorkbench(filename);
  const db = openWorkbench(filename), portfolio = createPortfolio(db, actor, "Synthetic regression", now);
  const account = createAccount(db, actor, portfolio, "A", "Synthetic", "CNY", now);
  const mapping: CsvMapping = {
    schema_version: "csv-import-mapping-v1", mapping_id: "SYNTHETIC-SOURCE-IDENTITY", version: 1, title: "Synthetic only",
    dialect: { encoding: "utf-8", delimiter: ",", record_separator: "lf" }, expected_headers: ["date", "amount", "source"], ignored_columns: [],
    account: { kind: "constant", value: account }, event_type: { kind: "constant", value: "deposit" }, source_id: "synthetic-broker",
    source_event_id: { kind: "column", column: "source", trim: false, empty: "reject" }, reason: { kind: "constant", value: "Synthetic" },
    effective_at: { column: "date", format: "YYYY-MM-DD", trim: false, source_timezone: "UTC" },
    rules: [{ event_type: "deposit", fields: { currency: { kind: "constant", value: "CNY" }, amount: {
      kind: "decimal", column: "amount", empty: "reject", format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false },
    } } }],
  };
  const manual = (key: string, amount: string, day = "2026-01-01") => recordFact(db, actor, {
    portfolio_id: portfolio, expected_revision: revision(db, portfolio), idempotency_key: key, source_id: "synthetic-manual", source_event_id: key,
    effective_at: day, time_precision: "date", source_timezone: "UTC", reason: "Synthetic",
    fact: { type: "deposit", account_id: account, currency: "CNY", amount },
  }, now);
  const preview = (rows: string[], filename = "synthetic.csv") => previewCsvImport(db, actor, {
    portfolio_id: portfolio, account_id: account, expected_revision: revision(db, portfolio), filename,
    mapping: JSON.stringify(mapping), bytes: Buffer.from(["date,amount,source", ...rows].join("\n")),
  }, { dataDir, now });
  const review = (batch: ImportPreview, rows: unknown[]) => ({ acknowledge_unverified_mapping: true, review_hash: batch.csv!.review_hash, rows });
  const confirm = (batch: ImportPreview, rows: unknown[]) => confirmImport(db, actor, portfolio, batch.id, batch.preview_hash, batch.expected_revision, now, { dataDir }, review(batch, rows));
  const cash = () => (db.prepare("SELECT balance FROM account_projections WHERE account_id=? AND currency='CNY' AND ledger_account='cash_settled'").get(account) as { balance: string }).balance;
  return { db, dataDir, portfolio, account, mapping, manual, preview, confirm, cash, close: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("CSV same-file reliable duplicate follows a manually linked first row without creating cash", () => {
  const f = fixture();
  try {
    const original = f.manual("manual-1", "100");
    const preview = f.preview(["2026-01-01,100,S", "2026-01-01,100,S"]);
    assert.equal(preview.status, "preview");
    assert.deepEqual(preview.csv!.required_review_rows, [1]);
    assert.equal(preview.rows[1].outcome!.kind, "same_file_row");
    const resolution = [{ row: 1, action: "link_existing", event_id: original.event_id, reason: "Same occurrence, manually verified in this fixture" }];
    const confirmed = f.confirm(preview, resolution);
    assert.deepEqual(confirmed.receipts.map(row => row.event_id), [original.event_id, original.event_id]);
    assert.ok(confirmed.receipts.every(row => row.duplicate));
    assert.equal(confirmed.revision, 1);
    assert.equal(f.cash(), "100");
    const retry = f.confirm(preview, resolution);
    assert.equal(retry.duplicate, true);
    assert.deepEqual(retry.receipts, confirmed.receipts);
    assert.equal(f.cash(), "100");
  } finally { f.close(); }
});

test("CSV manually linked reliable source cannot later be reused with changed economic content", () => {
  const f = fixture();
  try {
    const original = f.manual("manual-1", "100"), first = f.preview(["2026-01-01,100,S"]);
    f.confirm(first, [{ row: 1, action: "link_existing", event_id: original.event_id, reason: "Bind broker source S to this occurrence" }]);
    let code = "";
    try {
      const changed = f.preview(["2026-01-01,101,S"], "later-statement.csv");
      code = changed.rows.flatMap(row => row.errors).join(" ");
      if (changed.status === "preview") f.confirm(changed, []);
    } catch (error) { code = error instanceof Error ? error.message : String(error); }
    assert.match(code, /SOURCE.*CONFLICT/, `the already-bound source was accepted again; cash=${f.cash()}`);
    assert.equal(f.cash(), "100");
    assert.equal(revision(f.db, f.portfolio), 1);
  } finally { f.close(); }
});

test("CSV exact historical match can be explicitly linked despite later ledger facts", () => {
  const f = fixture();
  try {
    const original = f.manual("manual-1", "100");
    f.manual("later-event", "1", "2026-01-02");
    const preview = f.preview(["2026-01-01,100,S"]);
    assert.ok(preview.csv!.candidates[0].exact_event_ids.includes(original.event_id));
    assert.equal(preview.status, "preview", JSON.stringify(preview.rows[0].errors));
    assert.equal(preview.rows[0].outcome!.kind, "link_only");
    assert.throws(() => f.confirm(preview, [{ row: 1, action: "record_distinct", reason: "Attempt to bypass chronology" }]), /CSV_.*LINK|CHRONOLOGY/);
    assert.equal(f.cash(), "101");
    assert.equal(revision(f.db, f.portfolio), 2);
    const result = f.confirm(preview, [{ row: 1, action: "link_existing", event_id: original.event_id, reason: "Older statement record is already present" }]);
    assert.equal(result.receipts[0].event_id, original.event_id);
    assert.equal(result.revision, 2);
    assert.equal(f.cash(), "101");
  } finally { f.close(); }
});

test("CSV manually linked reliable source deduplicates automatically across different file bytes", () => {
  const f = fixture();
  try {
    const original = f.manual("manual-1", "100"), first = f.preview(["2026-01-01,100,S"]);
    f.confirm(first, [{ row: 1, action: "link_existing", event_id: original.event_id, reason: "Bind broker source" }]);
    const later = f.preview(["2026-01-01,100.00,S"], "later-formatting.csv");
    assert.notEqual(later.id, first.id);
    assert.equal(later.status, "preview");
    assert.equal(later.rows[0].outcome!.kind, "already_recorded");
    assert.deepEqual(later.csv!.required_review_rows, []);
    const confirmed = f.confirm(later, []);
    assert.equal(confirmed.receipts[0].event_id, original.event_id);
    assert.equal(confirmed.receipts[0].duplicate, true);
    assert.equal(confirmed.revision, 1);
    assert.equal(f.cash(), "100");
    assert.equal(f.confirm(later, []).duplicate, true);
  } finally { f.close(); }
});

test("CSV reliable source aliases reject conflicting content through direct and JSON imports too", () => {
  const f = fixture();
  try {
    const original = f.manual("manual-1", "100"), first = f.preview(["2026-01-01,100,S"]);
    f.confirm(first, [{ row: 1, action: "link_existing", event_id: original.event_id, reason: "Bind broker source" }]);
    const conflicting: LedgerCommand = { portfolio_id: f.portfolio, expected_revision: revision(f.db, f.portfolio), idempotency_key: "attempt-direct",
      source_id: f.mapping.source_id, source_event_id: "S", effective_at: "2026-01-01", time_precision: "date", source_timezone: "UTC", reason: "Other import path",
      fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: "101" } };
    assert.throws(() => recordFact(f.db, actor, conflicting, now), /SOURCE.*CONFLICT/);
    const jsonPreview = previewJsonImport(f.db, actor, f.portfolio, f.account, JSON.stringify([conflicting]), now, { dataDir: f.dataDir });
    assert.equal(jsonPreview.status, "invalid");
    assert.ok(jsonPreview.rows[0].errors.some(code => /SOURCE.*CONFLICT/.test(code)));
    assert.throws(() => confirmImport(f.db, actor, f.portfolio, jsonPreview.id, jsonPreview.preview_hash, jsonPreview.expected_revision, now, { dataDir: f.dataDir }), /IMPORT_HAS_ERRORS/);
    assert.equal(f.cash(), "100");
    assert.equal(revision(f.db, f.portfolio), 1);
    const same = recordFact(f.db, actor, { ...conflicting, idempotency_key: "same-direct", fact: { ...conflicting.fact, amount: "100.00" } }, now);
    assert.equal(same.event_id, original.event_id);
    assert.equal(same.duplicate, true);
    assert.equal(f.cash(), "100");
  } finally { f.close(); }
});

test("CSV confirmation detects changed referenced context even without a ledger revision change", () => {
  const f = fixture();
  try {
    f.db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('mapped-instrument','Synthetic',?)").run(now);
    f.db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('mapped-listing','mapped-instrument','CN','SSE','000001','CNY',?)").run(now);
    f.mapping.rules.push({ event_type: "buy", fields: { currency: { kind: "constant", value: "CNY" }, listing_id: { kind: "constant", value: "mapped-listing" },
      quantity: { kind: "constant", value: "1" }, price: { kind: "constant", value: "1" }, fee: { kind: "constant", value: "0" } } });
    const preview = f.preview(["2026-01-01,100,S"]);
    assert.equal(preview.status, "preview");
    f.db.prepare("UPDATE listings SET currency='USD' WHERE id='mapped-listing'").run();
    assert.equal(revision(f.db, f.portfolio), 0);
    assert.throws(() => f.confirm(preview, []), /CSV_IMPORT_CONTEXT_CHANGED/);
    assert.equal(revision(f.db, f.portfolio), 0);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM ledger_events").get() as { n: number }).n, 0);
  } finally { f.close(); }
});

test("CSV confirmation ignores unrelated account/listing catalog additions", () => {
  const f = fixture();
  try {
    const preview = f.preview(["2026-01-01,100,S"]);
    createAccount(f.db, actor, f.portfolio, "Unrelated", "Synthetic", "USD", now);
    f.db.prepare("INSERT INTO instruments(id,name,created_at) VALUES('unrelated-instrument','Synthetic',?)").run(now);
    f.db.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES('unrelated-listing','unrelated-instrument','US','TEST','UNUSED','USD',?)").run(now);
    assert.equal(revision(f.db, f.portfolio), 0);
    const result = f.confirm(preview, []);
    assert.equal(result.revision, 1);
    assert.equal(f.cash(), "100");
  } finally { f.close(); }
});

test("CSV conflicting same-file source identities cannot both escape dry-run failures through exact links", () => {
  const f = fixture();
  try {
    f.manual("first-occurrence", "100");
    f.manual("second-occurrence", "101");
    f.manual("later-event", "1", "2026-01-02");
    const preview = f.preview(["2026-01-01,100,S", "2026-01-01,101,S"]);
    assert.equal(preview.status, "invalid");
    assert.ok(preview.rows.some(row => row.errors.some(code => /SOURCE.*CONFLICT/.test(code))), JSON.stringify(preview.rows));
    assert.throws(() => f.confirm(preview, []), /IMPORT_HAS_ERRORS/);
    assert.equal(f.cash(), "202");
    assert.equal(revision(f.db, f.portfolio), 3);
  } finally { f.close(); }
});

test("CSV stale manual link rechecks a conflicting source alias committed without changing ledger revision", () => {
  const f = fixture();
  try {
    const first = f.manual("manual-100", "100"), second = f.manual("manual-101", "101");
    const stale = f.preview(["2026-01-01,101,S"], "B.csv");
    const winner = f.preview(["2026-01-01,100,S"], "A.csv");
    assert.equal(stale.expected_revision, winner.expected_revision);
    f.confirm(winner, [{ row: 1, action: "link_existing", event_id: first.event_id, reason: "Bind S to first occurrence" }]);
    assert.equal(revision(f.db, f.portfolio), stale.expected_revision);
    const outcomes = (f.db.prepare("SELECT COUNT(*) n FROM csv_import_outcomes").get() as { n: number }).n;
    assert.throws(() => f.confirm(stale, [{ row: 1, action: "link_existing", event_id: second.event_id, reason: "Stale review of conflicting S" }]), /SOURCE_DUPLICATE_CONFLICT/);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM csv_import_outcomes").get() as { n: number }).n, outcomes);
    assert.equal((f.db.prepare("SELECT status FROM import_batches WHERE id=?").get(stale.id) as { status: string }).status, "preview");
    assert.equal(f.cash(), "201");
    assert.equal(revision(f.db, f.portfolio), 2);
  } finally { f.close(); }
});

test("CSV stale manual link cannot rebind a source between distinct equal-valued real occurrences", () => {
  const f = fixture();
  try {
    const first = f.manual("real-occurrence-A", "100"), second = f.manual("real-occurrence-B", "100");
    const stale = f.preview(["2026-01-01,100.00,S"], "B.csv");
    const winner = f.preview(["2026-01-01,100,S"], "A.csv");
    assert.notEqual(stale.id, winner.id);
    f.confirm(winner, [{ row: 1, action: "link_existing", event_id: first.event_id, reason: "Source S identifies A, not merely an equal value" }]);
    assert.equal(revision(f.db, f.portfolio), stale.expected_revision);
    assert.throws(() => f.confirm(stale, [{ row: 1, action: "link_existing", event_id: second.event_id, reason: "Attempt to rebind S to B" }]), /CSV_SOURCE_LINK_CONFLICT/);
    assert.equal(f.cash(), "200");
    assert.equal(revision(f.db, f.portfolio), 2);
    const consistent = f.confirm(stale, [{ row: 1, action: "link_existing", event_id: first.event_id, reason: "Retain S to A binding" }]);
    assert.equal(consistent.receipts[0].event_id, first.event_id);
    assert.equal(consistent.revision, 2);
  } finally { f.close(); }
});

test("CSV same-batch link-only rows cannot bind one source to two equal-valued occurrences", () => {
  const f = fixture();
  try {
    const first = f.manual("occurrence-A", "100"), second = f.manual("occurrence-B", "100");
    f.manual("later-event", "1", "2026-01-02");
    const preview = f.preview(["2026-01-01,100,S", "2026-01-01,100.00,S"]);
    assert.deepEqual(preview.rows.map(row => row.outcome!.kind), ["link_only", "link_only"]);
    assert.deepEqual(preview.csv!.required_review_rows, [1, 2]);
    const firstLink = { row: 1, action: "link_existing", event_id: first.event_id, reason: "Source S belongs to A" };
    assert.throws(() => f.confirm(preview, [firstLink, { row: 2, action: "link_existing", event_id: second.event_id, reason: "Attempt inconsistent same-batch target" }]), /CSV_SOURCE_LINK_CONFLICT/);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM csv_import_outcomes WHERE batch_id=?").get(preview.id) as { n: number }).n, 0);
    assert.equal(revision(f.db, f.portfolio), 3);
    assert.equal(f.cash(), "201");
    const consistent = f.confirm(preview, [firstLink, { row: 2, action: "link_existing", event_id: first.event_id, reason: "Keep the same source binding" }]);
    assert.deepEqual(consistent.receipts.map(row => row.event_id), [first.event_id, first.event_id]);
    assert.equal(consistent.revision, 3);
  } finally { f.close(); }
});

test("source receipt resolver reads native facts and CSV aliases without persisting dedup records", () => {
  const f = fixture();
  try {
    const original = f.manual("manual-1", "100"), preview = f.preview(["2026-01-01,100,S"]);
    f.confirm(preview, [{ row: 1, action: "link_existing", event_id: original.event_id, reason: "Bind source for read-only resolver" }]);
    const native = JSON.parse((f.db.prepare("SELECT payload_json FROM ledger_events WHERE id=?").get(original.event_id) as { payload_json: string }).payload_json) as LedgerCommand;
    const changes = () => (f.db.prepare("SELECT total_changes() n").get() as { n: number }).n;
    const before = changes();
    for (const command of [native, preview.rows[0].command!]) {
      const receipt = resolveSourceReceipt(f.db, command);
      assert.equal(receipt!.event_id, original.event_id);
      assert.equal(receipt!.duplicate, true);
    }
    assert.equal(resolveSourceReceipt(f.db, { ...native, source_event_id: undefined }), undefined);
    assert.equal(resolveSourceReceipt(f.db, { ...native, source_event_id: "unseen-source" }), undefined);
    assert.equal(changes(), before);
  } finally { f.close(); }
});
