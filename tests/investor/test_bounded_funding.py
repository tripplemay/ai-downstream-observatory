from copy import deepcopy
import json
import subprocess
import sys
import unittest
from zoneinfo import ZoneInfo

from tests.investor.bounded_funding_fixtures import bounded_input, cases
from tests.investor.funded_history_fixtures import funded_input
from worker.accounting import decimal
from worker.investor.funded_history import calculate_funded_history, prepare_funded_history
from worker.investor.long_horizon import funding_schedule, validate_input
from worker.market.contracts import validate_contract
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash
from worker.research.rotation import run_continuous_portfolio


def traces(document):
    _, kernel = prepare_funded_history(document, allow_synthetic=True)
    for name in ("immediate", "staged"):
        _, releases = funding_schedule(kernel["plan"], ZoneInfo(kernel["plan"]["evaluation_timezone"]), staged=name == "staged")
        yield name, run_continuous_portfolio(kernel["dataset"], kernel["plan"], releases)


class BoundedFundingTests(unittest.TestCase):
    def test_new_contracts_preserve_bounds_and_do_not_widen_closed_legacy_versions(self):
        document = bounded_input(); before = deepcopy(document)
        _, kernel = prepare_funded_history(document, allow_synthetic=True)
        result = calculate_funded_history(document, allow_synthetic=True)
        self.assertEqual(document, before)
        self.assertEqual(kernel["schema_version"], "investor-long-horizon-input-v3")
        self.assertEqual(kernel["plan"]["execution"], document["context"]["execution"])
        self.assertEqual(result["schema_version"], "investor-funded-history-result-v2")
        self.assertEqual(result["comparison"]["schema_version"], "investor-long-horizon-result-v3")
        for value, schema in ((document, "investor-funded-history-input"), (result, "investor-funded-history-result"),
                              (kernel, "investor-long-horizon-input-v2"), (result["comparison"], "investor-long-horizon-result-v2")):
            with self.assertRaisesRegex(WorkbenchError, "CONTRACT_INVALID"):
                validate_contract(value, schema + ".schema.json")
        for key in ("buy_price_buffer_bps", "buy_fx_buffer_bps"):
            missing = deepcopy(document); del missing["context"]["execution"][key]
            with self.assertRaisesRegex(WorkbenchError, "CONTRACT_INVALID"):
                prepare_funded_history(missing, allow_synthetic=True)
            for value in ("-1", "10000.01"):
                invalid = deepcopy(kernel); invalid["plan"]["execution"][key] = value
                with self.assertRaisesRegex(WorkbenchError, "BOUND_INVALID"):
                    validate_input(invalid, allow_synthetic=True)
        for key in ("economics_independently_replayed", "source_independently_verified", "parameters_independently_preregistered",
                    "actual_arrivals_confirmed", "execution_authorized", "live_advice_eligible"):
            self.assertIs(result[key], False)

    def test_arrival_release_unit_nav_and_principal_are_continuous_for_ten_years(self):
        for name, run in traces(cases()["ten_years"]):
            self.assertEqual(run["engine_version"], "continuous-bounded-fixed-policy-funding-v1")
            self.assertEqual(run["initial_equity_cny"], "1200")
            self.assertEqual(run["contributions_cny"], "3000")
            self.assertEqual(run["ending_nav_cny"], "4200")
            self.assertEqual(run["profit_cny"], "0")
            self.assertEqual(run["twr"], "0")
            self.assertEqual(run["curve"][-1]["unit_nav"], "1")
            self.assertEqual(run["curve"][-1]["locked_cash_cny"], "200" if name == "staged" else "0")
            for row in run["curve"]:
                self.assertGreaterEqual(decimal(row["cash_cny"]), decimal(row["locked_cash_cny"]))
                self.assertGreaterEqual(decimal(row["unreserved_released_cash_cny"]), 0)

    def test_same_day_lots_keep_cents_and_reserve_only_released_capital(self):
        document = cases()["same_day_cents"]
        for name, run in traces(document):
            self.assertEqual(run["initial_equity_cny"], "200.02")
            self.assertEqual(run["contributions_cny"], "0")
            self.assertEqual(run["curve"][0]["released_capital_cny"], "66.66" if name == "staged" else "200.02")
            for order in (row for row in run["events"] if row["type"] == "research_order" and row["side"] == "buy"):
                self.assertLessEqual(decimal(order["worst_total_cash_cny"]), decimal(order["budget_cny"]))

    def test_price_and_foreign_fx_breaches_skip_frozen_orders_without_resizing(self):
        rows = cases()
        for key in ("price_breach", "foreign_fx_breach_costs"):
            for _, run in traces(rows[key]):
                gaps = [row for row in run["events"] if row["type"] == "execution_skipped"]
                self.assertTrue(any(row["reason"] == "EXECUTION_PRICE_OR_FX_BOUND_EXCEEDED" for row in gaps), key)
                self.assertGreater(run["execution_failure_count"], 0)
                for row in run["curve"]:
                    self.assertGreaterEqual(decimal(row["cash_cny"]), decimal(row["locked_cash_cny"]))

    def test_legacy_continuous_economic_trace_hashes_are_byte_identical_to_parent(self):
        expected = {"immediate": "fd2873ad05d7664ae3847bcfa45d6f95d4d1f019ac5178f3cd1856630c9f4cff",
                    "staged": "cd7b0f1e2bcd83120f564617a65d6b635f017e1b7096fabee58c33c2e93b1d17"}
        for name, run in traces(funded_input()):
            self.assertEqual(content_hash(run), expected[name])

    def test_cli_accepts_versioned_request_but_not_duplicate_keys_or_authorization(self):
        document = bounded_input()
        command = [sys.executable, "-m", "worker.investor.funded_history", "--allow-synthetic"]
        child = subprocess.run(command, cwd=ROOT, input=canonical_json(document), capture_output=True, text=True, timeout=30)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(json.loads(child.stdout)["schema_version"], "investor-funded-history-result-v2")
        for raw, code in ((canonical_json(document)[:-1] + ',"execution_authorized":true}', "CONTRACT_INVALID"),
                          (canonical_json(document)[:-1] + ',"schema_version":"investor-funded-history-input-v2"}', "INVESTOR_KERNEL_DUPLICATE_JSON_KEY")):
            child = subprocess.run(command, cwd=ROOT, input=raw, capture_output=True, text=True, timeout=30)
            self.assertEqual(child.returncode, 1)
            self.assertEqual(json.loads(child.stderr), {"error": code})


if __name__ == "__main__":
    unittest.main()
