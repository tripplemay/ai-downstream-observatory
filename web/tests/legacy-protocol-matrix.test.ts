import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { actionPython, probeActionMutation } from "./action-maintenance-fixture";
import { investorActor, investorFixture } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { enqueueLegacyTransitionJob, findLegacyTransitionRequest } from "../src/server/investor/legacy-transition-jobs";
import { readLegacyTransitionResponse } from "../src/server/investor/legacy-transition-read";
import { legacyTransitionAcknowledgements } from "../src/server/investor/legacy-transition-schemas";
import { compareInvestorMonitorData, readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { readEvidenceCheckpoint } from "../src/server/investor/evidence-monitor";
import { getInvestorState } from "../src/server/investor/service";

type Obj = Record<string, unknown>;
const admitted = "2026-11-03T06:00:03.003Z", migrated = "2026-11-06T06:00:04.002Z", binding = "a".repeat(64);
const tables = ["investor_models", "investor_model_controls", "investor_monitor_evidence_inputs", "investor_evidence_model_checkpoints",
  "investor_evidence_checkpoint_payloads", "investor_confirmed_captures"];
const finance = ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"];

function run(f: ReturnType<typeof investorFixture>, request: Obj) {
  return actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture,MIGRATED
from worker.orchestration.runtime import run_pending_once
from worker.orchestration.db import canonical_json
with offline_protocol_fixture():
 for _ in range(8):
  selected=run_pending_once(db,'fictional-node-original-protocol-core',clock=lambda:MIGRATED)
  result=db.execute('SELECT * FROM investor_legacy_transition_job_results WHERE request_id=?',('${request.request_id}',)).fetchone()
  if result:break
  assert selected is not None
 else:raise AssertionError('FICTIONAL_ORIGINAL_PROTOCOL_RESULT_REQUIRED')
 assert selected['status']=='succeeded'
 value={'result':json.loads(result['document_json'])}
 if result['outcome']=='registered':
  from worker.investor import legacy_transition_source,monitor_admission
  model=db.execute("SELECT document_json FROM investor_models WHERE workspace_id='w'").fetchone()
  definition=json.loads(model[0]);source=monitor_admission.latest_monitor_evidence(db,'w',definition['model_id'])
  value.update(input_id=source['id'],document=json.loads(source['document_json']))
  value['comparison']=legacy_transition_source.compare_transition_monitor_data(db,'w',definition,value['document'],now=MIGRATED)
 print(canonical_json(value))
`, "legacy_transition");
}

for (const protocol of ["v2", "v3"] as const) test(`original ${protocol} confirmed-price head -> ordinary explicit intent -> v5, independently replayed without resetting history`, t => {
  const f = investorFixture(); t.after(() => f.close());
  const metadata = actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import protocol_case,offline_protocol_fixture
from worker.orchestration.db import canonical_json
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
with offline_protocol_fixture():
 case=protocol_case(db,Path(sys.argv[1]));case.prepare('${protocol}')
 print(canonical_json({'model_id':case.model_id,'input_id':case.seed['id'],'checkpoint_id':case.head['id'],
  'authority_id':case.case.authority['id'],'member':case.case.member,'projection':case.projection,'state':case.state}))
`, "legacy_transition");
  const modelId = metadata.model_id as string, inputId = metadata.input_id as string, checkpointId = metadata.checkpoint_id as string;
  const model = f.db.prepare("SELECT * FROM investor_models WHERE id=?").get(modelId) as Obj;
  const definition = JSON.parse(model.document_json as string) as Obj;
  const reference = JSON.parse((f.db.prepare("SELECT document_json FROM investor_reference_plans WHERE id=?").get(model.plan_id) as Obj).document_json as string) as Obj;
  const beforeInitialRead = f.db.prepare("SELECT total_changes() n").get();
  const original = readInvestorMonitorEvidenceSource(f.db, "w", modelId, inputId, admitted);
  assert.equal(original.document.schema_version, `investor-monitor-data-input-${protocol}`);
  assert.equal("cost_assumptions" in (original.document.settings as Obj), protocol === "v3");
  assert.deepEqual(original.projection, metadata.projection); assert.equal(original.unavailable_reason, null);
  assert.deepEqual(new Set((original.projection!.quotes as Obj[]).map(value => value.observed_at)), new Set(["2026-11-02T20:00:00.000Z"]));
  assert.deepEqual(readEvidenceCheckpoint(f.db, "w", model, definition, checkpointId, admitted).checkpoint, metadata.state);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), beforeInitialRead);

  const hydrate = { model_id: modelId, input_id: inputId, checkpoint_id: checkpointId, authority_id: metadata.authority_id, member: metadata.member };
  actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import protocol_case,offline_protocol_fixture
with offline_protocol_fixture():
 case=protocol_case(db,Path(sys.argv[1]),json.loads(${JSON.stringify(JSON.stringify(hydrate))}));case.ready()
 print('{}')
