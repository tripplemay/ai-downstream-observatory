import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { NextResponse } from "next/server";
import { AuthError } from "../src/server/auth/core";
import { readCsvInspectionUpload, type CsvInspectionUpload } from "../src/server/ledger/csv-inspection-upload";

const source = readFileSync(new URL("../src/app/api/workbench/csv/inspect/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function route(options: { authError?: Error; openError?: Error; inspectError?: unknown; result?: unknown } = {}) {
  const calls: string[] = [], logs: unknown[][] = [];
  let captured: CsvInspectionUpload | undefined;
  const db = { readonly: true, close() { calls.push("close"); } };
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireMutationSession: async () => {
      calls.push("authenticate-and-check-origin");
      if (options.authError) throw options.authError;
      return { userId: "owner", sessionId: "synthetic-session" };
    } },
    "@/server/ledger/csv-inspection-upload": { readCsvInspectionUpload: async (request: Request) => {
      calls.push("read-body"); return readCsvInspectionUpload(request);
    } },
    "@/server/workbench-db": { openWorkbench: () => {
      calls.push("open"); if (options.openError) throw options.openError; return db;
    } },
    "@/server/ledger/csv-inspection": { inspectCsvImport: (connection: unknown, input: CsvInspectionUpload) => {
      calls.push("inspect"); assert.equal(connection, db); captured = input;
      if (options.inspectError !== undefined) throw options.inspectError;
      return options.result ?? { schema_version: "csv-inspection-v1", state_written: false, selected: null };
    } },
  };
  const module = { exports: {} as { POST: (request: Request) => Promise<Response>; runtime: string; dynamic: string } };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, {
    Error, console: { error: (...values: unknown[]) => logs.push(values) },
  }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
  initialize(id => { assert.ok(id in dependencies, `Unexpected route dependency: ${id}`); return dependencies[id]; }, module, module.exports);
  return { post: module.exports.POST, calls, logs, captured: () => captured, exports: module.exports };
}

function form(bytes = Buffer.from("\ufeffCode,Amount\r\n000001,100.00\r\n")) {
  const body = new FormData();
  body.set("portfolio_id", "synthetic-portfolio"); body.set("account_id", "synthetic-account");
  body.set("expected_revision", "7"); body.set("dialect", "auto");
  body.set("file", new Blob([new Uint8Array(bytes)], { type: "text/csv" }), "synthetic-original.csv");
  return body;
}
const request = (body: FormData = form()) => new Request("https://workbench.example.test/api/workbench/csv/inspect", { method: "POST", body });

test("inspection route authenticates and checks Origin before reading a malformed or oversized body", async () => {
  for (const [code, status] of [["UNAUTHENTICATED", 401], ["ORIGIN_FORBIDDEN", 403], ["AUTH_NOT_CONFIGURED", 503]] as const) {
    const handler = route({ authError: new AuthError(code, status) });
    const req = new Request("https://workbench.example.test/api/workbench/csv/inspect", {
      method: "POST", headers: { "Content-Length": "999999999", "Content-Type": "text/html" }, body: "not CSV",
    });
    const response = await handler.post(req);
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: code });
    assert.equal(req.bodyUsed, false); assert.deepEqual(handler.calls, ["authenticate-and-check-origin"]);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("inspection route preserves original bytes and accepts readonly connections without mutation dependencies", async () => {
  const handler = route(), bytes = Buffer.from("\ufeffCode,Note\r\n000001,=1+1\r\n");
  const response = await handler.post(request(form(bytes)));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { schema_version: "csv-inspection-v1", state_written: false, selected: null });
  assert.deepEqual(handler.calls, ["authenticate-and-check-origin", "read-body", "open", "inspect", "close"]);
  assert.equal(handler.captured()!.expected_revision, 7); assert.equal(handler.captured()!.dialect, "auto");
  assert.deepEqual(Buffer.from(handler.captured()!.bytes), bytes);
  assert.equal(handler.exports.runtime, "nodejs"); assert.equal(handler.exports.dynamic, "force-dynamic");
});

