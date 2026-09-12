import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { NextResponse } from "next/server";
import { AuthError, tokenHash } from "../src/server/auth/core";

function compile(relative: string, dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error }) as (require: (id: string) => unknown, module: unknown, exports: unknown) => void;
  initialize(id => { assert.ok(id in dependencies, `Unexpected dependency (financial DB is forbidden): ${id}`); return dependencies[id]; }, module, module.exports);
  return module.exports;
}
const bindingModule = compile("../src/server/auth/session-binding.ts", { "server-only": {}, "./core": { tokenHash } });
const sessionBinding = bindingModule.sessionBinding as (sid: string) => string;

function route(error?: unknown, sid = "synthetic-session-id", configError?: Error) {
  const calls: string[] = [];
  const exports = compile("../src/app/api/auth/session/route.ts", {
    "next/server": { NextResponse }, "@/server/auth/core": { AuthError, getAuthConfig: () => { calls.push("validate-auth-config"); if (configError) throw configError; return {}; } },
    "@/server/auth/session": { requireApiSession: async () => { calls.push("require-api-session"); if (error !== undefined) throw error; return { userId: "owner", sessionId: sid }; } },
    "@/server/auth/session-binding": { sessionBinding },
  });
  return { get: exports.GET as () => Promise<Response>, exports, calls };
}

test("public session binding is domain-separated from both raw SID and stored token hash", () => {
  const sid = "synthetic-session-id", result = sessionBinding(sid);
  assert.equal(result, tokenHash(`workbench-client-session-v1:${sid}`));
  assert.notEqual(result, sid); assert.notEqual(result, tokenHash(sid)); assert.match(result, /^[a-f0-9]{64}$/);
  assert.notEqual(result, sessionBinding("another-synthetic-session")); assert.throws(() => sessionBinding(""), /SESSION_BINDING_UNAVAILABLE/);
});

test("session GET authenticates without financial DB dependencies and only returns the opaque client binding", async () => {
  const handler = route(), response = await handler.get();
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { authenticated: true, session_binding: sessionBinding("synthetic-session-id") });
  assert.deepEqual(handler.calls, ["validate-auth-config", "require-api-session"]);
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(handler.exports.runtime, "nodejs"); assert.equal(handler.exports.dynamic, "force-dynamic");
});

test("missing/revoked session yields only a cache-protected 401 with no SID or diagnostic reflection", async () => {
  const handler = route(new AuthError("synthetic-sensitive-diagnostic", 401)), response = await handler.get();
  assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.deepEqual(handler.calls, ["validate-auth-config", "require-api-session"]);
});

test("auth store errors, unavailable configuration and invalid principal fail closed with generic 503", async () => {
  for (const error of [new AuthError("AUTH_NOT_CONFIGURED", 503), new Error("synthetic storage diagnostic"), "synthetic unexpected error"]) {
    const response = await route(error).get(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "AUTH_UNAVAILABLE" });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  const invalid = await route(undefined, "").get(); assert.equal(invalid.status, 503); assert.deepEqual(await invalid.json(), { error: "AUTH_UNAVAILABLE" });
});

test("unconfigured auth is an unavailable probe, not a false logout caused by the legacy anonymous fallback", async () => {
  const handler = route(undefined, "synthetic-session-id", new AuthError("AUTH_NOT_CONFIGURED", 503)), response = await handler.get();
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "AUTH_UNAVAILABLE" });
  assert.deepEqual(handler.calls, ["validate-auth-config"]);
});
