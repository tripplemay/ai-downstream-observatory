import assert from "node:assert/strict";
import test from "node:test";
import { readTransactionTiming } from "../scripts/csv-benchmark-timing";

const timing = { schema_version: "csv-transaction-timing-v1", outcome: "returned", transaction_call_us: 10,
  begin_to_callback_us: 2, callback_us: 5, finalize_tail_us: 3 };
const line = (value: unknown) => `CSV_TRANSACTION_TIMING ${JSON.stringify(value)}\n`;

test("CSV benchmark timing is opt-in and never fills missing measurements with zero", () => {
  assert.deepEqual(readTransactionTiming(line(timing), false), { status: "NOT_REQUESTED" });
  for (const stderr of ["", "CSV_TRANSACTION_TIMING_MISSING\n", "CSV_BACKGROUND_WORKER_FAILED\n"]) assert.deepEqual(readTransactionTiming(stderr, true), { status: "MISSING" });
  assert.deepEqual(readTransactionTiming(line(timing), true), { status: "OBSERVED", timing });
  const failed = { ...timing, outcome: "threw", begin_to_callback_us: null, callback_us: null, finalize_tail_us: null };
  assert.deepEqual(readTransactionTiming(line(failed), true), { status: "OBSERVED", timing: failed });
});

test("CSV benchmark rejects malformed, mixed, duplicated and inconsistent diagnostics", () => {
  for (const value of [null, [], {}, { ...timing, extra: "secret" }, { ...timing, outcome: "committed" },
    { ...timing, transaction_call_us: true }, { ...timing, callback_us: 5.5 }, { ...timing, callback_us: -1 },
    { ...timing, transaction_call_us: Number.MAX_SAFE_INTEGER + 1 }, { ...timing, transaction_call_us: 11 },
    { ...timing, callback_us: null }, { ...timing, begin_to_callback_us: null, callback_us: null, finalize_tail_us: null }]) {
    assert.equal(readTransactionTiming(line(value), true).status, "INVALID");
  }
  for (const value of ["CSV_TRANSACTION_TIMING {\n", "CSV_TRANSACTION_TIMINGX\n", line(timing) + line(timing), line(timing) + "CSV_TRANSACTION_TIMING_MISSING\n",
    "CSV_TRANSACTION_TIMING " + " ".repeat(1025) + JSON.stringify(timing)]) assert.equal(readTransactionTiming(value, true).status, "INVALID");
});
