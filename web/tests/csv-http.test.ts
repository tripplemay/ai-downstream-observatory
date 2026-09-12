import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { NextResponse } from "next/server";
import { AuthError } from "../src/server/auth/core";
import { readCsvUpload, type CsvUpload } from "../src/server/ledger/csv-upload";

const source = readFileSync(new URL("../src/app/api/workbench/csv/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function route(options: { authError?: Error; openError?: Error; previewError?: unknown; result?: unknown } = {}) {
  const calls: string[] = [], logs: unknown[][] = [];
  let captured: { actor: { id: string }; input: CsvUpload } | undefined;
  const db = { close() { calls.push("close"); } };
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireMutationSession: async () => {
      calls.push("authenticate-and-check-origin");
      if (options.authError) throw options.authError;
      return { userId: "owner", sessionId: "synthetic-session" };
    } },
    "@/server/ledger/csv-upload": { readCsvUpload: async (request: Request) => { calls.push("read-body"); return readCsvUpload(request); } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); if (options.openError) throw options.openError; return db; } },
    "@/server/ledger/csv-imports": { previewCsvImport: (connection: unknown, actor: { id: string }, input: CsvUpload) => {
      calls.push("preview"); assert.equal(connection, db); captured = { actor, input };
      if (options.previewError !== undefined) throw options.previewError;
      return options.result ?? { id: "synthetic-batch", status: "preview", expected_revision: 7, rows: [] };
    } },
  };
  // Execute the real route with isolated auth/database boundaries; multipart parsing stays real.
  const module = { exports: {} as { POST: (request: Request) => Promise<Response>; runtime: string; dynamic: string } };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, {
    Error, console: { error: (...values: unknown[]) => logs.push(values) },
  }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
  initialize(id => { assert.ok(id in dependencies, `Unexpected route dependency: ${id}`); return dependencies[id]; }, module, module.exports);
  return { post: module.exports.POST, calls, logs, captured: () => captured, exports: module.exports };
}

function form(bytes = Buffer.from("\ufeffcode,amount\r\n000001,100.00\r\n")) {
  const value = new FormData();
  value.set("portfolio_id", "synthetic-portfolio"); value.set("account_id", "synthetic-account");
  value.set("expected_revision", "7"); value.set("mapping", '{"schema_version":"synthetic-mapping"}');
  value.set("file", new Blob([new Uint8Array(bytes)], { type: "text/csv" }), "synthetic-original.csv");
  return value;
}

const request = (body: FormData = form()) => new Request("https://workbench.example.test/api/workbench/csv", { method: "POST", body });

test("CSV route authenticates and checks origin before reading even malformed or oversized bodies", async () => {
  for (const [code, status] of [["UNAUTHENTICATED", 401], ["ORIGIN_FORBIDDEN", 403], ["AUTH_NOT_CONFIGURED", 503]] as const) {
    const handler = route({ authError: new AuthError(code, status) });
    const req = new Request("https://workbench.example.test/api/workbench/csv", { method: "POST", headers: { "Content-Length": "999999999", "Content-Type": "text/html" }, body: "not CSV" });
    const result = await handler.post(req);
    assert.equal(result.status, status); assert.deepEqual(await result.json(), { error: code });
    assert.equal(req.bodyUsed, false); assert.deepEqual(handler.calls, ["authenticate-and-check-origin"]);
    assert.equal(handler.logs.length, 0);
  }
});

test("CSV route streams through the bounded multipart parser, derives identity from the session and closes the database", async () => {
  const handler = route(), bytes = Buffer.from("\ufeffcode,note\r\n000001,=1+1\r\n");
  const response = await handler.post(request(form(bytes)));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { id: "synthetic-batch", status: "preview", expected_revision: 7, rows: [] });
  assert.deepEqual(handler.calls, ["authenticate-and-check-origin", "read-body", "open", "preview", "close"]);
  const captured = handler.captured()!;
  assert.equal(captured.actor.id, "owner"); assert.deepEqual(Object.keys(captured.actor), ["id"]);
  assert.equal(captured.input.portfolio_id, "synthetic-portfolio"); assert.equal(captured.input.account_id, "synthetic-account");
  assert.equal(captured.input.expected_revision, 7); assert.equal(captured.input.filename, "synthetic-original.csv");
  assert.deepEqual(Buffer.from(captured.input.bytes), bytes);
  assert.equal(handler.exports.runtime, "nodejs"); assert.equal(handler.exports.dynamic, "force-dynamic");
});

