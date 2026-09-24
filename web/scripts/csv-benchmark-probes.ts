import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";

export interface ProbeSample { kind: "read" | "write"; pid: number; sequence: number; started_ns: string; finished_ns: string; ms: number; error: string | null }
export interface ProbeWindow { stage: string; started_ns: string; finished_ns: string }
export interface ProbeOptions { root: string; filename: string; dataDir: string; portfolio: string; account: string; readPortfolio: string; intervalMs?: number; maximum?: number }

export function boundedTermination(child: ChildProcess, deadlineMs: number, graceMs = 2000) {
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    escalation = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, graceMs);
  }, deadlineMs);
  const clear = () => { clearTimeout(deadline); clearTimeout(escalation); };
  child.once("exit", clear); child.once("error", clear);
  return clear;
}

export async function startProbePair(options: ProbeOptions) {
  const interval = options.intervalMs ?? 20, maximum = options.maximum ?? 10000;
  const samples: ProbeSample[] = [], completed: Record<string, unknown>[] = [];
  const controls = (["read", "write"] as const).map(kind => {
    const child = fork(path.join(options.root, "web/scripts/csv-benchmark-probe.ts"), ["--db", options.filename, "--kind", kind,
      "--portfolio", options.portfolio, "--account", options.account, "--read-portfolio", options.readPortfolio,
      "--interval-ms", String(interval), "--max-samples", String(maximum)], {
      execArgv: ["--import", path.join(options.root, "web/node_modules/tsx/dist/loader.mjs")],
      env: { PATH: process.env.PATH, TZ: "UTC", NODE_ENV: "test", WORKBENCH_DB_PATH: options.filename, WORKBENCH_DATA_DIR: options.dataDir, WORKBENCH_MODE: "ledger" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "", count = 0, done = false, ready = false, protocolError: string | null = null;
    let resolveReady: () => void, rejectReady: (error: Error) => void;
    const readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const reject = (error: unknown) => { protocolError = error instanceof Error ? error.message : "PROBE_PROTOCOL_INVALID"; rejectReady!(new Error(protocolError)); child.kill("SIGTERM"); };
    child.stdout!.on("data", () => reject(new Error("PROBE_UNEXPECTED_STDOUT")));
    child.stderr!.on("data", value => { stderr = (stderr + value).slice(-32768); });
    child.on("message", raw => {
      try {
        const value = raw as Record<string, unknown>;
        assert.ok(value && Buffer.byteLength(JSON.stringify(value)) <= 4096);
        assert.equal(value.kind, kind); assert.equal(value.pid, child.pid);
        if (value.type === "ready") { assert.equal(ready, false); assert.equal(value.busy_timeout_ms, 5000); ready = true; resolveReady!(); }
        else if (value.type === "started") assert.ok(ready);
        else if (value.type === "sample") {
          assert.ok(ready && !done && count < maximum); assert.equal(value.sequence, ++count);
          assert.match(String(value.started_ns), /^[0-9]+$/); assert.match(String(value.finished_ns), /^[0-9]+$/);
          assert.ok(BigInt(String(value.finished_ns)) >= BigInt(String(value.started_ns)));
          assert.equal(value.ms, Number(BigInt(String(value.finished_ns)) - BigInt(String(value.started_ns))) / 1e6);
          assert.ok(value.error === null || (typeof value.error === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(value.error)));
          const { type: _type, ...sample } = value; samples.push(sample as unknown as ProbeSample);
        } else if (value.type === "done") {
          assert.equal(done, false); assert.equal(value.samples, count); assert.equal(value.sample_cap_reached, count === maximum); done = true;
          completed.push(value);
        } else throw new Error("PROBE_PROTOCOL_INVALID");
      } catch (error) { reject(error); }
    });
    const exit = new Promise<Record<string, unknown>>(resolve => {
      child.once("error", error => { reject(error); resolve({ kind, pid: child.pid, exit_code: null, protocol_error: protocolError, stderr, complete: false }); });
      child.once("exit", (code, signal) => {
        if (!ready) rejectReady!(new Error("PROBE_STARTUP_FAILED"));
        resolve({ kind, pid: child.pid, exit_code: code, signal, protocol_error: protocolError, stderr, complete: done });
      });
    });
    const timeout = setTimeout(() => reject(new Error("PROBE_READY_TIMEOUT")), 10000);
    void readiness.finally(() => clearTimeout(timeout)).catch(() => {});
    const signal = (message: string) => { if (child.connected) child.send(message, error => { if (error) reject(error); }); };
    return { child, readiness, exit, signal };
  });
  const stop = async () => {
    for (const control of controls) control.signal("stop");
    const timeout = setTimeout(() => { for (const { child } of controls) if (child.exitCode === null) child.kill("SIGKILL"); }, 7500);
    try { return { processes: await Promise.all(controls.map(value => value.exit)), completed, samples }; }
    finally { clearTimeout(timeout); }
  };
  try { await Promise.all(controls.map(value => value.readiness)); }
  catch (error) { await stop(); throw error; }
  return { start: () => { for (const control of controls) control.signal("start"); }, stop,
    wait: () => Promise.all(controls.map(value => value.exit)), snapshot: () => [...samples], pids: controls.map(value => value.child.pid!) };
}

export function classifyProbeSamples(samples: ProbeSample[], windows: ProbeWindow[]) {
  return samples.map(sample => {
    const start = BigInt(sample.started_ns), end = BigInt(sample.finished_ns);
    const owner = windows.find(window => BigInt(window.started_ns) <= start && start < BigInt(window.finished_ns));
    const overlaps = windows.filter(window => start < BigInt(window.finished_ns) && end > BigInt(window.started_ns)).map(window => window.stage);
    return { ...sample, stage: owner?.stage ?? "idle", overlap_stages: overlaps,
      fully_contained: !!owner && end <= BigInt(owner.finished_ns) };
  });
}

export function summarizeProbeSamples(samples: ProbeSample[], windows: ProbeWindow[], minimum: number) {
  const classified = classifyProbeSamples(samples, windows);
  const distribution = (kind: string, stage?: string) => {
    const selected = classified.filter(sample => sample.kind === kind && (!stage || sample.stage === stage));
    const sorted = selected.map(sample => sample.ms).sort((a, b) => a - b);
    const percentile = (value: number) => sorted.length ? sorted[Math.ceil(sorted.length * value) - 1] : null;
    return { samples: selected.length, errors: selected.filter(sample => sample.error),
      fully_contained_samples: selected.filter(sample => sample.fully_contained).length,
      cross_boundary_samples: selected.filter(sample => sample.overlap_stages.length > 0 && !sample.fully_contained).length,
      p50_ms: percentile(0.5), p95_ms: percentile(0.95), p99_ms: percentile(0.99), max_ms: sorted.at(-1) ?? null };
  };
  const stages = [...new Set([...windows.map(window => window.stage), "idle"])];
  return { sample_target: { minimum_per_kind_per_execution_phase: minimum,
    by_stage: Object.fromEntries(stages.filter(stage => stage !== "idle").map(stage => [stage,
      Object.fromEntries(["read", "write"].map(kind => [kind, { observed: distribution(kind, stage).samples,
        target_met: distribution(kind, stage).samples >= minimum }]))])),
    idle_samples_count_toward_execution_target: false },
    all: { read: distribution("read"), write: distribution("write") },
    by_stage: Object.fromEntries(stages.map(stage => [stage, { read: distribution("read", stage), write: distribution("write", stage) }])), raw: classified };
}
