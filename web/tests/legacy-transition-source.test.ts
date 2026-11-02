import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { actionPython, probeActionMutation } from "./action-maintenance-fixture";
import { investorActor, investorFixture } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { readInvestorMonitorEvidenceSource, compareInvestorMonitorData } from "../src/server/investor/monitor-source";
import { readEvidenceCheckpoint } from "../src/server/investor/evidence-monitor";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { checkpointActionReview } from "../src/server/investor/action-checkpoint-replay";
import { validateInvestorMonitorDataDocument } from "../src/server/investor/kernel-contracts";

type Obj = Record<string, unknown>;
const at = "2026-11-03T06:00:04.002Z";
function fixture(t: TestContext, completed = false) {
  const f = investorFixture(); t.after(() => f.close());
  const value = actionPython(f.filename, `
from tests.investor.test_legacy_transition_source import LegacyTransitionSourceTests
from tests.investor.test_action_review_readmission import ActionReviewReadmissionTests
from tests.investor.test_action_review_workflow import ActionReviewWorkflowTests
from worker.investor import legacy_transition_source as bridge
from worker.investor.monitor_admission import latest_monitor_evidence
from worker.orchestration.db import canonical_json
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=LegacyTransitionSourceTests();case.db=db;case.at='${at}';case.case=ActionReviewReadmissionTests();case.case.db=db
case.case.case=ActionReviewWorkflowTests();case.case.case.db=db;case.case.case.path=Path(sys.argv[1]);case.case.case.version=0
if ${completed ? "True" : "False"}:
 case.test_default_core_rebinds_the_already_completed_capture_and_continues_the_original_model_without_a_new_request()
else:
 case.prepare();case.admit()
source=latest_monitor_evidence(db,'w',case.model_id);document=json.loads(source['document_json'])
comparison=bridge.compare_transition_monitor_data(db,'w',case.case.definition,document,now='${at}')
head=db.execute('SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1').fetchone()
print(canonical_json({'model_id':case.model_id,'input_id':source['id'],'input':document,'comparison':comparison,'checkpoint_id':head['id'],'old_review_id':case.case.old}))
`, "legacy_transition");
  return { ...f, modelId: value.model_id as string, inputId: value.input_id as string, document: value.input as Obj,
    comparison: value.comparison as Obj, checkpointId: value.checkpoint_id as string, oldReviewId: value.old_review_id as string };
}

test("independent Node preserves stale-source gaps under explicit v5 and replays original legacy checkpoints only after real admission", t => {
  const f = fixture(t), before = f.db.prepare("SELECT total_changes() n").get();
  const model = f.db.prepare("SELECT * FROM investor_models WHERE id=?").get(f.modelId) as Obj, definition = JSON.parse(model.document_json as string) as Obj;
  const reference = JSON.parse((f.db.prepare("SELECT document_json FROM investor_reference_plans ORDER BY created_at DESC LIMIT 1").get() as Obj).document_json as string) as Obj;
  const source = readInvestorMonitorEvidenceSource(f.db, "w", f.modelId, f.inputId, at);
  assert.equal(source.document.schema_version, "investor-monitor-data-input-v5");
  assert.ok(!source.projection || (source.projection.quality_gaps as string[]).length > 0);
  const comparison = compareInvestorMonitorData(f.db, "w", definition, reference.targets as Obj[], f.document, at);
  assert.deepEqual(comparison, f.comparison); assert.equal(comparison.comparison_projection.schema_version, "investor-monitor-data-projection-v3");
  const checkpoint = readEvidenceCheckpoint(f.db, "w", model, definition, f.checkpointId, at);
  assert.ok(checkpoint.checkpoint); assert.equal(checkpoint.unavailable_reason, null);
  const ro = new Database(f.filename, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(readInvestorMonitorEvidenceSource(ro, "w", f.modelId, f.inputId, at), source);
    assert.deepEqual(readEvidenceCheckpoint(ro, "w", model, definition, f.checkpointId, at), checkpoint);
    assert.equal((ro.prepare("SELECT total_changes() n").get() as Obj).n, 0);
  } finally { ro.close(); }
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  assert.equal(checkpointActionReview(f.db, "w", f.oldReviewId, at), null);
});

