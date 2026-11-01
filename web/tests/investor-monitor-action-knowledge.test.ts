import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { replayInvestorMonitorData, readInvestorMonitorEvidenceSource } from "../src/server/investor/monitor-source";
import { getInvestorState, executeInvestorCommand } from "../src/server/investor/service";
import { actionMaintenanceFixture, actionPython, LATER } from "./action-maintenance-fixture";
import { readManagedActionReview } from "../src/server/investor/managed-action-source";
import { actionAvailabilityRefs } from "../src/server/investor/monitor-action-knowledge";
import { validateInvestorSourceDocument } from "../src/server/investor/kernel-contracts";
import { readInvestorAuditedMonitorSnapshot } from "../src/server/investor/source-inputs";

type Obj = Record<string, unknown>;
const now = "2026-01-03T12:00:03.000Z";
function helper(f: ReturnType<typeof investorFixture>, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 131072, stdio: ["ignore", "pipe", "pipe"] })) as Obj;
}
function seed(f: ReturnType<typeof investorFixture>, args: string[] = []) {
  return helper(f, "tests.investor.monitor_data_fixture", ["--audited-actions", "--late-actions", ...args]) as {
    definition: Obj; reference_targets: Obj[]; document: Obj; projection: Obj; real_provider_called: boolean; registered_input_id: string };
}
function noFinance(f: ReturnType<typeof investorFixture>) {
  for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
}
function savedReference(f: ReturnType<typeof investorFixture>) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
  helper(f, "tests.investor.evidence_fixture"); helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const current = "2026-01-02T12:00:04.000Z", state = getInvestorState(f.db, actor, current); assert.ok(state.plan);
  executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision, idempotency_key: "save-knowledge-fixture" }, current);
  return getInvestorState(f.db, actor, current);
}

test("independent Node replays actual fictional retained receipts under the distinct late-action protocol", () => {
  const f = investorFixture();
  try {
    const value = seed(f); assert.equal(value.real_provider_called, false);
    const before = f.db.prepare("SELECT total_changes() n").get();
    const read = replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, value.document, now);
    assert.equal(value.document.schema_version, "investor-monitor-data-input-v4");
    assert.equal(read.projection!.schema_version, "investor-monitor-data-projection-v2");
    assert.deepEqual(read.projection, value.projection); assert.equal(read.unavailable_reason, null);
    assert.equal((read.projection!.corporate_actions as Obj[]).length, 3);
    for (const event of read.projection!.corporate_actions as Obj[]) assert.equal(event.known_at, now);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
  } finally { f.close(); }
});

test("self-consistent earlier availability and origin metadata are not original source evidence", () => {
  const f = investorFixture();
  try {
    const value = seed(f);
    for (const change of [{ known_at: "2025-12-30T00:00:00Z" }, { original_review_id: "fictional-forged-origin" }, { original_review_hash: "0".repeat(64) }, { event_hash: "0".repeat(64) }]) {
      const doc = structuredClone(value.document), segment = (doc.segments as Obj[]).find(row => ((row.snapshot as Obj).action_availability_refs as Obj[]).length)!;
      Object.assign(((segment.snapshot as Obj).action_availability_refs as Obj[])[0], change);
      assert.throws(() => replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, doc, now));
    }
    const mixed = { ...value.document, schema_version: "investor-monitor-data-input-v1" };
    assert.throws(() => replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, mixed, now)); noFinance(f);
  } finally { f.close(); }
});

test("monitor-only journal cannot be admitted as a historical research dataset", () => {
  const f = investorFixture();
  try {
    const value = seed(f);
    const segment=(value.document.segments as Obj[])[0];
    const source=readInvestorAuditedMonitorSnapshot(f.db,"w",{...segment,created_at:value.document.created_at,valid_until:value.document.valid_until},now);
    assert.ok(source.dataset); validateInvestorSourceDocument("monitor_dataset",source.dataset);
    assert.throws(() => validateInvestorSourceDocument("dataset", source.dataset));
    const grant = { ...value.document, live_advice_eligible: true };
    assert.throws(() => replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, grant, now)); noFinance(f);
  } finally { f.close(); }
});

test("a resealed projection cannot hide corrupted retained price bytes", () => {
  const f = investorFixture();
  try {
    const value = seed(f);
    f.db.exec("DROP TRIGGER investor_price_payload_no_update");
    f.db.prepare("UPDATE investor_price_payloads SET projection=? WHERE capture_id=(SELECT id FROM investor_price_captures LIMIT 1)").run(Buffer.from('{"FICTIONAL":"not original receipt"}'));
    const doc = { ...value.document, projection_hash: hash(value.projection) };
    assert.throws(() => replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, doc, now)); noFinance(f);
  } finally { f.close(); }
});

