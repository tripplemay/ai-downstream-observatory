import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, revision, recordFact, canonical } from "../src/server/ledger/service";
import { confirmImport, previewJsonImport, type ImportPreview } from "../src/server/ledger/imports";
import { previewCsvImport } from "../src/server/ledger/csv-imports";
import { readConfirmedCsvImport } from "../src/server/ledger/csv-confirmation";
import { CSV_RECOVERY_LIMITS, getCsvConfirmationAttempt, listCsvConfirmationAttempts, saveCsvConfirmationAttempt } from "../src/server/ledger/csv-confirmation-recovery";
import type { CsvMapping } from "../src/server/ledger/csv-schemas";
import type { CsvRowResolution } from "../src/server/ledger/csv-review";

const now = "2026-09-12T00:00:00.000Z", principal = { actorId: "owner", sessionHash: "a".repeat(64) };
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "csv-recovery-")), filename = path.join(dir, "workbench.db"); migrateWorkbench(filename);
  const db = openWorkbench(filename), actor = { id: "owner" };
  const portfolio = createPortfolio(db, actor, "Synthetic recovery", now), account = createAccount(db, actor, portfolio, "Synthetic account", "Synthetic", "CNY", now);
  const options = { dataDir: dir, now };
  const mapping = (missing = false): CsvMapping => ({ schema_version: "csv-import-mapping-v1", mapping_id: "SYNTHETIC-RECOVERY", version: 1, title: "Synthetic only",
    dialect: { encoding: "utf-8", delimiter: ",", record_separator: "either" }, expected_headers: ["date", "amount", "id", "note"], ignored_columns: missing ? ["id"] : [],
    account: { kind: "constant", value: account }, event_type: { kind: "constant", value: "deposit" }, source_id: "synthetic-recovery",
    source_event_id: missing ? null : { kind: "column", column: "id", trim: false, empty: "reject" }, reason: { kind: "column", column: "note", trim: false, empty: "reject" },
    effective_at: { column: "date", format: "YYYY-MM-DD", trim: false, source_timezone: "Asia/Shanghai" },
    rules: [{ event_type: "deposit", fields: { currency: { kind: "constant", value: "CNY" }, amount: { kind: "decimal", column: "amount", empty: "reject", format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false } } } }],
  });
  const preview = (rows = ["2026-01-01,100,s1,Synthetic"], missing = false) => previewCsvImport(db, actor, { portfolio_id: portfolio, account_id: account, expected_revision: revision(db, portfolio),
    filename: "synthetic.csv", bytes: Buffer.from("\ufeffdate,amount,id,note\r\n" + rows.join("\r\n") + "\r\n"), mapping: JSON.stringify(mapping(missing)) }, options);
  const review = (p: ImportPreview, rows: CsvRowResolution[] = []) => ({ acknowledge_unverified_mapping: true, review_hash: p.csv!.review_hash, rows });
  const payload = (p: ImportPreview, csvReview: unknown = review(p)) => JSON.stringify({ action: "confirm_import", portfolio_id: portfolio, batch_id: p.id, preview_hash: p.preview_hash, expected_revision: p.expected_revision, csv_review: csvReview });
  const confirm = (p: ImportPreview, csvReview: unknown = review(p)) => confirmImport(db, actor, portfolio, p.id, p.preview_hash, p.expected_revision, now, options, csvReview);
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  return { dir, filename, db, actor, portfolio, account, options, preview, review, payload, confirm, count,
    close() { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("durable attempts retain exact BOM, whitespace and Unicode payload without creating ledger facts", () => {
  const f = fixture();
  try {
    const p = f.preview(["2026-01-01,100,,Synthetic"], true), review = f.review(p, [{ row: 1, action: "record_distinct", reason: "合成核对 =1+1，仅文本" }]);
    const raw = "\ufeff \r\n" + JSON.stringify(JSON.parse(f.payload(p, review)), null, 2) + "\t\n";
    const audits = f.count("audit_events"), attempt = saveCsvConfirmationAttempt(f.db, principal, raw, f.options);
    assert.equal(attempt.payload_hash, sha(raw)); assert.equal(attempt.payload_bytes, Buffer.byteLength(raw));
    assert.equal(f.count("csv_confirmation_attempts"), 1); assert.equal(f.count("ledger_events"), 0); assert.equal(f.count("audit_events"), audits);
    assert.equal(revision(f.db, f.portfolio), 0);
    assert.deepEqual(saveCsvConfirmationAttempt(f.db, principal, raw, f.options), attempt);
    const detail = getCsvConfirmationAttempt(f.db, principal, { id: attempt.id }, f.options);
    assert.equal(detail.payload_text, raw); assert.equal(detail.review_error, null); assert.deepEqual(detail.confirmation, { status: "unconfirmed", attempt_matches: null });
    assert.equal("preview" in detail, false); assert.equal(JSON.stringify(detail).includes(principal.sessionHash), false);
    assert.equal(getCsvConfirmationAttempt(f.db, principal, { batch_id: p.id, payload_hash: sha(raw) }, f.options).attempt.id, attempt.id);
    const otherConnection = openWorkbench(f.filename);
    try { assert.equal(getCsvConfirmationAttempt(otherConnection, principal, { id: attempt.id }, f.options).payload_text, raw); } finally { otherConnection.close(); }
  } finally { f.close(); }
});

test("semantic review failure stays recoverable and never locks a batch against a new explicit attempt", () => {
  const f = fixture();
  try {
    const p = f.preview(["2026-01-01,100,,Synthetic"], true), bad = f.payload(p, { acknowledge_unverified_mapping: false });
    const first = saveCsvConfirmationAttempt(f.db, principal, bad, f.options);
    assert.throws(() => f.confirm(p, { acknowledge_unverified_mapping: false }), /CSV_REVIEW_INVALID/);
    assert.equal(getCsvConfirmationAttempt(f.db, principal, { id: first.id }, f.options).review_error, "CSV_REVIEW_INVALID");
    assert.equal(f.count("csv_confirmation_attempts"), 1); assert.equal(f.count("ledger_events"), 0);
    const again = f.preview(["2026-01-01,100,,Synthetic"], true); assert.equal(again.id, p.id);
    const review = f.review(p, [{ row: 1, action: "record_distinct", reason: "Synthetic independently reviewed" }]), raw = f.payload(p, review);
    const second = saveCsvConfirmationAttempt(f.db, principal, raw, f.options); assert.notEqual(second.id, first.id);
    const actual = f.confirm(p, review), detail = getCsvConfirmationAttempt(f.db, principal, { id: second.id }, f.options);
    assert.deepEqual(detail.confirmation, { ...actual, duplicate: true, status: "confirmed", attempt_matches: true });
    const rejected = getCsvConfirmationAttempt(f.db, principal, { id: first.id }, f.options);
    assert.equal(rejected.confirmation.status, "confirmed"); assert.equal(rejected.confirmation.attempt_matches, false); assert.equal(rejected.review_error, "CSV_REVIEW_INVALID");
    assert.equal(rejected.payload_text, bad); assert.equal(f.count("ledger_events"), 1);
  } finally { f.close(); }
});

test("a valid but different review reports the actual confirmation without claiming this attempt succeeded", () => {
  const f = fixture();
  try {
    const p = f.preview(["2026-01-01,100,,Synthetic"], true);
    const firstReview = f.review(p, [{ row: 1, action: "record_distinct", reason: "First reason" }]);
    const secondReview = f.review(p, [{ row: 1, action: "record_distinct", reason: "Second reason" }]);
    const first = saveCsvConfirmationAttempt(f.db, principal, f.payload(p, firstReview), f.options);
    const second = saveCsvConfirmationAttempt(f.db, principal, f.payload(p, secondReview), f.options);
    f.confirm(p, secondReview);
    const result = getCsvConfirmationAttempt(f.db, principal, { id: first.id }, f.options);
    assert.equal(result.review_error, null); assert.equal(result.confirmation.status, "confirmed"); assert.equal(result.confirmation.attempt_matches, false);
    assert.equal(getCsvConfirmationAttempt(f.db, principal, { id: second.id }, f.options).confirmation.attempt_matches, true);
    assert.throws(() => f.confirm(p, firstReview), /CSV_REVIEW_CONFLICT/);
  } finally { f.close(); }
});

test("principal/session and account/portfolio scope cannot be supplied by a payload or borrowed selector", () => {
  const f = fixture();
  try {
    const p = f.preview(), raw = f.payload(p), attempt = saveCsvConfirmationAttempt(f.db, principal, raw, f.options);
    for (const who of [{ ...principal, actorId: "another-owner" }, { ...principal, sessionHash: "b".repeat(64) }]) {
      assert.equal(listCsvConfirmationAttempts(f.db, who).attempts.length, 0);
      assert.throws(() => getCsvConfirmationAttempt(f.db, who, { id: attempt.id }, f.options), /CSV_RECOVERY_NOT_FOUND/);
      assert.throws(() => getCsvConfirmationAttempt(f.db, who, { batch_id: p.id, payload_hash: sha(raw) }, f.options), /CSV_RECOVERY_NOT_FOUND/);
    }
    assert.throws(() => saveCsvConfirmationAttempt(f.db, { ...principal, sessionHash: "sid-is-not-a-hash" }, raw, f.options), /CSV_RECOVERY_PRINCIPAL_INVALID/);
    for (const patch of [{ actor_id: "other" }, { session_hash: "b".repeat(64) }, { account_id: "other" }, { extra: true }])
      assert.throws(() => saveCsvConfirmationAttempt(f.db, principal, JSON.stringify({ ...JSON.parse(raw), ...patch }), f.options), /CSV_RECOVERY_PAYLOAD_INVALID/);
    assert.throws(() => saveCsvConfirmationAttempt(f.db, principal, JSON.stringify({ ...JSON.parse(raw), portfolio_id: "other" }), f.options), /IMPORT_NOT_FOUND/);
    assert.throws(() => saveCsvConfirmationAttempt(f.db, principal, JSON.stringify({ ...JSON.parse(raw), preview_hash: "f".repeat(64) }), f.options), /PREVIEW_HASH_MISMATCH/);
    assert.throws(() => saveCsvConfirmationAttempt(f.db, principal, JSON.stringify({ ...JSON.parse(raw), expected_revision: 1 }), f.options), /VERSION_CONFLICT/);
    assert.equal(f.count("csv_confirmation_attempts"), 1);
  } finally { f.close(); }
});

test("strict JSON, single BOM, byte size and CSV-only boundary reject malformed outer envelopes", () => {
  const f = fixture();
  try {
    const p = f.preview(), raw = f.payload(p);
    for (const value of ["", "{}", "[]", "\ufeff\ufeff" + raw, raw.slice(0, -1) + ',"action":"confirm_import"}', JSON.stringify({ ...JSON.parse(raw), expected_revision: 0.5 }), raw + "\ud800"])
      assert.throws(() => saveCsvConfirmationAttempt(f.db, principal, value, f.options), /CSV_RECOVERY_PAYLOAD_INVALID/);
    assert.throws(() => saveCsvConfirmationAttempt(f.db, principal, " ".repeat(CSV_RECOVERY_LIMITS.payload_bytes) + raw, f.options), /CSV_RECOVERY_PAYLOAD_TOO_LARGE/);
    const jp = previewJsonImport(f.db, f.actor, f.portfolio, f.account, JSON.stringify([p.rows[0].command]), now, f.options);
    assert.throws(() => saveCsvConfirmationAttempt(f.db, principal, f.payload(jp, null), f.options), /CSV_RECOVERY_NOT_CSV/);
    const noReview = JSON.parse(raw); delete noReview.csv_review;
    const saved = saveCsvConfirmationAttempt(f.db, principal, JSON.stringify(noReview), f.options);
    assert.equal(getCsvConfirmationAttempt(f.db, principal, { id: saved.id }, f.options).review_error, "CSV_REVIEW_INVALID");
  } finally { f.close(); }
});

test("independent commit rejects nesting and detects a restore marker created before transaction commit", () => {
  const f = fixture();
  try {
    const p = f.preview(), raw = f.payload(p);
    assert.throws(() => f.db.transaction(() => saveCsvConfirmationAttempt(f.db, principal, raw, f.options)).immediate(), /CSV_RECOVERY_INDEPENDENT_TRANSACTION_REQUIRED/);
    assert.equal(f.count("csv_confirmation_attempts"), 0);
    f.db.function("synthetic_restore_marker", () => { writeFileSync(path.join(f.dir, "RESTORE_PENDING_REVIEW"), "Synthetic marker", { mode: 0o600 }); return 1; });
    f.db.exec("CREATE TRIGGER synthetic_restore AFTER INSERT ON csv_confirmation_attempts BEGIN SELECT synthetic_restore_marker(); END");
    assert.throws(() => saveCsvConfirmationAttempt(f.db, principal, raw, f.options), /WORKBENCH_READ_ONLY/);
    assert.equal(f.count("csv_confirmation_attempts"), 0); assert.equal(f.count("ledger_events"), 0);
  } finally { f.close(); }
});

test("keyset list is current-session-only and bounded; exact attempts survive a newer ledger revision", () => {
  const f = fixture();
  try {
    const p = f.preview(), raw = f.payload(p), ids: string[] = [];
    for (let i = 0; i < 23; i++) ids.push(saveCsvConfirmationAttempt(f.db, principal, " ".repeat(i) + raw, f.options).id);
    const seen: string[] = []; let cursor: string | undefined;
    do { const page = listCsvConfirmationAttempts(f.db, principal, { limit: 7, ...(cursor ? { cursor } : {}) });
      assert.ok(page.attempts.length <= 7); assert.equal(JSON.stringify(page).includes("payload_text"), false);
      assert.equal(JSON.stringify(page).includes(principal.sessionHash), false); seen.push(...page.attempts.map(item => item.id)); cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, [...ids].sort().reverse()); assert.equal(new Set(seen).size, 23);
    for (const input of [{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { cursor: "invalid cursor" }]) assert.throws(() => listCsvConfirmationAttempts(f.db, principal, input), /CSV_RECOVERY_(QUERY|CURSOR)_INVALID/);
    recordFact(f.db, f.actor, { ...p.rows[0].command!, source_id: "other-synthetic-source", source_event_id: "other", idempotency_key: "independent", fact: { type: "deposit", account_id: f.account, currency: "CNY", amount: "1" } }, now);
    const existing = saveCsvConfirmationAttempt(f.db, principal, raw, f.options);
    assert.equal(existing.id, ids[0]); assert.equal(existing.expected_revision, 0); assert.equal(existing.current_revision, 1);
    assert.throws(() => f.confirm(p), /VERSION_CONFLICT/); assert.equal(getCsvConfirmationAttempt(f.db, principal, { id: ids[0] }, f.options).confirmation.status, "unconfirmed");
  } finally { f.close(); }
});

test("per-session count and total UTF8 budgets block only new attempts, not exact retries or reads", () => {
  const f = fixture();
  try {
    const p = f.preview(), raw = f.payload(p);
    for (let i = 0; i < CSV_RECOVERY_LIMITS.session_attempts; i++) saveCsvConfirmationAttempt(f.db, principal, " ".repeat(i) + raw, f.options);
    assert.throws(() => saveCsvConfirmationAttempt(f.db, principal, " ".repeat(128) + raw, f.options), /CSV_RECOVERY_BUDGET_EXCEEDED/);
    const existing = saveCsvConfirmationAttempt(f.db, principal, raw, f.options); assert.equal(getCsvConfirmationAttempt(f.db, principal, { id: existing.id }, f.options).payload_text, raw);
    const separate = { ...principal, sessionHash: "c".repeat(64) }, remaining = CSV_RECOVERY_LIMITS.payload_bytes - Buffer.byteLength(raw);
    let first = "";
    for (let i = 0; i < 12; i++) { const padded = " ".repeat(remaining - i) + "\t".repeat(i) + raw; first ||= padded; saveCsvConfirmationAttempt(f.db, separate, padded, f.options); }
    assert.throws(() => saveCsvConfirmationAttempt(f.db, separate, " ".repeat(remaining - 12) + "\t".repeat(12) + raw, f.options), /CSV_RECOVERY_BUDGET_EXCEEDED/);
    const exact = saveCsvConfirmationAttempt(f.db, separate, first, f.options);
    assert.equal(getCsvConfirmationAttempt(f.db, separate, { id: exact.id }, f.options).payload_text, first);
    const queries: string[] = [], prepare = f.db.prepare.bind(f.db);
    f.db.prepare = ((sql: string) => { queries.push(sql); return prepare(sql); }) as typeof f.db.prepare;
    try { assert.equal(listCsvConfirmationAttempts(f.db, separate).attempts.length, 10); }
    finally { f.db.prepare = prepare; }
    const listQuery = queries.find(query => query.includes("FROM csv_confirmation_attempts"))!;
    assert.ok(listQuery.includes("length(CAST(payload_text AS BLOB)) AS payload_bytes"));
    assert.doesNotMatch(listQuery.replace("length(CAST(payload_text AS BLOB)) AS payload_bytes", "payload_bytes"), /SELECT \*|payload_text/);
  } finally { f.close(); }
});

test("readonly detail returns verified real receipts and does not modify DB, attachments, audit or filesystem", () => {
  const f = fixture();
  try {
    const p = f.preview(), raw = f.payload(p), attempt = saveCsvConfirmationAttempt(f.db, principal, raw, f.options), actual = f.confirm(p);
    const before = f.db.prepare("SELECT total_changes() n").get(), audits = f.count("audit_events"), files = readdirSync(f.dir);
    const csvFile = path.join(f.dir, "attachments", `${p.csv!.content_hash}.csv`), bytes = readFileSync(csvFile);
    writeFileSync(path.join(f.dir, "RESTORE_PENDING_REVIEW"), "Synthetic readonly", { mode: 0o600 });
    for (const db of [f.db, openWorkbench(f.filename)]) {
      try {
        const detail = getCsvConfirmationAttempt(db, principal, { id: attempt.id }, f.options);
        assert.equal(detail.read_only, true); assert.deepEqual(detail.confirmation, { ...actual, duplicate: true, status: "confirmed", attempt_matches: true });
        assert.equal(listCsvConfirmationAttempts(db, principal).read_only, true);
        assert.throws(() => saveCsvConfirmationAttempt(db, principal, raw, f.options), /WORKBENCH_READ_ONLY/);
      } finally { if (db !== f.db) db.close(); }
    }
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); assert.equal(f.count("audit_events"), audits);
    assert.deepEqual(readFileSync(csvFile), bytes); assert.deepEqual(readdirSync(f.dir).filter(name => name !== "RESTORE_PENDING_REVIEW"), files);
  } finally { f.close(); }
});

test("recovery rejects changed original bytes, payload hash and mutually altered receipt copies", () => {
  for (const kind of ["attachment", "payload", "receipt"] as const) {
    const f = fixture();
    try {
      const p = f.preview(), attempt = saveCsvConfirmationAttempt(f.db, principal, f.payload(p), f.options);
      f.confirm(p);
      if (kind === "attachment") writeFileSync(path.join(f.dir, "attachments", `${p.csv!.content_hash}.csv`), "synthetic tampering");
      if (kind === "payload") {
        f.db.exec("DROP TRIGGER csv_confirmation_attempt_no_update");
        f.db.prepare("UPDATE csv_confirmation_attempts SET payload_text=payload_text||' ' WHERE id=?").run(attempt.id);
        // Discovery intentionally does not parse full bodies; it must not be presented as command integrity proof.
        assert.equal(listCsvConfirmationAttempts(f.db, principal).attempts[0].id, attempt.id);
      }
      if (kind === "receipt") {
        const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('audit_events','csv_import_outcomes') AND sql LIKE '%BEFORE UPDATE%'").all() as { name: string }[];
        for (const trigger of triggers) f.db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
        const audit = f.db.prepare("SELECT id,payload_json FROM audit_events WHERE action='confirm_import' AND object_id=?").get(p.id) as { id: string; payload_json: string };
        const payload = JSON.parse(audit.payload_json); payload.receipts[0].revision = 0;
        f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical(payload), audit.id);
        const outcome = JSON.parse((f.db.prepare("SELECT result_json FROM csv_import_outcomes WHERE batch_id=?").get(p.id) as { result_json: string }).result_json); outcome.receipt.revision = 0;
        f.db.prepare("UPDATE csv_import_outcomes SET result_json=? WHERE batch_id=?").run(canonical(outcome), p.id);
      }
      assert.throws(() => getCsvConfirmationAttempt(f.db, principal, { id: attempt.id }, f.options), kind === "payload" ? /CSV_RECOVERY_EVIDENCE_INVALID/ : kind === "receipt" ? /CSV_IMPORT_OUTCOMES_INVALID/ : /ATTACHMENT/);
      if (kind === "receipt") assert.throws(() => readConfirmedCsvImport(f.db, f.actor, f.portfolio, p.id, f.options), /CSV_IMPORT_OUTCOMES_INVALID/);
    } finally { f.close(); }
  }
});
