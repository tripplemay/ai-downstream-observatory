import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { investorFixture } from "./investor-fixture";
import { actionPython } from "./action-maintenance-fixture";
import { readRegisteredModelEpoch } from "../src/server/investor/registered-model-epoch";
import { readModelEpochRegistrationHeader } from "../src/server/investor/model-epoch-registration";
import { readEvidenceCheckpoint, readEvidenceMonitorRun } from "../src/server/investor/evidence-monitor";
import { getInvestorState, executeInvestorCommand } from "../src/server/investor/service";
import { validateInvestorMonitorDataDocument, validateModelEpochRegistration } from "../src/server/investor/kernel-contracts";

type Obj = Record<string, unknown>;
const actor = { id: "owner" }, now = "2026-10-20T10:00:03.000Z", stale = "2026-10-20T21:00:03.000Z";
function obj(value: unknown): Obj { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function seed(filename: string, automatic = false) {
  return actionPython(filename, `
from contextlib import ExitStack
from copy import deepcopy
from unittest.mock import patch
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.epoch_registration_fixture import create
from worker.investor import data_evidence,model_epoch_registration as registration
from worker.investor.registered_model_epoch import read_registered_model_epoch
reviewed=data_evidence.review_source;original_preview=registration.register_model_epoch_preview
def explicit_series(connection,workspace,actor,identifier,decision,facts,*args,**kwargs):
 if connection.execute('SELECT kind FROM investor_data_sources WHERE id=?',(identifier,)).fetchone()[0]=='fx':
  facts={**deepcopy(facts),'monitor_series':{'authority_id':'fictional-automatic-epoch-fx','revision_policy':'append_only_no_restatements'}}
 return reviewed(connection,workspace,actor,identifier,decision,facts,*args,**kwargs)
def automatic_preview(connection,workspace,actor,model,*ignored,**kwargs):
 return original_preview(connection,workspace,actor,model,**kwargs)
with offline_protocol_fixture(),ExitStack() as stack:
 if ${automatic ? "True" : "False"}:
  stack.enter_context(patch.object(data_evidence,'review_source',side_effect=explicit_series))
  stack.enter_context(patch.object(registration,'register_model_epoch_preview',side_effect=automatic_preview))
 saved=create(db,Path(sys.argv[1]));identifier=saved['registration']['epoch']['id']
 value=read_registered_model_epoch(db,'w','owner',identifier,now='${now}')
 later=read_registered_model_epoch(db,'w','owner',identifier,now='${stale}')
print(json.dumps({'value':value,'later':later}))
`, "core_readmission");
}

test("independent query-only journal/source/state replay reaches ordinary paused reads from automatically selected inputs; stale or resealed state cannot become current NAV", t => {
  const f = investorFixture(); t.after(f.close); const expected = seed(f.filename, true), value = obj(expected.value), record = obj(value.registration);
  const epochId = String(obj(record.epoch).id), runId = String(record.monitor_run_id), source = obj(value.source), definition = obj(obj(source.kernel_input).history).definition;
  const reader = new Database(f.filename, { readonly: true }); t.after(() => reader.close()); reader.pragma("query_only=ON");
  const replay = () => readRegisteredModelEpoch(reader, "w", actor, epochId, now);
  assert.deepEqual(replay(), value); assert.deepEqual(readRegisteredModelEpoch(reader, "w", actor, epochId, stale), expected.later);
  const model = obj(reader.prepare("SELECT * FROM investor_models WHERE id=?").get(record.model_id));
  assert.deepEqual(readEvidenceCheckpoint(reader, "w", model, obj(definition), obj(record.checkpoint).id, now).checkpoint, obj(source.candidate).checkpoint);
  const current = readEvidenceMonitorRun(reader, "w", runId, now);
  assert.equal(current.unavailable_reason, "MONITOR_EPOCH_CONTINUATION_NOT_ENABLED"); assert.equal(current.observation.outcome, "insufficient_evidence");
  const state = getInvestorState(reader, actor, now);
  assert.equal(state.model_watch?.status, "blocked"); assert.equal(state.model_watch?.model_nav_cny, null);
  assert.equal(state.observations[0].document.monitoring, "paused");
  const staleRead = readEvidenceMonitorRun(reader, "w", runId, stale);
  assert.equal(staleRead.unavailable_reason, "MONITOR_EPOCH_CURRENT_DATA_NOT_READY");
  assert.equal(staleRead.observation.outcome, "insufficient_evidence"); assert.equal(staleRead.observation.model_change, undefined);
  assert.equal(getInvestorState(reader, actor, stale).model_watch?.model_nav_cny, null);
  assert.equal((reader.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
  assert.throws(() => readRegisteredModelEpoch(reader, "w", { id: "foreign" }, epochId, now));
  assert.throws(() => readRegisteredModelEpoch(reader, "w", actor, "fictional-unregistered-epoch", now));
  assert.throws(() => validateInvestorMonitorDataDocument("input", source.input));
  for (const change of [{ monitoring_resumed: true }, { database_writes: 1 }, { current_source_eligibility_restored: true }, { provider_calls: 1 }, { quotes: [] }])
    assert.throws(() => validateModelEpochRegistration("replay_proof", { ...obj(value.proof), ...change }));
  f.db.exec("SAVEPOINT fictional_bad_epoch_tail");
  try {
    f.db.exec("DROP TRIGGER investor_evidence_checkpoint_insert; DROP TRIGGER investor_epoch_checkpoint_insert");
    f.db.prepare(`INSERT INTO investor_evidence_model_checkpoints SELECT 'fictional-unregistered-tail',workspace_id,model_id,input_id,sequence+1,
      content_hash,content_hash,projection_hash,created_at,valid_until FROM investor_evidence_model_checkpoints WHERE id=?`).run(obj(record.checkpoint).id);
    assert.deepEqual(readRegisteredModelEpoch(f.db, "w", actor, epochId, now), value);
    assert.equal(readEvidenceMonitorRun(f.db, "w", runId, now).unavailable_reason, "MONITOR_EPOCH_CONTINUATION_NOT_VERIFIED");
  } finally { f.db.exec("ROLLBACK TO fictional_bad_epoch_tail; RELEASE fictional_bad_epoch_tail"); }
  actionPython(f.filename, `
from tests.investor.registered_epoch_fixture import reseal_wrong_first_state
reseal_wrong_first_state(db,'${epochId}')
print('{}')
`);
  readModelEpochRegistrationHeader(reader, "w", actor, epochId, now);
  assert.throws(replay, /CHECKPOINT_CHANGED/);
  const bad = readEvidenceMonitorRun(reader, "w", runId, now);
  assert.equal(bad.observation.outcome, "insufficient_evidence"); assert.equal(bad.observation.model_change, undefined);
});

test("later owner cost/funding/control choices leave recorded economics unchanged while current cards hide old proposals; revoked providers still block", t => {
  const f = investorFixture(); t.after(f.close); const expected = seed(f.filename), value = obj(expected.value), record = obj(value.registration), epochId = String(obj(record.epoch).id);
  let state = getInvestorState(f.db, actor, now);
  executeInvestorCommand(f.db, actor, { action: "set_monitor_costs", model_id: String(record.model_id), model_hash: state.monitor_costs!.model_hash,
    expected_cost_version: state.monitor_costs!.version, expected_revision: state.revision, idempotency_key: "fictional-recorded-cost-change",
    acknowledged_research_only: true, costs: null, validity_days: null }, "2026-10-20T10:00:04.000Z");
  const later = "2026-10-20T10:00:05.000Z";
  assert.deepEqual(readRegisteredModelEpoch(f.db, "w", actor, epochId, later).source, value.source);
  assert.equal(readEvidenceMonitorRun(f.db, "w", String(record.monitor_run_id), later).unavailable_reason, "MONITOR_COST_ASSUMPTIONS_CHANGED");
  state = getInvestorState(f.db, actor, later);
  executeInvestorCommand(f.db, actor, { action: "save_funding_plan", expected_revision: state.revision, idempotency_key: "fictional-later-funding-plan",
    funding_plan: { schema_version: "investor-funding-plan-v1", start_date: "2026-10-21", horizon_years: 1, evaluation_timezone: "Asia/Shanghai",
      initial_capital_cny: "100.01", annual_contribution_cny: "10.01", first_annual_date: "2027-01-01", entry_method: "three_tranches_60_days",
      actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false } }, later);
  const changed = "2026-10-20T10:00:06.000Z";
  assert.deepEqual(readRegisteredModelEpoch(f.db, "w", actor, epochId, changed).source, value.source);
  assert.equal(readEvidenceMonitorRun(f.db, "w", String(record.monitor_run_id), changed).unavailable_reason, "MONITOR_FUNDING_PLAN_CHANGED");
  state = getInvestorState(f.db, actor, changed);
  executeInvestorCommand(f.db, actor, { action: "set_monitoring", model_id: String(record.model_id), enabled: false,
    expected_revision: state.revision, idempotency_key: "fictional-later-paused-model" }, changed);
  assert.deepEqual(readRegisteredModelEpoch(f.db, "w", actor, epochId, changed).source, value.source);
  const python = actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.investor.registered_model_epoch import read_registered_model_epoch
with offline_protocol_fixture():value=read_registered_model_epoch(db,'w','owner','${epochId}',now='${changed}')
print(json.dumps(value))
`, "core_readmission");
  assert.deepEqual(readRegisteredModelEpoch(f.db, "w", actor, epochId, changed), python);
  assert.equal(getInvestorState(f.db, actor, changed).model_watch?.model_nav_cny, null);
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','owner',grant,False,now='${changed}')
print('{}')
`);
  assert.throws(() => readRegisteredModelEpoch(f.db, "w", actor, epochId, changed));
  const revoked = readEvidenceMonitorRun(f.db, "w", String(record.monitor_run_id), changed);
  assert.equal(revoked.observation.outcome, "insufficient_evidence"); assert.equal(revoked.observation.model_change, undefined);
  for (const table of ["portfolios", "accounts", "ledger_events", "postings"])
    assert.equal((f.db.prepare("SELECT count(*) n FROM " + table).get() as { n: number }).n, 0);
});

test("a real bound funding epoch replays its recorded phase while an intraday due phase invalidates only the current card", t => {
  const f = investorFixture(); t.after(f.close);
  const inputs = actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.epoch_source_fixture import create
with offline_protocol_fixture():value=create(db,Path(sys.argv[1]))
print(json.dumps(value))
`, "core_readmission");
  const state = getInvestorState(f.db, actor, now);
  executeInvestorCommand(f.db, actor, { action: "save_funding_plan", expected_revision: state.revision, idempotency_key: "fictional-original-bound-funding",
    funding_plan: { schema_version: "investor-funding-plan-v1", start_date: "2026-10-20", horizon_years: 1, evaluation_timezone: "Asia/Shanghai",
      initial_capital_cny: "100.01", annual_contribution_cny: "10.01", first_annual_date: "2026-10-21", entry_method: "three_tranches_60_days",
      actual_arrivals_confirmed: false, execution_authorized: false, live_advice_eligible: false } }, now);
  const expected = actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.epoch_registration_fixture import register
from worker.investor.registered_model_epoch import read_registered_model_epoch
with offline_protocol_fixture():
 saved=register(db,json.loads(${JSON.stringify(JSON.stringify(inputs))}));identifier=saved['registration']['epoch']['id']
 before=read_registered_model_epoch(db,'w','owner',identifier,now='${now}')
 due=read_registered_model_epoch(db,'w','owner',identifier,now='2026-10-20T16:00:00.000Z')
print(json.dumps({'before':before,'due':due}))
`, "core_readmission");
  const before = obj(expected.before), record = obj(before.registration), epochId = String(obj(record.epoch).id);
  assert.ok(obj(obj(before.source).input).funding_binding);
  assert.deepEqual(readRegisteredModelEpoch(f.db, "w", actor, epochId, now), before);
  assert.deepEqual(readRegisteredModelEpoch(f.db, "w", actor, epochId, "2026-10-20T16:00:00.000Z"), expected.due);
  const due = readEvidenceMonitorRun(f.db, "w", String(record.monitor_run_id), "2026-10-20T16:00:00.000Z");
  assert.equal(due.unavailable_reason, "MONITOR_FUNDING_CONTEXT_CHANGED");
  assert.equal(due.observation.outcome, "insufficient_evidence"); assert.equal(due.observation.model_change, undefined);
});
