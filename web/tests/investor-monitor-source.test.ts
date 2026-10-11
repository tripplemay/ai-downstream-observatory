import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { readInvestorMonitorEvidenceSource, replayInvestorMonitorData } from "../src/server/investor/monitor-source";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { parseInvestorState } from "../src/components/workbench/investor-client";
import { EvidenceActionRestatement, EvidenceCheckpointLimitRequired, replayEvidenceModel } from "../src/server/investor/evidence-model-state";
import { replayEvidenceAssessment } from "../src/server/investor/evidence-model-assessment";

const now = "2026-01-03T12:00:03.000Z";
type Obj = Record<string, unknown>;
function helper(f: ReturnType<typeof investorFixture>, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] })) as {
      definition: Obj; document: Obj; projection: Obj; reference_targets: Obj[]; real_provider_called: boolean; rights_review_id: string; registered_input_id: string | null };
}
function seed(f: ReturnType<typeof investorFixture>, stale = false, admit = false) {
  return helper(f, "tests.investor.monitor_data_fixture", [...(stale ? ["--stale"] : []), ...(admit ? ["--admit"] : [])]);
}
function savedReference(f: ReturnType<typeof investorFixture>) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30" });
  helper(f, "tests.investor.evidence_fixture"); helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const current = "2026-01-02T12:00:04.000Z", state = getInvestorState(f.db, actor, current);
  assert.ok(state.plan);
  executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision, idempotency_key: "save-monitor-fixture" }, current);
  return getInvestorState(f.db, actor, current);
}
function noFinance(f: ReturnType<typeof investorFixture>) {
  for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
}

test("Node independently reproduces fictional three-market monitor projection from retained SDK receipts", () => {
  const f = investorFixture();
  try {
    const value = seed(f); assert.equal(value.real_provider_called, false);
    const before = f.db.prepare("SELECT total_changes() n").get();
    const result = replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, value.document, now);
    assert.equal(result.unavailable_reason, null); assert.deepEqual(result.projection, value.projection);
    assert.deepEqual(result.projection!.quality_gaps, []);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    assert.deepEqual(replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, value.document, result.projection!.valid_until),
      { projection: null, catalog: null, unavailable_reason: "MONITOR_DATA_PROJECTION_EXPIRED" });
    noFinance(f);
  } finally { f.close(); }
});

test("selected fictional reconstructed model admits metadata idempotently and independently binds audit, profile and source", () => {
  const f = investorFixture();
  try {
    const saved = savedReference(f), model = saved.model_watch!.id, workspace = saved.workspace_id!;
    const jobs = f.db.prepare("SELECT * FROM job_runs ORDER BY rowid").all();
    const controls = f.db.prepare("SELECT * FROM investor_model_controls ORDER BY rowid").all();
    const value = seed(f, false, true); assert.equal(value.real_provider_called, false); assert.ok(value.registered_input_id);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_monitor_evidence_inputs").get() as { n: number }).n, 1);
    const before = f.db.prepare("SELECT total_changes() n").get();
    const read = () => readInvestorMonitorEvidenceSource(f.db, workspace, model, value.registered_input_id!, "2026-01-03T12:00:04.000Z");
    const source = read(); assert.deepEqual(source.projection, value.projection); assert.deepEqual(source.document, value.document);
    assert.equal(source.unavailable_reason, null);
    assert.equal(source.document.quotes, undefined); assert.equal(source.document.fx, undefined);
    const expired = readInvestorMonitorEvidenceSource(f.db, workspace, model, value.registered_input_id!, value.projection.valid_until as string);
    assert.equal(expired.projection, null); assert.equal(expired.unavailable_reason, "MONITOR_DATA_PROJECTION_EXPIRED");
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    assert.deepEqual(f.db.prepare("SELECT * FROM job_runs ORDER BY rowid").all(), jobs);
    assert.deepEqual(f.db.prepare("SELECT * FROM investor_model_controls ORDER BY rowid").all(), controls);
    const still = getInvestorState(f.db, actor, "2026-01-03T12:00:04.000Z");
    assert.equal(still.model_watch?.status, "awaiting_evaluation"); assert.equal(still.model_watch?.model_nav_cny, null);
    assert.throws(() => readInvestorMonitorEvidenceSource(f.db, "foreign", model, value.registered_input_id!, now), /EVIDENCE_INVALID/);
    assert.throws(() => readInvestorMonitorEvidenceSource(f.db, workspace, "foreign", value.registered_input_id!, now), /EVIDENCE_INVALID/);
    for (const sql of ["UPDATE investor_monitor_evidence_inputs SET content_hash='x'", "DELETE FROM investor_monitor_evidence_inputs"])
      assert.throws(() => f.db.exec(sql), /immutable/);
    executeInvestorCommand(f.db, actor, { action: "save_profile", expected_revision: still.revision, idempotency_key: "changed-after-monitor-input",
      profile: { ...syntheticProfile, loss_tolerance: "0.30", horizon_years: 13 } }, "2026-01-03T12:00:04.000Z");
    assert.throws(read, /EVIDENCE_INVALID/);
    noFinance(f);
  } finally { f.close(); }
});

