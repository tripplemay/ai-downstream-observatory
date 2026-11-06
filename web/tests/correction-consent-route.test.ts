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
import { correctionConsentSubmitSchema } from "../src/server/investor/correction-consent-schemas";
import { buildConsentAttempt } from "../src/components/workbench/investor-correction-consent-client";
import { consentAnswers, consentResponse, consentScope, consentSummaryHash } from "./correction-consent-client-fixture";
import { reviewNow } from "./action-review-client-fixture";
import {verifyEpochControlRoute} from "./epoch-control-route-fixture";
import {verifyEpochPreviewRoute} from "./epoch-preview-route-fixture";
import {verifyEpochRegistrationRoute} from "./epoch-registration-route-fixture";
import {verifyHistoryRoute} from "./epoch-history-route-fixture";
test("history workflow route preserves explicit bounded intent, strict transport, session and metadata-only read boundaries",verifyHistoryRoute);
test("epoch registration route preserves strict 4KiB explicit acknowledgement, origin/session and historical GET boundaries",verifyEpochRegistrationRoute);

test("epoch control route preserves owner/session/origin guards, strict 16KiB intent bounds and private opaque responses",verifyEpochControlRoute);
test("epoch preview route accepts only explicit 4KiB owner intent and preserves strict transport, session and metadata-only GET boundaries",verifyEpochPreviewRoute);

const binding = consentScope.binding, input = buildConsentAttempt(consentResponse(), consentScope, consentSummaryHash, consentAnswers, "fictional-consent", reviewNow).intent;
const compiled = ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/investor/correction-consent/route.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function harness(options: { deny?: boolean; origin?: boolean; changeAt?: number; failure?: string } = {}) {
  const calls: string[] = [], args: unknown[][] = []; let count = 0;
  const auth = async () => { calls.push("auth"); count++; if (options.deny) throw new AuthError("UNAUTHENTICATED", 401); if (options.origin) throw new AuthError("ORIGIN_DENIED", 403);
    return { userId: "fictional-owner", sessionId: options.changeAt && count >= options.changeAt ? "changed" : "same" }; };
  const imports: Record<string, unknown> = { "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError }, "@/server/auth/session": { requireApiSession: auth, requireMutationSession: auth },
    "@/server/auth/session-binding": { sessionBinding: () => binding, assertRequestSessionBinding: (request: Request) => { calls.push("bind"); if (request.headers.get("X-Workbench-Session-Binding") !== binding) throw new AuthError("SESSION_CHANGED", 401); } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return { close() { calls.push("close"); } }; } }, "@/server/strict-json": { parseStrictJson }, "@/server/investor/schemas": { investorId },
    "@/server/investor/correction-consent-schemas": { correctionConsentSubmitSchema }, "@/server/investor/correction-consent-jobs": {
      enqueueCorrectionConsent: (...values: unknown[]) => { calls.push("enqueue"); args.push(values); if (options.failure) throw new Error(options.failure); return { request_id: "fictional-job" }; },
      readCorrectionConsentResponse: (...values: unknown[]) => { calls.push("read"); args.push(values); if (options.failure) throw new Error(options.failure); return consentResponse({ candidate: null }); } } };
  const module = { exports: {} as { GET: (request: Request) => Promise<Response>; POST: (request: Request) => Promise<Response> } };
  runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, URL, TextDecoder })((name: string) => { assert.ok(name in imports, name); return imports[name]; }, module, module.exports);
  return { ...module.exports, calls, args };
}
const request = (raw: string | Uint8Array = JSON.stringify(input), method = "POST", query = "") => new Request("https://fictional.example.test/api/workbench/investor/correction-consent" + query,
  { method, headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, ...(method === "POST" ? { body: typeof raw === "string" ? raw : new Uint8Array(raw).buffer } : {}) });
test("formal correction authenticates before body/storage and never exposes a result across a changed session", async () => {
  for (const option of [{ deny: true }, { origin: true }]) { const h = harness(option), r = request(); assert.ok([401, 403].includes((await h.POST(r)).status)); assert.equal(r.bodyUsed, false); assert.equal(h.calls.includes("open"), false); }
  const missing = request(); missing.headers.delete("X-Workbench-Session-Binding"); assert.equal((await harness().POST(missing)).status, 400); assert.equal(missing.bodyUsed, false);
  const early = harness({ changeAt: 2 }); assert.equal((await early.POST(request())).status, 401); assert.equal(early.calls.includes("open"), false);
  const late = harness({ changeAt: 3 }); assert.equal((await late.POST(request())).status, 401); assert.equal(late.calls.includes("enqueue"), true); assert.equal(late.calls.at(-1), "close");
});
test("metadata selectors are singular and closed, nonce misses never imply a new intent, and GET is private/no-store", async () => {
  for (const query of ["", "?impact=a&impact=b", "?request=a&nonce=b", "?model=a&impact=b", "?actor_id=other"]) {
    const h = harness(); assert.equal((await h.GET(request("", "GET", query))).status, 400); assert.equal(h.calls.includes("open"), false);
  }
  const h = harness(), value = await h.GET(request("", "GET", "?nonce=fictional-missing")); assert.equal(value.status, 200);
  assert.equal(h.calls.includes("enqueue"), false); assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][3])), { nonce: "fictional-missing" });
  assert.equal(value.headers.get("cache-control"), "private, no-store"); assert.equal(value.headers.get("vary"), "Cookie"); assert.equal(value.headers.get("x-content-type-options"), "nosniff");
});
test("32KiB strict transport rejects duplicate JSON, malformed UTF8, implicit consent and caller economics before storage", async () => {
  for (const raw of ['{"expected_revision":1,"expected_revision":2}', JSON.stringify({ ...input, baseline: {} }), JSON.stringify({ ...input, acknowledgements: { hypothetical_only: true } }), new Uint8Array([255])]) {
    const h = harness(); assert.equal((await h.POST(request(raw))).status, 400); assert.equal(h.calls.includes("open"), false);
  }
  let cancelled = false; const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32769)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const huge = new Request("https://fictional.example.test/api/workbench/investor/correction-consent", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, body: stream, duplex: "half" } as RequestInit);
  const h = harness(); assert.equal((await h.POST(huge)).status, 413); assert.equal(cancelled, true); assert.equal(h.calls.includes("open"), false);
});
test("exact owner intent is forwarded; conflicts/read-only remain explicit and internal failures are opaque", async () => {
  const h = harness(), response = await h.POST(request()); assert.equal(response.status, 200); assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][1])), { id: "fictional-owner" });
  assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][2])), input); assert.equal((await response.json()).lookup_nonce, input.idempotency_key);
  for (const [failure, status] of [["CORRECTION_CONSENT_BUSY", 409], ["CORRECTION_CONSENT_UNRESOLVED", 409], ["WORKBENCH_READ_ONLY", 423], ["SYNTHETIC_PRIVATE_SQL_MARKER", 503]] as const) {
    const r = await harness({ failure }).POST(request()); assert.equal(r.status, status); assert.deepEqual(await r.json(), { error: status === 503 ? "CORRECTION_CONSENT_UNAVAILABLE" : failure });
  }
});
