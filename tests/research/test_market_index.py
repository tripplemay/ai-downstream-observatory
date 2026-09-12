from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from worker.orchestration.db import WorkbenchError, instant, stamp
from worker.research import compare_backtest
from worker.research.snapshot import MarketView
from tests.research.fixtures import dataset, parameters, plan
from tests.research.long_fixtures import long_case
from tests.research.market_reference import ReferenceMarketView


HERE = Path(__file__).resolve().parent


def outcome(function, *args, **kwargs):
    try:
        return "value", function(*args, **kwargs)
    except WorkbenchError as error:
        return "error", str(error)


class IndexedMarketTests(unittest.TestCase):
    def test_frozen_report_hashes_and_original_oracle_are_unchanged(self):
        baseline = json.loads((HERE / "performance_baseline.json").read_text())
        self.assertEqual(baseline["cases"]["multi90"]["baseline_basis"], "generic_synthetic_rerun_of_original_oracle")
        self.assertEqual(sha256((HERE / "market_reference.py").read_bytes()).hexdigest(), baseline["reference_oracle_sha256"])
        cases = {"short": (dataset(), plan(), parameters()), "multi90": long_case(90)}
        for name, args in cases.items():
            with self.subTest(case=name):
                current = compare_backtest(*args, "train")
                for key in ("result_hash", "dataset_hash", "plan_hash"):
                    self.assertEqual(current[key], baseline["cases"][name][key])
                with patch("worker.research.backtest.MarketView", ReferenceMarketView):
                    reference = compare_backtest(*args, "train")
                self.assertEqual(current, reference)

    def test_price_revision_pit_missing_and_calendar_boundaries_match_original(self):
        variants = []
        base = dataset()
        variants.append(("original", base))
        missing = deepcopy(base)
        missing["observations"] = [row for row in missing["observations"] if row["id"] != "price:4"]
        variants.append(("missing", missing))
        revised = deepcopy(base)
        for index in (1, 3, 6):
            row = deepcopy(revised["observations"][index])
            row.update(id="revision:" + str(index), revision_id="v2", value="30", source_id="revision-source",
                       published_at=stamp(instant(row["observed_at"]) + timedelta(days=2)))
            revised["observations"].append(row)
        variants.append(("later_revision", revised))
        tied = deepcopy(base)
        row = deepcopy(tied["observations"][5])
        row.update(id="tied-source", source_id="other-source", value="99")
        tied["observations"].append(row)
        variants.append(("ambiguous", tied))
        same = deepcopy(base)
        row = deepcopy(same["observations"][5])
        row.update(id="same-value-other-id", source_id="other-source")
        same["observations"].insert(0, row)
        variants.append(("stable_equal_rank", same))
        delayed = deepcopy(base)
        delayed["sessions"][2]["available_at"] = "2025-01-06T06:00:00Z"
        variants.append(("nonmonotonic_availability", delayed))
        suspended = deepcopy(base)
        suspended["sessions"][3]["trade_allowed"] = False
        variants.append(("nontrading", suspended))
        for name, source in variants:
            for mode in ("synthetic", "historical_point_in_time", "actual_replay"):
                data = deepcopy(source)
                data["mode"] = mode
                if mode == "actual_replay":
                    for index, row in enumerate(data["observations"]):
                        row["ingested_at"] = stamp(instant(row["published_at"]) + timedelta(minutes=index % 3))
                current, reference = MarketView(data, 3600), ReferenceMarketView(data, 3600)
                for day in range(1, 15):
                    for clock in ("06:00:00", "07:00:00", "07:00:30", "07:01:00", "08:00:00"):
                        at = instant("2025-01-%02dT%sZ" % (day, clock))
                        with self.subTest(case=name, mode=mode, at=at):
                            for decision in (False, True):
                                self.assertEqual(outcome(current.price, "CN:TEST", at, decision=decision),
                                                 outcome(reference.price, "CN:TEST", at, decision=decision))
                            exact = at.replace(hour=7, minute=0, second=0)
                            self.assertEqual(outcome(current.price, "CN:TEST", at, exact_at=exact),
                                             outcome(reference.price, "CN:TEST", at, exact_at=exact))
                            self.assertEqual(outcome(current.next_session, "CN:TEST", at, instant("2025-01-14T23:00:00Z")),
                                             outcome(reference.next_session, "CN:TEST", at, instant("2025-01-14T23:00:00Z")))

    def test_fx_visibility_ties_staleness_and_cross_market_queries_match_original(self):
        data, _, _ = long_case(30)
        first = next(row for row in data["observations"] if row["series_key"] == "FX:USD")
        late = deepcopy(first)
        late.update(id="late-fx", revision_id="v2", value="9", published_at="2010-01-08T12:00:00Z")
        data["observations"].append(late)
        tied = deepcopy(next(row for row in data["observations"] if row["id"] == "fx:HKD:3"))
        tied.update(id="tied-fx", revision_id="v2", value="2")
        data["observations"].append(tied)
        for mode in ("synthetic", "actual_replay"):
            data["mode"] = mode
            if mode == "actual_replay":
                for row in data["observations"]:
                    row["ingested_at"] = row["published_at"]
            current, reference = MarketView(data, 86400), ReferenceMarketView(data, 86400)
            for date in ("2010-01-04", "2010-01-05", "2010-01-07", "2010-01-08", "2010-01-10", "2010-02-16"):
                for clock in ("07:00:00", "07:01:00", "08:01:00", "21:00:00", "21:01:00", "23:00:00"):
                    at = instant(date + "T" + clock + "Z")
                    for currency in ("CNY", "HKD", "USD", "EUR"):
                        self.assertEqual(outcome(current.fx, currency, at), outcome(reference.fx, currency, at))
                    for listing in ("CN:EQUITY", "HK:EQUITY", "US:EQUITY"):
                        for decision in (False, True):
                            self.assertEqual(outcome(current.price, listing, at, decision=decision),
                                             outcome(reference.price, listing, at, decision=decision))

    def test_queries_do_not_reparse_or_scan_historical_rows_after_indexing(self):
        data, _, _ = long_case(3300)
        view = MarketView(data, 604800)
        at = instant(data["sessions"][-1]["available_at"])
        with patch("worker.research.snapshot.instant", side_effect=AssertionError("query reparsed history")):
            for asset in data["assets"]:
                view.price(asset["listing_id"], at, decision=True)
                view.fx(asset["currency"], at)
                self.assertIsNone(view.next_session(asset["listing_id"], at, at + timedelta(days=1)))

    def test_3300_session_four_etf_long_window_regression(self):
        expected = json.loads((HERE / "index-benchmark-result.json").read_text())
        args = long_case(3300)
        report = compare_backtest(*args, "train")
        self.assertEqual(len(args[0]["sessions"]), 9900)
        self.assertEqual(len(args[0]["assets"]), 4)
        self.assertEqual(report["result_hash"], expected["long_result_hash"])
        self.assertEqual(report["dataset_hash"], expected["dataset_hash"])
        self.assertEqual(report["plan_hash"], expected["plan_hash"])
        self.assertEqual(report["strategy"]["ending_nav_cny"], expected["ending_nav_cny"])
        self.assertEqual(report["strategy"]["contributions_cny"], "396000")
        self.assertFalse(report["live_advice_eligible"])
        self.assertFalse(any(gate["status"] == "PASS" for gate in report["strategy_gates"].values()))

    def test_generic_fixture_and_benchmark_source_evidence_are_frozen(self):
        expected = json.loads((HERE / "index-benchmark-result.json").read_text())
        _, generic_plan, _ = long_case(3300)
        self.assertEqual(generic_plan["initial_capital_cny"], "240000")
        self.assertEqual({row["amount_cny"] for row in generic_plan["contributions"]}, {"36000"})
        self.assertEqual(expected["fixture_role"], "generic_synthetic_only")
        self.assertIsNotNone(instant(expected["measured_at"]))
        for filename, key in (("long_fixtures.py", "fixture_sha256"), ("benchmark.py", "benchmark_sha256"),
                              ("market_reference.py", "reference_oracle_sha256")):
            self.assertEqual(sha256((HERE / filename).read_bytes()).hexdigest(), expected[key])


if __name__ == "__main__":
    unittest.main()
