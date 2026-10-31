"""Fictional calendar continuation, never a source renewal or trade approval."""

from copy import deepcopy
from datetime import date, timedelta
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import test_initial_prices as fixtures
from worker.investor import data_evidence, initial_prices, source_inputs, confirmed_capture, calendar_continuation
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, instant, stamp, open_database
from worker.orchestration.runtime import run_pending_once


class CalendarContinuationTests(unittest.TestCase):
    setUp = fixtures.InitialPriceTests.setUp
    prepare = fixtures.InitialPriceTests.prepare
    model = fixtures.InitialPriceTests.model
    monitor_fixture = fixtures.InitialPriceTests.monitor_fixture
    assert_no_finance = fixtures.InitialPriceTests.assert_no_finance
    clocked = fixtures.InitialPriceTests.clocked
    transport = fixtures.InitialPriceTests.transport

    def context(self):
        return initial_prices._context(self.db, "w", self.definition["model_id"], fixtures.NOW)

    def setup_calendar(self):
        self.prepare(fixed=True)
        context = self.context()
        self.original_source = source_inputs.resolve_evidence_input(self.db, "w", context[3]["row"]["id"], now=fixtures.NOW)
        identity = next(iter(context[4]))
        self.calendar = data_evidence.resolve_review(self.db, "w", context[4][identity]["calendar_review_id"], "calendar", now=fixtures.NOW)

    def extended(self, facts=None):
        value = deepcopy(facts or self.calendar["facts"])
        day = (date.fromisoformat(value["range_end"]) + timedelta(days=1)).isoformat()
        value["range_end"] = day
        value["days"].append({"date": day, "kind": "closed", "close_at": None, "available_at": None,
            "settled_at": None, "settlement_rule_known_at": None})
        return value

    def approve(self, facts, previous=None):
        return data_evidence.review_source(self.db, "w", "synthetic-investor", self.calendar["source"]["id"],
            "approved", facts, "Fictional explicit unchanged-prefix continuation", self.calendar["review"]["valid_until"],
            now=fixtures.NOW, continues_calendar_review_id=previous or self.calendar["review"]["id"])

    def test_explicit_append_preserves_frozen_research_and_uses_new_calendar_for_collection(self):
        self.setup_calendar()
        with patch.object(longport, "_collect_isolated") as sdk:
            updated = self.approve(self.extended())
            before = self.db.total_changes
            source = source_inputs.resolve_evidence_input(self.db, "w", self.original_source["row"]["id"], now=fixtures.NOW)
            current = self.context()
            self.assertEqual(source, self.original_source)
            self.assertTrue(all(spec["calendar_review_id"] == updated["id"] for spec in current[4].values()))
            for identity in current[4]:
                self.assertEqual(initial_prices._plan(self.db, "w", current, identity, fixtures.NOW)["calendar_review_id"], updated["id"])
            self.assertEqual(self.db.total_changes, before)
        sdk.assert_not_called(); self.assert_no_finance()

    def test_plain_approved_append_still_invalidates_without_explicit_continuation(self):
        self.setup_calendar()
        data_evidence.review_source(self.db, "w", "synthetic-investor", self.calendar["source"]["id"],
            "approved", self.extended(), "Fictional ordinary review without continuity approval", self.calendar["review"]["valid_until"], now=fixtures.NOW)
        self.assertEqual(source_inputs.source_unavailable_reason(self.db, "w", self.original_source["document"], fixtures.NOW), "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        with self.assertRaises(WorkbenchError): self.context()
        self.assert_no_finance()

    def test_changed_prefix_rejects_atomically_and_does_not_supersede_the_old_review(self):
        self.setup_calendar(); before = list(self.db.iterdump())
        facts = self.extended()
        session = next(row for row in facts["days"] if row["kind"] != "closed")
        session["available_at"] = session["available_at"].replace(":01:00", ":02:00")
        with self.assertRaises(WorkbenchError): self.approve(facts)
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertEqual(source_inputs.resolve_evidence_input(self.db, "w", self.original_source["row"]["id"], now=fixtures.NOW), self.original_source)
        self.assert_no_finance()

    def test_two_explicit_hops_continue_but_withdrawal_blocks_the_entire_path(self):
        self.setup_calendar()
        facts = self.extended(); second = self.approve(facts)
        third = self.approve(self.extended(facts), second["id"])
        self.assertTrue(all(row["calendar_review_id"] == third["id"] for row in self.context()[4].values()))
        data_evidence.review_source(self.db, "w", "synthetic-investor", self.calendar["source"]["id"], "withdrawn", None,
            "Fictional withdrawal is not bypassed by old continuity receipts", self.calendar["review"]["valid_until"], now=fixtures.NOW)
        self.assertEqual(source_inputs.source_unavailable_reason(self.db, "w", self.original_source["document"], fixtures.NOW), "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        with self.assertRaises(WorkbenchError): self.context()
        self.assert_no_finance()

    def test_newly_appended_session_collects_once_without_inventing_action_coverage(self):
        self.setup_calendar()
        facts = self.extended()
        facts["days"][-1].update(kind="full", close_at="2026-01-04T07:00:00.000Z", available_at="2026-01-04T07:01:00.000Z",
            settled_at="2026-01-05T07:00:00.000Z", settlement_rule_known_at="2025-12-01T00:00:00.000Z")
        updated = self.approve(self.extended(facts))
        later = "2026-01-05T12:00:03.000Z"
        with patch.object(fixtures, "NOW", later), self.clocked(), self.transport() as sdk:
            for unused in range(2):
                self.assertEqual(run_pending_once(self.db, "fictional-extended-session", role="longport", clock=lambda: later)["status"], "succeeded")
        self.assertEqual(sdk.call_count, 2)
        requests = self.db.execute("SELECT calendar_review_id,session_date FROM investor_initial_price_requests").fetchall()
        self.assertEqual([tuple(row) for row in requests], [(updated["id"], "2026-01-04")] * 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
        # Calendar approval cannot manufacture action facts for the new session.
        from worker.investor.monitor_bootstrap import plan_bootstrap
        with self.assertRaisesRegex(WorkbenchError, "ACTIONS_NOT_UNIQUE"):
            plan_bootstrap(self.db, "w", self.definition["model_id"], later)
        self.assert_no_finance()

    def test_new_collection_rejects_an_old_calendar_even_when_historical_replay_is_continued(self):
        self.setup_calendar(); old = self.calendar["review"]["id"]
        self.approve(self.extended())
        capture = self.original_source["document"]["snapshot"]["capture_refs"][0]["capture_id"]
        with patch.object(longport, "_collect_isolated") as sdk:
            replay = data_evidence.resolve_capture(self.db, "w", capture, now=fixtures.NOW)
            binding = replay["binding"]
            with self.assertRaisesRegex(WorkbenchError, "COLLECTION_REVIEW_SUPERSEDED"):
                data_evidence.collection_binding(self.db, "w", binding["rights"]["review"]["id"], binding["listing"]["review"]["id"], old,
                    replay["receipt"]["request"]["start_date"], replay["receipt"]["request"]["end_date"], fixtures.NOW)
        sdk.assert_not_called(); self.assert_no_finance()

    def test_same_source_does_not_continue_rights_or_listing_reviews(self):
        self.setup_calendar(); self.approve(self.extended())
        for kind in ("rights", "listing"):
            previous = self.refs[0][kind]
            data_evidence.review_source(self.db, "w", "synthetic-investor", previous["source_id"], "approved",
                json.loads(previous["document_json"])["facts"], "Fictional unrelated review remains superseded", fixtures.monitor.EXPIRY, now=fixtures.NOW)
            self.assertEqual(source_inputs.source_unavailable_reason(self.db, "w", self.original_source["document"], fixtures.NOW), "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.assert_no_finance()

    def test_foreign_skipped_or_non_calendar_parent_and_immutable_receipt(self):
        self.setup_calendar(); before = list(self.db.iterdump())
        for parent in ("missing", self.refs[0]["rights"]["id"]):
            with self.assertRaises(WorkbenchError): self.approve(self.extended(), parent)
            self.assertEqual(list(self.db.iterdump()), before)
        updated = self.approve(self.extended()); before = list(self.db.iterdump())
        with self.assertRaises(WorkbenchError): self.approve(self.extended())
        self.assertEqual(list(self.db.iterdump()), before)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE investor_calendar_continuations SET actor_id='foreign'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM investor_calendar_continuations")
        self.assertEqual(calendar_continuation.current_calendar_review(self.db, "w", self.calendar["review"]["id"], fixtures.NOW)["review"]["id"], updated["id"])
        self.assert_no_finance()

    def test_continuation_limit_rejects_atomically_before_breaking_an_existing_path(self):
        self.setup_calendar(); previous = self.calendar["review"]["id"]; facts = self.calendar["facts"]
        for unused in range(calendar_continuation.MAX_CONTINUATIONS):
            facts = self.extended(facts); previous = self.approve(facts, previous)["id"]
        before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "CONTINUATION_LIMIT"):
            self.approve(self.extended(facts), previous)
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertEqual(calendar_continuation.current_calendar_review(self.db, "w", self.calendar["review"]["id"], fixtures.NOW)["review"]["id"], previous)
        self.assert_no_finance()

    def test_original_review_expiry_is_not_renewed_by_a_longer_new_review(self):
        from tests.investor import confirmed_capture_fixture as confirmed
        boundary = stamp(instant(confirmed.NOW) + timedelta(seconds=1))
        with patch.object(confirmed, "EXPIRY", boundary):
            refs = confirmed.sources(self.db)
        old = data_evidence.resolve_review(self.db, "w", refs[2]["id"], "calendar", now=confirmed.NOW)
        updated = data_evidence.review_source(self.db, "w", "synthetic-investor", old["source"]["id"], "approved",
            self.extended(old["facts"]), "Fictional longer new review cannot revive an expired original", fixtures.monitor.EXPIRY,
            now=confirmed.NOW, continues_calendar_review_id=old["review"]["id"])
        self.assertEqual(data_evidence.resolve_review(self.db, "w", updated["id"], "calendar", now=boundary)["review"]["id"], updated["id"])
        with self.assertRaises(WorkbenchError): calendar_continuation.current_calendar_review(self.db, "w", old["review"]["id"], boundary)
        self.assert_no_finance()

    def test_intermediate_review_is_a_historical_witness_but_origin_and_head_must_remain_valid(self):
        from tests.investor import confirmed_capture_fixture as confirmed
        refs = confirmed.sources(self.db)
        old = data_evidence.resolve_review(self.db, "w", refs[2]["id"], "calendar", now=confirmed.NOW)
        boundary = stamp(instant(confirmed.NOW) + timedelta(seconds=2))
        first = self.extended(old["facts"])
        middle = data_evidence.review_source(self.db, "w", "synthetic-investor", old["source"]["id"], "approved", first,
            "Fictional short intermediate deadline", boundary, now=confirmed.NOW, continues_calendar_review_id=old["review"]["id"])
        published = stamp(instant(confirmed.NOW) + timedelta(seconds=1))
        head = data_evidence.review_source(self.db, "w", "synthetic-investor", old["source"]["id"], "approved", self.extended(first),
            "Fictional explicit next approval before the intermediate expired", confirmed.EXPIRY, now=published, continues_calendar_review_id=middle["id"])
        self.assertEqual(calendar_continuation.current_calendar_review(self.db, "w", old["review"]["id"], boundary)["review"]["id"], head["id"])
        with self.assertRaises(WorkbenchError):
            calendar_continuation.current_calendar_review(self.db, "w", old["review"]["id"], confirmed.EXPIRY)
        self.assert_no_finance()

    def test_confirmed_receipt_replays_original_calendar_but_old_id_cannot_start_a_new_watch(self):
        from tests.investor import confirmed_capture_fixture as confirmed
        refs = confirmed.sources(self.db); capture = confirmed.stub_official(self.db, [refs])
        before = confirmed_capture.resolve_confirmed_capture(self.db, "w", capture["id"], now=confirmed.NOW)
        old = data_evidence.resolve_review(self.db, "w", refs[2]["id"], "calendar", now=confirmed.NOW)
        data_evidence.review_source(self.db, "w", "synthetic-investor", old["source"]["id"], "approved", self.extended(old["facts"]),
            "Fictional confirmed calendar continuation", confirmed.EXPIRY, now=confirmed.NOW, continues_calendar_review_id=old["review"]["id"])
        changes = self.db.total_changes
        self.assertEqual(confirmed_capture.resolve_confirmed_capture(self.db, "w", capture["id"], now=confirmed.NOW), before)
        with self.assertRaisesRegex(WorkbenchError, "COLLECTION_REVIEW_SUPERSEDED"):
            confirmed_capture._bindings(self.db, "w", confirmed.inputs([refs]), confirmed.NOW)
        self.assertEqual(self.db.total_changes, changes); self.assert_no_finance()

    def test_new_approved_extension_during_sdk_does_not_commit_or_replay_the_old_attempt(self):
        self.setup_calendar(); facts = self.extended(); first = self.approve(facts)
        initial_prices.discover_initial_prices(self.db, now=fixtures.NOW)
        before = self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0]
        def during(): self.approve(self.extended(facts), first["id"])
        with self.clocked(), self.transport(during=during) as sdk:
            self.assertEqual(run_pending_once(self.db, "fictional-calendar-boundary", role="longport", clock=lambda: fixtures.NOW)["status"], "skipped")
            self.assertEqual(run_pending_once(self.db, "fictional-calendar-boundary", role="longport", clock=lambda: fixtures.NOW)["status"], "skipped")
        self.assertEqual(sdk.call_count, 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_runs WHERE status='superseded'").fetchone()[0], 2)
        self.assertEqual(initial_prices.discover_initial_prices(self.db, now=fixtures.NOW), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_requests").fetchone()[0], 2)
        self.assert_no_finance()

    def test_stale_parent_from_another_connection_cannot_create_a_second_link(self):
        self.setup_calendar(); first = self.approve(self.extended()); before = list(self.db.iterdump())
        other = open_database(self.path); self.addCleanup(other.close)
        with self.assertRaisesRegex(WorkbenchError, "CONTINUATION_INVALID"):
            data_evidence.review_source(other, "w", "synthetic-investor", self.calendar["source"]["id"], "approved", self.extended(),
                "Fictional stale concurrent owner request", fixtures.monitor.EXPIRY, now=fixtures.NOW,
                continues_calendar_review_id=self.calendar["review"]["id"])
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_calendar_continuations").fetchone()[0], 1)
        self.assertEqual(calendar_continuation.current_calendar_review(other, "w", self.calendar["review"]["id"], fixtures.NOW)["review"]["id"], first["id"])
        self.assert_no_finance()

    def test_private_cli_explicit_option_echoes_no_reason_and_does_not_revive_an_expired_reference(self):
        from tests.investor.test_data_pipeline import DataPipelineCliTests
        from pathlib import Path
        self.setup_calendar()
        document = {"decision": "approved", "facts": self.extended(), "reason": "PRIVATE-CALENDAR-FIXTURE-REASON",
            "valid_until": self.calendar["review"]["valid_until"], "continues_calendar_review_id": self.calendar["review"]["id"]}
        path = Path(self.path).parent / "private-calendar-review.json"; path.write_text(json.dumps(document)); path.chmod(0o600)
        status, output, error = DataPipelineCliTests.invoke(self, "review-source", "--source", self.calendar["source"]["id"], "--file", str(path))
        self.assertEqual((status, error), (0, "")); self.assertNotIn(document["reason"], output)
        value = json.loads(output)
        self.assertTrue(value["historical_prefix_unchanged"]); self.assertFalse(value["historical_reference_expiry_extended"])
        self.assertFalse(value["collection_permission_granted"]); self.assertFalse(value["trading_permission"])
        self.assertEqual(source_inputs.source_unavailable_reason(self.db, "w", self.original_source["document"], stamp()), "REFERENCE_SOURCE_EXPIRED")
        before = list(self.db.iterdump()); document["collection_permission"] = True
        path.write_text(json.dumps(document))
        status, output, error = DataPipelineCliTests.invoke(self, "review-source", "--source", self.calendar["source"]["id"], "--file", str(path))
        self.assertEqual((status, output), (1, "")); self.assertNotIn(document["reason"], error)
        self.assertEqual(list(self.db.iterdump()), before); self.assert_no_finance()

    def test_direct_registration_cannot_bypass_the_restore_barrier_with_a_raw_transaction(self):
        self.setup_calendar()
        current = data_evidence.review_source(self.db, "w", "synthetic-investor", self.calendar["source"]["id"], "approved", self.extended(),
            "Fictional ordinary review before restore-barrier probe", fixtures.monitor.EXPIRY, now=fixtures.NOW)
        (self.path.parent / "RESTORE_PENDING_REVIEW").write_text("Fictional restore lock only")
        self.db.execute("BEGIN")
        try:
            with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
                calendar_continuation.register_continuation(self.db, "w", "synthetic-investor", self.calendar["review"]["id"], current["id"], fixtures.NOW)
        finally:
            self.db.execute("ROLLBACK")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_calendar_continuations").fetchone()[0], 0)
        self.assert_no_finance()

    def test_direct_registration_cannot_bypass_read_only_mode_with_a_raw_transaction(self):
        self.setup_calendar()
        current = data_evidence.review_source(self.db, "w", "synthetic-investor", self.calendar["source"]["id"], "approved", self.extended(),
            "Fictional ordinary review before read-only probe", fixtures.monitor.EXPIRY, now=fixtures.NOW)
        before = list(self.db.iterdump())
        self.db.execute("BEGIN")
        try:
            with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), self.assertRaisesRegex(WorkbenchError, "READ_ONLY"):
                calendar_continuation.register_continuation(self.db, "w", "synthetic-investor", self.calendar["review"]["id"], current["id"], fixtures.NOW)
        finally:
            self.db.execute("ROLLBACK")
        self.assertEqual(list(self.db.iterdump()), before)
        self.assert_no_finance()

    def test_late_receipt_failure_rolls_back_new_review_and_audits_without_superseding_the_origin(self):
        self.setup_calendar()
        self.db.execute("CREATE TEMP TRIGGER fictional_calendar_receipt_failure BEFORE INSERT ON investor_calendar_continuations BEGIN SELECT RAISE(ABORT,'FICTIONAL_RECEIPT_FAILURE'); END")
        before = list(self.db.iterdump())
        with self.assertRaisesRegex(sqlite3.IntegrityError, "FICTIONAL_RECEIPT_FAILURE"):
            self.approve(self.extended())
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertEqual(source_inputs.resolve_evidence_input(self.db, "w", self.original_source["row"]["id"], now=fixtures.NOW), self.original_source)
        self.assert_no_finance()
