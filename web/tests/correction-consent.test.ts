import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { investorFixture } from "./investor-fixture";
import { actionPython, probeActionMutation, resealActionRow } from "./action-maintenance-fixture";
import { hash } from "../src/server/ledger/service";
import { readCorrectionConsentBaseline, readCorrectionConsentReceipt } from "../src/server/investor/correction-consent";
import { validateCorrectionConsent } from "../src/server/investor/kernel-contracts";

const at = "2026-11-07T06:00:04.003Z", owner = { id: "synthetic-investor" };
test("independent read-only Node replay authenticates explicit consent, original source bytes and the exact corrected economic baseline", t => {
  const f = investorFixture(); t.after(f.close);
  const result = actionPython(f.filename, `
from tests.investor.test_correction_consent import CorrectionConsentTests,AT
db.execute("INSERT INTO investor_workspaces VALUES('w','synthetic-investor',0,'2026-11-01T05:00:03.000Z')")
case=CorrectionConsentTests();case.db=db;case.path=Path(sys.argv[1]);case.seed()
try:
 result=case.finish(case.enqueue());assert result['outcome']=='confirmed',result
 print(json.dumps({'id':result['confirmation_id'],'difference':case.impact_result['impact']['comparison']['difference_cny']}))
finally:case.doCleanups()
`, "legacy_transition");
  const reader = new Database(f.filename, { readonly: true });
  try {
    const receipt = readCorrectionConsentReceipt(reader, "w", owner, result.id as string, at);
    const baseline = readCorrectionConsentBaseline(reader, "w", owner, result.id as string, at);
    assert.equal(baseline.confirmation_id, receipt.confirmation_id); assert.equal(receipt.source_values_included, false);
    assert.doesNotMatch(JSON.stringify(receipt), /"(?:baseline|quantities|cash_by_currency|approved_facts|comparison|tax_per_unit|gross_per_unit)":/);
    assert.equal((baseline.baseline as Record<string, unknown>).status, "approved_baseline_requires_new_current_data_protocol");
    assert.equal(baseline.economic_correction_approved, true); assert.equal(baseline.monitoring_resumed, false);
    assert.equal(baseline.checkpoint_created, false);
    assert.equal(((baseline.baseline as Record<string, unknown>).valuation_summary as Record<string, unknown>).difference_cny, result.difference);
    assert.equal((reader.prepare("SELECT total_changes() n").get() as { n: number }).n, 0);
    assert.throws(() => readCorrectionConsentReceipt(reader, "w", { id: "foreign" }, result.id as string, at));
    const original = reader.prepare("SELECT document_json FROM investor_monitor_evidence_inputs ORDER BY rowid DESC LIMIT 1").get() as { document_json: string };
    assert.notEqual(JSON.parse(original.document_json).schema_version, "investor-approved-restatement-baseline-v1");
    for (const name of ["portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"])
      assert.equal((reader.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n, 0);
  } finally { reader.close(); }
  const input = readCorrectionConsentBaseline(f.db, "w", owner, result.id as string, at).request as object;
  for (const patch of [{ enable_rule: true }, { new_events: [] }, { acknowledgements: {} }])
    assert.throws(() => validateCorrectionConsent("submit", { ...input, ...patch }));
  probeActionMutation(f.db, ["investor_correction_consents", "investor_correction_consent_results", "audit_events"], () => {
    resealActionRow(f.db, "investor_correction_consents", result.id as string, doc => {
      const b = doc.baseline as Record<string, unknown>, e = b.economics as Record<string, unknown>;
      (e.quantities as Record<string, unknown>)["synthetic-3141"] = "99999";
    });
    const stored = f.db.prepare("SELECT document_json FROM investor_correction_consents WHERE id=?").get(result.id) as { document_json: string };
    const r = f.db.prepare("SELECT id FROM investor_correction_consent_results WHERE confirmation_id=?").get(result.id) as { id: string };
    resealActionRow(f.db, "investor_correction_consent_results", r.id, doc => { doc.confirmation_hash = hash(JSON.parse(stored.document_json)); });
  }, () => {
    assert.doesNotThrow(() => readCorrectionConsentReceipt(f.db, "w", owner, result.id as string, at));
    assert.throws(() => readCorrectionConsentBaseline(f.db, "w", owner, result.id as string, at));
  });
  probeActionMutation(f.db, ["investor_issuer_payloads"], () => {
    const row = f.db.prepare("SELECT raw_sha256,payload FROM investor_issuer_payloads ORDER BY rowid DESC LIMIT 1").get() as { raw_sha256: string; payload: Buffer };
    const raw = Buffer.from(row.payload); raw[raw.length - 1] ^= 1;
    f.db.prepare("UPDATE investor_issuer_payloads SET payload=? WHERE raw_sha256=? AND workspace_id='w'").run(raw, row.raw_sha256);
  }, () => assert.throws(() => readCorrectionConsentBaseline(f.db, "w", owner, result.id as string, at)));
  actionPython(f.filename, `
from worker.investor import eodhd_sources
grant=db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchall();assert len(grant)==1
eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',grant[0][0],False,now='${at}')
print('{}')
`);
  assert.doesNotThrow(() => readCorrectionConsentReceipt(f.db, "w", owner, result.id as string, at));
  assert.throws(() => readCorrectionConsentBaseline(f.db, "w", owner, result.id as string, at));
});
