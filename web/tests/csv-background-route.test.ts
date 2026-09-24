import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError, tokenHash } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";
import { readCsvUpload } from "../src/server/ledger/csv-upload";
import * as bindingModule from "../src/server/csv-background/binding";
import { csvBackgroundQuerySchema } from "../src/server/csv-background/queries";
import { isCsvBackgroundClientError } from "../src/server/csv-background/service";

const sid = "synthetic-session", binding = tokenHash(`workbench-client-session-v1:${sid}`), url = "https://synthetic.invalid/api/workbench/csv/jobs";
const confirm = { action: "confirm", command: { portfolio_id: "p", account_id: "a", idempotency_key: "synthetic-key", payload_text: " \n{\"batch_id\":\"synthetic\"}\t", acknowledge_background_execution: true } };
const cancel = { action: "cancel", command: { portfolio_id: "p", request_id: "r", reason: "Synthetic explicit cancellation" } };
const compiled = ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/csv/jobs/route.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function harness(options: { denied?: number; changedAt?: number; userChanged?: boolean; failure?: string } = {}) {
  let auth = 0; const calls: string[] = [], args: unknown[][] = [];
  const authenticate = async () => { calls.push("auth"); ++auth; if (options.denied) throw new AuthError(options.denied === 403 ? "INVALID_ORIGIN" : "UNAUTHENTICATED", options.denied);
    return { sessionId: options.changedAt && auth >= options.changedAt && !options.userChanged ? "changed-session" : sid, userId: options.changedAt && auth >= options.changedAt && options.userChanged ? "changed-user" : "synthetic-owner" }; };
  const effect = (name: string, values: unknown[]) => { calls.push(name); args.push(values); if (options.failure) throw new Error(options.failure); return { synthetic: name }; };
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError, tokenHash },
    "@/server/auth/session": { requireApiSession: authenticate, requireMutationSession: authenticate },
    "@/server/auth/session-binding": { sessionBinding: (value: string) => tokenHash(`workbench-client-session-v1:${value}`), assertRequestSessionBinding: (request: Request, value: string) => {
      calls.push("bind"); if (request.headers.has("X-Workbench-Session-Binding") && request.headers.get("X-Workbench-Session-Binding") !== tokenHash(`workbench-client-session-v1:${value}`)) throw new AuthError("SESSION_CHANGED", 401);
    } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return { close() { calls.push("close"); } }; } },
    "@/server/strict-json": { parseStrictJson }, "@/server/ledger/csv-upload": { readCsvUpload }, "@/server/csv-background/binding": bindingModule,
    "@/server/csv-background/service": { isCsvBackgroundClientError, requestCsvBackgroundPreview: (...values: unknown[]) => effect("preview", values),
      requestCsvBackgroundConfirmation: (...values: unknown[]) => effect("confirm", values), cancelCsvBackgroundRequest: (...values: unknown[]) => effect("cancel", values) },
    "@/server/csv-background/queries": { csvBackgroundQuerySchema, queryCsvBackground: (...values: unknown[]) => effect("query", values) },
  };
  const module = { exports: {} as { GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response> } };
  const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, URL, Request, TextDecoder });
  execute((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  return { ...module.exports, calls, args };
}
const post = (raw = JSON.stringify(confirm)) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, body: raw });
const get = (query = "portfolio=p") => new Request(`${url}?${query}`, { headers: { "X-Workbench-Session-Binding": binding } });
function upload(patch?: (form: FormData) => void) {
  const form = new FormData(); form.set("portfolio_id", "p"); form.set("account_id", "a"); form.set("expected_revision", "0");
  form.set("mapping", " \r\n{\"synthetic\":true}\t"); form.set("file", new Blob(["\ufeffid,value\r\nx,1\r\n"], { type: "text/csv" }), "synthetic.csv"); patch?.(form);
  return new Request(url, { method: "POST", headers: { "X-Workbench-Session-Binding": binding, "X-CSV-Idempotency-Key": "synthetic-upload", "X-CSV-Background-Acknowledged": "true" }, body: form });
}
function plain(value: unknown) { return JSON.parse(JSON.stringify(value)); }

