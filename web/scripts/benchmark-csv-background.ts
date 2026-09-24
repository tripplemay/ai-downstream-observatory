import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { sourceFiles } from "../../scripts/verification-source.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { canonical, createAccount, createPortfolio, hash, recordFact, revision } from "../src/server/ledger/service";
import { readCsvManifest } from "../src/server/ledger/csv-import-evidence";
import { readConfirmedCsvImport } from "../src/server/ledger/csv-confirmation";
import { requestCsvBackgroundConfirmation, requestCsvBackgroundPreview } from "../src/server/csv-background/service";
import type { CsvMapping } from "../src/server/ledger/csv-mapping";
import { boundedTermination, startProbePair, summarizeProbeSamples, type ProbeSample, type ProbeWindow } from "./csv-benchmark-probes";

async function main() {
const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
  rows: { type: "string", default: "10000" }, "historical-facts": { type: "string", default: "50000" },
  "market-rows": { type: "string", default: "2000000" }, "probe-samples": { type: "string", default: "1000" },
  "idle-probe-samples": { type: "string", default: "0" },
  output: { type: "string" },
} });
function integer(value: string | undefined, maximum: number): number {
  assert.match(value ?? "", /^(0|[1-9]\d*)$/); const result = Number(value);
  assert.ok(Number.isSafeInteger(result) && result <= maximum); return result;
}
const count = integer(values.rows, 10000), history = integer(values["historical-facts"], 50000);
const marketRows = integer(values["market-rows"], 2000000), samples = integer(values["probe-samples"], 1000);
const idleSamples = integer(values["idle-probe-samples"], 1000);
assert.ok(count > 0);
const root = path.resolve(__dirname, "../.."), output = path.resolve(values.output ?? path.join(root, "artifacts/verification/csv-background-v23", `benchmark-${Date.now()}.json`));
assert.ok(output.startsWith(path.join(root, "artifacts/verification/") ) && output.endsWith(".json"));
assert.equal(existsSync(output), false, "Refuse to overwrite retained evidence");
const python = process.env.WORKBENCH_TEST_PYTHON ?? "python3";
const measurementSources = () => Object.fromEntries([
  "web/scripts/benchmark-csv-background.ts", "web/scripts/csv-background.ts", "web/scripts/build-csv-background.mjs",
  "web/scripts/csv-benchmark-probe.ts", "web/scripts/csv-benchmark-probes.ts",
].map(file => [file, createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex")]));
const directory = mkdtempSync(path.join(os.tmpdir(), "csv-background-benchmark-"));
const filename = path.join(directory, "workbench.db"), start = performance.now();
const report: Record<string, unknown> = {
  schema_version: "csv-background-benchmark-v2", status: "RUNNING", started_at: new Date().toISOString(),
  environment: { platform: process.platform, architecture: process.arch, node: process.version, cpus: os.cpus().length, memory_bytes: os.totalmem(), parent_pid: process.pid },
  requested: { rows: count, historical_facts: history, market_rows: marketRows, probe_minimum_per_kind_per_execution_phase: samples, explicit_idle_samples_per_kind: idleSamples },
  source_sha256: sourceFiles(root),
  measurement_source_sha256: measurementSources(),
  boundaries: ["Synthetic isolated database; no broker credentials, live providers, HTTP authentication, browser or production.",
    "Market rows are explicitly reconstructed fixture observations, not accepted investment prices.",
    "This exercises actual Python dispatch and fixed Node preview/confirmation, not only parser mapping.",
    "Fixed Node bundle fingerprints are retained independently; source fingerprints alone do not prove that the bundle includes current source changes.",
    "Concurrent probes cover ledger/market reads and unrelated-portfolio small facts; not valuation, approvals or a complete production load mix.",
    "Read and normal recordFact write probes run in independent processes with unchanged 5000ms busy_timeout; parent does no concurrent probe SQL.",
    "Closed-loop probes wait 20ms after each operation; this is not a fixed-arrival load test and slow writes reduce the observed sample count.",
    "Requested sample count is a target, never padded with idle probes; explicit idle baseline and boundary-crossing samples remain separate.",
    "Phase attribution uses operation start monotonic time, with overlap and containment recorded; worker wall time does not measure SQLite writer lock duration.",
    "Completed measurement is not a performance pass; inspect phase errors, latency, sample shortfall, and source changes independently.",
    "Each import operation runs once; cold/warm repeated import distribution remains unverified."],
};
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const bundle = path.join(root, "web/dist/csv-background.mjs");
report.bundle_sha256_at_start = digest(bundle);
const persist = () => { mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); };
let db: ReturnType<typeof openWorkbench> | undefined;
let active: ReturnType<typeof spawn> | undefined;
const probes: ProbeSample[] = [], windows: ProbeWindow[] = [], probeProcesses: Record<string, unknown>[] = [];
const updateProbes = () => { report.probes = { ...summarizeProbeSamples(probes, windows, samples), windows, processes: probeProcesses,
  configuration: { process_per_kind: true, busy_timeout_ms: 5000, interval_after_operation_ms: 20, maximum_samples_per_process: 10000, maximum_lifetime_ms: 180000 } }; };
report.writer_transaction_timing = { status: "NOT_MEASURED", reason: "No publisher transaction-boundary instrumentation; worker and probe timings cannot establish lock acquisition or hold time." };
try {
  migrateWorkbench(filename); db = openWorkbench(filename);
  const actor = { id: "owner" }, principal = { actorId: actor.id, sessionHash: "a".repeat(64) };
  const portfolio = createPortfolio(db, actor, "Synthetic CSV benchmark"), concurrent = createPortfolio(db, actor, "Synthetic concurrent probes");
  const accounts = Array.from({ length: 9 }, (_, index) => createAccount(db!, actor, portfolio, `Account ${index + 1}`, "Synthetic", "CNY"));
  const probeAccount = createAccount(db, actor, concurrent, "Probe account", "Synthetic", "CNY"), account = accounts[0];
  const now = new Date().toISOString(), seedStarted = performance.now();
  db.transaction(() => {
    const instrument = db!.prepare("INSERT INTO instruments(id,name,created_at) VALUES(?,?,?)");
    const listing = db!.prepare("INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at) VALUES(?,?,'CN','SYNTHETIC',?,'CNY',?)");
    for (let i = 0; i < 1000; i++) { instrument.run(`synthetic-${i}`, `Synthetic ${i}`, now); listing.run(`listing-${i}`, `synthetic-${i}`, String(i).padStart(6, "0"), now); }
    if (marketRows) {
      db!.prepare("INSERT INTO market_batches(id,source_id,batch_type,scope,status,started_at) VALUES('synthetic-market','fixture','prices','synthetic','staging',?)").run(now);
      const observation = db!.prepare(`INSERT INTO market_observations(id,batch_id,source_id,listing_id,series_key,metric,value,unit,observed_at,ingested_at,price_basis,revision_id,raw_hash,parser_version,provenance)
        VALUES(?,'synthetic-market','fixture',?,?,'close','1','CNY',?,?,'unadjusted','fixture',?,'fixture','reconstructed')`);
      const rawHash = hash({ synthetic: true });
      for (let i = 0; i < marketRows; i++) {
        const listingId = `listing-${i % 1000}`, day = new Date(Date.UTC(2015, 0, 1) + Math.floor(i / 1000) * 86400000).toISOString();
        observation.run(`observation-${i}`, listingId, listingId, day, now, rawHash);
      }
    }
    for (let i = 0; i < history; i++) recordFact(db!, actor, {
      portfolio_id: portfolio, expected_revision: i, idempotency_key: `seed-${i}`, source_id: "synthetic-seed", source_event_id: `seed-${i}`,
      effective_at: "2025-01-01", time_precision: "date", source_timezone: "UTC", reason: "Synthetic benchmark history",
      fact: { type: "deposit", account_id: accounts[i % accounts.length], currency: "CNY", amount: String(i + 1) },
    }, now);
  }).immediate();
  report.seed_ms = performance.now() - seedStarted;
  report.actual_baseline = Object.fromEntries(["accounts", "listings", "market_observations", "ledger_events", "postings"].map(table => [table, (db!.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n]));
  assert.equal(revision(db, portfolio), history);
  const mapping: CsvMapping = {
    schema_version: "csv-import-mapping-v1", mapping_id: "SYNTHETIC-BENCHMARK", version: 1, title: "Synthetic benchmark, not broker verified",
    dialect: { encoding: "utf-8", delimiter: ",", record_separator: "either" }, expected_headers: ["date", "amount", "id", "note"], ignored_columns: [],
    account: { kind: "constant", value: account }, event_type: { kind: "constant", value: "deposit" }, source_id: "synthetic-import",
    source_event_id: { kind: "column", column: "id", trim: false, empty: "reject" }, reason: { kind: "column", column: "note", trim: false, empty: "reject" },
    effective_at: { column: "date", format: "YYYY-MM-DD", trim: false, source_timezone: "UTC" },
    rules: [{ event_type: "deposit", fields: { currency: { kind: "constant", value: "CNY" },
      amount: { kind: "decimal", column: "amount", empty: "reject", format: { decimal_separator: ".", grouping_separator: "none", negative_style: "minus", allow_leading_plus: false, trim: false } } } }],
  };
  const bytes = Buffer.from("date,amount,id,note\n" + Array.from({ length: count }, (_, i) => `2026-01-01,${100000 + i},import-${i},Synthetic row`).join("\n") + "\n");
  report.input_bytes = bytes.length;
  report.input_sha256 = createHash("sha256").update(bytes).digest("hex");
  const probeOptions = { root, filename, dataDir: directory, portfolio: concurrent, account: probeAccount, readPortfolio: portfolio };
  async function collectProbes(pair: Awaited<ReturnType<typeof startProbePair>>, phase: string) {
    const result = await pair.stop(); probes.push(...result.samples);
    probeProcesses.push({ phase, processes: result.processes, completed: result.completed }); updateProbes(); persist();
    for (const process of result.processes) assert.ok(process.exit_code === 0 && process.complete && !process.protocol_error, "Independent probe process failed");
  }
  async function worker(label: string, requestId: string) {
    const pair = samples ? await startProbePair(probeOptions) : undefined;
    const started = performance.now(), startedNs = process.hrtime.bigint(); let stdout = "", stderr = "";
    const child = spawn(python, ["-m", "worker.orchestration", "--db", filename, "--once", "--role", "core"], {
      cwd: root, env: { NODE_ENV: "test", PATH: process.env.PATH, WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: directory, PYTHONUNBUFFERED: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    active = child;
    pair?.start();
    child.stdout.on("data", value => { stdout = (stdout + value).slice(-32768); });
    child.stderr.on("data", value => { stderr = (stderr + value).slice(-32768); });
    const exit = new Promise<{ code: number | null; error?: Error }>(resolve => {
      let finished = false;
      const finish = (result: { code: number | null; error?: Error }) => {
        if (finished) return; finished = true;
        windows.push({ stage: label, started_ns: startedNs.toString(), finished_ns: process.hrtime.bigint().toString() }); resolve(result);
      };
      child.once("error", error => finish({ code: null, error }));
      child.once("exit", code => finish({ code }));
    });
    const clearDeadline = boundedTermination(child, 160000);
    try {
      const { code, error } = await exit;
      const duration = performance.now() - started;
      if (pair) await collectProbes(pair, label);
      report[label] = { duration_ms: duration, exit_code: code, stdout, stderr,
        jobs: db!.prepare("SELECT status,attempt_count,result_json FROM job_runs WHERE command_request_id=?").all(requestId) };
      persist(); if (error) throw error; assert.equal(code, 0, `${label} worker failed`);
      const stored = db!.prepare("SELECT result_json,result_hash FROM csv_background_results WHERE request_id=?").get(requestId) as { result_json: string; result_hash: string } | undefined;
      assert.ok(stored); assert.equal(hash(JSON.parse(stored.result_json)), stored.result_hash);
      return JSON.parse(stored.result_json);
    } finally { clearDeadline(); if (pair) await pair.stop(); active = undefined; }
  }
  persist();
  const beforePreview = performance.now();
  const previewRequest = requestCsvBackgroundPreview(db, principal, { portfolio_id: portfolio, account_id: account, expected_revision: history,
    idempotency_key: "benchmark-preview", filename: "synthetic.csv", mapping: canonical(mapping), bytes, acknowledge_background_execution: true }, { dataDir: directory });
  report.preview_submission_ms = performance.now() - beforePreview;
  const preview = await worker("preview_execution", previewRequest.request_id);
  assert.equal(preview.row_count, count); assert.equal(preview.error_count, 0); assert.equal(revision(db, portfolio), history);
  const manifest = readCsvManifest(db, preview.batch_id);
  assert.deepEqual(manifest.required_review_rows, []);
  const payload = JSON.stringify({ action: "confirm_import", portfolio_id: portfolio, batch_id: preview.batch_id, preview_hash: preview.preview_hash, expected_revision: history,
    csv_review: { acknowledge_unverified_mapping: true, review_hash: manifest.review_hash, rows: [] } });
  const beforeConfirm = performance.now();
  const confirmRequest = requestCsvBackgroundConfirmation(db, principal, { portfolio_id: portfolio, account_id: account, idempotency_key: "benchmark-confirm",
    payload_text: payload, acknowledge_background_execution: true }, { dataDir: directory });
  report.confirm_submission_ms = performance.now() - beforeConfirm;
  const confirmed = await worker("confirmation_execution", confirmRequest.request_id);
  assert.equal(confirmed.confirmed_revision, history + count); assert.equal(revision(db, portfolio), history + count);
  const proof = readConfirmedCsvImport(db, actor, portfolio, preview.batch_id, { dataDir: directory });
  assert.equal(proof.receipts.length, count); assert.equal(hash(proof.receipts), confirmed.receipts_hash);
  assert.equal(new Set(proof.receipts.map(receipt => receipt.event_id)).size, count);
  report.independent_actual_receipts = count;
  if (idleSamples) {
    const pair = await startProbePair({ ...probeOptions, maximum: idleSamples });
    pair.start(); await pair.wait(); await collectProbes(pair, "explicit_idle_baseline");
  }
  updateProbes();
  const writes = probes.filter(item => item.kind === "write" && !item.error).length;
  assert.equal(revision(db, concurrent), writes);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM ledger_events WHERE portfolio_id=?").get(portfolio) as { n: number }).n, history + count);
  const total = (db.prepare("SELECT p.balance FROM account_projections p JOIN accounts a ON a.id=p.account_id WHERE a.portfolio_id=? AND p.ledger_account='cash_settled' AND p.currency='CNY'").all(portfolio) as { balance: string }[])
    .reduce((sum, row) => sum + BigInt(row.balance), 0n);
  const expected = BigInt(history) * BigInt(history + 1) / 2n + BigInt(count) * 100000n + BigInt(count) * BigInt(count - 1) / 2n;
  assert.equal(total, expected);
  report.correctness = { unique_import_receipts: count, committed_probe_facts: writes, exact_cash_balance: total.toString(), expected_cash_balance: expected.toString() };
  report.database_bytes_before_checkpoint = statSync(filename).size;
  report.bundle_sha256 = digest(bundle);
  report.status = "COMPLETED_SCOPED_MEASUREMENT";
} catch (error) {
  report.status = "FAILED"; report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  if (active && active.exitCode === null) { active.kill("SIGTERM"); await new Promise<void>(resolve => { active!.once("exit", () => resolve()); setTimeout(() => { active?.kill("SIGKILL"); }, 2000).unref(); }); }
  db?.close(); rmSync(directory, { recursive: true, force: true });
  report.duration_ms = performance.now() - start; report.fixture_removed = true; report.finished_at = new Date().toISOString();
  report.process_resource_usage = process.resourceUsage(); persist();
  updateProbes();
  const before = report.source_sha256 as Record<string, string>, after = sourceFiles(root) as Record<string, string>;
  report.source_changed_during_run = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]);
  const measurementBefore = report.measurement_source_sha256 as Record<string, string>, measurementAfter = measurementSources();
  report.measurement_source_changed_during_run = Object.keys(measurementBefore).filter(file => measurementBefore[file] !== measurementAfter[file]);
  report.bundle_changed_during_run = report.bundle_sha256_at_start !== digest(bundle);
  persist();
  process.stdout.write(JSON.stringify({ status: report.status, output, sha256: digest(output) }) + "\n");
}
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
