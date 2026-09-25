import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { once } from "node:events";
import { MixedHttpClient, MixedHttpError, spawnOwned } from "../scripts/workbench-mixed-runtime";

async function server(t: { after: (fn: () => Promise<void>) => void }, handler: http.RequestListener) {
  const listener = http.createServer(handler);
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  t.after(async () => { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); });
  return new MixedHttpClient(`http://127.0.0.1:${(listener.address() as AddressInfo).port}`);
}
test("mixed HTTP transport restricts targets to loopback and retains complete response timings", async t => {
  for (const value of ["https://127.0.0.1:1234", "http://example.test:1234", "http://user:secret@127.0.0.1:1234", "http://127.0.0.1:1234/path"]) assert.throws(() => new MixedHttpClient(value));
  const client = await server(t, (_request, response) => { response.setHeader("Content-Type", "application/json"); response.end('{"ok":true}'); });
  await assert.rejects(() => client.request("//example.test/api/health"));
  const result = await client.request("/api/health"); assert.deepEqual(result.json, { ok: true }); assert.equal(result.status, 200);
  assert.ok(result.timing.started_ms <= result.timing.headers_ms! && result.timing.headers_ms! <= result.timing.completed_ms);
});
test("mixed HTTP request deadline covers a stalled response body, not just headers", async t => {
  const client = await server(t, (_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"unfinished":'); });
  const started = performance.now();
  await assert.rejects(() => client.request("/api/stalled", {}, { timeoutMs: 50 }), error => error instanceof MixedHttpError && ["HTTP_ABORTED", "HTTP_DEADLINE"].includes(error.code));
  assert.ok(performance.now() - started < 5000);
});
test("mixed HTTP bounds streaming bytes, rejects malformed UTF-8 and does not follow redirects", async t => {
  let redirected = 0;
  const client = await server(t, (request, response) => {
    if (request.url === "/api/large") response.end('"' + "x".repeat(1024) + '"');
    else if (request.url === "/api/utf8") response.end(Buffer.from([0x22, 0xff, 0x22]));
    else if (request.url === "/api/redirect") { response.writeHead(302, { Location: "/api/target" }); response.end("{}"); }
    else { redirected++; response.end("{}"); }
  });
  await assert.rejects(() => client.request("/api/large", {}, { maxBytes: 32 }), error => error instanceof MixedHttpError && error.code === "HTTP_RESPONSE_LIMIT");
  await assert.rejects(() => client.request("/api/utf8"), error => error instanceof MixedHttpError && error.code === "HTTP_INVALID_JSON");
  assert.equal((await client.request("/api/redirect")).status, 302); assert.equal(redirected, 0);
});
test("mixed HTTP parent cancellation prevents dispatch when already aborted", async t => {
  let calls = 0; const client = await server(t, (_request, response) => { calls++; response.end("{}"); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => client.request("/api/health", {}, { signal: controller.signal }), error => error instanceof MixedHttpError && error.code === "HTTP_ABORTED");
  assert.equal(calls, 0);
});

test("owned process cleanup stops a group even after its leader has exited", async t => {
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']}); child.stdout.once('data',()=>{process.stdout.write(String(child.pid));process.exit(0)});`;
  const owned = spawnOwned(process.execPath, ["-e", script], process.cwd(), process.env, { graceMs: 100 });
  t.after(async () => { try { await owned.stop(); } catch {} });
  await once(owned.child, "close");
  const descendant = Number(owned.snapshot().stdout); assert.ok(descendant > 0);
  process.kill(descendant, 0);
  await owned.stop();
  assert.equal(owned.snapshot().forced_stop, true); assert.equal(owned.snapshot().group_gone, true);
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
});

test("forced core shutdown never claims independently-sessioned children are quiescent", async t => {
  const owned = spawnOwned(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], process.cwd(), process.env, { graceMs: 100, requireCleanExit: true });
  t.after(async () => { try { await owned.stop(); } catch {} });
  await once(owned.child.stdout!, "data");
  await assert.rejects(() => owned.stop(), /CORE_CHILDREN_QUIESCENCE_UNPROVEN/);
  assert.equal(owned.snapshot().group_gone, true); assert.equal(owned.snapshot().clean_stop_verified, false);
  await assert.rejects(() => owned.stop(), /CORE_CHILDREN_QUIESCENCE_UNPROVEN/);
});

test("graceful core shutdown requires normal exit and permits only classified diagnostics", async t => {
  const owned = spawnOwned(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0));process.stderr.write('CSV_TRANSACTION_TIMING_MISSING\\n');process.stdout.write('ready');setInterval(()=>{},1000)"], process.cwd(), process.env, { requireCleanExit: true });
  t.after(async () => { try { await owned.stop(); } catch {} });
  await once(owned.child.stdout!, "data"); await owned.stop();
  const snapshot = owned.snapshot(); assert.equal(snapshot.exit_code, 0); assert.equal(snapshot.forced_stop, false); assert.equal(snapshot.clean_stop_verified, true);
  assert.equal(snapshot.truncated, false);
});

test("caught cleanup errors and truncated diagnostics invalidate a zero-exit core proof", async t => {
  for (const diagnostic of ['{"error":"TimeoutExpired"}\n', "x".repeat(100000)]) {
    const owned = spawnOwned(process.execPath, ["-e", `process.on('SIGTERM',()=>process.exit(0));process.stderr.write(${JSON.stringify(diagnostic)},()=>process.stdout.write('ready'));setInterval(()=>{},1000)`], process.cwd(), process.env, { requireCleanExit: true });
    t.after(async () => { try { await owned.stop(); } catch {} });
    await once(owned.child.stdout!, "data");
    await assert.rejects(() => owned.stop(), /CORE_CHILDREN_QUIESCENCE_UNPROVEN/);
    assert.equal(owned.snapshot().exit_code, 0); assert.equal(owned.snapshot().clean_stop_verified, false);
    assert.ok(Buffer.byteLength(owned.snapshot().stderr) <= 65536);
  }
});

test("permission-denied group probes remain uncertain until absence is actually observed", async t => {
  const owned = spawnOwned(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready');setInterval(()=>{},1000)"], process.cwd(), process.env, { requireCleanExit: true });
  const original = process.kill.bind(process); let probes = 0;
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid === -owned.child.pid! && signal === 0 && ++probes === 1) throw Object.assign(new Error("uncertain"), { code: "EPERM" });
    return original(pid, signal);
  });
  t.after(async () => { try { await owned.stop(); } catch {} });
  await once(owned.child.stdout!, "data"); await owned.stop();
  assert.ok(probes >= 2); assert.equal(owned.snapshot().group_gone, true); assert.equal(owned.snapshot().forced_stop, false);
});
