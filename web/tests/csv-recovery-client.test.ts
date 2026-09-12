import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio } from "../src/server/ledger/service";
import { previewCsvImport } from "../src/server/ledger/csv-imports";
import { confirmImport } from "../src/server/ledger/imports";
import { getCsvConfirmationAttempt, listCsvConfirmationAttempts, saveCsvConfirmationAttempt } from "../src/server/ledger/csv-confirmation-recovery";
import type { CsvConfirmationRecoveryDetailResponse } from "../src/server/ledger/csv-confirmation-recovery-types";
import type { CsvMapping } from "../src/server/ledger/csv-schemas";
import { parseCsvRecoveryDetail, parseCsvRecoveryList, recoveryResolutionDrafts } from "../src/components/workbench/csv-recovery-client";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const session = hash("synthetic-session-binding"), otherSession = hash("synthetic-other-session"), now = "2026-09-12T00:00:00.000Z";
const invalid = /^CSV_RECOVERY_RESPONSE_INVALID$/, changed = /^CSV_RECOVERY_SESSION_CHANGED$/;
const errorCode = (pattern: RegExp) => (error: unknown) => error instanceof Error && pattern.test(error.message);

function fixture(t: { after: (operation: () => void) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), "csv-recovery-client-")), filename = path.join(directory, "workbench.db");
  migrateWorkbench(filename); const db = openWorkbench(filename), actor = { id: "synthetic-owner" };
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const portfolio = createPortfolio(db, actor, "Synthetic recovery fixture"), account = createAccount(db, actor, portfolio, "Synthetic", "Synthetic", "CNY");
  const mapping: CsvMapping = {
    schema_version: "csv-import-mapping-v1", mapping_id: "synthetic-recovery", version: 1, title: "Synthetic explicit mapping",
    dialect: { encoding: "utf-8", delimiter: ",", record_separator: "either" }, expected_headers: ["Date", "Amount"], ignored_columns: [],
    account: { kind: "constant", value: account }, event_type: { kind: "constant", value: "deposit" }, source_id: "synthetic", source_event_id: null,
    reason: { kind: "constant", value: "Synthetic only" }, effective_at: { column: "Date", format: "YYYY-MM-DD", source_timezone: "UTC", trim: false },
    rules: [{ event_type: "deposit", fields: { currency: { kind: "constant", value: "CNY" }, amount: { kind: "decimal", column: "Amount", empty: "reject",
      format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", trim: false, allow_leading_plus: false } } } }],
  };
  const p = previewCsvImport(db, actor, { portfolio_id: portfolio, account_id: account, expected_revision: 0,
    filename: "synthetic.csv", bytes: Buffer.from("Date,Amount\n2026-01-01,17.25\n"), mapping: JSON.stringify(mapping) }, { dataDir: directory, now });
  assert.equal(p.status, "preview");
  const review = { acknowledge_unverified_mapping: true, review_hash: p.csv!.review_hash, rows: [{ row: 1, action: "record_distinct", reason: "Explicit synthetic occurrence" }] };
  const command = { action: "confirm_import", portfolio_id: portfolio, batch_id: p.id, preview_hash: p.preview_hash, expected_revision: p.expected_revision, csv_review: review };
  const payload = "\ufeff" + JSON.stringify(command, null, 2) + "\r\n";
  const principal = { actorId: actor.id, sessionHash: session }, options = { dataDir: directory, now };
  const saved = saveCsvConfirmationAttempt(db, principal, payload, options);
  const detail = (id = saved.id): CsvConfirmationRecoveryDetailResponse => ({ ...getCsvConfirmationAttempt(db, principal, { id }, options), session_binding: session });
  const list = (limit = 20) => ({ ...listCsvConfirmationAttempts(db, principal, { limit }), session_binding: session });
  const confirm = () => confirmImport(db, actor, portfolio, p.id, p.preview_hash, p.expected_revision, now, options, review);
  return { db, principal, options, detail, list, confirm, command, payload, saved, review };
}

function withPayload(source: CsvConfirmationRecoveryDetailResponse, payload: string) {
  const result = structuredClone(source); result.payload_text = payload;
  result.attempt.payload_bytes = Buffer.byteLength(payload); result.attempt.payload_hash = hash(payload); return result;
}

test("real saved attempt and confirmed receipt wire parse without normalizing the BOM, whitespace or retained request", async t => {
  const f = fixture(t), before = f.detail();
  assert.deepEqual(parseCsvRecoveryList(f.list(), session), f.list());
  const parsed = await parseCsvRecoveryDetail(before, session);
  assert.deepEqual(parsed, before); assert.equal(parsed.payload_text, f.payload); assert.equal(parsed.confirmation.status, "unconfirmed");
  assert.equal(parsed.attempt.payload_hash, hash(f.payload)); assert.equal(parsed.review_error, null);
  const confirmed = f.confirm(), after = f.detail();
  assert.deepEqual(await parseCsvRecoveryDetail(after, session), after);
  assert.equal(after.confirmation.status, "confirmed");
  if (after.confirmation.status === "confirmed") {
    assert.equal(after.confirmation.attempt_matches, true); assert.equal(after.confirmation.revision, confirmed.revision);
    assert.deepEqual(after.confirmation.receipts, confirmed.receipts);
  }
});

test("real list keyset cursor is canonical, bound to its final item and stable across same-time UUID ordering", t => {
  const f = fixture(t);
  saveCsvConfirmationAttempt(f.db, f.principal, JSON.stringify({ ...f.command, csv_review: { ...f.review, rows: [{ ...f.review.rows[0], reason: "Another explicit saved attempt" }] } }), f.options);
  const page = f.list(1); assert.ok(page.next_cursor); assert.deepEqual(parseCsvRecoveryList(page, session), page);
  const next = { ...listCsvConfirmationAttempts(f.db, f.principal, { limit: 1, cursor: page.next_cursor! }), session_binding: session };
  assert.deepEqual(parseCsvRecoveryList(next, session), next); assert.notEqual(next.attempts[0].id, page.attempts[0].id);
  for (const cursor of [page.next_cursor + "=", "!notbase64", Buffer.from('{"id":"wrong","created_at":"2026-09-12T00:00:00.000Z"}').toString("base64url")]) {
    assert.throws(() => parseCsvRecoveryList({ ...page, next_cursor: cursor }, session), errorCode(invalid));
  }
  assert.throws(() => parseCsvRecoveryList({ ...page, attempts: [] }, session), errorCode(invalid));
});

test("list shape, summary invariants, ordering, duplicate attempts and page bounds fail closed", t => {
  const f = fixture(t), source = f.list();
  for (const change of [
    (value: typeof source) => { value.read_only = "false" as unknown as boolean; },
    (value: typeof source) => { value.attempts[0].payload_bytes = 0; },
    (value: typeof source) => { value.attempts[0].expected_revision = 1; },
    (value: typeof source) => { value.attempts[0].current_revision = 0.5; },
    (value: typeof source) => { value.attempts[0].confirmed_revision = 1; },
    (value: typeof source) => { value.attempts[0].created_at = "2026-02-30T00:00:00.000Z"; },
    (value: typeof source) => { value.attempts[0].created_at = "2026-09-12T00:00:00Z"; },
    (value: typeof source) => { value.attempts = [value.attempts[0], value.attempts[0]]; },
    (value: typeof source) => { value.attempts = Array.from({ length: 21 }, (_, i) => ({ ...value.attempts[0], id: `x${i}` })); },
  ]) { const value = structuredClone(source); change(value); assert.throws(() => parseCsvRecoveryList(value, session), errorCode(invalid)); }
  assert.throws(() => parseCsvRecoveryList({ ...source, payload_text: f.payload }, session), errorCode(invalid));
  const wrongOrder = { ...source, attempts: [{ ...source.attempts[0], id: "a" }, { ...source.attempts[0], id: "b" }] };
  assert.throws(() => parseCsvRecoveryList(wrongOrder, session), errorCode(invalid));
});

test("cross-session lists and details use the distinct session-change code, malformed bindings are invalid", async t => {
  const f = fixture(t);
  assert.throws(() => parseCsvRecoveryList(f.list(), otherSession), errorCode(changed));
  await assert.rejects(parseCsvRecoveryDetail(f.detail(), otherSession), errorCode(changed));
  assert.throws(() => parseCsvRecoveryList({ ...f.list(), session_binding: "A".repeat(64) }, session), errorCode(invalid));
  await assert.rejects(parseCsvRecoveryDetail({ ...f.detail(), session_binding: null }, session), errorCode(invalid));
});

test("detail verifies UTF8 byte count and SHA256 before accepting any frozen payload", async t => {
  const f = fixture(t), source = f.detail();
  for (const value of [
    { ...source, payload_text: source.payload_text.slice(1) },
    { ...source, payload_text: source.payload_text + " " },
    { ...source, attempt: { ...source.attempt, payload_bytes: source.payload_text.length } },
    { ...source, attempt: { ...source.attempt, payload_hash: "a".repeat(64) } },
    withPayload(source, "\ufeff\ufeff" + JSON.stringify(f.command)),
    withPayload(source, JSON.stringify(f.command).replace("Explicit synthetic occurrence", "\ud800")),
    withPayload(source, "x".repeat(5 * 1024 * 1024 + 1)),
  ]) await assert.rejects(parseCsvRecoveryDetail(value, session), errorCode(invalid));
  const unicode = withPayload(source, JSON.stringify({ ...f.command, csv_review: { ...f.review, rows: [{ ...f.review.rows[0], reason: "Synthetic \u4e2d\u6587" }] } }));
  assert.equal((await parseCsvRecoveryDetail(unicode, session)).payload_text, unicode.payload_text);
});

test("duplicate JSON keys, wrong actions, scope, batch, preview and revision cannot be hidden behind a recomputed payload hash", async t => {
  const f = fixture(t), source = f.detail();
  const base = JSON.stringify(f.command);
  const mutations = [
    JSON.stringify({ ...f.command, action: "record_fact" }), JSON.stringify({ ...f.command, portfolio_id: "foreign-portfolio" }),
    JSON.stringify({ ...f.command, batch_id: "another-batch" }), JSON.stringify({ ...f.command, preview_hash: "a".repeat(64) }),
    JSON.stringify({ ...f.command, expected_revision: 1 }), JSON.stringify({ ...f.command, actor_id: "spoofed" }),
    base.replace('{"action":', '{"action":"confirm_import","action":'),
    base.replace('"rows":[', '"rows":[],"r\\u006fws":['),
  ];
  for (const text of mutations) await assert.rejects(parseCsvRecoveryDetail(withPayload(source, text), session), errorCode(invalid));
});

test("summary, batch and confirmation must agree including actual receipt count and revision", async t => {
  const f = fixture(t); f.confirm(); const source = f.detail();
  for (const change of [
    (value: typeof source) => { value.batch.account_id = "foreign"; },
    (value: typeof source) => { value.batch.portfolio_id = "foreign"; },
    (value: typeof source) => { value.batch.id = "foreign"; },
    (value: typeof source) => { value.batch.preview_hash = "a".repeat(64); },
    (value: typeof source) => { value.batch.expected_revision++; },
    (value: typeof source) => { value.batch.confirmed_revision = null; },
    (value: typeof source) => { value.batch.row_count = 2; },
    (value: typeof source) => { value.attempt.current_revision = 0; },
    (value: typeof source) => { value.confirmation = { status: "unconfirmed", attempt_matches: null }; },
    (value: typeof source) => { if (value.confirmation.status === "confirmed") value.confirmation.receipts[0].revision = 2; },
    (value: typeof source) => { if (value.confirmation.status === "confirmed") value.confirmation.receipts[0].warnings = Array(17).fill("warning"); },
    (value: typeof source) => { if (value.confirmation.status === "confirmed") value.confirmation.duplicate = false as true; },
    (value: typeof source) => { value.review_error = "CSV_REVIEW_LINK_NOT_EXACT"; },
  ]) { const value = structuredClone(source); change(value); await assert.rejects(parseCsvRecoveryDetail(value, session), errorCode(invalid)); }
});

test("missing or invalid original review remains readable, and a different confirmed review never implies this attempt succeeded", async t => {
  const f = fixture(t);
  for (const review of [undefined, null, { acknowledge_unverified_mapping: false }, { ...f.review, rows: [{ ...f.review.rows[0], action: "link_existing", event_id: "not-exact" }] }]) {
    const { csv_review: _review, ...base } = f.command; void _review;
    const text = JSON.stringify({ ...base, ...(review === undefined ? {} : { csv_review: review }) });
    const saved = saveCsvConfirmationAttempt(f.db, f.principal, text, f.options), detail = f.detail(saved.id);
    assert.notEqual(detail.review_error, null); assert.equal(detail.confirmation.status, "unconfirmed");
    assert.deepEqual(await parseCsvRecoveryDetail(detail, session), detail);
  }
  const text = JSON.stringify({ action: "confirm_import", portfolio_id: f.command.portfolio_id, batch_id: f.command.batch_id, preview_hash: f.command.preview_hash, expected_revision: f.command.expected_revision });
  const saved = saveCsvConfirmationAttempt(f.db, f.principal, text, f.options); f.confirm();
  const detail = await parseCsvRecoveryDetail(f.detail(saved.id), session);
  assert.equal(detail.confirmation.status, "confirmed");
  if (detail.confirmation.status === "confirmed") assert.equal(detail.confirmation.attempt_matches, false);
  assert.equal(detail.review_error, "CSV_REVIEW_INVALID"); assert.deepEqual(recoveryResolutionDrafts(text), { drafts: {}, acknowledged: false });
  await assert.rejects(parseCsvRecoveryDetail({ ...detail, review_error: null }, session), errorCode(invalid));
});

test("draft restoration retains only complete explicit choices and never fills, trims, merges duplicates or rewrites a request", t => {
  const f = fixture(t), rows = [
    { row: 1, action: "record_distinct", reason: "  Kept exactly  " },
    { row: 2, action: "link_existing", reason: "Explicit original link", event_id: "synthetic-event" },
    { row: 3, action: "link_prior_row", reason: "Explicit prior link", prior_row: 1 },
  ];
  const payload = "\ufeff" + JSON.stringify({ ...f.command, csv_review: { ...f.review, rows } }, null, 2);
  assert.deepEqual(recoveryResolutionDrafts(payload), { acknowledged: true, drafts: {
    1: { action: "record_distinct", reason: "  Kept exactly  ", event_id: "", prior_row: "" },
    2: { action: "link_existing", reason: "Explicit original link", event_id: "synthetic-event", prior_row: "" },
    3: { action: "link_prior_row", reason: "Explicit prior link", event_id: "", prior_row: "1" },
  } });
  for (const bad of [
    { ...f.review, acknowledge_unverified_mapping: false }, { ...f.review, rows: [rows[0], rows[0]] },
    { ...f.review, rows: [{ ...rows[2], prior_row: 3 }] }, { ...f.review, rows: [{ ...rows[0], reason: " " }] },
    { ...f.review, rows: [{ ...rows[0], event_id: "unexpected" }] }, { ...f.review, rows: [{ ...rows[0], row: 0 }] },
  ]) assert.deepEqual(recoveryResolutionDrafts(JSON.stringify({ ...f.command, csv_review: bad })), { drafts: {}, acknowledged: false });
  assert.deepEqual(recoveryResolutionDrafts('{"action":"confirm_import","action":"other"}'), { drafts: {}, acknowledged: false });
});

test("recovery client emits only browser-safe runtime imports", () => {
  const source = readFileSync(new URL("../src/components/workbench/csv-recovery-client.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const dependencies = [...compiled.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]);
  assert.deepEqual(dependencies.sort(), ["../../server/strict-json", "zod"]);
  assert.doesNotMatch(compiled, /\bBuffer\b|node:|better-sqlite3|csv-confirmation-recovery-types/);
});