`, "legacy_transition");
  const snapshot = Object.fromEntries(tables.map(table => [table, f.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()]));
  const first = readLegacyTransitionResponse(f.db, investorActor, binding, null, migrated);
  assert.deepEqual(first.model, { id: modelId, requires_transition: true }); assert.equal(first.request, null);
  assert.equal((f.db.prepare("SELECT count(*) n FROM investor_legacy_transition_confirmations").get() as Obj).n, 0);
  const previewBody = { kind: "preview", model_id: modelId, expected_revision: first.workspace_revision, idempotency_key: `fictional-${protocol}-preview` };
  const intent = enqueueLegacyTransitionJob(f.db, investorActor, previewBody, migrated);
  assert.deepEqual(enqueueLegacyTransitionJob(f.db, investorActor, previewBody, migrated), intent);
  run(f, intent);
  const ready = readLegacyTransitionResponse(f.db, investorActor, binding, intent.request_id as string, migrated);
  assert.equal(ready.request?.status, "preview_ready"); assert.equal(ready.preview_error, null); assert.ok(ready.view);
  assert.equal(ready.view.preview.proof.legacy_input_id, inputId); assert.equal(ready.view.preview.proof.checkpoint.sequence, 1);
  assert.ok(ready.view.preview.proof.carry_count > 0);
  assert.equal(findLegacyTransitionRequest(f.db, investorActor, `fictional-absent-${protocol}`), undefined);
  const submit = { kind: "confirmation", body: { schema_version: "investor-legacy-transition-submit-v1", preview_id: ready.view.preview.preview_id,
    expected_preview_hash: hash(ready.view.preview), expected_revision: ready.workspace_revision, idempotency_key: `fictional-${protocol}-confirm`,
    acknowledgements: Object.fromEntries(legacyTransitionAcknowledgements.map(key => [key, true])) } };
  const confirmation = enqueueLegacyTransitionJob(f.db, investorActor, submit, migrated), value = run(f, confirmation);
  const result = readLegacyTransitionResponse(f.db, investorActor, binding, confirmation.request_id as string, migrated);
  assert.equal(result.request?.status, "registered"); assert.equal(result.current_advice_certified, false);
  assert.equal(result.monitoring_activated, false); assert.deepEqual(result.model, { id: modelId, requires_transition: false });
  assert.deepEqual(enqueueLegacyTransitionJob(f.db, investorActor, submit, migrated), confirmation);
  const root = value.document as Obj, rootId = value.input_id as string;
  assert.equal(root.schema_version, "investor-monitor-data-input-v5");
  const comparison = compareInvestorMonitorData(f.db, "w", definition, reference.targets as Obj[], root, migrated);
  assert.deepEqual(comparison, value.comparison);
  const current = readInvestorMonitorEvidenceSource(f.db, "w", modelId, rootId, migrated);
  assert.deepEqual(current.projection, comparison.comparison_projection);
  assert.deepEqual(readEvidenceCheckpoint(f.db, "w", model, definition, checkpointId, migrated).checkpoint, metadata.state);
  assert.equal(readInvestorMonitorEvidenceSource(f.db, "w", modelId, inputId, migrated).unavailable_reason, "REFERENCE_SOURCE_NO_LONGER_CURRENT");
  for (const table of tables) {
    const expected = snapshot[table];
    assert.deepEqual(f.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all().slice(0, expected.length), expected, table);
  }
  const beforeRead = f.db.prepare("SELECT total_changes() n").get(), ro = new Database(f.filename, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(readInvestorMonitorEvidenceSource(ro, "w", modelId, rootId, migrated), current);
    assert.deepEqual(readEvidenceCheckpoint(ro, "w", model, definition, checkpointId, migrated).checkpoint, metadata.state);
    assert.equal((ro.prepare("SELECT total_changes() n").get() as Obj).n, 0);
  } finally { ro.close(); }
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), beforeRead);
  const stored = f.db.prepare("SELECT * FROM investor_monitor_evidence_inputs WHERE id=?").get(inputId) as Obj;
  const forged = JSON.parse(stored.document_json as string) as Obj; forged.projection_hash = "0".repeat(64);
  probeActionMutation(f.db, ["investor_monitor_evidence_inputs", "audit_events"], () => {
    f.db.prepare("UPDATE investor_monitor_evidence_inputs SET document_json=?,content_hash=? WHERE id=?").run(canonical(forged), hash(forged), inputId);
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ content_hash: hash(forged) }), stored.audit_id);
  }, () => {
    assert.throws(() => readEvidenceCheckpoint(f.db, "w", model, definition, checkpointId, migrated));
    assert.throws(() => readInvestorMonitorEvidenceSource(f.db, "w", modelId, rootId, migrated));
  });
  for (const table of finance) assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as Obj).n, 0);
  assert.equal(getInvestorState(f.db, investorActor, migrated).model_watch?.model_nav_cny, null);
  const later = "2026-11-06T06:00:04.003Z";
  const advanced = actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import protocol_case,offline_protocol_fixture
from worker.orchestration.db import canonical_json
with offline_protocol_fixture():
 case=protocol_case(db,Path(sys.argv[1]),json.loads(${JSON.stringify(JSON.stringify(hydrate))}))
 print(canonical_json(case.advance()))
`, "legacy_transition");
  const continuous = readInvestorMonitorEvidenceSource(f.db, "w", modelId, advanced.input_id as string, later);
  assert.deepEqual(continuous.projection, advanced.projection); assert.equal(continuous.unavailable_reason, null);
  assert.deepEqual(continuous.document.transition, root.transition);
  const head = readEvidenceCheckpoint(f.db, "w", model, definition, advanced.checkpoint_id as string, later);
  assert.deepEqual(head.checkpoint, advanced.state); assert.deepEqual(head.checkpoint!.initialized_at, (metadata.state as Obj).initialized_at);
  assert.deepEqual(head.checkpoint!.quantities, (metadata.state as Obj).quantities);
  assert.equal(getInvestorState(f.db, investorActor, later).model_watch?.checkpoint_sequence, head.checkpoint!.sequence);
  for (const table of finance) assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as Obj).n, 0);
  actionPython(f.filename, `
from worker.investor import eodhd_sources
withheld=${JSON.stringify((metadata.member as Obj).eodhd_authority_id)}
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',withheld,False,now='${later}')
print('{}')
`);
  assert.equal(getInvestorState(f.db, investorActor, later).model_watch?.model_nav_cny, null);
  assert.equal(readLegacyTransitionResponse(f.db, investorActor, binding, confirmation.request_id as string, later).request?.status, "registered");
});
