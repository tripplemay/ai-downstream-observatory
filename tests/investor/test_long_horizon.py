from copy import deepcopy
from datetime import timedelta
import json
import subprocess
import sys
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.investor.long_horizon_fixtures import foreign_input, long_input
from worker.accounting import decimal
from worker.investor.__main__ import MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, parse_request
from worker.investor.long_horizon import INPUT_CONTRACT, OUTPUT_CONTRACT, compare_funding_paths, funding_schedule, validate_input
from worker.market.contracts import validate_contract
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash, instant, stamp
from worker.research.rotation import run_continuous_portfolio


class LongHorizonTests(unittest.TestCase):
    def calculate(self, document):
        return compare_funding_paths(document, allow_synthetic=True)

    def trace(self, document, staged=True):
        zone = validate_input(document, allow_synthetic=True)
        _, releases = funding_schedule(document["plan"], zone, staged=staged)
        return run_continuous_portfolio(document["dataset"], document["plan"], releases)

    def test_holding_counterfactual_keeps_arrivals_and_new_cash_repair_but_never_sells_for_drift(self):
        document = long_input(days=120)
        document["plan"]["parameters"]["minimum_days_between_rebalances"] = 1
        document["plan"]["contributions"] = [{"at": "2025-01-31T16:00:00Z", "amount_cny": "300"}]
        for row in document["dataset"]["observations"]:
            if row["listing_id"] == "CN:ALPHA" and instant(row["observed_at"]) >= instant("2025-01-25T00:00:00Z"):
                row["value"] = "20"
        before = deepcopy(document)
        candidate = self.trace(document, staged=False)
        zone = validate_input(document, allow_synthetic=True)
        _, releases = funding_schedule(document["plan"], zone, staged=False)
        baseline = run_continuous_portfolio(document["dataset"], document["plan"], releases, holding_baseline=True)
        self.assertTrue(any(row["type"] == "simulated_sell" for row in candidate["events"]))
        self.assertFalse(any(row["type"] in ("simulated_sell", "sale_cash_settlement") for row in baseline["events"]))
        self.assertTrue(any("NEW_CASH_REPAIR" in row.get("trigger_codes", []) for row in baseline["events"]))
        self.assertTrue(any(row["type"] == "simulated_buy" and instant(row["at"]) > instant("2025-01-31T16:00:00Z") for row in baseline["events"]))
        self.assertEqual(baseline["contributions_cny"], candidate["contributions_cny"])
        self.assertEqual(baseline["engine_version"], "continuous-hold-new-cash-v1")
        self.assertEqual(baseline["policy_rules"]["rebalance"], "disabled_hold_new_cash")
        self.assertTrue(all(decimal(row["cash_cny"]) >= decimal(row["locked_cash_cny"]) for row in baseline["curve"]))
        self.assertEqual(document, before)

    def test_holding_counterfactual_is_explicit_boolean_and_default_output_is_unchanged(self):
        document = long_input(days=40)
        zone = validate_input(document, allow_synthetic=True)
        _, releases = funding_schedule(document["plan"], zone, staged=True)
        default = self.trace(document)
        explicit = run_continuous_portfolio(document["dataset"], document["plan"], releases, holding_baseline=False)
        self.assertEqual(default, explicit)
        for invalid in ("true", 1, None):
            with self.assertRaisesRegex(WorkbenchError, "UNSUPPORTED_HOLDING_BASELINE"):
                run_continuous_portfolio(document["dataset"], document["plan"], releases, holding_baseline=invalid)

    def test_ten_years_constant_price_one_continuous_account_no_investment_profit(self):
        document = long_input(days=3653, start="2015-01-01T00:00:00Z")
        document["plan"]["contributions"] = [{"at": "%d-12-31T16:00:00Z" % year, "amount_cny": "300"} for year in range(2015, 2024)]
        result = self.calculate(document)
        validate_contract(result, OUTPUT_CONTRACT)
        self.assertEqual(result["status"], "computed")
        for run in result["runs"].values():
            self.assertEqual(run["principal_cny"], "3900")
            self.assertEqual(run["ending_nav_cny"], "3900")
            self.assertEqual(run["profit_cny"], "0")
            self.assertEqual(run["twr"], "0")
            self.assertEqual(run["max_drawdown"], "0")
            self.assertEqual(run["xirr"]["status"], "ok")
            self.assertLess(abs(decimal(run["xirr"]["rate"])), decimal("0.000000000001"))
            self.assertEqual(run["event_counts"]["external_contribution"], 9)
            self.assertEqual(len(run["annual"]), 10)
            self.assertEqual(len(run["monthly"]), 120)
            self.assertEqual(run["ending_locked_cash_cny"], "0")
            self.assertEqual(run["execution_failure_count"], 0)
            self.assertIn("continuous_single_account_no_phase_or_year_restart", run["assumptions"])
            self.assertNotIn("independent_phase_restart_not_continuous_forward_history", run["assumptions"])
            self.assertEqual(run["annual"][-1]["principal_cny"], "3900")
        self.assertEqual(result["runs"]["staged"]["event_counts"]["funding_release"], 28)
        self.assertLess(len(canonical_json(result).encode()), MAX_OUTPUT_BYTES)

    def test_waiting_cash_is_in_nav_at_arrival_but_cannot_buy_before_release(self):
        document = long_input()
        document["plan"]["contributions"] = [{"at": "2025-01-31T16:00:00Z", "amount_cny": "300"}]
        trace = self.trace(document)
        arrival = next(row for row in trace["curve"] if instant(row["at"]) == instant("2025-01-31T16:00:00Z"))
        self.assertEqual(arrival["nav_cny"], "1500")
        self.assertEqual(arrival["principal_cny"], "1500")
        self.assertEqual(arrival["locked_cash_cny"], "200")
        self.assertEqual(arrival["unit_nav"], "1")
        first_buy = next(row for row in trace["events"] if row["type"] == "simulated_buy" and instant(row["at"]) > instant(arrival["at"]))
        self.assertLessEqual(decimal(first_buy["total_cash_cny"]), decimal("50"))
        for row in trace["curve"]:
            self.assertGreaterEqual(decimal(row["cash_cny"]), decimal(row["locked_cash_cny"]))
            self.assertGreaterEqual(decimal(row["unreserved_released_cash_cny"]), 0)
        self.assertEqual(trace["twr"], "0")
        self.assertEqual(trace["profit_cny"], "0")
        self.assertEqual(sum(decimal(row["amount_cny"]) for row in trace["events"] if row["type"] == "external_contribution"), 300)

    def test_partial_final_lot_is_not_silently_removed_or_forced_into_market(self):
        document = long_input(days=40)
        document["plan"]["contributions"] = [{"at": "2025-02-01T00:00:00Z", "amount_cny": "300"}]
        result = self.calculate(document)
        staged = result["runs"]["staged"]
        self.assertEqual(staged["principal_cny"], "1500")
        self.assertEqual(staged["ending_nav_cny"], "1500")
        self.assertEqual(staged["ending_locked_cash_cny"], "200")
        self.assertEqual([row["within_window"] for row in staged["funding_schedule"][-1]["tranches"]], [True, False, False])
        self.assertEqual(result["runs"]["immediate"]["ending_locked_cash_cny"], "0")

    def test_waiting_sale_buy_cannot_reserve_new_locked_arrivals_after_sale_price_gap(self):
        document = long_input()
        plan = document["plan"]
        plan["parameters"]["minimum_days_between_rebalances"] = 1
        plan["contributions"] = [{"at": "2025-01-27T08:00:00Z", "amount_cny": "1200"}]
        plan["funding_policy"]["contribution_offsets_days"] = list(range(0, 60, 5))
        for row in document["dataset"]["observations"]:
            if (row["listing_id"] == "CN:ALPHA" and instant("2025-01-25T00:00:00Z") <= instant(row["observed_at"])
                    < instant("2025-01-26T00:00:00Z")):
                row["value"] = "20"
        trace = self.trace(document)
        skipped = next(row for row in trace["events"] if row.get("reason") == "SETTLED_CASH_BELOW_PRECOMMITTED_BUDGET")
        self.assertEqual(skipped["budget_cny"], "300")
        self.assertEqual(skipped["available_cny"], "250")
        self.assertFalse(any(row["type"] == "order_cash_reserved" and row["order_id"] == skipped["order_id"] for row in trace["events"]))
        for row in trace["curve"]:
            self.assertGreaterEqual(decimal(row["cash_cny"]), decimal(row["locked_cash_cny"]))
            self.assertGreaterEqual(decimal(row["unreserved_released_cash_cny"]), 0)

    def test_tranche_quantum_residual_conserved_and_local_days_not_utc_days(self):
        document = long_input(days=120, start="2025-02-01T00:00:00Z")
        plan = document["plan"]
        plan["evaluation_timezone"] = "America/New_York"
        plan["contributions"] = [{"at": "2025-03-08T17:00:00Z", "amount_cny": "100.01"}]
        zone = validate_input(document, allow_synthetic=True)
        schedule, releases = funding_schedule(plan, zone, staged=True)
        rows = schedule[-1]["tranches"]
        self.assertEqual([row["amount_cny"] for row in rows], ["33.33", "33.33", "33.35"])
        self.assertEqual(rows[1]["at"], "2025-04-07T16:00:00.000000Z")
        self.assertEqual(sum(decimal(row["amount_cny"]) for row in rows), decimal("100.01"))
        self.assertEqual(sum(releases.values()), decimal("1300.01"))

    def test_ambiguous_and_nonexistent_local_release_times_reject_not_guess(self):
        for arrival in ("2025-03-08T07:30:00Z", "2025-11-01T05:30:00Z"):
            document = long_input()
            document["plan"].update(evaluation_timezone="America/New_York",
                window={"start": arrival, "end": stamp(instant(arrival) + timedelta(days=3))})
            document["plan"]["funding_policy"]["initial_offsets_days"] = [0, 1]
            with self.assertRaisesRegex(WorkbenchError, "RELEASE_LOCAL_TIME_INVALID"):
                funding_schedule(document["plan"], ZoneInfo("America/New_York"), staged=True)

    def test_same_arrivals_weights_costs_window_only_frozen_release_timing_differs(self):
        document = long_input()
        document["plan"]["funding_policy"]["initial_offsets_days"] = [0, 30, 60]
        for row in document["dataset"]["observations"]:
            row["value"] = "10" if instant(row["observed_at"]) < instant("2025-02-01T00:00:00Z") else "20"
        result = self.calculate(document)
        fast, staged = result["runs"]["immediate"], result["runs"]["staged"]
        self.assertGreater(decimal(fast["ending_nav_cny"]), decimal(staged["ending_nav_cny"]))
        self.assertEqual(fast["principal_cny"], staged["principal_cny"])
        self.assertEqual(fast["funding_schedule"][0]["arrival_at"], staged["funding_schedule"][0]["arrival_at"])
        self.assertFalse(result["live_advice_eligible"])
        self.assertFalse(result["parameters_independently_preregistered"])

    def test_new_principal_does_not_hide_unit_drawdown_or_become_profit(self):
        document = long_input()
        document["plan"]["contributions"] = [{"at": "2025-01-31T16:00:00Z", "amount_cny": "1200"}]
        document["plan"]["funding_policy"]["contribution_offsets_days"] = [0]
        for row in document["dataset"]["observations"]:
            if instant(row["observed_at"]) >= instant("2025-01-31T00:00:00Z"):
                row["value"] = "5"
        result = self.calculate(document)
        for run in result["runs"].values():
            self.assertEqual(run["ending_nav_cny"], "1800")
            self.assertEqual(run["principal_cny"], "2400")
            self.assertEqual(run["profit_cny"], "-600")
            self.assertEqual(run["twr"], "-0.5")
            self.assertEqual(run["max_drawdown"], "-0.5")

    def test_costs_reduce_nav_once_and_are_not_removed_from_wealth_display(self):
        document = foreign_input()
        document["plan"]["execution"].update(commission_bps="10", minimum_fee_cny="1", slippage_bps="5", fx_bps="20")
        result = self.calculate(document)
        for run in result["runs"].values():
            self.assertGreater(decimal(run["fees_cny"]), 0)
            self.assertGreater(decimal(run["fx_fees_cny"]), 0)
            self.assertGreater(decimal(run["slippage_cny"]), 0)
            self.assertEqual(decimal(run["ending_nav_cny"]) - decimal(run["principal_cny"]), decimal(run["profit_cny"]))
            self.assertLess(decimal(run["profit_cny"]), 0)

    def test_fx_loss_is_cny_portfolio_loss_not_hidden_by_a_later_contribution(self):
        document = foreign_input()
        document["plan"]["contributions"] = [{"at": "2025-01-31T16:00:00Z", "amount_cny": "300"}]
        for row in document["dataset"]["observations"]:
            if row["metric"] == "fx_cny_per_unit" and instant(row["observed_at"]) >= instant("2025-01-31T00:00:00Z"):
                row["value"] = "1"
        result = self.calculate(document)
        for run in result["runs"].values():
            self.assertEqual(run["ending_nav_cny"], "1200")
            self.assertEqual(run["principal_cny"], "1500")
            self.assertEqual(run["profit_cny"], "-300")
            self.assertEqual(run["twr"], "-0.25")
            self.assertEqual(run["max_drawdown"], "-0.25")

    def test_stale_fx_after_an_actual_simulated_holding_fails_without_returning_old_nav(self):
        document = foreign_input()
        document["dataset"]["observations"] = [row for row in document["dataset"]["observations"]
            if row["metric"] != "fx_cny_per_unit" or instant(row["observed_at"]) < instant("2025-01-05T00:00:00Z")]
        document["plan"]["execution"]["max_fx_age_seconds"] = 86400
        with self.assertRaisesRegex(WorkbenchError, "STALE_RESEARCH_FX"):
            self.calculate(document)

    def test_output_cap_and_wealth_identity_fail_closed_not_truncated(self):
        document = long_input(days=5)
        with patch("worker.investor.long_horizon.MAX_OUTPUT_BYTES", 1), self.assertRaisesRegex(WorkbenchError, "OUTPUT_TOO_LARGE"):
            self.calculate(document)
        from worker.investor.long_horizon import _summarize
        trace = self.trace(document)
        trace["curve"][-1]["principal_cny"] = "0"
        with self.assertRaisesRegex(WorkbenchError, "WEALTH_IDENTITY_INVALID"):
            _summarize(trace, [], ZoneInfo("Asia/Shanghai"))

    def test_expired_fx_missing_calendar_quote_and_unexecuted_targets_cannot_pass(self):
        document = foreign_input()
        document["plan"]["execution"]["max_fx_age_seconds"] = 0
        result = self.calculate(document)
        self.assertEqual(result["status"], "execution_gaps")
        self.assertGreater(result["runs"]["staged"]["execution_failure_count"], 0)
        missing = long_input()
        missing["dataset"]["observations"] = [row for row in missing["dataset"]["observations"] if row["listing_id"] != "CN:ALPHA"]
        rejected = self.calculate(missing)
        self.assertEqual(rejected["status"], "execution_gaps")
        self.assertGreater(rejected["runs"]["immediate"]["event_counts"]["policy_deployment_failed"], 0)

    def test_cross_year_dividend_receivable_split_and_settlement_not_reset(self):
        document = long_input(days=50, start="2025-12-15T00:00:00Z")
        document["dataset"]["actions"] = [
            {"id": "synthetic-dividend", "listing_id": "CN:ALPHA", "type": "dividend", "at": "2025-12-31T06:00:00Z",
             "published_at": "2025-12-01T00:00:00Z", "source_evidence": "Fictional dividend", "gross_per_unit": "1", "tax_per_unit": "0.2", "pay_at": "2026-01-03T00:00:00Z"},
            {"id": "synthetic-split", "listing_id": "CN:ALPHA", "type": "split", "at": "2026-01-01T06:00:00Z",
             "published_at": "2025-12-01T00:00:00Z", "source_evidence": "Fictional split", "ratio": "2"}]
        for row in document["dataset"]["observations"]:
            if row["listing_id"] == "CN:ALPHA":
                at = instant(row["observed_at"])
                row["value"] = "4.5" if at >= instant("2026-01-01T06:00:00Z") else "9" if at >= instant("2025-12-31T06:00:00Z") else "10"
        trace = self.trace(document)
        self.assertEqual(trace["profit_cny"], "-12")
        self.assertEqual(sum(decimal(row["net"]) for row in trace["events"] if row["type"] == "dividend_entitlement"), 48)
        self.assertEqual(sum(decimal(row["amount"]) for row in trace["events"] if row["type"] == "dividend_payment"), 48)
        boundary = next(row for row in trace["curve"] if instant(row["at"]) == instant("2026-01-01T06:00:00Z"))
        self.assertEqual(boundary["principal_cny"], "1200")
        self.assertEqual(boundary["nav_cny"], "1188")
        self.assertTrue(any(row["type"] == "split" for row in trace["events"]))
        self.assertTrue(any(row["type"] == "stock_settlement" for row in trace["events"]))

    def test_frozen_input_hashes_repeat_exactly_and_input_not_mutated(self):
        document = long_input(days=5)
        before = deepcopy(document)
        one, two = self.calculate(document), self.calculate(document)
        self.assertEqual(document, before)
        self.assertEqual(one, two)
        self.assertEqual(one["input_hash"], content_hash(document))
        self.assertEqual(one["result_hash"], content_hash({key: value for key, value in one.items() if key != "result_hash"}))

    def test_semantic_boundaries_do_not_repair_invalid_private_inputs(self):
        mutations = [
            (lambda p: p.update(evaluation_timezone="Invalid/PrivateZone"), "TIMEZONE_INVALID"),
            (lambda p: p.update(parameters_frozen_at="2025-02-01T00:00:00Z"), "PARAMETERS_NOT_FROZEN"),
            (lambda p: p["window"].update(end="2035-01-02T00:00:00Z"), "WINDOW_INVALID"),
            (lambda p: p.update(decision_times=list(reversed(p["decision_times"]))), "DECISIONS_INVALID"),
            (lambda p: p.update(decision_times=["2025-01-01T07:00:30Z"]), "UNOBSERVED_CLOSE_DECISION"),
            (lambda p: p.update(initial_capital_cny="0"), "FUNDING_PRECISION_INVALID"),
            (lambda p: p.update(initial_capital_cny="1200.001"), "FUNDING_PRECISION_INVALID"),
            (lambda p: p["funding_policy"].update(initial_offsets_days=[1, 30]), "OFFSETS_INVALID"),
            (lambda p: p["funding_policy"].update(initial_offsets_days=[30, 0]), "OFFSETS_INVALID"),
            (lambda p: p.update(contributions=[{"at": "2025-01-01T00:00:00Z", "amount_cny": "100"}]), "CONTRIBUTIONS_INVALID"),
            (lambda p: p.update(contributions=[{"at": "2025-04-30T00:00:00Z", "amount_cny": "100"}]), "CONTRIBUTIONS_INVALID"),
            (lambda p: p["execution"].update(slippage_bps="10000"), "COST_INVALID")]
        for mutation, code in mutations:
            document = long_input(days=5)
            mutation(document["plan"])
            with self.subTest(code=code), self.assertRaisesRegex(WorkbenchError, code):
                validate_input(document, allow_synthetic=True)
        document = long_input(days=5)
        document["dataset"]["corporate_actions_complete"] = False
        with self.assertRaisesRegex(WorkbenchError, "ACTIONS_INCOMPLETE"):
            validate_input(document, allow_synthetic=True)

    def test_closed_contract_and_bounded_json_do_not_accept_execution_or_precomputed_result(self):
        for field, value in (("result", {"profit_cny": "999"}), ("execute", True), ("approved", True)):
            document = long_input(days=5)
            document[field] = value
            with self.assertRaisesRegex(WorkbenchError, "CONTRACT_INVALID"):
                self.calculate(document)
        for raw, code in [(b'{"plan":{},"plan":{}}', "DUPLICATE_JSON_KEY"), (b'{"plan":NaN}', "NONFINITE_JSON"),
                          (b" " * (MAX_INPUT_BYTES + 1), "INPUT_TOO_LARGE")]:
            with self.assertRaisesRegex(WorkbenchError, code): parse_request(raw, INPUT_CONTRACT)

    def test_sub_microsecond_instants_are_rejected_not_rounded_into_known_evidence(self):
        for mutate in (
            lambda d: d["plan"].update(parameters_frozen_at="2024-12-31T23:59:59.0000001Z"),
            lambda d: d["plan"].update(decision_times=["2025-01-01T07:01:00.0000001Z"]),
            lambda d: d["plan"].update(contributions=[{"at": "2025-01-02T00:00:00.0000001Z", "amount_cny": "300"}]),
            lambda d: d["dataset"]["observations"][0].update(published_at="2025-01-01T07:01:00.0000001Z"),
            lambda d: d["dataset"].update(actions=[{"id": "synthetic-precise-dividend", "listing_id": "CN:ALPHA", "type": "dividend",
                "at": "2025-01-02T06:00:00Z", "published_at": "2025-01-01T00:00:00Z", "source_evidence": "Fictional precision test",
                "gross_per_unit": "1", "tax_per_unit": "0", "pay_at": "2025-01-03T00:00:00.0000001Z"}]),
        ):
            document = long_input(days=5)
            mutate(document)
            with self.assertRaisesRegex(WorkbenchError, "TIME_PRECISION_UNSUPPORTED"):
                self.calculate(document)

    def test_cli_explicit_fixture_flag_and_errors_never_echo_private_payload(self):
        document = long_input(days=5)
        command = [sys.executable, "-m", "worker.investor.long_horizon"]
        rejected = subprocess.run(command, input=canonical_json(document), text=True, cwd=ROOT, capture_output=True, timeout=30)
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(json.loads(rejected.stderr), {"error": "INVESTOR_LONG_HORIZON_SYNTHETIC_FORBIDDEN"})
        accepted = subprocess.run(command + ["--allow-synthetic"], input=canonical_json(document), text=True, cwd=ROOT, capture_output=True, timeout=30)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        validate_contract(json.loads(accepted.stdout), OUTPUT_CONTRACT)
        marker = "PRIVATE_TEST_MARKER_NOT_A_REAL_SECRET"
        document["plan"]["private_input"] = marker
        error = subprocess.run(command, input=canonical_json(document), text=True, cwd=ROOT, capture_output=True, timeout=30)
        self.assertEqual(error.returncode, 1)
        self.assertEqual(error.stdout, "")
        self.assertNotIn(marker, error.stderr)
        self.assertEqual(json.loads(error.stderr), {"error": "CONTRACT_INVALID"})


if __name__ == "__main__":
    unittest.main()
