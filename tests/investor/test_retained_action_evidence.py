"""Retained invented reports; never provider, permission or investment acceptance."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import test_managed_actions as fixture
from worker.investor import data_evidence, eodhd_sources, issuer_sources, managed_actions
from worker.investor.retained_action_evidence import read_retained_action_evidence
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, open_database


AT = fixture.LATER
OWNER = "synthetic-investor"


def retained_v5_after_correction(db, path):
    from tests.investor.test_action_restatement_kernel import retained_v5_case
    from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
    from worker.accounting.decimal_math import canonical, decimal
    from worker.investor.action_restatement_kernel import verify_action_restatement_arithmetic
    from worker.investor.source_inputs import _review_kind
    with offline_protocol_fixture():
        value = retained_v5_case(db, path); checked = value["input"]["checked_at"]
        documents = [json.loads(row[0]) for row in db.execute("SELECT document_json FROM investor_monitor_evidence_inputs ORDER BY rowid")]
        identifiers = sorted({ref["review_id"] for document in documents for segment in document["segments"]
            for ref in segment["snapshot"]["review_refs"] if _review_kind(db, "w", ref["review_id"]) == "actions"})
        before_proofs = [read_retained_action_evidence(db, "w", OWNER, identifier, now=checked) for identifier in identifiers]
        changed = next(row for row in value["input"]["corrected_actions"] if row["kind"] == "dividend_ex"
            and row not in value["input"]["original_actions"])
        event_id = changed["id"][len("ex:"):]
        selected = next(row for row in before_proofs if any(event["id"] == event_id for event in row["original_facts"]["events"]))
        original = selected["original_review"]
        if selected["proof"]["authority_id"] is not None:
            identifier = db.execute("SELECT base_review_id FROM investor_action_authorities WHERE id=?", (selected["proof"]["authority_id"],)).fetchone()[0]
            original = data_evidence.review_header(db, "w", identifier, now=checked)["review"]
        facts = json.loads(original["document_json"])["facts"]
        event = next(row for row in facts["events"] if row["id"] == event_id)
        event.update(gross_per_unit=canonical(decimal(changed["net_per_unit"]) + decimal(event["tax_per_unit"])), published_at=checked)
        data_evidence.review_source(db, "w", OWNER, original["source_id"], "approved", facts,
            "Hypothetical fixture correction only; no actual supplier or correction protocol approval", original["valid_until"], now=checked)
        before = list(db.iterdump()); count = db.total_changes
        evidence = [read_retained_action_evidence(db, "w", OWNER, identifier, now=checked) for identifier in identifiers]
        verify_action_restatement_arithmetic(value["input"], value["result"])
        from worker.investor.monitor_data import resolve_monitor_data
        current_document = json.loads(db.execute("SELECT document_json FROM investor_monitor_evidence_inputs WHERE id=?", (value["input_id"],)).fetchone()[0])
        current = resolve_monitor_data(db, "w", value["input"]["definition"], current_document, now=checked)
        assert current["unavailable_reason"] is not None and current["projection"] is None
        assert before == list(db.iterdump()) and count == db.total_changes
        for original, retained in zip(before_proofs, evidence):
            assert all(original[key] == retained[key] for key in ("original_review", "original_source", "original_facts"))
        return {**value, "retained_evidence": evidence}


class RetainedActionEvidenceTests(unittest.TestCase):
    setUp = fixture.ManagedActionTests.setUp
    prepare = fixture.ManagedActionTests.prepare
    policy = fixture.ManagedActionTests.policy
    grant = fixture.ManagedActionTests.grant
    next_source_day = fixture.ManagedActionTests.next_source_day
    assert_no_finance = fixture.ManagedActionTests.assert_no_finance

    def baseline(self, *, official=True):
        self.prepare(official=official)
        if official:
            self.grant()
            self.publication = managed_actions.publish_current_actions(self.db, now=fixture.AT)[0]["publication_id"]
        return self.base["id"]

    def correction(self, decision="approved", *, expiry="2027-01-01T00:00:00.000Z"):
        facts = deepcopy(self.base_facts)
        facts["events"][0]["gross_per_unit"] = "988.1234"
        return data_evidence.review_source(self.db, "w", OWNER, self.base_source["id"], decision,
            facts if decision == "approved" else None, "Fictional historical correction, no trading consent", expiry, now=AT)

    def read(self, identifier=None, *, now=AT, db=None):
        return read_retained_action_evidence(db or self.db, "w", OWNER, identifier or self.publication, now=now)

    def test_superseded_manual_record_is_read_only_and_never_claims_raw_provider_proof(self):
        identifier = self.baseline(); changed = self.correction(); before = list(self.db.iterdump()); count = self.db.total_changes
        value = self.read(identifier)
        self.assertEqual(value["original_facts"], self.base_facts)
        self.assertEqual(value["original_review"]["id"], identifier)
        self.assertEqual(value["proof"]["latest_manual_review_id"], changed["id"])
        self.assertEqual(value["proof"]["evidence_basis"], "owner_review_record_only")
        self.assertFalse(value["proof"]["original_raw_reports_replayed"])
        self.assertEqual(value["proof"]["capture_bindings"], [])
        self.assertNotIn("review", value); self.assertNotIn("facts", value)
        with self.assertRaisesRegex(WorkbenchError, "SUPERSEDED"):
            data_evidence.resolve_review(self.db, "w", identifier, "actions", now=AT)
        self.assertEqual(before, list(self.db.iterdump())); self.assertEqual(count, self.db.total_changes); self.assert_no_finance()

    def test_original_managed_publication_replays_exact_raw_reports_after_base_correction(self):
        self.baseline(); original = managed_actions.resolve_managed_review(self.db, "w", self.publication, now=fixture.AT)
        changed = self.correction(); before = list(self.db.iterdump()); count = self.db.total_changes
        with patch.object(issuer_sources.receiver, "collect_vanguard_distribution_draft", side_effect=AssertionError("NO_PROVIDER")), \
                patch.object(eodhd_sources.receiver, "collect_eodhd_action_draft", side_effect=AssertionError("NO_PROVIDER")):
            value = self.read()
        self.assertEqual(value["original_review"], original["review"]); self.assertEqual(value["original_facts"], original["facts"])
        proof = value["proof"]
        self.assertEqual(proof["latest_manual_review_id"], changed["id"])
        self.assertTrue(proof["original_raw_reports_replayed"]); self.assertEqual(len(proof["capture_bindings"]), 6)
        self.assertEqual(len({row["slot"] for row in proof["capture_bindings"]}), 6)
        for key in ("current_source_eligibility_restored", "economic_correction_approved", "checkpoint_created",
                "monitoring_resumed", "historical_observations_rewritten", "trading_permission"):
            self.assertIs(proof[key], False)
        self.assertNotIn("987.1234", json.dumps(proof)); self.assertNotIn(self.base_facts["tax_assumption"], json.dumps(proof))
        with self.assertRaises(WorkbenchError): managed_actions.resolve_managed_review(self.db, "w", self.publication, now=AT)
        self.assertEqual(before, list(self.db.iterdump())); self.assertEqual(count, self.db.total_changes); self.assert_no_finance()

    def test_retired_maintenance_and_quarantine_are_not_supplier_permission_withdrawal(self):
        self.baseline(); self.next_source_day()
        with patch.object(managed_actions, "_current_refs", return_value=(None, "SOURCE_CAPTURE_TERMINAL_FAILURE")):
            self.assertEqual(managed_actions.publish_current_actions(self.db, now=AT)[0]["status"], "blocked")
        managed_actions.set_authority_enabled(self.db, "w", OWNER, self.authority["id"], False, now=AT)
        self.correction(); before = list(self.db.iterdump())
        self.assertTrue(self.read()["proof"]["original_raw_reports_replayed"])
        self.assertTrue(managed_actions._quarantined(self.db, "w", self.authority["id"], AT))
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_current_supplier_permission_withdrawal_still_stops_original_replay(self):
        self.baseline(); self.correction()
        issuer_sources.set_authority_enabled(self.db, "w", OWNER, self.member["issuer_authority_id"], False, now=AT)
        with self.assertRaisesRegex(WorkbenchError, "AUTHORITY_INACTIVE"): self.read()
        self.assert_no_finance()

    def test_current_eodhd_permission_withdrawal_still_stops_original_replay(self):
        self.baseline(); self.correction()
        authority = self.db.execute("SELECT authority_id FROM investor_eodhd_requests WHERE id=(SELECT request_id FROM investor_eodhd_captures WHERE id=?)",
            (self.member["dividend_capture_id"],)).fetchone()[0]
        eodhd_sources.set_authority_enabled(self.db, "w", OWNER, authority, False, now=AT)
        with self.assertRaises(WorkbenchError): self.read()
        self.assert_no_finance()

    def test_manual_withdrawal_and_reapproval_cannot_silently_resurrect_old_record(self):
        self.baseline(); self.correction("withdrawn")
        with self.assertRaises(WorkbenchError): self.read()
        self.correction()
        with self.assertRaises(WorkbenchError): self.read()
        self.assert_no_finance()

    def test_expired_original_latest_or_publication_never_gets_a_new_deadline(self):
        self.baseline(); self.correction(expiry="2026-11-03T00:00:00.000Z")
        with self.assertRaises(WorkbenchError): self.read(now="2026-11-03T00:00:00.000Z")
        with self.assertRaises(WorkbenchError): self.read(self.base["id"], now=self.base["valid_until"])
        with self.assertRaises(WorkbenchError): self.read(now=self.policy()["valid_until"])
        self.assert_no_finance()

    def test_payload_purge_or_mutated_original_stops_even_with_valid_publication_hashes(self):
        self.baseline(); self.correction()
        self.db.execute("SAVEPOINT fictional_mutation")
        try:
            for trigger in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='investor_issuer_payloads'").fetchall():
                self.db.execute('DROP TRIGGER "' + trigger[0] + '"')
            self.db.execute("UPDATE investor_issuer_payloads SET payload=zeroblob(raw_bytes)")
            with self.assertRaises(ValueError): self.read()
        finally: self.db.execute("ROLLBACK TO fictional_mutation"); self.db.execute("RELEASE fictional_mutation")
        issuer_sources.set_authority_enabled(self.db, "w", OWNER, self.member["issuer_authority_id"], False, now=AT)
        issuer_sources.purge_issuer_capture(self.db, "w", OWNER, self.member["issuer_capture_id"], now=AT)
        with self.assertRaises(WorkbenchError): self.read()
        self.assert_no_finance()

    def test_self_resealed_publication_summary_cannot_replace_original_arithmetic(self):
        self.baseline(); self.correction()
        for trigger in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('investor_action_publications','audit_events')").fetchall():
            self.db.execute('DROP TRIGGER "' + trigger[0] + '"')
        row = self.db.execute("SELECT * FROM investor_action_publications WHERE id=?", (self.publication,)).fetchone()
        doc = json.loads(row["document_json"]); doc["checked_input_hash"] = "0" * 64; digest = content_hash(doc)
        self.db.execute("UPDATE investor_action_publications SET document_json=?,content_hash=? WHERE id=?", (canonical_json(doc), digest, row["id"]))
        self.db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json({"content_hash": digest}), row["audit_id"]))
        with self.assertRaises(WorkbenchError): self.read()
        self.assert_no_finance()

    def test_foreign_owner_future_clock_or_changed_identity_cannot_read(self):
        self.baseline(); self.correction()
        for workspace, owner in (("foreign", OWNER), ("w", "foreign")):
            with self.assertRaises(WorkbenchError): read_retained_action_evidence(self.db, workspace, owner, self.publication, now=AT)
        with self.assertRaises(WorkbenchError): self.read(now=fixture.AT)
        facts = deepcopy(self.base_facts); facts["listing_id"] = "foreign-listing"
        for event in facts["events"]: event["listing_id"] = facts["listing_id"]
        data_evidence.review_source(self.db, "w", OWNER, self.base_source["id"], "approved", facts, "Fictional changed identity",
            "2027-01-01T00:00:00.000Z", now=AT)
        with self.assertRaises(WorkbenchError): self.read()
        self.assert_no_finance()

    def test_read_only_connection_replays_without_database_copies_or_any_mutation(self):
        self.baseline(); self.correction(); before = list(self.db.iterdump())
        with open_database(self.path, read_only=True) as read:
            count = read.total_changes; value = self.read(db=read)
            self.assertEqual(count, read.total_changes)
        self.assertTrue(value["proof"]["original_raw_reports_replayed"])
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_actual_v3_to_v5_recorded_sources_survive_correction_for_comparison_not_current_monitoring(self):
        value = retained_v5_after_correction(self.db, self.path)
        self.assertTrue(any(row["proof"]["original_raw_reports_replayed"] for row in value["retained_evidence"]))
        self.assertEqual(value["input"]["head_projection"]["schema_version"], "investor-monitor-data-projection-v3")
        self.assertNotEqual(value["result"]["difference_cny"], "0")
        self.assertFalse(value["result"]["source_evidence_verified"])
        self.assert_no_finance()
