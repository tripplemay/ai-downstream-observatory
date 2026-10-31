"""Fictional current closes and stubbed SDK, not real monitoring qualification."""

from copy import deepcopy
from datetime import datetime
from decimal import Decimal
import json
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.investor import test_runtime as queue
from tests.investor.fixtures import monitor_input
from worker.investor.data_evidence import collect_prices, purge_price_payload, review_source, store_source
from worker.investor.monitor_data import build_monitor_data, check_reference_listing_identity, resolve_monitor_data
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, stamp


NOW = "2026-01-03T12:00:03.000Z"
EXPIRY = "2027-01-01T00:00:00.000Z"


class InvestorMonitorDataTests(unittest.TestCase):
    workspace_id = "w"
    setUp = queue.InvestorRuntimeTests.setUp
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def reviewed(self, kind, facts, label):
        source = store_source(self.db, self.workspace_id, "synthetic-investor", kind, {"title": "FICTIONAL " + label,
            "reference": "synthetic://monitor-data/" + label, "excerpt": "Invented test facts, not market/provider/rights certification"}, now=NOW)
        return review_source(self.db, self.workspace_id, "synthetic-investor", source["id"], "approved", facts, "Fictional unit test only", EXPIRY, now=NOW)

    def fixture(self, markets=("CN", "HK", "US"), *, injected=False, events=False, identities=None, roles=None, external_ai=False, confirmed_latest=False, extra_closed_day=False):
        rights = self.reviewed("rights", {"provider": "longport", "account_region": "SG", "markets": list(dict.fromkeys(markets)),
            "uses": ["private_research", "private_retention", "private_display", "private_backup"] + (["external_ai"] if external_ai else []), "retention_days": 30,
            "valid_from": "2025-01-01T00:00:00Z", "valid_until": EXPIRY, "clause_references": ["Fictional rights only"]}, "rights")
        windows, targets, references, calendar_cache, market_windows, fx_cache = [], [], [], {}, {}, {}
        for index, market in enumerate(markets):
            currency = {"CN": "CNY", "HK": "HKD", "US": "USD"}[market]
            identity, hour = identities[index] if identities else "fixture-" + market, {"CN": 7, "HK": 8, "US": 20}[market]
            mapping = {"listing_id": identity, "market": market, "currency": currency,
                "provider_symbol": {"CN:ALPHA": "501998.SH", "US:BETA": "FIC02.US", "HK:ALPHA": "9998.HK"}.get(identity, {"CN": "501999.SH", "HK": "9999.HK", "US": "FIC01.US"}[market])}
            listing = self.reviewed("listing", {**mapping, "quantity_step": "1", "tradable_from": "2020-01-01T00:00:00Z", "tradable_until": None,
                "product_type": "ETF", "leveraged": False, "inverse": False, "role": roles[identity] if roles else "growth", "fee_rate": "0.001", "fee_as_of": "2025-01-01",
                "economic_exposure": "Fictional exposure", "historical_universe_basis": "retrospectively_selected_not_survivorship_free"}, identity + "-listing")
            def calendar_stamp(day, hours=hour): return f"2026-01-{day:02d}T{hours:02d}:00:00.000Z"
            calendar = calendar_cache.get(market) or self.reviewed("calendar", {"market": market, "range_start": "2026-01-01", "range_end": "2026-01-04" if extra_closed_day else "2026-01-03", "days": [
                {"date": f"2026-01-{day:02d}", "kind": "half" if day == 2 and market == "HK" else "full", "close_at": calendar_stamp(day),
                 "available_at": calendar_stamp(day).replace(":00:00.", ":01:00."), "settled_at": calendar_stamp(day + 1), "settlement_rule_known_at": "2025-12-01T00:00:00Z"} for day in (1, 2)
            ] + [{"date": "2026-01-03", "kind": "closed", "close_at": None, "available_at": None, "settled_at": None, "settlement_rule_known_at": None}]
              + ([{"date": "2026-01-04", "kind": "closed", "close_at": None, "available_at": None, "settled_at": None, "settlement_rule_known_at": None}] if extra_closed_day else [])}, market + "-calendar")
            if market == "US":
                facts = json.loads(calendar["document_json"])["facts"]
                if facts["days"][1]["kind"] != "closed":
                    facts["days"][1].update(kind="closed", close_at=None, available_at=None, settled_at=None, settlement_rule_known_at=None)
                    calendar = review_source(self.db, self.workspace_id, "synthetic-investor", calendar["source_id"], "approved", facts, "Fictional US holiday only", EXPIRY, now=NOW)
            calendar_cache[market] = calendar
            declared = [{"id": "fictional-dividend:" + identity, "listing_id": identity, "type": "dividend", "at": "2026-01-01T03:00:00Z",
                "published_at": "2025-12-30T00:00:00Z", "source_evidence": "Fictional action only", "gross_per_unit": "1.1", "tax_per_unit": "0.1", "pay_at": "2026-01-02T01:00:00Z"},
                {"id": "fictional-split:" + identity, "listing_id": identity, "type": "split", "at": "2026-01-02T03:00:00Z", "published_at": "2025-12-30T00:00:00Z", "source_evidence": "Fictional action only", "ratio": "2"}] if events and market == "CN" else []
            actions = self.reviewed("actions", {"listing_id": identity, "range_start": "2026-01-01", "range_end": "2026-01-03",
                "coverage": "reviewed_complete", "tax_assumption": "Fictional net amount assumption", "events": declared}, identity + "-actions")
            end, expected = ("2026-01-01", ["2026-01-01"]) if market == "US" else ("2026-01-02", ["2026-01-01", "2026-01-02"])
            capture_end, capture_expected = ("2026-01-01", ["2026-01-01"]) if confirmed_latest and market != "US" else (end, expected)
            request = longport._request(mapping, "2026-01-01", capture_end, capture_expected)
            candles = [{"timestamp": datetime.fromisoformat(day).replace(tzinfo=ZoneInfo(longport._MARKETS[market][0])),
                "open": Decimal("10"), "high": Decimal("12"), "low": Decimal("9"), "close": Decimal("11.25"),
                "turnover": Decimal("11250"), "volume": 1000, "trade_session": 0} for day in capture_expected]
            projection = longport._normalize(candles, request=request, sdk_version="4.3.7", call_started_at=NOW, call_returned_at=NOW,
                datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")
            with patch.object(longport, "_collect_isolated", return_value=projection), \
                    patch("worker.investor.data_evidence._milliseconds", side_effect=lambda value=None: NOW if value is None else value), \
                    patch("worker.investor.data_evidence.instant", side_effect=lambda value=None: instant(NOW if value is None else value)):
                if injected:
                    class Client:
                        def history_candlesticks_by_date(self, *args, **kwargs): return candles
                    with patch.object(longport, "stamp", side_effect=lambda value=None: NOW if value is None else stamp(value)):
                        capture = collect_prices(self.db, self.workspace_id, "synthetic-investor", rights["id"], listing["id"], calendar["id"], "2026-01-01", capture_end,
                            now=NOW, client=Client(), sdk_version="4.3.7")
                else:
                    capture = collect_prices(self.db, self.workspace_id, "synthetic-investor", rights["id"], listing["id"], calendar["id"], "2026-01-01", capture_end)
            confirmed = None
            if confirmed_latest and market != "US":
                from .confirmed_capture_fixture import FictionalReceiver
                from worker.investor import confirmed_capture as confirmed_store
                from worker.market.providers import longport_confirmed
                mock = FictionalReceiver(now=NOW)
                original_millis, original_instant = confirmed_store._milliseconds, confirmed_store.instant
                with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=lambda request, **kwargs: mock(request, kwargs["stop_requested"])), \
                        patch.object(confirmed_store, "_milliseconds", side_effect=lambda value=None: original_millis(NOW if value is None else value)), \
                        patch.object(confirmed_store, "instant", side_effect=lambda value=None: original_instant(NOW if value is None else value)):
                    confirmed = confirmed_store.collect_confirmed_prices(self.db, self.workspace_id, "synthetic-investor", [{"rights_review_id": rights["id"],
                        "listing_review_id": listing["id"], "calendar_review_id": calendar["id"], "session_date": end}], watch_seconds=1)
            fx_ids = []
            if currency != "CNY":
                fx = fx_cache.get(currency) or self.reviewed("fx", {"currency": currency, "unit": "CNY_per_unit_currency", "rows": [
                    {"observed_at": "2026-01-01T10:00:00Z", "assumed_available_at": "2026-01-01T10:01:00Z", "value": "1.2"},
                    {"observed_at": NOW[:10] + "T10:00:00Z", "assumed_available_at": NOW[:10] + "T10:01:00Z", "value": "1.25"}]}, currency + "-fx")
                fx_cache[currency] = fx
                fx_ids.append(fx["id"])
            if market in market_windows:
                market_windows[market]["capture_ids"].append(capture["id"])
                market_windows[market]["action_review_ids"].append(actions["id"])
                if confirmed: market_windows[market]["confirmed_capture_ids"].append(confirmed["id"])
            else:
                window = {"capture_ids": [capture["id"]], "action_review_ids": [actions["id"]], "fx_review_ids": fx_ids, "start_date": "2026-01-01", "end_date": end}
                if confirmed: window["confirmed_capture_ids"] = [confirmed["id"]]
                market_windows[market] = window; windows.append(window)
            weight = "1" if len(markets) == 1 else "0.5" if len(markets) == 2 else ("0.33333334" if index == 0 else "0.33333333")
            targets.append({"listing_id": identity, "market": market, "currency": currency, "weight": weight})
            references.append({"rights": rights, "listing": listing, "calendar": calendar, "actions": actions, "capture": capture, "confirmed_capture": confirmed})
        definition = {"schema_version": "investor-model-definition-v1", "model_id": "fictional-monitor", "profile_id": "fictional-profile", "profile_version": 1,
            "profile_hash": "a" * 64, "plan_id": "fictional-plan", "plan_hash": "b" * 64, "targets": targets, "created_at": NOW, "valid_until": EXPIRY,
            "data_mode": "reconstructed", "scope": "research_model", "live_advice_eligible": False}
        definition["target_definition_hash"] = content_hash({key: definition[key] for key in ("profile_hash", "plan_hash", "targets")})
        settings = {"policy": monitor_input()["policy"], "funding_intent": None, "max_quote_age_seconds": 172800}
        return definition, windows, settings, references

    def test_three_market_different_closes_actual_receipt_time_and_newer_fx(self):
        definition, windows, settings, _ = self.fixture(events=True)
        before = self.db.total_changes
        result = build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        self.assertEqual(self.db.total_changes, before)
        projected = result["projection"]
        self.assertEqual(projected["quality_gaps"], [])
        self.assertEqual({row["market"]: row["observed_at"] for row in projected["quotes"]},
            {"CN": "2026-01-02T07:00:00.000Z", "HK": "2026-01-02T08:00:00.000Z", "US": "2026-01-01T20:00:00.000Z"})
        self.assertTrue(all(instant(row["known_at"]) == instant(NOW) for row in projected["quotes"]))
        self.assertEqual([row["value"] for row in projected["fx"]], ["1.25", "1.25"])
        self.assertEqual(projected["valid_until"], "2026-01-03T16:00:00.000Z")
        self.assertEqual({row["kind"] for row in projected["corporate_actions"]}, {"split", "dividend_ex", "dividend_payment"})
        dividend = next(row for row in projected["corporate_actions"] if row["kind"] == "dividend_ex")
        self.assertEqual(dividend["net_per_unit"], "1")
        self.assertEqual(dividend["known_at"], NOW)
        self.assertNotIn("quotes", canonical_json(result["document"]))
        self.assertEqual(result["document"]["projection_hash"], content_hash(projected))
        replay = resolve_monitor_data(self.db, "w", definition, result["document"], now=NOW)
        self.assertEqual(replay["projection"], projected)
        self.assertEqual(self.db.total_changes, before)
        self.assert_no_finance()

    def test_projection_expiry_does_not_extend_source_retention(self):
        definition, windows, settings, _ = self.fixture()
        result = build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        replay = resolve_monitor_data(self.db, "w", definition, result["document"], now=result["projection"]["valid_until"])
        self.assertEqual(replay["unavailable_reason"], "MONITOR_DATA_PROJECTION_EXPIRED")
        self.assertIsNone(replay["projection"])

    def test_withdrawn_purged_and_expired_sources_cannot_replay(self):
        definition, windows, settings, refs = self.fixture(("CN",))
        result = build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        rights = refs[0]["rights"]
        review_source(self.db, "w", "synthetic-investor", rights["source_id"], "withdrawn", None, "Fictional withdrawal", EXPIRY, now=NOW)
        replay = resolve_monitor_data(self.db, "w", definition, result["document"], now=NOW)
        self.assertEqual(replay["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.assertIsNone(replay["projection"])
        purge_price_payload(self.db, "w", "synthetic-investor", refs[0]["capture"]["id"], now=NOW)
        replay = resolve_monitor_data(self.db, "w", definition, result["document"], now=NOW)
        self.assertIsNone(replay["projection"])
        replay = resolve_monitor_data(self.db, "w", definition, result["document"], now=result["document"]["valid_until"])
        self.assertEqual(replay["unavailable_reason"], "REFERENCE_SOURCE_EXPIRED")
        self.assert_no_finance()

    def test_forged_hash_identity_target_scope_and_extra_window_are_rejected(self):
        definition, windows, settings, _ = self.fixture(("CN",))
        result = build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        for key, value in (("projection_hash", "c" * 64), ("target_definition_hash", "d" * 64), ("model_id", "other"), ("workspace_id", "other")):
            with self.subTest(key=key), self.assertRaises(WorkbenchError):
                resolve_monitor_data(self.db, "w", definition, {**result["document"], key: value}, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "MARKET_WINDOWS"):
            build_monitor_data(self.db, "w", definition, windows * 2, settings, now=NOW)
        corrupt = deepcopy(definition); corrupt["targets"][0]["currency"] = "USD"
        corrupt["target_definition_hash"] = content_hash({key: corrupt[key] for key in ("profile_hash", "plan_hash", "targets")})
        with self.assertRaisesRegex(WorkbenchError, "LISTING_SCOPE"):
            build_monitor_data(self.db, "w", corrupt, windows, settings, now=NOW)

    def test_injected_quote_capture_never_enters_monitor_projection(self):
        definition, windows, settings, _ = self.fixture(("CN",), injected=True)
        with self.assertRaisesRegex(WorkbenchError, "SYNTHETIC_CAPTURE_FORBIDDEN"):
            build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)

    def test_stale_quote_is_a_specific_gap_not_a_default_price(self):
        definition, windows, settings, _ = self.fixture(("CN",))
        settings["max_quote_age_seconds"] = 1
        result = build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        self.assertEqual(result["projection"]["quotes"], [])
        self.assertEqual(result["projection"]["quality_gaps"], ["MONITOR_PRICE_EXPIRED_CN"])
        self.assert_no_finance()

    def test_settings_reject_hidden_defaults_negative_costs_and_price_arrays(self):
        definition, windows, settings, _ = self.fixture(("CN",))
        mutations = [lambda value: value.pop("max_quote_age_seconds"), lambda value: value.update(max_quote_age_seconds=0),
            lambda value: value.update(quotes=[{"close": "100"}]), lambda value: value["policy"].update(weight_band="-1"),
            lambda value: value["policy"]["costs"].update(minimum_fee_cny="-1"),
            lambda value: value.update(funding_intent={"id": "planned", "amount_cny": "0", "expected_at": NOW})]
        for mutate in mutations:
            bad = deepcopy(settings); mutate(bad)
            with self.assertRaises(WorkbenchError): build_monitor_data(self.db, "w", definition, windows, bad, now=NOW)

    def test_calendar_horizon_expires_and_unknown_days_do_not_imply_holidays(self):
        definition, windows, settings, _ = self.fixture(("CN",))
        result = build_monitor_data(self.db, "w", definition, windows, settings, now="2026-01-04T12:00:03.000Z")
        self.assertEqual(result["projection"]["quotes"], [])
        self.assertIn("MONITOR_CALENDAR_NOT_CURRENT_CN", result["projection"]["quality_gaps"])
        self.assertIn("MONITOR_PRICE_EXPIRED_CN", result["projection"]["quality_gaps"])

    def test_future_model_microseconds_and_funding_precision_are_not_truncated(self):
        definition, windows, settings, _ = self.fixture(("CN",))
        definition["created_at"] = "2026-01-03T12:00:03.000001Z"
        with self.assertRaisesRegex(WorkbenchError, "MODEL_NOT_CURRENT"):
            build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        definition["created_at"] = NOW
        settings["funding_intent"] = {"id": "planned-only", "amount_cny": "2000", "expected_at": "2026-01-04T00:00:00.0000001Z"}
        with self.assertRaisesRegex(WorkbenchError, "CONTRACT_INVALID"):
            build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)

    def test_deleted_payload_is_detected_independently_of_current_review(self):
        definition, windows, settings, refs = self.fixture(("CN",))
        result = build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        self.db.execute("DROP TRIGGER investor_price_payload_delete")
        self.db.execute("DELETE FROM investor_price_payloads WHERE capture_id=?", (refs[0]["capture"]["id"],))
        with self.assertRaises(WorkbenchError):
            resolve_monitor_data(self.db, "w", definition, result["document"], now=NOW)

    def test_same_local_listing_id_cannot_silently_change_reference_symbol(self):
        definition, windows, settings, _ = self.fixture(("CN",))
        result = build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        targets = [{**row, "symbol": "501999.SH"} for row in definition["targets"]]
        check_reference_listing_identity(targets, result["catalog"])
        changed = deepcopy(result["catalog"])
        changed["fixture-CN"]["provider_symbol"] = "501998.SH"
        with self.assertRaisesRegex(WorkbenchError, "IDENTITY_CHANGED"):
            check_reference_listing_identity(targets, changed)


if __name__ == "__main__": unittest.main()
