import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError, tokenHash } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";

function compile(file: string, dependencies: Record<string, unknown>, unusedServerImports = false) {
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, TextDecoder, console }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
  initialize(id => {
    if (id in dependencies) return dependencies[id];
    if (unusedServerImports && id.startsWith("@/server/")) return {};
    throw new Error(`Unexpected dependency: ${id}`);
  }, module, module.exports);
  return module.exports;
}
const binding = compile("../src/server/auth/session-binding.ts", { "server-only": {}, "./core": { AuthError, tokenHash } }) as {
  sessionBinding: (sid: string) => string;
  assertRequestSessionBinding: (request: Pick<Request, "headers">, sid: string) => void;
};
const sid = "synthetic-original-session", changedSid = "synthetic-replacement-session";
const guard = binding.assertRequestSessionBinding;

test("optional request binding is exact, domain-separated and is not accepted as a session credential", () => {
  assert.doesNotThrow(() => guard({ headers: new Headers() }, sid));
  assert.doesNotThrow(() => guard({ headers: new Headers({ "X-Workbench-Session-Binding": binding.sessionBinding(sid) }) }, sid));
  for (const value of ["", "short", sid, tokenHash(sid), binding.sessionBinding(changedSid), binding.sessionBinding(sid).toUpperCase(), ` ${binding.sessionBinding(sid)}`, `${binding.sessionBinding(sid)} `]) {
    const request = { headers: { get: () => value } as unknown as Headers };
    assert.throws(() => guard(request, sid), error => error instanceof AuthError && error.status === 401 && error.code === "SESSION_CHANGED");
  }
  const duplicated = new Headers(); duplicated.append("X-Workbench-Session-Binding", binding.sessionBinding(sid)); duplicated.append("X-Workbench-Session-Binding", binding.sessionBinding(sid));
  assert.throws(() => guard({ headers: duplicated }, sid), /SESSION_CHANGED/);
});

type Principal = { userId: string; sessionId: string };
function route(kind: "main" | "csv", sessions: (Principal | Error)[] = [{ userId: "owner", sessionId: sid }]) {
  const calls: string[] = []; let authCount = 0;
  const db = { close: () => calls.push("close"), prepare: () => ({ get: () => ({ parser_version: "csv-v1" }) }) };
  const exports = compile(kind === "main" ? "../src/app/api/workbench/route.ts" : "../src/app/api/workbench/csv/route.ts", {
    "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError, tokenHash },
    "@/server/auth/session": { requireMutationSession: async () => {
      calls.push("authenticate"); const current = sessions[Math.min(authCount++, sessions.length - 1)];
      if (current instanceof Error) throw current; return current;
    } },
    "@/server/auth/session-binding": { assertRequestSessionBinding: (request: Request, currentSid: string) => { calls.push("binding"); guard(request, currentSid); } },
    "@/server/strict-json": { parseStrictJson },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return db; } },
    "@/server/ledger/service": { createPortfolio: () => { calls.push("create"); return "synthetic-portfolio"; } },
    "@/server/ledger/csv-upload": { readCsvUpload: async (request: Request) => { calls.push("read-body"); await request.arrayBuffer(); return { bytes: new Uint8Array() }; } },
    "@/server/ledger/csv-imports": { previewCsvImport: () => { calls.push("preview"); return { id: "synthetic-batch", status: "preview" }; } },
    "@/server/ledger/csv-confirmation-recovery": { saveCsvConfirmationAttempt: () => { calls.push("save-attempt"); }, isCsvRecoveryClientError: () => false },
    "@/server/ledger/imports": { confirmImport: () => { calls.push("confirm"); return { revision: 1, receipts: [] }; } },
  }, true);
  return { calls, post: exports.POST as (request: Request) => Promise<Response> };
}
function request(kind: "main" | "csv", supplied?: string, payload: unknown = { action: "create_portfolio", name: "Synthetic portfolio" }) {
  const headers = new Headers({ "Content-Type": kind === "main" ? "application/json" : "multipart/form-data; boundary=synthetic" });
  if (supplied !== undefined) headers.set("X-Workbench-Session-Binding", supplied);
  return new Request(`https://workbench.example.test/api/workbench${kind === "csv" ? "/csv" : ""}`, { method: "POST", headers, body: JSON.stringify(payload) });
}

test("same owner with a replaced cookie cannot send an old-bound request to either POST, before any body read", async () => {
  for (const kind of ["main", "csv"] as const) {
    const handler = route(kind, [{ userId: "owner", sessionId: changedSid }]), input = request(kind, binding.sessionBinding(sid));
    const response = await handler.post(input);
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: "SESSION_CHANGED" });
    assert.equal(input.bodyUsed, false); assert.deepEqual(handler.calls, ["authenticate", "binding"]);
  }
});

test("both POST handlers retain missing-header compatibility and permit the current exact binding", async () => {
  for (const kind of ["main", "csv"] as const) for (const supplied of [undefined, binding.sessionBinding(sid)]) {
    const handler = route(kind), input = request(kind, supplied), response = await handler.post(input);
    assert.equal(response.status, 200); assert.equal(input.bodyUsed, true);
    assert.deepEqual(handler.calls, kind === "main" ? ["authenticate", "binding", "open", "create", "close"] : ["authenticate", "binding", "read-body", "authenticate", "open", "preview", "close"]);
  }
});

test("a correct binding never skips login or same-origin authorization", async () => {
  for (const kind of ["main", "csv"] as const) for (const [code, status] of [["UNAUTHENTICATED", 401], ["INVALID_ORIGIN", 403]] as const) {
    const handler = route(kind, [new AuthError(code, status)]), input = request(kind, binding.sessionBinding(sid)), response = await handler.post(input);
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error: code });
    assert.equal(input.bodyUsed, false); assert.deepEqual(handler.calls, ["authenticate"]);
  }
});

test("CSV upload revalidates the original actor and SID after body consumption, before opening writable storage", async () => {
  const original = { userId: "owner", sessionId: sid };
  for (const next of [{ userId: "owner", sessionId: changedSid }, { userId: "other", sessionId: sid }, new AuthError("UNAUTHENTICATED", 401)]) {
    const handler = route("csv", [original, next]), input = request("csv", binding.sessionBinding(sid)), response = await handler.post(input);
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: next instanceof Error ? "UNAUTHENTICATED" : "SESSION_CHANGED" });
    assert.equal(input.bodyUsed, true); assert.deepEqual(handler.calls, ["authenticate", "binding", "read-body", "authenticate"]);
  }
});

test("main CSV confirmation retains the existing before/after-save session guard and never executes on a changed SID", async () => {
  const original = { userId: "owner", sessionId: sid }, changed = { userId: "owner", sessionId: changedSid };
  const payload = { action: "confirm_import", portfolio_id: "synthetic-portfolio", batch_id: "synthetic-batch", preview_hash: "a".repeat(64), expected_revision: 0 };
  for (const sessions of [[original, changed], [original, original, changed]]) {
    const handler = route("main", sessions), response = await handler.post(request("main", binding.sessionBinding(sid), payload));
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
    assert.equal(handler.calls.includes("confirm"), false); assert.equal(handler.calls.includes("save-attempt"), sessions.length === 3);
    assert.equal(handler.calls.at(-1), "close");
  }
});
