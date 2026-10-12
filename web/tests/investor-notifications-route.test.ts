import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError, requireSameOrigin } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";
import { investorNoticeReadSchema } from "../src/server/investor/notification-schemas";

const compiled = ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/investor/notifications/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const binding = "a".repeat(64), origin = "https://synthetic.example.test", sid = "synthetic-session";
const input = { notice_id: "fictional-notice", publication_hash: "c".repeat(64) };
function request(body: BodyInit = JSON.stringify(input), headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/workbench/investor/notifications`, { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json", "X-Workbench-Session-Binding": binding, ...headers,
  }, body });
}
function harness(options: { denied?: boolean; changed?: "sid" | "owner"; effectError?: Error } = {}) {
  const calls: string[] = [], captured: unknown[][] = []; let count = 0, currentRequest: Request;
  const authenticate = async () => {
    calls.push("authenticate"); count++;
    if (options.denied) throw new AuthError("UNAUTHENTICATED", 401);
    return { userId: options.changed === "owner" && count > 1 ? "foreign-owner" : "synthetic-owner", sessionId: options.changed === "sid" && count > 1 ? "foreign-session" : sid };
  };
  const db = { close: () => calls.push("close") };
  const effect = (name: string, ...args: unknown[]) => {
    calls.push(name); captured.push(args);
    if (name === "acknowledge") investorNoticeReadSchema.parse(args[2]);
    if (options.effectError) throw options.effectError;
    return { synthetic_result: name };
  };
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireApiSession: authenticate, requireMutationSession: async () => {
      const session = await authenticate(); requireSameOrigin(currentRequest.headers, { origin } as Parameters<typeof requireSameOrigin>[1]); return session;
    } },
    "@/server/auth/session-binding": { sessionBinding: () => binding, assertRequestSessionBinding: (value: Request) => {
      calls.push("binding"); if (value.headers.get("x-workbench-session-binding") !== binding) throw new AuthError("SESSION_CHANGED", 401);
    } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return db; } },
    "@/server/strict-json": { parseStrictJson },
    "@/server/investor/notification-schemas": { investorNoticeReadSchema },
    "@/server/investor/notifications": { readInvestorNotifications: (...args: unknown[]) => effect("list", ...args), readInvestorNotification: (...args: unknown[]) => effect("acknowledge", ...args) },
  };
  const module = { exports: {} as { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> } };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, URL, TextDecoder }) as (require: (name: string) => unknown, module: unknown, exports: unknown) => void;
  initialize(name => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  return { calls, captured, GET: (value: Request) => { currentRequest = value; return module.exports.GET(value); }, POST: (value: Request) => { currentRequest = value; return module.exports.POST(value); } };
}

test("notice route rejects anonymous, missing/stale bindings and cross-origin mutations before reading a body or opening a database", async () => {
  for (const item of ["anonymous", "missing", "stale", "origin", "cross-site"]) {
    const h = harness({ denied: item === "anonymous" }), req = request();
    if (item === "missing") req.headers.delete("x-workbench-session-binding");
    if (item === "stale") req.headers.set("x-workbench-session-binding", "b".repeat(64));
    if (item === "origin") req.headers.set("origin", "https://foreign.example.test");
    if (item === "cross-site") req.headers.set("sec-fetch-site", "cross-site");
    const response = await h.POST(req);
    assert.equal(response.status, item === "missing" ? 400 : item === "origin" || item === "cross-site" ? 403 : 401, item);
    assert.equal(req.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
  }
});

test("both notice methods recheck the session before database access and reject all query parameters", async () => {
  for (const method of ["GET", "POST"] as const) for (const changed of ["sid", "owner"] as const) {
    const h = harness({ changed }), req = method === "POST" ? request() : new Request(`${origin}/api/workbench/investor/notifications`, { headers: { "x-workbench-session-binding": binding } });
    assert.equal((await h[method](req)).status, 401); assert.equal(h.calls.includes("open"), false);
  }
  for (const method of ["GET", "POST"] as const) {
    const h = harness(), original = request(), req = new Request(`${original.url}?owner=foreign&owner=second`, method === "POST" ? original : { headers: original.headers });
    assert.equal((await h[method](req)).status, 400); assert.equal(req.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
  }
});

test("notice route uses server owner identity, bounds effects and returns no-store session-bound responses", async () => {
  for (const method of ["GET", "POST"] as const) {
    const h = harness(), req = method === "POST" ? request() : new Request(`${origin}/api/workbench/investor/notifications`, { headers: { "x-workbench-session-binding": binding } });
    const response = await h[method](req), expected = method === "POST" ? "acknowledge" : "list";
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { synthetic_result: expected, session_binding: binding });
    assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "Cookie");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(JSON.parse(JSON.stringify(h.captured[0][1])), { id: "synthetic-owner" });
    assert.equal(h.calls.filter(call => call === expected).length, 1); assert.equal(h.calls.at(-1), "close");
    if (method === "POST") assert.deepEqual(h.captured[0][2], input);
  }
});

test("notice request reader rejects malformed/duplicate JSON, invalid UTF-8, declared and streamed oversize before any database access", async () => {
  const cases: [BodyInit, Record<string, string>, number][] = [
    ['{"notice_id":"first","notice_id":"second","publication_hash":"' + input.publication_hash + '"}', {}, 400],
    ["PRIVATE_FIXTURE_MARKER", {}, 400], [new Uint8Array([0xc3, 0x28]), {}, 400],
    ["x".repeat(1025), {}, 413], ["{}", { "Content-Length": "1025" }, 413], ["{}", { "Content-Length": "-1" }, 413],
    ["{}", { "Content-Type": "text/plain" }, 415],
  ];
  for (const [body, headers, status] of cases) {
    const h = harness(), response = await h.POST(request(body, headers)); assert.equal(response.status, status);
    assert.equal(h.calls.includes("open"), false); assert.doesNotMatch(await response.text(), /PRIVATE_FIXTURE_MARKER|first|second/);
  }
});

test("strict acknowledgement rejects owner injection while operational errors never disclose native paths, data or stack", async () => {
  const h = harness(), invalid = await h.POST(request(JSON.stringify({ ...input, owner_id: "foreign" })));
  assert.equal(invalid.status, 400); assert.equal(h.calls.includes("open"), false);
  for (const [code, status] of [["WORKBENCH_READ_ONLY", 423], ["INVESTOR_NOTIFICATION_NOT_FOUND", 404], ["INVESTOR_NOTIFICATION_CHANGED", 409],
    ["INVESTOR_NOTIFICATION_EVIDENCE_INVALID", 503], ["SQLITE_BUSY /private/FIXTURE_SECRET", 503]] as const) {
    for (const method of ["GET", "POST"] as const) {
      const f = harness({ effectError: new Error(code) }), req = method === "POST" ? request() : new Request(`${origin}/api/workbench/investor/notifications`, { headers: { "x-workbench-session-binding": binding } });
      const response = await f[method](req); assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: status === 503 ? "INVESTOR_NOTIFICATIONS_UNAVAILABLE" : code }); assert.equal(f.calls.at(-1), "close");
    }
  }
  const brokenStoredRecord = harness({ effectError: new z.ZodError([{ code: "custom", path: [], message: "PRIVATE_FIXTURE_MARKER" }]) });
  const storedError = await brokenStoredRecord.GET(new Request(`${origin}/api/workbench/investor/notifications`, { headers: { "x-workbench-session-binding": binding } }));
  assert.equal(storedError.status, 503); assert.deepEqual(await storedError.json(), { error: "INVESTOR_NOTIFICATIONS_UNAVAILABLE" });
});
