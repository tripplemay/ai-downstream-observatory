from copy import deepcopy
from decimal import Decimal, localcontext
import unittest

from tests.investor.fixtures import MONITOR_NOW, monitor_input
from worker.investor.monitor import assess_model
from worker.orchestration.db import WorkbenchError, content_hash


class InvestorModelMonitorTests(unittest.TestCase):
    def setUp(self):
        self.document = monitor_input()

    def run_case(self, now=MONITOR_NOW):
        return assess_model(self.document, now)

    def fund(self, amount="2000", at=MONITOR_NOW):
        self.document["funding_intent"] = {"id": "synthetic-funding", "amount_cny": amount, "expected_at": at}

    def test_observe_requires_complete_current_inputs_and_has_no_actual_effect(self):
        before = deepcopy(self.document)
        result = self.run_case()
        self.assertEqual(result["outcome"], "observe")
        self.assertEqual(result["model_nav_cny"], "10000")
        self.assertEqual(result["gaps"], [])
        self.assertEqual(result["allocation_method"], "none")
        self.assertFalse(result["actual_holdings_linked"])
        self.assertFalse(result["execution_authorized"])
        self.assertFalse(result["live_advice_eligible"])
        self.assertEqual(self.document, before)
        self.assertEqual(result["result_hash"], content_hash({key: value for key, value in result.items() if key != "result_hash"}))

    def test_each_market_keeps_its_own_close_not_one_shared_date(self):
        result = self.run_case()
        self.assertEqual(result["market_cutoffs"], {"CN": "2025-07-08T07:00:00.000000Z", "HK": "2025-07-08T08:00:00.000000Z", "US": "2025-07-08T20:00:00.000000Z"})
        self.assertEqual(result["data_cutoff"], result["market_cutoffs"]["CN"])
        self.assertEqual(result["next_review_at"], "2025-07-09T06:00:00.000000Z")
        self.document["quotes"][2].update(observed_at="2025-07-07T20:00:00.000Z", expected_close_at="2025-07-07T20:00:00.000Z")
        self.assertEqual(self.run_case()["outcome"], "observe")

    def test_new_funding_is_hypothetical_not_added_to_observed_nav(self):
        self.fund()
        result = self.run_case()
        self.assertEqual(result["outcome"], "decision_required")
        self.assertEqual(result["reason_codes"], ["NEW_PLANNED_FUNDING"])
        self.assertEqual(result["funding_status"], "hypothetical_due")
        self.assertEqual(result["model_nav_cny"], "10000")
        self.assertEqual(result["allocation_method"], "contribution_repair_without_sales")
        with localcontext() as context:
            context.prec = 60
            purchases = sum(Decimal(row["proposed_change_cny"]) for row in result["changes"])
            costs = Decimal(result["estimated_cost_cny"])
            remaining = Decimal(result["hypothetical_cash_remaining_cny"])
            self.assertEqual(purchases + costs + remaining, Decimal("2000"))
            self.assertGreater(costs, 0)
            self.assertGreaterEqual(remaining, 0)
            self.assertTrue(all(Decimal(row["proposed_change_cny"]) > 0 for row in result["changes"]))

    def test_contributions_repair_underweights_without_selling_overweights(self):
        self.document["quantities"].update({"CN:ALPHA": "80", "HK:BETA": "10", "US:GAMMA": "10"})
        self.fund()
        result = self.run_case()
        changes = {row["listing_id"]: row for row in result["changes"]}
        self.assertEqual(changes["CN:ALPHA"]["proposed_change_cny"], "0")
        self.assertLess(Decimal(changes["CN:ALPHA"]["difference_cny"]), 0)
        self.assertGreater(Decimal(changes["HK:BETA"]["proposed_change_cny"]), 0)
        self.assertGreater(Decimal(changes["HK:BETA"]["remaining_target_difference_cny"]), 0)
        self.assertIn("MODEL_DRIFT_OUTSIDE_BAND", result["reason_codes"])
        self.assertTrue(all(Decimal(row["proposed_change_cny"]) >= 0 for row in result["changes"]))

    def test_future_funding_is_not_due_and_schedules_review(self):
        self.fund(at="2025-07-09T00:00:00.000Z")
        before = self.run_case()
        self.assertEqual(before["outcome"], "observe")
        self.assertEqual(before["funding_status"], "not_due")
        self.assertEqual(before["next_review_at"], "2025-07-09T00:00:00.000000Z")
        after = self.run_case("2025-07-09T00:00:00.000Z")
        self.assertEqual(after["outcome"], "decision_required")
        self.assertNotEqual(before["input_version"], after["input_version"])

    def test_each_missing_market_session_blocks_not_silently_observe(self):
        for index, market in enumerate(["CN", "HK", "US"]):
            self.document = monitor_input()
            self.document["quotes"][index]["observed_at"] = "2025-07-07T07:00:00.000Z"
            result = self.run_case()
            self.assertEqual(result["outcome"], "insufficient_evidence")
            self.assertIn("MARKET_DATA_NOT_CURRENT:" + market, result["gaps"])
            self.assertEqual(result["changes"], [])
            self.assertIsNone(result["model_nav_cny"])

    def test_expiry_and_fx_age_are_fail_closed_including_exact_boundary(self):
        result = self.run_case("2025-07-09T06:00:00.000Z")
        self.assertEqual(result["outcome"], "insufficient_evidence")
        self.assertIsNone(result["next_review_at"])
        self.document["fx"][0]["observed_at"] = "2025-07-07T21:00:00.000Z"
        self.assertIn("FX_NOT_CURRENT:HKD", self.run_case()["gaps"])
        self.document = monitor_input()
        self.document["policy"]["max_fx_age_seconds"] = 7200
        self.assertEqual(self.run_case()["outcome"], "observe")
        self.assertEqual(self.run_case("2025-07-08T23:00:00.001Z")["outcome"], "insufficient_evidence")

    def test_quote_or_fx_not_yet_known_cannot_be_used(self):
        for key in ["quotes", "fx"]:
            self.document = monitor_input()
            self.document[key][0]["known_at"] = "2025-07-08T23:00:00.000001Z"
            result = self.run_case()
            self.assertEqual(result["outcome"], "insufficient_evidence")
            self.assertIn("QUOTE_NOT_KNOWN_AT_EVALUATION" if key == "quotes" else "FX_NOT_KNOWN_AT_EVALUATION", result["gaps"])

    def test_sub_microsecond_time_is_rejected_not_truncated_into_known_information(self):
        self.document["quotes"][0]["known_at"] = "2025-07-08T23:00:00.0000001Z"
        with self.assertRaisesRegex(WorkbenchError, "CONTRACT_INVALID"): self.run_case()

    def test_missing_costs_block_changes_but_not_complete_no_change(self):
        self.document["policy"]["costs"] = None
        self.assertEqual(self.run_case()["outcome"], "observe")
        self.fund()
        result = self.run_case()
        self.assertEqual(result["outcome"], "insufficient_evidence")
        self.assertEqual(result["gaps"], ["COST_ASSUMPTIONS_MISSING"])
        self.assertTrue(all(row["proposed_change_cny"] == "0" for row in result["changes"]))

    def test_cost_cap_and_small_contribution_fail_without_fake_free_trades(self):
        self.fund()
        self.document["policy"]["costs"]["maximum_cost_fraction"] = "0"
        self.assertEqual(self.run_case()["gaps"], ["CHANGE_COST_EXCEEDS_POLICY"])
        self.document = monitor_input(); self.fund("0.5")
        result = self.run_case()
        self.assertEqual(result["outcome"], "insufficient_evidence")
        self.assertEqual(result["gaps"], ["FUNDING_CANNOT_BE_ALLOCATED_WITHIN_COST_BUDGET"])
        self.assertEqual(result["estimated_cost_cny"], "0")

    def test_target_change_and_drift_have_signed_research_differences(self):
        self.document["after_weights"].update({"CN:ALPHA": "0.6", "HK:BETA": "0.2", "US:GAMMA": "0.2"})
        result = self.run_case()
        self.assertEqual(result["outcome"], "decision_required")
        self.assertEqual(result["allocation_method"], "band_rebalance_research_not_executable")
        self.assertEqual([row["proposed_change_cny"] for row in result["changes"]], ["2000", "-1000", "-1000"])
        self.assertIn("TARGET_WEIGHTS_CHANGED", result["reason_codes"])
        self.assertIn("lot_size", result["constraints_not_checked"])

    def test_scope_duplicates_units_weight_sums_and_bad_costs_rejected(self):
        cases = [lambda d: d["quotes"].pop(), lambda d: d["quotes"].append(deepcopy(d["quotes"][0])),
                 lambda d: d["fx"].pop(), lambda d: d["fx"][0].update(unit="inverse"),
                 lambda d: d["after_weights"].update({"CN:ALPHA": "0.5"}),
                 lambda d: d["quantities"].update({"CN:ALPHA": "-1"}),
                 lambda d: d["policy"]["costs"].update(commission_bps="10000"),
                 lambda d: d["policy"].update(weight_band="-0.1"),
                 lambda d: d["quotes"][0].update(expected_close_at="2025-07-09T07:00:00.000Z")]
        for mutate in cases:
            self.document = monitor_input(); mutate(self.document)
            with self.subTest(document=self.document), self.assertRaises(WorkbenchError): self.run_case()

    def test_upstream_quality_gap_cannot_be_hidden_by_valid_prices(self):
        self.document["quality_gaps"] = ["CORPORATE_ACTIONS_INCOMPLETE", "IDENTITY_NOT_VERIFIED"]
        result = self.run_case()
        self.assertEqual(result["outcome"], "insufficient_evidence")
        self.assertEqual(result["gaps"], self.document["quality_gaps"])
        self.assertEqual(result["changes"], [])


if __name__ == "__main__": unittest.main()
