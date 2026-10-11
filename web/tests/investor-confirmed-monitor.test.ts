import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { investorActor as actor, investorFixture, saveSyntheticProfile, syntheticProfile } from "./investor-fixture";
import { canonical, hash } from "../src/server/ledger/service";
import { executeInvestorCommand, getInvestorState } from "../src/server/investor/service";
import { readInvestorDataSnapshot } from "../src/server/investor/source-inputs";
import { readInvestorMonitorEvidenceSource, replayInvestorMonitorData } from "../src/server/investor/monitor-source";
import { prepareInvestorAiExplanation } from "../src/server/investor/ai-explanation-context";
import { parseInvestorState } from "../src/components/workbench/investor-client";

type Obj = Record<string, unknown>;
type F = ReturnType<typeof investorFixture>;
type Fixture = { definition: Obj; document: Obj; projection: Obj; reference_targets: Obj[]; registered_input_id: string | null;
  confirmed_capture_ids: string[]; rights_review_id: string; real_provider_called: boolean; real_gateway_called: boolean };
const now = "2026-01-02T12:05:03.000Z", current = "2026-01-02T12:05:04.000Z";
function helper(f: F, module: string, args: string[] = []) {
  return JSON.parse(execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-m", module, "--db", f.filename, ...args], {
    cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 60000, maxBuffer: 262144, stdio: ["ignore", "pipe", "pipe"],
  })) as Fixture;
}
function seed(f: F, args: string[] = []) { return helper(f, "tests.investor.confirmed_monitor_fixture", args); }
function savedReference(f: F, fixed = false, externalAi = false) {
  saveSyntheticProfile(f, actor, { ...syntheticProfile, loss_tolerance: "0.30", illustrative_budget_cny: "98765.43" });
  helper(f, "tests.investor.evidence_fixture", [...(fixed ? ["--fixed-policy-v2"] : []), ...(externalAi ? ["--external-ai"] : [])]);
  helper(f, "tests.investor.queue_fixture", ["--mode", "core"]);
  const at = "2026-01-02T12:00:04.000Z", state = getInvestorState(f.db, actor, at); assert.ok(state.plan);
  executeInvestorCommand(f.db, actor, { action: "save_plan", plan_id: state.plan.id, expected_revision: state.revision,
    idempotency_key: "save-confirmed-reference" }, at);
  return getInvestorState(f.db, actor, at);
}
function noFinance(f: F) {
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
}
function python(f: F, code: string, args: string[]) {
  execFileSync(process.env.WORKBENCH_TEST_PYTHON ?? "python3", ["-c", code, f.filename, ...args], {
    cwd: path.resolve(process.cwd(), ".."), encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
  });
}

test("Node independently replays same-day CN/HK callbacks and the prior US holiday close without research admission", () => {
  const f = investorFixture();
  try {
    const value = seed(f); assert.equal(value.real_provider_called, false); assert.equal(value.real_gateway_called, false);
    assert.equal(value.document.schema_version, "investor-monitor-data-input-v2");
    const before = f.db.prepare("SELECT total_changes() n").get();
    const read = replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, value.document, now);
    assert.equal(read.unavailable_reason, null); assert.deepEqual(read.projection, value.projection);
    assert.deepEqual((read.projection!.quotes as Obj[]).map(row => [row.market, row.observed_at]).sort(), [
      ["CN", "2026-01-02T07:00:00.000Z"], ["HK", "2026-01-02T08:00:00.000Z"], ["US", "2026-01-01T20:00:00.000Z"],
    ]);
    const segment = (value.document.segments as Obj[]).find(row => (row.snapshot as Obj).schema_version === "investor-monitor-price-snapshot-v1")!;
    assert.throws(() => readInvestorDataSnapshot(f.db, "w", segment, now), /EVIDENCE_INVALID/);
    assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
  } finally { f.close(); }
});

test("new monitor format rejects legacy relabels, wrong capture kinds, hashes, caller prices and future reads", () => {
  const f = investorFixture();
  try {
    const value = seed(f), replay = (document: Obj, at = now) => replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, document, at);
    const bad = (mutate: (document: Obj) => void) => { const copy = structuredClone(value.document); mutate(copy); assert.throws(() => replay(copy), /EVIDENCE_INVALID/); };
    bad(copy => { copy.schema_version = "investor-monitor-data-input-v1"; });
    bad(copy => { copy.schema_version = "investor-monitor-data-input-v3"; });
    bad(copy => { copy.quotes = [{ close: "100" }]; });
    bad(copy => { copy.live_advice_eligible = true; });
    bad(copy => { copy.projection_hash = "a".repeat(64); });
    for (const kind of ["historical_sdk", "unknown"]) bad(copy => {
      const snapshot = (copy.segments as Obj[])[0].snapshot as Obj;
      const ref = (snapshot.capture_refs as Obj[]).find(row => row.kind === "confirmed_sdk")!; ref.kind = kind;
    });
    assert.throws(() => replay(value.document, "2026-01-02T12:05:02.000Z"), /EVIDENCE_INVALID/); noFinance(f);
  } finally { f.close(); }
});

