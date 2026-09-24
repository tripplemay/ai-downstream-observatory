import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { queryCsvBackground } from "../src/server/csv-background/queries";
import { cancelCsvBackgroundRequest } from "../src/server/csv-background/service";
import { canonical, hash } from "../src/server/ledger/service";
import { csvBackgroundQueryFixture } from "./csv-background-query-fixture";

test("background owner-scoped queries expose no original input or creating-session keys and never dispatch", t => {
  const f = csvBackgroundQueryFixture(t), request = f.enqueue();
  const result = queryCsvBackground(f.db, { ...f.principal, sessionHash: "b".repeat(64) }, { portfolio_id: f.portfolio, request_id: request.request_id }, f.options);
  assert.ok("item" in result); assert.equal(result.item.status, "queued"); assert.equal(result.item.job, null); assert.equal(result.item.result, null);
  assert.doesNotMatch(JSON.stringify(result), /input_json|csv_bytes|payload_text|session_hash|idempotency_key|synthetic\.csv/);
  for (const [actorId, portfolio] of [["foreign", f.portfolio], ["owner", "foreign"]]) assert.throws(() => queryCsvBackground(f.db, { ...f.principal, actorId }, { portfolio_id: portfolio, request_id: request.request_id }, f.options), /NOT_FOUND/);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM job_runs").get() as { n: number }).n, 0);
});
test("background list keysets bind actor and portfolio, and status reports cancellation or expiry without mutation", t => {
  const f = csvBackgroundQueryFixture(t), first = f.enqueue(), second = f.enqueue({ idempotency_key: "preview-2" });
  const page = queryCsvBackground(f.db, f.principal, { portfolio_id: f.portfolio, limit: 1 }, f.options); assert.ok("items" in page && page.view === "list"); assert.equal(page.items.length, 1); assert.ok(page.next_cursor);
  const tail = queryCsvBackground(f.db, f.principal, { portfolio_id: f.portfolio, limit: 1, cursor: page.next_cursor! }, f.options); assert.ok("items" in tail); assert.equal(tail.items.length, 1); assert.notDeepEqual(tail.items, page.items); assert.equal(tail.next_cursor, null);
  assert.throws(() => queryCsvBackground(f.db, f.principal, { portfolio_id: "foreign", cursor: page.next_cursor! }, f.options), /CURSOR_INVALID/);
  const malformedClock = Buffer.from(canonical({ scope: hash({ actor: f.principal.actorId, portfolio: f.portfolio, view: "list" }), after: { created_at: "not-a-clock", id: first.request_id } })).toString("base64url");
  assert.throws(() => queryCsvBackground(f.db, f.principal, { portfolio_id: f.portfolio, cursor: malformedClock }, f.options), /CURSOR_INVALID/);
  cancelCsvBackgroundRequest(f.db, { ...f.principal, sessionHash: "b".repeat(64) }, { portfolio_id: f.portfolio, request_id: first.request_id, reason: "Synthetic stop" }, f.options);
  const cancelled = queryCsvBackground(f.db, f.principal, { portfolio_id: f.portfolio, request_id: first.request_id }, f.options); assert.ok("item" in cancelled); assert.equal(cancelled.item.status, "cancelled");
  const expired = queryCsvBackground(f.db, f.principal, { portfolio_id: f.portfolio, request_id: second.request_id }, { ...f.options, now: "2026-09-12T00:15:00Z" }); assert.ok("item" in expired); assert.equal(expired.item.status, "expired");
});
test("real preview rows and candidate pages use fixed result identity and actual SQL LIMIT extraction", t => {
  const f = csvBackgroundQueryFixture(t), request = f.enqueue(), published = f.publish(request.request_id);
  const queries: string[] = [], original = f.db.prepare.bind(f.db);
  f.db.prepare = ((sql: string) => { queries.push(sql); return original(sql); }) as typeof f.db.prepare;
  const input = { portfolio_id: f.portfolio, request_id: request.request_id, view: "rows" as const, limit: 2 };
  const page = queryCsvBackground(f.db, f.principal, input, f.options); assert.ok("items" in page && page.view === "rows"); assert.equal(page.items.length, 2); assert.equal(page.items[0].row, 1); assert.equal(page.total, 27);
  assert.ok(queries.some(sql => /FROM import_rows WHERE batch_id=\? AND row_number>\? ORDER BY row_number LIMIT \?/.test(sql)));
  const tail = queryCsvBackground(f.db, f.principal, { ...input, cursor: page.next_cursor! }, f.options); assert.ok("items" in tail && tail.view === "rows"); assert.equal(tail.items[0].row, 3); assert.equal(tail.result_hash, page.result_hash); assert.equal(tail.preview_hash, published.preview_hash);
  const candidate = queryCsvBackground(f.db, f.principal, { ...input, view: "candidates", row: 27, kind: "exact_prior_rows" }, f.options); assert.ok("items" in candidate && candidate.view === "candidates"); assert.equal(candidate.total, 26); assert.deepEqual(candidate.items, [1, 2]);
  for (const patch of [{ row: 26 }, { kind: "possible_prior_rows" as const }, { view: "rows" as const, row: undefined, kind: undefined }]) assert.throws(() => queryCsvBackground(f.db, f.principal, { ...input, view: "candidates", row: 27, kind: "exact_prior_rows", ...patch, cursor: candidate.next_cursor! }, f.options), /CURSOR_INVALID/);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM ledger_events").get() as { n: number }).n, 0);
});
test("real confirmation receipts remain paged proof-bound and readable in recovery readonly", t => {
  const f = csvBackgroundQueryFixture(t), previewRequest = f.enqueue(), preview = f.publish(previewRequest.request_id), request = f.confirm(preview.batch_id), actual = f.publish(request.request_id);
  const input = { portfolio_id: f.portfolio, request_id: request.request_id, view: "receipts" as const, limit: 2 };
  const page = queryCsvBackground(f.db, f.principal, input, f.options); assert.ok("items" in page && page.view === "receipts"); assert.equal(page.items.length, 2); assert.equal(page.total, 27); assert.equal(page.receipts_hash, actual.receipts_hash);
  writeFileSync(path.join(f.dir, "RESTORE_PENDING_REVIEW"), "synthetic readonly");
  const tail = queryCsvBackground(f.db, { ...f.principal, sessionHash: "b".repeat(64) }, { ...input, cursor: page.next_cursor! }, f.options); assert.ok("items" in tail && tail.view === "receipts"); assert.equal(tail.read_only, true); assert.equal(tail.items[0].row, 3);
  assert.throws(() => queryCsvBackground(f.db, f.principal, { ...input, request_id: previewRequest.request_id }, f.options), /RECEIPTS_UNAVAILABLE/);
  const original = queryCsvBackground(f.db, f.principal, { portfolio_id: f.portfolio, request_id: previewRequest.request_id }, f.options); assert.ok("item" in original); assert.equal(original.item.result?.batch_status, "preview");
});
test("invalid/mixed selectors, pending pages and corrupted domain evidence fail closed", t => {
  const f = csvBackgroundQueryFixture(t), request = f.enqueue();
  for (const patch of [{ view: "rows" }, { request_id: request.request_id, view: "status", limit: 1 }, { request_id: request.request_id, view: "candidates", row: 1 }, { limit: 21 }, { raw: true }]) assert.throws(() => queryCsvBackground(f.db, f.principal, { portfolio_id: f.portfolio, ...patch } as never, f.options), /QUERY_INVALID/);
  assert.throws(() => queryCsvBackground(f.db, f.principal, { portfolio_id: f.portfolio, request_id: request.request_id, view: "rows" }, f.options), /RESULT_NOT_READY/);
  const result = f.publish(request.request_id);
  const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='import_rows'").all() as { name: string }[];
  for (const trigger of triggers) f.db.exec(`DROP TRIGGER "${trigger.name}"`);
  f.db.prepare("UPDATE import_rows SET errors_json='[]',normalized_json=NULL WHERE batch_id=? AND row_number=27").run(result.batch_id);
  assert.throws(() => queryCsvBackground(f.db, f.principal, { portfolio_id: f.portfolio, request_id: request.request_id, view: "rows", limit: 1 }, f.options), /EVIDENCE_INVALID/);
});
test("page projections reject unproved extra wrapper keys instead of leaking data or replacing SQL row numbers", t => {
  for (const view of ["rows", "receipts"] as const) {
    const f = csvBackgroundQueryFixture(t, 3), previewRequest = f.enqueue(), preview = f.publish(previewRequest.request_id);
    const request = view === "rows" ? previewRequest : f.confirm(preview.batch_id);
    if (view === "receipts") f.publish(request.request_id);
    const table = view === "rows" ? "import_rows" : "csv_import_outcomes", field = view === "rows" ? "raw_json" : "result_json";
    const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as { name: string }[];
    for (const trigger of triggers) f.db.exec(`DROP TRIGGER "${trigger.name}"`);
    const stored = f.db.prepare(`SELECT ${field} AS raw FROM ${table} WHERE batch_id=? AND row_number=1`).get(preview.batch_id) as { raw: string };
    f.db.prepare(`UPDATE ${table} SET ${field}=? WHERE batch_id=? AND row_number=1`).run(JSON.stringify({ ...JSON.parse(stored.raw), row: 10000, payload_text: "SYNTHETIC_PRIVATE_EXTRA" }), preview.batch_id);
    assert.throws(() => queryCsvBackground(f.db, f.principal, { portfolio_id: f.portfolio, request_id: request.request_id, view, limit: 1 }, f.options), /CSV_BACKGROUND_EVIDENCE_INVALID/);
  }
});
