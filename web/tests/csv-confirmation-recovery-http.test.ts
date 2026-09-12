import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError, tokenHash } from "../src/server/auth/core";
import { isCsvRecoveryClientError } from "../src/server/ledger/csv-confirmation-recovery";

const source = readFileSync(new URL("../src/app/api/workbench/csv/recovery/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const id = "11111111-1111-4111-8111-111111111111", sid = "synthetic-session-identifier", binding = "b".repeat(64);
function route(options: { authError?: Error; reauthError?: Error; changedSession?: boolean; readError?: unknown } = {}) {
  const calls: string[] = [], captured: unknown[] = [], logs: unknown[][] = []; let authCalls = 0;
  const db = { readonly: true, close() { calls.push("close"); } };
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError, tokenHash },
    "@/server/auth/session-binding": { sessionBinding: (value: string) => { assert.equal(value, sid); return binding; } },
    "@/server/auth/session": { requireApiSession: async () => {
      calls.push("authenticate"); authCalls++;
      if (options.authError) throw options.authError;
      if (authCalls > 1 && options.reauthError) throw options.reauthError;
      return { userId: "owner", sessionId: authCalls > 1 && options.changedSession ? "changed-synthetic-session" : sid };
    } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return db; } },
    "@/server/ledger/csv-confirmation-recovery": {
      isCsvRecoveryClientError,
      listCsvConfirmationAttempts: (connection: unknown, who: unknown, input: unknown) => {
        assert.equal(connection, db); calls.push("list"); captured.push(who, input);
        if (options.readError) throw options.readError;
        return { schema_version: "csv-confirmation-recovery-v1", attempts: [], next_cursor: null, read_only: true };
      },
      getCsvConfirmationAttempt: (connection: unknown, who: unknown, selector: unknown) => {
        assert.equal(connection, db); calls.push("detail"); captured.push(who, selector);
        if (options.readError) throw options.readError;
        return { schema_version: "csv-confirmation-recovery-v1", payload_text: "synthetic exact payload", read_only: true };
      },
    },
  };
  const module = { exports: {} as { GET: (request: Request) => Promise<Response>; POST?: unknown } };
  const initialize = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, URL, console: { error: (...values: unknown[]) => logs.push(values) } });
  initialize((name: string) => { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; }, module, module.exports);
  return { get: module.exports.GET, calls, captured, logs, exports: module.exports };
}
const request = (query = "") => new Request(`https://workbench.example.test/api/workbench/csv/recovery${query}`);

test("recovery GET authenticates before interpreting query and exposes no execution method", async () => {
  const handler = route({ authError: new AuthError("UNAUTHENTICATED", 401) });
  const result = await handler.get(request("?session_hash=attacker&limit=999"));
  assert.equal(result.status, 401); assert.deepEqual(handler.calls, ["authenticate"]); assert.equal(handler.exports.POST, undefined);
  assert.deepEqual(await result.json(), { error: "UNAUTHENTICATED" });
});

test("list/detail derive server session hash, revalidate session before disclosure and remain readable in readonly mode", async () => {
  for (const [query, expected] of [["?limit=7", { limit: 7 }], [`?id=${id}`, { id }], [`?batch=synthetic-batch&payload_hash=${"a".repeat(64)}`, { batch_id: "synthetic-batch", payload_hash: "a".repeat(64) }]] as const) {
    const handler = route(), result = await handler.get(request(query)); assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "private, no-store"); assert.equal(result.headers.get("x-content-type-options"), "nosniff"); assert.equal(result.headers.get("vary"), "Cookie");
    const body = await result.json(); assert.equal(body.session_binding, binding); assert.equal(body.read_only, true);
    assert.equal(JSON.stringify(body).includes(sid), false); assert.equal(JSON.stringify(body).includes(tokenHash(sid)), false);
    assert.deepEqual(JSON.parse(JSON.stringify(handler.captured)), [{ actorId: "owner", sessionHash: tokenHash(sid) }, expected]);
    assert.deepEqual(handler.calls, ["authenticate", "open", query.startsWith("?limit") ? "list" : "detail", "close", "authenticate"]);
  }
});

test("logout or changed session during the read discards sensitive response content", async () => {
  for (const options of [{ reauthError: new AuthError("UNAUTHENTICATED", 401) }, { changedSession: true }]) {
    const handler = route(options), result = await handler.get(request(`?id=${id}`));
    assert.equal(result.status, 401); assert.deepEqual(await result.json(), { error: "UNAUTHENTICATED" });
    assert.deepEqual(handler.calls, ["authenticate", "open", "detail", "close", "authenticate"]);
  }
});

test("duplicate keys, injected principal and ambiguous list/detail queries fail before opening storage", async () => {
  for (const query of ["?actor_id=owner", "?session_hash=" + "a".repeat(64), "?limit=1&limit=2", "?limit=21", "?limit=1e1", "?batch=synthetic", "?payload_hash=" + "a".repeat(64), `?id=${id}&limit=1`, `?id=${id}&batch=other&payload_hash=${"a".repeat(64)}`]) {
    const handler = route(), result = await handler.get(request(query)); assert.equal(result.status, 400, query);
    assert.deepEqual(await result.json(), { error: "CSV_RECOVERY_QUERY_INVALID" }); assert.deepEqual(handler.calls, ["authenticate"]);
  }
});

test("safe recovery failures never expose native paths, SQL or server session identifiers", async () => {
  for (const [error, status, code] of [[new Error("CSV_RECOVERY_NOT_FOUND"), 404, "CSV_RECOVERY_NOT_FOUND"], [new Error("CSV_RECOVERY_CURSOR_INVALID"), 400, "CSV_RECOVERY_CURSOR_INVALID"],
    [new Error("CSV_RECOVERY_RESPONSE_TOO_LARGE"), 413, "CSV_RECOVERY_RESPONSE_TOO_LARGE"], [new Error("CSV_RECOVERY_EVIDENCE_INVALID"), 503, "WORKBENCH_UNAVAILABLE"],
    [new Error("SQLITE_BUSY /private/synthetic.db SELECT payload_text"), 503, "WORKBENCH_UNAVAILABLE"], ["/private/synthetic.db", 503, "WORKBENCH_UNAVAILABLE"]] as const) {
    const handler = route({ readError: error }), result = await handler.get(request());
    assert.equal(result.status, status); assert.deepEqual(await result.json(), { error: code }); assert.equal(handler.calls.at(-1), "close");
    if (status === 503) assert.deepEqual(handler.logs, [["CSV confirmation recovery failed", error instanceof Error ? "Error" : "UnknownError"]]);
  }
});