test("default core advances the same original units through completed pre-review capture and independent normal Node state", t => {
  const f = fixture(t, true), before = f.db.prepare("SELECT total_changes() n").get();
  const source = readInvestorMonitorEvidenceSource(f.db, "w", f.modelId, f.inputId, at);
  assert.ok(source.projection); assert.deepEqual(source.projection, f.comparison.comparison_projection);
  assert.deepEqual(source.projection.quality_gaps, []);
  const state = getInvestorState(f.db, investorActor, at); assert.ok(state.model_watch);
  assert.equal(state.model_watch.id, f.modelId);
  const model = f.db.prepare("SELECT * FROM investor_models WHERE id=?").get(f.modelId) as Obj, definition = JSON.parse(model.document_json as string) as Obj;
  const current = readEvidenceCheckpoint(f.db, "w", model, definition, f.checkpointId, at);
  assert.equal(current.unavailable_reason, null); assert.equal(current.checkpoint!.sequence, 2);
  const first = JSON.parse((f.db.prepare("SELECT payload FROM investor_evidence_checkpoint_payloads p JOIN investor_evidence_model_checkpoints c ON c.id=p.checkpoint_id ORDER BY c.sequence LIMIT 1").get() as { payload: Buffer }).payload.toString()) as Obj;
  assert.deepEqual(current.checkpoint!.initialized_at, first.initialized_at);
  for (const [id, digest] of Object.entries(first.processed_actions as Obj)) assert.equal((current.checkpoint!.processed_actions as Obj)[id], digest);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "approval_events", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as Obj).n, 0);
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT authority_id FROM investor_eodhd_requests WHERE symbol='VT.US' LIMIT 1").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${at}')
print('{}')
`);
  const withdrawn = getInvestorState(f.db, investorActor, at);
  assert.equal(withdrawn.model_watch?.model_nav_cny, null); assert.equal(withdrawn.effective_outcome, "insufficient_evidence");
});

test("a protocol-shaped hash cannot invent prices or discard actual root admission", t => {
  const f = fixture(t), model = f.db.prepare("SELECT * FROM investor_models WHERE id=?").get(f.modelId) as Obj;
  const definition = JSON.parse(model.document_json as string) as Obj, targets = (JSON.parse((f.db.prepare("SELECT document_json FROM investor_reference_plans ORDER BY created_at DESC LIMIT 1").get() as Obj).document_json as string) as Obj).targets as Obj[];
  const forged = structuredClone(f.document); forged.projection_hash = "0".repeat(64);
  assert.throws(() => compareInvestorMonitorData(f.db, "w", definition, targets, forged, at));
  probeActionMutation(f.db, ["investor_legacy_transition_admissions"], () => f.db.prepare("DELETE FROM investor_legacy_transition_admissions").run(), () => {
    assert.throws(() => readInvestorMonitorEvidenceSource(f.db, "w", f.modelId, f.inputId, at));
    assert.throws(() => readEvidenceCheckpoint(f.db, "w", model, definition, f.checkpointId, at));
  });
  assert.equal(checkpointActionReview(f.db, "w", f.oldReviewId, at), null);
  assert.equal(hash(f.document), hash(JSON.parse((f.db.prepare("SELECT document_json FROM investor_monitor_evidence_inputs WHERE id=?").get(f.inputId) as Obj).document_json as string)));
});

test("fully resealed source, root-admission and audit hashes cannot revive a fabricated current quote", t => {
  const f = fixture(t), fake = structuredClone(f.comparison.comparison_projection) as Obj;
  fake.quotes = [{ listing_id: "synthetic-3141", market: "US", currency: "USD", close: "9999", price_basis: "unadjusted",
    observed_at: at, known_at: at, valid_until: f.document.valid_until, expected_close_at: at, calendar_hash: "f".repeat(64), observation_hash: "e".repeat(64) }];
  validateInvestorMonitorDataDocument("projection", fake);
  const forged = structuredClone(f.document); forged.projection_hash = hash(fake);
  probeActionMutation(f.db, ["investor_monitor_evidence_inputs", "investor_legacy_transition_admissions", "audit_events"], () => {
    const input = f.db.prepare("SELECT audit_id FROM investor_monitor_evidence_inputs WHERE id=?").get(f.inputId) as Obj;
    const row = f.db.prepare("SELECT * FROM investor_legacy_transition_admissions").get() as Obj;
    const doc = JSON.parse(row.document_json as string) as Obj; doc.input_hash = hash(forged);
    f.db.prepare("UPDATE investor_monitor_evidence_inputs SET document_json=?,content_hash=? WHERE id=?").run(canonical(forged), hash(forged), f.inputId);
    f.db.prepare("UPDATE investor_legacy_transition_admissions SET document_json=?,content_hash=? WHERE id=?").run(canonical(doc), hash(doc), row.id);
    for (const [auditId, digest] of [[input.audit_id, hash(forged)], [row.audit_id, hash(doc)]])
      f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ content_hash: digest }), auditId);
  }, () => {
    const queries: string[] = [];
    const guarded = new Proxy(f.db, { get(target, key) {
      if (key === "prepare") return (sql: string) => { queries.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    assert.throws(() => readInvestorMonitorEvidenceSource(guarded, "w", f.modelId, f.inputId, at));
    for (const table of ["investor_price_payloads", "investor_issuer_payloads", "investor_eodhd_payloads", "investor_evidence_checkpoint_payloads"])
      assert.ok(queries.some(sql => sql.includes(table)), table);
  });
  assert.equal(checkpointActionReview(f.db, "w", f.oldReviewId, at), null);
  assert.deepEqual(readInvestorMonitorEvidenceSource(f.db, "w", f.modelId, f.inputId, at).document, f.document);
});

test("ordinary owner costs refresh v5 without freezing old checkpoint fees, and expiry stays unknown with current NAV hidden", t => {
  const f = fixture(t, true), declared = "2026-11-03T06:00:04.003Z", applied = "2026-11-03T06:00:04.005Z", expired = "2026-11-04T06:00:04.004Z";
  const original = f.db.prepare("SELECT rowid,* FROM investor_evidence_model_checkpoints ORDER BY sequence").all();
  const state = getInvestorState(f.db, investorActor, declared); assert.ok(state.monitor_costs);
  executeInvestorCommand(f.db, investorActor, { action: "set_monitor_costs", model_id: f.modelId, model_hash: state.monitor_costs.model_hash,
    expected_revision: state.revision, expected_cost_version: state.monitor_costs.version, idempotency_key: "fictional-v5-owner-fees",
    costs: { commission_bps: "1", minimum_fee_cny: "1", fx_bps: "2", slippage_bps: "3", maximum_cost_fraction: "0.01" },
    validity_days: 1, acknowledged_research_only: true }, declared);
  const value = actionPython(f.filename, `
