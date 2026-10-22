"""Local, fictional read-only replay benchmark; no study or provider request."""

import argparse
from contextlib import nullcontext
from datetime import timedelta
import json
from statistics import median
from time import perf_counter
from unittest.mock import patch

from tests.investor import evidence_fixture as fixture
from tests.investor.fixtures import research_input
from tests.investor.long_horizon_fixtures import long_input
from tests.investor.test_runtime import InvestorRuntimeTests
from worker.investor import data_snapshot
from worker.investor.data_evidence import _fact_validation_scope
from worker.orchestration.db import content_hash, instant


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=1826)
    parser.add_argument("--repeats", type=int, choices=(1, 2, 3), default=1)
    args = parser.parse_args()
    if not 7 <= args.days <= 1826:
        parser.error("FICTIONAL_BENCHMARK_DAYS_OUT_OF_RANGE")
    case = InvestorRuntimeTests()
    try:
        case.setUp()
        start = "2021-01-01"
        end = (instant(start + "T00:00:00Z") + timedelta(days=args.days - 1)).date().isoformat()
        now, expiry = fixture.NOW, fixture.EXPIRY
        data = long_input(days=args.days, start=start + "T00:00:00Z")["dataset"]
        _, plan, policy = research_input()
        review_source = fixture.review_source

        def reviewed(db, workspace, actor, source, decision, facts, *args, **kwargs):
            # Expand only invented test metadata, without changing provider clocks.
            if "tradable_from" in facts:
                facts["tradable_from"] = "2020-01-01T00:00:00Z"
            for day in facts.get("days", []):
                day["settlement_rule_known_at"] = "2020-01-01T00:00:00Z"
            return review_source(db, workspace, actor, source, decision, facts, *args, **kwargs)

        with patch.object(fixture, "START", start), patch.object(fixture, "END", end), \
                patch.object(fixture, "EXPIRY", expiry), patch.object(fixture, "research_input", return_value=(data, plan, policy)), \
                patch.object(fixture, "review_source", side_effect=reviewed), \
                _fact_validation_scope():
            values = fixture.create(case.db, "w", "synthetic-investor", now=now, admit=False)
        before = case.db.total_changes
        arguments = (case.db, "w", values["captures"], values["actions"], [], start, end)
        results, timings = {}, {"uncached": [], "scoped": []}
        for _ in range(args.repeats):
            for label in ("uncached", "scoped"):
                scope = patch.object(data_snapshot, "_fact_validation_scope", nullcontext) if label == "uncached" else nullcontext()
                with scope:
                    started = perf_counter()
                    result = data_snapshot.build_dataset(*arguments, now=now)
                    timings[label].append(perf_counter() - started)
                    results[label] = result
        assert results["uncached"] == results["scoped"]
        assert before == case.db.total_changes
        case.assert_no_finance()
        for table in ("investor_evidence_inputs", "investor_research_requests", "investor_experiments", "investor_trial_intents", "investor_reference_plans"):
            assert case.db.execute("SELECT count(*) FROM " + table).fetchone()[0] == 0
        print(json.dumps({"status": "FICTIONAL_LOCAL_REPLAY_BENCHMARK_PASS_NOT_RELEASE", "days": args.days,
            "assets": len(data["assets"]), "captures": len(values["captures"]), "observations": len(data["observations"]),
            "timings_seconds": timings, "median_speedup": median(timings["uncached"]) / median(timings["scoped"]),
            "identical_full_reconstruction_hash": content_hash(results["scoped"]), "database_writes_during_replay": 0,
            "provider_calls": 0, "experiments_registered": 0, "independent_production_performance_verified": False}))
        return 0
    finally:
        case.doCleanups()


if __name__ == "__main__":
    raise SystemExit(main())
