from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal, localcontext
from fractions import Fraction
import random
import unittest

from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp
from worker.research.rotation_signals import _text, rank_targets
from worker.research.snapshot import MarketView, validate_dataset


BASE = datetime(2025, 1, 1, tzinfo=timezone.utc)


def parameters(**changes):
    value = {
        "schema_version": "research-rotation-parameters-v1", "universe": ["CN:A"],
        "momentum_sessions": 2, "moving_average_sessions": 3, "top_n": 1,
        "target_fraction": "0.8", "signal_basis": "gross_total_return_index",
        "ranking_currency": "listing_currency", "weighting": "equal_top_n_slots",
        "eligibility": "strictly_above_moving_average", "momentum_floor": None,
        "rebalance": "first_decision_each_month", "tie_break": "listing_id_ascending",
        "insufficient_history": "ineligible", "missing_data": "block",
        "tolerance": {"absolute_cny": "0", "weight": "0"},
    }
    value.update(changes)
    return value


def dataset(prices=None, mode="synthetic"):
    prices = prices or {"CN:A": ["10", "11", "12", "13", "14", "15"]}
    assets, sessions, observations = [], [], []
    market_specs = {"CN": (7, "CNY", "Asia/Shanghai"), "HK": (8, "HKD", "Asia/Hong_Kong"),
                    "US": (21, "USD", "America/New_York")}
    lengths = {}
    for listing, values in prices.items():
        market = listing.split(":")[0]
        hour, currency, zone = market_specs[market]
        lengths[market] = max(lengths.get(market, 0), len(values))
        assets.append({"listing_id": listing, "market": market, "currency": currency, "quantity_step": "1",
                       "tradable_from": stamp(BASE if market != "US" else BASE + timedelta(hours=5)),
                       "source_evidence": "Synthetic research lifecycle"})
        for i, value in enumerate(values):
            if value is None:
                continue
            close = BASE + timedelta(days=i, hours=hour)
            available = close + timedelta(minutes=1)
            observations.append({"id": f"bar:{listing}:{i}", "batch_id": "synthetic:rotation", "source_id": "synthetic",
                                 "listing_id": listing, "series_key": listing, "metric": "close", "value": value,
                                 "unit": currency, "observed_at": stamp(close), "published_at": stamp(available),
                                 "ingested_at": stamp(available), "source_timezone": zone, "time_precision": "second",
                                 "price_basis": "unadjusted", "revision_id": "v1", "raw_hash": content_hash([listing, i, value]),
                                 "parser_version": "synthetic-v1", "provenance": "reconstructed" if mode == "synthetic" else "live_observed"})
    for market, length in lengths.items():
        for i in range(length):
            close = BASE + timedelta(days=i, hours=market_specs[market][0])
            sessions.append({"market": market, "session_date": close.date().isoformat(), "close_at": stamp(close),
                             "available_at": stamp(close + timedelta(minutes=1)), "trade_allowed": True})
    return {"schema_version": "research-dataset-v1", "mode": mode,
            "source_evidence": "Synthetic fixtures only; calendar includes invented sessions",
            "license_scope": "Locally generated synthetic tests", "historical_archive_verified": False,
            "corporate_actions_complete": True, "assets": assets, "sessions": sessions,
            "observations": observations, "actions": [], "publication_refs": []}


def action(identity, kind, at, **fields):
    value = {"id": identity, "listing_id": "CN:A", "type": kind, "at": stamp(at),
             "published_at": stamp(at), "ingested_at": stamp(at), "source_evidence": "Synthetic action"}
    value.update(fields)
    return value


def evaluate(data, params=None, at=None):
    validate_dataset(data)
    market = MarketView(data, 2592000)
    return rank_targets(data, market, params or parameters(), at or BASE + timedelta(days=5, hours=23))


