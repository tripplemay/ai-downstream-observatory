import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError, requireSameOrigin } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";
import { executionScope } from "../src/components/workbench/investor-execution-followup-client";
import { executionUploadScopeSchema } from "../src/server/investor/execution-followup-schemas";
import { executionBinding as binding, executionContext as context } from "./investor-execution-fixture";

const origin = "https://synthetic.example.test";
function request(patch: (form: FormData) => void = () => {}, headers: Record<string, string> = {}, suffix = "") {
  const form = new FormData(); form.set("scope", JSON.stringify({ ...executionScope(context), expected_workspace_revision: context.workspace_revision }));
  form.set("idempotency_key", "fictional-upload"); form.set("media_type", "text/csv"); form.set("file", new File(["\ufefffictional,only\r\n"], "private-name.csv")); patch(form);
  return new Request(origin + "/api/workbench/investor/execution-evidence" + suffix, { method: "POST", body: form,
    headers: { Origin: origin, "X-Workbench-Session-Binding": binding, ...headers } });
}
function harness(options: { denied?: boolean; changed?: boolean; failure?: string } = {}) {
  let req: Request, count = 0; const calls: string[] = [], inputs: unknown[][] = [];
  const dependencies: Record<string, unknown> = { "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireMutationSession: async () => { calls.push("authenticate"); count++;
      if (options.denied) throw new AuthError("UNAUTHENTICATED", 401); requireSameOrigin(req.headers, { origin } as Parameters<typeof requireSameOrigin>[1]);
      return { userId: options.changed && count > 1 ? "foreign" : "owner", sessionId: "fictional-session" }; } },
    "@/server/auth/session-binding": { sessionBinding: () => binding, assertRequestSessionBinding: (input: Request) => {
      if (input.headers.get("x-workbench-session-binding") !== binding) throw new AuthError("SESSION_CHANGED", 401); } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return { close: () => calls.push("close") }; } },
    "@/server/strict-json": { parseStrictJson }, "@/server/investor/execution-followup-schemas": { executionUploadScopeSchema }, "@/server/investor/execution-evidence": { storeInvestorExecutionEvidence: (...input: unknown[]) => {
      calls.push("store"); executionUploadScopeSchema.parse(input[2]); inputs.push(input); if (options.failure) throw new Error(options.failure); return { fictional: true };
    } } };
  const code = ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/investor/execution-evidence/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as { POST: (input: Request) => Promise<Response> } };
  const initialize = runInNewContext(`(function(require,module,exports){${code}\n})`, { Error, Buffer, URL, Response, TextDecoder });
  initialize((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  return { calls, inputs, POST(input: Request) { req = input; return module.exports.POST(input); } };
}

test("evidence upload authenticates/origin-binds before consuming bytes and rechecks identity before storage", async () => {
  for (const kind of ["anonymous", "origin", "binding", "absent-binding", "query"]) {
    const h = harness({ denied: kind === "anonymous" }), req = request(undefined,
      kind === "origin" ? { Origin: "https://foreign.example.test" } : kind === "binding" ? { "X-Workbench-Session-Binding": "b".repeat(64) } : {}, kind === "query" ? "?owner=foreign" : "");
    if (kind === "absent-binding") req.headers.delete("x-workbench-session-binding");
    assert.equal((await h.POST(req)).status, kind === "origin" ? 403 : kind === "absent-binding" || kind === "query" ? 400 : 401);
    assert.equal(req.bodyUsed, false); assert.ok(!h.calls.includes("open"));
  }
  const changed = harness({ changed: true }); assert.equal((await changed.POST(request())).status, 401); assert.ok(!changed.calls.includes("open"));
  const h = harness(), response = await h.POST(request()); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(h.calls.at(-1), "close"); assert.deepEqual(JSON.parse(JSON.stringify(h.inputs[0][1])), { id: "owner" });
  const upload = h.inputs[0][3] as { bytes: Uint8Array; idempotency_key: string; media_type: string };
  assert.deepEqual(Buffer.from(upload.bytes), Buffer.from("\ufefffictional,only\r\n")); assert.equal(upload.idempotency_key, "fictional-upload");
});

test("multipart field/size/encoding and strict scope boundaries fail closed with no implicit financial operation", async () => {
  for (const patch of [(form: FormData) => form.append("scope", "{}"), (form: FormData) => form.set("owner", "foreign"),
    (form: FormData) => form.set("media_type", "application/octet-stream"), (form: FormData) => form.set("file", new File([], "empty.csv")),
    (form: FormData) => form.set("scope", '{"portfolio_id":"a","portfolio_id":"b"}'),
    (form: FormData) => form.set("scope", JSON.stringify({ ...executionScope(context), expected_workspace_revision: context.workspace_revision, owner_id: "forged" }))]) {
    const h = harness(); assert.equal((await h.POST(request(patch))).status, 400); assert.ok(!h.calls.includes("store"));
  }
  for (const [headers, expected] of [[{ "Content-Length": String(5 * 1024 * 1024 + 1) }, 413], [{ "Content-Encoding": "gzip" }, 415], [{ "Content-Type": "application/json" }, 415]] as const) {
    const h = harness(), req = request(undefined, headers); assert.equal((await h.POST(req)).status, expected); assert.equal(req.bodyUsed, false);
  }
  for (const [failure, status, code] of [["WORKBENCH_READ_ONLY", 423, "WORKBENCH_READ_ONLY"], ["INVESTOR_EXECUTION_CONTEXT_CONFLICT", 409, "INVESTOR_EXECUTION_CONTEXT_CONFLICT"],
    ["PRIVATE_STORAGE_MARKER /private/secret", 503, "INVESTOR_EXECUTION_UNAVAILABLE"]] as const) {
    const h = harness({ failure }), response = await h.POST(request()); assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: code });
  }
});
