"""Retained fictional official-transport substitutes; no live provider or approval."""

from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
import json
import sys
import unittest
from unittest.mock import patch

from tests.investor import action_reconciliation_fixture as sources
from tests.investor import test_managed_actions as fixture
from tests.market.test_eodhd_actions import archive as div_archive, dividend
from tests.market.test_vanguard_distributions import archive, row
from worker.investor import data_evidence, eodhd_sources, issuer_sources, managed_actions, reviewed_actions
from worker.market.providers.eodhd_actions import parse_eodhd_actions
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, open_database


REVIEWED = "2026-11-02T06:00:03.001Z"
Collector = sources.ActionCollector


class UpdatedCollector(Collector):
    event_day = "2026-10-30"

    def __call__(self, **options):
        result = super().__call__(**options)
        if options["kind"] != "div" or options["symbol"] != "VT.US":
            return result
        raw = div_archive(dividend("987.123", date="2026-09-25", declarationDate="2026-09-20",
            recordDate="2026-09-25", paymentDate="2026-09-30"), dividend("4.321", date=self.event_day,
            recordDate=self.event_day, paymentDate="2026-11-09"))
        result["raw"] = raw
        result["receipt"].update(raw_sha256=sha256(raw).hexdigest(), raw_bytes=len(raw))
        parameters = {key:options[key] for key in ("kind", "symbol", "start_date", "end_date")}
        result["draft"] = parse_eodhd_actions(raw, **parameters, retrieved_at=fixture.LATER)
        return result