test("background API authenticates session/Origin and requires current binding before parsing or storage", async () => {
  for (const denied of [401, 403]) {
    const h = harness({ denied }), request = post("NOT JSON"); assert.equal((await h.POST(request)).status, denied); assert.equal(request.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
    assert.equal((await h.GET(get("portfolio=p&portfolio=q"))).status, denied);
  }
  for (const method of ["GET", "POST"] as const) for (const value of [null, "", "b".repeat(64)]) {
    const h = harness(), request = method === "GET" ? get() : post(); if (value === null) request.headers.delete("X-Workbench-Session-Binding"); else request.headers.set("X-Workbench-Session-Binding", value);
    assert.equal((await h[method](request)).status, 401); assert.equal(request.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
  }
});
test("background confirm/cancel preserve exact command bytes and use server actor/tokenHash rather than client binding", async () => {
  for (const input of [confirm, cancel]) {
    const h = harness(), response = await h.POST(post(JSON.stringify(input))); assert.equal(response.status, 200);
    assert.deepEqual(h.calls, ["auth", "bind", "auth", "bind", "open", input.action, "auth", "bind", "close"]);
    assert.deepEqual(plain(h.args[0][1]), { actorId: "synthetic-owner", sessionHash: tokenHash(sid) }); assert.notEqual(tokenHash(sid), binding);
    assert.deepEqual(plain(h.args[0][2]), input.command); assert.equal((await response.json()).session_binding, binding);
    assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "Cookie"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  for (const changedAt of [2, 3]) for (const userChanged of [false, true]) {
    const h = harness({ changedAt, userChanged }), response = await h.POST(post()); assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: "SESSION_CHANGED" });
    assert.equal(h.calls.includes("confirm"), changedAt === 3); assert.equal(h.calls.includes("open"), changedAt === 3); if (changedAt === 3) assert.equal(h.calls.at(-1), "close");
  }
});
test("background GET selectors are strict and dispatch only the scoped bounded query with current principal", async () => {
  for (const [query, expected] of [
    ["portfolio=p&limit=2", { portfolio_id: "p", limit: 2 }],
    ["portfolio=p&request=r", { portfolio_id: "p", request_id: "r" }],
    ["portfolio=p&request=r&view=rows&cursor=next&limit=2", { portfolio_id: "p", request_id: "r", view: "rows", cursor: "next", limit: 2 }],
    ["portfolio=p&request=r&view=candidates&row=12&kind=exact_prior_rows&limit=5", { portfolio_id: "p", request_id: "r", view: "candidates", row: 12, kind: "exact_prior_rows", limit: 5 }],
    ["portfolio=p&request=r&view=receipts", { portfolio_id: "p", request_id: "r", view: "receipts" }],
  ] as const) {
    const h = harness(), response = await h.GET(get(query)); assert.equal(response.status, 200, query); assert.deepEqual(plain(h.args[0][2]), expected);
    assert.deepEqual(plain(h.args[0][1]), { actorId: "synthetic-owner", sessionHash: tokenHash(sid) }); assert.deepEqual(h.calls, ["auth", "bind", "open", "query", "auth", "bind", "close"]);
    assert.equal((await response.json()).session_binding, binding);
  }
  for (const query of ["", "portfolio=p&portfolio=p", "portfolio=p&raw=true", "portfolio=p&view=rows", "portfolio=p&row=1", "portfolio=p&limit=21", "portfolio=p&limit=01", "portfolio=p&limit=-1", "portfolio=p&request=r&limit=1", "portfolio=p&request=r&view=status&cursor=x", "portfolio=p&request=r&view=rows&limit=26", "portfolio=p&request=r&view=rows&row=1", "portfolio=p&request=r&view=candidates&row=1", "portfolio=p&request=r&view=candidates&row=1&kind=unknown"]) {
    const h = harness(); assert.equal((await h.GET(get(query))).status, 400, query); assert.equal(h.calls.includes("open"), false);
  }
  for (const userChanged of [false, true]) { const h = harness({ changedAt: 2, userChanged }); assert.equal((await h.GET(get())).status, 401); assert.equal(h.calls.at(-1), "close"); }
});
test("background strict JSON rejects forged fields, missing acknowledgement, duplicate keys and invalid cancellation Unicode", async () => {
  for (const command of [{ ...confirm.command, actorId: "forged" }, { ...confirm.command, session_hash: "a".repeat(64) }, { ...confirm.command, acknowledge_background_execution: false }, { ...confirm.command, expected_revision: 0 }]) {
    const h = harness(); assert.equal((await h.POST(post(JSON.stringify({ action: "confirm", command })))).status, 400); assert.equal(h.calls.includes("open"), false);
  }
  for (const reason of ["", " ", "x\ud800", "x\udfff", "x\u0000", "x\u001c", "x\u0085", "x".repeat(1001)]) {
    const h = harness(); assert.equal((await h.POST(post(JSON.stringify({ ...cancel, command: { ...cancel.command, reason } })))).status, 400); assert.equal(h.calls.includes("open"), false);
  }
  assert.equal((await harness().POST(post(JSON.stringify({ ...cancel, command: { ...cancel.command, reason: "Synthetic \ud83d\ude00" } })))).status, 200);
  for (const raw of [`{"action":"confirm","command":${JSON.stringify(confirm.command)},"command":${JSON.stringify(confirm.command)}}`, JSON.stringify({ ...confirm, actor: "forged" }), JSON.stringify({ ...confirm, action: "run_command" }), "PRIVATE_BAD_JSON"]) {
    const h = harness(), response = await h.POST(post(raw)); assert.equal(response.status, 400); assert.equal(h.calls.includes("open"), false); assert.doesNotMatch(await response.text(), /PRIVATE_BAD_JSON|forged/);
  }
  const h = harness(), request = new Request(url + "?view=status", { method: "POST", headers: post().headers, body: "NOT JSON" });
  assert.equal((await h.POST(request)).status, 400); assert.equal(request.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
});
test("background multipart requires explicit delegation headers and preserves mapping/file bytes without executing preview", async () => {
  const h = harness(), response = await h.POST(upload()); assert.equal(response.status, 200);
  const command = h.args[0][2] as { mapping: string; bytes: Uint8Array; idempotency_key: string; acknowledge_background_execution: boolean };
  assert.equal(command.mapping, " \r\n{\"synthetic\":true}\t"); assert.deepEqual(Buffer.from(command.bytes), Buffer.from("\ufeffid,value\r\nx,1\r\n"));
  assert.equal(command.idempotency_key, "synthetic-upload"); assert.equal(command.acknowledge_background_execution, true); assert.equal(h.calls.filter(value => value === "preview").length, 1);
  for (const header of ["X-CSV-Idempotency-Key", "X-CSV-Background-Acknowledged"]) for (const value of [null, "false"]) {
    const request = upload(), h = harness(); if (value === null) request.headers.delete(header); else request.headers.set(header, value);
    if (header === "X-CSV-Idempotency-Key" && value === "false") continue;
    assert.equal((await h.POST(request)).status, 400); assert.equal(request.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
  }
  for (const patch of [(form: FormData) => form.set("actor", "forged"), (form: FormData) => form.append("portfolio_id", "p"), (form: FormData) => form.delete("mapping"), (form: FormData) => form.set("expected_revision", "01")]) {
    const h = harness(); assert.equal((await h.POST(upload(patch))).status, 400); assert.equal(h.calls.includes("open"), false);
  }
});
test("background JSON supports a 5 MiB exact payload expanded by outer escaping rather than an accidental 5 MiB request cap", async () => {
  const size = bindingModule.CSV_BACKGROUND_LIMITS.payload_bytes, payload = "{}" + "\t".repeat(size - 2), raw = JSON.stringify({ ...confirm, command: { ...confirm.command, payload_text: payload } });
  assert.ok(Buffer.byteLength(raw) > size); const h = harness(); assert.equal((await h.POST(post(raw))).status, 200);
  assert.equal((h.args[0][2] as typeof confirm.command).payload_text, payload);
  const invalid = harness(); assert.equal((await invalid.POST(post(JSON.stringify({ ...confirm, command: { ...confirm.command, payload_text: payload + " " } })))).status, 400); assert.equal(invalid.calls.includes("open"), false);
});
test("background upload/JSON stream limits reject before storage without waiting for a hanging stream cancel", async () => {
  for (const [media, max] of [["application/json", 31 * 1024 * 1024], ["multipart/form-data; boundary=synthetic", 5 * 1024 * 1024]] as const) {
    const headers = new Headers(upload().headers); headers.set("Content-Type", media);
    for (const length of [String(max + 1), "NaN", "-1"]) {
      headers.set("Content-Length", length); const request = new Request(url, { method: "POST", headers, body: "x" }), h = harness();
      assert.equal((await h.POST(request)).status, 413); assert.equal(request.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
    }
    headers.delete("Content-Length"); let cancelled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(max + 1)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
    const request = new Request(url, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit), h = harness(), response = await h.POST(request);
    assert.equal(response.status, 413); assert.equal(response.headers.get("connection"), "close"); assert.equal(cancelled, true); assert.equal(h.calls.includes("open"), false);
  }
});
test("background route rejects unsupported media, content encoding, malformed UTF8 and oversized constituent upload fields", async () => {
  for (const request of [post(), upload()]) { request.headers.set("Content-Encoding", "identity"); const h = harness(); assert.equal((await h.POST(request)).status, 415); assert.equal(request.bodyUsed, false); assert.equal(h.calls.includes("open"), false); }
  const media = post(); media.headers.set("Content-Type", "text/plain"); assert.equal((await harness().POST(media)).status, 415);
  for (const media of ["application/json", "multipart/form-data; boundary=synthetic"]) {
    const headers = new Headers(upload().headers); headers.set("Content-Type", media);
    const h = harness(); assert.equal((await h.POST(new Request(url, { method: "POST", headers, body: new Uint8Array([0xc0, 0xaf]) }))).status, 400); assert.equal(h.calls.includes("open"), false);
  }
  for (const patch of [(form: FormData) => form.set("mapping", "x".repeat(256 * 1024 + 1)), (form: FormData) => form.set("file", new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]), "synthetic.csv")]) {
    const h = harness(); assert.equal((await h.POST(upload(patch))).status, 413); assert.equal(h.calls.includes("open"), false);
  }
});
test("background route safe errors preserve conflicts, readonly and scope boundaries without exposing evidence/internal messages", async () => {
  for (const [failure, status] of [["CSV_BACKGROUND_INPUT_INVALID", 400], ["CSV_BACKGROUND_CURSOR_INVALID", 400], ["CSV_BACKGROUND_QUERY_INVALID", 400], ["CSV_BACKGROUND_IDEMPOTENCY_CONFLICT", 409],
    ["CSV_BACKGROUND_RESULT_NOT_READY", 409], ["CSV_BACKGROUND_RECEIPTS_UNAVAILABLE", 409], ["CSV_BACKGROUND_NOT_FOUND", 404], ["CSV_BACKGROUND_ROW_NOT_FOUND", 404], ["ACCOUNT_OUT_OF_SCOPE", 403],
    ["WORKBENCH_READ_ONLY", 423], ["CSV_RECOVERY_PAYLOAD_TOO_LARGE", 413], ["CSV_BACKGROUND_RESPONSE_TOO_LARGE", 413], ["CSV_BACKGROUND_EVIDENCE_INVALID", 503], ["SQLITE_PRIVATE_MARKER", 503]] as const) {
    for (const method of ["POST", "GET"] as const) {
      const h = harness({ failure }), response = await h[method](method === "POST" ? post() : get()); assert.equal(response.status, status, failure); assert.deepEqual(await response.json(), { error: status === 503 ? "WORKBENCH_UNAVAILABLE" : failure });
      assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(h.calls.at(-1), "close");
    }
  }
});
