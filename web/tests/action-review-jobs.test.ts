import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test, { type TestContext } from "node:test";
import { actionPython, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { investorFixture } from "./investor-fixture";
import { enqueueActionReviewJob, readActionReviewJobStatus } from "../src/server/investor/action-review-jobs";
import { readActionReviewConfirmation } from "../src/server/investor/action-review-lineage";

type Obj = Record<string, unknown>;
const AT = "2026-11-03T06:00:03.001Z", LATER = "2026-11-03T06:00:04.001Z", actor = { id: "synthetic-investor" };
function fixture(t: TestContext) {
  const f = investorFixture(); t.after(() => {
    try {
      for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
        assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as Obj).n, 0, table);
    } finally { f.close(); }
  });
  actionPython(f.filename, `
from tests.investor.test_action_review_workflow import ActionReviewWorkflowTests
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=ActionReviewWorkflowTests();case.db=db;case.path=Path(sys.argv[1]);case.retained_reports()
print('{}')
`);
  const previewInput = { kind: "preview", symbol: "VT.US", expected_revision: 0, idempotency_key: "fictional-node-preview" };
  function work(at = AT) {
    return actionPython(f.filename, `
from worker.orchestration.runtime import run_pending_once
result=run_pending_once(db,'fictional-action-review-node',clock=lambda:'${at}')
assert result and result['status']=='succeeded',result
print(json.dumps({'job':result}))
`);
  }
  function status(at = AT) { return readActionReviewJobStatus(f.db, actor, null, at); }
  function preview() { const doc = enqueueActionReviewJob(f.db, actor, previewInput, AT); work(); return doc; }
  function answers() {
    const state = status(); assert.equal(state.request?.status, "preview_ready");
    return { kind: "confirmation", body: { schema_version: "investor-action-review-submit-v1", preview_id: state.request!.resource_id,
      expected_revision: state.workspace_revision, idempotency_key: "fictional-node-confirmation", enable_rule: false,
      new_events: [{ type: "dividend", date: "2026-11-02", at: "2026-11-02T14:30:00Z", pay_at: "2026-11-09T21:00:00Z", tax_per_unit: "0.432109" }],
      acknowledgements: Object.fromEntries(["issuer_amount_unit_and_currency", "reported_differences_seen", "explicit_research_instants", "explicit_tax_amounts",
        "unchanged_tax_assumption_applies", "reported_coverage_not_objective_absence", "no_historical_restatement", "register_new_default_off_rule"].map(key => [key, true])) } };
  }
  return { ...f, previewInput, preview, status, work, answers };
}

test("ordinary Node enqueue, default Python core and independent status complete preview and confirmation without staling their own CAS", t => {
  const f = fixture(t);
  assert.equal(f.status().request, null);
  const requested = enqueueActionReviewJob(f.db, actor, f.previewInput, AT);
  assert.equal(f.status().workspace_revision, 0); assert.equal(f.status().request?.status, "queued");
  assert.deepEqual(enqueueActionReviewJob(f.db, actor, f.previewInput, AT), requested);
  f.work(); const ready = f.status(); assert.equal(ready.workspace_revision, 1); assert.equal(ready.request?.status, "preview_ready");
  assert.equal(ready.request?.resource_valid_until, "2026-11-03T06:15:03.001Z");
  const body = f.answers(), confirmation = enqueueActionReviewJob(f.db, actor, body, LATER);
  assert.equal(f.status(LATER).workspace_revision, 1); assert.equal(f.status(LATER).request?.status, "queued");
  f.work(LATER); const done = f.status(LATER); assert.equal(done.workspace_revision, 2); assert.equal(done.request?.status, "confirmed");
  const read = readActionReviewConfirmation(f.db, "w", actor.id, done.request!.resource_id, LATER);
  assert.equal(read.research_admitted, false); assert.equal((read.request as Obj).enable_rule, false);
  assert.deepEqual(enqueueActionReviewJob(f.db, actor, body, LATER), confirmation);
  assert.deepEqual(enqueueActionReviewJob(f.db, actor, f.previewInput, LATER), requested);
  assert.equal((f.db.prepare("SELECT count(*) n FROM investor_action_review_confirmations").get() as Obj).n, 1);
  assert.doesNotMatch(JSON.stringify(done), /tax_per_unit|987\.1234|new_events/);
});