from worker.orchestration.runtime import run_pending_once
from worker.investor import monitor_data,confirmed_feed
from worker.investor.monitor_costs import current_settings
from worker.investor.monitor_admission import latest_monitor_evidence,current_monitor_model
from worker.investor.evidence_monitor_runtime import resolve_checkpoint
from worker.orchestration.db import canonical_json
run=run_pending_once(db,'fictional-v5-new-owner-fees',clock=lambda:'${applied}')
assert run['status']=='succeeded'
source=latest_monitor_evidence(db,'w','${f.modelId}');doc=json.loads(source['document_json'])
_,definition,_=current_monitor_model(db,'w','${f.modelId}','${expired}')
head=db.execute('SELECT id FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1').fetchone()[0]
checkpoint,reason=resolve_checkpoint(db,'w',definition,head,'${expired}')
assert reason is None and checkpoint is not None
candidate=monitor_data.build_monitor_data(db,'w',definition,[window for _,window in confirmed_feed._windows(db,'w',doc)],current_settings(db,'w',definition,doc['settings'],'${expired}'),now='${expired}',audited_action_knowledge=True,legacy_transition=doc['transition'])
print(canonical_json({'id':source['id'],'document':doc,'candidate':candidate['document'],'projection':candidate['projection'],'checkpoint_id':head}))
`, "legacy_transition");
  const source = readInvestorMonitorEvidenceSource(f.db, "w", f.modelId, value.id as string, applied);
  assert.ok(source.projection); assert.equal(source.document.schema_version, "investor-monitor-data-input-v5");
  assert.deepEqual(source.document.transition, f.document.transition);
  const current = getInvestorState(f.db, investorActor, applied); assert.equal(current.monitor_costs?.status, "known"); assert.equal(current.monitor_costs.input_applied, true);
  assert.deepEqual(source.projection.policy.costs, current.monitor_costs.costs);
  const model = f.db.prepare("SELECT * FROM investor_models WHERE id=?").get(f.modelId) as Obj, definition = JSON.parse(model.document_json as string) as Obj;
  assert.ok(readEvidenceCheckpoint(f.db, "w", model, definition, value.checkpoint_id, expired).checkpoint);
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM investor_evidence_model_checkpoints ORDER BY sequence").all().slice(0, original.length), original);
  const comparison = compareInvestorMonitorData(f.db, "w", definition, (JSON.parse((f.db.prepare("SELECT document_json FROM investor_reference_plans ORDER BY created_at DESC LIMIT 1").get() as Obj).document_json as string) as Obj).targets as Obj[], value.candidate, expired);
  assert.deepEqual(comparison.comparison_projection, value.projection); assert.equal((comparison.comparison_projection.policy as Obj).costs, null);
  const later = getInvestorState(f.db, investorActor, expired); assert.equal(later.model_watch?.model_nav_cny, null);
  assert.equal(later.effective_outcome, "insufficient_evidence"); assert.equal(later.monitor_costs?.status, "expired");
});
