import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test, { type TestContext } from "node:test";
import { investorFixture } from "./investor-fixture";
import { actionPython, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { enqueueActionReviewJob, enqueueUnchangedActionRecoveryJob, readActionReviewJobStatus } from "../src/server/investor/action-review-jobs";
import { readActionReviewConfirmation } from "../src/server/investor/action-review-lineage";
import { readInvestorSourceReview } from "../src/server/investor/source-inputs";
import { actionAvailabilityRefs } from "../src/server/investor/monitor-action-knowledge";
import { hash } from "../src/server/ledger/service";
import { readUnchangedActionRecoveryResponse } from "../src/server/investor/unchanged-action-recovery-read";
import { recoveryAttempt, parseRecoveryResponse } from "../src/components/workbench/investor-action-recovery-client";

type Obj = Record<string, unknown>;
const NOW = "2026-11-03T06:00:04.001Z", actor = { id: "synthetic-investor" };
function fixture(t: TestContext) {
  const f = investorFixture(); t.after(() => {
    try { for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as Obj).n, 0, name); }
    finally { f.close(); }
  });
  const metadata = actionPython(f.filename, `
from tests.investor.test_unchanged_action_recovery import UnchangedActionRecoveryTests
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=UnchangedActionRecoveryTests();case.db=db;case.path=Path(sys.argv[1]);case.ready()
print(json.dumps({'request':case.answers(),'authority':case.authority['id'],'base_review_id':case.base['id']}))
`);
  const input = { kind: "confirmation", body: metadata.request };
  function finish() {
    actionPython(f.filename, `
from worker.orchestration.runtime import run_pending_once
result=run_pending_once(db,'fictional-unchanged-recovery-core',clock=lambda:'${NOW}')
assert result and result['status']=='succeeded',result
print('{}')
`);
    const state = readActionReviewJobStatus(f.db, actor, null, NOW); assert.equal(state.request?.status, "confirmed");
    return readActionReviewConfirmation(f.db, "w", actor.id, state.request!.resource_id, NOW);
  }
  return { ...f, metadata, input, finish };
}

test("separate Node intent reaches default core, independent raw replay and unchanged original event knowledge", t => {
  const f = fixture(t), before = f.db.prepare("SELECT count(*) n FROM investor_action_publications").get();
  const changes = f.db.prepare("SELECT total_changes() n").get();
  const preview = readUnchangedActionRecoveryResponse(f.db, actor, "a".repeat(64), null, NOW);
  // The fixture registers a domain witness, not a background preview request.
  assert.equal(preview.recovery, null);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), changes);
  assert.throws(() => enqueueActionReviewJob(f.db, actor, f.input, NOW));
  const intent = enqueueUnchangedActionRecoveryJob(f.db, actor, f.input, NOW);
  assert.equal(intent.schema_version, "investor-action-review-job-request-v2");
  const confirmation = f.finish(); assert.equal(confirmation.schema_version, "investor-unchanged-action-recovery-confirmation-v1");
  assert.equal((confirmation.append_proof as Obj).added_event_count, 0); assert.equal(confirmation.research_admitted, false);
  assert.deepEqual(f.db.prepare("SELECT count(*) n FROM investor_action_publications").get(), before);
  assert.deepEqual(enqueueUnchangedActionRecoveryJob(f.db, actor, f.input, NOW), intent);
  const original = f.db.prepare("SELECT total_changes() n").get();
  const ref = f.db.prepare("SELECT r.id review_id,r.content_hash review_hash,r.source_id,s.content_hash source_hash FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id WHERE r.id=?").get(confirmation.new_review_id) as Obj;
  const reviewed = readInvestorSourceReview(f.db, "w", ref, NOW);
  const origins = actionAvailabilityRefs(f.db, "w", [reviewed], NOW, NOW);
  assert.equal(origins.length, 1); assert.equal(origins[0].original_review_id, f.metadata.base_review_id);
  assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), original);
  const readonly = new Database(f.filename, { readonly: true });
  try { assert.deepEqual(readActionReviewConfirmation(readonly, "w", actor.id, confirmation.confirmation_id, NOW), confirmation); }
  finally { readonly.close(); }
});

