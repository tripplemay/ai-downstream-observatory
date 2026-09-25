import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { createWorkbenchMixedFixture, mixedActivationRequest, mixedApprovalRequest, mixedCancelRequest, mixedLedgerRequest,
  mixedMarketRequest, mixedProposalRequest, mixedValuationRequest, type WorkbenchMixedFixture } from "./workbench-mixed-fixture";
import { MixedHttpError, startMixedRuntime, type MixedHttpResponse } from "./workbench-mixed-runtime";
import { runHttpLoad, summarizeHttpLoadSamples, type HttpLoadContext, type HttpLoadOperationResult, type HttpLoadReport } from "./workbench-http-load";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), endpoint = "/api/workbench", csvEndpoint = `${endpoint}/csv/jobs`;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const code = (error: unknown) => error instanceof MixedHttpError ? error.code : error instanceof Error ? error.message.slice(0, 1024) : "UNKNOWN_FAILURE";
export function parseMixedOptions(args: string[]) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    history: { type: "string", default: "30" }, listings: { type: "string", default: "10" }, "market-rows": { type: "string", default: "50" },
    "csv-rows": { type: "string", default: "10" }, count: { type: "string", default: "20" }, "interval-ms": { type: "string", default: "50" },
    "max-queued": { type: "string", default: "32" }, "core-count": { type: "string", default: "1" }, "poll-seconds": { type: "string", default: "5" },
    "overall-seconds": { type: "string", default: "180" }, output: { type: "string" },
  } });
  const integer = (name: keyof typeof values, low: number, high: number) => {
    const raw = values[name]; assert.ok(typeof raw === "string" && /^(0|[1-9]\d*)$/.test(raw), `INVALID_${name}`);
    const value = Number(raw); assert.ok(Number.isSafeInteger(value) && value >= low && value <= high, `INVALID_${name}`); return value;
  };
  const pollSeconds = Number(values["poll-seconds"]); assert.ok(Number.isFinite(pollSeconds) && pollSeconds >= .1 && pollSeconds <= 5, "INVALID_poll-seconds");
  return { history: integer("history", 6, 50000), listings: integer("listings", 2, 1000), marketRows: integer("market-rows", 0, 2000000),
    csvRows: integer("csv-rows", 1, 10000), count: integer("count", 1, 1000), intervalMs: integer("interval-ms", 1, 10000), maxQueued: integer("max-queued", 0, 1000),
    coreCount: integer("core-count", 1, 3), pollSeconds, overallMs: integer("overall-seconds", 30, 3600) * 1000, output: values.output };
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
  return { criterion: "Every completed background flow window has at least one actual dispatch and one measured target HTTP overlap for every class; not a SQLite lock claim.",
    windows: counts, verified: windows.length === 3 && Object.keys(load.classes).length === 4 && windows.every(window => window.completed_ms !== null) &&
      Object.values(counts).every(classes => Object.values(classes).every(value => value.dispatched_during_window > 0 && value.measured_http_overlap > 0)) };
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
export async function childJson(python: string, args: string[], environment: NodeJS.ProcessEnv, timeoutMs: number) {
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
      resolve({ exit_code: child.exitCode, signal: child.signalCode, stdout, stderr: !cleanupVerified ? "ORACLE_CLEANUP_UNCONFIRMED" : limited ? "ORACLE_OUTPUT_LIMIT" : expired ? "ORACLE_TIMEOUT" : stderr, value, cleanup_verified: cleanupVerified });
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
    attempts: [], errors: [], windows: [], source_before: {}, oracles: {},
  };
  const persist = () => writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  let fixture: WorkbenchMixedFixture | undefined, runtime: Awaited<ReturnType<typeof startMixedRuntime>> | undefined, baseline: any = null, sealed = false, oracleCleanupVerified = true, runtimeCleanupVerified = true;
  const records: { command: unknown; receipt: unknown }[] = [], approvals: { proposal_id: string; approval_id: string; cancel_id: string }[] = [], marketIds: string[] = [], valuationIds: string[] = [];
  let csv: { preview_request_id: string; confirm_request_id: string | null; rows: number; csv_sha256: string; mapping_sha256: string } | null = null;
  const abort = new AbortController(), wholeDeadline = setTimeout(() => abort.abort(), options.overallMs), pendingRequests = new Set<Promise<unknown>>();
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
        Object.assign(record, { completed_ms: response.timing.completed_ms, status: response.status, timing: response.timing,
          response: { bytes: response.bytes, parsed_json_sha256: sha(JSON.stringify(response.json)),
            id: response.json?.id ?? null, request_id: response.json?.request_id ?? null, revision: response.json?.revision ?? null, status: response.json?.status ?? null, error: response.json?.error ?? null } });
        appendFileSync(journal, JSON.stringify({ event: "response", ...record }) + "\n");
      }
      return response;
    } catch (error) {
      if (!sealed) { Object.assign(record, { completed_ms: clock(), status: error instanceof MixedHttpError ? error.status : null, error: code(error) }); appendFileSync(journal, JSON.stringify({ event: "failed", ...record }) + "\n"); }
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
    const result = await childJson(python, ["tests/performance/mixed_workload_oracle.py", "--db", filename, "--data-dir", dataDir, "--expected", inputFile],
      { PATH: process.env.PATH, NODE_ENV: "test", PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: "1", WORKBENCH_DATA_DIR: dataDir }, 60000);
    oracleCleanupVerified &&= result.cleanup_verified;
    report.oracles[phase] = result; writeFileSync(path.join(evidence, `oracle-${phase}.json`), JSON.stringify(result, null, 2) + "\n", { flag: "wx" }); persist();
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
    persist(); report.source_before = sourceSnapshot(); fixture = createWorkbenchMixedFixture({ filename, dataDir, history: options.history, listings: options.listings, marketRows: options.marketRows });
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
        if (kind === "ledger-get") { const value = await measure(() => get(kind, `${endpoint}?portfolio=${fixture!.ids.csv.portfolio_id}`, context)); assert.equal(value.selected, fixture!.ids.csv.portfolio_id); }
        else if (kind === "governance-get") await measure(() => get(kind, `${endpoint}?portfolio=${fixture!.ids.approval.portfolio_id}&view=governance`, context));
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
    load = runHttpLoad({ overallTimeoutMs: Math.max(1, options.overallMs - now()), drainTimeoutMs: 35000, signal: abort.signal,
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
        const form = new FormData();
        for (const [key, value] of Object.entries({ portfolio_id: fixture!.ids.csv.portfolio_id, account_id: fixture!.ids.csv.account_ids[0], expected_revision: String(fixture!.revisions.csv), mapping: input.mapping })) form.set(key, value);
        form.set("file", new Blob([new Uint8Array(input.bytes)], { type: "text/csv" }), "upload.csv");
        const response = accepted(await attempt("csv:preview", csvEndpoint, { method: "POST", headers: { "X-CSV-Idempotency-Key": "mixed-csv-preview",
          "X-CSV-Background-Acknowledged": "true", "X-CSV-Original-Filename": Buffer.from(input.filename).toString("base64url") }, body: form }, report.csv_input));
        csv = { preview_request_id: response.request_id, confirm_request_id: null, rows: options.csvRows, csv_sha256: sha(input.bytes), mapping_sha256: sha(input.mapping) };
        preview = await csvResult(response.request_id, "csv:preview");
        assert.equal(preview.error_count, 0); assert.equal(preview.row_count, options.csvRows); assert.equal(preview.required_review_count, 0);
        await oracle("preview");
      });
      await window("csv_confirm_flow", async () => {
        const payload = { action: "confirm_import", portfolio_id: fixture!.ids.csv.portfolio_id, batch_id: preview.batch_id, preview_hash: preview.preview_hash,
          expected_revision: fixture!.revisions.csv, csv_review: { acknowledge_unverified_mapping: true, review_hash: preview.review_hash, rows: [] } };
        const response = accepted(await post("csv:confirm", { action: "confirm", command: { portfolio_id: fixture!.ids.csv.portfolio_id, account_id: fixture!.ids.csv.account_ids[0],
          idempotency_key: "mixed-csv-confirm", payload_text: JSON.stringify(payload), acknowledge_background_execution: true } }, undefined, csvEndpoint));
        csv!.confirm_request_id = response.request_id; const confirmed = await csvResult(response.request_id, "csv:confirm");
        assert.equal(confirmed.confirmed_revision, fixture!.revisions.csv + options.csvRows);
      });
    })(), window("market_valuation_update_flow", async () => {
      await task("update:valuation-price", mixedMarketRequest(fixture!, "valuation", 1, 1), "market");
      await task("update:fx", mixedMarketRequest(fixture!, "fx", 1, 1), "market");
      await task("update:valuation", mixedValuationRequest(fixture!, "valuation", 1), "valuation");
    })]);
    for (const [index, result] of flows.entries()) if (result.status === "rejected") report.errors.push({ stage: index === 0 ? "csv_flow" : "market_valuation_flow", message: code(result.reason) });
    report.load = await load;
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
    if (pendingRequests.size) { let timer: NodeJS.Timeout | undefined; await Promise.race([Promise.allSettled([...pendingRequests]), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); if (timer) clearTimeout(timer); }
    sealed = true; report.unsettled_http_at_return = pendingRequests.size;
    const stopped = runtimeCleanupVerified && oracleCleanupVerified && (!runtime || report.processes.every((process: any) => process.exit_code !== null || process.signal !== null));
    report.owned_processes_stopped = stopped;
    report.uncertain_writers = !stopped;
    if (fixture && baseline && stopped) { try { await oracle("complete"); } catch (error) { report.errors.push({ stage: "final_oracle", message: code(error) }); } }
    else if (!stopped) report.errors.push({ stage: "final_oracle", message: "NOT_RUN_PROCESSES_NOT_STOPPED" });
    const cleanupVerified = stopped && oracleCleanupVerified;
    report.owned_processes_stopped = cleanupVerified; report.uncertain_writers = !cleanupVerified;
    let retentionVerified = !fixture;
    if (fixture && cleanupVerified) {
      try {
        const db = new Database(filename, { readonly: true }); try { await db.backup(path.join(evidence, "final-workbench.db")); } finally { db.close(); }
        if (existsSync(path.join(dataDir, "attachments"))) cpSync(path.join(dataDir, "attachments"), path.join(evidence, "attachments"), { recursive: true, errorOnExist: true, force: false });
        report.retained_database = { path: "final-workbench.db", sha256: sha(readFileSync(path.join(evidence, "final-workbench.db"))), attachments: "attachments", auth_database_retained: false };
        retentionVerified = true;
      } catch (error) { report.errors.push({ stage: "retention", message: code(error) }); }
    }
    report.retention_verified = retentionVerified;
    try { report.source_after = sourceSnapshot(); report.source_drift = [...new Set([...Object.keys(report.source_before), ...Object.keys(report.source_after)])].filter(file => report.source_before[file] !== report.source_after[file]); }
    catch (error) { report.errors.push({ stage: "source_snapshot", message: code(error) }); report.source_drift = null; }
    const classes = report.load?.classes as HttpLoadReport["classes"] | undefined;
    const complete = classes && Object.keys(classes).length === 4 && Object.values(classes).every(value => value.succeeded === options.count && value.failed === 0 && value.unsettled_at_return === 0);
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
