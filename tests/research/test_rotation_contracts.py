from copy import deepcopy
from datetime import timedelta
import unittest

from tests.research.fixtures import dataset, plan
from worker.accounting import AccountingError
from worker.orchestration.db import WorkbenchError, instant, stamp
from worker.research.snapshot import validate_dataset, validate_parameters, validate_plan


def rotation_parameters():
    return {"schema_version": "research-rotation-parameters-v1", "universe": ["CN:TEST"],
            "momentum_sessions": 2, "moving_average_sessions": 3, "top_n": 2, "target_fraction": "0.8",
            "signal_basis": "gross_total_return_index", "ranking_currency": "listing_currency",
            "weighting": "equal_top_n_slots", "eligibility": "strictly_above_moving_average",
            "momentum_floor": None, "rebalance": "first_decision_each_month", "tie_break": "listing_id_ascending",
            "insufficient_history": "ineligible", "missing_data": "block",
            "tolerance": {"absolute_cny": "0", "weight": "0"}}


def versioned_case():
    data, specification = dataset(), plan()
    data["schema_version"] = "research-dataset-v2"
    data["settlements"] = [{"market": row["market"], "session_date": row["session_date"],
                            "settled_at": stamp(instant(row["close_at"]) + timedelta(days=2)),
                            "published_at": "2024-12-01T00:00:00Z", "source_evidence": "Synthetic explicit calendar"}
                           for row in data["sessions"]]
    specification["schema_version"] = "research-plan-v2"
    specification["parameter_candidates"] = [rotation_parameters()]
    specification["benchmark"] = {"schema_version": "research-fixed-rebalance-parameters-v1",
                                  "weights": {"CN:TEST": "0.8"}, "rebalance": "first_decision_each_month",
                                  "tolerance": {"absolute_cny": "0", "weight": "0"}}
    specification["execution"].update(settlement_model="explicit_market_calendar",
                                      sale_proceeds="convert_to_cny_at_fill_then_settle")
    return data, specification


class RotationContractTests(unittest.TestCase):
    def test_v1_and_v2_have_explicit_distinct_semantics(self):
        validate_dataset(dataset())
        validate_plan(plan(), dataset())
        data, specification = versioned_case()
        validate_dataset(data)
        validate_plan(specification, data)
        for bad_plan, bad_data in ((plan(), data), (specification, dataset())):
            with self.assertRaisesRegex(WorkbenchError, "VERSION_MISMATCH"):
                validate_plan(bad_plan, bad_data)

    def test_old_plan_cannot_silently_gain_rotation_or_sale_semantics(self):
        data, specification = versioned_case()
        specification["schema_version"] = "research-plan-v1"
        with self.assertRaises(ValueError):
            validate_plan(specification, data)
        old_data = dataset()
        old_data["settlements"] = data["settlements"]
        with self.assertRaises(ValueError):
            validate_dataset(old_data)

    def test_v2_cannot_use_old_contribution_only_benchmark_or_unknown_flags(self):
        data, specification = versioned_case()
        specification["benchmark"] = plan()["benchmark"]
        with self.assertRaises(ValueError):
            validate_plan(specification, data)
        data, specification = versioned_case()
        specification["execution"]["assume_instant_settlement"] = True
        with self.assertRaises(ValueError):
            validate_plan(specification, data)

    def test_settlement_calendar_is_exact_complete_unique_and_chronological(self):
        for mutation in ("missing", "duplicate", "unknown", "early", "future"):
            data, _ = versioned_case()
            if mutation == "missing":
                data["settlements"].pop()
            elif mutation == "duplicate":
                data["settlements"].append(deepcopy(data["settlements"][0]))
            elif mutation == "unknown":
                data["settlements"][0]["market"] = "US"
            else:
                data["settlements"][0]["settled_at" if mutation == "early" else "published_at"] = (
                    "2024-01-01T00:00:00Z" if mutation == "early" else "2025-02-01T00:00:00Z")
            with self.subTest(mutation=mutation), self.assertRaisesRegex(WorkbenchError, "SETTLEMENT_CALENDAR"):
                validate_dataset(data)

    def test_actual_replay_requires_calendar_ingestion_evidence_not_late_knowledge(self):
        data, _ = versioned_case()
        data["mode"] = "actual_replay"
        for row in data["observations"]:
            row.update(provenance="live_observed", ingested_at=row["published_at"])
        with self.assertRaises(ValueError):
            validate_dataset(data)
        for row in data["settlements"]:
            row["ingested_at"] = row["published_at"]
        validate_dataset(data)
        data["settlements"][0]["ingested_at"] = "2025-02-01T00:00:00Z"
        with self.assertRaisesRegex(WorkbenchError, "SETTLEMENT_CALENDAR"):
            validate_dataset(data)

    def test_parameter_quantities_and_semantics_fail_closed(self):
        cases = [("target_fraction", "0"), ("target_fraction", "1.01"), ("momentum_floor", "-1.01"),
                 ("momentum_sessions", True), ("moving_average_sessions", 1), ("top_n", 101),
                 ("universe", ["CN:UNKNOWN"]), ("universe", ["CN:TEST", "CN:TEST"]),
                 ("target_fraction", "0.0000000000000000001"), ("signal_basis", "adjusted_close")]
        for key, value in cases:
            parameters = rotation_parameters()
            parameters[key] = value
            with self.subTest(key=key, value=value), self.assertRaises((ValueError, AccountingError)):
                validate_parameters(parameters, dataset())
        for tolerance in ({"absolute_cny": "-1", "weight": "0"}, {"absolute_cny": "0", "weight": "1.1"}):
            parameters = rotation_parameters()
            parameters["tolerance"] = tolerance
            with self.assertRaisesRegex(WorkbenchError, "TOLERANCE"):
                validate_parameters(parameters, dataset())

    def test_fixed_rebalance_weights_and_sell_price_bounds(self):
        data, specification = versioned_case()
        specification["benchmark"]["weights"] = {"CN:TEST": "1.1"}
        with self.assertRaisesRegex(WorkbenchError, "WEIGHTS"):
            validate_plan(specification, data)
        data, specification = versioned_case()
        specification["execution"]["slippage_bps"] = "10000"
        with self.assertRaisesRegex(WorkbenchError, "SELL_SLIPPAGE"):
            validate_plan(specification, data)


if __name__ == "__main__":
    unittest.main()
