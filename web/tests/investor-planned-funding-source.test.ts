import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonical, hash } from "../src/server/ledger/service";
import { openWorkbench } from "../src/server/workbench-db";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { readBoundPlannedFundingMonitor, readPlannedFundingMonitor } from "../src/server/investor/planned-funding-source";
import type { PlannedFundingBinding } from "../src/server/investor/planned-funding-monitor";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";

type F = ReturnType<typeof investorFixture>;
const savedAt = "2026-01-03T12:15:04.000Z", dueAt = "2026-01-04T00:00:00.000Z";
const plan = { schema_version: "investor-funding-plan-v1" as const, start_date: "2026-01-02", horizon_years: 1,
  evaluation_timezone: "Asia/Shanghai" as const, initial_capital_cny: "100.01", annual_contribution_cny: "10.01", first_annual_date: "2026-01-04",
  entry_method: "three_tranches_60_days" as const, actual_arrivals_confirmed: false as const, execution_authorized: false as const, live_advice_eligible: false as const };
function python(f: F, module: string, args: string[] = [], input?: unknown) {
  return spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args],
    { cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 1048576, ...(input === undefined ? {} : { input: JSON.stringify(input) }) });
}
function helper(f: F, module: string, args: string[] = []) {
  const child = python(f, module, args); assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}
function seed(f: F, fixed = true) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
  helper(f, "tests.investor.evidence_fixture", fixed ? ["--fixed-policy-v2"] : []);
  helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const candidate = getInvestorState(f.db, actor, "2026-01-02T12:00:04.000Z"); assert.ok(candidate.plan);
  executeInvestorCommand(f.db, actor, { action: "save_plan", expected_revision: candidate.revision, idempotency_key: "planned-funding-model", plan_id: candidate.plan.id },
    "2026-01-02T12:00:04.000Z");
  helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--later"]);
  const state = getInvestorState(f.db, actor, savedAt); assert.ok(state.workspace_id && state.model_watch);
  return { workspace: state.workspace_id, model: state.model_watch.id };
}
function save(f: F, id = "planned-funding-private", at = savedAt) {
  const state = getInvestorState(f.db, actor, at);
  return executeInvestorCommand(f.db, actor, { action: "save_funding_plan", funding_plan: plan, expected_revision: state.revision, idempotency_key: id }, at);
}
function replay(f: F, scope: ReturnType<typeof seed>, at: string, owner = actor.id) {
  return helper(f, "tests.investor.planned_funding_fixture", ["--workspace", scope.workspace, "--model", scope.model, "--at", at, "--actor", owner]);
}
function rejectsPython(f: F, scope: ReturnType<typeof seed>, at: string, owner = actor.id) {
  const child = python(f, "tests.investor.planned_funding_fixture", ["--workspace", scope.workspace, "--model", scope.model, "--at", at, "--actor", owner]);
  assert.notEqual(child.status, 0); assert.match(child.stderr, /INVESTOR_/);
}
function boundPython(f: F, scope: ReturnType<typeof seed>, binding: PlannedFundingBinding, at = savedAt, checkedAt = dueAt, owner = actor.id) {
  return python(f, "tests.investor.planned_funding_fixture", ["--workspace", scope.workspace, "--model", scope.model, "--at", at,
    "--actor", owner, "--bound", "--checked-at", checkedAt], binding);
}
function boundReplay(f: F, scope: ReturnType<typeof seed>, binding: PlannedFundingBinding, at = savedAt, checkedAt = dueAt) {
  const child = boundPython(f, scope, binding, at, checkedAt); assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}
function snapshot(f: F) {
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => { assert.match(name, /^[a-z0-9_]+$/); return { name, rows: f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() }; });
}
function noFinance(f: F) {
  for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0, name);
}