test("full standing-rule raw replay preserves original availability across two publication headers", t => {
  const f = actionMaintenanceFixture(t), before = f.db.prepare("SELECT total_changes() n").get();
  const reviews = (f.metadata.reviews as { review: Obj }[]).map(value => readManagedActionReview(f.db, "w", value.review.id, LATER));
  const refs = reviews.map(value => actionAvailabilityRefs(f.db, "w", [value], LATER, LATER)[0]);
  assert.notEqual(reviews[0].row.created_at, reviews[1].row.created_at);
  assert.equal(refs[0].known_at, refs[1].known_at); assert.equal(refs[0].event_hash, refs[1].event_hash);
  assert.equal(refs[0].original_review_id, f.metadata.base_review_id); assert.notEqual(refs[0].review_id, refs[1].review_id);
  const expected = actionPython(f.filename, `
from worker.investor import managed_actions as m
from worker.investor.monitor_action_knowledge import _availability_refs
from worker.orchestration.db import canonical_json
ids=[r[0] for r in db.execute("SELECT id FROM investor_action_publications WHERE status='published' ORDER BY sequence")]
values=[_availability_refs(db,'w',[m.resolve_managed_review(db,'w',i,now='${LATER}')],'${LATER}','${LATER}')[0] for i in ids]
print(canonical_json({'refs':values}))
`);
  assert.deepEqual(refs, expected.refs); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
});

test("ordinary metadata admission and core monitoring consume v4 without source calls or extra checkpoints", () => {
  const f = investorFixture();
  try {
    const saved = savedReference(f), value = seed(f, ["--admit", "--monitor", "--later"]);
    assert.equal(value.real_provider_called, false); assert.ok(value.registered_input_id);
    const before = f.db.prepare("SELECT total_changes() n").get();
    const read = readInvestorMonitorEvidenceSource(f.db, saved.workspace_id!, saved.model_watch!.id, value.registered_input_id, now);
    assert.deepEqual(read.projection, value.projection); assert.equal(read.unavailable_reason, null);
    const state = getInvestorState(f.db, actor, "2026-01-03T12:15:03.000Z");
    assert.equal(state.effective_outcome, "observe");
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_evidence_model_checkpoints").get() as { n: number }).n, 1);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
  } finally { f.close(); }
});

test("owner cost updates retain v4 and database guards reject missing, null or forged cost bindings", () => {
  const f = investorFixture();
  try {
    const saved = savedReference(f); seed(f,["--admit", "--monitor"]);
    const at = "2026-01-03T12:00:04.000Z", state = getInvestorState(f.db,actor,at);
    assert.equal(state.monitor_costs!.status,"unknown");
    executeInvestorCommand(f.db,actor,{action:"set_monitor_costs",model_id:saved.model_watch!.id,
      model_hash:state.monitor_costs!.model_hash,expected_cost_version:state.monitor_costs!.version,expected_revision:state.revision,
      idempotency_key:"fictional-v4-costs",costs:{commission_bps:"1",minimum_fee_cny:"2",fx_bps:"3",slippage_bps:"4",maximum_cost_fraction:"0.01"},
      validity_days:30,acknowledged_research_only:true},at);
    actionPython(f.filename,`
from worker.orchestration.runtime import run_pending_once
for _ in range(3):
 result=run_pending_once(db,'fictional-knowledge-cost-refresh',role='core',clock=lambda:'2026-01-03T12:01:04.000Z')
 if result is None:break
 assert result['status']=='succeeded',result
print('{}')
`);
    const row = f.db.prepare("SELECT * FROM investor_monitor_evidence_inputs ORDER BY created_at DESC,rowid DESC LIMIT 1").get() as Obj;
    const document = JSON.parse(row.document_json as string) as Obj, settings = document.settings as Obj;
    assert.equal(document.schema_version,"investor-monitor-data-input-v4"); assert.ok(settings.cost_assumptions);
    assert.equal(readInvestorMonitorEvidenceSource(f.db,saved.workspace_id!,saved.model_watch!.id,row.id as string,"2026-01-03T12:01:04.000Z").unavailable_reason,null);
    for (const [index,mode] of ["missing","null","forged"].entries()) {
      const modified=structuredClone(document), costs=(modified.settings as Obj), id=`fictional-invalid-v4-cost-${index}`;
      if(mode === "missing")delete costs.cost_assumptions;
      else if(mode === "null")costs.cost_assumptions=null;
      else costs.cost_assumptions={...(costs.cost_assumptions as Obj),content_hash:"0".repeat(64)};
      const before=f.db.prepare("SELECT count(*) n FROM audit_events").get();
      assert.throws(()=>f.db.transaction(()=>{
        f.db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,'synthetic-investor','investor_admit_monitor_source','investor_monitor_evidence_input',?,?,?)")
          .run(id,id,canonical({content_hash:hash(modified)}),row.created_at);
        f.db.prepare("INSERT INTO investor_monitor_evidence_inputs(id,workspace_id,model_id,source_qualification,document_json,content_hash,actor_id,created_at,valid_until,audit_id) VALUES(?,?,?,'owner_reviewed_reconstructed',?,?,'synthetic-investor',?,?,?)")
          .run(id,row.workspace_id,row.model_id,canonical(modified),hash(modified),row.created_at,row.valid_until,id);
      })(),/cost assumptions differ/);
      assert.deepEqual(f.db.prepare("SELECT count(*) n FROM audit_events").get(),before);
    }
    noFinance(f);
  } finally {f.close();}
});
