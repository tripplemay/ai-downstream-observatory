import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";
import { isEvaluationClientError } from "../src/server/evaluation/service";

const code = ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/evaluations/route.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function route(options: { authError?: Error; changed?: boolean; serviceError?: Error } = {}) {
  const calls: string[] = [], logs: unknown[][] = [], captured: unknown[][] = []; let count = 0;
  const auth = async () => { calls.push("auth"); if (options.authError) throw options.authError; return { userId: "owner", sessionId: ++count > 1 && options.changed ? "synthetic-new-session" : "synthetic-session" }; };
  const handler = (operation: string) => (_db: unknown, actor: unknown, input: unknown) => { calls.push(operation); captured.push([actor, input]); if (options.serviceError) throw options.serviceError; return { synthetic: true, read_only: true, operation }; };
  const dependencies: Record<string, unknown> = { "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireApiSession: auth, requireMutationSession: auth },
    "@/server/auth/session-binding": { assertRequestSessionBinding: (request: Request) => { calls.push("binding"); if (request.headers.has("x-workbench-session-binding")) throw new AuthError("SESSION_CHANGED", 401); } },
    "@/server/strict-json": { parseStrictJson }, "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return { close: () => calls.push("close") }; } },
    "@/server/evaluation/service": { getEvaluationState: handler("get"), saveSchedule: handler("save"), setScheduleStatus: handler("status"), retryEvaluation: handler("retry"), isEvaluationClientError },
  };
  const module = { exports: {} as { GET: (request: Request) => Promise<Response>; POST: (request: Request) => Promise<Response> } };
  const initialize = runInNewContext(`(function(require,module,exports){${code}\n})`, { Error, URL, Buffer, TextDecoder, console: { error: (...values: unknown[]) => logs.push(values) } }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
  initialize(id => { assert.ok(id in dependencies, id); return dependencies[id]; }, module, module.exports);
  return { ...module.exports, calls, logs, captured };
}
const url = "https://workbench.example.test/api/workbench/evaluations";
const post = (body: BodyInit = '{"action":"save_schedule","command":{}}', headers: HeadersInit = { "Content-Type": "application/json" }) => new Request(url, { method: "POST", headers, body });

test("evaluation endpoints authenticate before body/query handling and stale optional session binding rejects before reads", async () => {
  const handler = route({ authError: new AuthError("UNAUTHENTICATED", 401) }), input = post("bad", { "Content-Length": "9999999" });
  assert.equal((await handler.POST(input)).status, 401); assert.equal(input.bodyUsed, false); assert.deepEqual(handler.calls, ["auth"]);
  assert.equal((await route({ authError: new AuthError("UNAUTHENTICATED", 401) }).GET(new Request(url + "?actor=bad"))).status, 401);
  const stale = route(), bound = post("bad", { "X-Workbench-Session-Binding": "synthetic-stale" });
  assert.equal((await stale.POST(bound)).status, 401); assert.equal(bound.bodyUsed, false); assert.deepEqual(stale.calls, ["auth", "binding"]);
});

test("POST exposes only human schedule/status/retry commands, never worker publication or client PASS", async () => {
  for (const [action, operation] of [["save_schedule", "save"], ["set_schedule_status", "status"], ["retry_evaluation", "retry"]]) {
    const handler = route(), response = await handler.POST(post(JSON.stringify({ action, command: { idempotency_key: "synthetic" } })));
    assert.equal(response.status, 200); assert.deepEqual(handler.calls, ["auth", "binding", "auth", "open", operation, "close"]);
    assert.deepEqual(JSON.parse(JSON.stringify(handler.captured)), [[{ id: "owner", kind: "human" }, { idempotency_key: "synthetic" }]]);
  }
  for (const body of [{ action: "publish_result", command: {} }, { action: "save_schedule", command: {}, actor: "strategy" }, { action: "retry_evaluation", command: {}, pass: true }]) {
    const handler = route(); assert.equal((await handler.POST(post(JSON.stringify(body)))).status, 400); assert.equal(handler.calls.includes("open"), false);
  }
});

test("POST validates bounded strict JSON and UTF8 without opening storage on malformed input", async () => {
  const cases: [Request, number, string][] = [
    [post("{}", { "Content-Type": "text/plain" }), 415, "JSON_REQUIRED"],
    [post("{}", { "Content-Type": "application/json", "Content-Length": "1048577" }), 413, "REQUEST_TOO_LARGE"],
    [post(" ".repeat(1048577)), 413, "REQUEST_TOO_LARGE"],
    [post(new Uint8Array([0xff])), 400, "INVALID_UTF8"],
    [post('{"action":"save_schedule","action":"retry_evaluation","command":{}}'), 400, "INVALID_JSON"],
  ];
  for (const [input, status, error] of cases) {
    const handler = route(), response = await handler.POST(input); assert.equal(response.status, status); assert.deepEqual(await response.json(), { error });
    assert.equal(handler.calls.includes("open"), false); if (status === 413) assert.equal(response.headers.get("connection"), "close");
  }
});

test("GET translates bounded detail pagination and remains available in read-only mode", async () => {
  const handler = route(), response = await handler.GET(new Request(url + "?portfolio=p&cycle=c&attempt_cursor=opaque&limit=20"));
  assert.equal(response.status, 200); assert.equal((await response.json()).read_only, true); assert.deepEqual(handler.calls, ["auth", "open", "get", "auth", "close"]);
  assert.deepEqual(JSON.parse(JSON.stringify(handler.captured)), [[{ id: "owner", kind: "human" }, { portfolio_id: "p", cycle_id: "c", attempt_cursor: "opaque", limit: 20 }]]);
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.equal(response.headers.get("vary"), "Cookie");
  for (const query of ["?portfolio=p&portfolio=q", "?limit=51", "?limit=01", "?actor_id=owner"]) {
    const bad = route(); assert.equal((await bad.GET(new Request(url + query))).status, 400); assert.deepEqual(bad.calls, ["auth"]);
  }
});

test("session replacement during reads prevents disclosure and during POST body prevents writes", async () => {
  const get = route({ changed: true }), read = await get.GET(new Request(url));
  assert.equal(read.status, 401); assert.deepEqual(await read.json(), { error: "SESSION_CHANGED" }); assert.equal(get.calls.at(-1), "close");
  const write = route({ changed: true }), response = await write.POST(post());
  assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: "SESSION_CHANGED" }); assert.equal(write.calls.includes("open"), false);
});

test("only namespaced business errors are disclosed and native/storage evidence failures are generic", async () => {
  for (const [code, status] of [["EVALUATION_SCHEDULE_CONFLICT", 409], ["EVALUATION_ACCOUNT_OUT_OF_SCOPE", 403], ["EVALUATION_CYCLE_NOT_FOUND", 404], ["EVALUATION_DEFINITION_TOO_LARGE", 413], ["EVALUATION_TARGET_BUDGET_EXCEEDED", 400], ["WORKBENCH_READ_ONLY", 423]] as const) {
    const handler = route({ serviceError: new Error(code) }), response = await handler.POST(post()); assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: code }); assert.equal(handler.calls.at(-1), "close");
  }
  for (const code of ["SQLITE: /private/synthetic SELECT payload_json", "EVALUATION_EVIDENCE_INVALID"]) {
    const handler = route({ serviceError: new Error(code) }), response = await handler.GET(new Request(url));
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "WORKBENCH_UNAVAILABLE" }); assert.deepEqual(handler.logs, [["Evaluation request failed", "Error"]]);
  }
});
