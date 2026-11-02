import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { investorFixture } from "./investor-fixture";
import { actionPython } from "./action-maintenance-fixture";
import { enqueueCorrectionConsent, readCorrectionConsentResponse } from "../src/server/investor/correction-consent-jobs";
import { readCorrectionConsentBaseline } from "../src/server/investor/correction-consent";
import { hash } from "../src/server/ledger/service";

const actor = { id: "synthetic-investor" }, binding = "a".repeat(64), at = "2026-11-07T06:00:04.002Z";
test("ordinary Node intent reaches default core once; bounded GET and reload preserve metadata without qualifying a current state or exposing the baseline", t => {
  const f = investorFixture(); t.after(f.close);
  const seeded = actionPython(f.filename, `
from tests.investor.test_correction_consent import CorrectionConsentTests
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=CorrectionConsentTests();case.db=db;case.path=Path(sys.argv[1])
try:print(json.dumps(case.seed()))
finally:case.doCleanups()
`, "legacy_transition");
  const read = (selection: { impact?: string; request?: string; nonce?: string; model?: string }, db = f.db, now = at) => readCorrectionConsentResponse(db, actor, binding, selection, now);
  const impact = seeded.impact_request_id as string, before = read({ impact }); assert.ok(before.candidate); assert.equal(before.request, null);
  assert.equal(before.candidate.impact_result_hash, seeded.expected_result_hash);
  const tables = ["investor_models", "investor_model_controls", "investor_evidence_model_checkpoints", "investor_monitor_evidence_inputs", "investor_data_reviews", "investor_action_publications", "investor_action_controls"];
  const old = () => hash(tables.map(table => f.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all())); const oldHash = old();
  for (const patch of [{ expected_revision: 0 }, { acknowledgements: {} }, { enable_rule: true }, { tax_per_unit: "0" }])
    assert.throws(() => enqueueCorrectionConsent(f.db, actor, { ...seeded, ...patch }, at));
  assert.throws(() => enqueueCorrectionConsent(f.db, { id: "foreign" }, seeded, at));
  const intent = enqueueCorrectionConsent(f.db, actor, seeded, at);
  assert.deepEqual(enqueueCorrectionConsent(f.db, actor, seeded, at), intent);
  assert.equal(read({ request: intent.request_id as string }).request?.status, "queued");
  assert.equal(read({ impact }).candidate, null); assert.equal(read({ nonce: "fictional-missing" }).request, null);
  assert.throws(() => enqueueCorrectionConsent(f.db, actor, { ...seeded, idempotency_key: "fictional-second" }, at), /BUSY/);
  assert.throws(() => enqueueCorrectionConsent(f.db, actor, { ...seeded, expected_result_hash: "0".repeat(64) }, at), /DUPLICATE_CONFLICT/);
  const result = actionPython(f.filename, `
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.orchestration.runtime import run_pending_once
with offline_protocol_fixture():
 for unused in range(12):
  result=run_pending_once(db,'fictional-ordinary-consent-core',clock=lambda:'${at}')
  row=db.execute('SELECT document_json FROM investor_correction_consent_results').fetchone()
  if row:break
  assert result is not None
 assert row is not None
 print(row[0])
`, "legacy_transition"); assert.equal(result.outcome, "confirmed", JSON.stringify(result));
  const queries: string[] = [], reader = new Database(f.filename, { readonly: true, verbose: sql => queries.push(String(sql)) }); t.after(() => reader.close());
  const value = read({ model: before.candidate.model_id }, reader); assert.equal(value.request?.status, "confirmed"); assert.ok(value.receipt);
  assert.equal(value.candidate, null); assert.equal(value.workspace_revision, before.workspace_revision + 1); assert.equal(old(), oldHash);
  assert.doesNotMatch(JSON.stringify(value), /"(?:baseline|quantities|approved_facts|tax_per_unit|gross_per_unit|cash_by_currency|capture_refs)":/);
  assert.equal((reader.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
  assert.equal(queries.some(sql => /^(INSERT|UPDATE|DELETE|DROP|CREATE)\b/i.test(sql)), false);
  assert.equal(queries.some(sql => /^SELECT.*\b(?:payload|projection)\b.*FROM.*investor_(?:issuer|eodhd|price|confirmed|fx|evidence_checkpoint)_payloads/i.test(sql)), false);
  assert.deepEqual(enqueueCorrectionConsent(f.db, actor, seeded, "2026-11-07T07:00:00.000Z"), intent);
  assert.equal(readCorrectionConsentBaseline(reader, "w", actor, value.receipt.confirmation_id, at).confirmation_id, value.receipt.confirmation_id);
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchall();assert len(grant)==1
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant[0][0],False,now='${at}')
print('{}')
`);
  assert.equal(read({ model: before.candidate.model_id }, reader).receipt!.confirmation_id, value.receipt.confirmation_id);
  assert.throws(() => readCorrectionConsentBaseline(reader, "w", actor, value.receipt!.confirmation_id, at));
  for (const table of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
});
