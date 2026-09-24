import assert from "node:assert/strict";
import path from "node:path";
import { parseArgs } from "node:util";
import { openWorkbench } from "../src/server/workbench-db";
import { recordFact, revision } from "../src/server/ledger/service";

const { values } = parseArgs({ strict: true, allowPositionals: false, options: Object.fromEntries(
  ["db", "kind", "portfolio", "account", "read-portfolio", "interval-ms", "max-samples"].map(name => [name, { type: "string" as const }]),
) });
assert.ok(process.send && values.db && path.isAbsolute(values.db));
assert.ok(values.kind === "read" || values.kind === "write");
for (const name of ["portfolio", "account", "read-portfolio"]) assert.match(values[name] ?? "", /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const interval = Number(values["interval-ms"]), maximum = Number(values["max-samples"]);
assert.ok(Number.isSafeInteger(interval) && interval >= 1 && interval <= 1000);
assert.ok(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 10000);
const db = openWorkbench(values.db), kind = values.kind;
assert.equal(db.pragma("busy_timeout", { simple: true }), 5000, "Benchmark cannot widen the application busy timeout");
let stopped = false, started = false, closed = false;
function close() {
  if (closed) return;
  closed = true; clearTimeout(lifetime); db.close();
  if (process.connected) process.disconnect?.();
}
function stop() { stopped = true; if (!started) { started = true; void run(); } }
const send = (value: object) => new Promise<void>((resolve, reject) => {
  if (!process.connected || !process.send) return reject(new Error("PROBE_PARENT_DISCONNECTED"));
  process.send(value, error => error ? reject(error) : resolve());
});
process.once("disconnect", stop);
process.on("message", message => {
  if (message === "stop") stop();
  else if (message === "start" && !started) { started = true; void run(); }
  else { process.exitCode = 1; stop(); }
});
process.once("SIGTERM", stop);
const lifetime = setTimeout(stop, 180000);
async function run() {
  let count = 0;
  try {
    await send({ type: "started", kind, pid: process.pid });
    while (!stopped && count < maximum) {
      const start = process.hrtime.bigint(); let error: string | null = null;
      try {
        if (kind === "read") {
          db.prepare("SELECT revision FROM ledger_heads WHERE portfolio_id=?").get(values["read-portfolio"]!);
          db.prepare("SELECT value FROM market_observations WHERE series_key=? AND metric='close' AND price_basis='unadjusted' ORDER BY observed_at DESC LIMIT 1").get("listing-0");
        } else {
          const identity = `probe-${process.pid}-${count + 1}`;
          recordFact(db, { id: "owner" }, { portfolio_id: values.portfolio!, expected_revision: revision(db, values.portfolio!), idempotency_key: identity,
            source_id: "synthetic-probe", source_event_id: identity, effective_at: "2026-01-01", time_precision: "date", source_timezone: "UTC",
            reason: "Synthetic independent concurrent write probe", fact: { type: "deposit", account_id: values.account!, currency: "CNY", amount: "1" } });
        }
      } catch (value) {
        const candidate = value instanceof Error && "code" in value ? String(value.code) : value instanceof Error ? value.message : "UNKNOWN";
        error = /^[A-Z][A-Z0-9_]{0,100}$/.test(candidate) ? candidate : "PROBE_OPERATION_FAILED";
      }
      const end = process.hrtime.bigint();
      await send({ type: "sample", kind, pid: process.pid, sequence: ++count, started_ns: start.toString(), finished_ns: end.toString(), ms: Number(end - start) / 1e6, error });
      if (!stopped && count < maximum) await new Promise(resolve => setTimeout(resolve, interval));
    }
    await send({ type: "done", kind, pid: process.pid, samples: count, sample_cap_reached: count === maximum, resource_usage: process.resourceUsage() });
  } catch { process.exitCode = 1; }
  finally { close(); }
}
void send({ type: "ready", kind, pid: process.pid, busy_timeout_ms: 5000 }).catch(() => { process.exitCode = 1; close(); });
