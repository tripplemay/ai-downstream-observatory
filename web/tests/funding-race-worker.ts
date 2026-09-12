import { openWorkbench } from "../src/server/workbench-db";
import { linkFundingReceipt } from "../src/server/funding/service";

const [, , filename, start, raw] = process.argv;
const db = openWorkbench(filename);
while (Date.now() < Number(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
try {
  linkFundingReceipt(db, { id: "SYNTHETIC-RACE", kind: "human" }, JSON.parse(raw), { now: "2026-06-01T12:00:00.000Z" });
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "UNKNOWN" }));
} finally { db.close(); }
