import assert from "node:assert/strict";
import test from "node:test";
import { currentResearchDisplay, researchTaskStatus } from "../src/components/workbench/research-format";
import { researchTaskSchema, type InvestorResearchTask } from "../src/server/investor/schemas";

function task(): InvestorResearchTask {
  return researchTaskSchema.parse({
    id: "fictional-status-task", profile_id: "fictional-profile", profile_version: 1, input_version: "a".repeat(64),
    engine_version: "investor-diversified-reference-v1", status: "calculated",
    created_at: "2026-01-02T12:00:01.000Z", completed_at: "2026-01-02T12:00:02.000Z",
    reason_codes: ["SELECTED_CANDIDATE_FAILED_VALIDATION"], live_advice_eligible: false,
    registry: { experiment_id: "fictional-experiment", manifest_hash: "b".repeat(64),
      phases: { train: { registered: 3, completed: 3 }, validation: { registered: 1, completed: 1 }, holdout: { registered: 0, completed: 0 } },
      freeze_hash: "c".repeat(64), prior_window_exposures: 0, exposure_watermark: 4,
      holdout_status: "not_independently_verified", coverage: "local_investor_trials_only", live_advice_eligible: false },
    study: { status: "insufficient_evidence", qualification: "synthetic_test_only", result_hash: "d".repeat(64),
      implementation_hash: "e".repeat(64), candidates: [],
      phase_checks: [{ phase: "train", execution_failure_count: 0, benchmark_execution_failure_count: 0 },
        { phase: "validation", execution_failure_count: 1, benchmark_execution_failure_count: 0 }] },
  });
}

test("calculated failure is a visible validation hold, not success or missing market data", () => {
  const value = task(), original = structuredClone(value), status = researchTaskStatus(value);
  assert.equal(status.title, "验证期未通过，未生成参考组合");
  assert.match(status.detail, /计算完成不等于策略通过/);
  assert.match(status.action, /另建研究版本/);
  assert.deepEqual(value, original);
});
test("holdout failure and unknown failure never become ready or encourage automatic retries", () => {
  const value = task(); value.reason_codes = ["SELECTED_CANDIDATE_FAILED_HOLDOUT"];
  assert.equal(researchTaskStatus(value).title, "保留期未通过，未生成参考组合");
  value.reason_codes = ["FUTURE_REASON_WITH_PRIVATE_LOOKING_TEXT"];
  const status = researchTaskStatus(value);
  assert.equal(status.title, "计算完成，研究证据仍不足");
  assert.doesNotMatch(JSON.stringify(status), /FUTURE_REASON/);
});
test("risk options and reference calculation retain unknown-risk and research-only boundaries", () => {
  const value = task(); value.study!.status = "risk_options_ready"; value.reason_codes = ["RISK_BUDGET_UNCONFIRMED"];
  assert.equal(researchTaskStatus(value).title, "测试候选已计算，等待确认风险范围");
  value.study!.status = "reference_ready"; value.reason_codes = [];
  assert.match(researchTaskStatus(value).title, /合成测试/);
  value.study!.qualification = "owner_reviewed_reconstructed";
  assert.match(researchTaskStatus(value).title, /不代表实盘验证/);
  assert.match(researchTaskStatus(value).detail, /不证明未来盈利/);
});
test("expiry takes priority over old failed-candidate messages and drops phase checks", () => {
  const value = task();
  value.study!.qualification = "owner_reviewed_reconstructed";
  value.study!.source_context = { range_start: "2025-01-01", range_end: "2025-06-01", valid_until: "2026-01-03T00:00:00.000Z",
    basis: "owner_reviewed_historical_reconstruction", listings: [{ listing_id: "CN:ALPHA", provider_symbol: "501998.SH", market: "CN", role: "growth" }] };
  researchTaskSchema.parse(value);
  const expired = currentResearchDisplay(value, Date.parse(value.study!.source_context.valid_until));
  assert.equal(expired.study, null);
  assert.equal(researchTaskStatus(expired).title, "研究来源或输入已失效");
  assert.deepEqual(value.study!.phase_checks!.map(row => row.phase), ["train", "validation"]);
});
test("queued, running, retrying, blocked and failed remain distinct technical states", () => {
  for (const state of ["queued", "running", "retrying", "blocked", "failed"] as const) {
    const value = task(); value.status = state; value.study = null;
    const status = researchTaskStatus(value);
    assert.doesNotMatch(status.title, /已通过|已计算/);
    assert.match(status.detail, /不代表持续监测已启用/);
  }
});
