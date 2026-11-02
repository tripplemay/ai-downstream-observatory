import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { actionPython, probeActionMutation } from "./action-maintenance-fixture";
import { investorActor, investorFixture } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { enqueueLegacyTransitionJob, findLegacyTransitionRequest } from "../src/server/investor/legacy-transition-jobs";
import { readLegacyTransitionResponse } from "../src/server/investor/legacy-transition-read";
import { legacyTransitionAcknowledgements } from "../src/server/investor/legacy-transition-schemas";

type Obj = Record<string, unknown>;
const at = "2026-11-03T06:00:04.002Z", binding = "a".repeat(64);
function fixture(t: TestContext) {
  const f = investorFixture(); t.after(() => f.close());
  const meta = actionPython(f.filename, `
from tests.investor.test_legacy_transition_source import LegacyTransitionSourceTests
from tests.investor.test_action_review_readmission import ActionReviewReadmissionTests
from tests.investor.test_action_review_workflow import ActionReviewWorkflowTests
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=LegacyTransitionSourceTests();case.db=db;case.at='${at}';case.case=ActionReviewReadmissionTests();case.case.db=db
case.case.case=ActionReviewWorkflowTests();case.case.case.db=db;case.case.case.path=Path(sys.argv[1]);case.case.case.version=0
case.case.model(audited=False,known_costs=True);case.case.confirm()
from worker.orchestration.runtime import run_pending_once
for _ in range(10):
 if run_pending_once(db,'fictional-baseline-core',clock=lambda:'${at}') is None:break
else:raise AssertionError('FICTIONAL_BASELINE_CORE_NOT_DRAINED')
print(json.dumps({'model_id':case.case.definition['model_id']}))
`, "legacy_transition");
  return { ...f, modelId: meta.model_id as string };
}
function run(f: { filename: string }, request: Obj) {
  actionPython(f.filename, `
from worker.investor import legacy_transition_jobs as jobs
from worker.orchestration.runtime import run_pending_once
for _ in range(10):
 result=run_pending_once(db,'fictional-ordinary-core',clock=lambda:'${at}')
 if db.execute('SELECT 1 FROM investor_legacy_transition_job_results WHERE request_id=?',('${request.request_id}',)).fetchone():break
 assert result is not None
else:raise AssertionError('FICTIONAL_CORE_REQUEST_NOT_COMPLETED')
print('{}')
`, "legacy_transition");
}
function preview(f: ReturnType<typeof fixture>) {
  const initial = readLegacyTransitionResponse(f.db, investorActor, binding, null, at);
  const input = { kind: "preview", model_id: f.modelId, expected_revision: initial.workspace_revision, idempotency_key: "fictional-web-legacy-preview" };
  const intent = enqueueLegacyTransitionJob(f.db, investorActor, input, at); run(f, intent);
  return { intent, input, response: readLegacyTransitionResponse(f.db, investorActor, binding, intent.request_id as string, at) };
}