test("closed recovery input and original-nonce binding reject fake events, missing consent and changed enable choice", t => {
  const f = fixture(t), body = f.input.body as Obj;
  for (const patch of [{ new_events: [] }, { tax_per_unit: "0" }, { acknowledgements: {} }])
    assert.throws(() => enqueueUnchangedActionRecoveryJob(f.db, actor, { kind: "confirmation", body: { ...body, ...patch } }, NOW));
  enqueueUnchangedActionRecoveryJob(f.db, actor, f.input, NOW); f.finish();
  assert.throws(() => enqueueUnchangedActionRecoveryJob(f.db, actor, { kind: "confirmation", body: { ...body, enable_rule: true } }, NOW), /DUPLICATE_CONFLICT/);
  assert.throws(() => readActionReviewConfirmation(f.db, "w", "foreign-owner", (readActionReviewJobStatus(f.db, actor, null, NOW).request!).resource_id, NOW));
});

test("self-resealed recovery proof cannot replace actual original bytes and failed publication witness", t => {
  const f = fixture(t); enqueueUnchangedActionRecoveryJob(f.db, actor, f.input, NOW); const confirmed = f.finish();
  for (const mode of ["source", "failure"]) probeActionMutation(f.db, ["investor_action_review_confirmations", "audit_events"], () => {
    const request = structuredClone(confirmed.request as Obj);
    if (mode === "failure") request.failed_publication_hash = "0".repeat(64);
    resealActionRow(f.db, "investor_action_review_confirmations", confirmed.confirmation_id as string, doc => {
      (doc.append_proof as Obj)[mode === "source" ? "current_snapshot_hash" : "failed_publication_hash"] = "0".repeat(64);
      if (mode === "failure") { doc.request = request; doc.request_hash = hash(request); }
    }, mode === "failure" ? { request_hash: hash(request) } : {});
  }, () => assert.throws(() => readActionReviewConfirmation(f.db, "w", actor.id, confirmed.confirmation_id, NOW)));
});

test("ordinary versioned DTO qualifies actual failure and raw sources, then explicit client intent reaches default core", async t => {
  const f = fixture(t), binding = "a".repeat(64), before = f.db.prepare("SELECT count(*) n FROM investor_issuer_requests").get();
  const revision = (f.db.prepare("SELECT revision FROM investor_workspaces WHERE id='w'").get() as Obj).revision;
  enqueueUnchangedActionRecoveryJob(f.db, actor, { kind: "preview", symbol: "VT.US", expected_revision: revision, idempotency_key: "fictional-http-preview" }, NOW);
  function run() {
    actionPython(f.filename, `
from worker.orchestration.runtime import run_pending_once
result=run_pending_once(db,'fictional-recovery-dto-core',clock=lambda:'${NOW}')
assert result and result['status']=='succeeded',result
print('{}')
`);
  }
  run(); const value = readUnchangedActionRecoveryResponse(f.db, actor, binding, null, NOW);
  assert.equal(value.review.view!.confirmation_supported, false); assert.equal(value.recovery!.failure_code, "SOURCE_CAPTURE_TERMINAL_FAILURE");
  await parseRecoveryResponse(value, binding, "w", value.review.view!, Date.parse(NOW));
  const intent = recoveryAttempt(value, true, false, "fictional-dto-confirm", Date.parse(NOW));
  enqueueUnchangedActionRecoveryJob(f.db, actor, intent.intent, NOW); run();
  const result = readUnchangedActionRecoveryResponse(f.db, actor, binding, null, NOW, { lookupNonce: intent.nonce });
  assert.equal(result.review.request!.status, "confirmed"); assert.equal(result.recovery, null); assert.equal(result.review.view, null);
  await parseRecoveryResponse(result, binding, "w", value.review.view!, Date.parse(NOW), intent);
  assert.deepEqual(f.db.prepare("SELECT count(*) n FROM investor_issuer_requests").get(), before);
});
