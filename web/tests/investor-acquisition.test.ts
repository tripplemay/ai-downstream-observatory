import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { openWorkbench } from "../src/server/workbench-db";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { acquisitionDisplayInstant, readInvestorAcquisition } from "../src/server/investor/acquisition";
import { acquisitionSchema, type InvestorAcquisition, type InvestorModelWatch } from "../src/server/investor/schemas";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { acquisitionDeadlines, currentAcquisitionDisplay, InvestorAcquisitionPanel } from "../src/components/workbench/investor-acquisition";
import { currentModelWatchDisplay, investorPollInterval } from "../src/components/workbench/research-format";

type F = ReturnType<typeof investorFixture>;
const binding = "a".repeat(64), initialAt = "2026-01-03T12:00:04.000Z", early = "2026-01-04T06:55:01.000Z", end = "2026-01-04T07:01:03.000Z";
function helper(f: F, module: string, args: string[] = []) {
  const result = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
    cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  })) as { real_provider_called?: boolean; real_gateway_called?: boolean; stubbed_sdk_calls?: number };
  assert.notEqual(result.real_provider_called, true); assert.notEqual(result.real_gateway_called, true); return result;
}
function clone(f: F): F {
  const directory = mkdtempSync(path.join(os.tmpdir(), "etf-investor-synthetic-")), filename = path.join(directory, "workbench.db");
  writeFileSync(filename, f.db.serialize(), { mode: 0o600 }); const db = openWorkbench(filename);
  return { directory, filename, db, close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function saved(f: F, initial: boolean) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
  helper(f, "tests.investor.evidence_fixture", initial ? ["--initial-monitor-calendar"] : []);
  helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const at = "2026-01-02T12:00:04.000Z", state = getInvestorState(f.db, actor, at); assert.ok(state.plan);
  executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision, idempotency_key: "save-acquisition-reference" }, at);
}
function read(f: F, at: string) {
  const changes = f.db.prepare("SELECT total_changes() n").get(), state = getInvestorState(f.db, actor, at);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
  assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
  assert.ok(state.model_watch?.acquisition); assert.notEqual(state.model_watch.acquisition.status, "unavailable");
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
  return state;
}

test("actual initial producer activity is read-only: no registration, queued, leased, lease-dead, completed and failed", () => {
  const base = investorFixture();
  try {
    saved(base, true);
    const start = read(base, initialAt); assert.equal(start.model_watch!.acquisition!.phase, "initial_prices");
    assert.deepEqual(start.model_watch!.acquisition!.markets.map(row => [row.market, row.target_count, row.status]), [["CN", 2, "not_registered"]]);
    for (const change of [{ model_id: "other-model" }, { checked_at: early }, { status: "paused" },
      { markets: [{ ...start.model_watch!.acquisition!.markets[0], target_count: 1 }] }])
      assert.throws(() => parseInvestorState({ ...start, session_binding: binding, model_watch: { ...start.model_watch!,
        acquisition: { ...start.model_watch!.acquisition!, ...change } } }, binding), /RESPONSE_INVALID/);
    const legacy = structuredClone(start); delete legacy.model_watch!.acquisition;
    assert.deepEqual(parseInvestorState({ ...legacy, session_binding: binding }, binding), legacy);
    for (const mode of ["discover", "claim", "collect", "failed"] as const) {
      const f = clone(base);
      try {
        const output = helper(f, "tests.investor.initial_price_fixture", ["--mode", mode]);
        assert.equal(output.stubbed_sdk_calls, ["discover", "claim"].includes(mode) ? 0 : 2);
        const state = read(f, initialAt), row = state.model_watch!.acquisition!.markets[0];
        assert.equal(row.status, { discover: "queued", claim: "running", collect: "waiting_core", failed: "failed" }[mode]);
        assert.equal(row.registered_count, 2); assert.equal(row.completed_count, mode === "collect" ? 2 : 0);
        assert.equal(state.model_watch?.checkpoint_sequence, 0); assert.equal(state.model_watch?.model_nav_cny, null);
        assert.equal(state.effective_outcome, "insufficient_evidence");
        if (mode === "claim") assert.equal(read(f, "2026-01-03T12:05:04.000Z").model_watch!.acquisition!.markets[0].status, "lease_expired");
        if (mode === "collect") assert.equal(investorPollInterval({ ...state, model_watch: { ...state.model_watch!, status: "blocked" } }), 5000);
        const paused = executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: state.model_watch!.id, enabled: false,
          expected_revision: state.revision, idempotency_key: "pause-acquisition" }, initialAt);
        assert.equal(paused.revision, state.revision + 1); assert.equal(read(f, initialAt).model_watch!.acquisition!.status, "paused");
      } finally { f.close(); }
    }
  } finally { base.close(); }
});

