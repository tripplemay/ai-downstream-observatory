import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";
import * as schemas from "../src/server/price-schedules/schemas";
import { isPriceCollectionClientError } from "../src/server/price-schedules/core";
import { priceBinding as binding, priceDefinition } from "./price-schedule-test-fixture";

const sid = "synthetic-session", url = "https://synthetic.invalid/api/workbench/price-schedules";
const save = { action: "save_schedule", command: { portfolio_id: "p", idempotency_key: "synthetic-key", reason: "SYNTHETIC EXPLICIT AUTHORIZATION", acknowledgement: true,
  expected_schedule_id: null, expected_schedule_revision: 0, definition_json: JSON.stringify(priceDefinition()) } };
const status = { action: "set_status", command: { portfolio_id: "p", idempotency_key: "synthetic-key", reason: "SYNTHETIC EXPLICIT AUTHORIZATION", acknowledgement: true,
  schedule_id: "schedule-synthetic", expected_schedule_revision: 1, status: "enabled" } };
const compiled = ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/price-schedules/route.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function harness(options: { denied?: number; changedAt?: number; userChanged?: boolean; failure?: string } = {}) {
  let auth = 0; const calls: string[] = [], args: unknown[][] = [];
  const authenticate = async () => { calls.push("auth"); ++auth; if (options.denied) throw new AuthError(options.denied === 403 ? "INVALID_ORIGIN" : "UNAUTHENTICATED", options.denied);
    return { sessionId: options.changedAt && auth >= options.changedAt && !options.userChanged ? "changed-session" : sid, userId: options.changedAt && auth >= options.changedAt && options.userChanged ? "changed-user" : "synthetic-owner" }; };
  const effect = (name: string, arguments_: unknown[]) => { calls.push(name); args.push(arguments_); if (options.failure) throw new Error(options.failure); return { synthetic: name }; };
  const dependencies: Record<string, unknown> = { "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireApiSession: authenticate, requireMutationSession: authenticate },
    "@/server/auth/session-binding": { sessionBinding: () => binding, assertRequestSessionBinding: (request: Request) => { calls.push("bind"); if (request.headers.has("X-Workbench-Session-Binding") && request.headers.get("X-Workbench-Session-Binding") !== binding) throw new AuthError("SESSION_CHANGED", 401); } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return { close() { calls.push("close"); } }; } },
    "@/server/strict-json": { parseStrictJson }, "@/server/price-schedules/schemas": schemas,
    "@/server/price-schedules/service": { isPriceCollectionClientError,
      savePriceCollectionSchedule: (...values: unknown[]) => effect("save", values), setPriceCollectionScheduleStatus: (...values: unknown[]) => effect("status", values) },
    "@/server/price-schedules/queries": { getPriceCollectionScheduleState: (...values: unknown[]) => effect("state", values), getPriceCollectionSlot: (...values: unknown[]) => effect("slot", values) } };
  const module = { exports: {} as { GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response> } };
  const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, URL, TextDecoder });
  execute((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  return { ...module.exports, calls, args };
}
const post = (raw = JSON.stringify(save)) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, body: raw });
const get = (query: string) => new Request(`${url}?${query}`, { headers: { "X-Workbench-Session-Binding": binding } });