test("stored monitor admission cannot survive resealed projection metadata or an invalid audit", () => {
  for (const mode of ["metadata", "audit"] as const) {
    const f = investorFixture();
    try {
      const saved = savedReference(f), value = seed(f, false, true);
      f.db.exec("DROP TRIGGER audit_events_no_update");
      if (mode === "metadata") {
        const document = { ...value.document, projection_hash: "a".repeat(64) };
        f.db.exec("DROP TRIGGER investor_monitor_evidence_no_update");
        f.db.prepare("UPDATE investor_monitor_evidence_inputs SET document_json=?,content_hash=?").run(canonical(document), hash(document));
        // Even re-sealing the metadata and its audit cannot change the receipt-derived projection.
        f.db.prepare("UPDATE audit_events SET payload_json=? WHERE id=(SELECT audit_id FROM investor_monitor_evidence_inputs)").run(canonical({ content_hash: hash(document) }));
      } else f.db.prepare("UPDATE audit_events SET actor_id='foreign' WHERE id=(SELECT audit_id FROM investor_monitor_evidence_inputs)").run();
      assert.throws(() => readInvestorMonitorEvidenceSource(f.db, saved.workspace_id!, saved.model_watch!.id, value.registered_input_id!, now), /EVIDENCE_INVALID/);
      noFinance(f);
    } finally { f.close(); }
  }
});

test("independent monitor replay does not fill stale prices or grant synthetic/live qualification", () => {
  const f = investorFixture();
  try {
    const value = seed(f, true);
    const result = replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, value.document, now);
    assert.deepEqual(result.projection, value.projection); assert.deepEqual(result.projection!.quotes, []);
    assert.deepEqual(result.projection!.quality_gaps, ["MONITOR_PRICE_EXPIRED_CN", "MONITOR_PRICE_EXPIRED_HK", "MONITOR_PRICE_EXPIRED_US"]);
    for (const change of [{ model_id: "foreign" }, { workspace_id: "foreign" }, { projection_hash: "a".repeat(64) },
      { source_qualification: "synthetic_test_only" }, { live_advice_eligible: true }, { quotes: [{ close: "100" }] }])
      assert.throws(() => replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, { ...value.document, ...change }, now), /EVIDENCE_INVALID/);
    const targets = structuredClone(value.reference_targets); targets[0].symbol = "DIFFERENT.US";
    assert.throws(() => replayInvestorMonitorData(f.db, "w", value.definition, targets, value.document, now), /EVIDENCE_INVALID/);
    noFinance(f);
  } finally { f.close(); }
});

