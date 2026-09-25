import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export interface MixedHttpTiming { started_ms: number; headers_ms: number | null; completed_ms: number }
export interface MixedHttpResponse { status: number; json: any; headers: Headers; timing: MixedHttpTiming; bytes: number }
export class MixedHttpError extends Error {
  constructor(readonly code: string, readonly status: number | null, readonly timing: MixedHttpTiming) { super(code); }
}

/** Loopback-only transport. Its deadline includes headers and the entire bounded body. */
export class MixedHttpClient {
  private cookie = "";
  private binding = "";
  constructor(readonly address: string, readonly origin = "https://workbench.example.test") {
    const parsed = new URL(address);
    assert.equal(parsed.protocol, "http:"); assert.equal(parsed.hostname, "127.0.0.1");
    assert.ok(parsed.port); assert.equal(parsed.username + parsed.password + parsed.search + parsed.hash, ""); assert.equal(parsed.pathname, "/");
  }
  async request(url: string, init: RequestInit = {}, options: { signal?: AbortSignal; nowMs?: () => number; timeoutMs?: number; maxBytes?: number; json?: boolean } = {}): Promise<MixedHttpResponse> {
    assert.ok(url.startsWith("/api/") && !url.includes("#"));
    const target = new URL(url, this.address); assert.equal(target.origin, new URL(this.address).origin);
    const timeout = options.timeoutMs ?? 30000, maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 30000);
    assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 16 * 1024 * 1024);
    const now = options.nowMs ?? (() => performance.now()), timing: MixedHttpTiming = { started_ms: now(), headers_ms: null, completed_ms: 0 };
    const controller = new AbortController(); let status: number | null = null, rejectDeadline: (reason: Error) => void = () => {};
    const failed = (code: string) => new MixedHttpError(code, status, { ...timing, completed_ms: now() });
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const abort = () => { controller.abort(); rejectDeadline(failed("HTTP_ABORTED")); };
    const timer = setTimeout(() => { controller.abort(); rejectDeadline(failed("HTTP_DEADLINE")); }, timeout);
    const parentSignal = options.signal ?? init.signal ?? undefined;
    parentSignal?.addEventListener("abort", abort, { once: true });
    const operation = async () => {
      if (parentSignal?.aborted) throw failed("HTTP_ABORTED");
      const headers = new Headers(init.headers);
      if (this.cookie) headers.set("Cookie", this.cookie);
      if (this.binding) headers.set("X-Workbench-Session-Binding", this.binding);
      if (init.method && init.method !== "GET") headers.set("Origin", this.origin);
      let response: Response;
      try { response = await fetch(target, { ...init, headers, signal: controller.signal, redirect: "manual" }); }
      catch { throw failed(controller.signal.aborted ? "HTTP_ABORTED" : "HTTP_TRANSPORT_FAILED"); }
      status = response.status; timing.headers_ms = now();
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = response.body?.getReader();
      try {
        while (reader) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length;
          if (size > maxBytes) { controller.abort(); void reader.cancel().catch(() => {}); throw failed("HTTP_RESPONSE_LIMIT"); }
          chunks.push(next.value);
        }
      } catch (error) {
        if (error instanceof MixedHttpError) throw error;
        throw failed(controller.signal.aborted ? "HTTP_ABORTED" : "HTTP_BODY_FAILED");
      } finally { reader?.releaseLock(); }
      timing.completed_ms = now();
      if (controller.signal.aborted || parentSignal?.aborted || timing.completed_ms - timing.started_ms >= timeout) throw failed("HTTP_DEADLINE");
      let json: unknown = null;
      if (options.json !== false) {
        try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw failed("HTTP_INVALID_JSON"); }
      }
      if (controller.signal.aborted || parentSignal?.aborted || now() - timing.started_ms >= timeout) throw failed("HTTP_DEADLINE");
      return { status, json, headers: response.headers, timing: { ...timing }, bytes: size };
    };
    try { return await Promise.race([operation(), deadline]); }
    finally { clearTimeout(timer); parentSignal?.removeEventListener("abort", abort); }
  }
  post(url: string, body: unknown, options: Parameters<MixedHttpClient["request"]>[2] = {}) {
    return this.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, options);
  }
  async login(password: string) {
    const response = await this.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }).toString() }, { json: false });
    assert.equal(response.status, 303, "MIXED_LOGIN_FAILED");
    const cookie = response.headers.get("set-cookie"); assert.ok(cookie && /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=Strict/i.test(cookie));
    this.cookie = cookie.split(";")[0];
    const session = await this.request("/api/auth/session"); assert.equal(session.status, 200);
    assert.match(session.json.session_binding, /^[a-f0-9]{64}$/); this.binding = session.json.session_binding;
  }
}

