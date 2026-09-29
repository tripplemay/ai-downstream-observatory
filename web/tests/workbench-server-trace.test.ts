import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installServerTrace, installServerTraceFromEnvironment, summarizeServerTrace } from "../scripts/workbench-server-trace.mjs";

const runId = "1234567890abcdef1234567890abcdef", preload = fileURLToPath(new URL("../scripts/workbench-server-trace.mjs", import.meta.url));
function temporary() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "workbench-server-trace-")));
  chmodSync(directory, 0o700); return { directory, filename: path.join(directory, "trace.jsonl") };
}
async function listener(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { address: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
const headers = (id: string) => ({ "X-Workbench-Benchmark-Id": id });

test("server trace records real normal and streamed response completion without retaining query headers or body", async () => {
  const temp = temporary(), control = installServerTrace({ filename: temp.filename, runId });
  const app = await listener((request, response) => {
    if (request.method === "POST") { response.statusCode = 201; response.write("first"); setTimeout(() => response.end("last"), 25); }
    else { response.statusCode = 200; response.end("normal"); }
  });
  try {
    assert.equal(await (await fetch(`${app.address}/api/workbench?portfolio=DO_NOT_RETAIN_QUERY`, { headers: { ...headers(`${runId}:1`), Cookie: "DO_NOT_RETAIN_COOKIE" } })).text(), "normal");
    const streamed = await fetch(`${app.address}/api/workbench/csv/jobs?request=DO_NOT_RETAIN_QUERY`, { method: "POST", headers: headers(`${runId}:2`), body: "DO_NOT_RETAIN_BODY" });
    assert.equal(streamed.status, 201); assert.equal(await streamed.text(), "firstlast");
    await app.close(); control.stop();
    const raw = readFileSync(temp.filename, "utf8"), result = summarizeServerTrace(raw, runId);
    assert.equal(result.status, "PASS"); assert.equal(result.counts.begun, 2); assert.equal(result.counts.finished, 2);
    assert.equal(result.requests[`${runId}:2`].path, "/api/workbench/csv/jobs"); assert.ok(result.requests[`${runId}:2`].duration_ms >= 15);
    assert.equal(result.requests[`${runId}:2`].status, 201); assert.equal(result.requests[`${runId}:1`].outcome, "finish");
    assert.equal(raw.includes("DO_NOT_RETAIN"), false); assert.equal(statSync(temp.filename).mode & 0o777, 0o600);
  } finally { control.stop(); if (app.server.listening) await app.close(); rmSync(temp.directory, { recursive: true, force: true }); }
});

test("server trace distinguishes a disconnected real response from finish without pretending the mutation rolled back", async () => {
  const temp = temporary(), control = installServerTrace({ filename: temp.filename, runId });
  let observed: (() => void) | undefined;
  const closed = new Promise<void>(resolve => { observed = resolve; });
  const app = await listener((_request, response) => { response.on("close", () => observed!()); response.writeHead(200); response.write("partial"); });
  try {
    await new Promise<void>(resolve => {
      const request = http.get(`${app.address}/api/workbench`, { headers: headers(`${runId}:1`) }, response => {
        response.once("data", () => { response.destroy(); resolve(); }); response.on("error", () => {});
      }); request.on("error", () => {});
    });
    await closed; await app.close(); control.stop();
    const result = summarizeServerTrace(readFileSync(temp.filename, "utf8"), runId);
    assert.equal(result.status, "FAIL"); assert.deepEqual(result.errors, ["TRACE_ABORTED"]);
    assert.equal(result.requests[`${runId}:1`].outcome, "aborted"); assert.equal(result.counts.finished, 0);
  } finally { control.stop(); if (app.server.listening) await app.close(); rmSync(temp.directory, { recursive: true, force: true }); }
});

test("server trace stops with incomplete rather than zero-duration success when a response remains open", async () => {
  const temp = temporary(), control = installServerTrace({ filename: temp.filename, runId });
  let observed: (() => void) | undefined;
  const entered = new Promise<void>(resolve => { observed = resolve; });
  const app = await listener(() => observed!());
  const request = http.get(`${app.address}/api/workbench`, { headers: headers(`${runId}:1`) }); request.on("error", () => {});
  try {
    await entered; control.stop(); request.destroy(); await app.close();
    const result = summarizeServerTrace(readFileSync(temp.filename, "utf8"), runId);
    assert.equal(result.status, "FAIL"); assert.equal(result.requests[`${runId}:1`].outcome, "incomplete");
    assert.equal(result.requests[`${runId}:1`].duration_ms, null); assert.equal(result.requests[`${runId}:1`].status, null);
  } finally { control.stop(); request.destroy(); if (app.server.listening) await app.close(); rmSync(temp.directory, { recursive: true, force: true }); }
});

test("server trace preload preserves an actual application throw and retains an incomplete request on process exit", () => {
  const temp = temporary();
  try {
    const child = spawnSync(process.execPath, ["--import", preload, "-e", `const http=require('node:http');const s=http.createServer(()=>{throw new Error('APP_TEST_THROW')});s.listen(0,'127.0.0.1',()=>{http.get('http://127.0.0.1:'+s.address().port+'/api/workbench',{headers:{'X-Workbench-Benchmark-Id':'${runId}:1'}}).on('error',()=>{})})`],
      { timeout: 5000, encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test", WORKBENCH_SERVER_TRACE_PATH: temp.filename, WORKBENCH_SERVER_TRACE_RUN_ID: runId } });
    assert.equal(child.status, 1); assert.match(child.stderr, /APP_TEST_THROW/);
    const result = summarizeServerTrace(readFileSync(temp.filename, "utf8"), runId);
    assert.equal(result.status, "FAIL"); assert.equal(result.counts.incomplete, 1);
  } finally { rmSync(temp.directory, { recursive: true, force: true }); }
});

test("server trace ignores unconfigured IDs and non-allowlisted paths and methods", async () => {
  const temp = temporary(), control = installServerTrace({ filename: temp.filename, runId });
  const app = await listener((_request, response) => response.end("unchanged"));
  try {
    for (const [url, method, id] of [["/api/workbench", "GET", null], ["/api/auth/session", "GET", "SECRET"], ["/api/workbench", "PUT", "SECRET"]]) {
      assert.equal(await (await fetch(app.address + url, { method: method!, headers: id ? headers(id) : {} })).text(), "unchanged");
    }
    await app.close(); control.stop();
    const result = summarizeServerTrace(readFileSync(temp.filename, "utf8"), runId);
    assert.equal(result.status, "PASS"); assert.equal(result.counts.begun, 0);
  } finally { control.stop(); if (app.server.listening) await app.close(); rmSync(temp.directory, { recursive: true, force: true }); }
});

test("server trace pairs concurrent real requests independently even when they finish in reverse order", async () => {
  const temp = temporary(), control = installServerTrace({ filename: temp.filename, runId });
  let first: http.ServerResponse | undefined;
  const app = await listener((request, response) => {
    if (request.headers["x-workbench-benchmark-id"] === `${runId}:1`) first = response;
    else { response.end("second"); first!.end("first"); }
  });
  const firstRequest = fetch(`${app.address}/api/workbench`, { headers: headers(`${runId}:1`) });
  try {
    const deadline = Date.now() + 1000;
    while (!first && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(first, "First real request did not arrive");
    assert.equal(await (await fetch(`${app.address}/api/workbench`, { headers: headers(`${runId}:2`) })).text(), "second");
    assert.equal(await (await firstRequest).text(), "first"); await app.close(); control.stop();
    const raw = readFileSync(temp.filename, "utf8"), result = summarizeServerTrace(raw, runId);
    assert.equal(result.status, "PASS"); assert.equal(result.counts.finished, 2);
    assert.deepEqual(raw.trimEnd().split("\n").map(line => JSON.parse(line)).filter(row => row.type === "finish").map(row => row.request_id), [`${runId}:2`, `${runId}:1`]);
  } finally { control.stop(); if (app.server.listening) await app.close(); await firstRequest.catch(() => {}); rmSync(temp.directory, { recursive: true, force: true }); }
});

test("server trace invalid duplicate and over-capacity IDs fail integrity but never change HTTP responses", async () => {
  for (const [name, ids, expected, maxRequests] of [
    ["invalid", [`${runId}:01`], "INVALID_ID", 10],
    ["combined", [`${runId}:1, ${runId}:2`], "INVALID_ID", 10],
    ["other-run", [`${"f".repeat(32)}:1`], "INVALID_ID", 10],
    ["duplicate", [`${runId}:1`, `${runId}:1`], "DUPLICATE_ID", 10],
    ["capacity", [`${runId}:1`, `${runId}:2`], "CAPACITY_EXCEEDED", 1],
  ] as const) {
    const temp = temporary(), control = installServerTrace({ filename: temp.filename, runId, maxRequests });
    const app = await listener((_request, response) => response.end("unchanged"));
    try {
      for (const id of ids) assert.equal(await (await fetch(`${app.address}/api/workbench`, { headers: headers(id) })).text(), "unchanged", name);
      await app.close(); control.stop(); const result = summarizeServerTrace(readFileSync(temp.filename, "utf8"), runId);
      assert.equal(result.status, "FAIL"); assert.ok(result.errors.includes(expected));
    } finally { control.stop(); if (app.server.listening) await app.close(); rmSync(temp.directory, { recursive: true, force: true }); }
  }
});

test("server trace journal byte capacity is bounded and cannot silently discard records as PASS", async () => {
  const temp = temporary(), control = installServerTrace({ filename: temp.filename, runId, maxRequests: 100, maxBytes: 4096 });
  const app = await listener((_request, response) => response.end("unchanged"));
  try {
    for (let i = 0; i < 30; i++) assert.equal((await fetch(`${app.address}/api/workbench`, { headers: headers(`${runId}:${i}`) })).status, 200);
    await app.close(); control.stop(); assert.ok(statSync(temp.filename).size <= 4096);
    const result = summarizeServerTrace(readFileSync(temp.filename, "utf8"), runId); assert.equal(result.status, "FAIL"); assert.ok(result.errors.includes("CAPACITY_EXCEEDED"));
  } finally { control.stop(); if (app.server.listening) await app.close(); rmSync(temp.directory, { recursive: true, force: true }); }
});

test("server trace write errors are explicit incomplete evidence and leave application responses unchanged", async t => {
  const temp = temporary(), control = installServerTrace({ filename: temp.filename, runId }), journal = statSync(temp.filename);
  const original = fs.writeSync;
  const mocked = t.mock.method(fs, "writeSync", ((fd: number, ...args: unknown[]) => {
    const target = fs.fstatSync(fd);
    if (target.dev === journal.dev && target.ino === journal.ino) throw new Error("SYNTHETIC_WRITE_FAILURE");
    return Reflect.apply(original, fs, [fd, ...args]);
  }) as typeof fs.writeSync);
  syncBuiltinESMExports();
  const app = await listener((_request, response) => response.end("unchanged"));
  try {
    assert.equal(await (await fetch(`${app.address}/api/workbench`, { headers: headers(`${runId}:1`) })).text(), "unchanged");
    mocked.mock.restore(); syncBuiltinESMExports(); await app.close(); control.stop();
    assert.equal(summarizeServerTrace(readFileSync(temp.filename, "utf8"), runId).status, "FAIL");
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); control.stop(); if (app.server.listening) await app.close(); rmSync(temp.directory, { recursive: true, force: true }); }
});

test("server trace requires a private owned parent and exclusive new file, and remains disabled without environment", () => {
  const original = http.Server.prototype.emit, temp = temporary();
  try {
    assert.equal(installServerTraceFromEnvironment({}), null); assert.equal(http.Server.prototype.emit, original); assert.equal(existsSync(temp.filename), false);
    assert.throws(() => installServerTraceFromEnvironment({ WORKBENCH_SERVER_TRACE_PATH: temp.filename }));
    chmodSync(temp.directory, 0o755); assert.throws(() => installServerTrace({ filename: temp.filename, runId }), /SERVER_TRACE_DIRECTORY_INVALID/);
    chmodSync(temp.directory, 0o700); symlinkSync(temp.directory, path.join(temp.directory, "alias"));
    assert.throws(() => installServerTrace({ filename: path.join(temp.directory, "alias", "trace.jsonl"), runId }), /SERVER_TRACE_DIRECTORY_INVALID/);
    writeFileSync(temp.filename, "preserve", { mode: 0o600 });
    assert.throws(() => installServerTrace({ filename: temp.filename, runId }), /EEXIST/); assert.equal(readFileSync(temp.filename, "utf8"), "preserve");
    assert.equal(http.Server.prototype.emit, original);
  } finally { rmSync(temp.directory, { recursive: true, force: true }); }
});

test("server trace module has no preload side effects when both activation environment variables are absent", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {Server} from 'node:http';import assert from 'node:assert/strict';const original=Server.prototype.emit;await import(${JSON.stringify(new URL("../scripts/workbench-server-trace.mjs", import.meta.url).href)});assert.equal(Server.prototype.emit,original);`],
    { timeout: 5000, encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" } });
  assert.equal(child.status, 0); assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
});

test("server trace parser rejects missing duplicate malformed or mismatched records instead of inventing observations", async () => {
  const temp = temporary(), control = installServerTrace({ filename: temp.filename, runId });
  const app = await listener((_request, response) => { response.statusCode = 409; response.end("expected rejection"); });
  try {
    assert.equal((await fetch(`${app.address}/api/workbench`, { headers: headers(`${runId}:1`) })).status, 409);
    await app.close(); control.stop();
    const raw = readFileSync(temp.filename, "utf8"), lines = raw.trimEnd().split("\n");
    assert.equal(summarizeServerTrace(raw, runId).status, "PASS"); assert.equal(summarizeServerTrace(raw, runId).requests[`${runId}:1`].status, 409);
    const malformed = [lines.slice(0, -1), [lines[0], ...lines.slice(2)], [...lines.slice(0, 3), lines[2], lines[3]],
      [lines[0], lines[1].replace('"type":"begin"', '"type":"begin","body":"not allowed"'), ...lines.slice(2)],
      [lines[0], lines[1].replace('"type":"begin"', '"type":"begin","type":"begin"'), ...lines.slice(2)],
      [lines[0], lines[1], lines[2].replace(/"duration_ns":"\d+"/, '"duration_ns":"0"'), lines[3]], [...lines, lines[2]]];
    for (const records of malformed) assert.equal(summarizeServerTrace(records.join("\n") + "\n", runId).status, "FAIL");
    assert.equal(summarizeServerTrace(raw, "f".repeat(32)).status, "FAIL"); assert.equal(summarizeServerTrace(raw.slice(0, -1), runId).status, "FAIL");
  } finally { control.stop(); if (app.server.listening) await app.close(); rmSync(temp.directory, { recursive: true, force: true }); }
});
