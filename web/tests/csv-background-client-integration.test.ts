import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { AuthError, tokenHash } from "../src/server/auth/core";
import { openWorkbench } from "../src/server/workbench-db";
import { parseStrictJson } from "../src/server/strict-json";
import { createAccount, createPortfolio, revision } from "../src/server/ledger/service";
import { readCsvUpload } from "../src/server/ledger/csv-upload";
import { getCsvConfirmationAttempt } from "../src/server/ledger/csv-confirmation-recovery";
import * as binding from "../src/server/csv-background/binding";
import * as service from "../src/server/csv-background/service";
import * as queries from "../src/server/csv-background/queries";
import { fetchCsvBackground, prepareCsvBackgroundConfirmation, prepareCsvBackgroundPreview, sendCsvBackground } from "../src/components/workbench/csv-background-client";

const root = path.resolve(__dirname, "../.."), endpoint = "https://synthetic.invalid/api/workbench/csv/jobs";
const compiled = ts.transpileModule(readFileSync(path.join(root, "web/src/app/api/workbench/csv/jobs/route.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const sessionModule = { exports: {} as typeof import("../src/server/auth/session-binding") };
const sessionCode = ts.transpileModule(readFileSync(path.join(root, "web/src/server/auth/session-binding.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
runInNewContext(`(function(require,module,exports){${sessionCode}\n})`, { Error })((name: string) => {
  if (name === "server-only") return {};
  assert.equal(name, "./core"); return { AuthError, tokenHash };
}, sessionModule, sessionModule.exports);
const sessionBindings = sessionModule.exports;

// Only session authentication and HTTP transport are substituted. The route, database services,
// fixed Python/Node worker and browser response verifier execute their real implementations.
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "csv-client-worker-")), filename = path.join(directory, "workbench.db");
  const oldDataDir = process.env.WORKBENCH_DATA_DIR, oldFetch = globalThis.fetch;
  process.env.WORKBENCH_DATA_DIR = directory;
  migrateWorkbench(filename); const db = openWorkbench(filename), actorId = "synthetic-client-owner";
  let sid = "synthetic-session-one";
  const portfolio = createPortfolio(db, { id: actorId }, "Synthetic client workflow");
  const account = createAccount(db, { id: actorId }, portfolio, "Synthetic", "Synthetic", "CNY");
  const mapping = " \n" + JSON.stringify({ schema_version: "csv-import-mapping-v1", mapping_id: "SYNTHETIC-CLIENT", version: 1, title: "Synthetic only",
    dialect: { encoding: "utf-8", delimiter: ",", record_separator: "either" }, expected_headers: ["date", "amount", "id", "note"], ignored_columns: [],
    account: { kind: "constant", value: account }, event_type: { kind: "constant", value: "deposit" }, source_id: "synthetic",
    source_event_id: { kind: "column", column: "id", trim: false, empty: "reject" }, reason: { kind: "column", column: "note", trim: false, empty: "reject" },
    effective_at: { column: "date", format: "YYYY-MM-DD", trim: false, source_timezone: "UTC" },
    rules: [{ event_type: "deposit", fields: { currency: { kind: "constant", value: "CNY" }, amount: { kind: "decimal", column: "amount", empty: "reject",
      format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false } } } }] }, null, 2) + "\r\n\t";
  const file = new File(["\ufeffdate,amount,id,note\r\n2026-01-01,10,s1,Original\r\n2026-01-01,10,s2,Same economic fact\r\n"], "\u5408\u6210 \"original\".csv", { type: "text/csv" });
  const authenticate = async () => ({ sessionId: sid, userId: actorId });
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError, tokenHash },
    "@/server/auth/session": { requireApiSession: authenticate, requireMutationSession: authenticate },
    "@/server/auth/session-binding": sessionBindings, "@/server/workbench-db": { openWorkbench: () => openWorkbench(filename) },
    "@/server/strict-json": { parseStrictJson }, "@/server/ledger/csv-upload": { readCsvUpload },
    "@/server/csv-background/binding": binding, "@/server/csv-background/service": service, "@/server/csv-background/queries": queries,
  };
  const module = { exports: {} as { GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response> } };
  const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, URL, Request, TextDecoder });
  execute((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  const traffic: { method: string; pathname: string }[] = [];
  let afterPost: (() => void) | null = null;
  globalThis.fetch = async (input, init) => {
    const request = new Request(new URL(String(input), endpoint), init), url = new URL(request.url);
    traffic.push({ method: request.method, pathname: url.pathname });
    if (url.pathname === "/api/auth/session") return Response.json({ authenticated: true, session_binding: sessionBindings.sessionBinding(sid) });
    assert.equal(url.pathname, "/api/workbench/csv/jobs", "No legacy endpoint or external transport is permitted");
    const response = await module.exports[request.method as "GET" | "POST"](request);
    if (request.method === "POST" && response.ok && afterPost) { const effect = afterPost; afterPost = null; effect(); }
    return response;
  };
  const options = () => ({ sessionBinding: sessionBindings.sessionBinding(sid), isCurrent: () => true });
  const worker = () => {
    const result = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3", ["-m", "worker.orchestration", "--db", filename, "--once", "--role", "core"], {
      cwd: root, encoding: "utf8", timeout: 20000, maxBuffer: 65536,
      env: { PATH: process.env.PATH, WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: directory, NODE_ENV: "test", PYTHONUNBUFFERED: "1" },
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };
  const get = (query: Omit<queries.CsvBackgroundQuery, "portfolio_id"> = {}, extra: Partial<Parameters<typeof fetchCsvBackground>[1]> = {}) =>
    fetchCsvBackground({ portfolio_id: portfolio, ...query }, { ...options(), ...extra });
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  const latest = (operation: string) => (db.prepare("SELECT id FROM csv_background_requests WHERE operation=? ORDER BY created_at DESC,id DESC LIMIT 1").get(operation) as { id: string }).id;
  const preparePreview = () => prepareCsvBackgroundPreview({ portfolioId: portfolio, accountId: account, revision: 0, file, mapping, idempotencyKey: "synthetic-preview", acknowledge: true });
  const prepareConfirm = (result: NonNullable<Awaited<ReturnType<typeof binding.readCsvBackgroundResult>>>) => {
    const payloadText = "\ufeff " + JSON.stringify({ action: "confirm_import", portfolio_id: portfolio, batch_id: result.batch_id, preview_hash: result.preview_hash,
      expected_revision: 0, csv_review: { acknowledge_unverified_mapping: true, review_hash: result.review_hash,
        rows: [{ row: 2, action: "link_prior_row", prior_row: 1, reason: "Synthetic explicit duplicate link" }] } }, null, 2) + "\r\n\t";
    return prepareCsvBackgroundConfirmation({ portfolioId: portfolio, accountId: account, idempotencyKey: "synthetic-confirm", payloadText, acknowledge: true });
  };
  return { db, directory, actorId, portfolio, account, mapping, file, traffic, options, worker, get, count, latest, preparePreview, prepareConfirm,
    afterNextPost: (effect: () => void) => { afterPost = effect; }, rotateSession: () => { sid = "synthetic-session-two"; },
    close() { globalThis.fetch = oldFetch; if (oldDataDir === undefined) delete process.env.WORKBENCH_DATA_DIR; else process.env.WORKBENCH_DATA_DIR = oldDataDir;
      db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("real worker and strict browser client recover lost preview/committed responses without duplicate facts, preserving linked receipt pagination", { timeout: 30000 }, async () => {
  const f = fixture(); try {
    const prepared = await f.preparePreview();
    f.afterNextPost(() => { throw new TypeError("Synthetic lost accepted response"); });
    await assert.rejects(sendCsvBackground(prepared, f.options()), /lost accepted/);
    assert.equal(f.count("csv_background_requests"), 1); assert.equal(f.count("job_runs"), 0); assert.equal(f.count("ledger_events"), 0);
    const previewId = f.latest("preview"), previewReceipt = await sendCsvBackground(prepared, f.options());
    assert.equal(previewReceipt.request_id, previewId); assert.equal(f.count("csv_background_requests"), 1);
    const frozen = f.db.prepare("SELECT input_json,csv_bytes FROM csv_background_requests WHERE id=?").get(previewId) as { input_json: string; csv_bytes: Buffer };
    assert.equal(JSON.parse(frozen.input_json).mapping, f.mapping); assert.equal(JSON.parse(frozen.input_json).filename, f.file.name);
    assert.deepEqual(frozen.csv_bytes, Buffer.from(await f.file.arrayBuffer()));
    f.worker();
    const preview = await f.get({ request_id: previewId, view: "status" }); assert.equal(preview.view, "status");
    if (preview.view !== "status") throw new Error("Wrong view"); assert.equal(preview.item.status, "succeeded"); assert.ok(preview.item.result);
    const review = await f.get({ request_id: previewId, view: "rows", review_only: true, limit: 1 }, { expected: preview.item });
    assert.equal(review.view, "rows"); if (review.view !== "rows") throw new Error("Wrong view");
    assert.deepEqual(review.items.map(item => item.row), [2]); assert.equal(review.total, 1);
    const candidates = await f.get({ request_id: previewId, view: "candidates", row: 2, kind: "exact_prior_rows", limit: 1 }, { expected: preview.item, expectedRow: review.items[0] });
    assert.equal(candidates.view, "candidates"); if (candidates.view !== "candidates") throw new Error("Wrong view"); assert.deepEqual(candidates.items, [1]);
    const confirmation = await f.prepareConfirm(preview.item.result);
    f.afterNextPost(() => { f.worker(); throw new TypeError("Synthetic response lost after actual commit"); });
    await assert.rejects(sendCsvBackground(confirmation, f.options()), /lost after actual commit/);
    assert.equal(f.count("ledger_events"), 1); assert.equal(revision(f.db, f.portfolio), 1); assert.equal(f.count("csv_import_outcomes"), 2);
    const confirmId = f.latest("confirm"), retry = await sendCsvBackground(confirmation, f.options());
    assert.equal(retry.request_id, confirmId); assert.equal(retry.status, "queued", "Acceptance replay is not current execution status");
    assert.equal(f.count("csv_background_requests"), 2); assert.equal(f.count("job_runs"), 2); f.worker(); assert.equal(f.count("ledger_events"), 1);
    const stored = f.db.prepare("SELECT payload_text FROM csv_confirmation_attempts").get() as { payload_text: string };
    assert.equal(stored.payload_text, confirmation.payloadText);
    const completed = await f.get({ request_id: confirmId }); assert.equal(completed.view, "status"); if (completed.view !== "status") throw new Error("Wrong view");
    assert.equal(completed.item.status, "succeeded"); assert.equal(completed.item.result?.confirmed_revision, 1);
    const first = await f.get({ request_id: confirmId, view: "receipts", limit: 1 }, { expected: completed.item });
    assert.equal(first.view, "receipts"); if (first.view !== "receipts") throw new Error("Wrong view"); assert.ok(first.next_cursor);
    const second = await f.get({ request_id: confirmId, view: "receipts", limit: 1, cursor: first.next_cursor }, { expected: completed.item });
    assert.equal(second.view, "receipts"); if (second.view !== "receipts") throw new Error("Wrong view");
    assert.equal(first.items[0].receipt.event_id, second.items[0].receipt.event_id); assert.equal(second.items[0].resolution?.action, "link_prior_row");
    assert.equal(second.next_cursor, null); assert.equal(second.total, 2);
    const historical = await f.get({ request_id: previewId, view: "preview" }, { expected: preview.item });
    assert.equal(historical.view, "preview"); if (historical.view !== "preview") throw new Error("Wrong view");
    assert.equal(preview.item.result.batch_status, "preview"); assert.equal(historical.preview.batch_status, "confirmed");
    assert.equal(historical.preview.confirmed_revision, 1);
  } finally { f.close(); }
});

test("session change after real acceptance never auto-replays; a new session reads restricted worker proof but cannot recover original confirmation bytes", { timeout: 30000 }, async () => {
  const f = fixture(); try {
    const previewReceipt = await sendCsvBackground(await f.preparePreview(), f.options()); f.worker();
    const preview = binding.readCsvBackgroundResult(f.db, previewReceipt.request_id, { dataDir: f.directory }); assert.ok(preview);
    const confirmation = await f.prepareConfirm(preview), oldOptions = f.options();
    f.afterNextPost(() => { f.rotateSession(); });
    await assert.rejects(sendCsvBackground(confirmation, oldOptions), /UNAUTHENTICATED/);
    assert.equal(f.count("csv_background_requests"), 2); assert.equal(f.count("ledger_events"), 0);
    const posts = f.traffic.filter(value => value.method === "POST").length; assert.equal(posts, 2);
    f.worker(); assert.equal(f.count("ledger_events"), 1);
    const history = await f.get(); assert.equal(history.view, "list"); if (history.view !== "list") throw new Error("Wrong view");
    const confirmed = history.items.find(item => item.operation === "confirm")!; assert.equal(confirmed.status, "succeeded");
    const current = await f.get({ request_id: confirmed.request_id }); assert.equal(current.view, "status");
    for (const forbidden of ["payload_text", "csv_bytes", "input_json", "session_hash", "idempotency_key"]) assert.equal(JSON.stringify(current).includes(`"${forbidden}"`), false);
    const attempt = f.db.prepare("SELECT id FROM csv_confirmation_attempts").get() as { id: string };
    assert.throws(() => getCsvConfirmationAttempt(f.db, { actorId: f.actorId, sessionHash: tokenHash("synthetic-session-two") }, { id: attempt.id }, { dataDir: f.directory }), /CSV_RECOVERY_NOT_FOUND/);
    await assert.rejects(fetchCsvBackground({ portfolio_id: f.portfolio }, oldOptions), /UNAUTHENTICATED/);
    assert.equal(f.traffic.filter(value => value.method === "POST").length, posts); assert.equal(f.count("csv_background_requests"), 2);
  } finally { f.close(); }
});
