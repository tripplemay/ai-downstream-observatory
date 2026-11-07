import assert from "node:assert/strict";
import test from "node:test";
import { actionPython } from "./action-maintenance-fixture";
import { investorActor, investorFixture } from "./investor-fixture";
import { readInvestorMonitorEvidenceSource, compareInvestorMonitorData } from "../src/server/investor/monitor-source";
import { readEvidenceCheckpoint } from "../src/server/investor/evidence-monitor";
import { getInvestorState } from "../src/server/investor/service";

type Obj = Record<string, unknown>;
const first = "2026-11-04T06:00:03.000Z", listen = "2026-11-05T19:58:00.000Z", next = "2026-11-06T06:00:03.000Z";
test("ordinary v5 survives same-rule publication, qualified pause recovery, one later callback and default-core checkpoint with independent current/old replay", t => {
  const f = investorFixture(); t.after(() => f.close());
  // Separate bounded fixture phases, not a larger timeout or replay of a killed phase.
  const meta = actionPython(f.filename, `
from tests.investor.test_legacy_transition_continuation import continued_case
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=continued_case(db,Path(sys.argv[1]));case.ready(pause=False)
print(json.dumps({'model_id':case.model_id,'authority':case.authority,'first_publication':case.first_publication,
 'seed_id':case.seed['id'],'member':case.case.case.case.member}))
`, "legacy_transition");
  const modelId = meta.model_id as string, model = f.db.prepare("SELECT * FROM investor_models WHERE id=?").get(modelId) as Obj;
  const definition = JSON.parse(model.document_json as string) as Obj;
  const reference = JSON.parse((f.db.prepare("SELECT document_json FROM investor_reference_plans WHERE id=?").get(model.plan_id) as Obj).document_json as string) as Obj;
  const oldCheckpoints = f.db.prepare("SELECT rowid,* FROM investor_evidence_model_checkpoints ORDER BY sequence").all() as Obj[];
  assert.ok(oldCheckpoints.length >= 2);
  const root = f.db.prepare("SELECT input_id FROM investor_legacy_transition_admissions WHERE model_id=?").get(modelId) as Obj;
  const rootDocument = JSON.parse((f.db.prepare("SELECT document_json FROM investor_monitor_evidence_inputs WHERE id=?").get(root.input_id) as Obj).document_json as string) as Obj;
  const before = f.db.prepare("SELECT total_changes() n").get();
  // The original manual base is still authentic under its rule's first unchanged
  // economic publication; it does not become a new current quote.
  const rootComparison = compareInvestorMonitorData(f.db, "w", definition, reference.targets as Obj[], rootDocument, first);
  assert.ok(rootComparison.comparison_catalog); assert.ok(rootComparison.comparison_projection);
  assert.ok(readInvestorMonitorEvidenceSource(f.db, "w", modelId, meta.seed_id as string, first).projection);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  actionPython(f.filename, `
from tests.investor.test_legacy_transition_continuation import continued_case,SECOND
case=continued_case(db,Path(sys.argv[1]),json.loads(${JSON.stringify(JSON.stringify(meta))}))
case.pause();case.publication(SECOND)
print('{}')
`, "legacy_transition");
  const stale = readInvestorMonitorEvidenceSource(f.db, "w", modelId, meta.seed_id as string, listen);
  assert.equal(stale.projection, null); assert.equal(stale.unavailable_reason, "REFERENCE_SOURCE_NO_LONGER_CURRENT");
  const historical = readEvidenceCheckpoint(f.db, "w", model, definition, oldCheckpoints.at(-1)!.id as string, listen);
  assert.equal(historical.unavailable_reason, null); assert.ok(historical.checkpoint);
  assert.equal(getInvestorState(f.db, investorActor, listen).model_watch?.model_nav_cny, null);
  const advanced = actionPython(f.filename, `
from tests.investor.test_legacy_transition_continuation import continued_case
case=continued_case(db,Path(sys.argv[1]),json.loads(${JSON.stringify(JSON.stringify(meta))}))
source,checkpoint=case.advance()
print(json.dumps({'input_id':source['id'],'checkpoint_id':checkpoint['id']}))
`, "legacy_transition");
  const source = readInvestorMonitorEvidenceSource(f.db, "w", modelId, advanced.input_id as string, next);
  assert.ok(source.projection); assert.deepEqual(source.projection.quality_gaps, []);
  assert.deepEqual([...new Set((source.projection.quotes as Obj[]).map(row => row.observed_at))], ["2026-11-05T20:00:00.000Z"]);
  const checkpoint = readEvidenceCheckpoint(f.db, "w", model, definition, advanced.checkpoint_id as string, next);
  assert.equal(checkpoint.unavailable_reason, null); assert.ok(checkpoint.checkpoint);
  assert.deepEqual(checkpoint.checkpoint.initialized_at, historical.checkpoint.initialized_at);
  for (const [id, hash] of Object.entries(historical.checkpoint.processed_actions as Obj)) assert.equal((checkpoint.checkpoint.processed_actions as Obj)[id], hash);
  assert.deepEqual((f.db.prepare("SELECT rowid,* FROM investor_evidence_model_checkpoints ORDER BY sequence").all() as Obj[]).slice(0, oldCheckpoints.length), oldCheckpoints);
  assert.equal(getInvestorState(f.db, investorActor, next).model_watch?.id, modelId);
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "approval_events", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as Obj).n, 0);
});
