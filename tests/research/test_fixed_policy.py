from copy import deepcopy
from decimal import Decimal
import unittest
from zoneinfo import ZoneInfo

from tests.research.rotation_fixtures import dataset, fixed, plan
from tests.research.fixed_policy_fixtures import policy_parameters, two_year_case
from tests.research.test_rotation import flat, rows
from worker.orchestration.db import WorkbenchError, content_hash, instant
from worker.research.fixed_policy import class_drift, cooldown_elapsed, period
from worker.research.rotation import run_rotation_portfolio
from worker.research.backtest import compare_backtest
from worker.research.snapshot import validate_parameters


class FixedPolicyTests(unittest.TestCase):
    def setUp(self):
        self.data, self.plan, self.parameters = dataset(), plan(), policy_parameters()
        flat(self.data)

    def run_case(self):
        return run_rotation_portfolio(self.data, self.plan, self.parameters, "train")

    def test_calendar_period_uses_evaluation_timezone_not_utc(self):
        at = instant("2025-07-01T02:00:00Z")
        self.assertEqual(period(at, ZoneInfo("America/New_York"), "first_decision_each_half_year"), "2025-H1")
        self.assertEqual(period(at, ZoneInfo("Asia/Shanghai"), "first_decision_each_half_year"), "2025-H2")
        self.assertEqual(period(instant("2026-01-01T02:00:00Z"), ZoneInfo("America/New_York"), "first_decision_each_year"), "2025")
        with self.assertRaisesRegex(WorkbenchError, "SCHEDULE"): period(at, ZoneInfo("UTC"), "monthly")

    def test_cooldown_counts_local_dates_across_dst_not_elapsed_hours(self):
        before, after = instant("2025-03-08T17:00:00Z"), instant("2025-03-09T16:00:00Z")
        self.assertTrue(cooldown_elapsed(after, before, ZoneInfo("America/New_York"), 1))
        self.assertFalse(cooldown_elapsed(after, before, ZoneInfo("America/New_York"), 2))
        with self.assertRaisesRegex(WorkbenchError, "COOLDOWN"): cooldown_elapsed(after, None, ZoneInfo("UTC"), True)

    def test_drift_is_absolute_role_aggregate_including_cash_in_nav(self):
        weights = {"a": "0.3", "b": "0.3", "c": "0.4"}
        roles = {"a": "growth", "b": "growth", "c": "defensive"}
        values = {"a": Decimal(45), "b": Decimal(15), "c": Decimal(40)}
        result = class_drift(weights, roles, values, Decimal(100), Decimal("0.05"))
        self.assertFalse(any(row["threshold_breached"] for row in result))
        cash = class_drift(weights, roles, values, Decimal(120), Decimal("0.05"))
        growth = next(row for row in cash if row["role"] == "growth")
        self.assertEqual(growth["difference_weight"], "-0.1"); self.assertTrue(growth["threshold_breached"])

    def test_threshold_is_inclusive_five_percentage_points_not_relative_five_percent(self):
        weights, roles = {"a": "0.5"}, {"a": "growth"}
        for value, expected in (("52.5", False), ("55", True), ("45", True)):
            with self.subTest(value=value):
                self.assertEqual(class_drift(weights, roles, {"a": Decimal(value)}, Decimal(100), Decimal("0.05"))[0]["threshold_breached"], expected)

    def test_invalid_threshold_role_and_scope_fail_closed(self):
        for change in ({"roles": {}}, {"class_drift_threshold": "0"}, {"class_drift_threshold": "1.01"},
                       {"rebalance": "first_decision_each_month"}, {"minimum_days_between_rebalances": 0}, {"extra": True}):
            with self.subTest(change=change), self.assertRaises(WorkbenchError):
                validate_parameters({**self.parameters, **change}, self.data)
        with self.assertRaises(WorkbenchError):
            class_drift({"a": "1"}, {"a": "unknown"}, {}, Decimal(100), Decimal("0.05"))

    def test_separate_version_keeps_legacy_monthly_contract_closed(self):
        validate_parameters(fixed(), self.data)
        with self.assertRaises(WorkbenchError): validate_parameters({**fixed(), "roles": self.parameters["roles"]}, self.data)

    def test_flat_two_year_history_has_two_annual_or_four_half_year_reviews_not_24(self):
        data, research_plan = two_year_case()
        for schedule, count in (("first_decision_each_year", 2), ("first_decision_each_half_year", 4)):
            result = run_rotation_portfolio(data, research_plan, policy_parameters(schedule=schedule), "train")
            evaluations = [row for row in rows(result, "evaluation") if row["outcome"] != "blocked"]
            self.assertEqual(len(evaluations), count)
            self.assertEqual(result["twr"], "0"); self.assertEqual(result["profit_cny"], "0")
            self.assertEqual(result["engine_version"], "fixed-policy-rebalance-v2")
            self.assertNotIn("monthly_evaluation_counts", result)
        legacy = run_rotation_portfolio(data, research_plan, fixed(), "train")
        self.assertEqual(len(rows(legacy, "evaluation")), 24)
        self.assertNotIn("policy_rules", legacy)

    def test_intra_period_cash_repairs_on_next_frozen_decision_without_sales_or_fake_profit(self):
        self.plan["contributions"] = [{"at": "2025-01-12T00:00:00Z", "amount_cny": "300"}]
        result = self.run_case()
        repair = next(row for row in rows(result, "evaluation") if "NEW_CASH_REPAIR" in row.get("trigger_codes", []))
        self.assertEqual(repair["nav_cny"], "1500")
        self.assertEqual(repair["allocation_method"], "new_cash_repair_without_sales")
        self.assertFalse(rows(result, "simulated_sell"))
        self.assertEqual(result["positions"], {"CN:ALPHA": "75", "CN:BETA": "75"})
        self.assertEqual(result["twr"], "0"); self.assertEqual(result["profit_cny"], "0")
        self.assertEqual(result["contributions_cny"], "300")

    def test_cash_repair_does_not_sell_overweight_even_when_drift_requires_full_rebalance(self):
        self.plan["contributions"] = [{"at": "2025-01-12T00:00:00Z", "amount_cny": "100"}]
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-12": row["value"] = "15"
        result = self.run_case()
        repair = next(row for row in rows(result, "evaluation") if "NEW_CASH_REPAIR" in row.get("trigger_codes", []))
        orders = [row for row in rows(result, "research_order") if row["at"] == repair["at"]]
        self.assertEqual([row["side"] for row in orders], ["buy"])
        self.assertEqual(orders[0]["listing_id"], "CN:BETA")
        cooldown = [row for row in rows(result, "policy_monitor") if row["reason_codes"] == ["REBALANCE_COOLDOWN"]]
        self.assertTrue(cooldown)
        self.assertFalse(rows(result, "simulated_sell"))

    def test_class_drift_outside_calendar_review_waits_cooldown_then_uses_settled_sales(self):
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-12": row["value"] = "15"
        result = self.run_case()
        rebalanced = next(row for row in rows(result, "evaluation") if row["outcome"] == "proposed" and "INITIAL_DEPLOYMENT" not in row.get("trigger_codes", []))
        self.assertEqual(rebalanced["at"][:10], "2025-02-04")
        self.assertIn("CLASS_WEIGHT_BREACH", rebalanced["trigger_codes"])
        self.assertNotIn("CALENDAR_REVIEW", rebalanced["trigger_codes"])
        sell = rows(result, "simulated_sell")[0]
        dependent = next(row for row in rows(result, "research_order") if row["dependency_order_ids"])
        buys = [row for row in rows(result, "simulated_buy") if row["order_id"] == dependent["order_id"]]
        # This short phase may expire before the settlement-dependent buy.
        self.assertTrue(all(instant(row["at"]) > instant(sell["settled_at"]) for row in buys))

    def test_order_budget_remains_fixed_and_never_earns_decision_day_jump(self):
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-06": row["value"] = "20"
        result = self.run_case()
        skipped = rows(result, "execution_skipped")
        self.assertTrue(any(row["reason"] == "EXECUTION_EXCEEDS_PRECOMMITTED_CASH_BUDGET" for row in skipped))
        initial = rows(result, "research_order")[0]
        self.assertEqual(initial["quantity"], "60")
        self.assertGreaterEqual(result["execution_failure_count"], 1)

    def test_missing_initial_execution_cannot_qualify_all_cash_as_a_successful_policy(self):
        for row in self.data["sessions"]: row["trade_allowed"] = False
        result = self.run_case()
        self.assertEqual(result["twr"], "0")
        self.assertEqual(result["execution_failure_count"], 1)
        self.assertEqual(rows(result, "policy_deployment_failed")[0]["reason"], "INITIAL_DEPLOYMENT_NOT_EXECUTED")

    def test_initial_calendar_slot_is_not_consumed_by_unpublished_close(self):
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"].startswith("2025-01-05"):
                row["published_at"] = "2025-01-06T07:01:00Z"
        result = self.run_case()
        first, second = rows(result, "evaluation")[:2]
        self.assertEqual(first["outcome"], "blocked")
        self.assertEqual(second["at"][:10], "2025-01-06")
        self.assertIn("CALENDAR_REVIEW", second["trigger_codes"])
        self.assertGreater(instant(rows(result, "simulated_buy")[0]["at"]), instant(second["at"]))

    def test_missing_target_cannot_be_hidden_by_successful_buy_of_another_target(self):
        self.data["assets"][0]["quantity_step"] = "100000"
        result = self.run_case()
        self.assertEqual({row["listing_id"] for row in rows(result, "simulated_buy")}, {"CN:BETA"})
        failure = rows(result, "policy_deployment_failed")[0]
        self.assertEqual(failure["reason"], "INITIAL_DEPLOYMENT_INCOMPLETE")
        self.assertEqual(failure["missing_listings"], ["CN:ALPHA"])
        self.assertEqual(result["execution_failure_count"], 1)

    def test_frozen_parameter_content_hash_includes_timing_and_no_sale_rules(self):
        self.plan.update(parameter_candidates=[self.parameters], benchmark=deepcopy(self.parameters))
        first = compare_backtest(self.data, self.plan, self.parameters, "train")
        second = compare_backtest(deepcopy(self.data), deepcopy(self.plan), deepcopy(self.parameters), "train")
        self.assertEqual(first["result_hash"], second["result_hash"])
        changed = {**self.parameters, "minimum_days_between_rebalances": 31}
        self.assertNotEqual(content_hash(changed), content_hash(self.parameters))
        self.assertEqual(first["strategy"], first["benchmark"])
        self.assertFalse(first["live_advice_eligible"])
