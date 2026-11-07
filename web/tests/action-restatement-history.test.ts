import assert from "node:assert/strict";
import test from "node:test";
import { actionPython } from "./action-maintenance-fixture";
import { investorFixture } from "./investor-fixture";
import { readEvidenceCheckpoint } from "../src/server/investor/evidence-monitor";
import { readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { verifyActionRestatementArithmetic } from "../src/server/investor/action-restatement-kernel";

type Obj = Record<string, unknown>;
test("retained original-v3 fees, explicit v5 consent and real fictional default-core head feed independent economic restatement without writes", t => {
  const f = investorFixture(); t.after(() => f.close());
  const value = actionPython(f.filename, `
from tests.investor.test_action_restatement_kernel import retained_v5_case
from worker.orchestration.db import canonical_json
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
print(canonical_json(retained_v5_case(db,Path(sys.argv[1]))))
`, "legacy_transition");
  const before = f.db.prepare("SELECT total_changes() n").get(), input = value.input as Obj;
  const model = f.db.prepare("SELECT * FROM investor_models WHERE id=?").get(value.model_id) as Obj;
  const source = readInvestorMonitorEvidenceSource(f.db, "w", value.model_id as string, value.input_id as string, "2026-11-06T06:00:04.003Z");
  assert.equal(source.unavailable_reason, null); assert.deepEqual(source.projection, input.head_projection);
  const checkpoint = readEvidenceCheckpoint(f.db, "w", model, input.definition as Obj, value.checkpoint_id as string, "2026-11-06T06:00:04.003Z");
  assert.deepEqual(checkpoint.checkpoint, input.head);
  const result = verifyActionRestatementArithmetic(input, value.result);
  assert.notEqual(result.difference_cny, "0"); assert.equal(result.state_published, false); assert.equal(result.source_evidence_verified, false);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"]) {
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
  }
});
