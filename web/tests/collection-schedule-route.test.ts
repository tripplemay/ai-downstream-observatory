import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";
import { isCollectionClientError } from "../src/server/market-schedules/service";

const source = readFileSync(new URL("../src/app/api/workbench/market/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const binding = "a".repeat(64), sid = "synthetic-session";
function harness(options: { authError?: AuthError; changedSession?: boolean; effectError?: Error } = {}) {
  const calls: string[] = [], captures: unknown[][] = []; let authentications = 0;
  const db = { close() { calls.push("close"); } };
  const authenticate = async () => { calls.push("authenticate"); authentications++; if (options.authError) throw options.authError; return { userId: "synthetic-owner", sessionId: options.changedSession && authentications > 1 ? "new-session" : sid }; };
  const effect = (kind: string, ...values: unknown[]) => { calls.push(kind); captures.push(values); if (options.effectError) throw options.effectError; return { synthetic_result: kind }; };
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireApiSession: authenticate, requireMutationSession: authenticate },
    "@/server/auth/session-binding": { sessionBinding: () => binding, assertRequestSessionBinding: (request: Request) => { calls.push("binding"); const header = request.headers.get("X-Workbench-Session-Binding"); if (header !== null && header !== binding) throw new AuthError("SESSION_CHANGED", 401); } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return db; } },
    "@/server/strict-json": { parseStrictJson },
    "@/server/market-references/service": { isReferenceClientError: () => false, storeMarketReferenceSource: () => { throw new Error("UNEXPECTED_REFERENCE_MUTATION"); }, publishMarketReference: () => { throw new Error("UNEXPECTED_REFERENCE_MUTATION"); } },
    "@/server/market-references/queries": { getMarketReferenceState: () => { throw new Error("UNEXPECTED_REFERENCE_QUERY"); } },
    "@/server/market-schedules/service": { isCollectionClientError, saveCollectionSchedule: (...args: unknown[]) => effect("save", ...args), setCollectionScheduleStatus: (...args: unknown[]) => effect("status", ...args) },
    "@/server/market-schedules/queries": { getCollectionScheduleState: (...args: unknown[]) => effect("list", ...args), getCollectionSlot: (...args: unknown[]) => effect("slot", ...args) },
  };
  const module = { exports: {} as { POST: (request: Request) => Promise<Response>; GET: (request: Request) => Promise<Response> } };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, URL, TextDecoder }) as (require: (name: string) => unknown, module: unknown, exports: unknown) => void;
  initialize(name => { assert.ok(name in dependencies, `Unexpected import ${name}`); return dependencies[name]; }, module, module.exports);
  return { ...module.exports, calls, captures };
}
function request(value: unknown = { action: "save_collection_schedule", command: { definition_json: "{\n  \"synthetic\": true\n}\n" } }) {
  return new Request("https://synthetic.example.test/api/workbench/market", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, body: JSON.stringify(value) });
}
test("real route authenticates and binds the session before malformed body reads, then rejects a changed SID before database access", async () => {
  const denied = harness({ authError: new AuthError("UNAUTHENTICATED", 401) }), raw = request();
  assert.equal((await denied.POST(raw)).status, 401); assert.equal(raw.bodyUsed, false); assert.deepEqual(denied.calls, ["authenticate"]);
  const mismatch = harness(), mismatched = request(); mismatched.headers.set("X-Workbench-Session-Binding", "b".repeat(64));
  assert.equal((await mismatch.POST(mismatched)).status, 401); assert.equal(mismatched.bodyUsed, false); assert.equal(mismatch.calls.includes("open"), false);
  const changed = harness({ changedSession: true }), response = await changed.POST(request());
  assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: "SESSION_CHANGED" }); assert.equal(changed.calls.includes("open"), false);
});
test("new schedule actions use server human identity, preserve definition bytes and return non-cacheable session-bound results", async () => {
  for (const [action, expected] of [["save_collection_schedule", "save"], ["set_collection_schedule_status", "status"]]) {
    const value = { definition_json: "{\n \"synthetic\": true\n}\n" }, h = harness(), response = await h.POST(request({ action, command: value }));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { synthetic_result: expected, session_binding: binding });
    assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "Cookie");
    assert.deepEqual(h.calls, ["authenticate", "binding", "authenticate", "binding", "open", expected, "close"]);
    assert.deepEqual(JSON.parse(JSON.stringify(h.captures[0][1])), { id: "synthetic-owner", kind: "human" });
    assert.deepEqual(h.captures[0][2], value);
  }
});
test("schedule list and slot query parameters are strict, bounded, read-only and authenticated", async () => {
  for (const [search, kind, expected] of [["view=collection_schedules&portfolio=p&schedule=s&limit=50&cursor=opaque", "list", { portfolio_id: "p", schedule_id: "s", cursor: "opaque", limit: 50 }], ["view=collection_slot&portfolio=p&id=slot", "slot", { portfolio_id: "p", slot_id: "slot" }]] as const) {
    const h = harness(), response = await h.GET(new Request(`https://synthetic.example.test/api/workbench/market?${search}`));
    assert.equal(response.status, 200); assert.deepEqual(JSON.parse(JSON.stringify(h.captures[0][1])), expected);
    assert.deepEqual(h.calls, ["authenticate", "binding", "open", kind, "close"]);
  }
  for (const search of ["view=collection_schedules&limit=51", "view=collection_schedules&portfolio=p&portfolio=q", "view=collection_schedules&id=unexpected", "view=collection_slot&portfolio=p&id=slot&schedule=s", "view=collection_slot&id=slot", "view=collection_schedules&actor_id=other"]) {
    const h = harness(), response = await h.GET(new Request(`https://synthetic.example.test/api/workbench/market?${search}`));
    assert.equal(response.status, 400); assert.equal(h.calls.includes("open"), false);
  }
});
test("strict JSON rejects duplicate and unknown envelope fields before any schedule effect", async () => {
  for (const raw of ['{"action":"save_collection_schedule","action":"set_collection_schedule_status","command":{}}', '{"action":"save_collection_schedule","command":{},"actor_id":"other"}', "SYNTHETIC_PRIVATE_MARKER"]) {
    const h = harness(), response = await h.POST(new Request("https://synthetic.example.test/api/workbench/market", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw }));
    assert.equal(response.status, 400); assert.equal(h.calls.includes("open"), false); assert.doesNotMatch(await response.text(), /SYNTHETIC_PRIVATE_MARKER|actor_id/);
  }
});
test("business errors have explicit status while native paths or damaged evidence are never exposed", async () => {
  for (const [code, status] of [["COLLECTION_SCHEDULE_CONFLICT", 409], ["COLLECTION_SCOPE_CONFLICT", 409], ["COLLECTION_OUT_OF_SCOPE", 403], ["COLLECTION_PERMISSION_DENIED", 403], ["COLLECTION_SLOT_NOT_FOUND", 404], ["COLLECTION_DEFINITION_TOO_LARGE", 413], ["COLLECTION_LIMIT_REACHED", 400], ["WORKBENCH_READ_ONLY", 423], ["COLLECTION_EVIDENCE_INVALID", 503], ["SQLITE_BUSY /private/synthetic-secret", 503]] as const) {
    const h = harness({ effectError: new Error(code) }), response = await h.POST(request());
    assert.equal(response.status, status, code); assert.deepEqual(await response.json(), { error: status === 503 ? "WORKBENCH_UNAVAILABLE" : code }); assert.equal(h.calls.at(-1), "close");
  }
});