test("inspection route rejects injected, duplicate, malformed and oversized uploads before opening a database", async () => {
  const spoofed = form(); spoofed.set("actor_id", "attacker");
  const duplicate = form(); duplicate.append("account_id", "another-account");
  const invalid = form(); invalid.set("values", '{"column":"Code","trim":false,"offset":0,"limit":100}');
  const cases: [Request, number, string][] = [
    [new Request("https://workbench.example.test/api/workbench/csv/inspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), 415, "CSV_MULTIPART_REQUIRED"],
    [new Request("https://workbench.example.test/api/workbench/csv/inspect", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": "999999999" }, body: "x" }), 413, "REQUEST_TOO_LARGE"],
    [request(spoofed), 400, "CSV_INSPECTION_FIELDS_INVALID"],
    [request(duplicate), 400, "CSV_INSPECTION_FIELDS_INVALID"],
    [request(invalid), 400, "CSV_INSPECTION_FIELDS_INVALID"],
    [request(form(Buffer.from([0xff]))), 400, "INVALID_UTF8"],
  ];
  for (const [req, status, code] of cases) {
    const handler = route(), response = await handler.post(req);
    assert.equal(response.status, status, code); assert.deepEqual(await response.json(), { error: code });
    assert.deepEqual(handler.calls, ["authenticate-and-check-origin", "read-body"]);
    if (status === 413) assert.equal(response.headers.get("connection"), "close");
  }
});

test("inspection route maps precise scope, CAS and pagination errors and closes its read connection", async () => {
  const cases: [string, number][] = [
    ["VERSION_CONFLICT", 409], ["ACCOUNT_OUT_OF_SCOPE", 403], ["PORTFOLIO_NOT_FOUND", 404],
    ["CSV_INSPECTION_FIELDS_INVALID", 400], ["CSV_INSPECTION_VALUES_UNAVAILABLE", 400],
    ["CSV_COLUMN_NOT_FOUND", 400], ["CSV_INSPECTION_VALUES_INVALID", 400], ["CSV_FILENAME_INVALID", 400],
    ["CSV_TOO_LARGE", 413], ["CSV_INSPECTION_VALUES_TOO_LARGE", 413], ["CSV_INSPECTION_RESPONSE_TOO_LARGE", 413],
  ];
  for (const [code, status] of cases) {
    const handler = route({ inspectError: new Error(code) }), response = await handler.post(request());
    assert.equal(response.status, status, code); assert.deepEqual(await response.json(), { error: code });
    assert.deepEqual(handler.calls, ["authenticate-and-check-origin", "read-body", "open", "inspect", "close"]);
    assert.equal(handler.logs.length, 0);
  }
});

test("inspection parse diagnostics remain readable without claiming a ledger preview or mutation", async () => {
  const result = { state_written: false, broker_format_verified: false, selected: { valid: false, document_errors: [{ code: "CSV_DUPLICATE_HEADER" }] } };
  const handler = route({ result }), response = await handler.post(request());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), result);
  assert.deepEqual(handler.calls, ["authenticate-and-check-origin", "read-body", "open", "inspect", "close"]);
});

test("inspection route never discloses native paths, SQL or unknown error details", async () => {
  for (const error of [new Error("SQLITE_BUSY: /private/synthetic.db SELECT secret FROM attachments"), new Error("CSV_COLUMN_NOT_FOUND:/private/fixture"), "/private/fixture"]) {
    const handler = route({ inspectError: error }), response = await handler.post(request());
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "WORKBENCH_UNAVAILABLE" });
    assert.equal(handler.calls.at(-1), "close");
    assert.deepEqual(handler.logs, [["CSV inspection failed", error instanceof Error ? "Error" : "UnknownError"]]);
  }
  const handler = route({ openError: new Error("ENOENT: /private/synthetic.db") }), response = await handler.post(request());
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "WORKBENCH_UNAVAILABLE" });
  assert.deepEqual(handler.calls, ["authenticate-and-check-origin", "read-body", "open"]);
});