export interface OwnedProcess {
  child: ChildProcess;
  snapshot(): { pid: number | null; exit_code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; truncated: boolean; forced_stop: boolean; group_gone: boolean; clean_stop_verified: boolean };
  stop(): Promise<void>;
}
function coreDiagnosticsClean(stderr: string): boolean {
  return stderr.split("\n").filter(Boolean).every(line => {
    if (line === "CSV_TRANSACTION_TIMING_MISSING") return true;
    if (!line.startsWith("CSV_TRANSACTION_TIMING ")) return false;
    try {
      const value = JSON.parse(line.slice("CSV_TRANSACTION_TIMING ".length));
      if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["schema_version", "outcome", "transaction_call_us", "begin_to_callback_us", "callback_us", "finalize_tail_us"].sort()) || value.schema_version !== "csv-transaction-timing-v1" || !["returned", "threw"].includes(value.outcome)) return false;
      const valid = (part: unknown) => typeof part === "number" && Number.isSafeInteger(part) && part >= 0;
      const parts = [value.begin_to_callback_us, value.callback_us, value.finalize_tail_us];
      return valid(value.transaction_call_us) && (parts.every(part => part === null) ? value.outcome === "threw" : parts.every(valid) && parts.reduce((total, part) => total + part, 0) === value.transaction_call_us);
    } catch { return false; }
  });
}
export function spawnOwned(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv, options: { graceMs?: number; requireCleanExit?: boolean } = {}): OwnedProcess {
  const graceMs = options.graceMs ?? 3000;
  assert.ok(Number.isSafeInteger(graceMs) && graceMs >= 1 && graceMs <= 30000);
  const child = spawn(command, args, { cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0), truncated = false;
  const retain = (old: Buffer, chunk: Buffer) => { const bytes = Buffer.concat([old, chunk]); if (bytes.length > 65536) truncated = true; return Buffer.from(bytes.subarray(-65536)); };
  child.stdout!.on("data", chunk => { stdout = retain(stdout, chunk); }); child.stderr!.on("data", chunk => { stderr = retain(stderr, chunk); });
  let spawnError: Error | undefined, closed = false, forced = false, groupGone = false, clean = false;
  child.once("close", () => { closed = true; }); child.once("error", error => { spawnError = error; });
  const groupAlive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      // Permission denial is not absence; keep polling within the stop deadline.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
      throw error;
    }
  };
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    // A group can outlive its leader; direct-child exit is not a cleanup proof.
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const waitGone = async (milliseconds: number) => {
    const until = performance.now() + milliseconds;
    do {
      groupGone = !groupAlive();
      if (groupGone && closed) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (performance.now() < until);
    groupGone = !groupAlive(); return groupGone && closed;
  };
  let stopping: Promise<void> | undefined;
  return { child, snapshot: () => ({ pid: child.pid ?? null, exit_code: child.exitCode, signal: child.signalCode, stdout: stdout.toString(), stderr: spawnError ? "PROCESS_SPAWN_FAILED" : stderr.toString(), truncated, forced_stop: forced, group_gone: groupGone, clean_stop_verified: clean }),
    stop() {
      stopping ??= (async () => {
        kill("SIGTERM");
        if (!await waitGone(graceMs)) { forced = true; kill("SIGKILL"); if (!await waitGone(2000)) throw new Error("PROCESS_STOP_TIMEOUT"); }
        // The real core CLI reaps independently-sessioned CSV children in finally.
        // Forced/abnormal core exit cannot prove that; retain the fixture and fail closed.
        // The CLI can catch a child-cleanup error and still exit zero: reject any
        // unclassified diagnostic or truncated output rather than lose that proof.
        if (options.requireCleanExit && (forced || spawnError || child.exitCode !== 0 || child.signalCode !== null || truncated || !coreDiagnosticsClean(stderr.toString()))) throw new Error("CORE_CHILDREN_QUIESCENCE_UNPROVEN");
        clean = true;
      })();
      return stopping;
    } };
}

export async function startMixedRuntime(input: { root: string; filename: string; dataDir: string; releaseHash: string; python: string; coreCount: number; pollSeconds: number }) {
  assert.ok(Number.isSafeInteger(input.coreCount) && input.coreCount >= 1 && input.coreCount <= 3);
  assert.ok(Number.isFinite(input.pollSeconds) && input.pollSeconds >= 0.1 && input.pollSeconds <= 5);
  assert.ok(existsSync(path.join(input.root, "web/.next/BUILD_ID")), "Production build required");
  const listener = net.createServer(); await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const password = randomBytes(24).toString("base64url"), salt = randomBytes(16), hash = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const base = { PATH: process.env.PATH, HOME: input.dataDir, TMPDIR: process.env.TMPDIR, TZ: "UTC", WORKBENCH_DB_PATH: input.filename,
    WORKBENCH_DATA_DIR: input.dataDir, WORKBENCH_MODE: "ledger", WORKBENCH_RELEASE_SHA256: input.releaseHash };
  const client = new MixedHttpClient(`http://127.0.0.1:${port}`), processes: OwnedProcess[] = [];
  const stop = async () => { const errors: Error[] = []; for (const child of [...processes].reverse()) { try { await child.stop(); } catch (error) { errors.push(error as Error); } } if (errors.length) throw new AggregateError(errors, "MIXED_PROCESS_CLEANUP_FAILED"); };
  try {
    const web = spawnOwned(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], path.join(input.root, "web"), {
      ...base, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", DB_PATH: path.join(input.dataDir, "legacy-must-not-exist.db"),
      WORKBENCH_ORIGIN: client.origin, WORKBENCH_PASSWORD_HASH: `scrypt$32768$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`, WORKBENCH_SESSION_SECRET: randomBytes(48).toString("base64url"),
    }); processes.push(web);
    const until = performance.now() + 30000; let ready = false;
    while (performance.now() < until) {
      assert.equal(web.child.exitCode, null, "MIXED_WEB_EXITED");
      try { if ((await client.request("/api/health", {}, { timeoutMs: 1000 })).status === 200) { ready = true; break; } } catch { /* Startup is bounded separately from measured requests. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, "MIXED_WEB_READINESS_TIMEOUT"); await client.login(password);
    for (let index = 0; index < input.coreCount; index++) processes.push(spawnOwned(input.python,
      ["-m", "worker.orchestration", "--db", input.filename, "--role", "core", "--poll-seconds", String(input.pollSeconds)], input.root,
      { ...base, NODE_ENV: "production", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", WORKBENCH_CSV_TRANSACTION_TIMING: "1" }, { graceMs: 15000, requireCleanExit: true }));
    return { client, processes, stop, port, buildId: readFileSync(path.join(input.root, "web/.next/BUILD_ID"), "utf8").trim() };
  } catch (error) { await stop(); throw error; }
}
