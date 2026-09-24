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

async function main() {
const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
  rows: { type: "string", default: "10000" }, "historical-facts": { type: "string", default: "50000" },
  "market-rows": { type: "string", default: "2000000" }, "probe-samples": { type: "string", default: "1000" },
  output: { type: "string" },
} });
function integer(value: string | undefined, maximum: number): number {
  assert.match(value ?? "", /^(0|[1-9]\d*)$/); const result = Number(value);
  assert.ok(Number.isSafeInteger(result) && result <= maximum); return result;
}
const count = integer(values.rows, 10000), history = integer(values["historical-facts"], 50000);
const marketRows = integer(values["market-rows"], 2000000), samples = integer(values["probe-samples"], 1000);
assert.ok(count > 0);
const root = path.resolve(__dirname, "../.."), output = path.resolve(values.output ?? path.join(root, "artifacts/verification/csv-background-v23", `benchmark-${Date.now()}.json`));
assert.ok(output.startsWith(path.join(root, "artifacts/verification/") ) && output.endsWith(".json"));
assert.equal(existsSync(output), false, "Refuse to overwrite retained evidence");
const python = process.env.WORKBENCH_TEST_PYTHON ?? "python3";
const measurementSources = () => Object.fromEntries([
  "web/scripts/benchmark-csv-background.ts", "web/scripts/csv-background.ts", "web/scripts/build-csv-background.mjs",
].map(file => [file, createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex")]));
const directory = mkdtempSync(path.join(os.tmpdir(), "csv-background-benchmark-"));
const filename = path.join(directory, "workbench.db"), start = performance.now();
const report: Record<string, unknown> = {
  schema_version: "csv-background-benchmark-v1", status: "RUNNING", started_at: new Date().toISOString(),
  environment: { platform: process.platform, architecture: process.arch, node: process.version, cpus: os.cpus().length, memory_bytes: os.totalmem() },
  requested: { rows: count, historical_facts: history, market_rows: marketRows, probe_samples: samples },
  source_sha256: sourceFiles(root),
  measurement_source_sha256: measurementSources(),
  boundaries: ["Synthetic isolated database; no broker credentials, live providers, HTTP authentication, browser or production.",
    "Market rows are explicitly reconstructed fixture observations, not accepted investment prices.",
    "This exercises actual Python dispatch and fixed Node preview/confirmation, not only parser mapping.",
    "Concurrent probes cover ledger/market reads and unrelated-portfolio small facts; not valuation, approvals or a complete production load mix.",
    "Post-import probes only fill the requested sample floor; their idle distribution is separate and cannot certify concurrent latency.",
    "Each import operation runs once; cold/warm repeated import distribution remains unverified."],
};
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const persist = () => { mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); };
let db: ReturnType<typeof openWorkbench> | undefined;
let active: ReturnType<typeof spawn> | undefined;
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
  const probes: { kind: string; stage: string; ms: number; error: string | null }[] = [];
  let stage = "idle";
  let probeSerial = 0;
  function probe() {
    for (const kind of ["read", "write"]) {
      const started = performance.now(); let error: string | null = null;
      try {
        if (kind === "read") {
          db!.prepare("SELECT revision FROM ledger_heads WHERE portfolio_id=?").get(portfolio);
          db!.prepare("SELECT value FROM market_observations WHERE series_key=? AND metric='close' AND price_basis='unadjusted' ORDER BY observed_at DESC LIMIT 1").get("listing-0");
        } else recordFact(db!, actor, { portfolio_id: concurrent, expected_revision: revision(db!, concurrent), idempotency_key: `probe-${++probeSerial}`,
          source_id: "synthetic-probe", source_event_id: String(probeSerial), effective_at: "2026-01-01", time_precision: "date", source_timezone: "UTC",
          reason: "Synthetic concurrent write probe", fact: { type: "deposit", account_id: probeAccount, currency: "CNY", amount: "1" } });
      } catch (value) { error = value instanceof Error ? value.message : "UNKNOWN"; }
      probes.push({ kind, stage, ms: performance.now() - started, error });
    }
  }
  async function worker(label: string, requestId: string) {
    stage = label;
    const started = performance.now(); let stdout = "", stderr = "", exited = false;
    const child = spawn(python, ["-m", "worker.orchestration", "--db", filename, "--once", "--role", "core"], {
      cwd: root, env: { NODE_ENV: "test", PATH: process.env.PATH, WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: directory, PYTHONUNBUFFERED: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    active = child;
    child.stdout.on("data", value => { stdout = (stdout + value).slice(-32768); });
    child.stderr.on("data", value => { stderr = (stderr + value).slice(-32768); });
    const exit = new Promise<{ code: number | null; error?: Error }>(resolve => {
      child.once("error", error => { exited = true; resolve({ code: null, error }); });
      child.once("exit", code => { exited = true; resolve({ code }); });
    });
    const deadline = setTimeout(() => child.kill("SIGTERM"), 160000);
    try {
      while (!exited) { if (samples) probe(); await new Promise(resolve => setTimeout(resolve, 20)); }
      const { code, error } = await exit;
      report[label] = { duration_ms: performance.now() - started, exit_code: code, stdout, stderr,
        jobs: db!.prepare("SELECT status,attempt_count,result_json FROM job_runs WHERE command_request_id=?").all(requestId) };
      persist(); if (error) throw error; assert.equal(code, 0, `${label} worker failed`);
      const stored = db!.prepare("SELECT result_json,result_hash FROM csv_background_results WHERE request_id=?").get(requestId) as { result_json: string; result_hash: string } | undefined;
      assert.ok(stored); assert.equal(hash(JSON.parse(stored.result_json)), stored.result_hash);
      return JSON.parse(stored.result_json);
    } finally { clearTimeout(deadline); active = undefined; stage = "idle"; }
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
  while (probes.filter(item => item.kind === "read").length < samples) { probe(); await new Promise(resolve => setTimeout(resolve, 1)); }
  const distribution = (kind: string, selectedStage?: string) => {
    const data = probes.filter(item => item.kind === kind && (!selectedStage || item.stage === selectedStage)), sorted = data.map(item => item.ms).sort((a, b) => a - b);
    const percentile = (quantile: number) => sorted.length ? sorted[Math.ceil(sorted.length * quantile) - 1] : null;
    return { samples: data.length, errors: data.filter(item => item.error), p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99), max_ms: sorted.at(-1) ?? null };
  };
  report.probes = { all: { read: distribution("read"), write: distribution("write") },
    by_stage: Object.fromEntries(["preview_execution", "confirmation_execution", "idle"].map(stage => [stage, { read: distribution("read", stage), write: distribution("write", stage) }])), raw: probes };
  const writes = probes.filter(item => item.kind === "write" && !item.error).length;
  assert.equal(revision(db, concurrent), writes);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM ledger_events WHERE portfolio_id=?").get(portfolio) as { n: number }).n, history + count);
  const total = (db.prepare("SELECT p.balance FROM account_projections p JOIN accounts a ON a.id=p.account_id WHERE a.portfolio_id=? AND p.ledger_account='cash_settled' AND p.currency='CNY'").all(portfolio) as { balance: string }[])
    .reduce((sum, row) => sum + BigInt(row.balance), 0n);
  const expected = BigInt(history) * BigInt(history + 1) / 2n + BigInt(count) * 100000n + BigInt(count) * BigInt(count - 1) / 2n;
  assert.equal(total, expected);
  report.correctness = { unique_import_receipts: count, committed_probe_facts: writes, exact_cash_balance: total.toString(), expected_cash_balance: expected.toString() };
  report.database_bytes_before_checkpoint = statSync(filename).size;
  report.bundle_sha256 = digest(path.join(root, "web/dist/csv-background.mjs"));
  report.status = "COMPLETED_SCOPED_MEASUREMENT";
} catch (error) {
  report.status = "FAILED"; report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  if (active && active.exitCode === null) { active.kill("SIGTERM"); await new Promise<void>(resolve => { active!.once("exit", () => resolve()); setTimeout(() => { active?.kill("SIGKILL"); }, 2000).unref(); }); }
  db?.close(); rmSync(directory, { recursive: true, force: true });
  report.duration_ms = performance.now() - start; report.fixture_removed = true; report.finished_at = new Date().toISOString();
  report.process_resource_usage = process.resourceUsage(); persist();
  const before = report.source_sha256 as Record<string, string>, after = sourceFiles(root) as Record<string, string>;
  report.source_changed_during_run = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]);
  const measurementBefore = report.measurement_source_sha256 as Record<string, string>, measurementAfter = measurementSources();
  report.measurement_source_changed_during_run = Object.keys(measurementBefore).filter(file => measurementBefore[file] !== measurementAfter[file]);
  persist();
  process.stdout.write(JSON.stringify({ status: report.status, output, sha256: digest(output) }) + "\n");
}
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