test("saved owner plans feed both independent readers for legacy and fixed models without any state writes", () => {
  for (const fixed of [false, true]) {
    const f = investorFixture();
    try {
      const scope = seed(f, fixed); save(f);
      const before = snapshot(f), changes = f.db.prepare("SELECT total_changes() n").get();
      const future = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, savedAt)!;
      assert.equal(future.projection.status, "not_due"); assert.equal(future.projection.due_amount_normalized_cny, "0");
      assert.deepEqual(replay(f, scope, savedAt), future);
      const due = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, dueAt)!;
      assert.equal(due.projection.status, "hypothetical_due"); assert.equal(due.projection.due_amount_normalized_cny, "332.966703329667033296");
      assert.deepEqual(replay(f, scope, dueAt), due);
      assert.deepEqual(snapshot(f), before); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes); noFinance(f);
      assert.ok(f.db.prepare("SELECT 1 FROM investor_evidence_model_checkpoints").get());
      assert.ok(f.db.prepare("SELECT 1 FROM investor_evidence_monitor_runs").get());
      assert.equal("cash_cny" in due.projection, false); assert.equal(due.projection.qualification, "unadmitted_planned_funding_projection");
    } finally { f.close(); }
  }
});

test("absence, foreign owner, pause and model expiry do not manufacture a funding projection", () => {
  const f = investorFixture();
  try {
    const scope = seed(f);
    assert.equal(readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, savedAt), null); assert.equal(replay(f, scope, savedAt), null);
    save(f); const before = snapshot(f);
    assert.throws(() => readPlannedFundingMonitor(f.db, { id: "foreign-owner" }, scope.workspace, scope.model, savedAt));
    rejectsPython(f, scope, savedAt, "foreign-owner"); assert.deepEqual(snapshot(f), before);
    const model = JSON.parse((f.db.prepare("SELECT document_json FROM investor_models WHERE id=?").get(scope.model) as { document_json: string }).document_json);
    assert.throws(() => readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, model.valid_until)); rejectsPython(f, scope, model.valid_until);
    const state = getInvestorState(f.db, actor, savedAt);
    executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: scope.model, enabled: false,
      expected_revision: state.revision, idempotency_key: "planned-funding-pause" }, savedAt);
    const paused = snapshot(f);
    assert.throws(() => readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, savedAt)); rejectsPython(f, scope, savedAt);
    assert.deepEqual(snapshot(f), paused); noFinance(f);
  } finally { f.close(); }
});

test("new saved version reanchors without retroactive cash; changed preferences cannot reuse the old bound plan or model", () => {
  const f = investorFixture();
  try {
    const scope = seed(f); save(f);
    const old = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, dueAt)!;
    save(f, "planned-funding-new-version", dueAt);
    const revised = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, dueAt)!;
    assert.equal(revised.projection.anchor_at, dueAt); assert.equal(revised.projection.status, "not_due");
    assert.equal(revised.projection.releases[0].status, "excluded_before_anchor");
    assert.notEqual(revised.request.binding.funding_plan_id, old.request.binding.funding_plan_id);
    assert.notEqual(revised.projection.funding_intent!.id, old.projection.funding_intent!.id);
    assert.deepEqual(replay(f, scope, dueAt), revised);
    const state = getInvestorState(f.db, actor, dueAt);
    executeInvestorCommand(f.db, actor, { action: "save_profile", profile: { ...syntheticProfile, loss_tolerance: "0.20" },
      expected_revision: state.revision, idempotency_key: "planned-funding-profile-change" }, dueAt);
    const before = snapshot(f);
    assert.throws(() => readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, dueAt)); rejectsPython(f, scope, dueAt);
    assert.deepEqual(snapshot(f), before); noFinance(f);
  } finally { f.close(); }
});

test("restore-mode reads remain zero-write and corrupt command audits are rejected by both engines", () => {
  const f = investorFixture();
  try {
    const scope = seed(f), receipt = save(f);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "FICTIONAL PRIVATE FUNDING READ ONLY\n");
    const before = snapshot(f);
    const prepared = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, savedAt);
    assert.deepEqual(replay(f, scope, savedAt), prepared); assert.deepEqual(snapshot(f), before);
    assert.ok(prepared);
    assert.deepEqual(readBoundPlannedFundingMonitor(f.db, actor, scope.workspace, prepared.request.binding, savedAt, dueAt), prepared);
    assert.deepEqual(boundReplay(f, scope, prepared.request.binding), prepared); assert.deepEqual(snapshot(f), before);
    const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_events' AND sql LIKE '%UPDATE%'").all() as { name: string }[];
    for (const row of triggers) { assert.match(row.name, /^[a-z0-9_]+$/); f.db.exec(`DROP TRIGGER ${row.name}`); }
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run('{"input":{},"result":{}}', receipt.audit_id);
    const corrupt = snapshot(f);
    assert.throws(() => readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, savedAt)); rejectsPython(f, scope, savedAt);
    assert.deepEqual(snapshot(f), corrupt); noFinance(f);
  } finally { f.close(); }
});

