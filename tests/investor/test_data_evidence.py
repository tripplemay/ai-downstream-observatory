"""Fictional owner documents and injected quotes; no real provider or licence."""

from copy import deepcopy
from datetime import datetime, timedelta
from decimal import Decimal
import json
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.investor import test_runtime as queue
from worker.investor.data_evidence import collect_prices, purge_price_payload, resolve_capture, resolve_review, review_source, store_source, validate_facts
from worker.investor.data_snapshot import build_dataset
from worker.market.contracts import observation_semantics, validate_contract
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp
from worker.research.snapshot import MarketView, validate_dataset


NOW = queue.NOW
EXPIRY = "2027-01-01T00:00:00.000Z"
START, END = "2025-06-05", "2025-06-06"


class FictionalClient:
    def __init__(self, market="CN", omit=False, during=None):
        self.market, self.omit, self.during, self.calls = market, omit, during, 0

    def history_candlesticks_by_date(self, symbol, **kwargs):
        self.calls += 1
        if self.during: self.during()
        zone = ZoneInfo({"CN": "Asia/Shanghai", "HK": "Asia/Hong_Kong", "US": "America/New_York"}[self.market])
        return [{"timestamp": datetime(2025, 6, day, tzinfo=zone), "open": Decimal("10"), "high": Decimal("12"), "low": Decimal("9"),
            "close": Decimal("11.25"), "turnover": Decimal("11250"), "volume": 1000, "trade_session": 0} for day in ([5] if self.omit else [5, 6])]


class InvestorDataTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def review(self, kind, facts, label=""):
        source = store_source(self.db, "w", "synthetic-investor", kind,
            {"title": "Fictional " + kind + label, "reference": "synthetic://local/" + kind + label, "excerpt": "Locally invented software test only, not real provider rights or market evidence"}, now=NOW)
        review = review_source(self.db, "w", "synthetic-investor", source["id"], "approved", facts, "Fictional test only", EXPIRY, now=NOW)
        return source, review

    def prepare(self, market="CN", listing="synthetic-alpha", currency=None, label=""):
        currency = currency or {"CN": "CNY", "HK": "HKD", "US": "USD"}[market]
        rights = {"provider": "longport", "account_region": "SG", "markets": ["CN", "HK", "US"], "uses": ["private_research", "private_retention", "private_display", "private_backup"],
            "retention_days": 30, "valid_from": "2025-01-01T00:00:00Z", "valid_until": EXPIRY, "clause_references": ["Fictional agreement, no real authorization"]}
        _, r = self.review("rights", rights, label)
        _, l = self.review("listing", {"listing_id": listing, "provider_symbol": {"CN": "501999.SH", "HK": "9999.HK", "US": "FIC01.US"}[market], "market": market, "currency": currency,
            "quantity_step": "1", "tradable_from": "2020-01-01T00:00:00Z", "tradable_until": None, "product_type": "ETF", "leveraged": False, "inverse": False, "role": "growth",
            "fee_rate": "0.001", "fee_as_of": "2025-01-01", "economic_exposure": "Fictional exposure", "historical_universe_basis": "retrospectively_selected_not_survivorship_free"}, label)
        hours = {"CN": 7, "HK": 8, "US": 20}
        days = []
        for day in (5, 6):
            close = datetime(2025, 6, day, hours[market], tzinfo=instant(NOW).tzinfo)
            stamp = lambda value: value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            days.append({"date": f"2025-06-{day:02d}", "kind": "half" if market == "HK" and day == 6 else "full", "close_at": stamp(close),
                "available_at": stamp(close + timedelta(minutes=1)), "settled_at": stamp(close + timedelta(days=1)), "settlement_rule_known_at": "2024-01-01T00:00:00Z"})
        _, c = self.review("calendar", {"market": market, "range_start": START, "range_end": END, "days": days}, label)
        _, a = self.review("actions", {"listing_id": listing, "range_start": START, "range_end": END, "coverage": "reviewed_complete", "tax_assumption": "Explicit fictional tax model", "events": []}, label)
        return r, l, c, a

    def collect(self, refs, market="CN", client=None):
        with patch("worker.market.providers.longport.stamp", side_effect=lambda value=None: NOW if value is None else stamp(value)):
            return collect_prices(self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), START, END,
                now=NOW, client=client or FictionalClient(market), sdk_version="4.3.7")

    def stub_official_capture(self, refs):
        request = longport._request({key: json.loads(refs[1]["document_json"])["facts"][key]
            for key in ("listing_id", "provider_symbol", "market", "currency")}, START, END, [START, END])
        projection = longport._normalize(FictionalClient().history_candlesticks_by_date("unused"), request=request,
            sdk_version="4.3.7", call_started_at=NOW, call_returned_at=NOW,
            datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")
        # The transport is deliberately stubbed. This tests reconstructed-mode
        # propagation, not network origin, licence approval or real market data.
        with patch.object(longport, "_collect_isolated", return_value=projection), \
                patch("worker.investor.data_evidence._milliseconds", side_effect=lambda value=None: NOW if value is None else value), \
                patch("worker.investor.data_evidence.instant", side_effect=lambda value=None: instant(NOW if value is None else value)):
            return collect_prices(self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), START, END)

    def test_readonly_assembly_dereferences_receipts_and_keeps_injected_data_synthetic(self):
        refs = self.prepare(); capture = self.collect(refs)
        before = self.db.total_changes
        result = build_dataset(self.db, "w", [capture["id"]], [refs[3]["id"]], [], START, END, now=NOW, allow_synthetic=True)
        self.assertEqual(self.db.total_changes, before)
        self.assertEqual(result["dataset"]["mode"], "synthetic")
        self.assertFalse(result["dataset"]["historical_archive_verified"])
        self.assertEqual(len(result["dataset"]["observations"]), 2)
        self.assertEqual(result["dataset"]["observations"][0]["value"], "11.25")
        self.assertNotIn("published_at", result["dataset"]["observations"][0])
        self.assertIn("assumed_available_at", result["dataset"]["observations"][0])
        self.assertFalse(result["manifest"]["external_ai_authorized"])
        self.assert_no_finance()

    def test_test_capture_cannot_enter_default_reader_or_be_relabelled_as_official(self):
        refs = self.prepare(); capture = self.collect(refs)
        with self.assertRaisesRegex(WorkbenchError, "SYNTHETIC_CAPTURE_FORBIDDEN"):
            resolve_capture(self.db, "w", capture["id"], now=NOW)
        self.db.execute("DROP TRIGGER investor_price_capture_no_update")
        receipt = json.loads(capture["receipt_json"]); receipt["qualification"] = "isolated_official_sdk"
        from worker.orchestration.db import canonical_json
        self.db.execute("UPDATE investor_price_captures SET qualification='isolated_official_sdk',receipt_json=?,receipt_hash=? WHERE id=?", (canonical_json(receipt), content_hash(receipt), capture["id"]))
        with self.assertRaisesRegex(WorkbenchError, "EVIDENCE_INVALID"):
            resolve_capture(self.db, "w", capture["id"], now=NOW)

    def test_missing_use_rights_prevents_network_call_and_all_capture_writes(self):
        refs = self.prepare(); source = refs[0]["source_id"]
        facts = json.loads(refs[0]["document_json"])["facts"]; facts["uses"].remove("private_backup")
        replacement = review_source(self.db, "w", "synthetic-investor", source, "approved", facts, "Fictional restricted uses", EXPIRY, now=NOW)
        client = FictionalClient()
        with self.assertRaisesRegex(WorkbenchError, "USE_NOT_GRANTED"):
            self.collect((replacement, *refs[1:]), client=client)
        self.assertEqual(client.calls, 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], 0)

    def test_scope_expiry_source_hash_audit_and_latest_review_are_independently_checked(self):
        refs = self.prepare()
        with self.assertRaisesRegex(WorkbenchError, "OUT_OF_SCOPE"): resolve_review(self.db, "other", refs[0]["id"], "rights", now=NOW)
        review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "withdrawn", None, "Fictional withdrawal", EXPIRY, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "SUPERSEDED"): resolve_review(self.db, "w", refs[0]["id"], "rights", now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "OUT_OF_SCOPE"):
            store_source(self.db, "w", "other", "rights", {"title": "x", "reference": "x", "excerpt": "x"}, now=NOW)

    def test_changed_review_during_provider_call_cannot_commit_old_binding(self):
        refs = self.prepare()
        client = FictionalClient(during=lambda: review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "withdrawn", None, "Changed in flight", EXPIRY, now=NOW))
        with self.assertRaises(WorkbenchError): self.collect(refs, client=client)
        self.assertEqual(client.calls, 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], 0)

    def test_calendar_gaps_product_risk_and_unknown_fee_cannot_be_marked_reviewed(self):
        refs = self.prepare()
        for kind, row, mutate in [("calendar", refs[2], lambda value: value["days"].pop()),
                ("listing", refs[1], lambda value: value.update(leveraged=True)),
                ("listing", refs[1], lambda value: value.update(fee_rate=None))]:
            facts = json.loads(row["document_json"])["facts"]; mutate(facts)
            with self.assertRaisesRegex(WorkbenchError, "FACTS_INVALID"): validate_facts(kind, facts)

    def test_price_coverage_actions_fx_and_duplicate_tiles_are_not_silently_filled(self):
        refs = self.prepare(); client = FictionalClient(omit=True)
        with self.assertRaisesRegex(WorkbenchError, "COVERAGE_MISMATCH"): self.collect(refs, client=client)
        capture, duplicate = self.collect(refs), self.collect(refs)
        with self.assertRaisesRegex(WorkbenchError, "OVERLAPPING_PRICE_CAPTURES"):
            build_dataset(self.db, "w", [capture["id"], duplicate["id"]], [refs[3]["id"]], [], START, END, now=NOW, allow_synthetic=True)
        with self.assertRaisesRegex(WorkbenchError, "ACTION_COVERAGE_INCOMPLETE"):
            build_dataset(self.db, "w", [capture["id"]], [], [], START, END, now=NOW, allow_synthetic=True)
        hk = self.prepare("HK", "synthetic-hk", label="hk"); hk_capture = self.collect(hk, "HK")
        with self.assertRaisesRegex(WorkbenchError, "FX_COVERAGE_INCOMPLETE"):
            build_dataset(self.db, "w", [hk_capture["id"]], [hk[3]["id"]], [], START, END, now=NOW, allow_synthetic=True)

    def test_three_market_closes_and_fx_assumed_availability_remain_separate(self):
        captures, actions, fx = [], [], []
        for market in ("CN", "HK", "US"):
            refs = self.prepare(market, "synthetic-" + market, label=market)
            captures.append(self.collect(refs, market)["id"]); actions.append(refs[3]["id"])
            if market != "CN":
                _, rate = self.review("fx", {"currency": "HKD" if market == "HK" else "USD", "unit": "CNY_per_unit_currency",
                    "rows": [{"observed_at": "2025-06-04T00:00:00Z", "assumed_available_at": "2025-06-04T00:01:00Z", "value": "1.2"}]}, market)
                fx.append(rate["id"])
        result = build_dataset(self.db, "w", captures, actions, fx, START, END, now=NOW, allow_synthetic=True)
        self.assertEqual(len(result["dataset"]["sessions"]), 6)
        self.assertEqual(len(result["dataset"]["observations"]), 8)
        self.assertEqual({row["market"]: row["close_at"].split("T")[1] for row in result["dataset"]["sessions"] if row["session_date"] == START},
                         {"CN": "07:00:00.000Z", "HK": "08:00:00.000Z", "US": "20:00:00.000Z"})
        self.assert_no_finance()

    def test_retention_purge_keeps_receipt_tombstone_and_cannot_be_undone(self):
        refs = self.prepare(); capture = self.collect(refs)
        with self.assertRaisesRegex(WorkbenchError, "PURGE_NOT_DUE"):
            purge_price_payload(self.db, "w", "synthetic-investor", capture["id"], now=NOW)
        until = capture["retain_until"]
        with self.assertRaisesRegex(WorkbenchError, "RETENTION_EXPIRED"):
            resolve_capture(self.db, "w", capture["id"], now=until, allow_synthetic=True)
        payload = bytes(self.db.execute("SELECT projection FROM investor_price_payloads").fetchone()[0])
        purge = purge_price_payload(self.db, "w", "synthetic-investor", capture["id"], now=until)
        self.assertEqual(purge["reason"], "retention_expired")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_payloads").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0], 1)
        self.assertEqual(purge_price_payload(self.db, "w", "synthetic-investor", capture["id"], now=until), purge)
        with self.assertRaisesRegex(Exception, "cannot be replaced"):
            self.db.execute("INSERT INTO investor_price_payloads(capture_id,projection) VALUES(?,?)", (capture["id"], payload))

    def test_withdrawn_rights_block_reads_and_allow_payload_purge_before_retention_deadline(self):
        refs = self.prepare(); capture = self.collect(refs)
        review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "withdrawn", None, "Fictional revocation", EXPIRY, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "SUPERSEDED"): resolve_capture(self.db, "w", capture["id"], now=NOW, allow_synthetic=True)
        self.assertEqual(purge_price_payload(self.db, "w", "synthetic-investor", capture["id"], now=NOW)["reason"], "rights_no_longer_active")

    def test_every_audit_and_capture_row_is_immutable_except_audited_payload_deletion(self):
        refs = self.prepare(); self.collect(refs)
        for table in ("investor_data_sources", "investor_data_reviews", "investor_price_captures"):
            with self.assertRaisesRegex(Exception, "immutable"): self.db.execute("UPDATE " + table + " SET created_at=?", (NOW,))
            with self.assertRaisesRegex(Exception, "immutable"): self.db.execute("DELETE FROM " + table)
            row = dict(self.db.execute("SELECT * FROM " + table).fetchone())
            with self.assertRaises(Exception): self.db.execute("INSERT OR REPLACE INTO " + table + "(" + ",".join(row) + ") VALUES(" + ",".join("?" for _ in row) + ")", tuple(row.values()))
        with self.assertRaisesRegex(Exception, "purge record"): self.db.execute("DELETE FROM investor_price_payloads")

    def test_stubbed_official_transport_reconstructs_history_without_claiming_point_in_time(self):
        refs = self.prepare(); capture = self.stub_official_capture(refs)
        result = build_dataset(self.db, "w", [capture["id"]], [refs[3]["id"]], [], START, END, now=NOW)
        self.assertEqual(result["dataset"]["mode"], "reconstructed")
        self.assertFalse(result["live_advice_eligible"])
        for mode in ("historical_point_in_time", "actual_replay"):
            changed = deepcopy(result["dataset"]); changed.update(mode=mode, historical_archive_verified=True)
            for row in changed["settlements"]:
                row["ingested_at"] = row["published_at"]
            with self.assertRaisesRegex(WorkbenchError, "RECONSTRUCTED_DATA_CANNOT_BECOME_POINT_IN_TIME"):
                validate_dataset(changed)
        manifest = deepcopy(result["manifest"]); manifest["external_ai_authorized"] = True
        with self.assertRaisesRegex(WorkbenchError, "CONTRACT_INVALID"):
            validate_contract(manifest, "investor-data-snapshot.schema.json")
        self.assert_no_finance()

    def test_freezing_reconstruction_cannot_adopt_future_or_later_captured_sources(self):
        refs = self.prepare(); capture = self.stub_official_capture(refs)
        arguments = (self.db, "w", [capture["id"]], [refs[3]["id"]], [], START, END)
        with self.assertRaisesRegex(WorkbenchError, "SNAPSHOT_IN_FUTURE"):
            build_dataset(*arguments, now=NOW, snapshot_at="2026-01-02T12:00:03.001Z")
        with self.assertRaisesRegex(WorkbenchError, "SOURCE_AFTER_SNAPSHOT"):
            build_dataset(*arguments, now=NOW, snapshot_at="2026-01-02T12:00:02.999Z")

    def test_assumed_price_and_fx_times_block_earlier_decisions_without_faking_publication(self):
        refs = self.prepare("HK", "synthetic-hk"); capture = self.collect(refs, "HK")
        _, rate = self.review("fx", {"currency": "HKD", "unit": "CNY_per_unit_currency", "rows": [{
            "observed_at": "2025-06-05T08:00:00Z", "assumed_available_at": "2025-06-05T08:02:00Z", "value": "1.2"}]})
        result = build_dataset(self.db, "w", [capture["id"]], [refs[3]["id"]], [rate["id"]], START, END, now=NOW, allow_synthetic=True)
        data = result["dataset"]; view = MarketView(data, 86400)
        with self.assertRaisesRegex(WorkbenchError, "PRICE_UNAVAILABLE"):
            view.price("synthetic-hk", instant("2025-06-05T08:00:30Z"), decision=True)
        self.assertEqual(str(view.price("synthetic-hk", instant("2025-06-05T08:01:00Z"), decision=True)[0]), "11.25")
        with self.assertRaisesRegex(WorkbenchError, "FX_UNAVAILABLE"):
            view.fx("HKD", instant("2025-06-05T08:01:00Z"))
        self.assertEqual(str(view.fx("HKD", instant("2025-06-05T08:02:00Z"))[0]), "1.2")
        for change in ({"published_at": "2025-06-05T08:01:00Z"}, {"assumed_available_at": "2025-06-05T07:59:00Z"},
                {"assumed_available_at": "2027-01-01T00:00:00Z"}):
            modified = deepcopy(data); next(row for row in modified["observations"] if row["metric"] == "close" and row["observed_at"].startswith(START)).update(change)
            with self.assertRaisesRegex(WorkbenchError, "ASSUMED_AVAILABILITY"):
                validate_dataset(modified)
        row = next(row for row in data["observations"] if row["metric"] == "close")
        with self.assertRaisesRegex(WorkbenchError, "RESEARCH_ONLY"):
            observation_semantics(row, {"id": row["batch_id"], "source_id": row["source_id"], "batch_type": "prices", "source_mode": "synthetic"})

    def test_official_clock_is_not_caller_controlled_and_future_fee_review_is_rejected(self):
        refs = self.prepare()
        with patch.object(longport, "collect_longport_candles") as transport:
            with self.assertRaisesRegex(WorkbenchError, "PRODUCTION_CLOCK_NOT_CALLER_CONTROLLED"):
                collect_prices(self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), START, END, now=NOW)
            transport.assert_not_called()
        facts = json.loads(refs[1]["document_json"])["facts"]; facts["fee_as_of"] = "2027-01-01"
        with self.assertRaisesRegex(WorkbenchError, "FEE_DATE_IN_FUTURE"):
            review_source(self.db, "w", "synthetic-investor", refs[1]["source_id"], "approved", facts, "Future fee", EXPIRY, now=NOW)

    def test_microsecond_sdk_times_survive_millisecond_capture_metadata(self):
        refs = self.prepare()
        started, returned = NOW.removesuffix("000Z") + "000123Z", NOW.removesuffix("000Z") + "000789Z"
        request = longport._request({key: json.loads(refs[1]["document_json"])["facts"][key]
            for key in ("listing_id", "provider_symbol", "market", "currency")}, START, END, [START, END])
        projection = longport._normalize(FictionalClient().history_candlesticks_by_date("unused"), request=request, sdk_version="4.3.7",
            call_started_at=started, call_returned_at=returned, datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")
        with patch.object(longport, "_collect_isolated", return_value=projection), \
                patch("worker.investor.data_evidence._milliseconds", return_value=NOW), \
                patch("worker.investor.data_evidence.instant", side_effect=lambda value=None: instant(NOW.removesuffix("000Z") + "000999Z" if value is None else value)):
            capture = collect_prices(self.db, "w", "synthetic-investor", *(row["id"] for row in refs[:3]), START, END)
        replay = resolve_capture(self.db, "w", capture["id"], now=NOW)
        self.assertEqual(replay["receipt"]["source"]["call_returned_at"], returned)

    def test_restore_lock_prevents_all_evidence_mutations_before_collection(self):
        refs = self.prepare(); marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        marker.touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            store_source(self.db, "w", "synthetic-investor", "rights", {"title": "x", "reference": "x", "excerpt": "x"}, now=NOW)
        client = FictionalClient()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            self.collect(refs, client=client)
        self.assertEqual(client.calls, 0)