test("actual confirmed producer exposes registered windows, missed starts, partial events and core admission without upgrading research", () => {
  const base = investorFixture();
  try {
    saved(base, false);
    helper(base, "tests.investor.confirmed_monitor_fixture", ["--admit", "--monitor", "--next-calendar"]);
    assert.equal(read(base, early).model_watch!.acquisition!.markets[0].status, "not_registered");
    for (const mode of ["discover", "claim", "complete", "partial", "empty", "late", "admit"] as const) {
      const f = clone(base);
      try {
        const output = helper(f, "tests.investor.acquisition_fixture", ["--mode", mode]);
        assert.equal(output.stubbed_sdk_calls, ["discover", "claim", "late"].includes(mode) ? 0 : 1);
        const at = mode === "discover" ? early : mode === "claim" ? "2026-01-04T06:58:01.000Z" : end;
        const state = read(f, at), activity = state.model_watch!.acquisition!, row = activity.markets[0];
        assert.equal(activity.phase, "confirmed_close");
        assert.equal(row.status, { discover: "scheduled", claim: "running", complete: "waiting_core", partial: "partial", empty: "no_events", late: "missed_window", admit: "input_registered" }[mode]);
        assert.equal(row.scheduled_at, "2026-01-04T06:58:00.000Z"); assert.equal(row.latest_start_at, "2026-01-04T06:59:30.000Z");
        if (mode === "discover") {
          assert.equal(read(f, "2026-01-04T06:58:01.000Z").model_watch!.acquisition!.markets[0].status, "queued");
          assert.equal(read(f, "2026-01-04T06:59:30.001Z").model_watch!.acquisition!.markets[0].status, "missed_window");
        }
        assert.equal(activity.evidence_scope, "task_metadata_only"); assert.equal(state.live_advice_eligible, false);
      } finally { f.close(); }
    }
  } finally { base.close(); }
});

