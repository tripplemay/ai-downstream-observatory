"""Frozen low-frequency monitoring arithmetic; no DB or source admission."""

from copy import deepcopy
from decimal import Decimal, localcontext
import json
import subprocess
import sys
import unittest
from unittest.mock import patch

from tests.investor.fixtures import MONITOR_NOW, monitor_input
from tests.investor.policy_monitor_fixtures import document, vectors
from worker.investor.monitor import assess_model
from worker.market.contracts import validate_contract
from worker.orchestration.db import ROOT, WorkbenchError, content_hash


class FixedPolicyMonitorTests(unittest.TestCase):
    def setUp(self):
        self.cases = {row["name"]: row["request"] for row in vectors()}

    def result(self, name):
        request = self.cases[name]
        before = deepcopy(request)
        result = assess_model(request["document"], request["now"])
        self.assertEqual(request, before)
        self.assertEqual(result["result_hash"], content_hash({key: value for key, value in result.items() if key != "result_hash"}))
        self.assertFalse(result["actual_holdings_linked"]); self.assertFalse(result["execution_authorized"]); self.assertFalse(result["live_advice_eligible"])
        return result

    def test_initial_valid_calendar_review_does_not_force_a_trade(self):
        result = self.result("initial-balanced")
        self.assertEqual(result["outcome"], "observe"); self.assertEqual(result["allocation_method"], "none")
        self.assertEqual(result["policy_evaluation"]["review_period"], "2025-H2")
        self.assertTrue(result["policy_evaluation"]["calendar_due"])
        self.assertIsNotNone(result["next_policy_state"]["last_review_at"])
        self.assertIsNone(result["next_policy_state"]["last_proposed_at"])

    def test_within_class_swap_cannot_trigger_old_security_band(self):
        result = self.result("within-class-swap")
        self.assertEqual(result["outcome"], "observe")
        self.assertTrue(any(not row["within_band"] for row in result["changes"]))
        self.assertTrue(all(not row["threshold_breached"] for row in result["policy_evaluation"]["class_drift"]))
        self.assertNotIn("MODEL_DRIFT_OUTSIDE_BAND", result["reason_codes"])

    def test_absolute_five_percentage_points_is_inclusive_not_relative(self):
        result = self.result("inclusive-class-threshold")
        self.assertEqual(result["outcome"], "decision_required")
        self.assertIn("CLASS_WEIGHT_BREACH", result["reason_codes"])
        growth = next(row for row in result["policy_evaluation"]["class_drift"] if row["role"] == "growth")
        self.assertEqual(growth["difference_weight"], "0.05")
        self.assertEqual(self.result("below-class-threshold")["outcome"], "observe")

    def test_cooldown_reports_the_breach_without_publishing_new_orders(self):
        result = self.result("cooldown-breach")
        self.assertEqual(result["outcome"], "observe")
        self.assertEqual(result["reason_codes"], ["POLICY_COOLDOWN_NO_NEW_ADVICE", "CLASS_WEIGHT_BREACH"])
        self.assertTrue(result["policy_evaluation"]["cooldown_active"])
        self.assertTrue(all(row["proposed_change_cny"] == "0" for row in result["changes"]))
        self.assertEqual(result["next_policy_state"]["last_proposed_at"], self.cases["cooldown-breach"]["document"]["fixed_policy"]["state"]["last_proposed_at"])

    def test_funding_bypasses_cooldown_but_is_not_in_observed_nav(self):
        result = self.result("new-funding-bypasses-cooldown")
        self.assertEqual(result["outcome"], "decision_required"); self.assertEqual(result["model_nav_cny"], "10000")
        self.assertEqual(result["allocation_method"], "contribution_repair_without_sales")
        self.assertTrue(result["policy_evaluation"]["new_funding"])
        self.assertTrue(all(Decimal(row["proposed_change_cny"]) >= 0 for row in result["changes"]))
        with localcontext() as context:
            context.prec = 60
            self.assertEqual(sum((Decimal(row["proposed_change_cny"]) for row in result["changes"]), Decimal(0))
                + Decimal(result["estimated_cost_cny"]) + Decimal(result["hypothetical_cash_remaining_cny"]), Decimal("2000"))

    def test_open_funding_stays_a_decision_without_sliding_the_anchor(self):
        result = self.result("open-funding-keeps-anchor")
        self.assertEqual(result["outcome"], "decision_required")
        self.assertFalse(result["policy_evaluation"]["new_funding"])
        self.assertIn("PLANNED_FUNDING_REVIEW_OPEN", result["reason_codes"])
        self.assertEqual(result["next_policy_state"]["last_proposed_at"], self.cases["open-funding-keeps-anchor"]["document"]["fixed_policy"]["state"]["last_proposed_at"])
        self.assertEqual(result["next_policy_state"]["last_review_at"], self.cases["open-funding-keeps-anchor"]["document"]["fixed_policy"]["state"]["last_review_at"])
        equivalent = self.result("equivalent-funding-spelling-keeps-anchor")
        self.assertFalse(equivalent["policy_evaluation"]["new_funding"])
        self.assertEqual(equivalent["next_policy_state"], result["next_policy_state"])
        changed = self.result("changed-funding-renews-anchor")
        self.assertTrue(changed["policy_evaluation"]["new_funding"])
        self.assertNotEqual(changed["next_policy_state"]["last_proposed_at"], result["next_policy_state"]["last_proposed_at"])

    def test_paid_model_cny_cash_is_in_nav_once_and_only_repairs_without_sales(self):
        result = self.result("new-model-cash-no-double-funding")
        self.assertEqual(result["model_nav_cny"], "11000"); self.assertEqual(result["funding_status"], "none")
        self.assertEqual(result["outcome"], "decision_required")
        self.assertEqual(result["allocation_method"], "contribution_repair_without_sales")
        self.assertEqual(sum(Decimal(row["hypothetical_target_value_cny"]) for row in result["changes"]), Decimal("11000"))
        self.assertTrue(all(Decimal(row["proposed_change_cny"]) >= 0 for row in result["changes"]))
        growth = next(row for row in result["policy_evaluation"]["class_drift"] if row["role"] == "growth")
        self.assertLess(Decimal(growth["current_weight"]), Decimal("0.7"))

    def test_pending_model_cash_repeats_without_sliding_anchor_or_foreign_conversion(self):
        result = self.result("open-model-cash-keeps-anchor")
        self.assertEqual(result["outcome"], "decision_required"); self.assertFalse(result["policy_evaluation"]["new_cny_cash"])
        self.assertEqual(result["next_policy_state"]["last_proposed_at"], self.cases["open-model-cash-keeps-anchor"]["document"]["fixed_policy"]["state"]["last_proposed_at"])
        foreign = self.result("foreign-cash-is-not-cny-repair")
        self.assertFalse(foreign["policy_evaluation"]["cash_repair_pending"])
        self.assertEqual(foreign["allocation_method"], "band_rebalance_research_not_executable")
        self.assertIsNone(foreign["hypothetical_cash_remaining_cny"])

    def test_small_funding_and_future_funding_do_not_force_transactions(self):
        small = self.result("small-funding-within-tolerance")
        self.assertEqual(small["outcome"], "observe"); self.assertIsNone(small["next_policy_state"]["last_proposed_at"])
        future = self.result("future-funding")
        self.assertEqual(future["funding_status"], "not_due"); self.assertEqual(future["outcome"], "observe")
        self.assertEqual(future["next_review_at"], "2025-07-08T23:15:00.000000Z")

    def test_invalid_data_and_cost_failures_cannot_consume_policy_state(self):
        for name in ("missing-costs", "cost-cap", "stale-market", "expired-exact-boundary"):
            with self.subTest(name=name):
                result = self.result(name)
                self.assertEqual(result["outcome"], "insufficient_evidence")
                self.assertEqual(result["next_policy_state"], self.cases[name]["document"]["fixed_policy"]["state"])
                if name in ("stale-market", "expired-exact-boundary"):
                    self.assertIsNone(result["policy_evaluation"]); self.assertIsNone(result["model_nav_cny"])

    def test_half_year_year_and_dst_use_local_dates(self):
        half = self.result("local-half-year-boundary"), self.result("new-period-cooldown-not-consumed")
        self.assertEqual(half[0]["policy_evaluation"]["review_period"], "2025-H2")
        self.assertTrue(half[0]["policy_evaluation"]["calendar_due"])
        self.assertEqual(half[1]["next_policy_state"]["last_review_at"], self.cases["new-period-cooldown-not-consumed"]["document"]["fixed_policy"]["state"]["last_review_at"])
        self.assertEqual(self.result("local-year-boundary")["policy_evaluation"]["review_period"], "2026")
        dst = self.result("dst-local-days-not-48-hours")
        self.assertFalse(dst["policy_evaluation"]["cooldown_active"]); self.assertEqual(dst["outcome"], "decision_required")

    def test_forged_scope_state_timezone_and_precision_are_rejected(self):
        changes = [lambda d: d["fixed_policy"]["parameters"]["roles"].pop("HK:BETA"),
            lambda d: d["fixed_policy"]["parameters"].update(class_drift_threshold="0"),
            lambda d: d["fixed_policy"]["parameters"]["tolerance"].update(weight="-0.01"),
            lambda d: d["fixed_policy"]["parameters"].update(class_drift_threshold="0.0500000000000000001"),
            lambda d: d["after_weights"].update({"CN:ALPHA": "0.5"}), lambda d: d.update(after_plan_hash="e" * 64),
            lambda d: d["fixed_policy"].update(evaluation_timezone="Private/NotAZone"),
            lambda d: d["fixed_policy"]["state"].update(last_review_at="2025-07-09T00:00:00Z"),
            lambda d: d["fixed_policy"]["state"].update(last_proposed_at=MONITOR_NOW),
            lambda d: d["fixed_policy"]["state"].update(last_funding_hash="a" * 64),
            lambda d: d["fixed_policy"]["state"].update(cash_cny_seen="-1"),
            lambda d: d["policy"].update(weight_band="0"), lambda d: d["fixed_policy"].update(auto_trade=True)]
        for change in changes:
            with self.subTest(change=change):
                value = document(); change(value)
                with self.assertRaises((WorkbenchError, ValueError)): assess_model(value, MONITOR_NOW)

    def test_version_and_closed_result_never_implicitly_enable_a_source_or_broker(self):
        value = document()
        with patch("worker.orchestration.db.open_database") as database, patch("worker.market.providers.credentials.read_private_credentials_file") as credentials:
            result = assess_model(value, MONITOR_NOW)
        database.assert_not_called(); credentials.assert_not_called()
        self.assertEqual(result["schema_version"], "investor-model-assessment-v2")
        validate_contract(result, "investor-model-assessment-v2.schema.json")
        with self.assertRaises(WorkbenchError): validate_contract({**result, "execution_authorized": True}, "investor-model-assessment-v2.schema.json")
        self.assertEqual(assess_model(monitor_input(), MONITOR_NOW)["schema_version"], "investor-model-assessment-v1")

    def test_cli_diagnostic_does_not_echo_private_policy_input(self):
        value = document(); value["fixed_policy"]["evaluation_timezone"] = "Private/NotAZone"
        child = subprocess.run([sys.executable, "-m", "worker.investor"], cwd=ROOT, text=True, capture_output=True,
            input=json.dumps({"action": "monitor", "document": value, "now": MONITOR_NOW}), timeout=30)
        self.assertEqual(child.returncode, 1); self.assertEqual(child.stdout, "")
        self.assertEqual(json.loads(child.stderr), {"error": "INVESTOR_FIXED_POLICY_TIMEZONE_INVALID"})
        self.assertNotIn("Private/NotAZone", child.stderr)


if __name__ == "__main__": unittest.main()
