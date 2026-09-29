import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { mixedActivationRequest, mixedApprovalRequest, mixedCancelRequest, mixedLedgerRequest,
  mixedMarketRequest, mixedProposalRequest, mixedValuationRequest, type WorkbenchMixedFixture } from "./workbench-mixed-fixture";
import { MixedHttpError, startMixedRuntime, type MixedHttpResponse } from "./workbench-mixed-runtime";
import { runHttpLoad, summarizeHttpLoadSamples, type HttpLoadContext, type HttpLoadOperationResult, type HttpLoadReport } from "./workbench-http-load";
import { assertMixedGovernanceView, assertMixedLedgerView } from "./workbench-mixed-views";
import { summarizeServerTrace } from "./workbench-server-trace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), endpoint = "/api/workbench", csvEndpoint = `${endpoint}/csv/jobs`;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const code = (error: unknown) => error instanceof MixedHttpError ? error.code : error instanceof Error ? error.message.slice(0, 1024) : "UNKNOWN_FAILURE";
export function retainMixedAttachments(source: string, destination: string) {
  const directory = lstatSync(source);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o777) === 0o700, "SOURCE_ATTACHMENT_DIRECTORY_INVALID");
  assert.equal(existsSync(destination), false, "REFUSE_TO_OVERWRITE_ATTACHMENTS");
  mkdirSync(destination, { mode: 0o700 });
  assert.equal(lstatSync(destination).mode & 0o777, 0o700, "RETAINED_ATTACHMENT_DIRECTORY_MODE");
  const files = readdirSync(source).sort().map(name => {
    const from = path.join(source, name), to = path.join(destination, name), stat = lstatSync(from);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600, "SOURCE_ATTACHMENT_FILE_INVALID");
    const hash = sha(readFileSync(from)); copyFileSync(from, to, constants.COPYFILE_EXCL);
    assert.equal(lstatSync(to).mode & 0o777, 0o600, "RETAINED_ATTACHMENT_FILE_MODE");
    assert.equal(sha(readFileSync(to)), hash, "RETAINED_ATTACHMENT_BYTES_MISMATCH");
    return { name, sha256: hash, byte_size: stat.size, mode: "0600" };
  });
  return { directory_mode: "0700", files };
}
export function parseMixedOptions(args: string[]) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    history: { type: "string", default: "30" }, listings: { type: "string", default: "10" }, "market-rows": { type: "string", default: "50" },
    "csv-rows": { type: "string", default: "10" }, count: { type: "string", default: "20" }, "interval-ms": { type: "string", default: "50" },
    "max-queued": { type: "string", default: "32" }, "core-count": { type: "string", default: "1" }, "poll-seconds": { type: "string", default: "5" },
    "background-cycles": { type: "string", default: "1" }, "background-interval-ms": { type: "string", default: "20000" },
    "overall-seconds": { type: "string", default: "180" }, "setup-seconds": { type: "string", default: "600" }, output: { type: "string" },
  } });
  const integer = (name: keyof typeof values, low: number, high: number) => {
    const raw = values[name]; assert.ok(typeof raw === "string" && /^(0|[1-9]\d*)$/.test(raw), `INVALID_${name}`);
    const value = Number(raw); assert.ok(Number.isSafeInteger(value) && value >= low && value <= high, `INVALID_${name}`); return value;
  };
  const pollSeconds = Number(values["poll-seconds"]); assert.ok(Number.isFinite(pollSeconds) && pollSeconds >= .1 && pollSeconds <= 5, "INVALID_poll-seconds");
  return { history: integer("history", 6, 50000), listings: integer("listings", 2, 1000), marketRows: integer("market-rows", 0, 2000000),
    csvRows: integer("csv-rows", 1, 10000), count: integer("count", 1, 1000), intervalMs: integer("interval-ms", 1, 10000), maxQueued: integer("max-queued", 0, 1000),
    coreCount: integer("core-count", 1, 3), pollSeconds, overallMs: integer("overall-seconds", 30, 3600) * 1000,
    setupMs: integer("setup-seconds", 30, 3600) * 1000, backgroundCycles: integer("background-cycles", 1, 100),
    backgroundIntervalMs: integer("background-interval-ms", 100, 60000), output: values.output };
}
export function mixedCsvInput(fixture: WorkbenchMixedFixture, count: number) {
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 10000);
  const mapping = JSON.stringify({ schema_version: "csv-import-mapping-v1", mapping_id: "SYNTHETIC-MIXED-CSV", version: 1, title: "Synthetic mixed load only",
    dialect: { encoding: "utf-8", delimiter: ",", record_separator: "either" }, expected_headers: ["date", "amount", "source", "note"], ignored_columns: [],
    account: { kind: "constant", value: fixture.ids.csv.account_ids[0] }, event_type: { kind: "constant", value: "deposit" }, source_id: "synthetic-mixed-csv",
    source_event_id: { kind: "column", column: "source", trim: false, empty: "reject" }, reason: { kind: "column", column: "note", trim: false, empty: "reject" },
    effective_at: { column: "date", format: "YYYY-MM-DD", trim: false, source_timezone: "UTC" },
    rules: [{ event_type: "deposit", fields: { currency: { kind: "constant", value: "CNY" }, amount: { kind: "decimal", column: "amount", empty: "reject",
      format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false } } } }] });
  const bytes = Buffer.from("date,amount,source,note\n" + Array.from({ length: count }, (_, i) => `${fixture.clock.effective_date},${1000001 + i},mixed-csv:${i},Synthetic independently occurring deposit ${i}`).join("\n") + "\n");
  return { mapping, bytes, filename: "synthetic-mixed.csv", total_amount: String(BigInt(count) * (2000001n + BigInt(count)) / 2n) };
}
export function mixedOverlapSummary(load: HttpLoadReport, windows: { name: string; started_ms: number; completed_ms: number | null }[]) {
  const counts = Object.fromEntries(windows.map(window => [window.name, Object.fromEntries(Object.keys(load.classes).map(id => {
    const rows = load.samples.filter(row => row.class_id === id), end = window.completed_ms;
    return [id, {
      dispatched_during_window: end === null ? 0 : rows.filter(row => row.dispatched_ms !== null && row.dispatched_ms >= window.started_ms && row.dispatched_ms < end).length,
      operation_overlap: end === null ? 0 : rows.filter(row => row.dispatched_ms !== null && row.dispatched_ms < end && row.completed_ms > window.started_ms).length,
      measured_http_overlap: end === null ? 0 : rows.filter(row => {
        const timing = row.result?.http.timings;
        return timing && timing.started_ms < end && timing.completed_ms > window.started_ms;
      }).length,
    }];
  }))]));
  const names = new Set(windows.map(window => window.name));
  return { criterion: "Every completed background flow window has at least one actual dispatch and one measured target HTTP overlap for every class; not a SQLite lock claim.",
    windows: counts, verified: windows.length >= 3 && names.size === windows.length && names.has("csv_preview_flow") && names.has("csv_confirm_flow") &&
      windows.filter(window => /^market_valuation_update_flow(?::[1-9]\d*)?$/.test(window.name)).length === windows.length - 2 &&
      Object.keys(load.classes).length === 4 && windows.every(window => window.completed_ms !== null) &&
      Object.values(counts).every(classes => Object.values(classes).every(value => value.dispatched_during_window > 0 && value.measured_http_overlap > 0)) };
}
export function linkMixedServerTargets(attempts: { phase: string; sample_id: string | null; method: string; path: string; status: number | null;
  server_request_id?: string | null; error?: string | null }[], load: HttpLoadReport, trace: ReturnType<typeof summarizeServerTrace>) {
  const measuredPhases = new Set(["ledger-get", "governance-get", "record-fact", "approval:approve"]);
  const targets = attempts.filter(row => row.sample_id && measuredPhases.has(row.phase));
  const server_unobserved_targets = targets.filter(row => row.status === null).map(row => {
    assert.ok(row.error && row.server_request_id, "SERVER_TRACE_UNOBSERVED_TARGET_INVALID");
    return { sample_id: row.sample_id, request_id: row.server_request_id, error: row.error,
      server_observed: Boolean(trace.requests[row.server_request_id]) };
  });
  const server_samples = targets.filter(row => row.status !== null).map(row => {
    const measured = row.server_request_id ? trace.requests[row.server_request_id] : undefined;
    assert.ok(measured && measured.method === row.method && measured.path === row.path && measured.status === row.status && measured.outcome === "finish", "SERVER_TRACE_TARGET_MISMATCH");
    return { sample_id: row.sample_id, request_id: row.server_request_id, ...measured };
  });
  const bySample = new Map<string, typeof server_samples>();
  for (const sample of server_samples) {
    const group = bySample.get(sample.sample_id!) ?? [];
    group.push(sample); bySample.set(sample.sample_id!, group);
  }
  const successful = load.samples.filter(row => row.status === "success");
  for (const row of successful) assert.equal(bySample.get(row.sample_id)?.length, 1, "SERVER_TRACE_SUCCESS_MISSING");
  const server_latency = Object.fromEntries(Object.keys(load.classes).map(classId => {
    const durations = successful.filter(row => row.class_id === classId).map(row => bySample.get(row.sample_id)![0].duration_ms).sort((a, b) => a - b);
    const percentile = (p: number) => durations.length ? durations[Math.ceil(durations.length * p) - 1] : null;
    return [classId, { successful_count: durations.length, p50_ms: percentile(.5), p95_ms: percentile(.95), p99_ms: percentile(.99), max_ms: durations.at(-1) ?? null }];
  }));
  return { server_samples, server_unobserved_targets, server_latency };
}
export function removeVerifiedTemporary(directory: string, processesStopped: boolean, retentionVerified: boolean) {
  if (processesStopped && retentionVerified) rmSync(directory, { recursive: true, force: true });
  return !existsSync(directory);
}
function sourceSnapshot() {
  const files = execFileSync("git", ["-c", "core.filemode=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0")
    .filter(file => /^(contracts|migrations|web\/(src|scripts|tests)|worker|tests|scripts)\//.test(file) && /\.(ts|tsx|py|json|sql|mjs|sh)$/.test(file));
  return Object.fromEntries([...new Set([...files, "web/package.json", "web/package-lock.json", "requirements-workbench.txt",
    "web/dist/csv-background.mjs", "web/dist/monthly-evaluation.mjs", "web/dist/governance-fixture.mjs", "web/dist/governance-fixture.manifest.json", "web/.next/BUILD_ID"])].sort().map(file => [file, sha(readFileSync(path.join(root, file)))]));
}
export async function childJson(python: string, args: string[], environment: NodeJS.ProcessEnv, timeoutMs: number, label: "ORACLE" | "FIXTURE" = "ORACLE") {
  return new Promise<{ exit_code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; value: any; cleanup_verified: boolean }>(resolve => {
    const child = spawn(python, args, { cwd: root, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", limited = false, expired = false, stopping = false, closed = false, settled = false;
    let escalation: NodeJS.Timeout | undefined, finalDeadline: NodeJS.Timeout | undefined, poll: NodeJS.Timeout | undefined;
    const groupGone = () => {
      if (!child.pid) return true;
      try { process.kill(-child.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    };
    const signal = (value: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, value); } catch {} } };
    const finish = (cleanupVerified: boolean) => {
      if (settled) return; settled = true;
      clearTimeout(timer); if (escalation) clearTimeout(escalation); if (finalDeadline) clearTimeout(finalDeadline); if (poll) clearTimeout(poll);
      let value = null; if (cleanupVerified && !limited && !expired) { try { value = JSON.parse(stdout); } catch {} }
      if (!cleanupVerified) { child.stdout!.destroy(); child.stderr!.destroy(); child.unref(); }
      resolve({ exit_code: child.exitCode, signal: child.signalCode, stdout, stderr: !cleanupVerified ? `${label}_CLEANUP_UNCONFIRMED` : limited ? `${label}_OUTPUT_LIMIT` : expired ? `${label}_TIMEOUT` : stderr, value, cleanup_verified: cleanupVerified });
    };
    const check = () => { if (settled) return; if (closed && groupGone()) finish(true); else poll = setTimeout(check, 25); };
    const stop = () => {
      if (stopping || settled) return; stopping = true; signal("SIGTERM");
      escalation = setTimeout(() => signal("SIGKILL"), 2000);
      finalDeadline = setTimeout(() => finish(closed && groupGone()), 4000); check();
    };
    const retain = (old: string, chunk: Buffer) => { if (Buffer.byteLength(old) + chunk.length > 16 * 1024 * 1024) { limited = true; stop(); return old; } return old + chunk.toString(); };
    child.stdout!.on("data", chunk => { stdout = retain(stdout, chunk); }); child.stderr!.on("data", chunk => { stderr = retain(stderr, chunk); });
    const timer = setTimeout(() => { expired = true; stop(); }, timeoutMs);
    child.once("error", error => { stderr = code(error); });
    child.once("close", () => { closed = true; if (groupGone()) finish(true); else stop(); });
  });
}

export async function runMixedBenchmark(options: ReturnType<typeof parseMixedOptions>) {
  const output = path.resolve(options.output ?? path.join(root, "artifacts/verification/workbench-mixed", new Date().toISOString().replace(/[:.]/g, "-"), "report.json"));
  const evidence = path.dirname(output), allowed = path.join(root, "artifacts/verification") + path.sep;
  assert.ok(output.startsWith(allowed), "OUTPUT_MUST_BE_IGNORED_VERIFICATION_EVIDENCE"); assert.equal(existsSync(output), false, "REFUSE_TO_OVERWRITE_EVIDENCE");
  mkdirSync(evidence, { recursive: true });
  const journal = path.join(evidence, "http-attempts.jsonl"); assert.equal(existsSync(journal), false); writeFileSync(journal, "", { flag: "wx" });
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "workbench-mixed-"))), filename = path.join(temporary, "workbench.db"), dataDir = path.join(temporary, "auth");
  const python = process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3", start = performance.now(), now = () => performance.now() - start;
  const report: Record<string, any> = { schema_version: "workbench-mixed-benchmark-v1", status: "RUNNING", started_at: new Date().toISOString(),
    requested: options, environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, memory_bytes: os.totalmem() },
    performance_gate: false, production: false, completed_requirements: [], status_scope: "synthetic_correctness_only", mixed_overlap_verified: false,
    normal_worker_defaults: { core_count: 1, poll_seconds: 5 },
    boundaries: ["Synthetic temporary database, authenticated loopback production Next, continuous core worker; no provider credentials or network provider.",
      "Legacy gate/research prerequisites are explicitly synthetic scaffolding, never real gate verification or investment admission.",
      "Fixed independent arrivals never pad idle samples or retry mutations. Timeouts do not prove rollback; final oracle checks actual effects after all owned processes stop.",
      "Operation wall includes setup and cleanup. http.timings isolates the selected HTTP POST, not server-only execution time.",
      "Overlap windows cover observed request/queue/worker/proof flow, not exact SQLite writer-lock instants.",
      "First measured versus subsequent samples are not a cold-server claim; bootstrap HTTP already ran. Bucket sample targets are null unless separately specified.",
      "Every planned class must have its requested successful count; this smoke is not a 1000-sample/resource-constrained/SLA acceptance."],
    attempts: [], errors: [], windows: [], source_before: {}, oracles: {}, phase_times: {}, csv_timing: {}, background_schedule: [], temporary_directory: temporary,
  };
  const persist = () => writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  let fixture: WorkbenchMixedFixture | undefined, runtime: Awaited<ReturnType<typeof startMixedRuntime>> | undefined, baseline: any = null, sealed = false, oracleCleanupVerified = true, runtimeCleanupVerified = true;
  const records: { command: unknown; receipt: unknown }[] = [], approvals: { proposal_id: string; approval_id: string; cancel_id: string }[] = [], marketIds: string[] = [], valuationIds: string[] = [];
  let csv: { preview_request_id: string; confirm_request_id: string | null; rows: number; csv_sha256: string; mapping_sha256: string } | null = null;
  const abort = new AbortController(), pendingRequests = new Set<Promise<unknown>>();
  let wholeDeadline = setTimeout(() => abort.abort(), options.setupMs);
  const attempt = async (phase: string, url: string, init: RequestInit, requestBody: unknown, clock = now, signal = abort.signal, sampleId: string | null = null) => {
    assert.equal(sealed, false, "MIXED_REPORT_SEALED");
    assert.ok(runtime, "RUNTIME_NOT_STARTED");
    const record: Record<string, any> = { id: `http:${report.attempts.length}`, phase, sample_id: sampleId, method: init.method ?? "GET", path: url.split("?", 1)[0],
      query: Object.fromEntries(new URL(url, "http://127.0.0.1").searchParams), request: requestBody, clock_origin: clock === now ? "run" : "load", dispatched_ms: clock(),
      completed_ms: null, status: null, error: null, response: null, effect: "unknown_until_oracle" };
    report.attempts.push(record); appendFileSync(journal, JSON.stringify({ event: "before_dispatch", ...record }) + "\n");
    const promise = runtime.client.request(url, init, { signal, nowMs: clock, timeoutMs: 30000, maxBytes: 16 * 1024 * 1024 }); pendingRequests.add(promise);
    try {
      const response = await promise;
      if (!sealed) {
        Object.assign(record, { completed_ms: response.timing.completed_ms, status: response.status, timing: response.timing, server_request_id: response.requestId,
          response: { bytes: response.bytes, parsed_json_sha256: sha(JSON.stringify(response.json)),
            id: response.json?.id ?? null, request_id: response.json?.request_id ?? null, revision: response.json?.revision ?? null, status: response.json?.status ?? null, error: response.json?.error ?? null } });
        appendFileSync(journal, JSON.stringify({ event: "response", ...record }) + "\n");
      }
      return response;
    } catch (error) {
      if (!sealed) { Object.assign(record, { completed_ms: clock(), status: error instanceof MixedHttpError ? error.status : null, server_request_id: error instanceof MixedHttpError ? error.requestId : null, error: code(error) }); appendFileSync(journal, JSON.stringify({ event: "failed", ...record }) + "\n"); }
      throw error;
    } finally { pendingRequests.delete(promise); }
  };
  const post = (phase: string, body: unknown, context?: HttpLoadContext, url = endpoint) => attempt(phase, url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, body, context?.nowMs ?? now, context?.signal ?? abort.signal, context?.sampleId ?? null);
  const get = (phase: string, url: string, context?: HttpLoadContext) => attempt(phase, url, {}, null, context?.nowMs ?? now, context?.signal ?? abort.signal, context?.sampleId ?? null);
  const accepted = (response: MixedHttpResponse) => { assert.equal(response.status, 200, `HTTP_${response.status}:${response.json?.error ?? "unexpected"}`); return response.json; };
  const sleep = async () => { if (abort.signal.aborted) throw new Error("MIXED_OVERALL_DEADLINE"); await new Promise(resolve => setTimeout(resolve, 100)); };
  const oracle = async (phase: "baseline" | "preview" | "complete") => {
    assert.ok(fixture);
    const input = { schema_version: "workbench-mixed-oracle-input-v1", phase, fixture, baseline, csv: phase === "baseline" ? null : csv,
      records: phase === "complete" ? records : [], approvals: phase === "complete" ? approvals : [], market_request_ids: phase === "complete" ? marketIds : [], valuation_request_ids: phase === "complete" ? valuationIds : [] };
    const inputFile = path.join(evidence, `oracle-${phase}-input.json`); writeFileSync(inputFile, JSON.stringify(input, null, 2) + "\n", { flag: "wx" });
    const oracleStarted = now();
    const result = await childJson(python, ["tests/performance/mixed_workload_oracle.py", "--db", filename, "--data-dir", dataDir, "--expected", inputFile],
      { PATH: process.env.PATH, NODE_ENV: "test", PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1", WORKBENCH_DATA_DIR: dataDir }, 60000);
    oracleCleanupVerified &&= result.cleanup_verified;
    report.oracles[phase] = { ...result, started_ms: oracleStarted, completed_ms: now() };
    writeFileSync(path.join(evidence, `oracle-${phase}.json`), JSON.stringify(report.oracles[phase], null, 2) + "\n", { flag: "wx" }); persist();
    assert.equal(result.cleanup_verified, true, "ORACLE_CLEANUP_UNCONFIRMED");
    assert.equal(result.exit_code, 0, `ORACLE_${phase}_FAILED:${result.stdout || result.stderr}`); assert.equal(result.value?.status, "passed");
    if (phase === "baseline") baseline = result.value.baseline;
    return result.value;
  };
  const task = async (phase: string, body: ReturnType<typeof mixedMarketRequest> | ReturnType<typeof mixedValuationRequest>, kind: "market" | "valuation") => {
    const receipt = accepted(await post(phase, body)); assert.equal(typeof receipt.request_id, "string");
    (kind === "market" ? marketIds : valuationIds).push(receipt.request_id);
    for (;;) {
      const state = accepted(await get(`${phase}:poll`, `${endpoint}?portfolio=${encodeURIComponent(body.command.portfolio_id)}`));
      const job = state.tasks.find((row: any) => row.id === receipt.request_id);
      if (job?.status === "succeeded") return { request_id: receipt.request_id, ...JSON.parse(job.result_json) };
      if (job && ["failed", "dead_letter", "cancelled", "skipped", "partial"].includes(job.status)) throw new Error(`MIXED_TASK_${job.status.toUpperCase()}`);
      await sleep();
    }
  };
  const csvResult = async (requestId: string, phase: string) => {
    for (;;) {
      const state = accepted(await get(`${phase}:poll`, `${csvEndpoint}?portfolio=${encodeURIComponent(fixture!.ids.csv.portfolio_id)}&request=${encodeURIComponent(requestId)}`));
      if (state.item.status === "succeeded") { assert.ok(state.item.result); return state.item.result; }
      if (["failed", "dead_letter", "cancelled", "expired", "partial", "skipped"].includes(state.item.status)) throw new Error(`MIXED_CSV_${state.item.status.toUpperCase()}`);
      await sleep();
    }
  };
  let load: Promise<HttpLoadReport> | undefined;
  try {
    persist(); report.source_before = sourceSnapshot();
    report.phase_times.fixture = { started_ms: now(), completed_ms: null };
    const seeded = await childJson(process.execPath, ["--import", path.join(root, "web/node_modules/tsx/dist/loader.mjs"), path.join(root, "web/scripts/create-workbench-mixed-fixture.ts"),
      JSON.stringify({ filename, dataDir, history: options.history, listings: options.listings, marketRows: options.marketRows })],
      { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: temporary, NODE_ENV: "test", TZ: "UTC" }, options.setupMs, "FIXTURE");
    report.fixture_process = { ...seeded, value: undefined, stdout: undefined, stdout_sha256: sha(seeded.stdout) };
    runtimeCleanupVerified = seeded.cleanup_verified;
    report.phase_times.fixture.completed_ms = now(); persist();
    assert.equal(seeded.exit_code, 0, `FIXTURE_FAILED:${seeded.stderr}`);
    assert.equal(seeded.cleanup_verified, true, "FIXTURE_CLEANUP_UNCONFIRMED");
    assert.equal(seeded.value?.schema_version, "workbench-mixed-fixture-v1", "FIXTURE_RESULT_INVALID");
    fixture = seeded.value as WorkbenchMixedFixture;
    report.fixture = fixture; await oracle("baseline");
    // A failed startup may also fail its internal cleanup before exposing handles.
    runtimeCleanupVerified = false;
    runtime = await startMixedRuntime({ root, filename, dataDir, releaseHash: fixture.releaseHash, python, coreCount: options.coreCount, pollSeconds: options.pollSeconds });
    runtimeCleanupVerified = true;
    report.runtime = { build_id: runtime.buildId, core_count: options.coreCount, poll_seconds: options.pollSeconds, port: runtime.port };
    for (const kind of ["approval", "valuation", "fx"] as const) await task(`bootstrap:${kind}`, mixedMarketRequest(fixture, kind, 0), "market");
    const approvalValuation = await task("bootstrap:approval-valuation", mixedValuationRequest(fixture, "approval", 0), "valuation");
    await task("bootstrap:valuation", mixedValuationRequest(fixture, "valuation", 0), "valuation");
    const activation = accepted(await post("bootstrap:activation", mixedActivationRequest(fixture, approvalValuation.valuation_id))); assert.equal(typeof activation.id, "string");
    report.bootstrap = { activation_id: activation.id, approval_valuation_id: approvalValuation.valuation_id };
    assert.equal(abort.signal.aborted, false, "MIXED_SETUP_DEADLINE");
    clearTimeout(wholeDeadline); wholeDeadline = setTimeout(() => abort.abort(), options.overallMs);
    report.phase_times.load = { started_ms: now(), completed_ms: null };
    let loadOrigin: number | undefined;
    const loadClock = () => performance.now() - loadOrigin!;
    const classOperation = (kind: "ledger-get" | "governance-get" | "record-fact" | "approval") => async (context: HttpLoadContext): Promise<HttpLoadOperationResult> => {
      let measured: MixedHttpResponse | MixedHttpError | undefined;
      const measure = async (call: () => Promise<MixedHttpResponse>) => { try { measured = await call(); return accepted(measured); } catch (error) { if (error instanceof MixedHttpError) measured = error; throw error; } };
      const method = kind.endsWith("get") ? "GET" : "POST";
      const result = (ok: boolean, error?: unknown): HttpLoadOperationResult => ({ ok, http: { method, url: endpoint, status: measured?.status ?? null,
        ...(measured ? { timings: measured.timing } : {}) },
        ...(ok ? {} : { error: { code: "MIXED_OPERATION_FAILED", message: code(error) } }) });
      try {
        if (kind === "ledger-get") assertMixedLedgerView(await measure(() => get(kind, `${endpoint}?portfolio=${fixture!.ids.csv.portfolio_id}`, context)), fixture!, options.csvRows);
        else if (kind === "governance-get") assertMixedGovernanceView(await measure(() => get(kind, `${endpoint}?portfolio=${fixture!.ids.approval.portfolio_id}&view=governance`, context)), fixture!, activation.id);
        else if (kind === "record-fact") {
          const state = accepted(await get("record-fact:revision", `${endpoint}?portfolio=${fixture!.ids.ledger.portfolio_id}`, context));
          const body = mixedLedgerRequest(fixture!, context.index, state.revision), receipt = await measure(() => post(kind, body, context));
          assert.equal(receipt.revision, state.revision + 1); assert.equal(typeof receipt.event_id, "string"); records.push({ command: body.command, receipt });
        } else {
          const proposal = accepted(await post("approval:create", mixedProposalRequest(fixture!, activation.id, approvalValuation.valuation_id, context.index), context));
          const approved = await measure(() => post("approval:approve", mixedApprovalRequest(fixture!, proposal, context.index), context));
          assert.equal(approved.broker_order_sent, false); assert.equal(approved.status, "approved_pending_manual_execution");
          const cancelled = accepted(await post("approval:cancel", mixedCancelRequest(fixture!, proposal.id, context.index), context));
          assert.equal(cancelled.facts_changed, false); assert.equal(cancelled.released, 1);
          approvals.push({ proposal_id: proposal.id, approval_id: approved.id, cancel_id: cancelled.id });
        }
        return result(true);
      } catch (error) { return result(false, error); }
    };
    load = runHttpLoad({ overallTimeoutMs: options.overallMs, drainTimeoutMs: 35000, signal: abort.signal,
      runtime: { now: () => { const value = performance.now(); loadOrigin ??= value; return value; }, setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: handle => clearTimeout(handle as NodeJS.Timeout) },
      classes: (["ledger-get", "governance-get", "record-fact", "approval"] as const).map(id => ({ id, count: options.count, intervalMs: options.intervalMs,
        maxInFlight: id.endsWith("get") ? 2 : 1, maxQueued: options.maxQueued, queueTimeoutMs: 30000, requestTimeoutMs: 30000,
        target: { method: id.endsWith("get") ? "GET" : "POST", url: endpoint }, operation: classOperation(id) })) });
    const window = async (name: string, action: () => Promise<void>) => {
      const value = { name, started_ms: loadClock(), completed_ms: null as number | null }; report.windows.push(value);
      try { await action(); } finally { value.completed_ms = loadClock(); persist(); }
    };
    const input = mixedCsvInput(fixture, options.csvRows);
    writeFileSync(path.join(evidence, "csv-original.csv"), input.bytes, { flag: "wx" }); writeFileSync(path.join(evidence, "mapping-original.json"), input.mapping, { flag: "wx" });
    report.csv_input = { rows: options.csvRows, filename: input.filename, source_id: "synthetic-mixed-csv", total_amount: input.total_amount, csv_sha256: sha(input.bytes), raw_mapping_sha256: sha(input.mapping) };
    let preview: any;
    const flows = await Promise.allSettled([(async () => {
      await window("csv_preview_flow", async () => {
        report.csv_timing.preview = { submitted_ms: now(), accepted_ms: null, terminal_observed_ms: null,
          scope: "submission_to_terminal_HTTP_observation; includes queue and transport, excludes independent oracle" };
        const form = new FormData();
        for (const [key, value] of Object.entries({ portfolio_id: fixture!.ids.csv.portfolio_id, account_id: fixture!.ids.csv.account_ids[0], expected_revision: String(fixture!.revisions.csv), mapping: input.mapping })) form.set(key, value);
        form.set("file", new Blob([new Uint8Array(input.bytes)], { type: "text/csv" }), "upload.csv");
        const response = accepted(await attempt("csv:preview", csvEndpoint, { method: "POST", headers: { "X-CSV-Idempotency-Key": "mixed-csv-preview",
          "X-CSV-Background-Acknowledged": "true", "X-CSV-Original-Filename": Buffer.from(input.filename).toString("base64url") }, body: form }, report.csv_input));
        csv = { preview_request_id: response.request_id, confirm_request_id: null, rows: options.csvRows, csv_sha256: sha(input.bytes), mapping_sha256: sha(input.mapping) };
        report.csv_timing.preview.accepted_ms = now();
        preview = await csvResult(response.request_id, "csv:preview");
        report.csv_timing.preview.terminal_observed_ms = now();
        assert.equal(preview.error_count, 0); assert.equal(preview.row_count, options.csvRows); assert.equal(preview.required_review_count, 0);
      });
      await oracle("preview");
      await window("csv_confirm_flow", async () => {
        report.csv_timing.confirm = { submitted_ms: now(), accepted_ms: null, terminal_observed_ms: null,
          scope: "submission_to_terminal_HTTP_observation; includes queue and transport, excludes independent oracle" };
        const payload = { action: "confirm_import", portfolio_id: fixture!.ids.csv.portfolio_id, batch_id: preview.batch_id, preview_hash: preview.preview_hash,
          expected_revision: fixture!.revisions.csv, csv_review: { acknowledge_unverified_mapping: true, review_hash: preview.review_hash, rows: [] } };
        const response = accepted(await post("csv:confirm", { action: "confirm", command: { portfolio_id: fixture!.ids.csv.portfolio_id, account_id: fixture!.ids.csv.account_ids[0],
          idempotency_key: "mixed-csv-confirm", payload_text: JSON.stringify(payload), acknowledge_background_execution: true } }, undefined, csvEndpoint));
        csv!.confirm_request_id = response.request_id; report.csv_timing.confirm.accepted_ms = now();
        const confirmed = await csvResult(response.request_id, "csv:confirm"); report.csv_timing.confirm.terminal_observed_ms = now();
        assert.equal(confirmed.confirmed_revision, fixture!.revisions.csv + options.csvRows);
      });
    })(), (async () => {
      for (let index = 0; index < options.backgroundCycles; index++) {
        const planned = index * options.backgroundIntervalMs;
        while (loadClock() < planned) await sleep();
        if (abort.signal.aborted) throw new Error("MIXED_OVERALL_DEADLINE");
        const schedule = { cycle: index + 1, scheduled_ms: planned, started_ms: loadClock(), completed_ms: null as number | null };
        report.background_schedule.push(schedule);
        try {
          await window(index === 0 ? "market_valuation_update_flow" : `market_valuation_update_flow:${index + 1}`, async () => {
            const sequence = index + 1;
            await task(`update:${sequence}:valuation-price`, mixedMarketRequest(fixture!, "valuation", sequence, sequence), "market");
            await task(`update:${sequence}:fx`, mixedMarketRequest(fixture!, "fx", sequence, sequence), "market");
            await task(`update:${sequence}:valuation`, mixedValuationRequest(fixture!, "valuation", sequence), "valuation");
          });
        } finally { schedule.completed_ms = loadClock(); }
      }
    })()]);
    for (const [index, result] of flows.entries()) if (result.status === "rejected") report.errors.push({ stage: index === 0 ? "csv_flow" : "market_valuation_flow", message: code(result.reason) });
    report.load = await load;
    report.phase_times.load.completed_ms = now();
    report.buckets = Object.fromEntries(Object.keys(report.load.classes).map(id => {
      const rows = (report.load as HttpLoadReport).samples.filter(row => row.class_id === id);
      return [id, { first_measured: summarizeHttpLoadSamples(rows.filter(row => row.index === 0)), subsequent: summarizeHttpLoadSamples(rows.filter(row => row.index > 0)),
        ...Object.fromEntries(report.windows.map((value: any) => [value.name, summarizeHttpLoadSamples(rows.filter(row => row.dispatched_ms !== null && row.dispatched_ms < value.completed_ms && row.completed_ms > value.started_ms))])) }];
    }));
    report.overlap = mixedOverlapSummary(report.load, report.windows); report.mixed_overlap_verified = report.overlap.verified;
  } catch (error) { report.errors.push({ stage: "workload", message: code(error) }); }
  finally {
    abort.abort(); clearTimeout(wholeDeadline);
    if (load && !report.load) { try { report.load = await load; } catch (error) { report.errors.push({ stage: "scheduler", message: code(error) }); } }
    if (runtime) { try { await runtime.stop(); } catch (error) { runtimeCleanupVerified = false; report.errors.push({ stage: "cleanup", message: code(error) }); } report.processes = runtime.processes.map(process => process.snapshot()); }
    if (runtime && runtimeCleanupVerified) {
      try {
        const traceBytes = readFileSync(runtime.trace.path), retained = path.join(evidence, "server-trace.jsonl");
        writeFileSync(retained, traceBytes, { flag: "wx", mode: 0o600 });
        const trace = summarizeServerTrace(traceBytes.toString("utf8"), runtime.trace.runId);
        report.server_trace = { ...trace, path: "server-trace.jsonl", sha256: sha(traceBytes),
          scope: "HTTP request event to response finish; excludes pre-request socket/event-loop queue and client receive/parse; includes server streaming/backpressure and begin-observer write overhead" };
        assert.equal(trace.status, "PASS", "SERVER_TRACE_INCOMPLETE");
        assert.ok(!report.processes.some((row: any) => row.stderr.includes("WORKBENCH_SERVER_TRACE_INTEGRITY_FAILED")), "SERVER_TRACE_DIAGNOSTIC_FAILURE");
        Object.assign(report, linkMixedServerTargets(report.attempts, report.load, trace));
      } catch (error) { report.errors.push({ stage: "server_trace", message: code(error) }); }
    }
    if (pendingRequests.size) { let timer: NodeJS.Timeout | undefined; await Promise.race([Promise.allSettled([...pendingRequests]), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); if (timer) clearTimeout(timer); }
    sealed = true; report.unsettled_http_at_return = pendingRequests.size;
    const stopped = runtimeCleanupVerified && oracleCleanupVerified && (!runtime || report.processes.every((process: any) => process.exit_code !== null || process.signal !== null));
    report.owned_processes_stopped = stopped;
    report.uncertain_writers = !stopped;
    if (fixture && baseline && stopped) { try { await oracle("complete"); } catch (error) { report.errors.push({ stage: "final_oracle", message: code(error) }); } }
    else if (!stopped) report.errors.push({ stage: "final_oracle", message: "NOT_RUN_PROCESSES_NOT_STOPPED" });
    const cleanupVerified = stopped && oracleCleanupVerified;
    report.owned_processes_stopped = cleanupVerified; report.uncertain_writers = !cleanupVerified;
    // A timed-out fixture child can leave a partial database without a result.
    let retentionVerified = !fixture && !existsSync(filename);
    if (fixture && cleanupVerified) {
      try {
        const db = new Database(filename, { readonly: true }); try { await db.backup(path.join(evidence, "final-workbench.db")); } finally { db.close(); }
        const attachments = existsSync(path.join(dataDir, "attachments")) ? retainMixedAttachments(path.join(dataDir, "attachments"), path.join(evidence, "attachments")) : null;
        report.retained_database = { path: "final-workbench.db", sha256: sha(readFileSync(path.join(evidence, "final-workbench.db"))), attachments: "attachments", attachment_evidence: attachments, auth_database_retained: false };
        retentionVerified = true;
      } catch (error) { report.errors.push({ stage: "retention", message: code(error) }); }
    }
    report.retention_verified = retentionVerified;
    try { report.source_after = sourceSnapshot(); report.source_drift = [...new Set([...Object.keys(report.source_before), ...Object.keys(report.source_after)])].filter(file => report.source_before[file] !== report.source_after[file]); }
    catch (error) { report.errors.push({ stage: "source_snapshot", message: code(error) }); report.source_drift = null; }
    const classes = report.load?.classes as HttpLoadReport["classes"] | undefined;
    const complete = classes && Object.keys(classes).length === 4 && Object.values(classes).every(value => value.succeeded === options.count && value.failed === 0 && value.unsettled_at_return === 0);
    if (classes && !complete) report.errors.push({ stage: "load", message: "MIXED_CLASS_SHORTFALL",
      classes: Object.fromEntries(Object.entries(classes).map(([id, value]) => [id, { succeeded: value.succeeded, failed: value.failed, statuses: value.statuses }])) });
    report.status = !report.errors.length && report.source_drift?.length === 0 && !pendingRequests.size && cleanupVerified && complete && report.oracles.complete?.value?.status === "passed" ? "PASS" : "FAIL";
    report.finished_at = new Date().toISOString(); report.duration_ms = now(); report.http_attempt_journal = { path: "http-attempts.jsonl", sha256: sha(readFileSync(journal)) };
    report.temporary_directory_removed = removeVerifiedTemporary(temporary, cleanupVerified, retentionVerified); persist();
  }
  return { output, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMixedBenchmark(parseMixedOptions(process.argv.slice(2))).then(({ output, report }) => {
    console.log(JSON.stringify({ output, status: report.status, performance_gate: false, errors: report.errors }));
    if (report.status !== "PASS") process.exitCode = 1;
  }).catch(error => { console.error(code(error)); process.exitCode = 1; });
}
