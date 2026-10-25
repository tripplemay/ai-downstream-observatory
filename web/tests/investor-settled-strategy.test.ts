import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { hash } from "../src/server/ledger/service";
import { verifyInvestorKernelResult } from "../src/server/investor/kernel-contracts";
import { executionChecksUsable, phaseExecutionReview } from "../src/server/investor/research-execution";

function cases() {
  const child = spawnSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", `
import json
from tests.investor.test_settled_strategy import settled_strategy_case
from tests.investor.fixtures import profile
from worker.investor.strategy import research_reference
rows=[]
for orphan in (False,True):
 data,plan,policy=settled_strategy_case(orphan)
 p=profile('0.30'); request=dict(action='research',dataset=data,plan=plan,policy=policy,profile=p)
 rows.append(dict(orphan=orphan,request=request,result=research_reference(data,plan,policy,p,allow_synthetic=True)))
print(json.dumps(rows))`], { cwd: path.resolve(".."), encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as Array<{ orphan: boolean; request: Record<string, unknown>; result: Record<string, any> }>;
}
test("new selection and independent replay require candidate and benchmark cash intents to finish, even with zero raw failures", () => {
  for (const row of cases()) {
    assert.equal(verifyInvestorKernelResult(row.request, row.result), row.result);
    assert.equal(row.result.status, row.orphan ? "insufficient_evidence" : "reference_ready");
    const summary = row.result.candidates[0].train;
    assert.equal(executionChecksUsable({ ...summary, ...phaseExecutionReview(summary) }), !row.orphan);
    if (row.orphan) {
      assert.equal(summary.execution_failure_count, 0); assert.equal(summary.failed_cash_intent_count, 1);
      assert.equal(row.result.selected_parameters, null); assert.deepEqual(row.result.phase_evidence, []);
      const forged = structuredClone(row.result);
      forged.candidates[0].train.failed_cash_intent_count = 0;
      const { result_hash, ...body } = forged; forged.result_hash = hash(body);
      assert.throws(() => verifyInvestorKernelResult(row.request, forged), /INVESTOR_KERNEL_RESULT_INVALID/);
    }
  }
});
