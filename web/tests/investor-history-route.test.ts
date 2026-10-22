import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { NextResponse } from "next/server";
import { AuthError } from "../src/server/auth/core";
import { historyQuerySchema } from "../src/server/investor/history-schemas";

const binding = "a".repeat(64);
function harness(options: { denied?: boolean; changed?: boolean; failure?: string } = {}) {
  const calls: string[] = [], inputs: unknown[][] = []; let count = 0;
  const dependencies: Record<string, unknown> = { "next/server": { NextResponse }, "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireApiSession: async () => { calls.push("authenticate"); count++;
      if (options.denied) throw new AuthError("UNAUTHENTICATED", 401);
      return { userId: options.changed && count > 1 ? "foreign" : "owner", sessionId: "fictional-session" }; } },
    "@/server/auth/session-binding": { sessionBinding: () => binding, assertRequestSessionBinding: (request: Request) => {
      if (request.headers.get("x-workbench-session-binding") !== binding) throw new AuthError("SESSION_CHANGED", 401); } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return { close: () => calls.push("close") }; } },
    "@/server/investor/history-schemas": { historyQuerySchema }, "@/server/investor/history": { readInvestorHistory: (...input: unknown[]) => {
      calls.push("read"); inputs.push(input); if (options.failure) throw new Error(options.failure); return { fictional: true };
    } } };
  const code = ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/investor/history/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as { GET: (request: Request) => Promise<Response> } };
  runInNewContext(`(function(require,module,exports){${code}\n})`, { Error, URL, Object })((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  return { ...module.exports, calls, inputs };
}
function request(query = "", value: string | null = binding) {
  return new Request("https://synthetic.example.test/api/workbench/investor/history" + query, { headers: value ? { "X-Workbench-Session-Binding": value } : {} });
}
test("history authenticates and binds twice, closes scope before opening DB and never uses client owner identity", async () => {
  for (const [options, req, expected] of [[{ denied: true }, request(), 401], [{}, request("", null), 400], [{}, request("", "b".repeat(64)), 401],
    [{ changed: true }, request(), 401], [{}, request("?owner=foreign"), 400], [{}, request("?cursor=a&cursor=b"), 400],
    [{}, request("?observation=%2Fetc"), 400], [{}, request("?cursor=" + "a".repeat(1401)), 400]] as const) {
    const h = harness(options); assert.equal((await h.GET(req)).status, expected); assert.ok(!h.calls.includes("open"));
  }
  const h = harness(), response = await h.GET(request("?observation=fictional&cursor=opaque_cursor"));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(h.calls.at(-1), "close");
  assert.deepEqual(JSON.parse(JSON.stringify(h.inputs[0][1])), { id: "owner" });
  assert.deepEqual(h.inputs[0][2], { observation: "fictional", cursor: "opaque_cursor" });
});
test("history returns closed not-found/cursor errors and never exposes native paths or failed source payloads", async () => {
  for (const [failure, status, code] of [["INVESTOR_HISTORY_CURSOR_INVALID", 400, "INVESTOR_HISTORY_CURSOR_INVALID"],
    ["INVESTOR_HISTORY_NOT_FOUND", 404, "INVESTOR_HISTORY_NOT_FOUND"], ["PRIVATE /private/evidence", 503, "INVESTOR_HISTORY_UNAVAILABLE"]] as const) {
    const h = harness({ failure }), response = await h.GET(request()); assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code }); assert.equal(h.calls.at(-1), "close");
  }
});
