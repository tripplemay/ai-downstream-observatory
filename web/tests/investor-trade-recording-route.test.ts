import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError, requireSameOrigin } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";
import { investorCommandSchema } from "../src/server/investor/schemas";
import { isInvestorClientError } from "../src/server/investor/service";
import { buildCashRecordingIntent } from "../src/components/workbench/investor-cash-recording-client";
import { cashContext, validCashDraft } from "./investor-cash-recording-fixture";

const binding = "a".repeat(64), origin = "https://synthetic.example.test";
const input = { action: "record_linked_trade_fact", expected_revision: 2, idempotency_key: "fictional-command", portfolio_id: "fictional-book", account_id: "fictional-account",
  expected_ledger_revision: 3, expected_account_row_version: 4, expected_link_id: "fictional-link", expected_link_version: 1, expected_context_hash: "c".repeat(64),
  basis: "operator_transcription_not_broker_file", acknowledgement: true, source_id: "FICTIONAL", source_event_id: "1", source_reference: "Fictional source",
  effective_date: "2026-01-01", source_timezone: "UTC", entry: { type: "buy", listing_id: "fictional-listing", currency: "USD", quantity: "1", consideration: "10", fee: "0" } };
function request(body: BodyInit = JSON.stringify(input), headers: Record<string, string> = {}, query = "") {
  return new Request(`${origin}/api/workbench/investor${query}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json",
    "X-Workbench-Session-Binding": binding, ...headers }, body });
}
function readRequest(query = "?account=fictional-account", cash = false) { return new Request(`${origin}/api/workbench/investor/${cash ? "cash-recording" : "trade-recording"}${query}`, { headers: { "X-Workbench-Session-Binding": binding } }); }
function harness(options: { denied?: boolean; changed?: "sid" | "owner"; effectError?: Error; cash?: boolean } = {}) {
  const calls: string[] = [], captured: unknown[][] = []; let count = 0, currentRequest: Request;
  const authenticate = async () => { calls.push("authenticate"); count++;
    if (options.denied) throw new AuthError("UNAUTHENTICATED", 401);
    return { userId: options.changed === "owner" && count > 1 ? "foreign" : "fictional-owner", sessionId: options.changed === "sid" && count > 1 ? "foreign-session" : "fictional-session" };
  };
  const db = { close: () => calls.push("close") };
  const effect = (name: string, ...args: unknown[]) => {
    if (name === "execute") investorCommandSchema.parse(args[2]);
    calls.push(name); captured.push(args); if (options.effectError) throw options.effectError;
    return { synthetic_result: name };
  };
  const dependencies: Record<string, unknown> = { "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireApiSession: authenticate, requireMutationSession: async () => { const session = await authenticate();
      requireSameOrigin(currentRequest.headers, { origin } as Parameters<typeof requireSameOrigin>[1]); return session; } },
    "@/server/auth/session-binding": { sessionBinding: () => binding, assertRequestSessionBinding: (req: Request) => {
      calls.push("binding"); const value = req.headers.get("x-workbench-session-binding"); if (value && value !== binding) throw new AuthError("SESSION_CHANGED", 401);
    } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return db; } }, "@/server/strict-json": { parseStrictJson },
    "@/server/investor/service": { executeInvestorCommand: (...args: unknown[]) => effect("execute", ...args), getInvestorState: () => ({}), isInvestorClientError },
    "@/server/investor/trade-recording": { getTradeRecordingContext: (...args: unknown[]) => effect("context", ...args) },
    "@/server/investor/cash-recording": { getCashRecordingContext: (...args: unknown[]) => effect("context", ...args) } };
  function load(file: string) {
    const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} as { GET?: (req: Request) => Promise<Response>; POST?: (req: Request) => Promise<Response> } };
    const initialize = runInNewContext(`(function(require,module,exports){${code}\n})`, { Error, Buffer, URL, TextDecoder }) as (require: (name: string) => unknown, module: unknown, exports: unknown) => void;
    initialize(name => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports); return module.exports;
  }
  const read = load(`../src/app/api/workbench/investor/${options.cash ? "cash-recording" : "trade-recording"}/route.ts`), write = load("../src/app/api/workbench/investor/route.ts");
  return { calls, captured, GET: (req: Request) => { currentRequest = req; return read.GET!(req); }, POST: (req: Request) => { currentRequest = req; return write.POST!(req); } };
}

test("manual metadata requires authentication, mandatory binding and one valid account; no invalid read opens a database", async () => {
  for (const kind of ["anonymous", "missing", "stale", "absent-account", "duplicate-account", "owner-injection", "invalid-account"]) {
    const h = harness({ denied: kind === "anonymous" }), req = readRequest(kind === "absent-account" ? "" : kind === "duplicate-account" ? "?account=first&account=second"
      : kind === "owner-injection" ? "?account=fictional-account&owner=foreign" : kind === "invalid-account" ? "?account=%2Fetc" : undefined);
    if (kind === "missing") req.headers.delete("x-workbench-session-binding"); if (kind === "stale") req.headers.set("x-workbench-session-binding", "b".repeat(64));
    assert.equal((await h.GET(req)).status, kind === "anonymous" || kind === "stale" ? 401 : 400, kind); assert.equal(h.calls.includes("open"), false);
  }
});

test("cash endpoint and command use the same strict session/origin/body boundary without allowing implicit cash facts", async () => {
  const body = JSON.stringify({ ...buildCashRecordingIntent(cashContext, validCashDraft()), expected_revision: 2, idempotency_key: "fictional-cash" });
  for (const method of ["GET", "POST"] as const) {
    const h = harness({ cash: true }), response = await h[method](method === "GET" ? readRequest(undefined, true) : request(body));
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(h.calls.at(-1), "close");
    for (const denied of ["anonymous", "missing", "stale", "changed-owner", "query"]) {
      const guard = harness({ cash: true, denied: denied === "anonymous", changed: denied === "changed-owner" ? "owner" : undefined });
      const req = method === "GET" ? readRequest(denied === "query" ? "?account=fictional-account&owner=foreign" : undefined, true)
        : request(body, {}, denied === "query" ? "?owner=foreign" : "");
      if (denied === "missing") req.headers.delete("x-workbench-session-binding");
      if (denied === "stale") req.headers.set("x-workbench-session-binding", "b".repeat(64));
      assert.equal((await guard[method](req)).status, ["missing", "query"].includes(denied) ? 400 : 401, denied);
      assert.equal(guard.calls.includes("open"), false);
    }
  }
  for (const [code, status] of [["INVESTOR_CASH_CONTEXT_CONFLICT", 409], ["INVESTOR_CASH_ACCOUNT_DISABLED", 400], ["INVESTOR_CASH_SOURCE_DUPLICATE_CONFLICT", 409], ["WORKBENCH_READ_ONLY", 423]] as const) {
    const h = harness({ cash: true, effectError: new Error(code) }); assert.equal((await h.POST(request(body))).status, status);
  }
  const h = harness({ cash: true, effectError: new Error("PRIVATE_CASH_MARKER /private/fixture") }), response = await h.GET(readRequest(undefined, true));
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "INVESTOR_CASH_UNAVAILABLE" });
  const noOrigin = harness({ cash: true }), req = request(body, { Origin: "https://foreign.example.test" });
  assert.equal((await noOrigin.POST(req)).status, 403); assert.equal(req.bodyUsed, false);
});

test("manual writes reject anonymous, stale sessions and cross-origin requests before reading the body; both methods recheck owner and SID", async () => {
  for (const kind of ["anonymous", "stale", "origin", "cross-site"]) {
    const h = harness({ denied: kind === "anonymous" }), req = request();
    if (kind === "stale") req.headers.set("x-workbench-session-binding", "b".repeat(64));
    if (kind === "origin") req.headers.set("origin", "https://foreign.example.test"); if (kind === "cross-site") req.headers.set("sec-fetch-site", "cross-site");
    assert.equal((await h.POST(req)).status, kind === "origin" || kind === "cross-site" ? 403 : 401); assert.equal(req.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
  }
  for (const method of ["GET", "POST"] as const) for (const changed of ["sid", "owner"] as const) {
    const h = harness({ changed }); assert.equal((await h[method](method === "GET" ? readRequest() : request())).status, 401); assert.equal(h.calls.includes("open"), false);
  }
  for (const req of [request(), request(JSON.stringify(input), {}, "?owner=foreign")]) {
    if (!new URL(req.url).search) req.headers.delete("x-workbench-session-binding");
    const h = harness(); assert.equal((await h.POST(req)).status, 400); assert.equal(h.calls.includes("open"), false);
  }
});

test("manual body parser rejects duplicate keys, malformed UTF-8 and oversized bodies; strict intent rejects injected fields", async () => {
  for (const [body, headers, status] of [
    ['{"action":"record_linked_trade_fact","action":"save_profile"}', {}, 400], [new Uint8Array([0xc3, 0x28]), {}, 400],
    ["PRIVATE_FIXTURE_MARKER", {}, 400], ["x".repeat(32769), {}, 413], ["{}", { "Content-Length": "32769" }, 413],
    ["{}", { "Content-Type": "text/plain" }, 415],
  ] as [BodyInit, Record<string, string>, number][]) {
    const h = harness(), response = await h.POST(request(body, headers)); assert.equal(response.status, status); assert.equal(h.calls.includes("open"), false);
    assert.doesNotMatch(await response.text(), /PRIVATE_FIXTURE_MARKER/);
  }
  const h = harness(); assert.equal((await h.POST(request(JSON.stringify({ ...input, owner_id: "foreign" })))).status, 400);
  assert.equal(h.calls.includes("execute"), false);
});

test("one verified manual command uses server owner, no-store receipt and bounded effect; native errors are never disclosed", async () => {
  for (const method of ["GET", "POST"] as const) {
    const h = harness(), response = await h[method](method === "GET" ? readRequest() : request()); assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "Cookie"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await response.json(), { synthetic_result: method === "GET" ? "context" : "execute", session_binding: binding });
    assert.deepEqual(JSON.parse(JSON.stringify(h.captured[0][1])), { id: "fictional-owner" }); assert.equal(h.calls.at(-1), "close");
    assert.equal(h.calls.filter(name => name === (method === "GET" ? "context" : "execute")).length, 1);
  }
  for (const [code, status] of [["INVESTOR_TRADE_CONTEXT_CONFLICT", 409], ["INVESTOR_TRADE_ACCOUNT_DISABLED", 400], ["WORKBENCH_READ_ONLY", 423], ["INVESTOR_ACCOUNT_OUT_OF_SCOPE", 403], ["SQLITE_BUSY /private/FIXTURE_SECRET", 503]] as const) {
    const h = harness({ effectError: new Error(code) }), response = await h.POST(request()); assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: status === 503 ? "INVESTOR_UNAVAILABLE" : code }); assert.equal(h.calls.at(-1), "close");
  }
  const h = harness({ effectError: new Error("SQLITE_BUSY /private/FIXTURE_SECRET") }), response = await h.GET(readRequest());
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "INVESTOR_TRADE_UNAVAILABLE" }); assert.equal(h.calls.at(-1), "close");
});
