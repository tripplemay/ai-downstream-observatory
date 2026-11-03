"""Current fictional source preparation, separate from registration and monitoring."""

from contextlib import closing
import json
import unittest
from unittest.mock import patch

from tests.investor import action_reconciliation_fixture as sources, test_managed_actions as managed_fixture
from tests.investor import test_runtime as runtime
from tests.investor import test_correction_consent as consent_fixture
from tests.investor.test_reviewed_action_successor import UpdatedCollector
from tests.market.test_vanguard_distributions import archive, row
from worker.investor import corrected_action_source as corrected, correction_consent as consent, eodhd_sources, managed_actions
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, open_database


OWNER = "synthetic-investor"
AT = consent_fixture.AT
LATER = "2026-11-08T06:00:04.003Z"


class CorrectedActionSourceTests(unittest.TestCase):
    setUp = runtime.InvestorRuntimeTests.setUp
    assert_no_finance = runtime.InvestorRuntimeTests.assert_no_finance
    seed = consent_fixture.CorrectionConsentTests.seed
    enqueue = consent_fixture.CorrectionConsentTests.enqueue
    finish = consent_fixture.CorrectionConsentTests.finish

    def confirmed(self, *, mode="replace"):
        self.seed(mode=mode); result = self.finish(self.enqueue()); self.assertEqual(result["outcome"], "confirmed", result)
        self.identifier = result["confirmation_id"]
        return self.identifier

    def prepare(self, *, now=AT, db=None):
        return corrected.prepare_corrected_action_source(db or self.db, "w", OWNER, self.identifier, now=now)

    def next_reports(self, *, at=LATER, gross="5.32109"):
        case = managed_fixture.ManagedActionTests(); case.db = self.db; case.member = self.value["member"]
        records = [row("987.1234", exDividendDate="2026-09-25", recordDate="2026-09-25", payableDate="2026-09-30"),
            row(gross, exDividendDate="2026-11-05", recordDate="2026-11-05", payableDate="2026-11-09")]
        with patch.object(managed_fixture, "LATER", at), patch.object(sources, "ActionCollector", UpdatedCollector), patch.object(UpdatedCollector, "event_day", "2026-11-05"):
            case.next_source_day(issuer_raw=archive(*records))

    def test_full_baseline_replay_and_current_report_candidate_are_readonly_not_source_publication_or_restored_monitoring(self):
        identifier = self.confirmed(); before = list(self.db.iterdump())
        with closing(open_database(self.path, read_only=True)) as db:
            document = corrected.read_correction_consent_baseline(db, "w", OWNER, identifier, now=AT)
            value = self.prepare(db=db)
            self.assertEqual(value["facts"]["events"], document["baseline"]["approved_facts"]["events"])
            self.assertEqual(value["proof"]["candidate_facts_hash"], content_hash(value["facts"]))
            self.assertEqual(value["proof"]["confirmation_hash"], content_hash(document))
            self.assertEqual(value["proof"]["knowledge_at"], document["baseline"]["knowledge_at"])
            for key in ("current_source_eligibility_restored", "handover_registered", "maintenance_enabled", "checkpoint_created", "monitoring_resumed", "trading_permission"):
                self.assertIs(value["proof"][key], False)
            self.assertEqual(db.total_changes, 0)
        self.assertEqual(value, self.prepare()); self.assertEqual(before, list(self.db.iterdump()))
        # The old short intent/preview is not reused as a new permission clock.
        self.assertEqual(self.prepare(now="2026-11-07T07:00:00.000Z")["facts"], value["facts"])
        for actor in ("foreign", ""):
            with self.assertRaises(WorkbenchError): corrected.prepare_corrected_action_source(self.db, "w", actor, identifier, now=AT)
        with self.assertRaises(WorkbenchError): self.prepare(now="2026-11-11T06:00:00.000Z")
        with patch.object(corrected.consent, "_registered_correction_document", side_effect=AssertionError("NO_STOPPED_REPLAY")) as heavy:
            with self.assertRaises(WorkbenchError): corrected.prepare_corrected_action_source(self.db, "w", OWNER, identifier, now=AT, stop_requested=lambda: True)
        heavy.assert_not_called(); self.assert_no_finance()

    def test_later_complete_unchanged_reports_extend_only_coverage_and_a_new_correction_stops_without_fallback(self):
        self.confirmed(); first = self.prepare()
        with self.assertRaises(WorkbenchError): self.prepare(now=LATER)
        self.next_reports(); before = list(self.db.iterdump()); second = self.prepare(now=LATER)
        self.assertGreater(second["facts"]["range_end"], first["facts"]["range_end"])
        self.assertEqual({k: v for k, v in first["facts"].items() if k != "range_end"}, {k: v for k, v in second["facts"].items() if k != "range_end"})
        self.assertNotEqual(second["proof"]["current_captures"], first["proof"]["current_captures"])
        self.assertEqual(second["proof"]["knowledge_at"], first["proof"]["knowledge_at"])
        self.assertEqual(before, list(self.db.iterdump()))
        # Neither this preparation nor yesterday's valid candidate clears quarantine.
        with self.assertRaises(WorkbenchError): managed_actions.resolve_managed_review(self.db, "w", self.value["authority_id"], now=LATER)
        later = "2026-11-09T06:00:04.003Z"; self.next_reports(at=later, gross="6.32109")
        before = list(self.db.iterdump())
        with self.assertRaises(WorkbenchError): self.prepare(now=later)
        self.assertEqual(before, list(self.db.iterdump()))
        self.assertEqual(consent.read_correction_consent_receipt(self.db, "w", OWNER, self.identifier, now=later)["confirmation_id"], self.identifier)
        self.assert_no_finance()

    def test_self_resealed_wrong_baseline_missing_raw_and_revoked_supplier_never_become_current_sources(self):
        self.confirmed()
        self.db.execute("SAVEPOINT fictional_mutation")
        try:
            for trigger in ("investor_correction_consent_update", "investor_correction_consent_result_update", "audit_events_no_update"):
                self.db.execute("DROP TRIGGER " + trigger)
            row = self.db.execute("SELECT * FROM investor_correction_consents WHERE id=?", (self.identifier,)).fetchone(); doc = json.loads(row["document_json"])
            doc["baseline"]["economics"]["quantities"]["synthetic-3141"] = "99999"; digest = content_hash(doc)
            self.db.execute("UPDATE investor_correction_consents SET document_json=?,content_hash=? WHERE id=?", (canonical_json(doc), digest, self.identifier))
            self.db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json({"content_hash": digest}), row["audit_id"]))
            result = self.db.execute("SELECT * FROM investor_correction_consent_results WHERE confirmation_id=?", (self.identifier,)).fetchone(); output = json.loads(result["document_json"])
            output["confirmation_hash"] = digest; digest = content_hash(output)
            self.db.execute("UPDATE investor_correction_consent_results SET document_json=?,content_hash=? WHERE id=?", (canonical_json(output), digest, result["id"]))
            self.db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json({"content_hash": digest}), result["audit_id"]))
            consent.read_correction_consent_receipt(self.db, "w", OWNER, self.identifier, now=AT)
            with self.assertRaises(WorkbenchError): self.prepare()
        finally: self.db.execute("ROLLBACK TO fictional_mutation"); self.db.execute("RELEASE fictional_mutation")
        self.db.execute("SAVEPOINT fictional_purge")
        try:
            self.db.execute("DROP TRIGGER investor_issuer_payload_delete")
            self.db.execute("DELETE FROM investor_issuer_payloads WHERE rowid=(SELECT max(rowid) FROM investor_issuer_payloads)")
            with self.assertRaises(WorkbenchError): self.prepare()
        finally: self.db.execute("ROLLBACK TO fictional_purge"); self.db.execute("RELEASE fictional_purge")
        eodhd_sources.set_authority_enabled(self.db, "w", OWNER, self.value["member"]["eodhd_authority_id"], False, now=AT)
        with self.assertRaises(WorkbenchError): self.prepare()
        self.assertEqual(consent.read_correction_consent_receipt(self.db, "w", OWNER, self.identifier, now=AT)["confirmation_id"], self.identifier)
        self.assert_no_finance()


if __name__ == "__main__": unittest.main()
