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


class EpochHistoryPlanTests(unittest.TestCase):
    def setUp(self):
        from tests.investor import test_current_correction_fixture as fixture
        fixture.CurrentCorrectionFixtureTests.setUp(self)

    def seed(self,enabled=True):
        from tests.investor.epoch_continuation_source_fixture import create
        from worker.investor import epoch_continuation as epochs
        self.saved=create(self.db,self.path);self.epoch_id=self.saved["registration"]["epoch"]["id"]
        if enabled:
            epochs.set_epoch_continuation_control(self.db,"w","owner",self.body(True),owner_interaction=True,now="2026-10-20T10:00:03.000Z")

    def body(self,enabled):
        from worker.investor import epoch_continuation as epochs
        root=self.db.execute("SELECT content_hash FROM investor_model_epochs WHERE id=?",(self.epoch_id,)).fetchone()
        head=dict(self.db.execute("SELECT id,content_hash FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1").fetchone())
        return {"schema_version":"investor-epoch-control-submit-v1","epoch_id":self.epoch_id,"expected_registration_hash":root[0],"expected_checkpoint":head,
            "expected_revision":self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0],"idempotency_key":"fictional-history-plan-"+str(enabled),
            "enabled":enabled,"acknowledgements":{k:True for k in epochs.ACKS}}

    def test_owned_active_epoch_plans_exact_past_missing_windows_and_preserves_unknown_listener_metadata_without_io(self):
        from contextlib import closing,redirect_stdout,redirect_stderr
        import io
        from worker.investor import epoch_history_plan as planner,epoch_confirmed_feed as feed,data_pipeline
        self.seed();feed.discover_epoch_watches(self.db,now="2026-10-20T19:55:00.000Z")
        before=list(self.db.iterdump());at="2026-10-22T10:00:03.000Z"
        with closing(open_database(self.path,read_only=True)) as reader,patch.object(longport,"_collect_isolated",side_effect=AssertionError("NO_PLAN_IO")) as sdk, \
                patch.object(longport,"read_private_credentials_file",side_effect=AssertionError("NO_PLAN_CREDENTIALS")) as credentials:
            value=planner.plan_epoch_history(reader,"w","owner",self.epoch_id,now=at)
            self.assertEqual(reader.total_changes,0)
        sdk.assert_not_called();credentials.assert_not_called()
        self.assertEqual(value["status"],"download_confirmation_required");self.assertEqual(value["missing_date_count"],4)
        self.assertEqual(len(value["tiles"]),2)
        self.assertTrue(all(t["expected_dates"]==["2026-10-20","2026-10-21"] for t in value["tiles"]))
        self.assertEqual(value["ranges"],[{"market":"US","checkpoint_date":"2026-10-19","past_end_date":"2026-10-21","current_local_date":"2026-10-22"}])
        self.assertEqual(len(value["prior_attempts"]),1);self.assertEqual(value["prior_attempts"][0]["job_status"],"queued")
        self.assertFalse(value["prior_attempts"][0]["network_outcome_inferred"])
        for k in ("future_calls_authorized","current_source_eligibility_restored","monitoring_resumed","trading_permission","market_values_output"):self.assertFalse(value[k])
        self.assertEqual(before,list(self.db.iterdump()))
        from worker.market.contracts import validate_contract
        for change in ({"future_calls_authorized":True},{"provider_calls":1},{"max_batch_calls":5},{"trading_permission":True},{"quotes":[]}):
            with self.assertRaises(WorkbenchError):validate_contract({**value,**change},planner.SCHEMA)
        real=planner.plan_epoch_history
        def readonly(connection,*args,**kwargs):
            self.assertEqual(connection.execute("PRAGMA query_only").fetchone()[0],1)
            return real(connection,*args,**kwargs,now=at)
        stream=io.StringIO()
        self.path.chmod(0o644)
        with redirect_stderr(io.StringIO()),patch.object(data_pipeline,"plan_epoch_history",side_effect=AssertionError("NO_UNSAFE_DATABASE_READ")) as unsafe:
            self.assertEqual(data_pipeline.main(["--db",str(self.path),"--workspace","w","--actor","owner","plan-epoch-history","--epoch",self.epoch_id]),1)
        unsafe.assert_not_called();self.path.chmod(0o600)
        with redirect_stdout(stream),patch.object(data_pipeline,"plan_epoch_history",side_effect=readonly):
            self.assertEqual(data_pipeline.main(["--db",str(self.path),"--workspace","w","--actor","owner","plan-epoch-history","--epoch",self.epoch_id]),0)
        self.assertEqual(json.loads(stream.getvalue()),value);self.assertEqual(before,list(self.db.iterdump()))

    def test_retained_data_conflicts_expiry_and_tiling_cannot_turn_a_plan_into_a_download_or_a_current_grant(self):
        from worker.investor import epoch_history_plan as planner
        from tests.investor import epoch_gap_fixture as gap
        self.seed();at=gap.NOW
        days=[(datetime(2026,1,1).date()+timedelta(days=i)).isoformat() for i in range(70)]
        available={days[20],days[21]};tiles=planner._tiles(days,available)
        self.assertEqual({d for tile in tiles for d in tile},set(days)-available)
        self.assertTrue(all((longport._day(t[-1])-longport._day(t[0])).days<31 for t in tiles))
        self.assertTrue(all(not any(t[0]<=d<=t[-1] for d in available) for t in tiles))
        original=planner.plan_epoch_history(self.db,"w","owner",self.epoch_id,now=at)
        repeated=planner.plan_epoch_history(self.db,"w","owner",self.epoch_id,now="2026-10-22T10:00:04.000Z",planned_at=at)
        self.assertEqual(original["plan_hash"],repeated["plan_hash"])
        for now,planned in (("2026-10-22T10:05:03.000Z",at),(at,"2026-10-22T10:00:04.000Z")):
            with self.assertRaisesRegex(WorkbenchError,"PLAN_EXPIRED"):planner.plan_epoch_history(self.db,"w","owner",self.epoch_id,now=now,planned_at=planned)
        gap.add_prices(self.db,self.saved,["2026-10-20","2026-10-21"])
        before=list(self.db.iterdump());complete=planner.plan_epoch_history(self.db,"w","owner",self.epoch_id,now=at)
        self.assertEqual(complete["status"],"no_missing_past_closes");self.assertEqual(complete["tiles"],[]);self.assertEqual(complete["missing_date_count"],0)
        self.assertNotEqual(complete["plan_hash"],original["plan_hash"]);self.assertEqual(before,list(self.db.iterdump()))
        gap.add_prices(self.db,self.saved,["2026-10-20"],delta="1")
        with self.assertRaisesRegex(WorkbenchError,"CAPTURE_PRICES_CONFLICT"):planner.plan_epoch_history(self.db,"w","owner",self.epoch_id,now=at)

    def test_planning_rejects_paused_foreign_and_withdrawn_epochs_and_does_not_borrow_retired_source_permission(self):
        from worker.investor import epoch_history_plan as planner,epoch_continuation as epochs,eodhd_sources
        at="2026-10-22T10:00:03.000Z";self.seed(False);before=list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError,"EXPLICIT_ACTIVATION_REQUIRED"):planner.plan_epoch_history(self.db,"w","owner",self.epoch_id,now=at)
        self.assertEqual(before,list(self.db.iterdump()))
        epochs.set_epoch_continuation_control(self.db,"w","owner",self.body(True),owner_interaction=True,now="2026-10-20T10:00:03.000Z")
        for workspace,actor,epoch in (("w","foreign",self.epoch_id),("foreign","owner",self.epoch_id),("w","owner","foreign")):
            with self.assertRaises(WorkbenchError):planner.plan_epoch_history(self.db,workspace,actor,epoch,now=at)
        before=list(self.db.iterdump())
        with patch.object(planner.feed,"_context",side_effect=AssertionError("NO_STOPPED_REPLAY")) as heavy:
            with self.assertRaisesRegex(WorkbenchError,"WORKER_STOP_REQUESTED"):planner.plan_epoch_history(self.db,"w","owner",self.epoch_id,now=at,stop_requested=lambda:True)
        heavy.assert_not_called();self.assertEqual(before,list(self.db.iterdump()))
        grant=self.db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
        eodhd_sources.set_authority_enabled(self.db,"w","owner",grant,False,now=at)
        with self.assertRaises(WorkbenchError):planner.plan_epoch_history(self.db,"w","owner",self.epoch_id,now=at)
        for table in ("portfolios","accounts","ledger_events","postings"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM "+table).fetchone()[0],0)


if __name__ == "__main__":
    unittest.main()
