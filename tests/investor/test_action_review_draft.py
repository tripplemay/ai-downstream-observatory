"""Unapproved owner previews from fictional retained receipts, never live calls."""

from copy import deepcopy
import json
import sys
import unittest
from unittest.mock import patch

from tests.investor import action_reconciliation_fixture as sources
from tests.investor import test_managed_actions as fixture
from tests.investor.test_reviewed_action_successor import UpdatedCollector
from tests.market.test_vanguard_distributions import archive, row
from worker.investor import action_review_draft as draft, eodhd_sources, issuer_sources, managed_actions
from worker.orchestration.db import WorkbenchError, open_database


AT = "2026-11-03T06:00:03.001Z"
LATER = "2026-11-03T06:00:04.001Z"


class ActionReviewDraftTests(unittest.TestCase):
    setUp = fixture.ManagedActionTests.setUp
    prepare = fixture.ManagedActionTests.prepare
    policy = fixture.ManagedActionTests.policy
    grant = fixture.ManagedActionTests.grant
    next_source_day = fixture.ManagedActionTests.next_source_day
    assert_no_finance = fixture.ManagedActionTests.assert_no_finance

    def retained_reports(self, *, new_event=True, correction=False, published=True, valid_until=None):
        self.prepare()
        if valid_until is None:
            self.grant()
        else:
            self.authority = managed_actions.register_authority(self.db, "w", "synthetic-investor", self.policy(valid_until=valid_until), now=fixture.AT)
        if published:
            managed_actions.set_authority_enabled(self.db, "w", "synthetic-investor", self.authority["id"], True, now=fixture.AT)
            self.assertEqual(managed_actions.publish_current_actions(self.db, now=fixture.AT)[0]["status"], "published")
        records = [row("987.1235" if correction else "987.1234", exDividendDate="2026-09-25", recordDate="2026-09-25", payableDate="2026-09-30")]
        if new_event:
            records.append(row("4.32109", exDividendDate="2026-11-02", recordDate="2026-11-02", payableDate="2026-11-09"))
        collector = UpdatedCollector if new_event else sources.ActionCollector
        with patch.object(fixture, "LATER", "2026-11-03T06:00:03.000Z"), patch.object(sources, "ActionCollector", collector), \
                patch.object(UpdatedCollector, "event_day", "2026-11-02"):
            self.next_source_day(issuer_raw=archive(*records))

    def inspect(self, *, now=AT, actor="synthetic-investor"):
        return draft.preview_action_review_draft(self.db, "w", actor, self.authority["id"], now=now)

    def test_no_approved_review_or_new_rule_is_needed_and_no_source_is_called(self):
        self.retained_reports(); before = list(self.db.iterdump()); changes = self.db.total_changes
        with patch.object(issuer_sources.receiver, "collect_vanguard_distribution_draft", side_effect=AssertionError("NO_SOURCE_CALL")), \
                patch.object(eodhd_sources.receiver, "collect_eodhd_action_draft", side_effect=AssertionError("NO_SOURCE_CALL")):
            value = self.inspect()
        self.assertEqual(before, list(self.db.iterdump())); self.assertEqual(changes, self.db.total_changes)
        self.assertEqual(value["status"], "new_reported_actions"); self.assertEqual(len(value["changes"]), 1)
        self.assertEqual(value["previous_coverage_end"], "2026-10-31"); self.assertEqual(value["candidate_coverage_end"], "2026-11-02")
        item = value["changes"][0]
        self.assertEqual(item["current"]["issuer"][0]["distribution_amount"], "4.32109")
        self.assertEqual(item["current"]["dividends"][0]["unadjusted_value"], "4.321")
        for field in ("effective_at", "payment_at", "tax_per_unit"): self.assertIsNone(item[field])
        self.assertEqual(value["visibility"], "private_owner_only_not_ai")
        self.assertFalse(value["confirmation_supported"]); self.assertFalse(value["new_review_created"])
        self.assert_no_finance()

    def test_known_old_nominal_difference_does_not_become_a_new_change(self):
        self.retained_reports(new_event=False); before = list(self.db.iterdump()); value = self.inspect()
        self.assertEqual(value["status"], "no_reported_changes"); self.assertEqual(value["changes"], [])
        self.assertEqual(value["source_report"]["comparison"]["counts"]["nominal_amount_differences"], 1)
        self.assertFalse(value["source_report"]["empty_split_list_is_absence_proof"])
        self.assertFalse(value["research_admitted"]); self.assertEqual(before, list(self.db.iterdump()))

    def test_historical_correction_is_shown_alongside_new_event_not_cropped_or_approved(self):
        self.retained_reports(correction=True); before = list(self.db.iterdump()); value = self.inspect()
        self.assertEqual(value["status"], "historical_correction_required")
        self.assertEqual([item["disposition"] for item in value["changes"]], ["historical_correction", "new_report"])
        old = value["changes"][0]
        self.assertEqual(old["previous"]["issuer"][0]["distribution_amount"], "987.1234")
        self.assertEqual(old["current"]["issuer"][0]["distribution_amount"], "987.1235")
        self.assertFalse(value["confirmation_supported"]); self.assertFalse(value["quarantine_cleared"])
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_pending_current_day_is_not_replaced_by_previous_day_or_empty_list(self):
        self.prepare(); self.grant(); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "CURRENT_REPORTS_PENDING"): self.inspect()
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_owner_checked_before_reading_private_sources(self):
        self.retained_reports()
        with patch.object(managed_actions, "_anchor") as private:
            with self.assertRaises(WorkbenchError): self.inspect(actor="fictional-other-owner")
            private.assert_not_called()

    def test_paused_rule_remains_paused_and_changes_the_bound_draft(self):
        self.retained_reports(); original = self.inspect()
        managed_actions.set_authority_enabled(self.db, "w", "synthetic-investor", self.authority["id"], False, now=AT)
        before = list(self.db.iterdump()); paused = self.inspect()
        self.assertFalse(paused["rule_enabled"]); self.assertNotEqual(original["draft_basis_hash"], paused["draft_basis_hash"])
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_same_facts_at_a_later_check_keep_digest_but_not_original_ack_ttl(self):
        self.retained_reports(); before = list(self.db.iterdump()); first, second = self.inspect(), self.inspect(now=LATER)
        self.assertEqual(first["draft_basis_hash"], second["draft_basis_hash"])
        self.assertNotEqual(first["checked_at"], second["checked_at"]); self.assertNotEqual(first["refresh_after"], second["refresh_after"])
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_preview_deadline_is_clipped_to_underlying_rule_expiry(self):
        self.retained_reports(valid_until="2026-11-03T06:00:10.000Z")
        value = self.inspect(); self.assertEqual(value["refresh_after"], "2026-11-03T06:00:10.000Z")

    def test_source_withdrawal_rejects_instead_of_returning_cached_economic_rows(self):
        self.retained_reports(); self.inspect()
        eodhd_sources.set_authority_enabled(self.db, "w", "synthetic-investor", self.member["eodhd_authority_id"], False, now=AT)
        before = list(self.db.iterdump())
        with self.assertRaises(WorkbenchError): self.inspect()
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_genuinely_readonly_connection_and_no_tax_text_in_payload(self):
        self.retained_reports(); before = list(self.db.iterdump()); reader = open_database(self.path, read_only=True)
        try:
            value = draft.preview_action_review_draft(reader, "w", "synthetic-investor", self.authority["id"], now=AT)
            self.assertEqual(reader.total_changes, 0)
        finally:
            reader.close()
        self.assertNotIn(self.base_facts["tax_assumption"], json.dumps(value))
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_first_manual_basis_works_without_positive_old_publication(self):
        self.retained_reports(published=False); value = self.inspect()
        self.assertIsNone(value["previous_publication_id"]); self.assertEqual(value["previous_coverage_end"], "2026-09-30")
        self.assertFalse(value["approval_performed"]); self.assert_no_finance()

    def test_later_reported_date_is_kept_even_outside_common_cutoff(self):
        empty = {kind: {"source": {"range_start": "2026-10-01", "range_end": "2026-10-31"}, "records": []} for kind in draft._FIELDS}
        current = deepcopy(empty)
        current["issuer"]["records"] = [{"ex_date": "2026-11-03", "issuer_type_code": "INC", "distribution_amount": "4.32109", "record_date": "2026-11-03", "pay_date": "2026-11-09"}]
        changes = draft._changes(empty, current, "2026-10-31", "2026-11-02")
        self.assertEqual(len(changes), 1); self.assertTrue(changes[0]["outside_common_coverage"])
        self.assertEqual(changes[0]["date"], "2026-11-03")

    def test_non_display_record_field_change_cannot_disappear_in_projection(self):
        empty = {kind: {"source": {"range_start": "2026-09-01", "range_end": "2026-10-31"}, "records": []} for kind in draft._FIELDS}
        empty["issuer"]["records"] = [{"ex_date": "2026-09-25", "issuer_type_code": "INC", "distribution_amount": "987.1234", "record_date": "2026-09-25", "pay_date": "2026-09-30", "date_precision": "date_not_instant"}]
        changed = deepcopy(empty); changed["issuer"]["records"][0]["date_precision"] = "fictional-parser-change"
        changes = draft._changes(empty, changed, "2026-10-31", "2026-10-31")
        self.assertEqual(changes[0]["disposition"], "historical_correction")
        self.assertNotEqual(changes[0]["previous"]["issuer"][0]["record_hash"], changes[0]["current"]["issuer"][0]["record_hash"])


if __name__ == "__main__":
    if sys.argv[1:] == ["--contract"]:
        case = ActionReviewDraftTests()
        try:
            case.setUp(); case.retained_reports(); value = case.inspect(); case.assert_no_finance(); print(json.dumps(value))
        finally:
            case.doCleanups()
    else:
        unittest.main()