test("source withdrawal, expiry, audited purge and payload corruption fail closed for confirmed monitor data", () => {
  for (const mode of ["withdrawn", "expired", "purged", "payload"] as const) {
    const f = investorFixture();
    try {
      const value = seed(f); let at = now, expected: string | null = null;
      if (mode === "expired") { at = value.document.valid_until as string; expected = "REFERENCE_SOURCE_EXPIRED"; }
      if (mode === "withdrawn" || mode === "purged") {
        python(f, "import sys; from worker.orchestration.db import open_database; from worker.investor.data_evidence import review_source; db=open_database(sys.argv[1]); source=db.execute('SELECT source_id FROM investor_data_reviews WHERE id=?',(sys.argv[2],)).fetchone()[0]; review_source(db,'w','synthetic-investor',source,'withdrawn',None,'Fictional withdrawal','2027-01-01T00:00:00.000Z',now=sys.argv[3]); db.close()", [value.rights_review_id, now]);
        expected = "REFERENCE_SOURCE_NO_LONGER_CURRENT";
      }
      if (mode === "purged") {
        python(f, "import sys; from worker.orchestration.db import open_database; from worker.investor.confirmed_capture import purge_confirmed_payload; db=open_database(sys.argv[1]); purge_confirmed_payload(db,'w','synthetic-investor',sys.argv[2],now=sys.argv[3]); db.close()", [value.confirmed_capture_ids[0], now]);
        assert.equal(f.db.prepare("SELECT 1 FROM investor_confirmed_payloads WHERE capture_id=?").get(value.confirmed_capture_ids[0]), undefined);
        assert.ok(f.db.prepare("SELECT 1 FROM investor_confirmed_purges WHERE capture_id=?").get(value.confirmed_capture_ids[0]));
      }
      if (mode === "payload") {
        f.db.exec("DROP TRIGGER investor_confirmed_payload_no_update");
        f.db.prepare("UPDATE investor_confirmed_payloads SET projection=? WHERE capture_id=?").run(Buffer.from("{}"), value.confirmed_capture_ids[0]);
        assert.throws(() => replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, value.document, at), /EVIDENCE_INVALID/);
      } else {
        const result = replayInvestorMonitorData(f.db, "w", value.definition, value.reference_targets, value.document, at);
        assert.equal(result.projection, null); assert.equal(result.unavailable_reason, expected);
      }
      noFinance(f);
    } finally { f.close(); }
  }
});

test("both saved model versions publish grouped confirmed callbacks through default core and readonly Node GET", () => {
  for (const fixed of [false, true]) {
    const f = investorFixture();
    try {
      const saved = savedReference(f, fixed), value = seed(f, ["--admit", "--monitor", "--grouped"]);
      assert.equal(new Set(value.confirmed_capture_ids).size, 1); assert.ok(value.registered_input_id);
      const before = f.db.prepare("SELECT total_changes() n").get();
      const input = readInvestorMonitorEvidenceSource(f.db, saved.workspace_id!, saved.model_watch!.id, value.registered_input_id!, current);
      assert.equal(input.unavailable_reason, null); assert.deepEqual(input.projection, value.projection);
      const state = getInvestorState(f.db, actor, current);
      assert.equal(state.effective_outcome, fixed ? "decision_required" : "observe");
      assert.equal(state.model_watch?.status, fixed ? "research_decision" : "research_observe");
      assert.equal(state.model_watch?.checkpoint_sequence, 1); assert.equal(state.latest?.document.monitoring, "active");
      assert.equal(state.live_advice_eligible, false); assert.equal(hash(state.latest!.document), state.latest!.content_hash);
      assert.deepEqual(parseInvestorState({ ...state, session_binding: "a".repeat(64) }, "a".repeat(64)), state);
      assert.throws(() => readInvestorMonitorEvidenceSource(f.db, "foreign", saved.model_watch!.id, value.registered_input_id!, current), /EVIDENCE_INVALID/);
      assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
    } finally { f.close(); }
  }
});

test("AI context requires historical and every grouped callback target grant without calling a gateway", () => {
  for (const [researchAi, monitorAi, secondDenied] of [[false, true, false], [true, false, false], [true, true, true], [true, true, false]]) {
    const f = investorFixture();
    try {
      savedReference(f, true, researchAi);
      const value = seed(f, ["--admit", "--monitor", "--grouped", "--funding", ...(monitorAi ? ["--external-ai"] : []), ...(secondDenied ? ["--deny-second-confirmed-ai"] : [])]);
      const before = f.db.prepare("SELECT total_changes() n").get();
      if (!researchAi || !monitorAi || secondDenied) assert.throws(() => prepareInvestorAiExplanation(f.db, actor, current), /SOURCE_SHARING_NOT_APPROVED/);
      else {
        const prepared = prepareInvestorAiExplanation(f.db, actor, current), raw = canonical(prepared.context);
        assert.equal(prepared.context.deterministic_outcome, "decision_required"); assert.equal(hash(prepared.context), prepared.context_hash);
        for (const denied of ["98765.43", "1000", "CN:ALPHA", "CN:BETA", "501998.SH", "501999.SH", prepared.workspace_id,
          prepared.observation_id, "model_nav_cny", "account_region", "rights_review_id", ...value.confirmed_capture_ids]) assert.ok(!raw.includes(denied), denied);
        assert.equal(prepared.context.strategy_gates.live_advice_eligible, false);
      }
      assert.equal(value.real_gateway_called, false); assert.deepEqual(f.db.prepare("SELECT total_changes() n").get(), before); noFinance(f);
    } finally { f.close(); }
  }
});
