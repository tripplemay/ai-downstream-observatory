import { parseArgs } from "node:util";
import { openWorkbench } from "../src/server/workbench-db";
import { publishMonthlyEvaluation } from "../src/server/evaluation/publisher";

try {
  const { values } = parseArgs({ options: { "job-id": { type: "string" }, "lease-owner": { type: "string" }, "fencing-token": { type: "string" }, attempt: { type: "string" } }, strict: true, allowPositionals: false });
  const integer = (value: string | undefined) => {
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("EVALUATION_LEASE_INVALID");
    return Number(value);
  };
  if (!values["job-id"] || !values["lease-owner"]) throw new Error("EVALUATION_LEASE_INVALID");
  const db = openWorkbench();
  try {
    publishMonthlyEvaluation(db, { job_id: values["job-id"], owner: values["lease-owner"], fencing_token: integer(values["fencing-token"]), attempt: integer(values.attempt) });
    process.stdout.write('{"status":"committed"}\n');
  } finally { db.close(); }
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const safe = /^(?:EVALUATION_[A-Z_]+|STALE_OR_EXPIRED_LEASE|WORKBENCH_READ_ONLY)$/.test(message) ? message : "EVALUATION_WORKER_FAILED";
  process.stderr.write(`${safe}\n`); process.exitCode = 1;
}