test("a fresh user session can read durable status but status never returns reusable confirmation or source bytes", t => {
  const f = fixture(t); f.preview(); const request = f.answers(); enqueueActionReviewJob(f.db, actor, request, LATER); f.work(LATER);
  const before = f.db.prepare("SELECT total_changes() n").get(), read = f.status(LATER);
  assert.equal(read.request?.status, "confirmed"); assert.equal(read.research_admitted, false);
  assert.doesNotMatch(JSON.stringify(read), /acknowledgements|tax_per_unit|document_json|body|source_evidence/);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
});

test("busy, changed nonce payload, missing consent and foreign owner do not leave extra request or audit rows", t => {
  const f = fixture(t); enqueueActionReviewJob(f.db, actor, f.previewInput, AT);
  const before = f.db.prepare("SELECT count(*) n FROM audit_events").get();
  assert.throws(() => enqueueActionReviewJob(f.db, actor, { ...f.previewInput, idempotency_key: "busy-preview" }, AT), /BUSY/);
  assert.throws(() => enqueueActionReviewJob(f.db, actor, { ...f.previewInput, symbol: "BND.US" }, AT), /DUPLICATE_CONFLICT/);
  assert.throws(() => enqueueActionReviewJob(f.db, { id: "foreign-owner" }, f.previewInput, AT), /WORKSPACE_REQUIRED/);
  assert.deepEqual(f.db.prepare("SELECT count(*) n FROM audit_events").get(), before);
  f.work(); const body = f.answers(), unchanged = f.db.prepare("SELECT count(*) n FROM audit_events").get();
  delete (body.body as Obj).enable_rule;
  assert.throws(() => enqueueActionReviewJob(f.db, actor, body, LATER));
  assert.deepEqual(f.db.prepare("SELECT count(*) n FROM audit_events").get(), unchanged);
});

test("a queued source withdrawal produces an explicit rejection instead of any new approval", t => {
  const f = fixture(t); enqueueActionReviewJob(f.db, actor, f.previewInput, AT);
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT r.authority_id FROM investor_eodhd_requests r WHERE r.symbol='VT.US' LIMIT 1").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w', 'synthetic-investor',grant,False,now='${AT}')
print('{}')
`);
  f.work(); assert.equal(f.status().request?.status, "rejected"); assert.equal(f.status().request?.code, "ACTION_REVIEW_SOURCE_UNAVAILABLE");
  assert.equal((f.db.prepare("SELECT count(*) n FROM investor_action_review_previews").get() as Obj).n, 0);
});

test("expired, changed-version and readonly preview status do not silently refresh the original witness", t => {
  const f = fixture(t); const doc = f.preview();
  const reader = new Database(f.filename, { readonly: true });
  try { assert.equal(readActionReviewJobStatus(reader, actor, doc.request_id as string, AT).request?.status, "preview_ready"); }
  finally { reader.close(); }
  assert.equal(f.status("2026-11-03T06:16:03.001Z").request?.status, "expired");
  f.db.prepare("UPDATE investor_workspaces SET revision=revision+1 WHERE id='w'").run();
  assert.equal(f.status().request?.status, "outdated");
  assert.throws(() => readActionReviewJobStatus(f.db, { id: "foreign-owner" }, doc.request_id as string, AT), /WORKSPACE_REQUIRED/);
});

test("a resealed wrong resource or fence is not a truthful worker result", t => {
  const f = fixture(t); f.preview();
  const result = f.db.prepare("SELECT * FROM investor_action_review_job_results").get() as Obj;
  for (const mode of ["resource", "fence"]) probeActionMutation(f.db, ["investor_action_review_job_results", "audit_events"], () => {
    const columns = mode === "resource" ? { resource_hash: "0".repeat(64) } : { fencing_token: 2 };
    resealActionRow(f.db, "investor_action_review_job_results", result.id as string, doc => Object.assign(doc, columns), columns);
  }, () => assert.throws(() => f.status(), mode));
  assert.equal(f.status().request?.status, "preview_ready");
});
