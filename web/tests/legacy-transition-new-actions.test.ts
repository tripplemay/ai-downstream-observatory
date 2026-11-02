import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { actionPython } from "./action-maintenance-fixture";
import { investorActor, investorFixture } from "./investor-fixture";
import { enqueueActionReviewJob, readActionReviewJobStatus } from "../src/server/investor/action-review-jobs";
import { readActionReviewConfirmation } from "../src/server/investor/action-review-lineage";
import { readEvidenceCheckpoint } from "../src/server/investor/evidence-monitor";
import { readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { getInvestorState } from "../src/server/investor/service";

type Obj = Record<string, unknown>;
const report = "2026-11-06T06:00:03.000Z", previewAt = "2026-11-06T06:00:03.001Z", confirmAt = "2026-11-06T06:00:04.001Z";
test("a second ordinary review preserves v5 history and distinct knowledge through Node intent, default core and independent replay", t => {
  const f = investorFixture(); t.after(() => f.close());
  const meta = actionPython(f.filename, `
from tests.investor.test_legacy_transition_new_actions import new_action_case
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=new_action_case(db,Path(sys.argv[1]));case.ready()
base=case.case
print(json.dumps({'model_id':base.model_id,'authority':base.authority,'first_publication':base.first_publication,
 'seed_id':base.seed['id'],'member':base.case.case.case.member}))
`, "legacy_transition");
  const modelId = meta.model_id as string;
  const original = Object.fromEntries(["investor_models", "investor_model_controls", "investor_monitor_evidence_inputs",
    "investor_evidence_model_checkpoints", "investor_evidence_checkpoint_payloads"].map(table =>
      [table, f.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()]));
  const model = f.db.prepare("SELECT * FROM investor_models WHERE id=?").get(modelId) as Obj;
  const definition = JSON.parse(model.document_json as string) as Obj;
  const priorHeader = f.db.prepare("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1").get() as Obj;
  const priorState = readEvidenceCheckpoint(f.db, "w", model, definition, priorHeader.id as string, "2026-11-04T06:00:03.000Z");
  assert.ok(priorState.checkpoint);
  actionPython(f.filename, `
from tests.investor.test_legacy_transition_new_actions import new_action_case
case=new_action_case(db,Path(sys.argv[1]),json.loads(${JSON.stringify(JSON.stringify(meta))}))
case.capture();case.reports()
print('{}')
`, "legacy_transition");
  assert.equal(getInvestorState(f.db, investorActor, report).model_watch?.model_nav_cny, null);
  const revision = (f.db.prepare("SELECT revision FROM investor_workspaces WHERE id='w'").get() as Obj).revision;
  const intent = enqueueActionReviewJob(f.db, investorActor, { kind: "preview", symbol: "VT.US", expected_revision: revision,
    idempotency_key: "fictional-v5-node-next-preview" }, previewAt);
  const work = (at: string) => actionPython(f.filename, `
from worker.orchestration.runtime import run_pending_once
for _ in range(8):
 result=run_pending_once(db,'fictional-v5-next-node-core',clock=lambda:'${at}')
 if result is None: break
else: raise AssertionError('FICTIONAL_V5_CORE_DID_NOT_SETTLE')
print('{}')
`, "legacy_transition");
  work(previewAt);
  const preview = readActionReviewJobStatus(f.db, investorActor, intent.request_id as string, previewAt);
  assert.equal(preview.request?.status, "preview_ready");
  const body = { schema_version: "investor-action-review-submit-v1", preview_id: preview.request!.resource_id,
    expected_revision: preview.workspace_revision, idempotency_key: "fictional-v5-node-next-confirmation", enable_rule: false,
    new_events: [{ type: "dividend", date: "2026-11-05", at: "2026-11-05T14:30:00Z", pay_at: "2026-11-12T21:00:00Z", tax_per_unit: "0.4" }],
    acknowledgements: Object.fromEntries(["issuer_amount_unit_and_currency", "reported_differences_seen", "explicit_research_instants", "explicit_tax_amounts",
      "unchanged_tax_assumption_applies", "reported_coverage_not_objective_absence", "no_historical_restatement", "register_new_default_off_rule"].map(key => [key, true])) };
  const submitted = enqueueActionReviewJob(f.db, investorActor, { kind: "confirmation", body }, confirmAt);
  work(confirmAt);
  const done = readActionReviewJobStatus(f.db, investorActor, submitted.request_id as string, confirmAt);
  assert.equal(done.request?.status, "confirmed");
  const confirmation = readActionReviewConfirmation(f.db, "w", investorActor.id, done.request!.resource_id, confirmAt);
  assert.equal((confirmation.request as Obj).enable_rule, false);
  assert.equal((f.db.prepare("SELECT enabled FROM investor_action_controls WHERE id=?").get(confirmation.new_control_id) as Obj).enabled, 0);
  assert.deepEqual(enqueueActionReviewJob(f.db, investorActor, { kind: "confirmation", body }, confirmAt), submitted);
  const currentHeader = f.db.prepare("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1").get() as Obj;
  assert.notEqual(currentHeader.id, priorHeader.id);
  const before = f.db.prepare("SELECT total_changes() n").get();
  const source = readInvestorMonitorEvidenceSource(f.db, "w", modelId, currentHeader.input_id as string, confirmAt);
  assert.equal(source.document.schema_version, "investor-monitor-data-input-v5"); assert.ok(source.projection);
  assert.deepEqual(source.projection.quality_gaps, []);
  const current = readEvidenceCheckpoint(f.db, "w", model, definition, currentHeader.id as string, confirmAt);
  const historical = readEvidenceCheckpoint(f.db, "w", model, definition, priorHeader.id as string, confirmAt);
  assert.ok(current.checkpoint); assert.ok(historical.checkpoint);
  assert.deepEqual(historical.checkpoint, priorState.checkpoint);
  assert.deepEqual(current.checkpoint.initialized_at, priorState.checkpoint.initialized_at);
  for (const [id, digest] of Object.entries(priorState.checkpoint.processed_actions as Obj)) assert.equal((current.checkpoint.processed_actions as Obj)[id], digest);
  const added = (source.projection.corporate_actions as Obj[]).filter(item => item.effective_at === "2026-11-05T14:30:00.000Z");
  assert.equal(added.length, 1); assert.equal(added[0].known_at, confirmAt);
  assert.ok((current.checkpoint.processed_actions as Obj)[added[0].id as string]);
  assert.equal(getInvestorState(f.db, investorActor, confirmAt).model_watch?.id, modelId);
  for (const [table, rows] of Object.entries(original)) assert.deepEqual(f.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all().slice(0, rows.length), rows);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  const ro = new Database(f.filename, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(readEvidenceCheckpoint(ro, "w", model, definition, currentHeader.id as string, confirmAt), current);
    assert.deepEqual(readInvestorMonitorEvidenceSource(ro, "w", modelId, currentHeader.input_id as string, confirmAt), source);
    assert.equal((ro.prepare("SELECT total_changes() n").get() as Obj).n, 0);
  } finally { ro.close(); }
  actionPython(f.filename, `
from worker.investor import eodhd_sources
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',${JSON.stringify((meta.member as Obj).eodhd_authority_id)},False,now='${confirmAt}')
print('{}')
`, "legacy_transition");
  const withdrawn = getInvestorState(f.db, investorActor, confirmAt);
  assert.equal(withdrawn.model_watch?.model_nav_cny, null); assert.equal(withdrawn.effective_outcome, "insufficient_evidence");
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "approval_events", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as Obj).n, 0);
});
