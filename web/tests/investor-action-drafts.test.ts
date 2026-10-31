import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type Database from "better-sqlite3";
import { investorActor as actor, investorFixture, saveSyntheticProfile } from "./investor-fixture";
import { getInvestorState } from "../src/server/investor/service";
import { readActionDraftProgress, unavailableActionDraftProgress } from "../src/server/investor/action-draft-progress";
import { actionDraftProgressSchema, type ActionDraftProgress } from "../src/server/investor/action-draft-progress-schemas";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { InvestorActionDrafts } from "../src/components/workbench/investor-action-drafts";

const at = "2026-01-03T07:00:01.000Z", binding = "a".repeat(64);
type F = ReturnType<typeof investorFixture>;
function setup(mode?: string) {
  const f = investorFixture(); saveSyntheticProfile(f);
  if (mode) produce(f, mode);
  return f;
}
function produce(f: F, mode: string, principal = actor) {
  const workspace = getInvestorState(f.db, principal, "2026-01-02T12:00:00.000Z").workspace_id!;
  const result = JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", "tests.investor.action_draft_progress_fixture",
    "--db", f.filename, "--workspace", workspace, "--actor", principal.id, "--mode", mode], {
    cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144,
  }));
  assert.equal(result.real_provider_called, false); assert.equal(result.real_gateway_called, false); return result;
}
function read(f: F, time = at, principal = actor) {
  const before = f.db.prepare("SELECT total_changes() n").get(), state = getInvestorState(f.db, principal, time);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
  for (const name of ["portfolios", "accounts", "ledger_events", "postings", "approval_events", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
  assert.equal(state.live_advice_eligible, false); assert.equal(state.effective_outcome, "insufficient_evidence");
  assert.ok(state.action_drafts); return state;
}

test("owner-scoped progress distinguishes no registration, future, disabled, expired and effective permission without pretending a provider is online", () => {
  for (const mode of [undefined, "future", "disabled", "waiting"] as const) {
    const f = setup(mode);
    try {
      const time = mode === "future" ? "2026-01-02T12:00:02.000Z" : at;
      const value = read(f, time).action_drafts!;
      assert.equal(value.status, mode === undefined ? "not_configured" : mode === "waiting" ? "waiting_scheduler" : mode);
      assert.equal(value.provider_online_verified, false); assert.equal(value.entries.length, 0);
      if (mode === "waiting") assert.equal(read(f, "2027-01-03T05:00:00.000Z").action_drafts!.status, "expired");
      assert.equal(getInvestorState(f.db, { id: "other-investor" }, time).action_drafts, undefined);
    } finally { f.close(); }
  }
});

test("actual synthetic producer registration, leases and immutable capture outcomes remain metadata only", () => {
  for (const mode of ["queued", "running", "unknown", "partial", "captured", "failed", "expired_job"]) {
    const f = setup(mode);
    try {
      const value = read(f, mode === "expired_job" ? "2026-01-03T07:04:01.000Z" : at).action_drafts!;
      assert.equal(value.status, "visible", mode); assert.equal(value.latest_source_day, "2026-01-03"); assert.equal(value.entries.length, 4);
      const counts = (state: string) => value.entries.filter(row => row.status === state).length;
      if (mode === "queued") assert.equal(counts("queued"), 4);
      if (mode === "running") {
        assert.equal(counts("running"), 1);
        assert.equal(read(f, "2026-01-03T07:03:00.000Z").action_drafts!.entries.filter(row => row.status === "lease_expired").length, 1);
      }
      if (mode === "unknown" || mode === "expired_job") assert.equal(counts("indeterminate_no_retry"), 1);
      if (mode === "partial") { assert.equal(counts("captured_draft"), 1); assert.equal(counts("queued"), 3); }
      if (mode === "captured") {
        assert.equal(counts("captured_draft"), 4); assert.ok(value.entries.every(row => row.qualification === "synthetic_test"));
        assert.ok(!JSON.stringify(value).includes("raw_sha256"));
      }
      if (mode === "failed") {
        assert.equal(counts("transport_failed"), 1); assert.equal(counts("superseded"), 3);
        assert.equal(value.entries.find(row => row.status === "transport_failed")!.reason_code, "EODHD_CAPTURE_AUTH_FAILED");
      }
      assert.equal(value.research_admitted, false); assert.equal(value.corporate_actions_complete, false);
    } finally { f.close(); }
  }
});

test("closed collection dates and ten-year retention cannot be presented as fresh queued work or usable drafts", () => {
  const f = setup("queued"), r = setup("retention");
  try {
    const old = read(f, "2026-01-04T07:00:00.000Z").action_drafts!;
    assert.equal(old.latest_source_day, "2026-01-03"); assert.ok(old.entries.every(row => row.status === "closed"));
    assert.ok(read(r, "2036-01-03T07:00:00.000Z").action_drafts!.entries.every(row => row.status === "retention_expired"));
  } finally { f.close(); r.close(); }
});

test("optional corrupt metadata fails closed without hiding independent research or leaking payloads", () => {
  const f = setup("captured");
  try {
    const before = read(f), queries: string[] = [];
    const safe = { transaction: f.db.transaction.bind(f.db), prepare(sql: string) { queries.push(sql); assert.doesNotMatch(sql, /eodhd_payloads|SELECT\s+payload/i); return f.db.prepare(sql); } } as Database.Database;
    assert.deepEqual(readActionDraftProgress(safe, before.workspace_id!, actor.id, at), before.action_drafts);
    assert.ok(queries.length < 40);
    f.db.exec("DROP TRIGGER investor_eodhd_capture_update");
    f.db.prepare("UPDATE investor_eodhd_captures SET content_hash=? WHERE rowid=(SELECT min(rowid) FROM investor_eodhd_captures)").run("b".repeat(64));
    const after = read(f);
    assert.equal(after.action_drafts!.status, "unavailable"); assert.deepEqual(after.effective_gaps, before.effective_gaps);
    assert.equal(after.effective_outcome, before.effective_outcome);
  } finally { f.close(); }
});

test("foreign workspace is rejected, and another owner's read cannot see a prior owner's attempts", () => {
  const f = setup("queued");
  try {
    const first = read(f);
    saveSyntheticProfile(f, { id: "other-investor" });
    const other = read(f, at, { id: "other-investor" });
    assert.equal(other.action_drafts!.status, "not_configured");
    assert.throws(() => readActionDraftProgress(f.db, first.workspace_id!, "other-investor", at), /PROGRESS_INVALID/);
    assert.equal(first.action_drafts!.entries.length, 4);
  } finally { f.close(); }
});

test("past authority history does not hide the active rule, control audits are batch-read and inspection never replenishes daily slots", () => {
  const f = setup("history");
  try {
    const state = read(f), count = f.db.prepare("SELECT count(*) n FROM investor_eodhd_requests").get();
    assert.equal(state.action_drafts!.status, "visible"); assert.equal(state.action_drafts!.entries.length, 4);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_eodhd_authorities").get() as { n: number }).n, 13);
    const queries: string[] = [], safe = { transaction: f.db.transaction.bind(f.db), prepare(sql: string) { queries.push(sql); return f.db.prepare(sql); } } as Database.Database;
    assert.deepEqual(readActionDraftProgress(safe, state.workspace_id!, actor.id, at), state.action_drafts);
    assert.ok(queries.length < 40); read(f);
    assert.deepEqual(f.db.prepare("SELECT count(*) n FROM investor_eodhd_requests").get(), count);
  } finally { f.close(); }
});

test("closed progress contract and session client reject advice promotion, future clocks, raw fields and fabricated entries", () => {
  const f = setup("captured");
  try {
    const state = read(f), value = state.action_drafts!;
    for (const changed of [{ ...value, live_advice_eligible: true }, { ...value, research_admitted: true }, { ...value, provider_online_verified: true },
      { ...value, raw: "private" }, { ...value, entries: value.entries.slice(0, 3) }, { ...value, entries: [value.entries[0], ...value.entries.slice(0, 3)] },
      { ...value, latest_source_day: "2026-02-30" }, { ...value, refresh_after: value.checked_at },
      { ...value, refresh_after: "2027-01-03T07:00:01.000Z" }, { ...value, latest_source_day: "2027-01-03" }])
      assert.equal(actionDraftProgressSchema.safeParse(changed).success, false);
    assert.throws(() => parseInvestorState({ ...state, session_binding: binding, action_drafts: { ...value, checked_at: "2026-01-03T07:00:02.000Z" } }, binding), /RESPONSE_INVALID/);
    const legacy = { ...state }; delete legacy.action_drafts;
    assert.deepEqual(parseInvestorState({ ...legacy, session_binding: binding }, binding), legacy);
  } finally { f.close(); }
});

test("semantic mobile-friendly panel explains pending and failure states, labels synthetic captures and stops claiming old status at expiry", () => {
  const f = setup("failed");
  try {
    const value = read(f).action_drafts!, render = (v: ActionDraftProgress, now = at) => renderToStaticMarkup(createElement(InvestorActionDrafts, { value: v, nowMs: Date.parse(now) }));
    const html = render(value); assert.match(html, /公司行动交叉核验进度/); assert.match(html, /来源鉴权或权限未通过/);
    assert.match(html, /合成采集测试/); assert.match(html, /最近登记的纽约日期/); assert.doesNotMatch(html, /<button|<form|<pre/);
    const stale = render(value, value.refresh_after); assert.match(stale, /状态快照已到复核时间/); assert.doesNotMatch(stale, /来源鉴权或权限未通过/);
    assert.match(render(unavailableActionDraftProgress(at)), /采集记录暂未通过完整核对/);
  } finally { f.close(); }
});
