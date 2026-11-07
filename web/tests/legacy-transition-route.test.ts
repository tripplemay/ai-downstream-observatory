import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";
import { investorId } from "../src/server/investor/schemas";
import { legacyTransitionInputSchema } from "../src/server/investor/legacy-transition-schemas";
import { transitionBinding as binding, transitionIntent, transitionResponse } from "./legacy-transition-client-fixture";

const compiled = ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/investor/legacy-transition/route.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function harness(options: { deny?: boolean; origin?: boolean; changeAt?: number; failure?: string } = {}) {
  const calls: string[] = [], args: unknown[][] = []; let auth = 0;
  const authenticate = async () => {
    calls.push("auth"); auth++; if (options.deny) throw new AuthError("UNAUTHENTICATED", 401); if (options.origin) throw new AuthError("ORIGIN_DENIED", 403);
    return { userId: "fictional-owner", sessionId: options.changeAt && auth >= options.changeAt ? "changed" : "same" };
  };
  const dependencies: Record<string, unknown> = { "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireApiSession: authenticate, requireMutationSession: authenticate },
    "@/server/auth/session-binding": { sessionBinding: () => binding, assertRequestSessionBinding: (request: Request) => {
      if (request.headers.get("X-Workbench-Session-Binding") !== binding) throw new AuthError("SESSION_CHANGED", 401);
    } }, "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return { close() { calls.push("close"); } }; } },
    "@/server/strict-json": { parseStrictJson }, "@/server/investor/schemas": { investorId }, "@/server/investor/legacy-transition-schemas": { legacyTransitionInputSchema },
    "@/server/investor/legacy-transition-jobs": { enqueueLegacyTransitionJob: (...input: unknown[]) => {
      calls.push("enqueue"); args.push(input); if (options.failure) throw new Error(options.failure); return { request_id: "fictional-job" };
    }, findLegacyTransitionRequest: (...input: unknown[]) => { calls.push("find"); args.push(input); return undefined; } },
    "@/server/investor/legacy-transition-read": { readLegacyTransitionResponse: (...input: unknown[]) => {
      calls.push("read"); args.push(input); return transitionResponse({ request: null, view: null });
    } } };
  const module = { exports: {} as { POST: (request: Request) => Promise<Response>; GET: (request: Request) => Promise<Response> } };
  runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, URL, TextDecoder })
    ((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  return { ...module.exports, calls, args };
}
function request(raw: string | Uint8Array = JSON.stringify(transitionIntent), method = "POST", query = "") {
  return new Request("https://fictional.example.test/api/workbench/investor/legacy-transition" + query, { method,
    headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, ...(method === "POST" ? { body: typeof raw === "string" ? raw : new Uint8Array(raw).buffer } : {}) });
}
test("auth, Origin and binding precede body/DB access; session change after enqueue withholds private facts", async () => {
  for (const opts of [{ deny: true }, { origin: true }, { changeAt: 2 }]) {
    const h = harness(opts), r = request(); assert.ok([401, 403].includes((await h.POST(r)).status)); assert.equal(h.calls.includes("open"), false);
    if (!opts.changeAt) assert.equal(r.bodyUsed, false);
  }
  const missing = request(); missing.headers.delete("X-Workbench-Session-Binding"); assert.equal((await harness().POST(missing)).status, 400); assert.equal(missing.bodyUsed, false);
  const h = harness({ changeAt: 3 }), withheld = await h.POST(request()); assert.equal(withheld.status, 401);
  assert.ok(h.calls.includes("enqueue")); assert.deepEqual(await withheld.json(), { error: "SESSION_CHANGED" }); assert.equal(h.calls.at(-1), "close");
});
test("GET never writes or falls back on nonce miss; query duplicates and cross-session reads are refused", async () => {
  const h = harness(), response = await h.GET(request("", "GET", "?nonce=fictional-missing")); assert.equal(response.status, 200); assert.equal(h.calls.includes("enqueue"), false);
  const args = h.args.at(-1)!; assert.equal(args[3], null); assert.deepEqual(JSON.parse(JSON.stringify(args[5])), { latest: false, lookupNonce: "fictional-missing" });
  for (const query of ["?nonce=x&request=y", "?request=x&request=y", "?actor_id=other"]) assert.equal((await harness().GET(request("", "GET", query))).status, 400);
  assert.equal((await harness({ changeAt: 2 }).GET(request("", "GET"))).status, 401);
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "Cookie");
});
test("closed byte-bounded payload rejects private/unknown fields, duplicate keys, missing consent and invalid UTF8 before writes", async () => {
  for (const raw of ['{"kind":"preview","kind":"preview"}', JSON.stringify({ ...transitionIntent, actor_id: "other" }), '{"kind":"confirmation","body":{}}', new Uint8Array([255])]) {
    const h = harness(); assert.equal((await h.POST(request(raw))).status, 400); assert.equal(h.calls.includes("open"), false);
  }
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32769)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const huge = new Request("https://fictional.example.test/api/workbench/investor/legacy-transition", { method: "POST", headers: {
    "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, body: stream, duplex: "half" } as RequestInit);
  const h = harness(), response = await h.POST(huge); assert.equal(response.status, 413); assert.equal(cancelled, true); assert.equal(h.calls.includes("open"), false);
  for (const [failure, status] of [["LEGACY_TRANSITION_JOB_BUSY", 409], ["WORKBENCH_READ_ONLY", 423], ["SYNTHETIC_PRIVATE_MARKER SQLITE", 503]] as const) {
    const result = await harness({ failure }).POST(request()); assert.equal(result.status, status);
    assert.deepEqual(await result.json(), { error: status === 503 ? "LEGACY_TRANSITION_UNAVAILABLE" : failure });
  }
});
