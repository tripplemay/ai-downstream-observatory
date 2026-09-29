import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { childJson, linkMixedServerTargets, mixedCsvInput, mixedOverlapSummary, parseMixedOptions, removeVerifiedTemporary, retainMixedAttachments } from "../scripts/benchmark-workbench-mixed";
import type { HttpLoadReport, HttpLoadSample } from "../scripts/workbench-http-load";
import type { WorkbenchMixedFixture } from "../scripts/workbench-mixed-fixture";
import { mapCsvImport, parseCsvMapping } from "../src/server/ledger/csv-mapping";

test("mixed benchmark defaults are explicitly small and preserve normal worker polling defaults", () => {
  const input = parseMixedOptions([]);
  assert.deepEqual([input.history, input.listings, input.marketRows, input.csvRows, input.count], [30, 10, 50, 10, 20]);
  assert.equal(input.coreCount, 1); assert.equal(input.pollSeconds, 5);
  assert.equal(input.setupMs, 600000); assert.equal(input.overallMs, 180000);
  assert.equal(input.backgroundCycles, 1); assert.equal(input.backgroundIntervalMs, 20000);
  assert.equal(parseMixedOptions(["--background-cycles", "12"]).backgroundCycles, 12);
  assert.equal(parseMixedOptions(["--setup-seconds", "30", "--overall-seconds", "120"]).setupMs, 30000);
  assert.equal(parseMixedOptions(["--poll-seconds", "0.1"]).pollSeconds, .1);
  assert.equal(parseMixedOptions(["--count", "1000", "--history", "50000", "--listings", "1000", "--market-rows", "2000000", "--csv-rows", "10000"]).count, 1000);
  for (const args of [["--count", "0"], ["--count", "1001"], ["--poll-seconds", "0"], ["--poll-seconds", "Infinity"], ["--core-count", "4"], ["--history", "05"], ["--setup-seconds", "0"], ["--unknown"]]) assert.throws(() => parseMixedOptions(args));
});

test("mixed CSV originals map all rows to unique reliable sources and an independently calculable cash sum", () => {
  const fixture = { ids: { csv: { account_ids: ["csv-account"] } }, clock: { effective_date: "2026-09-24" } } as WorkbenchMixedFixture;
  const input = mixedCsvInput(fixture, 10), mapping = parseCsvMapping(input.mapping);
  const mapped = mapCsvImport(input.bytes, mapping, { portfolio_id: "csv-portfolio", account_id: "csv-account", accounts: [{ id: "csv-account", portfolio_id: "csv-portfolio" }], listings: [] });
  assert.equal(mapped.can_preview, true); assert.equal(mapped.rows.length, 10); assert.equal(input.total_amount, "10000055");
  assert.deepEqual(mapped.rows.map(row => row.command?.source_event_id), Array.from({ length: 10 }, (_, i) => `mixed-csv:${i}`));
  assert.ok(mapped.rows.every(row => row.command?.source_id === "synthetic-mixed-csv" && row.command.fact.type === "deposit" && row.command.fact.account_id === "csv-account"));
  assert.equal(mapped.rows.reduce((sum, row) => sum + BigInt((row.command!.fact as { amount: string }).amount), 0n).toString(), input.total_amount);
  assert.throws(() => mixedCsvInput(fixture, 0)); assert.throws(() => mixedCsvInput(fixture, 10001));
});

test("oracle transport retains valid JSON only after its owned process has exited", async () => {
  const result = await childJson(process.execPath, ["-e", "process.stdout.write(JSON.stringify({status:'passed'}))"], { PATH: process.env.PATH, NODE_ENV: "test" }, 2000);
  assert.equal(result.exit_code, 0); assert.equal(result.cleanup_verified, true); assert.deepEqual(result.value, { status: "passed" });
});

