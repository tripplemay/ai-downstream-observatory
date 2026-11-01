import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { actionPython, probeActionMutation } from "./action-maintenance-fixture";
import { investorActor, investorFixture } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { readLegacyTransitionConfirmation } from "../src/server/investor/legacy-action-transition";
import { checkpointActionReview } from "../src/server/investor/action-checkpoint-replay";
import { readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";

type Obj = Record<string, unknown>;
const at = "2026-11-03T06:00:04.002Z";
function fixture(t: TestContext) {
  const f = investorFixture(); t.after(() => f.close());
  const value = actionPython(f.filename, `
from tests.investor.test_action_review_readmission import ActionReviewReadmissionTests
from tests.investor.test_action_review_workflow import ActionReviewWorkflowTests
from worker.investor import legacy_transition_workflow as flow,legacy_action_transition as transition
from worker.orchestration.db import canonical_json,content_hash
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=ActionReviewReadmissionTests();case.db=db;case.case=ActionReviewWorkflowTests();case.case.db=db;case.case.path=Path(sys.argv[1]);case.case.version=0
case.model(audited=False,known_costs=True);case.confirm()
revision=db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
witness=flow.register_legacy_transition_preview(db,'w','synthetic-investor',{'model_id':case.definition['model_id'],'expected_revision':revision,'idempotency_key':'fictional-legacy-witness'},now='${at}')
request={'schema_version':'investor-legacy-transition-submit-v1','preview_id':witness['preview_id'],'expected_preview_hash':content_hash(witness),'expected_revision':witness['workspace_revision'],'idempotency_key':'fictional-legacy-confirm',
'acknowledgements':{key:True for key in ('preserve_original_accounting_and_knowledge','revalidate_current_sources_on_every_use','new_actions_keep_audited_knowledge','quality_gaps_are_not_current_advice','research_only_no_trading')}}
confirmation=flow.confirm_legacy_transition(db,'w','synthetic-investor',request,now='${at}')
candidate=transition._prepare_legacy_action_transition(db,'w','synthetic-investor',case.definition['model_id'],now='${at}')['candidate']
print(canonical_json({'confirmation':confirmation,'candidate':candidate,'old_review_id':case.old}))
`, "legacy_transition");
  const receipt = value.confirmation as Obj;
  return { ...f, receipt, candidate: value.candidate as Obj, modelId: receipt.model_id as string,
    id: receipt.confirmation_id as string, oldReviewId: value.old_review_id as string };
}

test("Node independently replays explicit consent against all original bytes on an actual read-only connection", t => {
  const f = fixture(t), before = f.db.prepare("SELECT total_changes() n").get();
  t.mock.method(globalThis, "fetch", () => { throw new Error("NO_NETWORK"); });
  assert.deepEqual(readLegacyTransitionConfirmation(f.db, investorActor, "w", f.id, f.candidate, at), f.receipt);
  const ro = new Database(f.filename, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(readLegacyTransitionConfirmation(ro, investorActor, "w", f.id, f.candidate, at), f.receipt);
    assert.equal((ro.prepare("SELECT total_changes() n").get() as Obj).n, 0);
  } finally { ro.close(); }
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  assert.equal(checkpointActionReview(f.db, "w", f.oldReviewId, at), null);
  assert.equal(readInvestorMonitorEvidenceSource(f.db, "w", f.modelId, f.receipt.legacy_input_id as string, at).projection, null);
  assert.equal(f.receipt.monitor_data_readmission_required, true); assert.equal(f.receipt.research_admitted, false);
});

test("a hash-consistent false processed-action binding is rejected by independently replayed economics", t => {
  const f = fixture(t);
  probeActionMutation(f.db, ["investor_legacy_transition_previews", "investor_legacy_transition_confirmations", "audit_events"], () => {
    const row = f.db.prepare("SELECT * FROM investor_legacy_transition_previews WHERE id=?").get(f.receipt.preview_id) as Obj;
    const witness = JSON.parse(row.document_json as string) as Obj; (witness.proof as Obj).carry_hash = "f".repeat(64);
    const receipt = structuredClone(f.receipt); receipt.carry_hash = "f".repeat(64); receipt.preview_hash = hash(witness);
    (receipt.request as Obj).expected_preview_hash = hash(witness); receipt.request_hash = hash(receipt.request);
    f.db.prepare("UPDATE investor_legacy_transition_previews SET document_json=?,content_hash=? WHERE id=?").run(canonical(witness), hash(witness), row.id);
    f.db.prepare("UPDATE investor_legacy_transition_confirmations SET document_json=?,content_hash=?,request_hash=? WHERE id=?")
      .run(canonical(receipt), hash(receipt), receipt.request_hash, f.id);
    for (const [auditId, digest] of [[row.audit_id, hash(witness)], [(f.db.prepare("SELECT audit_id FROM investor_legacy_transition_confirmations WHERE id=?").get(f.id) as Obj).audit_id, hash(receipt)]]) {
      f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ content_hash: digest }), auditId);
    }
  }, () => {
    const queries: string[] = [];
    const guarded = new Proxy(f.db, { get(target, key) {
      if (key === "prepare") return (sql: string) => { queries.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    assert.throws(() => readLegacyTransitionConfirmation(guarded, investorActor, "w", f.id, f.candidate, at));
    for (const table of ["investor_price_payloads", "investor_issuer_payloads", "investor_eodhd_payloads", "investor_evidence_checkpoint_payloads"])
      assert.ok(queries.some(sql => sql.includes(table)), table);
  });
  assert.deepEqual(readLegacyTransitionConfirmation(f.db, investorActor, "w", f.id, f.candidate, at), f.receipt);
});

test("an existing receipt survives ordinary pause/resume, new fees and their expiry without preserving expired costs", t => {
  const f = fixture(t), declared = "2026-11-03T06:00:04.003Z", effective = "2026-11-03T06:00:04.009Z", expired = "2026-11-04T06:00:04.004Z";
  const original = f.db.prepare("SELECT rowid,* FROM investor_monitor_evidence_inputs ORDER BY rowid").all();
  const s = getInvestorState(f.db, investorActor, declared); assert.ok(s.monitor_costs);
  executeInvestorCommand(f.db, investorActor, { action: "set_monitor_costs", model_id: f.modelId, model_hash: s.monitor_costs.model_hash,
    expected_cost_version: s.monitor_costs.version, expected_revision: s.revision, idempotency_key: "fictional-post-consent-fees",
    costs: { commission_bps: "1", minimum_fee_cny: "1", fx_bps: "2", slippage_bps: "3", maximum_cost_fraction: "0.01" },
    validity_days: 1, acknowledged_research_only: true }, declared);
  for (const [enabled, stamp] of [[false, "2026-11-03T06:00:04.005Z"], [true, "2026-11-03T06:00:04.007Z"]] as const) {
    const state = getInvestorState(f.db, investorActor, stamp);
    executeInvestorCommand(f.db, investorActor, { action: "set_monitoring", model_id: f.modelId, enabled,
      expected_revision: state.revision, idempotency_key: "fictional-consent-control-" + enabled }, stamp);
  }
  assert.notEqual((f.db.prepare("SELECT id FROM investor_model_controls ORDER BY version DESC LIMIT 1").get() as Obj).id, f.receipt.control_id);
  assert.throws(() => readLegacyTransitionConfirmation(f.db, investorActor, "w", f.id, f.candidate, effective));
  const values = actionPython(f.filename, `
from worker.investor import legacy_transition_workflow as flow,legacy_action_transition as transition
from worker.orchestration.db import canonical_json
result={}
for key,stamp in {'fresh':'${effective}','expired':'${expired}'}.items():
 result[key]={'receipt':flow.resolve_legacy_transition_confirmation(db,'w','synthetic-investor','${f.id}',now=stamp),'candidate':transition._prepare_legacy_action_transition(db,'w','synthetic-investor','${f.modelId}',now=stamp)['candidate']}
print(canonical_json(result))
`, "legacy_transition");
  for (const [key, stamp] of [["fresh", effective], ["expired", expired]]) {
    const value = values[key] as Obj;
    assert.deepEqual(value.receipt, f.receipt);
    assert.deepEqual(readLegacyTransitionConfirmation(f.db, investorActor, "w", f.id, value.candidate, stamp), f.receipt);
    if (key === "expired") assert.equal((((value.candidate as Obj).settings as Obj).policy as Obj).costs, null);
  }
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM investor_monitor_evidence_inputs ORDER BY rowid").all(), original);
});

test("another owner, altered metadata, future or expired receipt and supplier withdrawal never qualify a summary", t => {
  const f = fixture(t), before = f.db.prepare("SELECT total_changes() n").get();
  assert.throws(() => readLegacyTransitionConfirmation(f.db, { id: "other" }, "w", f.id, f.candidate, at));
  assert.throws(() => readLegacyTransitionConfirmation(f.db, investorActor, "other", f.id, f.candidate, at));
  const bad = structuredClone(f.candidate); bad.projection_hash = "0".repeat(64);
  assert.throws(() => readLegacyTransitionConfirmation(f.db, investorActor, "w", f.id, bad, at));
  assert.throws(() => readLegacyTransitionConfirmation(f.db, investorActor, "w", f.id, f.candidate, "2026-11-03T06:00:04.001Z"));
  assert.throws(() => readLegacyTransitionConfirmation(f.db, investorActor, "w", f.id, f.candidate, f.receipt.valid_until as string));
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT authority_id FROM investor_eodhd_requests WHERE symbol='VT.US' LIMIT 1").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${at}')
print('{}')
`);
  assert.throws(() => readLegacyTransitionConfirmation(f.db, investorActor, "w", f.id, f.candidate, at));
  assert.equal(checkpointActionReview(f.db, "w", f.oldReviewId, at), null);
});
