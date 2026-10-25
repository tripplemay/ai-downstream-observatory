import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFundedComparison } from "../src/server/investor/funded-comparison";
import { assertFundedComparisonBuild, fundedComparisonSourceFiles, withFundedComparisonCapacity } from "../src/server/investor/funded-comparison-process";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { parseFundedComparison } from "../src/components/workbench/investor-funded-comparison-client";
import { FundedComparisonResults } from "../src/components/workbench/investor-funded-comparison-panel";
import { investorActor as actor, investorFixture, saveSyntheticProfile } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { getFundedPathAnalysis } from "../src/server/investor/funded-analysis";
import { parseFundedAnalysis } from "../src/components/workbench/investor-funded-analysis-client";
import { FundedAnalysisResults } from "../src/components/workbench/investor-funded-analysis-panel";

const registered = "2026-01-02T12:00:04.000Z", done = "2026-01-02T12:00:05.000Z", expired = "2026-02-03T00:00:00.000Z", binding = "a".repeat(64);
function helper(f: ReturnType<typeof investorFixture>, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args],
    { cwd: path.resolve(".."), encoding: "utf8", timeout: 120000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] }));
}
function setup(f: ReturnType<typeof investorFixture>, failure = false, bounded = false, eventReview = false, settled = false, orphan = false) {
  saveSyntheticProfile(f);
  executeInvestorCommand(f.db, actor, { action: "save_funding_plan", expected_revision: 1, idempotency_key: "fictional-funding",
    funding_plan: { schema_version: "investor-funding-plan-v1", start_date: "2026-01-01", horizon_years: 1, evaluation_timezone: "Asia/Shanghai",
      initial_capital_cny: "1200", annual_contribution_cny: "300", first_annual_date: "2026-12-31", entry_method: "three_tranches_60_days",
      actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false } }, registered);
  helper(f, "tests.investor.evidence_fixture", ["--fixed-policy-v2", "--funded-year", ...(bounded ? ["--bounded-execution-v3"] : []), ...(eventReview ? ["--event-review-execution-v5"] : []), ...(settled ? ["--settled-intent-execution-v6"] : []), ...(orphan ? ["--funded-settled-orphan"] : [])]);
  executeInvestorCommand(f.db, actor, { action: "compare_funding", expected_revision: getInvestorState(f.db, actor, registered).revision, idempotency_key: "fictional-study" }, registered);
  helper(f, "tests.investor.funded_study_fixture", [...(failure ? ["--fail-first-candidate"] : []), ...(bounded || eventReview || settled ? ["--default-core"] : [])]);
}
function count(f: ReturnType<typeof investorFixture>, table: string) { return (f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n; }
function changes(f: ReturnType<typeof investorFixture>) { return (f.db.prepare("SELECT total_changes() n").get() as { n: number }).n; }

test("v6 source keeps cash intents through normal annual producer, durable payloads, cold replay, strict clients and holding analysis", async () => {
  const f = investorFixture();
  try {
    setup(f, false, false, false, true);
    const rows = f.db.prepare("SELECT payload FROM investor_funded_result_payloads").all() as { payload: Buffer }[];
    assert.equal(rows.length, 3);
    for (const row of rows) {
      const result = JSON.parse(row.payload.toString("utf8"));
      assert.equal(result.schema_version, "investor-funded-history-result-v4");
      assert.equal(result.comparison.schema_version, "investor-long-horizon-result-v5");
      assert.equal(result.comparison.runs.immediate.engine_version, "continuous-settled-intent-funding-v1");
    }
    const before = changes(f), state = getInvestorState(f.db, actor, done), report = await getFundedComparison(f.db, actor, { clock: () => done });
    assert.equal(report.status, "verified_retrospective");
    assert.deepEqual(parseFundedComparison({ ...report, session_binding: binding }, state, binding, Date.parse(done)), report);
    for (const candidate of report.candidates) for (const p of Object.values(candidate.paths!)) {
      assert.equal(p.execution_review?.schema_version, "execution-review-summary-v2");
      assert.equal(p.cash_intent_review?.pending_intents, 0); assert.equal(p.cash_intent_review?.failed_intents, 0);
    }
    const selector = { parameters_hash: report.candidates[0].parameters_hash, path: "staged" as const };
    const analysis = await getFundedPathAnalysis(f.db, actor, selector, { clock: () => done });
    assert.equal(analysis.status, "verified_retrospective");
    assert.equal(analysis.analysis?.baseline.summary.cash_intent_review?.failed_intents, 0);
    assert.deepEqual(await parseFundedAnalysis({ ...analysis, session_binding: binding }, report, binding, selector.parameters_hash, selector.path, Date.parse(done)), analysis);
    const hidden = structuredClone(report); delete hidden.candidates[0].paths!.immediate.cash_intent_review;
    assert.throws(() => parseFundedComparison({ ...hidden, session_binding: binding }, state, binding, Date.parse(done)), /RESPONSE_INVALID/);
    const gaps = structuredClone(report); gaps.candidates[0].paths!.immediate.cash_intent_review!.failed_intents++;
    assert.throws(() => parseFundedComparison({ ...gaps, session_binding: binding }, state, binding, Date.parse(done)), /RESPONSE_INVALID/);
    const unfinishedBaseline = structuredClone(analysis); unfinishedBaseline.analysis!.baseline.summary.cash_intent_review!.pending_intents++;
    await assert.rejects(parseFundedAnalysis({ ...unfinishedBaseline, session_binding: binding }, report, binding, selector.parameters_hash, selector.path, Date.parse(done)), /RESPONSE_INVALID/);
    const markup = renderToStaticMarkup(createElement(FundedComparisonResults, { value: report }));
    assert.match(markup, /失败交收后买入意图/); assert.match(markup, /不是真实委托/);
    assert.equal(changes(f), before);
    for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal(count(f, table), 0, table);
  } finally { f.close(); }
});

test("annual orphan stays visible and incomplete through default core and service read models despite zero order errors", async () => {
  const f = investorFixture();
  try {
    setup(f, false, false, false, true, true);
    assert.equal(count(f, "investor_funded_result_payloads"), 3);
    const before = changes(f), state = getInvestorState(f.db, actor, done), report = await getFundedComparison(f.db, actor, { clock: () => done });
    assert.equal(report.status, "partial"); assert.equal(report.economics_independently_replayed, false);
    assert.equal(report.candidates.length, 3);
    assert.deepEqual(parseFundedComparison({ ...report, session_binding: binding }, state, binding, Date.parse(done)), report);
    for (const candidate of report.candidates) {
      assert.equal(candidate.status, "verified_with_execution_gaps");
      assert.equal(candidate.paths?.immediate.execution_failure_count, 0);
      assert.equal(candidate.paths?.immediate.cash_intent_review?.failed_intents, 1);
    }
    const selector = { parameters_hash: report.candidates[0].parameters_hash, path: "immediate" as const };
    const analysis = await getFundedPathAnalysis(f.db, actor, selector, { clock: () => done });
    assert.equal(analysis.status, "verified_with_execution_gaps"); assert.equal(analysis.economics_independently_replayed, false);
    assert.deepEqual(await parseFundedAnalysis({ ...analysis, session_binding: binding }, report, binding, selector.parameters_hash, selector.path, Date.parse(done)), analysis);
    assert.equal(analysis.analysis?.baseline.summary.cash_intent_review?.failed_intents, 0);
    assert.match(renderToStaticMarkup(createElement(FundedComparisonResults, { value: report })), /失败交收后买入意图/);
    assert.equal(changes(f), before);
    for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal(count(f, table), 0, table);
  } finally { f.close(); }
});

test("v5 admitted source keeps event-review policy through durable funding study, cold replay and path analysis", async () => {
  const f = investorFixture();
  try {
    setup(f, false, false, true);
    const rows = f.db.prepare("SELECT payload FROM investor_funded_result_payloads").all() as { payload: Buffer }[];
    assert.equal(rows.length, 3);
    for (const row of rows) {
      const result = JSON.parse(row.payload.toString("utf8"));
      assert.equal(result.schema_version, "investor-funded-history-result-v3");
      assert.equal(result.comparison.schema_version, "investor-long-horizon-result-v4");
      assert.equal(result.comparison.runs.immediate.engine_version, "continuous-event-review-funding-v1");
      assert(result.comparison.runs.immediate.corporate_action_cancellation_count > 0);
    }
    const before = changes(f), state = getInvestorState(f.db, actor, done);
    const report = await getFundedComparison(f.db, actor, { clock: () => done });
    assert.equal(report.status, "verified_retrospective"); assert.equal(report.candidates.length, 3);
    assert.deepEqual(parseFundedComparison({ ...report, session_binding: binding }, state, binding, Date.parse(done)), report);
    for (const candidate of report.candidates) {
      const p = candidate.paths!.immediate;
      assert(p.execution_failure_count > 0); assert(p.execution_review);
      assert.equal(p.execution_review.terminal_failure_count, 0);
      assert.equal(p.execution_review.resolved_cancellations, p.execution_review.cancellations);
      assert.equal(p.execution_review.unresolved_reviews, 0);
    }
    const selector = { parameters_hash: report.candidates[0].parameters_hash, path: "immediate" as const };
    const analysis = await getFundedPathAnalysis(f.db, actor, selector, { clock: () => done });
    assert.equal(analysis.status, "verified_retrospective");
    assert(analysis.analysis?.baseline.summary.execution_review);
    assert.deepEqual(await parseFundedAnalysis({ ...analysis, session_binding: binding }, report, binding, selector.parameters_hash, selector.path, Date.parse(done)), analysis);
    const unresolved = structuredClone(analysis);
    unresolved.analysis!.baseline.summary.execution_review!.unresolved_reviews++;
    await assert.rejects(parseFundedAnalysis({ ...unresolved, session_binding: binding }, report, binding, selector.parameters_hash, selector.path, Date.parse(done)), /RESPONSE_INVALID/);
    const hidden = structuredClone(analysis);
    delete hidden.analysis!.candidate.summary.execution_review;
    await assert.rejects(parseFundedAnalysis({ ...hidden, session_binding: binding }, report, binding, selector.parameters_hash, selector.path, Date.parse(done)), /RESPONSE_INVALID/);
    const markup = renderToStaticMarkup(createElement(FundedComparisonResults, { value: report }));
    assert.match(markup, /原始撤单/); assert.match(markup, /未解决执行缺口/); assert.match(markup, /未完成复核/);
    assert.equal(changes(f), before);
    for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal(count(f, table), 0, table);
  } finally { f.close(); }
});

test("bounded source reaches existing durable funding study, cold independent replay and analysis without financial writes", async () => {
  const f = investorFixture();
  try {
    setup(f, false, true);
    const rows = f.db.prepare("SELECT payload FROM investor_funded_result_payloads").all() as { payload: Buffer }[];
    assert.equal(rows.length, 3);
    for (const row of rows) {
      const result = JSON.parse(row.payload.toString("utf8"));
      assert.equal(result.schema_version, "investor-funded-history-result-v2");
      assert.equal(result.comparison.schema_version, "investor-long-horizon-result-v3");
      assert.equal(result.comparison.runs.immediate.engine_version, "continuous-bounded-fixed-policy-funding-v1");
    }
    const before = changes(f), state = getInvestorState(f.db, actor, done);
    const report = await getFundedComparison(f.db, actor, { clock: () => done });
    assert.equal(report.status, "verified_retrospective"); assert.equal(report.candidates.length, 3);
    assert.deepEqual(parseFundedComparison({ ...report, session_binding: binding }, state, binding, Date.parse(done)), report);
    const selector = { parameters_hash: report.candidates[0].parameters_hash, path: "staged" as const };
    const analysis = await getFundedPathAnalysis(f.db, actor, selector, { clock: () => done });
    assert.equal(analysis.status, "verified_retrospective"); assert.equal(analysis.analysis?.candidate.summary.principal_cny, "1500");
    assert.deepEqual(await parseFundedAnalysis({ ...analysis, session_binding: binding }, report, binding, selector.parameters_hash, selector.path, Date.parse(done)), analysis);
    assert.equal(changes(f), before); assert.equal(state.plan, null); assert.equal(state.profile?.document.loss_tolerance, null);
    for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal(count(f, table), 0, table);
    const other = await getFundedComparison(f.db, { id: "other-owner" }, { clock: () => done }); assert.equal(other.status, "not_started");
    const old = await getFundedComparison(f.db, actor, { clock: () => expired }); assert.equal(old.status, "outdated"); assert.equal(old.candidates.length, 0);
  } finally { f.close(); }
});

test("private persisted comparison independently replays all candidates, remains read-only and never selects personal risk or weights", async () => {
  const f = investorFixture();
  try {
    setup(f); assert.equal(count(f, "investor_funded_result_headers"), 3); assert.equal(count(f, "investor_funded_result_payloads"), 3);
    const state = getInvestorState(f.db, actor, done), before = changes(f), report = await getFundedComparison(f.db, actor, { clock: () => done });
    assert.equal(report.status, "verified_retrospective"); assert.equal(report.economics_independently_replayed, true);
    assert.equal(report.candidates.length, 3); assert.equal(report.execution_authorized, false); assert.equal(report.publication_eligible, false);
    assert.equal(report.source_independently_verified, false); assert.equal(report.parameters_independently_preregistered, false);
    for (const candidate of report.candidates) {
      assert.equal(candidate.paths?.immediate.principal_cny, "1500"); assert.equal(candidate.paths?.staged.principal_cny, "1500");
      assert.equal(candidate.allocation.length, 2); assert.equal(candidate.status, "verified_retrospective");
      assert.ok(candidate.economics_hash); assert.ok(candidate.result_hash);
    }
    assert.equal(changes(f), before); assert.equal(count(f, "ledger_events"), 0); assert.equal(count(f, "portfolios"), 0);
    assert.equal(getInvestorState(f.db, actor, done).profile?.document.loss_tolerance, null);
    assert.equal(getInvestorState(f.db, actor, done).funded_study?.economics_independently_replayed, false);
    assert.deepEqual(parseFundedComparison({ ...report, session_binding: binding }, state, binding, Date.parse(done)), report);
    for (const change of [{ execution_authorized: true }, { live_advice_eligible: true }, { publication_eligible: true }, { source_independently_verified: true },
      { workspace_revision: state.revision + 1 }, { request_id: "other-request" }, { profile_id: "other-profile" }, { session_binding: "b".repeat(64) }, { unexpected: {} }])
      assert.throws(() => parseFundedComparison({ ...report, session_binding: binding, ...change }, state, binding, Date.parse(done)), /RESPONSE_INVALID/);
    const markup = renderToStaticMarkup(createElement(FundedComparisonResults, { value: report }));
    assert.match(markup, /假设累计本金/); assert.match(markup, /扣已识别成本后的盈亏/); assert.match(markup, /最大回撤/);
    assert.match(markup, /不是收益排名/); assert.match(markup, /风险预算未确认/); assert.doesNotMatch(markup, /买入按钮|保证盈利|最佳组合/);
    for (const sql of ["UPDATE investor_funded_result_headers SET valid_until=valid_until", "DELETE FROM investor_funded_result_headers",
      "INSERT OR REPLACE INTO investor_funded_result_headers SELECT * FROM investor_funded_result_headers",
      "UPDATE investor_funded_result_payloads SET payload=payload", "DELETE FROM investor_funded_result_payloads",
      "INSERT OR REPLACE INTO investor_funded_result_payloads SELECT * FROM investor_funded_result_payloads"])
      assert.throws(() => f.db.exec(sql));
    assert.equal((await getFundedComparison(f.db, { id: "other-owner" }, { clock: () => done })).status, "not_started");
  } finally { f.close(); }
});
test("failed candidates stay beside independently replayed peers without survivor-only comparison", async () => {
  const f = investorFixture();
  try {
    setup(f, true); const report = await getFundedComparison(f.db, actor, { clock: () => done });
    assert.equal(report.status, "partial"); assert.equal(report.economics_independently_replayed, false);
    assert.deepEqual(report.candidates.map(row => row.status), ["failed", "verified_retrospective", "verified_retrospective"]);
    assert.equal(report.candidates[0].paths, null); assert.equal(count(f, "investor_funded_result_payloads"), 2);
    const failed = await getFundedPathAnalysis(f.db, actor, { parameters_hash: report.candidates[0].parameters_hash, path: "immediate" }, { clock: () => done });
    assert.equal(failed.status, "unavailable"); assert.equal(failed.analysis, null);
  } finally { f.close(); }
});
test("expired or withdrawn sources hide economics; core cleanup is scoped, audited and idempotent", async () => {
  const f = investorFixture();
  try {
    setup(f); assert.throws(() => helper(f, "tests.investor.funded_study_fixture", ["--purge-first"]), /PURGE_NOT_DUE/);
    assert.throws(() => helper(f, "tests.investor.funded_study_fixture", ["--purge-first", "--actor", "different-owner", "--now", expired]), /OUT_OF_SCOPE/);
    const before = changes(f), report = await getFundedComparison(f.db, actor, { clock: () => expired });
    assert.equal(report.status, "outdated"); assert.equal(report.candidates.length, 0); assert.equal(changes(f), before);
    assert.equal(count(f, "investor_funded_result_payloads"), 3);
    const marker = path.join(f.directory, "RESTORE_PENDING_REVIEW"); writeFileSync(marker, "FICTIONAL RESTORE LOCK\n");
    assert.throws(() => helper(f, "tests.investor.funded_study_fixture", ["--purge-due", "--now", expired]), /RESTORE_PENDING_REVIEW/);
    const { unlinkSync } = await import("node:fs"); unlinkSync(marker);
    assert.equal(helper(f, "tests.investor.funded_study_fixture", ["--purge-due", "--now", expired]).purge_count, 3);
    assert.equal(helper(f, "tests.investor.funded_study_fixture", ["--purge-due", "--now", expired]).purge_count, 0);
    assert.equal(count(f, "investor_funded_result_payloads"), 0); assert.equal(count(f, "investor_funded_result_headers"), 3); assert.equal(count(f, "investor_funded_result_purges"), 3);
    assert.equal(count(f, "ledger_events"), 0);
    for (const sql of ["UPDATE investor_funded_result_purges SET reason=reason", "DELETE FROM investor_funded_result_purges"]) assert.throws(() => f.db.exec(sql));
  } finally { f.close(); }
  const g = investorFixture();
  try {
    setup(g); helper(g, "tests.investor.funded_study_fixture", ["--withdraw-first-source"]);
    assert.equal((await getFundedComparison(g.db, actor, { clock: () => done })).status, "outdated");
    assert.equal(helper(g, "tests.investor.funded_study_fixture", ["--purge-due"]).purge_count, 3);
    assert.equal(count(g, "investor_funded_result_payloads"), 0);
    assert.deepEqual(g.db.prepare("SELECT DISTINCT reason FROM investor_funded_result_purges").all(), [{ reason: "source_unavailable" }]);
  } finally { g.close(); }
});
test("source expiry during asynchronous replay rejects all economic output instead of returning an old certificate", async () => {
  const f = investorFixture();
  try {
    setup(f); let calls = 0;
    const report = await getFundedComparison(f.db, actor, { clock: () => calls++ === 0 ? done : expired });
    assert.equal(report.status, "outdated"); assert.equal(report.candidates.length, 0); assert.equal(report.economics_independently_replayed, false);
    const current = await getFundedComparison(f.db, actor, { clock: () => done }); calls = 0;
    const analysis = await getFundedPathAnalysis(f.db, actor, { parameters_hash: current.candidates[0].parameters_hash, path: "immediate" },
      { clock: () => calls++ === 0 ? done : expired });
    assert.equal(analysis.status, "outdated"); assert.equal(analysis.analysis, null); assert.equal(analysis.economics_independently_replayed, false);
  } finally { f.close(); }
});
test("self-sealed forged economic payload is not trusted; missing legacy bytes are explicit rather than fabricated", async () => {
  const f = investorFixture();
  try {
    setup(f);
    const triggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='investor_funded_result_payloads'").all() as { name: string }[];
    for (const trigger of triggers) f.db.exec(`DROP TRIGGER ${trigger.name}`);
    const row = f.db.prepare("SELECT * FROM investor_funded_result_payloads ORDER BY parameters_hash LIMIT 1").get() as { run_id: string; parameters_hash: string; payload: Buffer };
    const forged = JSON.parse(row.payload.toString("utf8")); forged.comparison.runs.immediate.profit_cny = "99999999";
    const { result_hash: ignoredComparisonHash, ...comparisonBody } = forged.comparison; void ignoredComparisonHash;
    forged.comparison.result_hash = hash(comparisonBody);
    const { result_hash: ignoredRootHash, ...rootBody } = forged; void ignoredRootHash; forged.result_hash = hash(rootBody);
    const metadataTriggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('investor_funded_result_headers','investor_funded_study_runs')").all() as { name: string }[];
    for (const trigger of metadataTriggers) f.db.exec(`DROP TRIGGER ${trigger.name}`);
    f.db.prepare("UPDATE investor_funded_result_headers SET result_hash=? WHERE run_id=? AND parameters_hash=?").run(forged.result_hash, row.run_id, row.parameters_hash);
    const run = JSON.parse((f.db.prepare("SELECT document_json FROM investor_funded_study_runs WHERE id=?").get(row.run_id) as { document_json: string }).document_json);
    run.candidates.find((candidate: { parameters_hash: string }) => candidate.parameters_hash === row.parameters_hash).result_hash = forged.result_hash;
    f.db.prepare("UPDATE investor_funded_study_runs SET document_json=?,content_hash=? WHERE id=?").run(canonical(run), hash(run), row.run_id);
    f.db.prepare("UPDATE investor_funded_result_payloads SET payload=? WHERE run_id=? AND parameters_hash=?").run(Buffer.from(canonical(forged)), row.run_id, row.parameters_hash);
    const report = await getFundedComparison(f.db, actor, { clock: () => done });
    assert.equal(report.status, "partial"); assert.equal(report.candidates[0].paths, null); assert.equal(report.candidates[0].reason_code, "FUNDED_COMPARISON_REPLAY_FAILED");
    await assert.rejects(getFundedPathAnalysis(f.db, actor, { parameters_hash: row.parameters_hash, path: "immediate" }, { clock: () => done }), /REPLAY_FAILED/);
    const headerTriggers = f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='investor_funded_result_headers'").all() as { name: string }[];
    for (const trigger of headerTriggers) f.db.exec(`DROP TRIGGER ${trigger.name}`);
    f.db.exec("DELETE FROM investor_funded_result_payloads; DELETE FROM investor_funded_result_headers");
    const legacy = await getFundedComparison(f.db, actor, { clock: () => done });
    assert.ok(legacy.candidates.every(row => row.reason_code === "FUNDED_COMPARISON_LEGACY_DIGEST_ONLY" && row.paths === null));
  } finally { f.close(); }
});
test("fixed worker source inventory matches build tooling; per-process capacity rejects overlap and releases after errors", async () => {
  const built = JSON.parse(readFileSync(path.resolve("dist/funded-comparison.manifest.json"), "utf8"));
  assert.deepEqual(fundedComparisonSourceFiles(), built.source_files); assert.match(assertFundedComparisonBuild(), /^[a-f0-9]{64}$/);
  let release!: () => void;
  const first = withFundedComparisonCapacity("fictional-one", () => new Promise<void>(resolve => { release = resolve; }));
  await assert.rejects(withFundedComparisonCapacity("fictional-one", async () => null), /BUSY/);
  const second = withFundedComparisonCapacity("fictional-two", async () => { await assert.rejects(withFundedComparisonCapacity("fictional-three", async () => null), /BUSY/); });
  await second; release(); await first;
  await assert.rejects(withFundedComparisonCapacity("fictional-one", async () => { throw new Error("fictional failure"); }), /fictional failure/);
  assert.equal(await withFundedComparisonCapacity("fictional-one", async () => 1), 1);
});
test("selected funded curve is owner-scoped, read-only and bound to the independently replayed summary, not a recommended strategy", async () => {
  const f = investorFixture();
  try {
    setup(f); const comparison = await getFundedComparison(f.db, actor, { clock: () => done });
    const parameters = comparison.candidates[0].parameters_hash, before = changes(f);
    const report = await getFundedPathAnalysis(f.db, actor, { parameters_hash: parameters, path: "staged" }, { clock: () => done });
    assert.equal(report.status, "verified_retrospective"); assert.equal(report.analysis?.baseline_preregistered, false);
    assert.equal(report.source_independently_verified, false); assert.equal(report.publication_eligible, false); assert.equal(report.live_advice_eligible, false);
    assert.equal(report.analysis!.candidate.summary.principal_cny, "1500"); assert.equal(report.analysis!.baseline.summary.principal_cny, "1500");
    assert.deepEqual(report.analysis!.candidate.summary, comparison.candidates[0].paths!.staged);
    assert.equal(changes(f), before); assert.equal(count(f, "ledger_events"), 0); assert.equal(count(f, "portfolios"), 0);
    assert.equal(getInvestorState(f.db, actor, done).profile?.document.loss_tolerance, null);
    assert.deepEqual(await parseFundedAnalysis({ ...report, session_binding: binding }, comparison, binding, parameters, "staged", Date.parse(done)), report);
    assert.equal((await getFundedPathAnalysis(f.db, { id: "other-owner" }, { parameters_hash: parameters, path: "staged" }, { clock: () => done })).analysis, null);
    assert.equal((await getFundedPathAnalysis(f.db, actor, { parameters_hash: "f".repeat(64), path: "staged" }, { clock: () => done })).status, "unavailable");
    const abort = new AbortController(); abort.abort();
    await assert.rejects(getFundedPathAnalysis(f.db, actor, { parameters_hash: parameters, path: "staged" }, { clock: () => done, signal: abort.signal }), /ABORTED/);
    const markup = renderToStaticMarkup(createElement(FundedAnalysisResults, { data: report.analysis! }));
    assert.match(markup, /累计本金/); assert.match(markup, /待释放现金/); assert.match(markup, /不是未来亏损概率/); assert.match(markup, /谷底恢复至原峰值/);
    assert.doesNotMatch(markup, /最佳组合|自动交易|保证盈利/);
  } finally { f.close(); }
});
test("funded curve client rejects stale scope and resealed inconsistent money, monthly windows and risk diagnostics", async () => {
  const f = investorFixture();
  try {
    setup(f); const comparison = await getFundedComparison(f.db, actor, { clock: () => done }), parameters = comparison.candidates[0].parameters_hash;
    const report = await getFundedPathAnalysis(f.db, actor, { parameters_hash: parameters, path: "immediate" }, { clock: () => done });
    const mutations = [
      (value: typeof report & { session_binding: string }) => { value.session_binding = "b".repeat(64); },
      (value: typeof report) => { value.workspace_revision++; },
      (value: typeof report) => { value.parameters_hash = "f".repeat(64); },
      (value: typeof report) => { value.path = "staged"; },
      (value: typeof report) => { value.valid_until = expired; },
      (value: typeof report) => { value.analysis!.candidate.daily[0].profit_cny = "999"; value.analysis!.candidate.daily_curve_hash = hash(value.analysis!.candidate.daily); },
      (value: typeof report) => { value.analysis!.candidate.daily[0].local_date = "2015-01-02"; value.analysis!.candidate.daily_curve_hash = hash(value.analysis!.candidate.daily); },
      (value: typeof report) => { value.analysis!.candidate.monthly[0].nav_cny = "999"; },
      (value: typeof report) => { value.analysis!.candidate.rolling[0].window_count = 1; },
      (value: typeof report) => { value.analysis!.comparison.ending_nav_difference_cny = "123"; },
      (value: typeof report) => { value.analysis!.baseline.summary.principal_cny = "999"; },
      (value: typeof report) => { value.analysis!.candidate.risk.max_drawdown = "-0.5"; },
      (value: typeof report) => { value.analysis!.candidate.risk.recovery_days = 1; },
    ];
    for (const mutate of mutations) {
      const changed = { ...structuredClone(report), session_binding: binding }; mutate(changed);
      await assert.rejects(parseFundedAnalysis(changed, comparison, binding, parameters, "immediate", Date.parse(done)));
    }
    for (const field of ["execution_authorized", "source_independently_verified", "publication_eligible", "live_advice_eligible"])
      await assert.rejects(parseFundedAnalysis({ ...report, session_binding: binding, [field]: true }, comparison, binding, parameters, "immediate", Date.parse(done)));
    await assert.rejects(parseFundedAnalysis({ ...report, session_binding: binding }, comparison, binding, parameters, "immediate", Date.parse(expired)));
    helper(f, "tests.investor.funded_study_fixture", ["--withdraw-first-source"]);
    const stale = await getFundedPathAnalysis(f.db, actor, { parameters_hash: parameters, path: "immediate" }, { clock: () => done });
    assert.equal(stale.status, "outdated"); assert.equal(stale.analysis, null);
  } finally { f.close(); }
});