test("ordinary Node intent -> default core witness -> explicit combined registration, with read-only independent status and no controls or finance changes", t => {
  const f = fixture(t), initial = readLegacyTransitionResponse(f.db, investorActor, binding, null, at);
  assert.deepEqual(initial.model, { id: f.modelId, requires_transition: true }); assert.equal(initial.request, null);
  const revision = initial.workspace_revision, controls = f.db.prepare("SELECT rowid,* FROM investor_model_controls ORDER BY rowid").all();
  const input = { kind: "preview", model_id: f.modelId, expected_revision: revision, idempotency_key: "fictional-web-legacy-preview" };
  const intent = enqueueLegacyTransitionJob(f.db, investorActor, input, at);
  assert.equal((f.db.prepare("SELECT revision FROM investor_workspaces WHERE id='w'").get() as Obj).revision, revision);
  assert.deepEqual(enqueueLegacyTransitionJob(f.db, investorActor, input, at), intent);
  assert.equal(readLegacyTransitionResponse(f.db, investorActor, binding, intent.request_id as string, at).request?.status, "queued");
  run(f, intent);
  const ready = readLegacyTransitionResponse(f.db, investorActor, binding, intent.request_id as string, at);
  assert.equal(ready.request?.status, "preview_ready"); assert.equal(ready.preview_error, null); assert.ok(ready.view);
  assert.equal(ready.view.preview.workspace_revision, revision + 1); assert.equal(ready.request?.resource_hash, hash(ready.view.preview));
  assert.equal("candidate" in ready.view, false); assert.equal("quotes" in ready.view, false);
  const submit = { kind: "confirmation", body: { schema_version: "investor-legacy-transition-submit-v1", preview_id: ready.view.preview.preview_id,
    expected_preview_hash: hash(ready.view.preview), expected_revision: ready.workspace_revision, idempotency_key: "fictional-web-legacy-confirm",
    acknowledgements: Object.fromEntries(legacyTransitionAcknowledgements.map(key => [key, true])) } };
  const confirmation = enqueueLegacyTransitionJob(f.db, investorActor, submit, at); run(f, confirmation);
  const result = readLegacyTransitionResponse(f.db, investorActor, binding, confirmation.request_id as string, at);
  assert.equal(result.request?.status, "registered"); assert.equal(result.workspace_revision, revision + 3); assert.equal(result.view, null);
  assert.equal(result.current_advice_certified, false); assert.equal(result.monitoring_activated, false);
  assert.deepEqual(result.model, { id: f.modelId, requires_transition: false });
  assert.deepEqual(f.db.prepare("SELECT rowid,* FROM investor_model_controls ORDER BY rowid").all(), controls);
  assert.deepEqual(enqueueLegacyTransitionJob(f.db, investorActor, submit, at), confirmation);
  assert.equal((f.db.prepare("SELECT count(*) n FROM job_runs WHERE job_type='investor_legacy_transition'").get() as Obj).n, 2);
  const before = f.db.prepare("SELECT total_changes() n").get(), ro = new Database(f.filename, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(readLegacyTransitionResponse(ro, investorActor, binding, confirmation.request_id as string, at), { ...result, read_only: true });
    assert.equal((ro.prepare("SELECT total_changes() n").get() as Obj).n, 0);
  } finally { ro.close(); }
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "approval_events", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as Obj).n, 0);
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT authority_id FROM investor_eodhd_requests WHERE symbol='VT.US' LIMIT 1").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${at}')
print('{}')
`);
  const withdrawn = readLegacyTransitionResponse(f.db, investorActor, binding, confirmation.request_id as string, at);
  assert.equal(withdrawn.request?.status, "registered"); assert.equal(withdrawn.current_advice_certified, false); assert.equal(withdrawn.view, null);
});

test("unknown nonce never falls back to latest; changed nonce, foreign workspace, absent acknowledgements and unknown fields cannot enqueue", t => {
  const f = fixture(t), { intent, input, response } = preview(f); assert.ok(response.view);
  assert.equal(findLegacyTransitionRequest(f.db, investorActor, "fictional-absent"), undefined);
  const exact = readLegacyTransitionResponse(f.db, investorActor, binding, null, at, { latest: false, lookupNonce: "fictional-absent" });
  assert.equal(exact.request, null); assert.equal(exact.lookup_nonce, "fictional-absent");
  assert.throws(() => enqueueLegacyTransitionJob(f.db, investorActor, { ...input, model_id: "other" }, at), /DUPLICATE_CONFLICT/);
  assert.throws(() => readLegacyTransitionResponse(f.db, { id: "other" }, binding, intent.request_id as string, at));
  assert.throws(() => enqueueLegacyTransitionJob(f.db, investorActor, { ...input, quotes: [] }, at));
  assert.throws(() => enqueueLegacyTransitionJob(f.db, investorActor, { kind: "confirmation", body: { schema_version: "investor-legacy-transition-submit-v1",
    preview_id: response.view!.preview.preview_id, expected_preview_hash: hash(response.view!.preview), expected_revision: response.workspace_revision,
    idempotency_key: "fictional-missing-ack", acknowledgements: {} } }, at));
  const later = "2026-11-03T06:05:04.002Z", expired = readLegacyTransitionResponse(f.db, investorActor, binding, intent.request_id as string, later);
  assert.equal(expired.request?.status, "expired"); assert.equal(expired.view, null);
});

test("a fully resealed witness cannot replace independent replay; source withdrawal hides consent without mutating the historical job", t => {
  const f = fixture(t), { intent, response } = preview(f); assert.ok(response.view);
  const row = f.db.prepare("SELECT * FROM investor_legacy_transition_previews WHERE id=?").get(response.view.preview.preview_id) as Obj;
  const forged = structuredClone(response.view.preview); forged.basis_hash = "0".repeat(64); const digest = hash(forged);
  probeActionMutation(f.db, ["investor_legacy_transition_previews", "audit_events", "investor_legacy_transition_job_results", "job_runs"], () => {
    f.db.prepare("UPDATE investor_legacy_transition_previews SET document_json=?,content_hash=? WHERE id=?").run(canonical(forged), digest, row.id);
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ content_hash: digest }), row.audit_id);
    const result = f.db.prepare("SELECT * FROM investor_legacy_transition_job_results WHERE request_id=?").get(intent.request_id) as Obj;
    const doc = JSON.parse(result.document_json as string) as Obj; doc.resource_hash = digest; const resultHash = hash(doc);
    f.db.prepare("UPDATE investor_legacy_transition_job_results SET document_json=?,content_hash=?,resource_hash=? WHERE id=?").run(canonical(doc), resultHash, digest, result.id);
    f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=?").run(canonical({ content_hash: resultHash }), result.audit_id);
  }, () => {
    const current = readLegacyTransitionResponse(f.db, investorActor, binding, intent.request_id as string, at);
    assert.equal(current.request?.status, "preview_ready"); assert.equal(current.view, null); assert.equal(current.preview_error, "LEGACY_TRANSITION_VIEW_UNAVAILABLE");
  });
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT authority_id FROM investor_eodhd_requests WHERE symbol='VT.US' LIMIT 1").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant,False,now='${at}')
print('{}')
`);
  const withdrawn = readLegacyTransitionResponse(f.db, investorActor, binding, intent.request_id as string, at);
  assert.equal(withdrawn.view, null); assert.equal(withdrawn.preview_error, "LEGACY_TRANSITION_VIEW_UNAVAILABLE");
});
