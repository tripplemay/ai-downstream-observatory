import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { investorFixture } from "./investor-fixture";
import { actionPython } from "./action-maintenance-fixture";
import { hash } from "../src/server/ledger/service";
import { replayModelEpochSource } from "../src/server/investor/model-epoch-source";
import { validateModelEpochSource, validateInvestorMonitorDataDocument } from "../src/server/investor/kernel-contracts";

type Obj = Record<string, unknown>;
const actor = { id: "owner" }, now = "2026-10-20T10:00:03.000Z";
test("independent query-only Node replays current reviewed calendar/SDK/FX and corrected source lineage into an unregistered v6 preparation", t => {
  const f = investorFixture(); t.after(f.close);
  const expected = actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from tests.investor.epoch_source_fixture import create,NOW
from worker.investor.model_epoch_source import prepare_model_epoch_source,replay_model_epoch_source,build_monitor_data
from worker.orchestration.db import content_hash
from copy import deepcopy
with offline_protocol_fixture():
 value=create(db,Path(sys.argv[1]))
 prepared=prepare_model_epoch_source(db,'w','owner',**value,now=NOW)
 later=replay_model_epoch_source(db,'w','owner',prepared['epoch_definition'],prepared['input'],now='2026-10-20T10:00:03.001Z')
 settings=deepcopy(prepared['input']['settings']);settings['policy']['weight_band']='0.9'
 raw=build_monitor_data(db,'w',prepared['kernel_input']['history']['definition'],value['windows'],settings,now=NOW,audited_action_knowledge=True)
 forged=deepcopy(prepared['input']);forged.update(settings=settings,audited_projection_hash=raw['document']['projection_hash'])
 projection=deepcopy(prepared['projection']);projection['economic_projection']['policy']=raw['projection']['policy'];forged['projection_hash']=content_hash(projection)
print(json.dumps({'value':prepared,'later':later,'forged_settings':forged}))
`, "core_readmission");
  const value = expected.value as Obj, candidate = value.candidate as Obj, implementation = (candidate.assessment as Obj).implementation_hash as string;
  const reader = new Database(f.filename, { readonly: true }); t.after(() => reader.close()); reader.pragma("query_only=ON");
  const replay = () => replayModelEpochSource(reader, "w", actor, value.epoch_definition, value.input, now, implementation);
  assert.deepEqual(replay(), value);
  assert.deepEqual(replayModelEpochSource(reader, "w", actor, value.epoch_definition, value.input, "2026-10-20T10:00:03.001Z", implementation), expected.later);
  assert.equal((reader.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
  assert.equal(replay().proof.source_evidence_verified, true); assert.equal(replay().proof.epoch_registered, false);
  assert.equal(replay().candidate.registered_bindings_verified, false);
  assert.throws(() => validateInvestorMonitorDataDocument("input", value.input));
  assert.throws(() => replayModelEpochSource(reader, "w", { id: "foreign" }, value.epoch_definition, value.input, now, implementation));
  for (const change of [{ carry_hash: "0".repeat(64) }, { carry_count: 0 }, { projection_hash: "0".repeat(64) }])
    assert.throws(() => replayModelEpochSource(reader, "w", actor, value.epoch_definition, { ...value.input as Obj, ...change }, now, implementation));
  const alteredEpoch = { ...value.epoch_definition as Obj, original_head_id: "forged" }, alteredInput = structuredClone(value.input as Obj);
  (alteredInput.epoch as Obj).content_hash = hash(alteredEpoch);
  assert.throws(() => replayModelEpochSource(reader, "w", actor, alteredEpoch, alteredInput, now, implementation));
  assert.throws(() => replayModelEpochSource(reader, "w", actor, value.epoch_definition, expected.forged_settings, now, implementation), /SETTINGS_CHANGED/);
  for (const flag of ["epoch_registered", "current_source_eligibility_restored", "checkpoint_created", "monitoring_resumed", "trading_permission"])
    assert.throws(() => validateModelEpochSource("proof", { ...value.proof as Obj, [flag]: true }));
  assert.doesNotMatch(JSON.stringify(value.proof), /"(?:quotes|gross_per_unit|tax_per_unit|quantities|cash_by_currency|tax_assumption)":/);
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
eodhd_sources.set_authority_enabled(db,'w','owner',grant,False,now='${now}')
print('{}')
`);
  assert.throws(replay);
});
