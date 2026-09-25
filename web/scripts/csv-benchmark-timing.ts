import type { CsvTransactionTiming } from "../src/server/csv-background/types";

const prefix = "CSV_TRANSACTION_TIMING ";
const keys = ["schema_version", "outcome", "transaction_call_us", "begin_to_callback_us", "callback_us", "finalize_tail_us"].sort();
const duration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function readTransactionTiming(stderr: string, requested: boolean): { status: "NOT_REQUESTED" | "MISSING" | "INVALID" | "OBSERVED"; timing?: CsvTransactionTiming } {
  if (!requested) return { status: "NOT_REQUESTED" };
  const lines = stderr.split("\n").filter(line => line.startsWith("CSV_TRANSACTION_TIMING"));
  if (!lines.length || (lines.length === 1 && lines[0] === "CSV_TRANSACTION_TIMING_MISSING")) return { status: "MISSING" };
  if (lines.length !== 1 || !lines[0].startsWith(prefix) || Buffer.byteLength(lines[0]) > 1024) return { status: "INVALID" };
  try {
    const value = JSON.parse(lines[0].slice(prefix.length));
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.join(",")
      || value.schema_version !== "csv-transaction-timing-v1" || !["returned", "threw"].includes(value.outcome)
      || !duration(value.transaction_call_us)) return { status: "INVALID" };
    const parts = [value.begin_to_callback_us, value.callback_us, value.finalize_tail_us];
    const noCallback = parts.every(part => part === null);
    if (noCallback ? value.outcome !== "threw" : !parts.every(duration) || parts.reduce((sum, part) => sum + part, 0) !== value.transaction_call_us) return { status: "INVALID" };
    return { status: "OBSERVED", timing: value };
  } catch { return { status: "INVALID" }; }
}
