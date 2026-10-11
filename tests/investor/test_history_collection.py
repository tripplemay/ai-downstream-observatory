"""Invented calendars/quotes only; never approves a provider licence or return."""

from datetime import datetime, timedelta
from decimal import Decimal
import json
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.investor import test_data_evidence as evidence
from tests.investor import test_runtime as queue
from worker.investor.data_evidence import collect_prices, review_source
from worker.investor.data_snapshot import build_dataset
from worker.investor.history_collection import collect_history, plan_history
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, instant, open_database, stamp


NOW, EXPIRY = evidence.NOW, evidence.EXPIRY
START, END = "2025-01-01", "2025-03-10"


class CalendarClient:
    def __init__(self, facts, *, fail_call=None, during=None):
        self.facts, self.fail_call, self.during, self.calls = facts, fail_call, during, []

    def history_candlesticks_by_date(self, symbol, **kwargs):
        self.calls.append((kwargs["start"].isoformat(), kwargs["end"].isoformat()))
        if self.during:
            during, self.during = self.during, None
            during()
        if len(self.calls) == self.fail_call:
            raise RuntimeError("PRIVATE-FICTIONAL-PROVIDER-DIAGNOSTIC")
        zone = ZoneInfo(longport._MARKETS[self.facts["market"]][0])
        return [{"timestamp": datetime.fromisoformat(row["date"]).replace(tzinfo=zone),
            "open": Decimal("10"), "high": Decimal("12"), "low": Decimal("9"), "close": Decimal("11.25"),
            "turnover": Decimal("11250"), "volume": 1000, "trade_session": 0} for row in self.facts["days"]
            if row["kind"] != "closed" and self.calls[-1][0] <= row["date"] <= self.calls[-1][1]]


class HistoryCollectionTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    review = evidence.InvestorDataTests.review
    prepare = evidence.InvestorDataTests.prepare
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def fixture(self, market="CN", start=START, end=END, close_first_tile=False, tradable_from=None):
        refs = list(self.prepare(market))
        asset = json.loads(refs[1]["document_json"])["facts"]
        asset["tradable_from"] = tradable_from or "2010-01-01T00:00:00Z"
        refs[1] = review_source(self.db, "w", "synthetic-investor", refs[1]["source_id"], "approved", asset, "Fictional lifecycle", EXPIRY, now=NOW)
        first, last, days = longport._day(start), longport._day(end), []
        zone = ZoneInfo(longport._MARKETS[market][0])
        for index in range((last - first).days + 1):
            day = first + timedelta(days=index)
            closed = day.weekday() >= 5 or close_first_tile and index < 31
            close = datetime(day.year, day.month, day.day, {"CN": 15, "HK": 16, "US": 16}[market], tzinfo=zone)
            days.append({"date": day.isoformat(), "kind": "closed" if closed else "half" if index == 32 else "full",
                "close_at": None if closed else stamp(close), "available_at": None if closed else stamp(close + timedelta(minutes=1)),
                "settled_at": None if closed else stamp(close + timedelta(days=1)),
                "settlement_rule_known_at": None if closed else "2010-01-01T00:00:00Z"})
        facts = {"market": market, "range_start": start, "range_end": end, "days": days}
        refs[2] = review_source(self.db, "w", "synthetic-investor", refs[2]["source_id"], "approved", facts, "Invented test calendar, not exchange data", EXPIRY, now=NOW)
        action = json.loads(refs[3]["document_json"])["facts"]
        action.update(range_start=start, range_end=end)
        refs[3] = review_source(self.db, "w", "synthetic-investor", refs[3]["source_id"], "approved", action, "Fictional actions", EXPIRY, now=NOW)
        return refs, CalendarClient(facts)

    def arguments(self, refs, start=START, end=END):
        return (self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), start, end)

    def plan(self, refs, start=START, end=END, now=NOW):
        return plan_history(*self.arguments(refs, start, end), now=now, allow_synthetic=True)

    def collect(self, refs, client, start=START, end=END, *, maximum=1, plan_hash=None, now=NOW):
        digest = self.plan(refs, start, end, now)["plan_hash"] if plan_hash is None else plan_hash
        with patch.object(longport, "stamp", side_effect=lambda value=None: now if value is None else stamp(value)):
            return collect_history(*self.arguments(refs, start, end), plan_hash=digest, max_calls=maximum, now=now, client=client, sdk_version="4.3.7")

    def test_ten_year_three_market_plans_partition_every_day_and_do_not_call_or_write(self):
        for market in ("CN", "HK", "US"):
            with self.subTest(market=market):
                refs, _ = self.fixture(market, "2016-01-01", "2025-12-31")
                before = self.db.total_changes
                with patch.object(longport, "read_private_credentials_file") as credentials, patch.object(longport, "_collect_isolated") as sdk:
                    result = plan_history(*self.arguments(refs, "2016-01-01", "2025-12-31"), now=NOW)
                credentials.assert_not_called(); sdk.assert_not_called()
                self.assertEqual(before, self.db.total_changes)
                self.assertEqual(result["provider_calls"], 0)
                self.assertEqual(result["missing_tile_count"], 118)
                expected_cursor = longport._day(result["range_start"])
                for tile in result["tiles"]:
                    self.assertEqual(longport._day(tile["start_date"]), expected_cursor)
                    self.assertLessEqual((longport._day(tile["end_date"]) - expected_cursor).days, 30)
                    expected_cursor = longport._day(tile["end_date"]) + timedelta(days=1)
                self.assertEqual(expected_cursor.isoformat(), "2026-01-01")
                for field in ("market_values_output", "research_queue_updated", "historical_archive_verified", "total_return_verified", "live_advice_eligible"):
                    self.assertFalse(result[field])
        self.assert_no_finance()

    def test_bounded_batch_resumes_valid_receipts_without_duplicate_prices_then_builds_dataset(self):
        refs, client = self.fixture()
        planned = self.plan(refs)
        first = self.collect(refs, client)
        self.assertEqual((first["provider_calls"], first["retained_tile_count"], first["missing_tile_count"]), (1, 1, 2))
        self.assertTrue(first["stopped_at_call_limit"])
        self.assertEqual(first["valid_until"], "2026-02-01T12:00:03.000Z")
        second = self.collect(refs, client, maximum=4, plan_hash=planned["plan_hash"])
        self.assertEqual((second["provider_calls"], second["missing_tile_count"], len(client.calls)), (2, 0, 3))
        self.assertTrue(second["price_coverage_complete"])
        self.assertEqual(second["plan_hash"], planned["plan_hash"])
        captures = [tile["capture_id"] for tile in second["tiles"] if tile["capture_id"]]
        before = self.db.total_changes
        third = self.collect(refs, client, maximum=4)
        self.assertEqual(third["provider_calls"], 0); self.assertEqual(self.db.total_changes, before)
        result = build_dataset(self.db, "w", captures, [refs[3]["id"]], [], START, END, now=NOW, allow_synthetic=True)
        self.assertEqual(len(result["dataset"]["observations"]), planned["expected_date_count"])
        self.assertEqual(result["dataset"]["mode"], "synthetic")
        self.assertEqual(len(set(client.calls)), 3)
        self.assert_no_finance()

    def test_closed_or_prelisting_tiles_never_request_empty_prices(self):
        for options in ({"close_first_tile": True}, {"tradable_from": "2025-02-01T00:00:00Z"}):
            refs, client = self.fixture(**options)
            planned = self.plan(refs)
            self.assertEqual(planned["tiles"][0]["status"], "no_sessions")
            self.assertEqual(planned["no_session_tile_count"], 1)
            collected = self.collect(refs, client, maximum=4)
            self.assertEqual(collected["provider_calls"], 2)
            self.assertTrue(collected["price_coverage_complete"])
        self.assert_no_finance()

    def test_failed_second_call_preserves_first_receipt_and_requires_explicit_resume(self):
        refs, client = self.fixture(); client.fail_call = 2
        digest = self.plan(refs)["plan_hash"]
        with self.assertRaisesRegex(WorkbenchError, "LONGPORT_SDK_CALL_FAILED"):
            self.collect(refs, client, maximum=4, plan_hash=digest)
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], 1)
        result = self.collect(refs, client, maximum=4, plan_hash=digest)
        self.assertEqual(result["provider_calls"], 2)
        self.assertEqual(client.calls[0], ("2025-01-01", "2025-01-31"))
        self.assertEqual(client.calls[1], client.calls[2])
        self.assertEqual(client.calls[3], ("2025-03-04", END))
        self.assert_no_finance()

    def test_invalid_hash_call_limit_range_and_official_clock_fail_before_transport(self):
        refs, client = self.fixture()
        digest = self.plan(refs)["plan_hash"]
        for maximum in (0, 5, True, 1.0):
            with self.assertRaisesRegex(WorkbenchError, "HISTORY_CALL_LIMIT"):
                self.collect(refs, client, maximum=maximum)
        for hashed in ("x", "A" * 64, "0" * 64, None):
            if hashed is None:
                continue
            with self.assertRaisesRegex(WorkbenchError, "HISTORY_PLAN_(INVALID|CHANGED)"):
                self.collect(refs, client, plan_hash=hashed)
        with self.assertRaisesRegex(WorkbenchError, "PRODUCTION_CLOCK_NOT_CALLER_CONTROLLED"):
            collect_history(*self.arguments(refs), plan_hash=digest, now=NOW)
        for start, end in ((END, START), ("2010-01-01", END), (START, "2026-01-02")):
            with self.assertRaises(WorkbenchError): self.plan(refs, start, end)
        self.assertEqual(client.calls, [])
        self.assert_no_finance()

    def test_owner_source_expiry_missing_uses_and_superseded_plan_stop_before_sdk(self):
        refs, client = self.fixture()
        digest = self.plan(refs)["plan_hash"]
        with self.assertRaisesRegex(WorkbenchError, "OUT_OF_SCOPE"):
            plan_history(self.db, "w", "other", *(row["id"] for row in refs[:3]), START, END, now=NOW)
        with self.assertRaises(WorkbenchError): self.plan(refs, now=EXPIRY)
        facts = json.loads(refs[0]["document_json"])["facts"]; facts["uses"].remove("private_backup")
        replacement = review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "approved", facts, "Fictional absent use", EXPIRY, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "SUPERSEDED"):
            self.collect(refs, client, plan_hash=digest)
        refs[0] = replacement
        with patch.object(longport, "read_private_credentials_file") as credentials, patch.object(longport, "_collect_isolated") as sdk:
            with self.assertRaisesRegex(WorkbenchError, "USE_NOT_GRANTED"):
                collect_history(*self.arguments(refs), plan_hash=digest, credentials_file="/private/unused.env")
        credentials.assert_not_called(); sdk.assert_not_called()
        self.assert_no_finance()

    def test_new_calendar_review_requires_new_plan_hash_not_mutable_reapproval(self):
        refs, client = self.fixture()
        previous = self.plan(refs)["plan_hash"]
        facts = json.loads(refs[2]["document_json"])["facts"]
        refs[2] = review_source(self.db, "w", "synthetic-investor", refs[2]["source_id"], "approved", facts, "Fictional reaffirmation", EXPIRY, now=NOW)
        self.assertNotEqual(self.plan(refs)["plan_hash"], previous)
        with self.assertRaisesRegex(WorkbenchError, "HISTORY_PLAN_CHANGED"):
            self.collect(refs, client, plan_hash=previous)
        self.assertEqual(client.calls, [])

    def test_duplicate_and_misaligned_existing_captures_are_not_silently_chosen(self):
        refs, client = self.fixture()
        with patch.object(longport, "stamp", side_effect=lambda value=None: NOW if value is None else stamp(value)):
            for _ in range(2):
                collect_prices(self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), START, "2025-01-31", now=NOW, client=client, sdk_version="4.3.7")
        with self.assertRaisesRegex(WorkbenchError, "CAPTURE_WINDOWS_CONFLICT"): self.plan(refs)
        # A different review set has no link to the prior captures.
        refs, client = self.fixture("HK")
        with patch.object(longport, "stamp", side_effect=lambda value=None: NOW if value is None else stamp(value)):
            collect_prices(self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), START, "2025-01-02", now=NOW, client=client, sdk_version="4.3.7")
        with self.assertRaisesRegex(WorkbenchError, "CAPTURE_WINDOWS_CONFLICT"): self.plan(refs)

    def test_second_connection_winning_sdk_race_cannot_create_duplicate_commit(self):
        refs, client = self.fixture(end="2025-01-31")
        rival = open_database(self.path); self.addCleanup(rival.close)
        def win():
            collect_prices(rival, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), START, "2025-01-31",
                now=NOW, client=CalendarClient(client.facts), sdk_version="4.3.7", prevent_retained_overlap=True)
        client.during = win
        with self.assertRaisesRegex(WorkbenchError, "CAPTURE_WINDOWS_CONFLICT"):
            self.collect(refs, client, end="2025-01-31")
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], 1)
        self.assertEqual(self.collect(refs, client, end="2025-01-31")["provider_calls"], 0)
        self.assert_no_finance()

    def test_rights_withdrawal_during_sdk_cannot_commit_or_continue(self):
        refs, client = self.fixture()
        client.during = lambda: review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "withdrawn", None, "Fictional withdrawal", EXPIRY, now=NOW)
        with self.assertRaises(WorkbenchError): self.collect(refs, client, maximum=4)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], 0)
        self.assert_no_finance()

    def test_expired_payload_is_not_reused_or_deleted_by_planning_and_can_be_recaptured(self):
        refs, client = self.fixture(end="2025-01-31")
        first = self.collect(refs, client, end="2025-01-31")
        later = stamp(instant(NOW) + timedelta(days=31))
        before = self.db.total_changes
        planned = self.plan(refs, end="2025-01-31", now=later)
        self.assertEqual(planned["missing_tile_count"], 1); self.assertEqual(self.db.total_changes, before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], 1)
        result = self.collect(refs, client, end="2025-01-31", now=later)
        self.assertEqual(result["provider_calls"], 1)
        self.assertEqual(result["plan_hash"], first["plan_hash"])
        self.assertNotEqual(result["tiles"][0]["capture_id"], first["tiles"][0]["capture_id"])
        self.assert_no_finance()

    def test_default_reader_rejects_injected_reuse_and_tampered_projection(self):
        refs, client = self.fixture()
        self.collect(refs, client)
        with self.assertRaisesRegex(WorkbenchError, "SYNTHETIC_CAPTURE_FORBIDDEN"):
            plan_history(*self.arguments(refs), now=NOW)
        self.db.execute("DROP TRIGGER investor_price_payload_no_update")
        self.db.execute("UPDATE investor_price_payloads SET projection=?", (b"PRIVATE-FICTIONAL-TAMPERED",))
        with self.assertRaises(WorkbenchError): self.plan(refs)

    def test_restore_lock_stops_batch_before_sdk_even_when_all_tiles_are_retained(self):
        refs, client = self.fixture(end="2025-01-31")
        self.collect(refs, client, end="2025-01-31")
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"; marker.touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            self.collect(refs, client, end="2025-01-31")
        self.assertEqual(len(client.calls), 1)
        self.assert_no_finance()

    def test_clock_rollback_cannot_hide_future_receipt_and_collect_duplicate(self):
        refs, client = self.fixture(end="2025-01-31")
        later = stamp(instant(NOW) + timedelta(seconds=1))
        self.collect(refs, client, end="2025-01-31", now=later)
        with self.assertRaisesRegex(WorkbenchError, "HISTORY_SOURCE_AFTER_CLOCK"):
            self.plan(refs, end="2025-01-31")
        with self.assertRaisesRegex(WorkbenchError, "HISTORY_SOURCE_AFTER_CLOCK"):
            self.collect(refs, client, end="2025-01-31")
        self.assertEqual(len(client.calls), 1)


if __name__ == "__main__":
    unittest.main()