test("withdrawn, expired or damaged retained evidence cannot expose a monitor price projection", () => {
  for (const mode of ["withdrawn", "expired", "payload"] as const) {
    const f = investorFixture();
    try {
      const value = seed(f);
      if (mode === "expired") {
        assert.equal(replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, value.document, value.document.valid_until as string).unavailable_reason, "REFERENCE_SOURCE_EXPIRED");
      } else if (mode === "payload") {
        f.db.exec("DROP TRIGGER investor_price_payload_no_update"); f.db.prepare("UPDATE investor_price_payloads SET projection=?").run(Buffer.from("{}"));
        assert.throws(() => replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, value.document, now), /EVIDENCE_INVALID/);
      } else {
        const row = f.db.prepare("SELECT * FROM investor_data_reviews WHERE id=?").get(value.rights_review_id) as Obj;
        const document = { ...JSON.parse(row.document_json as string), version: 2, decision: "withdrawn", facts: null, reason: "Fictional withdrawal only" };
        f.db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('monitor-withdraw-audit','synthetic-investor','investor_review_data_source','investor_data_review','monitor-withdraw',?,?)").run(canonical({ content_hash: hash(document) }), now);
        f.db.prepare("INSERT INTO investor_data_reviews(id,workspace_id,source_id,version,decision,document_json,content_hash,actor_id,created_at,valid_until,audit_id) VALUES('monitor-withdraw','w',?,2,'withdrawn',?,?,'synthetic-investor',?,?,'monitor-withdraw-audit')")
          .run(row.source_id, canonical(document), hash(document), now, row.valid_until);
        const result = replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, value.document, now);
        assert.equal(result.projection, null); assert.equal(result.unavailable_reason, "REFERENCE_SOURCE_NO_LONGER_CURRENT");
      }
      noFinance(f);
    } finally { f.close(); }
  }
});

test("default core publishes a fictional qualified observation independently replayed by Node", () => {
  const f = investorFixture();
  try {
    savedReference(f);
    helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--later"]);
    const before = f.db.prepare("SELECT total_changes() n").get();
    const state = getInvestorState(f.db, actor, "2026-01-03T12:15:04.000Z");
    assert.equal(state.effective_outcome, "observe"); assert.equal(state.model_watch?.status, "research_observe");
    assert.equal(state.model_watch?.checkpoint_sequence, 1); assert.equal(state.model_watch?.model_nav_cny, "10000");
    assert.equal(state.latest?.document.model_change?.model_nav_cny, "10000");
    assert.equal(state.latest?.document.monitoring, "active"); assert.equal(state.live_advice_eligible, false);
    assert.equal(hash(state.latest!.document), state.latest!.content_hash);
    assert.deepEqual(parseInvestorState({ ...state, session_binding: "a".repeat(64) }, "a".repeat(64)), state);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
    const overdue = getInvestorState(f.db, actor, "2026-01-03T12:30:00.000Z");
    assert.equal(overdue.model_watch?.status, "overdue"); assert.equal(overdue.model_watch?.model_nav_cny, null);
    assert.equal(overdue.effective_outcome, "insufficient_evidence");
    noFinance(f);
  } finally { f.close(); }
});

test("legacy qualified steps and a sparse upgrade retain independently verifiable state", () => {
  const f = investorFixture();
  try {
    savedReference(f);
    helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--later", "--legacy-monitor"]);
    const state = getInvestorState(f.db, actor, "2026-01-03T12:15:04.000Z");
    assert.equal(state.effective_outcome, "observe"); assert.equal(state.model_watch?.checkpoint_sequence, 2);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_evidence_monitor_runs").get() as { n: number }).n, 3);
    assert.equal((f.db.prepare("SELECT count(*) n FROM investor_evidence_model_checkpoints").get() as { n: number }).n, 2);
    noFinance(f);
  } finally { f.close(); }
});

