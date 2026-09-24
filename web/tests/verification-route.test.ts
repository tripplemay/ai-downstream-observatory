import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { NextResponse } from "next/server";
import { AuthError } from "../src/server/auth/core";
import { parseStrictJson } from "../src/server/strict-json";
import { verificationCommandSchema, verificationQuerySchema } from "../src/server/verifications/schemas";

const binding = "a".repeat(64), sid = "synthetic-session";
const clientErrors = new Set(["VERIFICATION_COMMAND_INVALID", "VERIFICATION_QUERY_INVALID", "VERIFICATION_CURSOR_INVALID", "VERIFICATION_CLOCK_INVALID", "VERIFICATION_PERMISSION_DENIED",
  "VERIFICATION_PORTFOLIO_NOT_FOUND", "VERIFICATION_REQUEST_NOT_FOUND", "VERIFICATION_ARTIFACT_NOT_FOUND", "VERIFICATION_CONTEXT_CHANGED", "VERIFICATION_IDEMPOTENCY_CONFLICT",
  "VERIFICATION_EVIDENCE_INVALID", "VERIFICATION_SOURCE_UNAVAILABLE", "VERIFICATION_RESPONSE_TOO_LARGE"]);
const input = { portfolio_id: "synthetic-portfolio", check_id: "E-02.cash-contribution-neutrality.v1", expected_context_hash: "c".repeat(64), reason: "Synthetic route check", idempotency_key: "synthetic-request" };
const compiled = ts.transpileModule(readFileSync(new URL("../src/app/api/workbench/verifications/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function harness(options: { denied?: number; changedAt?: number; userChanged?: boolean; failure?: string } = {}) {
  const calls: string[] = [], arguments_: unknown[][] = []; let auth = 0;
  const authenticate = async () => { calls.push("auth"); ++auth; if (options.denied) throw new AuthError(options.denied === 403 ? "INVALID_ORIGIN" : "UNAUTHENTICATED", options.denied);
    return { sessionId: options.changedAt && auth >= options.changedAt && !options.userChanged ? "changed-session" : sid,
      userId: options.changedAt && auth >= options.changedAt && options.userChanged ? "changed-owner" : "synthetic-owner" }; };
  const effect = (name: string, args: unknown[], result: unknown) => { calls.push(name); arguments_.push(args); if (options.failure) throw new Error(options.failure); return result; };
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse }, zod: { z }, "@/server/auth/core": { AuthError },
    "@/server/auth/session": { requireApiSession: authenticate, requireMutationSession: authenticate },
    "@/server/auth/session-binding": { sessionBinding: () => binding, assertRequestSessionBinding: (request: Request) => {
      calls.push("bind"); if (request.headers.has("X-Workbench-Session-Binding") && request.headers.get("X-Workbench-Session-Binding") !== binding) throw new AuthError("SESSION_CHANGED", 401);
    } },
    "@/server/workbench-db": { openWorkbench: () => { calls.push("open"); return { close() { calls.push("close"); } }; } },
    "@/server/strict-json": { parseStrictJson }, "@/server/verifications/schemas": { verificationCommandSchema, verificationQuerySchema },
    "@/server/verifications/service": {
      isVerificationClientError: (code: string) => clientErrors.has(code),
      requestVerification: (...args: unknown[]) => effect("request", args, { request_id: "synthetic-request", check_id: input.check_id, context_hash: input.expected_context_hash, status: "queued" }),
      getVerificationState: (...args: unknown[]) => effect("query", args, { selected_portfolio_id: "synthetic-portfolio", read_only: true }),
      readVerificationArtifact: (...args: unknown[]) => effect("artifact", args, { id: "synthetic-artifact", body: Buffer.from('{"synthetic":true,"not_script":"<script>"}\n'), sha256: "d".repeat(64) }),
    },
  };
  const module = { exports: {} as { GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response> } };
  const execute = runInNewContext(`(function(require,module,exports){${compiled}\n})`, { Error, Buffer, URL, TextDecoder, Uint8Array });
  execute((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, module, module.exports);
  return { ...module.exports, calls, arguments_ };
}
const url = "https://synthetic.invalid/api/workbench/verifications";
const post = (raw = JSON.stringify({ command: input })) => new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, body: raw });
const get = (query: string) => new Request(`${url}?${query}`, { headers: { "X-Workbench-Session-Binding": binding } });