test("CSV route preserves an invalid preview as inspectable rows instead of claiming it was booked", async () => {
  const preview = { id: "invalid-batch", status: "invalid", rows: [{ row: 1, errors: ["CSV_VALUE_NOT_MAPPED"], command: null }] };
  const handler = route({ result: preview }), response = await handler.post(request());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), preview);
  assert.deepEqual(handler.calls, ["authenticate-and-check-origin", "read-body", "open", "preview", "close"]);
});

test("CSV upload validation never opens a database and size errors close the connection", async () => {
  const spoofed = form(); spoofed.set("actor", "attacker");
  const cases: [Request, number, string][] = [
    [new Request("https://workbench.example.test/api/workbench/csv", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), 415, "CSV_MULTIPART_REQUIRED"],
    [new Request("https://workbench.example.test/api/workbench/csv", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": "999999999" }, body: "x" }), 413, "REQUEST_TOO_LARGE"],
    [request(spoofed), 400, "CSV_UPLOAD_FIELDS_INVALID"],
    [request(form(Buffer.from([0xff]))), 400, "INVALID_UTF8"],
  ];
  for (const [req, status, code] of cases) {
    const handler = route(), response = await handler.post(req);
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: code });
    assert.deepEqual(handler.calls, ["authenticate-and-check-origin", "read-body"]);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    if (status === 413) assert.equal(response.headers.get("connection"), "close");
  }
});

test("CSV route maps only explicit business errors and always closes the opened database", async () => {
  const cases: [string, number][] = [
    ["VERSION_CONFLICT", 409], ["CSV_MAPPING_VERSION_CONFLICT", 409], ["CSV_FILE_ALREADY_CONFIRMED", 409],
    ["CSV_IMPORT_METHOD_CHANGED", 409], ["CSV_IMPORT_CONTEXT_CHANGED", 409], ["CSV_REVIEW_HASH_MISMATCH", 409],
    ["ACCOUNT_OUT_OF_SCOPE", 403], ["ATTACHMENT_OUT_OF_SCOPE", 403], ["CSV_REVIEW_SCOPE_MISMATCH", 403],
    ["PORTFOLIO_NOT_FOUND", 404], ["ATTACHMENT_NOT_FOUND", 404], ["UNAUTHENTICATED", 401],
    ["WORKBENCH_READ_ONLY", 423], ["ATTACHMENT_TOO_LARGE", 413], ["CSV_MAPPING_TOO_LARGE", 413], ["CSV_TOO_LARGE", 413],
    ["CSV_UPLOAD_FIELDS_INVALID", 400], ["CSV_MAPPING_INVALID", 400], ["CSV_MAPPING_JSON_INVALID", 400],
    ["CSV_REVIEW_CANDIDATE_LIMIT", 400], ["INVALID_ATTACHMENT_UTF8", 400], ["INVALID_ATTACHMENT_BYTES", 400],
  ];
  for (const [code, status] of cases) {
    const handler = route({ previewError: new Error(code) }), response = await handler.post(request());
    assert.equal(response.status, status, code); assert.deepEqual(await response.json(), { error: code });
    assert.deepEqual(handler.calls, ["authenticate-and-check-origin", "read-body", "open", "preview", "close"]);
    assert.equal(handler.logs.length, 0);
    if (status === 413) assert.equal(response.headers.get("connection"), "close");
  }
  const handler = route({ previewError: new Error("CSV_MAPPING_INVALID:/private/synthetic-secret.json") });
  const response = await handler.post(request());
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "CSV_MAPPING_INVALID" });
});

test("native errors and corrupt persisted evidence return a generic failure without path or SQL disclosure", async () => {
  for (const error of [
    new Error("SQLITE_BUSY: /private/synthetic/workbench.db SELECT secret FROM attachments"),
    new Error("CSV_IMPORT_EVIDENCE_INVALID"), new Error("CSV_IMPORT_EVIDENCE_MISSING"),
    new Error("CSV_IMPORT_OUTCOMES_INVALID"), new Error("CSV_CONTEXT_INVALID"),
    new Error("CSV_CONFIRM_TRANSACTION_REQUIRED"), new Error("ATTACHMENT_HASH_MISMATCH"),
    new Error("CSV_NOT_A_RECOGNIZED_ERROR:/private/fixture"), "/private/fixture",
  ]) {
    const handler = route({ previewError: error }), response = await handler.post(request());
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "WORKBENCH_UNAVAILABLE" });
    assert.equal(handler.calls.at(-1), "close");
    assert.deepEqual(handler.logs, [["CSV upload failed", error instanceof Error ? "Error" : "UnknownError"]]);
  }
  const handler = route({ openError: new Error("ENOENT: /private/synthetic/workbench.db") }), response = await handler.post(request());
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "WORKBENCH_UNAVAILABLE" });
  assert.deepEqual(handler.calls, ["authenticate-and-check-origin", "read-body", "open"]);
});
