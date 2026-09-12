"""Reproducible synthetic benchmark; no real investment admission claims."""

import argparse
from datetime import datetime, timezone
from decimal import Decimal, localcontext
from hashlib import sha256
import json
from pathlib import Path
import platform
import time
from unittest.mock import patch

from worker.orchestration.db import instant, stamp
from worker.research import compare_backtest
from worker.research.snapshot import MarketView
from tests.research.long_fixtures import long_case
from tests.research.market_reference import ReferenceMarketView


def run_benchmark(days=3300, reference_days=90):
    measured_at = stamp(datetime.now(timezone.utc))
    small = long_case(reference_days)
    started = time.perf_counter()
    with patch("worker.research.backtest.MarketView", ReferenceMarketView):
        reference = compare_backtest(*small, "train")
    old_seconds = time.perf_counter() - started
    started = time.perf_counter()
    current = compare_backtest(*small, "train")
    small_seconds = time.perf_counter() - started
    if reference != current:
        raise AssertionError("full reference report changed")
    dataset, plan, parameters = long_case(days)
    started = time.perf_counter()
    report = compare_backtest(dataset, plan, parameters, "train")
    long_seconds = time.perf_counter() - started
    started = time.perf_counter()
    repeated = compare_backtest(dataset, plan, parameters, "train")
    repeat_seconds = time.perf_counter() - started
    if report != repeated:
        raise AssertionError("long report is nondeterministic")
    end = instant(plan["windows"]["train"]["end"])
    indexed, oracle = MarketView(dataset, 604800), ReferenceMarketView(dataset, 604800)
    started = time.perf_counter()
    for asset in dataset["assets"]:
        if indexed.price(asset["listing_id"], end, decision=True) != oracle.price(asset["listing_id"], end, decision=True):
            raise AssertionError("long endpoint quote differs from original")
        if indexed.fx(asset["currency"], end) != oracle.fx(asset["currency"], end):
            raise AssertionError("long endpoint FX differs from original")
    endpoint_oracle_seconds = time.perf_counter() - started
    # Independent terminal mark from raw, already-final same-day observations;
    # there are no dividend/receivable/foreign-cash effects in this fixture.
    with localcontext() as context:
        context.prec = 60
        terminal = Decimal(report["strategy"]["curve"][-1]["cash_cny"])
        for asset in dataset["assets"]:
            prices = [row for row in dataset["observations"] if row.get("listing_id") == asset["listing_id"] and instant(row["observed_at"]) <= end]
            price = Decimal(max(prices, key=lambda row: instant(row["observed_at"]))["value"])
            rates = [row for row in dataset["observations"] if row["series_key"] == "FX:" + asset["currency"] and instant(row["observed_at"]) <= end]
            rate = Decimal(max(rates, key=lambda row: instant(row["observed_at"]))["value"]) if rates else Decimal("1")
            terminal += Decimal(report["strategy"]["positions"].get(asset["listing_id"], "0")) * price * rate
        if terminal != Decimal(report["strategy"]["ending_nav_cny"]):
            raise AssertionError("independent terminal NAV differs")
    if report["live_advice_eligible"] or any(gate["status"] == "PASS" for gate in report["strategy_gates"].values()):
        raise AssertionError("synthetic benchmark cannot grant strategy admission")
    here = Path(__file__).resolve().parent
    return {"python": platform.python_version(), "platform": platform.platform(), "data_mode": "synthetic",
            "fixture_role": "generic_synthetic_only", "measured_at": measured_at,
            "snapshot_sha256": sha256((here.parents[1] / "worker/research/snapshot.py").read_bytes()).hexdigest(),
            "fixture_sha256": sha256((here / "long_fixtures.py").read_bytes()).hexdigest(),
            "benchmark_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
            "reference_oracle_sha256": sha256((here / "market_reference.py").read_bytes()).hexdigest(),
            "reference_trading_days": reference_days, "reference_seconds": round(old_seconds, 6),
            "indexed_reference_seconds": round(small_seconds, 6), "reference_result_hash": reference["result_hash"],
            "reference_dataset_hash": reference["dataset_hash"], "reference_plan_hash": reference["plan_hash"],
            "reference_ending_nav_cny": reference["strategy"]["ending_nav_cny"], "reference_twr": reference["strategy"]["twr"],
            "synthetic_sessions_per_market": days, "market_sessions": len(dataset["sessions"]), "etfs": len(dataset["assets"]),
            "observations": len(dataset["observations"]), "training_window": plan["windows"]["train"],
            "indexed_long_seconds": round(long_seconds, 6), "indexed_repeat_seconds": round(repeat_seconds, 6),
            "long_endpoint_reference_seconds": round(endpoint_oracle_seconds, 6),
            "long_result_hash": report["result_hash"], "dataset_hash": report["dataset_hash"], "plan_hash": report["plan_hash"],
            "ending_nav_cny": report["strategy"]["ending_nav_cny"], "twr": report["strategy"]["twr"],
            "contributions_cny": report["strategy"]["contributions_cny"], "curve_points": len(report["strategy"]["curve"]),
            "full_small_report_equal": True, "long_repeat_equal": True, "long_endpoint_queries_equal": True,
            "independent_terminal_nav_equal": True, "full_unindexed_long_backtest_run": False, "live_advice_eligible": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=3300)
    parser.add_argument("--reference-days", type=int, default=90)
    args = parser.parse_args()
    if not 30 <= args.days <= 4000 or not 30 <= args.reference_days <= 120:
        parser.error("days 30..4000, reference-days 30..120")
    print(json.dumps(run_benchmark(args.days, args.reference_days), indent=2))


if __name__ == "__main__":
    main()