test("corrupt optional task records fail closed without disabling independently checked research or crossing owners", () => {
  const f = investorFixture();
  try {
    saved(f, true); helper(f, "tests.investor.initial_price_fixture", ["--mode", "discover"]);
    const state = read(f, initialAt), watch = state.model_watch!;
    assert.equal(getInvestorState(f.db, { id: "other-investor" }, initialAt).model_watch, null);
    const request = f.db.prepare("SELECT id,document_json FROM investor_initial_price_requests LIMIT 1").get() as { id: string; document_json: string };
    f.db.exec("DROP TRIGGER investor_initial_price_request_update");
    f.db.prepare("UPDATE investor_initial_price_requests SET document_json=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(request.document_json), unexpected: true }), request.id);
    assert.throws(() => readInvestorAcquisition(f.db, state.workspace_id!, watch, state.profile!, initialAt, true));
    const after = getInvestorState(f.db, actor, initialAt);
    assert.equal(after.model_watch!.acquisition!.status, "unavailable");
    assert.deepEqual(after.effective_gaps, state.effective_gaps); assert.equal(after.effective_outcome, state.effective_outcome);
    assert.deepEqual(parseInvestorState({ ...after, session_binding: binding }, binding), after);
  } finally { f.close(); }
});

const future = "2026-01-05T12:00:00.000Z";
function activity(status: InvestorAcquisition["markets"][number]["status"] = "scheduled"): InvestorAcquisition {
  return acquisitionSchema.parse({ model_id: "fictional-model", checked_at: early, phase: "confirmed_close", status: "visible",
    markets: [{ market: "CN", target_count: 2, registered_count: 2, completed_count: 0, status, session_date: "2026-01-04",
      scheduled_at: "2026-01-04T06:58:00.000Z", latest_start_at: "2026-01-04T06:59:30.000Z", stop_at: "2026-01-04T07:03:00.000Z",
      lease_until: status === "running" ? "2026-01-04T06:59:00.000Z" : null, valid_until: future, completed_at: null }],
    evidence_scope: "task_metadata_only", live_advice_eligible: false });
}
test("offline display expires model, lease and missed start independently of polling, with conservative UTC clock projection", () => {
  assert.equal(currentAcquisitionDisplay(activity(), Date.parse("2026-01-04T06:58:00.000Z"), future).markets[0].status, "queued");
  assert.equal(currentAcquisitionDisplay(activity(), Date.parse("2026-01-04T06:59:30.001Z"), future).markets[0].status, "missed_window");
  assert.equal(currentAcquisitionDisplay(activity("running"), Date.parse("2026-01-04T06:59:00.000Z"), future).markets[0].status, "lease_expired");
  assert.equal(currentAcquisitionDisplay(activity(), Date.parse(future), future).status, "expired");
  assert.ok(acquisitionDeadlines(activity(), future).includes(Date.parse("2026-01-04T06:59:30.001Z")));
  assert.equal(acquisitionDisplayInstant("1969-12-31T23:59:59.999999Z"), "1969-12-31T23:59:59.999Z");
  assert.equal(acquisitionDisplayInstant("1969-12-31T23:59:59.999999Z", "start"), "1970-01-01T00:00:00.000Z");
  assert.equal(acquisitionDisplayInstant("2026-01-04T06:58:00.000001Z", "start"), "2026-01-04T06:58:00.001Z");
  assert.throws(() => acquisitionDisplayInstant("2026-02-30T00:00:00Z"));
});
test("closed acquisition contract refuses extra data, invented completion, live authority and duplicate markets", () => {
  const value = activity();
  for (const copy of [{ ...value, actual_cash: "100" }, { ...value, evidence_scope: "qualified_market_data" }, { ...value, live_advice_eligible: true },
    { ...value, markets: [...value.markets, ...value.markets] }, { ...value, markets: [{ ...value.markets[0], completed_count: 3 }] },
    { ...value, markets: [{ ...value.markets[0], status: "waiting_core" }] }]) assert.equal(acquisitionSchema.safeParse(copy).success, false);
});
test("offline model display hides expired NAV and due conclusions even when refresh is paused", () => {
  const watch: InvestorModelWatch = { id: "model", profile_id: "profile", plan_id: "plan", plan_hash: "b".repeat(64), valid_until: future, enabled: true,
    status: "research_observe", created_at: early, completed_at: early, next_check_at: end, checkpoint_sequence: 1, initial_notional_cny: "10000",
    evaluation_input_version: "c".repeat(64), model_nav_cny: "10001", source_qualification: "owner_reviewed_reconstructed", live_advice_eligible: false };
  assert.equal(currentModelWatchDisplay(watch, Date.parse(end)).status, "overdue");
  assert.equal(currentModelWatchDisplay(watch, Date.parse(end)).model_nav_cny, null);
  assert.equal(currentModelWatchDisplay(watch, Date.parse(future)).status, "expired");
  assert.equal(currentModelWatchDisplay({ ...watch, enabled: false, status: "paused" }, Date.parse(future)).status, "paused");
});
test("bounded semantic panel renders distinct empty, missed and invalid states without a new manual workflow", () => {
  const value = activity(), render = (input: InvestorAcquisition, at = early) => renderToStaticMarkup(createElement(InvestorAcquisitionPanel,
    { value: input, nowMs: Date.parse(at), modelValidUntil: future }));
  const scheduled = render(value); assert.match(scheduled, /已登记待启动窗口/); assert.match(scheduled, /aria-label="行情采集进度"/);
  assert.match(scheduled, /不是 worker 在线/); assert.doesNotMatch(scheduled, /<button|<input|<form/);
  assert.match(render(value, "2026-01-04T06:59:30.001Z"), /已错过本次启动窗口/);
  assert.match(render({ ...value, status: "unavailable", markets: [] }), /记录未通过核对/);
  const none = { ...value, markets: [{ ...value.markets[0], registered_count: 0, completed_count: 0, status: "not_registered" as const,
    session_date: null, scheduled_at: null, latest_start_at: null, stop_at: null, valid_until: null }] };
  assert.match(render(none), /未推测下次时间/);
});