test("verification route authenticates and binds before body parsing or database access", async () => {
  for (const status of [401, 403]) {
    const h = harness({ denied: status }), request = post("not json"); assert.equal((await h.POST(request)).status, status);
    assert.equal(request.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
    assert.equal((await h.GET(new Request(url + "?portfolio=a&portfolio=b"))).status, status);
  }
  const request = post(); request.headers.set("X-Workbench-Session-Binding", "b".repeat(64));
  const h = harness(); assert.equal((await h.POST(request)).status, 401); assert.equal(request.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
});
test("verification mutations and artifact reads require an explicit session binding, but authenticated state can bootstrap", async () => {
  const h = harness(), unbound = post(); unbound.headers.delete("X-Workbench-Session-Binding");
  assert.equal((await h.POST(unbound)).status, 401); assert.equal(unbound.bodyUsed, false); assert.equal(h.calls.includes("open"), false);
  const artifact = harness(); assert.equal((await artifact.GET(new Request(url + "?portfolio=p&artifact=a"))).status, 401); assert.equal(artifact.calls.includes("open"), false);
  assert.equal((await harness().GET(new Request(url))).status, 200);
  const withQuery = harness(), queried = new Request(url + "?command=run", { method: "POST", headers: post().headers, body: "not JSON" });
  assert.equal((await withQuery.POST(queried)).status, 400); assert.equal(queried.bodyUsed, false); assert.equal(withQuery.calls.includes("open"), false);
});
test("verification POST uses only server actor and exact queued receipt, with post-effect session revalidation", async () => {
  const h = harness(), response = await h.POST(post()); assert.equal(response.status, 200);
  assert.deepEqual(h.calls, ["auth", "bind", "auth", "bind", "open", "request", "auth", "bind", "close"]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.arguments_[0][1])), { id: "synthetic-owner", kind: "human" });
  assert.deepEqual(JSON.parse(JSON.stringify(h.arguments_[0][2])), input);
  assert.equal((await response.json()).status, "queued"); assert.equal(response.headers.get("cache-control"), "private, no-store");
  for (const changedAt of [2, 3]) for (const userChanged of [false, true]) {
    const stale = harness({ changedAt, userChanged }), withheld = await stale.POST(post()); assert.equal(withheld.status, 401);
    assert.deepEqual(await withheld.json(), { error: "SESSION_CHANGED" }); assert.equal(stale.calls.includes("request"), changedAt === 3);
  }
});
test("verification GET scopes list/detail and rejects duplicate or mixed artifact selectors before storage", async () => {
  const h = harness(), response = await h.GET(new Request(url + "?portfolio=p&request=r")); assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(h.arguments_[0][1])), { portfolio: "p", request: "r" });
  assert.deepEqual(h.calls, ["auth", "bind", "open", "query", "auth", "bind", "close"]);
  for (const query of ["portfolio=p&portfolio=q", "portfolio=p&request=r&cursor=c", "portfolio=p&request=r&limit=1", "limit=51", "limit=0", "limit=01", "artifact=a", "portfolio=p&artifact=a&request=r", "portfolio=p&artifact=a&limit=1", "portfolio=p&command=run"]) {
    const rejected = harness(); assert.equal((await rejected.GET(get(query))).status, 400, query); assert.equal(rejected.calls.includes("open"), false);
  }
  const stale = harness({ changedAt: 2 }); assert.equal((await stale.GET(new Request(url))).status, 401); assert.equal(stale.calls.at(-1), "close");
});
test("private artifact download rechecks session and returns inert bytes with a fixed attachment filename", async () => {
  const h = harness(), response = await h.GET(get("portfolio=p&artifact=a")); assert.equal(response.status, 200);
  assert.deepEqual(h.arguments_[0].slice(1), ["p", "a"]); assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="verification-artifact.json"');
  assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("x-workbench-session-binding"), binding); assert.equal(response.headers.get("x-artifact-sha256"), "d".repeat(64));
  assert.equal(await response.text(), '{"synthetic":true,"not_script":"<script>"}\n');
  const stale = harness({ changedAt: 2 }), withheld = await stale.GET(get("portfolio=p&artifact=a"));
  assert.equal(withheld.status, 401); assert.doesNotMatch(await withheld.text(), /not_script|synthetic-artifact/);
});
test("verification request rejects claimed result, actor, runtime controls and duplicate JSON keys", async () => {
  for (const reason of ["Synthetic \ud800", "Synthetic \udfff", "Synthetic \u0000"]) {
    const h = harness(), raw = JSON.stringify({ command: { ...input, reason } });
    assert.match(raw, /\\u(?:d800|dfff|0000)/u);
    assert.equal((await h.POST(post(raw))).status, 400); assert.equal(h.calls.includes("open"), false);
  }
  const paired = harness();
  assert.equal((await paired.POST(post(JSON.stringify({ command: { ...input, reason: "Synthetic \ud83d\ude00" } })))).status, 200);
  assert.equal(paired.calls.includes("request"), true);
  for (const extra of [{ actor: "owner" }, { result: { status: "pass" } }, { command: "shell" }, { path: "/synthetic" }, { env: {} }, { fixture: {} }, { pass: true }]) {
    const h = harness(), response = await h.POST(post(JSON.stringify({ command: { ...input, ...extra } })));
    assert.equal(response.status, 400); assert.equal(h.calls.includes("open"), false);
  }
  for (const raw of [`{"command":${JSON.stringify(input)},"command":${JSON.stringify(input)}}`, JSON.stringify({ command: input, actor: "forged" }), "SYNTHETIC_PRIVATE_MARKER"]) {
    const h = harness(), response = await h.POST(post(raw)); assert.equal(response.status, 400); assert.doesNotMatch(await response.text(), /SYNTHETIC_PRIVATE_MARKER|forged/); assert.equal(h.calls.includes("open"), false);
  }
});
test("verification route bounds a 1 MiB UTF8 body and cancels oversized streams without waiting for cancellation", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1048577)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, body: stream, duplex: "half" } as RequestInit);
  const h = harness(), response = await h.POST(request); assert.equal(response.status, 413); assert.equal(response.headers.get("connection"), "close"); assert.equal(cancelled, true); assert.equal(h.calls.includes("open"), false);
  const declared = post(); declared.headers.set("Content-Length", "1048577"); assert.equal((await harness().POST(declared)).status, 413); assert.equal(declared.bodyUsed, false);
  const invalid = new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Session-Binding": binding }, body: new Uint8Array([0xc0, 0xaf]) }); assert.equal((await harness().POST(invalid)).status, 400);
});
test("safe verification errors preserve read-only and scope semantics without leaking raw evidence or storage details", async () => {
  for (const [code, expected] of [["VERIFICATION_CONTEXT_CHANGED", 409], ["VERIFICATION_IDEMPOTENCY_CONFLICT", 409], ["VERIFICATION_PERMISSION_DENIED", 403],
    ["VERIFICATION_ARTIFACT_NOT_FOUND", 404], ["VERIFICATION_QUERY_INVALID", 400], ["WORKBENCH_READ_ONLY", 423], ["VERIFICATION_SOURCE_UNAVAILABLE", 503],
    ["VERIFICATION_EVIDENCE_INVALID", 503], ["VERIFICATION_RESPONSE_TOO_LARGE", 503], ["VERIFICATION_PRIVATE_SECRET", 503], ["SQLITE_FAILURE SYNTHETIC_PRIVATE_MARKER", 503]] as const) {
    const response = await harness({ failure: code }).POST(post()); assert.equal(response.status, expected, code);
    assert.deepEqual(await response.json(), { error: expected === 503 && code !== "VERIFICATION_SOURCE_UNAVAILABLE" ? "WORKBENCH_UNAVAILABLE" : code });
  }
});
