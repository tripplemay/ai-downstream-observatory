import { parseArgs } from "node:util";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dns from "node:dns";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";

function denied() { throw new Error("CSV_BACKGROUND_NETWORK_FORBIDDEN"); }
const block = (target: object, keys: string[]) => {
  for (const key of keys) if (!Reflect.set(target, key, denied)) throw new Error("CSV_BACKGROUND_SANDBOX_UNAVAILABLE");
};
block(net, ["connect", "createConnection", "createServer"]);
block(net.Socket.prototype, ["connect"]); block(net.Server.prototype, ["listen"]);
block(tls, ["connect", "createServer"]);
block(http, ["request", "get", "createServer"]); block(https, ["request", "get", "createServer"]);
block(http2, ["connect", "createServer", "createSecureServer"]);
block(dgram, ["createSocket"]);
block(dgram.Socket.prototype, ["bind", "connect", "send"]);
for (const target of [dns, dns.promises]) {
  block(target, Object.keys(target).filter(key => key === "lookup" || key === "lookupService" || key === "reverse" || key.startsWith("resolve")));
  block(target.Resolver.prototype, Object.getOwnPropertyNames(target.Resolver.prototype).filter(key => key === "reverse" || key.startsWith("resolve")));
}
block(childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
block(workerThreads, ["Worker"]);
block(globalThis, ["fetch", "WebSocket", "EventSource"]);
syncBuiltinESMExports();

try {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { "job-id": { type: "string" }, "lease-owner": { type: "string" }, "fencing-token": { type: "string" }, attempt: { type: "string" } }, strict: true, allowPositionals: false });
  const integer = (value: string | undefined) => {
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("CSV_BACKGROUND_LEASE_INVALID");
    return Number(value);
  };
  if (!values["job-id"] || !values["lease-owner"]) throw new Error("CSV_BACKGROUND_LEASE_INVALID");
  const lease = { job_id: values["job-id"], owner: values["lease-owner"], fencing_token: integer(values["fencing-token"]), attempt: integer(values.attempt) };
  // Install application-level network guards before evaluating any ledger modules.
  const { openWorkbench } = await import("../src/server/workbench-db");
  const { publishCsvBackground } = await import("../src/server/csv-background/publisher");
  const db = openWorkbench();
  try {
    publishCsvBackground(db, lease);
    process.stdout.write('{"status":"committed"}\n');
  } finally { db.close(); }
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const safe = /^(?:(?:CSV|IMPORT)_[A-Z0-9_]+|VERSION_CONFLICT|PREVIEW_HASH_MISMATCH|STALE_OR_EXPIRED_LEASE|WORKBENCH_READ_ONLY|RESTORE_PENDING_REVIEW)$/.test(message) ? message : "CSV_BACKGROUND_WORKER_FAILED";
  process.stderr.write(`${safe}\n`); process.exitCode = 1;
}