test("oracle transport cannot accept a timeout response or wait forever for a TERM-ignoring child", { timeout: 6000 }, async () => {
  const result = await childJson(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write(JSON.stringify({status:'passed'}));setInterval(()=>{},1000)"], { PATH: process.env.PATH, NODE_ENV: "test" }, 100);
  assert.equal(result.cleanup_verified, true); assert.equal(result.value, null); assert.equal(result.stderr, "ORACLE_TIMEOUT"); assert.notEqual(result.exit_code, 0);
});

test("fixture setup uses a separately bounded process and keeps partial evidence after a timeout", { timeout: 10000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mixed-partial-fixture-"));
  const filename = path.join(directory, "partial.db");
  try {
    const result = await childJson(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(filename)},'partial');setInterval(()=>{},1000)`],
      { PATH: process.env.PATH, NODE_ENV: "test" }, 3000, "FIXTURE");
    assert.equal(result.stderr, "FIXTURE_TIMEOUT"); assert.equal(result.value, null);
    assert.equal(result.cleanup_verified, true); assert.notEqual(result.exit_code, 0);
    assert.equal(removeVerifiedTemporary(directory, true, false), false);
    assert.equal(readFileSync(filename, "utf8"), "partial");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("mixed overlap needs real dispatches and measured HTTP overlap in every class and background window", () => {
  const classes = ["ledger-get", "governance-get", "record-fact", "approval"];
  const windows = ["csv_preview_flow", "csv_confirm_flow", "market_valuation_update_flow"].map(name => ({ name, started_ms: 10, completed_ms: 20 }));
  const samples: HttpLoadSample[] = classes.map(class_id => ({ sample_id: `${class_id}:0`, class_id, index: 0, target: null,
    scheduled_ms: 11, dispatched_ms: 11, completed_ms: 19, queue_ms: 0, wall_ms: 8, status: "success", error: null,
    result: { ok: true, http: { method: "GET", url: "/api/workbench", status: 200, timings: { started_ms: 12, headers_ms: 15, completed_ms: 18 } } } }));
  const load = { samples, classes: Object.fromEntries(classes.map(id => [id, {}])) } as HttpLoadReport;
  assert.equal(mixedOverlapSummary(load, windows).verified, true);
  assert.equal(mixedOverlapSummary(load, [...windows, { name: "market_valuation_update_flow:2", started_ms: 10, completed_ms: 20 }]).verified, true);
  assert.equal(mixedOverlapSummary(load, [...windows, windows[2]]).verified, false);
  samples[0].dispatched_ms = 9;
  let value = mixedOverlapSummary(load, windows);
  assert.equal(value.verified, false); assert.equal(value.windows.csv_preview_flow[classes[0]].operation_overlap, 1);
  assert.equal(value.windows.csv_preview_flow[classes[0]].dispatched_during_window, 0);
  samples[0].dispatched_ms = 11; samples[0].result!.http.timings = { started_ms: 21, headers_ms: 22, completed_ms: 23 };
  assert.equal(mixedOverlapSummary(load, windows).verified, false);
  assert.equal(mixedOverlapSummary(load, []).verified, false);
  assert.equal(mixedOverlapSummary(load, windows.map(window => ({ ...window, completed_ms: null }))).verified, false);
});

test("server timing links successful targets but preserves client failures that never reached the server", () => {
  const attempts = [
    { phase: "ledger-get", sample_id: "ledger-get:0", method: "GET", path: "/api/workbench", status: 200, server_request_id: "run:1", error: null },
    { phase: "ledger-get", sample_id: "ledger-get:1", method: "GET", path: "/api/workbench", status: null, server_request_id: "run:2", error: "HTTP_TRANSPORT_FAILED" },
    { phase: "record-fact", sample_id: "record-fact:0", method: "POST", path: "/api/workbench", status: 503, server_request_id: "run:3", error: null },
  ];
  const requests = {
    "run:1": { trace_id: "trace:1", method: "GET", path: "/api/workbench", status: 200, outcome: "finish", duration_ms: 10 },
    "run:3": { trace_id: "trace:3", method: "POST", path: "/api/workbench", status: 503, outcome: "finish", duration_ms: 20 },
  };
  const load = { samples: [
    { sample_id: "ledger-get:0", class_id: "ledger-get", status: "success" },
    { sample_id: "ledger-get:1", class_id: "ledger-get", status: "error" },
    { sample_id: "record-fact:0", class_id: "record-fact", status: "error" },
  ], classes: { "ledger-get": {}, "record-fact": {} } } as unknown as HttpLoadReport;
  const linked = linkMixedServerTargets(attempts, load, { requests } as never);
  assert.equal(linked.server_samples.length, 2);
  assert.deepEqual(linked.server_unobserved_targets, [{ sample_id: "ledger-get:1", request_id: "run:2", error: "HTTP_TRANSPORT_FAILED", server_observed: false }]);
  assert.equal(linked.server_latency["ledger-get"].successful_count, 1);
  assert.equal(linked.server_latency["record-fact"].successful_count, 0);
  assert.throws(() => linkMixedServerTargets(attempts, load, { requests: { "run:3": requests["run:3"] } } as never), /SERVER_TRACE_TARGET_MISMATCH/);
});

test("stopped fixture remains available when evidence retention fails, and unknown writers are never removed", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mixed-retention-test-")), original = path.join(directory, "original-evidence");
  try {
    writeFileSync(original, "retention failed; preserve original");
    assert.equal(removeVerifiedTemporary(directory, true, false), false); assert.equal(existsSync(original), true);
    assert.equal(removeVerifiedTemporary(directory, false, true), false); assert.equal(existsSync(original), true);
    assert.equal(removeVerifiedTemporary(directory, true, true), true); assert.equal(existsSync(directory), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("retained attachments preserve private directory and file modes as well as original bytes", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mixed-private-evidence-")), source = path.join(directory, "source"), target = path.join(directory, "retained");
  try {
    mkdirSync(source, { mode: 0o700 }); writeFileSync(path.join(source, "original.json"), '{"synthetic":true}', { mode: 0o600 });
    const evidence = retainMixedAttachments(source, target);
    assert.equal(evidence.directory_mode, "0700"); assert.equal(evidence.files.length, 1);
    assert.equal(evidence.files[0].mode, "0600"); assert.equal(statSync(target).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(target, "original.json")).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(path.join(target, "original.json")), readFileSync(path.join(source, "original.json")));
    assert.throws(() => retainMixedAttachments(source, target), /REFUSE_TO_OVERWRITE_ATTACHMENTS/);
    chmodSync(source, 0o755);
    assert.throws(() => retainMixedAttachments(source, path.join(directory, "invalid")), /SOURCE_ATTACHMENT_DIRECTORY_INVALID/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
