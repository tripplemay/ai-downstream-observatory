"""Synthetic SDK repeat rows; conflicting prices are never repaired."""

from copy import deepcopy
from datetime import timedelta
import unittest

from tests.market.test_longport_provider import RANGE, RETURNED, STARTED, candle, candles, parse
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, canonical_json, instant


def projection(rows):
    return longport._normalize(rows, request=longport._request(**RANGE), sdk_version=longport.SDK_VERSION,
        call_started_at=STARTED, call_returned_at=RETURNED, datetime_basis="runtime_utc_from_unix_timestamp",
        collector_runtime="isolated_official_sdk", allow_exact_duplicates=True)


class DuplicateProjectionTests(unittest.TestCase):
    def test_both_exact_sdk_rows_remain_hashed_but_only_first_becomes_observation(self):
        result = projection([candle(), candle(), candle("2025-06-06")])
        self.assertEqual(result["schema_version"], "longport-candles-projection-v2")
        self.assertEqual(len(result["projection"]["candlesticks"]), 3)
        self.assertEqual([row["projection_row"] for row in result["records"]], [0, 2])
        self.assertEqual(result["source"]["duplicate_rows"], [{"row": 1, "first_row": 0}])
        self.assertEqual((result["source"]["raw_record_count"], result["source"]["unique_record_count"]), (3, 2))
        replay = longport._parse_child_projection(result["projection_bytes"], result["request"], instant(STARTED), instant(RETURNED))
        self.assertEqual(replay, result)

    def test_no_duplicates_produce_identical_legacy_v1_bytes(self):
        result = projection(candles())
        self.assertEqual(result["schema_version"], "longport-candles-projection-v1")
        self.assertNotIn("duplicate_rows", result["source"])
        legacy = longport._normalize(candles(), request=result["request"], sdk_version=longport.SDK_VERSION,
            call_started_at=STARTED, call_returned_at=RETURNED, datetime_basis="runtime_utc_from_unix_timestamp",
            collector_runtime="isolated_official_sdk")
        self.assertEqual(result, legacy)

    def test_conflicting_fields_even_same_close_same_day_fail(self):
        for changes in ({"close": "10"}, {"open": "10.01"}, {"high": "12"}, {"low": "8"},
            {"turnover": "106"}, {"volume": 9007199254740994},
            {"timestamp": candle().timestamp + timedelta(seconds=1)}, {"open": "10.00000"}):
            with self.subTest(changes=changes), self.assertRaisesRegex(WorkbenchError, "DUPLICATE"):
                projection([candle(), candle(**changes), candle("2025-06-06")])
        with self.assertRaisesRegex(WorkbenchError, "SESSION"):
            projection([candle(), candle(trade_session=1), candle("2025-06-06")])

    def test_repeated_row_does_not_fill_missing_date_or_relax_row_budgets(self):
        with self.assertRaisesRegex(WorkbenchError, "COVERAGE_MISMATCH"): projection([candle(), candle()])
        with self.assertRaisesRegex(WorkbenchError, "CANDLE_COUNT"): projection([candle()] * 31 + [candle("2025-06-06")])
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE"): parse([candle(), candle(), candle("2025-06-06")])

    def test_reordered_nonadjacent_repeats_bind_original_first_row(self):
        result = projection([candle("2025-06-06"), candle(), candle("2025-06-06"), candle()])
        self.assertEqual(result["source"]["duplicate_rows"], [{"row": 2, "first_row": 0}, {"row": 3, "first_row": 1}])
        self.assertEqual([row["projection_row"] for row in result["records"]], [1, 0])

    def test_self_rehashed_false_counts_policy_and_legacy_claim_reject_on_replay(self):
        result = projection([candle(), candle(), candle("2025-06-06")])
        for key, value in (("raw_record_count", 2), ("unique_record_count", 3),
            ("duplicate_rows", [{"row": 1, "first_row": 2}]), ("duplicate_bar_policy", "last_wins")):
            raw = deepcopy(result["projection"]); raw["source"][key] = value
            with self.subTest(key=key), self.assertRaises(WorkbenchError):
                longport._parse_child_projection(canonical_json(raw).encode(), result["request"], instant(STARTED), instant(RETURNED))
        raw = deepcopy(result["projection"]); raw["schema_version"] = "longport-candles-projection-v1"
        with self.assertRaises(WorkbenchError):
            longport._parse_child_projection(canonical_json(raw).encode(), result["request"], instant(STARTED), instant(RETURNED))