test("sparse cross-language arithmetic rechecks FX and funding while preserving unit lineage", () => {
  const raw = execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", "tests.investor.evidence_model_fixture"],
    { cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 30000, maxBuffer: 131072, stdio: ["ignore","pipe","pipe"] });
  const fixture = JSON.parse(raw) as { definition: Obj; cases: { projection: Obj; previous: Obj | null; now: string; result: Obj | null; error: string | null }[]; real_provider_called: boolean };
  assert.equal(fixture.real_provider_called, false);
  for (const [index,caseValue] of fixture.cases.entries()) {
    const replay = () => replayEvidenceModel(fixture.definition, caseValue.projection, caseValue.previous, caseValue.now, "b".repeat(64), true);
    if (caseValue.error) {
      assert.throws(replay, error => (error instanceof EvidenceCheckpointLimitRequired || error instanceof EvidenceActionRestatement) && error.message === caseValue.error);
    } else {
      const result = replay(), expected = caseValue.result!;
      assert.deepEqual(result.checkpoint, expected.checkpoint, `case ${index} checkpoint`);
      assert.deepEqual(result.document, (expected.monitor_request as Obj).document, `case ${index} monitor document`);
      const assessment = expected.assessment as Obj;
      assert.deepEqual(replayEvidenceAssessment(result.document, caseValue.now, assessment.implementation_hash as string), assessment, `case ${index} assessment`);
    }
  }
});

test("awaiting and queued monitoring reject future controls, future admissions and an unbound job", () => {
  for (const mode of ["control","input","job"] as const) {
    const f = investorFixture();
    try {
      savedReference(f);
      helper(f, "tests.investor.monitor_data_fixture", ["--admit", ...(mode === "job" ? ["--queue"] : [])]);
      const at = "2026-01-03T12:00:04.000Z";
      assert.equal(getInvestorState(f.db, actor, at).model_watch?.status, mode === "job" ? "queued" : "awaiting_evaluation");
      if (mode === "control") {
        f.db.exec("DROP TRIGGER investor_model_control_no_update");
        f.db.prepare("UPDATE investor_model_controls SET created_at=?").run("2026-01-03T12:10:00.000Z");
      } else if (mode === "input") {
        const row = f.db.prepare("SELECT * FROM investor_monitor_evidence_inputs").get() as Obj;
        const document = { ...JSON.parse(row.document_json as string), created_at: "2026-01-03T12:10:00.000Z" };
        f.db.exec("DROP TRIGGER investor_monitor_evidence_no_update");
        f.db.prepare("UPDATE investor_monitor_evidence_inputs SET created_at=?,document_json=?,content_hash=?").run(document.created_at, canonical(document), hash(document));
      } else {
        const row = f.db.prepare("SELECT * FROM investor_evidence_monitor_requests").get() as Obj;
        const document = { ...JSON.parse(row.document_json as string), engine_version: "investor-evidence-model-watcher-v1" };
        f.db.exec("DROP TRIGGER investor_evidence_request_no_update");
        f.db.prepare("UPDATE investor_evidence_monitor_requests SET document_json=?,input_version=?").run(canonical(document), hash(document));
      }
      const before = f.db.prepare("SELECT total_changes() n").get();
      assert.throws(() => getInvestorState(f.db, actor, at), /EVIDENCE_INVALID/);
      assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before);
      noFinance(f);
    } finally { f.close(); }
  }
});

test("qualified funding card can be reviewed without applying the proposed changes", () => {
  const f = investorFixture();
  try {
    savedReference(f);
    const seeded = helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--funding"]);
    const sourceRow = f.db.prepare("SELECT content_hash FROM investor_monitor_evidence_inputs").get() as Obj;
    const rendered = replayEvidenceModel(seeded.definition, seeded.projection, null, now, sourceRow.content_hash as string);
    const stored = f.db.prepare("SELECT payload FROM investor_evidence_run_payloads").get() as { payload: Buffer };
    const assessment = JSON.parse(stored.payload.toString()).assessment;
    assert.deepEqual(replayEvidenceAssessment(rendered.document, now, assessment.implementation_hash), assessment);
    const at = "2026-01-03T12:00:04.000Z", state = getInvestorState(f.db, actor, at);
    assert.equal(state.effective_outcome, "decision_required"); assert.equal(state.model_watch?.status, "research_decision");
    assert.equal(state.latest?.document.model_change?.allocation_method, "contribution_repair_without_sales");
    const quantities = f.db.prepare("SELECT payload FROM investor_evidence_checkpoint_payloads").all();
    assert.deepEqual(parseInvestorState({ ...state, session_binding: "a".repeat(64) }, "a".repeat(64)), state);
    executeInvestorCommand(f.db, actor, { action: "review", decision: "accept_idea", note: "Fictional review, not execution", observation_id: state.latest!.id,
      expected_revision: state.revision, idempotency_key: "fictional-qualified-review" }, at);
    assert.deepEqual(f.db.prepare("SELECT payload FROM investor_evidence_checkpoint_payloads").all(), quantities);
    assert.equal(getInvestorState(f.db, actor, at).decisions[0].decision, "accept_idea");
    noFinance(f);
  } finally { f.close(); }
});