class RotationSignalTests(unittest.TestCase):
    def test_rational_output_rounding_matches_decimal60_including_half_even_and_carry(self):
        generator = random.Random(1729)
        fractions = [Fraction(1, 3), Fraction(-1, 7), Fraction(1, 10 ** 200), Fraction(10 ** 200),
                     Fraction(10 ** 60 + 5, 10 ** 60), Fraction(10 ** 60 + 15, 10 ** 60),
                     Fraction(10 ** 61 - 5, 10 ** 61), Fraction(0)]
        fractions += [Fraction(generator.randint(-10 ** 300, 10 ** 300), generator.randint(1, 10 ** 300)) for _ in range(100)]
        with localcontext() as context:
            context.prec = 60
            for value in fractions:
                self.assertEqual(Decimal(_text(value)), Decimal(value.numerator) / Decimal(value.denominator))

    def test_exact_session_window_momentum_and_ma_are_evidenced(self):
        result = evaluate(dataset())
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["targets"], {"CN:A": "0.8"})
        signal = result["signals"][0]
        self.assertEqual(signal["window"]["observation_ids"], ["bar:CN:A:3", "bar:CN:A:4", "bar:CN:A:5"])
        self.assertEqual(signal["window"]["count"], 3)
        self.assertEqual(len(signal["window"]["selected_vector_hash"]), 64)
        with localcontext() as context:
            context.prec = 60
            self.assertEqual(Decimal(signal["momentum"]), Decimal(2) / 13)
            self.assertEqual(Decimal(signal["moving_average"]), Decimal(14) / 13)
        self.assertEqual(signal["formula"]["reinvestment"], "at_period_close")

    def test_equal_top_n_slots_leave_unfilled_weight_as_cash(self):
        result = evaluate(dataset({"CN:A": ["10", "11", "12"], "CN:B": ["12", "11", "10"]}),
                          parameters(universe=["CN:A", "CN:B"], top_n=4))
        self.assertEqual(result["targets"], {"CN:A": "0.2", "CN:B": "0"})
        self.assertEqual(result["signals"][1]["status"], "ineligible")

    def test_tied_momentum_uses_binary_listing_id_and_all_targets_include_zero(self):
        data = dataset({"CN:a": ["10", "11", "12"], "CN:Z": ["10", "11", "12"]})
        result = evaluate(data, parameters(universe=["CN:a", "CN:Z"]))
        self.assertEqual(result["targets"], {"CN:Z": "0.8", "CN:a": "0"})
        self.assertEqual(result["signals"][1]["reason_codes"], ["OUTSIDE_TOP_N"])

    def test_different_intermediate_paths_do_not_break_an_exact_momentum_tie(self):
        data = dataset({"CN:A": ["13", "14", "15"], "CN:B": ["13", "13", "15"]})
        result = evaluate(data, parameters(universe=["CN:A", "CN:B"]))
        self.assertEqual(result["targets"], {"CN:A": "0.8", "CN:B": "0"})
        self.assertEqual(result["signals"][0]["momentum"], result["signals"][1]["momentum"])

    def test_ma_window_can_be_longer_than_momentum_without_changing_its_denominator(self):
        result = evaluate(dataset(), parameters(momentum_sessions=1, moving_average_sessions=6))
        self.assertEqual(result["signals"][0]["window"]["count"], 6)
        with localcontext() as context:
            context.prec = 60
            self.assertEqual(Decimal(result["signals"][0]["momentum"]), Decimal(1) / 14)

    def test_same_instant_action_order_is_independent_of_input_and_identifier_order(self):
        data = dataset({"CN:A": ["100", "100", "50"]})
        at = BASE + timedelta(days=2, hours=7)
        data["actions"] = [action("a:dividend", "dividend", at, gross_per_unit="5", tax_per_unit="0", pay_at=stamp(at)),
                           action("z:split", "split", at, ratio="2")]
        result = evaluate(data)
        self.assertEqual(result["signals"][0]["momentum"], "0.1")
        self.assertEqual(result["signals"][0]["window"]["action_ids"], ["z:split", "a:dividend"])

    def test_ma_and_floor_comparisons_are_strict(self):
        self.assertEqual(evaluate(dataset({"CN:A": ["10", "10", "10"]}))["targets"], {"CN:A": "0"})
        result = evaluate(dataset({"CN:A": ["10", "11", "12"]}), parameters(momentum_floor="0.2"))
        self.assertEqual(result["targets"], {"CN:A": "0"})
        self.assertIn("MOMENTUM_NOT_STRICTLY_ABOVE_FLOOR", result["signals"][0]["reason_codes"])

    def test_negative_momentum_floor_does_not_implicitly_require_positive_momentum(self):
        result = evaluate(dataset({"CN:A": ["100", "50", "80"]}), parameters(moving_average_sessions=2, momentum_floor="-0.3"))
        self.assertEqual(result["targets"], {"CN:A": "0.8"})
        self.assertEqual(result["signals"][0]["momentum"], "-0.2")

    def test_actual_ipo_short_history_is_ineligible_but_left_truncation_blocks(self):
        data = dataset({"CN:A": ["10", "11"]})
        result = evaluate(data)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["signals"][0]["reason_codes"], ["IPO_INSUFFICIENT_HISTORY"])
        data["assets"][0]["tradable_from"] = "2024-01-01T00:00:00Z"
        result = evaluate(data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["targets"], {})
        self.assertEqual(result["reason_codes"], ["ROTATION_HISTORY_COVERAGE_UNKNOWN:CN:A"])

    def test_missing_older_required_bar_blocks_instead_of_compressing_window(self):
        result = evaluate(dataset({"CN:A": ["10", "11", "12", "13", None, "15"]}))
        self.assertEqual(result["status"], "blocked")
        self.assertIn("MISSING_REQUIRED_ROTATION_BAR:CN:A", result["reason_codes"])

    def test_missing_latest_bar_and_unavailable_latest_session_do_not_fall_back(self):
        data = dataset()
        data["observations"] = data["observations"][:-1]
        self.assertEqual(evaluate(data)["status"], "blocked")
        data = dataset()
        data["sessions"][-1]["available_at"] = stamp(BASE + timedelta(days=6))
        result = evaluate(data)
        self.assertEqual(result["reason_codes"], ["ROTATION_SESSION_NOT_AVAILABLE:CN:A"])

    def test_future_revision_does_not_change_old_decision_but_visible_revision_does(self):
        data = dataset()
        at = BASE + timedelta(days=5, hours=23)
        original = evaluate(data, at=at)
        row = deepcopy(data["observations"][-2])
        row.update(id="revised:old", revision_id="v2", value="100", published_at=stamp(at + timedelta(microseconds=1)),
                   ingested_at=stamp(at + timedelta(microseconds=1)))
        data["observations"].append(row)
        self.assertEqual(evaluate(data, at=at), original)
        changed = evaluate(data, at=at + timedelta(microseconds=1))
        self.assertEqual(changed["targets"], {"CN:A": "0"})
        self.assertEqual(changed["signals"][0]["window"]["observation_ids"][-2], "revised:old")

    def test_actual_replay_filters_by_ingestion_but_historical_pit_uses_publication(self):
        data = dataset(mode="actual_replay")
        at = BASE + timedelta(days=5, hours=23)
        original = evaluate(data, at=at)
        row = deepcopy(data["observations"][-2])
        row.update(id="late:row", revision_id="v2", value="100", published_at=stamp(at - timedelta(hours=1)),
                   ingested_at=stamp(at + timedelta(microseconds=1)))
        data["observations"].append(row)
        self.assertEqual(evaluate(data, at=at), original)
        data["mode"], data["historical_archive_verified"] = "historical_point_in_time", True
        self.assertEqual(evaluate(data, at=at)["targets"], {"CN:A": "0"})

    def test_tied_conflicting_visible_revision_blocks(self):
        data = dataset()
        revised = deepcopy(data["observations"][-1])
        revised.update(id="conflict", revision_id="v2", value="16")
        data["observations"].append(revised)
        self.assertEqual(evaluate(data)["reason_codes"], ["AMBIGUOUS_ROTATION_BAR_REVISION:CN:A"])

    def test_market_windows_are_independent_and_do_not_use_fx_for_ranking(self):
        data = dataset({"CN:A": ["10", "11", "12", "13", "14", "15"], "US:B": ["10", "11", "12", "13", "14", "99"]})
        result = evaluate(data, parameters(universe=["CN:A", "US:B"], top_n=2), BASE + timedelta(days=5, hours=10))
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["signals"][0]["window"]["observation_ids"][-1], "bar:CN:A:5")
        self.assertEqual(result["signals"][1]["window"]["observation_ids"][-1], "bar:US:B:4")

    def test_split_is_neutral_and_gross_dividend_is_reinvested_only_in_signal(self):
        data = dataset({"CN:A": ["100", "100", "50"]})
        event_at = BASE + timedelta(days=2, hours=6)
        data["actions"] = [action("split", "split", event_at, ratio="2"),
                           action("dividend", "dividend", event_at, gross_per_unit="5", tax_per_unit="2", pay_at=stamp(event_at + timedelta(days=5)))]
        before = deepcopy(data)
        result = evaluate(data)
        self.assertEqual(result["signals"][0]["momentum"], "0.1")
        self.assertEqual(result["signals"][0]["window"]["action_ids"], ["split", "dividend"])
        self.assertEqual(data, before)
        data["actions"] = data["actions"][:1]
        self.assertEqual(evaluate(data)["signals"][0]["momentum"], "0")

    def test_later_split_does_not_multiply_preceding_dividend_cash(self):
        data = dataset({"CN:A": ["100", "100", "25"]})
        start = BASE + timedelta(days=1, hours=8)
        data["actions"] = [action("first_div", "dividend", start, gross_per_unit="10", tax_per_unit="0", pay_at=stamp(start)),
                           action("later_split", "split", start + timedelta(hours=1), ratio="4"),
                           action("later_div", "dividend", start + timedelta(hours=2), gross_per_unit="1", tax_per_unit="0", pay_at=stamp(start + timedelta(hours=2)))]
        signal = evaluate(data)["signals"][0]
        self.assertEqual(signal["momentum"], "0.14")
        self.assertEqual(signal["window"]["action_ids"], ["first_div", "later_split", "later_div"])

    def test_future_actions_and_dataset_order_do_not_change_rankings(self):
        data = dataset()
        original = evaluate(data)
        future = BASE + timedelta(days=6, hours=6)
        data["actions"].append(action("future_split", "split", future, ratio="10"))
        data["sessions"].reverse()
        data["observations"].reverse()
        self.assertEqual(evaluate(data), original)

    def test_inactive_lifecycle_is_ineligible(self):
        data = dataset({"CN:A": ["10", "11", "12"]})
        data["assets"][0]["tradable_until"] = stamp(BASE + timedelta(days=3))
        result = evaluate(data)
        self.assertEqual(result["targets"], {"CN:A": "0"})
        self.assertEqual(result["signals"][0]["reason_codes"], ["ASSET_NOT_ACTIVE_AT_DECISION"])

    def test_missing_action_coverage_blocks_even_if_all_prices_exist(self):
        data = dataset()
        data["corporate_actions_complete"] = False
        self.assertEqual(evaluate(data)["reason_codes"], ["ROTATION_CORPORATE_ACTIONS_INCOMPLETE:CN:A"])

    def test_extreme_action_products_block_instead_of_emitting_unbounded_decimals(self):
        data = dataset({"CN:A": ["100", "100", "100"]})
        at = BASE + timedelta(days=2, hours=6)
        data["actions"] = [action(f"split:{i}", "split", at + timedelta(seconds=i), ratio="1" + "0" * 37) for i in range(9)]
        result = evaluate(data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["targets"], {})
        self.assertEqual(result["reason_codes"], ["ROTATION_NUMERIC_EVIDENCE_LIMIT:CN:A"])

    def test_full_500_point_window_is_bounded_and_input_is_unchanged(self):
        data = dataset({"CN:A": [str(1000 + i) for i in range(500)]})
        before = content_hash(data)
        result = evaluate(data, parameters(momentum_sessions=252, moving_average_sessions=500), BASE + timedelta(days=500))
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["signals"][0]["window"]["count"], 500)
        self.assertLess(len(str(result)), 15000)
        self.assertEqual(content_hash(data), before)

    def test_invalid_explicit_parameters_and_wrong_market_snapshot_are_rejected(self):
        for changes in ({"target_fraction": "0"}, {"target_fraction": "1.1"}, {"momentum_sessions": 0},
                        {"moving_average_sessions": 1}, {"momentum_floor": 0.1},
                        {"momentum_floor": "-1.01"}, {"tolerance": {"absolute_cny": "0", "weight": "1.01"}},
                        {"universe": ["CN:A", "CN:A"]}, {"universe": ["CN:UNKNOWN"]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                evaluate(dataset(), parameters(**changes))
        data = dataset()
        other = dataset({"CN:A": ["1", "2", "3"]})
        with self.assertRaisesRegex(WorkbenchError, "ROTATION_MARKET_DATASET_MISMATCH"):
            rank_targets(data, MarketView(other, 10), parameters(), instant("2025-01-06T23:00:00Z"))


if __name__ == "__main__":
    unittest.main()
