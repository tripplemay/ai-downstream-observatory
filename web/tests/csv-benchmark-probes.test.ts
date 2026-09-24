import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateWorkbench } from "../../scripts/migrate-workbench.mjs";
import { openWorkbench } from "../src/server/workbench-db";
import { createAccount, createPortfolio, revision } from "../src/server/ledger/service";
import { boundedTermination, classifyProbeSamples, startProbePair, summarizeProbeSamples, type ProbeSample } from "../scripts/csv-benchmark-probes";

const sample = (kind: "read" | "write", start: number, end: number): ProbeSample => ({ kind, pid: 123, sequence: 1,
  started_ns: String(start), finished_ns: String(end), ms: (end - start) / 1e6, error: null });

test("probe attribution keeps blocked writes in their starting phase and never uses idle to pad targets", () => {
  const windows = [{ stage: "preview_execution", started_ns: "100", finished_ns: "200" },
    { stage: "confirmation_execution", started_ns: "300", finished_ns: "400" }];
  const samples = [sample("write", 150, 250), sample("read", 110, 120), sample("read", 250, 320),
    ...Array.from({ length: 20 }, () => sample("write", 500, 510))];
  const classified = classifyProbeSamples(samples, windows);
  assert.equal(classified[0].stage, "preview_execution"); assert.equal(classified[0].fully_contained, false);
  assert.deepEqual(classified[0].overlap_stages, ["preview_execution"]);
  assert.equal(classified[2].stage, "idle"); assert.deepEqual(classified[2].overlap_stages, ["confirmation_execution"]);
  const report = summarizeProbeSamples(samples, windows, 10);
  assert.deepEqual(report.sample_target.by_stage.preview_execution.write, { observed: 1, target_met: false });
  assert.deepEqual(report.sample_target.by_stage.confirmation_execution.write, { observed: 0, target_met: false });
  assert.equal(report.sample_target.idle_samples_count_toward_execution_target, false);
  assert.equal(report.by_stage.idle.write.samples, 20); assert.equal(report.by_stage.preview_execution.write.cross_boundary_samples, 1);
});

function fixture() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "csv-benchmark-probes-test-")), filename = path.join(dataDir, "workbench.db");
  migrateWorkbench(filename); const db = openWorkbench(filename), actor = { id: "owner" };
  const readPortfolio = createPortfolio(db, actor, "Synthetic import portfolio"), portfolio = createPortfolio(db, actor, "Synthetic probe portfolio");
  const account = createAccount(db, actor, portfolio, "Probe", "Synthetic", "CNY");
  return { db, portfolio, options: { root: path.resolve(__dirname, "../.."), filename, dataDir, portfolio, account, readPortfolio },
    close() { db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

async function waitUntil(condition: () => boolean) {
  const until = performance.now() + 10000;
  while (!condition()) { assert.ok(performance.now() < until, "Probe condition timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("independent read process and parent progress while normal write hits the unchanged SQLite busy timeout", { timeout: 20000 }, async () => {
  const f = fixture(); let pair: Awaited<ReturnType<typeof startProbePair>> | undefined;
  let ticks = 0; const timer = setInterval(() => ticks++, 10);
  try {
    pair = await startProbePair({ ...f.options, maximum: 2 });
    assert.equal(new Set(pair.pids).size, 2); assert.ok(pair.pids.every(pid => pid !== process.pid));
    f.db.exec("BEGIN IMMEDIATE"); pair.start();
    await waitUntil(() => pair!.snapshot().filter(value => value.kind === "read").length === 2);
    assert.equal(pair.snapshot().filter(value => value.kind === "write").length, 0, "Read process must not wait behind the blocked write process");
    await waitUntil(() => pair!.snapshot().some(value => value.kind === "write"));
    const blocked = pair.snapshot().find(value => value.kind === "write")!;
    assert.equal(blocked.error, "SQLITE_BUSY"); assert.ok(blocked.ms >= 4900);
    assert.ok(ticks >= 5, "Parent timers must progress while the writer blocks");
    f.db.exec("ROLLBACK"); await pair.wait();
    const result = await pair.stop();
    assert.ok(result.processes.every(value => value.complete && value.exit_code === 0 && !value.protocol_error));
    const writes = result.samples.filter(value => value.kind === "write" && !value.error);
    assert.equal(writes.length, 1); assert.equal(revision(f.db, f.portfolio), writes.length);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM ledger_events WHERE portfolio_id=?").get(f.portfolio) as { n: number }).n, writes.length);
  } finally { clearInterval(timer); if (f.db.inTransaction) f.db.exec("ROLLBACK"); await pair?.stop(); f.close(); }
});

test("ready probes stop cleanly without starting workload or creating ledger facts", { timeout: 15000 }, async () => {
  const f = fixture(); let pair: Awaited<ReturnType<typeof startProbePair>> | undefined;
  try {
    pair = await startProbePair(f.options); const result = await pair.stop();
    assert.deepEqual(result.samples, []); assert.equal(revision(f.db, f.portfolio), 0);
    assert.ok(result.processes.every(value => value.complete && value.exit_code === 0 && !value.protocol_error));
  } finally { await pair?.stop(); f.close(); }
});

test("worker deadline escalates when a child ignores SIGTERM", { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready')"], { stdio: ["ignore", "pipe", "ignore"] });
  let clear: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    const exit = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    clear = boundedTermination(child, 50, 50);
    assert.deepEqual(await exit, { code: null, signal: "SIGKILL" });
  } finally { clear?.(); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});