test("price schedule route authenticates Origin/session and binding before parsing or storage", async () => {
  for (const denied of [401, 403]) {
    const h = harness({ denied }), request = post("NOT JSON"); assert.equal((await h.POST(request)).status, denied); assert.equal(request.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
    assert.equal((await h.GET(get("portfolio=p&portfolio=q"))).status, denied);
  }
  for (const value of [null, "b".repeat(64)]) {
    const h = harness(), request = post(); if (value === null) request.headers.delete("X-Workbench-Session-Binding"); else request.headers.set("X-Workbench-Session-Binding", value);
    assert.equal((await h.POST(request)).status, 401); assert.equal(request.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
  }
  assert.equal((await harness().GET(new Request(url))).status, 200);
  const detail = harness(); assert.equal((await detail.GET(new Request(url + "?portfolio=p&slot=s"))).status, 401); assert.equal(detail.calls.includes("open"), false);
});
test("price schedule save/status use only server actor and revalidate session after effect", async () => {
  for (const input of [save, status]) {
    const h = harness(), response = await h.POST(post(JSON.stringify(input))); assert.equal(response.status, 200);
    assert.deepEqual(h.calls, ["auth", "bind", "auth", "bind", "open", input === save ? "save" : "status", "auth", "bind", "close"]);
    assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][1])), { id: "synthetic-owner", kind: "human" }); assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][2])), input.command);
    assert.equal((await response.json()).session_binding, binding); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "Cookie");
  }
  for (const changedAt of [2, 3]) for (const userChanged of [false, true]) {
    const h = harness({ changedAt, userChanged }), response = await h.POST(post()); assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: "SESSION_CHANGED" });
    assert.equal(h.calls.includes("save"), changedAt === 3);
  }
});
test("price schedule GET strict scoped list/detail rejects duplicate unknown mixed selectors before DB", async () => {
  const h = harness(); assert.equal((await h.GET(get("portfolio=p&schedule=s&limit=2"))).status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(h.args[0][1])), { portfolio_id: "p", schedule_id: "s", limit: 2 });
  const detail = harness(); assert.equal((await detail.GET(get("portfolio=p&slot=x"))).status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(detail.args[0][1])), { portfolio_id: "p", slot_id: "x" });
  for (const query of ["portfolio=p&portfolio=p", "schedule=s", "slot=s", "cursor=x", "portfolio=p&slot=s&schedule=x", "portfolio=p&slot=s&cursor=x", "portfolio=p&slot=s&limit=1", "limit=0", "limit=01", "limit=51", "portfolio=", "portfolio=p&url=x"]) {
    const h = harness(); assert.equal((await h.GET(get(query))).status, 400, query); assert.equal(h.calls.includes("open"), false);
  }
  const stale = harness({ changedAt: 2 }); assert.equal((await stale.GET(get("portfolio=p"))).status, 401); assert.equal(stale.calls.at(-1), "close");
  const request = new Request(url + "?enable=true", { method: "POST", headers: post().headers, body: "NOT JSON" }), denied = harness();
  assert.equal((await denied.POST(request)).status, 400); assert.equal(request.bodyUsed, false); assert.equal(denied.calls.includes("open"), false);
});
test("price schedule strict commands reject forged actor/time/enable, missing ack, duplicate keys and invalid reason Unicode", async () => {
  for (const change of [{ actor: "forged" }, { now: "2030-01-01" }, { status: "enabled" }, { acknowledgement: false }, { reason: " " }, { reason: "x\ud800" }, { reason: "x\udfff" }, { reason: "x\u0000" }]) {
    const h = harness(); assert.equal((await h.POST(post(JSON.stringify({ ...save, command: { ...save.command, ...change } })))).status, 400); assert.equal(h.calls.includes("open"), false);
  }
  const paired = harness(); assert.equal((await paired.POST(post(JSON.stringify({ ...save, command: { ...save.command, reason: "SYNTHETIC \ud83d\ude00" } })))).status, 200);
  for (const raw of [`{"action":"save_schedule","command":${JSON.stringify(save.command)},"command":${JSON.stringify(save.command)}}`, JSON.stringify({ ...save, actor: "forged" }), JSON.stringify({ ...save, action: "run_command" }), "PRIVATE_BAD_JSON"]) {
    const h = harness(), response = await h.POST(post(raw)); assert.equal(response.status, 400); assert.equal(h.calls.includes("open"), false); assert.doesNotMatch(await response.text(), /PRIVATE_BAD_JSON|forged/);
  }
});
test("price schedule body bounds raw stream without hanging cancellation and rejects malformed UTF8 or media type", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1048577)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const h = harness(), request = new Request(url, { method: "POST", headers: post().headers, body: stream, duplex: "half" } as RequestInit), response = await h.POST(request);
  assert.equal(response.status, 413); assert.equal(response.headers.get("connection"), "close"); assert.equal(cancelled, true); assert.equal(h.calls.includes("open"), false);
  const declared = post(); declared.headers.set("Content-Length", "1048577"); assert.equal((await harness().POST(declared)).status, 413); assert.equal(declared.bodyUsed, false);
  const invalid = new Request(url, { method: "POST", headers: post().headers, body: new Uint8Array([0xc0, 0xaf]) }); assert.equal((await harness().POST(invalid)).status, 400);
  const media = post(); media.headers.set("Content-Type", "text/plain"); assert.equal((await harness().POST(media)).status, 415);
});
test("price schedule safe errors preserve conflict/readonly boundaries without storage or evidence leaks", async () => {
  for (const [failure, status] of [["PRICE_COLLECTION_INVALID_COMMAND", 400], ["PRICE_COLLECTION_SCHEDULE_CONFLICT", 409], ["PRICE_COLLECTION_IDEMPOTENCY_CONFLICT", 409], ["PRICE_COLLECTION_SLOT_NOT_FOUND", 404],
    ["PRICE_COLLECTION_PERMISSION_DENIED", 403], ["WORKBENCH_READ_ONLY", 423], ["PRICE_COLLECTION_EVIDENCE_INVALID", 503], ["SQLITE_PRIVATE_MARKER", 503]] as const) {
    const response = await harness({ failure }).POST(post()); assert.equal(response.status, status, failure); assert.deepEqual(await response.json(), { error: status === 503 ? "WORKBENCH_UNAVAILABLE" : failure });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});
