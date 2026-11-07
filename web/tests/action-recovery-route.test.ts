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
import { unchangedRecoveryInputSchema } from "../src/server/investor/unchanged-action-recovery-schemas";
import { recoveryAttempt } from "../src/components/workbench/investor-action-recovery-client";
import { recoveryResponse } from "./action-recovery-client-fixture";
import { reviewBinding as binding, reviewNow as now, reviewIntent } from "./action-review-client-fixture";

const input = recoveryAttempt(recoveryResponse(), true, false, "fictional-recovery", now).intent;
const compiled = ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/investor/action-recovery/route.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function harness(options: { deny?: boolean; origin?: boolean; changeAt?: number; failure?: string } = {}) {
  const calls: string[] = [], args: unknown[][] = []; let count = 0;
  const auth = async () => { calls.push("auth"); count++; if (options.deny) throw new AuthError("UNAUTHENTICATED", 401);
    if (options.origin) throw new AuthError("ORIGIN_DENIED", 403); return { userId: "fictional-owner", sessionId: options.changeAt && count >= options.changeAt ? "changed" : "same" }; };
  const imports: Record<string, unknown> = { "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireApiSession: auth, requireMutationSession: auth }, "@/server/auth/session-binding": {
      sessionBinding: () => binding, assertRequestSessionBinding: (r: Request) => { calls.push("bind"); if (r.headers.get("X-Workbench-Session-Binding") !== binding) throw new AuthError("SESSION_CHANGED", 401); } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return { close() { calls.push("close"); } }; } },
    "@/server/strict-json": { parseStrictJson }, "@/server/investor/schemas": { investorId },
    "@/server/investor/unchanged-action-recovery-schemas": { unchangedRecoveryInputSchema },
    "@/server/investor/action-review-jobs": { enqueueUnchangedActionRecoveryJob: (...v: unknown[]) => {
      calls.push("enqueue"); args.push(v); if (options.failure) throw new Error(options.failure); return { request_id: "fictional-job" }; },
      findActionReviewRequest: () => { calls.push("find"); return undefined; } },
    "@/server/investor/unchanged-action-recovery-read": { readUnchangedActionRecoveryResponse: (...v: unknown[]) => {
      calls.push("read"); args.push(v); if (options.failure) throw new Error(options.failure); return recoveryResponse(); } } };
  const module = { exports: {} as { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> } };
  runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, URL, TextDecoder })((name: string) => { assert.ok(name in imports, name); return imports[name]; }, module, module.exports);
  return { ...module.exports, calls, args };
}
function request(raw: string | Uint8Array = JSON.stringify(input), method = "POST", query = "") {
  return new Request("https://fictional.example.test/api/workbench/investor/action-recovery" + query, { method,
    headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding },
    ...(method === "POST" ? { body: typeof raw === "string" ? raw : new Uint8Array(raw).buffer } : {}) });
}
test("recovery authentication/origin/binding precede body reads; changed sessions withhold private facts before and after durable enqueue", async () => {
  for (const options of [{ deny: true }, { origin: true }]) { const h = harness(options), r = request(); assert.ok([401, 403].includes((await h.POST(r)).status)); assert.equal(r.bodyUsed, false); assert.equal(h.calls.includes("open"), false); }
  const missing = request(); missing.headers.delete("X-Workbench-Session-Binding"); assert.equal((await harness().POST(missing)).status, 400); assert.equal(missing.bodyUsed, false);
  const early = harness({ changeAt: 2 }); assert.equal((await early.POST(request())).status, 401); assert.equal(early.calls.includes("open"), false);
  const late = harness({ changeAt: 3 }), response = await late.POST(request()); assert.equal(response.status, 401); assert.equal(late.calls.includes("enqueue"), true);
  assert.deepEqual(await response.json(), { error: "SESSION_CHANGED" }); assert.equal(late.calls.at(-1), "close");
});
test("read-only GET has no provider/write path, reauthenticates and forbids latest fallback for a missing nonce", async () => {
  const h = harness(), response = await h.GET(request("", "GET", "?nonce=fictional-missing")); assert.equal(response.status, 200); assert.equal(h.calls.includes("enqueue"), false);
  assert.equal(h.args[0][3], null); assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][5])), { latest: false, lookupNonce: "fictional-missing" });
  for (const [key, value] of [["cache-control", "private, no-store"], ["vary", "Cookie"], ["x-content-type-options", "nosniff"]]) assert.equal(response.headers.get(key), value);
  assert.equal((await harness({ changeAt: 2 }).GET(request("", "GET"))).status, 401);
  for (const query of ["?request=a&nonce=b", "?request=a&request=b", "?actor_id=other"]) { const bad = harness(); assert.equal((await bad.GET(request("", "GET", query))).status, 400); assert.equal(bad.calls.includes("open"), false); }
});
test("closed strict transport accepts only server-owned recovery intent; event/tax smuggling, old confirmations and oversized bodies cannot write", async () => {
  const body = (input as { body: Record<string, unknown> }).body;
  for (const raw of [JSON.stringify({ ...input as object, actor_id: "other" }), JSON.stringify({ kind: "confirmation", body: { ...body, new_events: [] } }),
    JSON.stringify({ kind: "confirmation", body: { ...body, tax_per_unit: "0" } }), '{"kind":"preview","kind":"preview"}', new Uint8Array([255])]) {
    const h = harness(); assert.equal((await h.POST(request(raw))).status, 400); assert.equal(h.calls.includes("open"), false); }
  assert.equal((await harness().POST(request(JSON.stringify(reviewIntent)))).status, 200);
  const h = harness(); assert.equal((await h.POST(request())).status, 200); assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][1])), { id: "fictional-owner" });
  assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][2])), input);
  let cancelled = false; const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(524289)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const huge = new Request("https://fictional.example.test/api/workbench/investor/action-recovery", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, body: stream, duplex: "half" } as RequestInit);
  const oversize = harness(); assert.equal((await oversize.POST(huge)).status, 413); assert.equal(cancelled, true); assert.equal(oversize.calls.includes("open"), false);
  const failure = await harness({ failure: "SYNTHETIC_PRIVATE_SQL" }).POST(request()); assert.equal(failure.status, 503); assert.deepEqual(await failure.json(), { error: "ACTION_RECOVERY_UNAVAILABLE" });
});
