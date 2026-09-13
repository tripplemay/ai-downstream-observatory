import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";
import { isListingReviewClientError } from "../src/server/listing-reviews/service";
const binding = "a".repeat(64), sid = "synthetic-session";
const compiled = ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/listing-reviews/route.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function harness(options: { denied?: boolean; changed?: boolean; failure?: string } = {}) {
  const calls: string[] = [], arguments_: unknown[][] = []; let auth = 0;
  const authenticate = async () => { calls.push("auth"); auth++; if (options.denied) throw new AuthError("UNAUTHENTICATED", 401); return { userId: "synthetic-owner", sessionId: options.changed && auth > 1 ? "other" : sid }; };
  const effect = (name: string, ...args: unknown[]) => { calls.push(name); arguments_.push(args); if (options.failure) throw new Error(options.failure); return { id: "review", portfolio_id: "portfolio", listing_id: "listing" }; };
  const dependencies: Record<string, unknown> = { "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError }, "@/server/auth/session": { requireApiSession: authenticate, requireMutationSession: authenticate }, "@/server/auth/session-binding": { sessionBinding: () => binding, assertRequestSessionBinding: (request: Request) => { calls.push("bind"); if (request.headers.has("X-Workbench-Session-Binding") && request.headers.get("X-Workbench-Session-Binding") !== binding) throw new AuthError("SESSION_CHANGED", 401); } }, "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return { close() { calls.push("close"); } }; } }, "@/server/strict-json": { parseStrictJson }, "@/server/listing-reviews/service": { isListingReviewClientError, publishListingReview: (...args: unknown[]) => effect("publish", ...args), readListingReviewVersion: (...args: unknown[]) => ({ document: effect("document", ...args) }) }, "@/server/listing-reviews/queries": { getListingReviewState: (...args: unknown[]) => effect("query", ...args) } };
  const module = { exports: {} as { POST: (request: Request) => Promise<Response>; GET: (request: Request) => Promise<Response> } };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, URL, TextDecoder });
  initialize((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports); return { ...module.exports, calls, arguments_ };
}
function request(raw = JSON.stringify({ action: "publish", command: { reason: "Synthetic review" } })) { return new Request("https://synthetic.example.test/api/workbench/listing-reviews", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, body: raw }); }
test("route binds auth before reading any body, and rechecks session after body before opening database", async () => {
  const denied = harness({ denied: true }), body = request(); assert.equal((await denied.POST(body)).status, 401); assert.equal(body.bodyUsed, false);
  const mismatch = request(); mismatch.headers.set("X-Workbench-Session-Binding", "b".repeat(64)); assert.equal((await harness().POST(mismatch)).status, 401); assert.equal(mismatch.bodyUsed, false);
  const changed = harness({ changed: true }); assert.equal((await changed.POST(request())).status, 401); assert.equal(changed.calls.includes("open"), false);
});
test("successful route uses server human identity and returns only exact review document plus session-bound private receipt", async () => {
  const h = harness(), response = await h.POST(request()); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "Cookie"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(h.calls, ["auth", "bind", "auth", "bind", "open", "publish", "document", "close"]); assert.deepEqual(JSON.parse(JSON.stringify(h.arguments_[0][1])), { id: "synthetic-owner", kind: "human" }); assert.equal((await response.json()).session_binding, binding);
});
test("GET authenticates again after database read; revocation withholds all query contents", async () => {
  const h = harness(), response = await h.GET(new Request("https://synthetic.example.test/api/workbench/listing-reviews?portfolio=p&listing=l&limit=50")); assert.equal(response.status, 200);
  assert.deepEqual(h.calls, ["auth", "bind", "open", "query", "auth", "bind", "close"]);
  const changed = harness({ changed: true }), withheld = await changed.GET(new Request("https://synthetic.example.test/api/workbench/listing-reviews")); assert.equal(withheld.status, 401); assert.deepEqual(await withheld.json(), { error: "SESSION_CHANGED" }); assert.equal(changed.calls.at(-1), "close");
  for (const search of ["portfolio=p&portfolio=q", "limit=51", "listing=l&actor_id=x", "limit=0"]) { const invalid = harness(); assert.equal((await invalid.GET(new Request(`https://synthetic.example.test/api/workbench/listing-reviews?${search}`))).status, 400); assert.equal(invalid.calls.includes("open"), false); }
});
test("strict bounded UTF8 JSON rejects duplicate keys and oversized streams without awaiting a stalled cancellation", async () => {
  for (const raw of ['{"action":"publish","action":"publish","command":{}}', '{"action":"publish","command":{},"actor_id":"x"}', "SYNTHETIC_PRIVATE_MARKER"]) { const h = harness(), response = await h.POST(request(raw)); assert.equal(response.status, 400); assert.doesNotMatch(await response.text(), /SYNTHETIC_PRIVATE_MARKER|actor_id/); assert.equal(h.calls.includes("open"), false); }
  let cancelled = false; const h = harness();
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const oversized = new Request("https://synthetic.example.test/api/workbench/listing-reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  const response = await h.POST(oversized); assert.equal(response.status, 413); assert.equal(response.headers.get("connection"), "close"); assert.equal(cancelled, true); assert.equal(h.calls.includes("open"), false);
});
test("safe business codes map explicitly while corrupted evidence and native details are withheld", async () => {
  for (const [code, status] of [["LISTING_REVIEW_VERSION_CONFLICT", 409], ["LISTING_REVIEW_IDENTITY_CONFLICT", 409], ["LISTING_REVIEW_SOURCE_OUT_OF_SCOPE", 403], ["LISTING_REVIEW_PERMISSION_DENIED", 403], ["LISTING_REVIEW_NOT_FOUND", 404], ["LISTING_REVIEW_INVALID_COMMAND", 400], ["WORKBENCH_READ_ONLY", 423], ["LISTING_REVIEW_EVIDENCE_INVALID", 503], ["SQLITE_FAILURE SYNTHETIC_PRIVATE_MARKER", 503]] as const) {
    const response = await harness({ failure: code }).POST(request()); assert.equal(response.status, status, code); assert.deepEqual(await response.json(), { error: status === 503 ? "WORKBENCH_UNAVAILABLE" : code });
  }
});