test("frozen versions replay after a new plan, pause, changed preferences and model expiry without becoming current advice", () => {
  for (const fixed of [false, true]) {
    const f = investorFixture();
    try {
      const scope = seed(f, fixed); save(f);
      const original = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, savedAt)!;
      const oldDue = readBoundPlannedFundingMonitor(f.db, actor, scope.workspace, original.request.binding, dueAt, dueAt);
      save(f, "frozen-new-version", dueAt);
      const current = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, dueAt)!;
      assert.notEqual(current.context_hash, oldDue.context_hash);
      assert.equal(current.projection.status, "not_due"); assert.equal(oldDue.projection.status, "hypothetical_due");
      let state = getInvestorState(f.db, actor, dueAt);
      executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: scope.model, enabled: false,
        expected_revision: state.revision, idempotency_key: "frozen-model-pause" }, dueAt);
      state = getInvestorState(f.db, actor, dueAt);
      executeInvestorCommand(f.db, actor, { action: "save_profile", profile: { ...syntheticProfile, loss_tolerance: "0.20" },
        expected_revision: state.revision, idempotency_key: "frozen-profile-change" }, dueAt);
      const definition = JSON.parse((f.db.prepare("SELECT document_json FROM investor_models WHERE id=?").get(scope.model) as { document_json: string }).document_json);
      const checkedAt = definition.valid_until as string, before = snapshot(f), changes = f.db.prepare("SELECT total_changes() n").get();
      assert.deepEqual(readBoundPlannedFundingMonitor(f.db, actor, scope.workspace, original.request.binding, savedAt, checkedAt), original);
      assert.deepEqual(boundReplay(f, scope, original.request.binding, savedAt, checkedAt), original);
      assert.deepEqual(readBoundPlannedFundingMonitor(f.db, actor, scope.workspace, original.request.binding, dueAt, checkedAt), oldDue);
      assert.deepEqual(boundReplay(f, scope, original.request.binding, dueAt, checkedAt), oldDue);
      assert.throws(() => readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, checkedAt));
      rejectsPython(f, scope, checkedAt);
      assert.equal(original.projection.qualification, "unadmitted_planned_funding_projection");
      assert.deepEqual(snapshot(f), before); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes); noFinance(f);
    } finally { f.close(); }
  }
});

test("historical binding rejects foreign scope, every forged identity, unknown fields and impossible replay clocks", () => {
  const f = investorFixture();
  try {
    const scope = seed(f); save(f);
    const original = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, savedAt)!, binding = original.request.binding;
    const before = snapshot(f);
    const changes = [{ funding_plan_id: "missing-version" }, { funding_plan_hash: "c".repeat(64) }, { profile_hash: "c".repeat(64) },
      { model_id: "missing-model" }, { model_hash: "c".repeat(64) }, { model_created_at: savedAt }, { plan_declared_at: dueAt }, { funding_plan_version: 999 }];
    for (const change of changes) {
      const altered = { ...binding, ...change };
      assert.throws(() => readBoundPlannedFundingMonitor(f.db, actor, scope.workspace, altered, savedAt, dueAt));
      const child = boundPython(f, scope, altered); assert.notEqual(child.status, 0); assert.match(child.stderr, /INVESTOR_|SYNTHETIC_/);
    }
    for (const [evaluated, checked] of [["2026-01-03T12:15:03.999Z", dueAt], [dueAt, savedAt],
      ["2026-02-30T00:00:00.000Z", dueAt], [savedAt, "2026-01-04T00:00:00.000001Z"],
      ["2026-01-03T12:15:04.000000Z", dueAt], [savedAt, "2026-01-04T00:00:00Z"],
      [savedAt, "2026-01-04T00:00:00.000000Z"]]) {
      assert.throws(() => readBoundPlannedFundingMonitor(f.db, actor, scope.workspace, binding, evaluated, checked));
      assert.notEqual(boundPython(f, scope, binding, evaluated, checked).status, 0);
    }
    assert.throws(() => readBoundPlannedFundingMonitor(f.db, { id: "foreign-owner" }, scope.workspace, binding, savedAt, dueAt));
    assert.notEqual(boundPython(f, scope, binding, savedAt, dueAt, "foreign-owner").status, 0);
    assert.throws(() => readBoundPlannedFundingMonitor(f.db, actor, "foreign-workspace", binding, savedAt, dueAt));
    assert.deepEqual(snapshot(f), before); noFinance(f);
  } finally { f.close(); }
});

