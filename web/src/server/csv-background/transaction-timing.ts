import type Database from "better-sqlite3";
import type { CsvTransactionTiming } from "./types";

/** Measures API boundaries, not exact SQLite lock acquisition/release instants. */
export function runCsvTransaction<T>(db: Database.Database, operation: () => T, observe?: (timing: CsvTransactionTiming) => void): T {
  if (db.inTransaction) throw new Error("CSV_BACKGROUND_INDEPENDENT_TRANSACTION_REQUIRED");
  if (!observe) return db.transaction(operation).immediate();
  let entered: bigint | undefined, exited: bigint | undefined;
  let outcome: CsvTransactionTiming["outcome"] = "threw";
  const transaction = db.transaction(() => {
    entered = process.hrtime.bigint();
    try { return operation(); }
    finally { exited = process.hrtime.bigint(); }
  });
  const started = process.hrtime.bigint();
  try {
    const result = transaction.immediate();
    outcome = "returned";
    return result;
  } finally {
    const finished = process.hrtime.bigint();
    const offset = (instant: bigint) => Number((instant - started) / 1000n);
    const total = offset(finished), begin = entered === undefined ? null : offset(entered), end = exited === undefined ? null : offset(exited);
    // Diagnostics run only after transaction return/throw and never change its result.
    try {
      observe({ schema_version: "csv-transaction-timing-v1", outcome, transaction_call_us: total,
        begin_to_callback_us: begin, callback_us: begin === null || end === null ? null : end - begin,
        finalize_tail_us: end === null ? null : total - end });
    } catch { /* Non-authoritative telemetry must not change a financial outcome. */ }
  }
}