class ReviewedActionSuccessorTests(unittest.TestCase):
    setUp = fixture.ManagedActionTests.setUp
    prepare = fixture.ManagedActionTests.prepare
    policy = fixture.ManagedActionTests.policy
    grant = fixture.ManagedActionTests.grant
    next_source_day = fixture.ManagedActionTests.next_source_day
    assert_no_finance = fixture.ManagedActionTests.assert_no_finance

    def prepared_reviews(self, *, previous_publication=False, event_day="2026-10-30", event_at="2026-10-30T13:30:00Z", published_at=None):
        self.prepare(); self.grant(); self.previous_authority = self.authority
        if previous_publication:
            self.assertEqual(managed_actions.publish_current_actions(self.db, now=fixture.AT)[0]["status"], "published")
        raw = archive(row("987.1234", exDividendDate="2026-09-25", recordDate="2026-09-25", payableDate="2026-09-30"),
            row("4.32109", exDividendDate=event_day, recordDate=event_day, payableDate="2026-11-09"))
        with patch.object(sources, "ActionCollector", UpdatedCollector), patch.object(UpdatedCollector,"event_day",event_day):
            self.next_source_day(issuer_raw=raw)
        self.assertEqual(managed_actions.publish_current_actions(self.db, now=fixture.LATER)[0]["status"], "blocked")
        refs, failure = managed_actions._current_refs(self.db, "w", self.policy(), fixture.LATER[:10], fixture.LATER)
        self.assertIsNone(failure); self.assertIsNotNone(refs)
        new_facts = deepcopy(self.base_facts); new_facts["range_end"] = (instant(fixture.LATER).date()-timedelta(days=1)).isoformat()
        new_facts["events"].append({"id":"fictional-explicitly-reviewed-current-event", "listing_id":"synthetic-3141",
            "type":"dividend", "at":event_at, "published_at":published_at or fixture.LATER,
            "pay_at":"2026-11-09T21:00:00Z", "gross_per_unit":"4.32109", "tax_per_unit":"0.432109",
            "source_evidence":"synthetic://new-manual-event-review"})
        source = data_evidence.store_source(self.db, "w", "synthetic-investor", "actions", {
            "title":"Fictional separate manual update", "reference":"synthetic://new-action-review",
            "excerpt":"Invented explicit owner review; never tax or issuer certification"}, now=REVIEWED)
        self.next_review = data_evidence.review_source(self.db, "w", "synthetic-investor", source["id"], "approved", new_facts,
            "Fictional separately reviewed new event, not old standing consent", "2026-11-10T00:00:00.000Z", now=REVIEWED)
        preview = managed_actions.preview_authority(self.db, "w", "synthetic-investor", self.next_review["id"],
            self.member["listing_review_id"], refs, now=REVIEWED)
        policy = self.policy(**{key:preview[key] for key in ("base_review_id", "base_review_hash", "anchor_captures", "anchor_binding_hash")}, valid_from=REVIEWED)
        self.next_authority = managed_actions.register_authority(self.db, "w", "synthetic-investor", policy, now=REVIEWED)

    def inspect(self):
        return reviewed_actions.preview_reviewed_action_successor(self.db, "w", "synthetic-investor",
            self.previous_authority["id"], self.next_authority["id"], now=REVIEWED)

    def test_actual_resolvers_prepare_existing_manual_review_without_clearing_or_enabling(self):
        self.prepared_reviews(); before = list(self.db.iterdump()); changes = self.db.total_changes
        with patch.object(eodhd_sources.receiver, "collect_eodhd_action_draft", side_effect=AssertionError("NO_SOURCE_CALL")):
            value = self.inspect()
        self.assertEqual(before, list(self.db.iterdump())); self.assertEqual(changes, self.db.total_changes)
        self.assertEqual(value["status"], "explicit_review_successor_prepared_not_registered")
        self.assertTrue(value["next_manual_review_record_verified"])
        self.assertEqual(value["append_proof"]["added_event_count"], 1)
        self.assertIsNone(value["previous_publication_id"])
        for key in ("handover_registered", "next_rule_enabled", "quarantine_cleared", "research_admitted", "trading_permission"):
            self.assertIs(value[key], False)
        self.assertTrue(managed_actions._quarantined(self.db, "w", self.previous_authority["id"], REVIEWED))
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1",
            (self.next_authority["id"],)).fetchone()[0], 0)
        with self.assertRaises(WorkbenchError):
            managed_actions.current_action_reviews(self.db, "w", ["synthetic-3141"], REVIEWED)
        self.assertNotIn("4.32109", json.dumps(value)); self.assert_no_finance()

    def test_published_coverage_is_not_forgotten_when_owner_adds_a_new_manual_review(self):
        self.prepared_reviews(previous_publication=True)
        before=list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError,"HISTORICAL_CORRECTION_REQUIRED"):
            self.inspect()
        self.assertEqual(before,list(self.db.iterdump())); self.assert_no_finance()

    def test_prior_published_basis_is_fully_replayed_but_remains_unavailable_as_current(self):
        with patch.object(fixture,"LATER","2026-11-03T06:00:03.000Z"), patch.dict(globals(),REVIEWED="2026-11-03T06:00:03.001Z"):
            self.prepared_reviews(previous_publication=True,event_day="2026-11-02",event_at="2026-11-02T14:30:00Z")
            before=list(self.db.iterdump()); value=self.inspect()
            self.assertIsNotNone(value["previous_publication_id"])
            self.assertEqual(value["append_proof"]["previous_coverage_end"],"2026-10-31")
            self.assertEqual(value["append_proof"]["new_coverage_end"],"2026-11-02")
            self.assertEqual(before,list(self.db.iterdump()))
            with self.assertRaises(WorkbenchError):
                managed_actions.resolve_managed_review(self.db,"w",value["previous_publication_id"],now=REVIEWED)
            self.assert_no_finance()

    def test_a_self_resealed_old_summary_is_not_a_substitute_for_raw_replay(self):
        with patch.object(fixture,"LATER","2026-11-03T06:00:03.000Z"), patch.dict(globals(),REVIEWED="2026-11-03T06:00:03.001Z"):
            self.prepared_reviews(previous_publication=True,event_day="2026-11-02",event_at="2026-11-02T14:30:00Z")
            for trigger in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('investor_action_publications','audit_events')").fetchall():
                self.db.execute('DROP TRIGGER "'+trigger[0]+'"')
            row=self.db.execute("SELECT * FROM investor_action_publications WHERE authority_id=? AND status='published'",(self.previous_authority['id'],)).fetchone()
            document=json.loads(row['document_json']);document['checked_input_hash']='0'*64;digest=content_hash(document)
            self.db.execute('UPDATE investor_action_publications SET document_json=?,content_hash=? WHERE id=?',(canonical_json(document),digest,row['id']))
            self.db.execute('UPDATE audit_events SET payload_json=? WHERE id=?',(canonical_json({'content_hash':digest}),row['audit_id']))
            before=list(self.db.iterdump())
            with self.assertRaisesRegex(WorkbenchError,'HISTORICAL_PUBLICATION_INVALID'):self.inspect()
            self.assertEqual(before,list(self.db.iterdump()));self.assert_no_finance()

    def test_source_withdrawal_stops_even_though_both_manual_reviews_still_exist(self):
        self.prepared_reviews()
        eodhd_sources.set_authority_enabled(self.db,"w","synthetic-investor",self.member["eodhd_authority_id"],False,now=REVIEWED)
        before=list(self.db.iterdump())
        with self.assertRaises(WorkbenchError):self.inspect()
        self.assertEqual(before,list(self.db.iterdump())); self.assert_no_finance()

    def test_owner_boundary_is_checked_before_reading_private_action_sources(self):
        self.prepared_reviews()
        with patch.object(managed_actions,"_anchor") as resolver:
            with self.assertRaises(WorkbenchError):
                reviewed_actions.preview_reviewed_action_successor(self.db,"w","foreign-investor",
                    self.previous_authority["id"],self.next_authority["id"],now=REVIEWED)
            resolver.assert_not_called()
        self.assert_no_finance()

    def test_paused_old_rule_is_compared_only_not_silently_resumed(self):
        self.prepared_reviews()
        managed_actions.set_authority_enabled(self.db,"w","synthetic-investor",self.previous_authority["id"],False,now=REVIEWED)
        before=list(self.db.iterdump()); value=self.inspect()
        self.assertFalse(value["previous_control_enabled"]); self.assertFalse(value["next_rule_enabled"])
        self.assertEqual(before,list(self.db.iterdump())); self.assert_no_finance()

    def test_preview_works_through_a_genuinely_readonly_connection(self):
        self.prepared_reviews();before=list(self.db.iterdump())
        reader=open_database(self.path,read_only=True)
        try:
            value=reviewed_actions.preview_reviewed_action_successor(reader,'w','synthetic-investor',
                self.previous_authority['id'],self.next_authority['id'],now=REVIEWED)
            self.assertEqual(value['database_writes'],0);self.assertEqual(reader.total_changes,0)
        finally:reader.close()
        self.assertEqual(before,list(self.db.iterdump()));self.assert_no_finance()

    def test_microsecond_transport_completion_is_not_rounded_back_before_knowledge(self):
        micro='2026-11-03T06:00:03.000901Z'; original_stamp=issuer_sources.stamp; original_collector=sources.IssuerCollector
        def collector(**options):
            return original_collector(**{**options,'at':micro if options.get('at')==fixture.LATER else options.get('at')})
        with patch.object(fixture,'LATER','2026-11-03T06:00:03.000Z'),patch.dict(globals(),REVIEWED='2026-11-03T06:00:03.001Z'):
            # Model the runtime's microsecond transport clock separately from canonical metadata clocks.
            with patch.object(issuer_sources,'stamp',side_effect=lambda value=None:micro if value==instant(fixture.LATER) else original_stamp(value)), \
                    patch.object(sources,'IssuerCollector',side_effect=collector):
                self.prepared_reviews(previous_publication=True,event_day='2026-11-02',event_at='2026-11-02T14:30:00Z',published_at=micro)
            before=list(self.db.iterdump());value=self.inspect()
            self.assertEqual(value['append_proof']['added_event_count'],1)
            self.assertEqual(before,list(self.db.iterdump()));self.assert_no_finance()

    def test_withdrawn_new_review_does_not_borrow_the_old_rule_authorization(self):
        self.prepared_reviews()
        data_evidence.review_source(self.db,'w','synthetic-investor',self.next_review['source_id'],'withdrawn',None,
            'Fictional withdrawal','2026-11-10T00:00:00.000Z',now=REVIEWED)
        before=list(self.db.iterdump())
        with self.assertRaises(WorkbenchError):self.inspect()
        self.assertEqual(before,list(self.db.iterdump()));self.assert_no_finance()

    def test_already_started_new_rule_cannot_be_reset_into_a_fresh_successor(self):
        self.prepared_reviews()
        managed_actions.set_authority_enabled(self.db,'w','synthetic-investor',self.previous_authority['id'],False,now=REVIEWED)
        managed_actions.set_authority_enabled(self.db,'w','synthetic-investor',self.next_authority['id'],True,now=REVIEWED)
        managed_actions.set_authority_enabled(self.db,'w','synthetic-investor',self.next_authority['id'],False,now=REVIEWED)
        before=list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError,'NEW_AUTHORITY_MUST_REMAIN_UNSTARTED'):self.inspect()
        self.assertEqual(before,list(self.db.iterdump()));self.assert_no_finance()


if __name__ == "__main__":
    if sys.argv[1:] == ["--contract"]:
        case=ReviewedActionSuccessorTests()
        try:
            case.setUp();case.prepared_reviews();value=case.inspect();case.assert_no_finance();print(json.dumps(value))
        finally:case.doCleanups()
    else:
        unittest.main()