test("a plan edit on another connection cannot change a read transaction's frozen version; the next read detects it", () => {
  const f = investorFixture();
  try {
    const scope = seed(f); save(f); const other = openWorkbench(f.filename);
    try {
      const frozen = f.db.transaction(() => {
        const first = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, dueAt)!;
        const state = getInvestorState(other, actor, dueAt);
        executeInvestorCommand(other, actor, { action: "save_funding_plan", funding_plan: plan,
          expected_revision: state.revision, idempotency_key: "other-connection-plan" }, dueAt);
        assert.deepEqual(readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, dueAt), first);
        assert.deepEqual(readBoundPlannedFundingMonitor(f.db, actor, scope.workspace, first.request.binding, dueAt, dueAt), first);
        return first;
      }).deferred();
      const fresh = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, dueAt)!;
      assert.notEqual(fresh.context_hash, frozen.context_hash);
      assert.deepEqual(boundReplay(f, scope, frozen.request.binding, dueAt), frozen);
      assert.deepEqual(replay(f, scope, dueAt), fresh); noFinance(f);
    } finally { other.close(); }
  } finally { f.close(); }
});

test("historical command receipts reject extra fields and numeric substitutes for booleans even when later plans are valid", () => {
  const f = investorFixture();
  try {
    const scope = seed(f), receipt = save(f);
    const binding = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, savedAt)!.request.binding;
    save(f, "valid-later-plan", dueAt);
    const row = f.db.prepare("SELECT payload_json FROM audit_events WHERE id=?").get(receipt.audit_id) as { payload_json: string };
    const original = JSON.parse(row.payload_json) as { input: Record<string, unknown>; result: Record<string, unknown> };
    for (const { name } of f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_events' AND sql LIKE '%UPDATE%'").all() as { name: string }[]) {
      assert.match(name, /^[a-z0-9_]+$/); f.db.exec(`DROP TRIGGER ${name}`);
    }
    const variants = [{ ...original, extra: "not-closed" }, { ...original, input: { ...original.input, expected_revision: true } },
      { ...original, result: { ...original.result, actual_arrivals_confirmed: 0 } },
      { ...original, result: { ...original.result, execution_authorized: 0 } },
      { ...original, result: { ...original.result, extra: "not-closed" } }];
    for (const altered of variants) {
      f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical(altered), receipt.audit_id);
      const before = snapshot(f);
      assert.throws(() => readBoundPlannedFundingMonitor(f.db, actor, scope.workspace, binding, savedAt, dueAt));
      assert.notEqual(boundPython(f, scope, binding).status, 0);
      assert.equal(readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, dueAt)!.projection.status, "not_due");
      assert.deepEqual(snapshot(f), before); noFinance(f);
    }
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(row.payload_json, receipt.audit_id);
    assert.equal(hash(readBoundPlannedFundingMonitor(f.db, actor, scope.workspace, binding, savedAt, dueAt)), hash(boundReplay(f, scope, binding)));
  } finally { f.close(); }
});

test("a missing earlier plan breaks the frozen version prefix instead of silently rebinding to latest", () => {
  const f = investorFixture();
  try {
    const scope = seed(f), first = save(f); save(f, "prefix-plan-two", dueAt);
    const binding = readPlannedFundingMonitor(f.db, actor, scope.workspace, scope.model, dueAt)!.request.binding;
    for (const { name } of f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='investor_funding_plans' AND sql LIKE '%DELETE%'").all() as { name: string }[]) {
      assert.match(name, /^[a-z0-9_]+$/); f.db.exec(`DROP TRIGGER ${name}`);
    }
    f.db.prepare("DELETE FROM investor_funding_plans WHERE audit_id=?").run(first.audit_id);
    const before = snapshot(f);
    assert.throws(() => readBoundPlannedFundingMonitor(f.db, actor, scope.workspace, binding, dueAt, dueAt));
    assert.notEqual(boundPython(f, scope, binding, dueAt).status, 0);
    assert.deepEqual(snapshot(f), before); noFinance(f);
  } finally { f.close(); }
});
