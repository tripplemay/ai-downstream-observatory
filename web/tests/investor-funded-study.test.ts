import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { canonical, hash } from "../src/server/ledger/service";
import { fundedStudyRequestSchema, fundedStudyRunSchema } from "../src/server/investor/funded-study-schemas";
import { prepareFundedStudyInputs } from "../src/server/investor/funded-study-input";
import { readInvestorResearchSource } from "../src/server/investor/source-inputs";
import type { InvestorFundingPlan } from "../src/server/investor/funding-schemas";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { investorPollInterval } from "../src/components/workbench/research-format";
import { InvestorFundingPanel } from "../src/components/workbench/investor-funding-panel";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";

const now = "2026-01-02T12:00:04.000Z", done = "2026-01-02T12:00:05.000Z", binding = "a".repeat(64);
const plan: InvestorFundingPlan = { schema_version: "investor-funding-plan-v1", start_date: "2026-01-01", horizon_years: 1,
  evaluation_timezone: "Asia/Shanghai", initial_capital_cny: "1200", annual_contribution_cny: "300", first_annual_date: "2026-12-31",
  entry_method: "three_tranches_60_days", actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false };
function helper(f: ReturnType<typeof investorFixture>, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? process.env.WORKBENCH_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args],
    { cwd: path.resolve(".."), encoding: "utf8", timeout: 120000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }));
}
function setup(f: ReturnType<typeof investorFixture>) {
  saveSyntheticProfile(f);
  executeInvestorCommand(f.db, actor, { action: "save_funding_plan", expected_revision: 1, idempotency_key: "fictional-funding", funding_plan: plan }, now);
}
function compare(f: ReturnType<typeof investorFixture>, key = "fictional-comparison") {
  return executeInvestorCommand(f.db, actor, { action: "compare_funding", expected_revision: getInvestorState(f.db, actor, now).revision, idempotency_key: key }, now);
}
function facts(f: ReturnType<typeof investorFixture>) {
  return ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"]
    .map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

test("one-click funding comparison is private, immutable, CAS/idempotent and denies inline data or risk grants", () => {
  const f = investorFixture();
  try {
    saveSyntheticProfile(f);
    assert.throws(() => compare(f), /FUNDING_CURRENT_PLAN_REQUIRED/);
    executeInvestorCommand(f.db, actor, { action: "save_funding_plan", expected_revision: 1, idempotency_key: "fund", funding_plan: plan }, now);
    const before = getInvestorState(f.db, actor, now), finance = facts(f);
    const command = { action: "compare_funding", expected_revision: before.revision, idempotency_key: "compare" };
    for (const extra of [{ dataset: {} }, { parameters: {} }, { historical_start_date: "2024-01-01" }, { execution_authorized: true }, { loss_tolerance: "0.5" }])
      assert.throws(() => executeInvestorCommand(f.db, actor, { ...command, ...extra }, now));
    const receipt = executeInvestorCommand(f.db, actor, command, now);
    assert.deepEqual(executeInvestorCommand(f.db, actor, command, now), receipt);
    assert.throws(() => executeInvestorCommand(f.db, actor, { ...command, idempotency_key: "stale" }, now), /VERSION_CONFLICT/);
    const state = getInvestorState(f.db, actor, now);
    assert.equal(state.funded_study?.status, "queued"); assert.equal(state.funded_study?.candidate_count, 0);
    assert.equal(investorPollInterval(state), 5000); assert.equal(state.profile?.document.loss_tolerance, null);
    assert.equal(state.funded_study?.economics_independently_replayed, false);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
    assert.equal(getInvestorState(f.db, { id: "other-owner" }, now).funded_study, null);
    for (const table of ["investor_funded_study_requests"]) for (const sql of [`UPDATE ${table} SET created_at=created_at`, `DELETE FROM ${table}`, `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`])
      assert.throws(() => f.db.exec(sql));
    assert.deepEqual([state.latest, state.plan, state.model_watch], [before.latest, before.plan, before.model_watch]);
    assert.deepEqual(facts(f), finance);
    helper(f, "tests.investor.funded_study_fixture");
    const finished = getInvestorState(f.db, actor, done);
    assert.equal(finished.funded_study?.status, "blocked"); assert.deepEqual(finished.funded_study?.reason_codes, ["FUNDED_STUDY_REVIEWED_SOURCE_REQUIRED"]);
    assert.deepEqual(facts(f), finance); assert.deepEqual(parseInvestorState({ ...finished, session_binding: binding }, binding), finished);
  } finally { f.close(); }
});
test("reviewed short data cannot replace the complete funding horizon or borrow old policy", () => {
  const f = investorFixture();
  try {
    setup(f); helper(f, "tests.investor.evidence_fixture", ["--fixed-policy-v2", "--funded-calendar"]); compare(f);
    helper(f, "tests.investor.funded_study_fixture");
    const state = getInvestorState(f.db, actor, done);
    assert.equal(state.funded_study?.status, "blocked");
    assert.deepEqual(state.funded_study?.reason_codes, ["FUNDED_STUDY_FULL_HORIZON_NOT_COVERED"]);
    assert.equal(state.funded_study?.historical_start_date, null); assert.equal(state.funded_study?.candidate_count, 0);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
  } finally { f.close(); }
});
test("fictional year-long receipts bind all candidates to the real registration clock; computed digests never publish economics", () => {
  const f = investorFixture();
  try {
    setup(f); helper(f, "tests.investor.evidence_fixture", ["--fixed-policy-v2", "--funded-year"]); const receipt = compare(f);
    const row = f.db.prepare("SELECT * FROM investor_funded_study_requests WHERE id=?").get(receipt.resource_id) as { document_json: string; input_version: string; evidence_input_id: string };
    const registered = fundedStudyRequestSchema.parse(JSON.parse(row.document_json));
    assert.equal(registered.comparison_declared_at, now); assert.equal(registered.historical_start_date, "2024-01-01", JSON.stringify(registered.reason_codes)); assert.equal(registered.candidate_hashes.length, 3);
    assert.deepEqual(registered.reason_codes, []); assert.equal(hash(registered), row.input_version);
    const source = readInvestorResearchSource(f.db, registered.workspace_id, { input_id: null, evidence_input_id: row.evidence_input_id }, now)!;
    assert.ok(source.document && source.payload);
    const studySource = { created_at: source.row.created_at, range_start: "2024-01-01", range_end: "2024-12-31", payload: source.payload };
    const prepared = prepareFundedStudyInputs(plan, studySource, now, syntheticProfile);
    assert.deepEqual(prepared.candidate_hashes, registered.candidate_hashes);
    for (const [change, expected] of [
      [{ liquidity_need: "uncertain" }, "FUNDED_STUDY_LIQUIDITY_REVIEW_REQUIRED"],
      [{ exclusions: ["Fictional exclusion"] }, "FUNDED_STUDY_EXCLUSIONS_REQUIRE_QUALIFIED_UNIVERSE"],
      [{ markets: ["HK"] }, "FUNDED_STUDY_UNIVERSE_OUTSIDE_ALLOWED_MARKETS"],
      [{ horizon_years: 1 }, "FUNDED_STUDY_HORIZON_OUTSIDE_STRATEGY_SCOPE"],
      [{ research_direction: "rotation" }, "FUNDED_STUDY_ENHANCEMENT_EVIDENCE_REQUIRED"],
    ] as const) assert.deepEqual(prepareFundedStudyInputs(plan, studySource, now, { ...syntheticProfile, ...change } as typeof syntheticProfile).reason_codes, [expected]);
    const finance = facts(f); helper(f, "tests.investor.funded_study_fixture");
    const state = getInvestorState(f.db, actor, done); assert.equal(state.funded_study?.status, "calculated_unverified");
    const run = fundedStudyRunSchema.parse(JSON.parse((f.db.prepare("SELECT document_json FROM investor_funded_study_runs").get() as { document_json: string }).document_json));
    assert.equal(run.candidates.length, 3); assert.ok(run.candidates.every(value => value.result_hash !== null));
    assert.equal("ending_nav_cny" in run, false); assert.equal("profit_cny" in run, false);
    assert.equal(state.plan, null); assert.equal(state.profile?.document.loss_tolerance, null); assert.equal(state.model_watch, null);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state); assert.deepEqual(facts(f), finance);
    const markup = renderToStaticMarkup(createElement(InvestorFundingPanel, { state: state.funding, profile: state.profile!, study: state.funded_study, disabled: false, onCommand() {}, onEditingChange() {} }));
    assert.match(markup, /等待独立经济核验/); assert.match(markup, /不写入账户现金或真实持仓/); assert.doesNotMatch(markup, /年化收益|预计收益|收益排名/);
    for (const change of [(s: typeof state) => { s.funded_study!.economics_independently_replayed = true as never; },
      (s: typeof state) => { s.funded_study!.funding_plan_id = "different-plan"; }, (s: typeof state) => { s.funded_study!.created_at = "2027-01-01T00:00:00.000Z"; }]) {
      const altered = structuredClone(state); change(altered); assert.throws(() => parseInvestorState({ ...altered, session_binding: binding }, binding), /RESPONSE_INVALID/);
    }
    const expired = getInvestorState(f.db, actor, "2026-02-03T00:00:00.000Z"); assert.equal(expired.funded_study?.status, "outdated");
    assert.deepEqual(parseInvestorState({ ...expired, session_binding: binding }, binding), expired);
    for (const sql of ["UPDATE investor_funded_study_runs SET status=status", "DELETE FROM investor_funded_study_runs", "INSERT OR REPLACE INTO investor_funded_study_runs SELECT * FROM investor_funded_study_runs"])
      assert.throws(() => f.db.exec(sql));
  } finally { f.close(); }
});
test("changed preferences invalidate a comparison and require re-reviewed funding; restore mode stays readable", () => {
  const f = investorFixture();
  try {
    setup(f); compare(f);
    executeInvestorCommand(f.db, actor, { action: "save_profile", expected_revision: 3, idempotency_key: "profile-change", profile: { ...syntheticProfile, horizon_years: 10 } }, now);
    const state = getInvestorState(f.db, actor, now); assert.equal(state.funded_study?.status, "outdated");
    assert.throws(() => compare(f, "changed-plan"), /FUNDING_CURRENT_PLAN_REQUIRED/);
    helper(f, "tests.investor.funded_study_fixture");
    assert.equal((f.db.prepare("SELECT status FROM job_runs WHERE job_type='investor_funded_study'").get() as { status: string }).status, "skipped");
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_funded_study_runs").get() as { n: number }).n, 0);
    writeFileSync(path.join(f.directory, "RESTORE_PENDING_REVIEW"), "FICTIONAL COMPARISON RESTORE LOCK\n");
    assert.equal(getInvestorState(f.db, actor, done).read_only, true);
    assert.throws(() => compare(f, "read-only"), /WORKBENCH_READ_ONLY/);
  } finally { f.close(); }
});
test("a failed candidate remains registered beside completed candidates rather than disappearing from the study", () => {
  const f = investorFixture();
  try {
    setup(f); helper(f, "tests.investor.evidence_fixture", ["--fixed-policy-v2", "--funded-year"]); compare(f);
    helper(f, "tests.investor.funded_study_fixture", ["--fail-first-candidate"]);
    const state = getInvestorState(f.db, actor, done); assert.equal(state.funded_study?.status, "failed");
    const run = fundedStudyRunSchema.parse(JSON.parse((f.db.prepare("SELECT document_json FROM investor_funded_study_runs").get() as { document_json: string }).document_json));
    assert.deepEqual(run.candidates.map(row => row.status), ["failed", "calculated_unverified", "calculated_unverified"]);
    assert.equal(run.candidates[0].result_hash, null); assert.equal(run.candidates[0].reason_code, "FUNDED_STUDY_CANDIDATE_FAILED");
    assert.equal(state.profile?.document.loss_tolerance, null); assert.equal(state.plan, null);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: binding }, binding), state);
  } finally { f.close(); }
});
test("corrupt comparison evidence is isolated and cannot be overwritten by a new request", () => {
  const f = investorFixture();
  try {
    setup(f); const receipt = compare(f);
    const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='audit_events' AND sql LIKE '%UPDATE%'").all() as { name: string }[];
    for (const row of triggers) f.db.exec(`DROP TRIGGER ${row.name}`);
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ input: {}, result: {} }), receipt.audit_id);
    const state = getInvestorState(f.db, actor, now); assert.equal(state.funded_study, null); assert.equal(state.funded_study_unavailable, true); assert.ok(state.profile);
    assert.throws(() => compare(f, "overwrite"), /FUNDED_STUDY_EVIDENCE_INVALID/);
    assert.equal(getInvestorState(f.db, actor, now).revision, 3);
  } finally { f.close(); }
});