test("resealing a qualified assessment and its displayed cost cannot override independent math", () => {
  const f = investorFixture();
  try {
    savedReference(f); helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor", "--funding"]);
    const row = f.db.prepare("SELECT * FROM investor_evidence_monitor_runs").get() as Obj;
    const raw = f.db.prepare("SELECT payload FROM investor_evidence_run_payloads").get() as { payload: Buffer };
    const value = JSON.parse(raw.payload.toString()), assessment = value.assessment;
    assert.notEqual(assessment.estimated_cost_cny, "0");
    assessment.estimated_cost_cny = "0"; delete assessment.result_hash; assessment.result_hash = hash(assessment);
    value.observation.model_change.estimated_cost_cny = "0"; value.observation.model_change.assessment_hash = assessment.result_hash;
    const run = { ...JSON.parse(row.document_json as string), assessment_hash: assessment.result_hash, payload_hash: hash(value), observation_hash: hash(value.observation) };
    f.db.exec("DROP TRIGGER investor_evidence_run_no_update"); f.db.exec("DROP TRIGGER investor_evidence_run_payload_update");
    f.db.prepare("UPDATE investor_evidence_monitor_runs SET document_json=?,content_hash=? WHERE id=?").run(canonical(run), hash(run), row.id);
    f.db.prepare("UPDATE investor_evidence_run_payloads SET payload=? WHERE run_id=?").run(Buffer.from(canonical(value)), row.id);
    assert.throws(() => getInvestorState(f.db, actor, "2026-01-03T12:00:04.000Z"), /EVIDENCE_INVALID/);
    noFinance(f);
  } finally { f.close(); }
});

test("qualified metadata cannot extend its source lifetime or publish a corrupted checkpoint", () => {
  for (const mode of ["expiry", "units"] as const) {
    const f = investorFixture();
    try {
      savedReference(f); helper(f, "tests.investor.monitor_data_fixture", ["--admit", "--monitor"]);
      if (mode === "expiry") {
        const row = f.db.prepare("SELECT * FROM investor_evidence_monitor_runs").get() as Obj;
        const run = { ...JSON.parse(row.document_json as string), valid_until: "2027-01-01T00:00:00.000Z" };
        f.db.exec("DROP TRIGGER investor_evidence_run_no_update");
        f.db.prepare("UPDATE investor_evidence_monitor_runs SET document_json=?,content_hash=?,valid_until=?").run(canonical(run), hash(run), run.valid_until);
      } else {
        f.db.exec("DROP TRIGGER investor_evidence_checkpoint_payload_update");
        const row = f.db.prepare("SELECT payload FROM investor_evidence_checkpoint_payloads").get() as { payload: Buffer };
        const state = JSON.parse(row.payload.toString()); state.quantities[Object.keys(state.quantities)[0]] = "9999";
        f.db.prepare("UPDATE investor_evidence_checkpoint_payloads SET payload=?").run(Buffer.from(canonical(state)));
      }
      assert.throws(() => getInvestorState(f.db, actor, "2026-01-03T12:00:04.000Z"), /EVIDENCE_INVALID/);
      noFinance(f);
    } finally { f.close(); }
  }
});
