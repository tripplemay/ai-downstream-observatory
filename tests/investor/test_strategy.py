from copy import deepcopy
from unittest.mock import patch
import unittest

from worker.investor.strategy import research_reference
from worker.orchestration.db import WorkbenchError, content_hash
from worker.research.backtest import compare_backtest
from tests.investor.fixtures import fixed_policy_input, profile, research_input


class InvestorStrategyTests(unittest.TestCase):
    def setUp(self):
        self.data, self.plan, self.policy = research_input()

    def run_case(self, preferences=None):
        return research_reference(self.data, self.plan, self.policy, preferences or profile("0.30"), allow_synthetic=True)

    def test_low_frequency_unknown_risk_runs_only_frozen_train_candidates(self):
        self.data, self.plan, self.policy = fixed_policy_input()
        with patch("worker.investor.strategy.compare_backtest", wraps=compare_backtest) as runner:
            result = self.run_case(profile())
        self.assertEqual(result["status"], "risk_options_ready")
        self.assertIsNone(result["selected_parameters"])
        self.assertEqual([call.args[3] for call in runner.call_args_list], ["train"] * 3)
        self.assertTrue(all(call.args[2]["schema_version"] == "research-fixed-rebalance-parameters-v2" for call in runner.call_args_list))

    def test_low_frequency_role_mapping_cannot_differ_from_stress_policy(self):
        self.data, self.plan, self.policy = fixed_policy_input()
        self.policy["candidates"][1]["roles"]["CN:ALPHA"] = "defensive"
        self.plan["parameter_candidates"] = deepcopy(self.policy["candidates"])
        with self.assertRaisesRegex(WorkbenchError, "POLICY_ROLE_MISMATCH"): self.run_case()

    def test_low_frequency_numeric_spelling_is_not_an_extra_trial(self):
        self.data, self.plan, self.policy = fixed_policy_input()
        duplicate = deepcopy(self.policy["candidates"][0]); duplicate["class_drift_threshold"] = "0.050"
        self.policy["candidates"].append(duplicate); self.plan["parameter_candidates"] = deepcopy(self.policy["candidates"])
        self.plan["trial_budgets"]["train"] = 4
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_ECONOMIC"): self.run_case()

    def test_low_frequency_unexecutable_all_cash_is_not_eligible(self):
        self.data, self.plan, self.policy = fixed_policy_input()
        for row in self.data["sessions"]: row["trade_allowed"] = False
        result = self.run_case(profile())
        self.assertEqual(result["status"], "insufficient_evidence")
        self.assertIsNone(result["selected_parameters"])
        self.assertTrue(all(row["train"]["execution_failure_count"] > 0 for row in result["candidates"]))

    def test_low_frequency_missing_growth_target_is_not_qualified_by_defensive_only_returns(self):
        self.data, self.plan, self.policy = fixed_policy_input()
        self.data["assets"][0]["quantity_step"] = "100000"
        result = self.run_case()
        self.assertEqual(result["status"], "insufficient_evidence")
        self.assertIsNone(result["selected_parameters"])
        self.assertTrue(all(row["risk_budget_pass"] is False for row in result["candidates"]))

    def test_unknown_risk_displays_alternatives_but_never_opens_validation_or_holdout(self):
        with patch("worker.investor.strategy.compare_backtest", wraps=compare_backtest) as runner:
            result = self.run_case(profile())
        self.assertEqual(result["status"], "risk_options_ready")
        self.assertIsNone(result["selected_parameters"])
        self.assertEqual(result["phase_evidence"], [])
        self.assertEqual(result["reason_codes"], ["RISK_BUDGET_UNCONFIRMED"])
        self.assertEqual([call.args[3] for call in runner.call_args_list], ["train"] * 3)
        self.assertEqual(len(result["candidates"]), 3)
        self.assertTrue(all(row["risk_budget_pass"] is None for row in result["candidates"]))
        self.assertEqual(result["candidates"][0]["stresses"][0]["kind"], "hypothetical_role_shock_not_probability_or_loss_limit")

    def test_selected_reference_uses_same_frozen_candidate_in_validation_and_holdout(self):
        with patch("worker.investor.strategy.compare_backtest", wraps=compare_backtest) as runner:
            result = self.run_case()
        self.assertEqual(result["status"], "reference_ready")
        self.assertEqual([row["phase"] for row in result["phase_evidence"]], ["train", "validation", "holdout"])
        self.assertEqual([call.args[3] for call in runner.call_args_list], ["train"] * 3 + ["validation", "holdout"])
        for call in runner.call_args_list[-2:]: self.assertEqual(call.args[2], result["selected_parameters"])
        self.assertFalse(result["live_advice_eligible"])
        self.assertEqual(result["qualification"], "exploratory_research_only")
        sealed = dict(result); seal = sealed.pop("result_hash")
        self.assertEqual(seal, content_hash(sealed))

    def test_money_preferences_do_not_change_weights_or_create_financial_facts(self):
        original = self.run_case()
        changed = self.run_case({**profile("0.30"), "illustrative_budget_cny": "250000", "planned_annual_contribution_cny": "40000"})
        self.assertEqual(original["selected_parameters"], changed["selected_parameters"])
        self.assertEqual(original["phase_evidence"], changed["phase_evidence"])
        self.assertNotEqual(original["profile_hash"], changed["profile_hash"])
        self.assertNotIn("orders", changed)

    def test_holdout_failure_never_reselects_an_alternative_or_claims_success(self):
        def fail(data, plan, parameters, phase):
            result = compare_backtest(data, plan, parameters, phase)
            if phase == "holdout": result["strategy"]["max_drawdown"] = "0.9"
            return result
        with patch("worker.investor.strategy.compare_backtest", side_effect=fail) as runner:
            result = self.run_case()
        self.assertEqual(result["status"], "insufficient_evidence")
        self.assertEqual(result["reason_codes"], ["SELECTED_CANDIDATE_FAILED_HOLDOUT"])
        self.assertEqual(len(runner.call_args_list), 5)
        self.assertIsNotNone(result["selected_parameters"])
        self.assertFalse(result["live_advice_eligible"])

    def test_validation_failure_does_not_unseal_holdout(self):
        def fail(data, plan, parameters, phase):
            result = compare_backtest(data, plan, parameters, phase)
            if phase == "validation": result["strategy"]["execution_failure_count"] = 1
            return result
        with patch("worker.investor.strategy.compare_backtest", side_effect=fail) as runner:
            result = self.run_case()
        self.assertEqual(result["reason_codes"], ["SELECTED_CANDIDATE_FAILED_VALIDATION"])
        self.assertNotIn("holdout", [call.args[3] for call in runner.call_args_list])

    def test_failed_benchmark_cannot_make_a_candidate_eligible_or_fake_ready_risk_choices(self):
        def fail(data, plan, parameters, phase):
            result = compare_backtest(data, plan, parameters, phase)
            result["benchmark"]["execution_failure_count"] = 1
            return result
        for preferences in (profile(), profile("0.30")):
            with patch("worker.investor.strategy.compare_backtest", side_effect=fail):
                result = self.run_case(preferences)
            self.assertEqual(result["status"], "insufficient_evidence")
            self.assertIsNone(result["selected_parameters"])
            self.assertEqual(result["candidates"][0]["train"]["benchmark_execution_failure_count"], 1)

    def test_declared_trial_budget_is_not_silently_exceeded(self):
        self.plan["trial_budgets"]["train"] = 2
        with self.assertRaisesRegex(WorkbenchError, "TRIAL_BUDGET_TOO_SMALL"): self.run_case()

    def test_simple_baseline_remains_a_real_candidate_not_just_a_comparison_caption(self):
        self.plan["benchmark"]["weights"].update({"CN:ALPHA": "0.3", "CN:BETA": "0.7"})
        with self.assertRaisesRegex(WorkbenchError, "BASELINE_NOT_IN_CANDIDATES"): self.run_case()

    def test_small_risk_budget_blocks_without_increasing_it(self):
        result = self.run_case(profile("0.10"))
        self.assertEqual(result["status"], "insufficient_evidence")
        self.assertEqual(result["reason_codes"], ["NO_CANDIDATE_WITHIN_CONFIRMED_RISK_BUDGET"])
        self.assertIsNone(result["selected_parameters"])

    def test_signed_drawdown_loss_is_compared_to_positive_risk_budget_in_every_phase(self):
        for target_phase in ("train", "validation", "holdout"):
            def excessive(data, plan, parameters, phase):
                result = compare_backtest(data, plan, parameters, phase)
                if phase == target_phase: result["strategy"]["max_drawdown"] = "-0.45"
                return result
            with self.subTest(phase=target_phase), patch("worker.investor.strategy.compare_backtest", side_effect=excessive):
                result = self.run_case(profile("0.30"))
            self.assertEqual(result["status"], "insufficient_evidence")
            self.assertEqual(result["reason_codes"], ["NO_CANDIDATE_WITHIN_CONFIRMED_RISK_BUDGET" if target_phase == "train"
                                                   else "SELECTED_CANDIDATE_FAILED_" + target_phase.upper()])

    def test_equal_return_prefers_smaller_drawdown_magnitude_not_more_negative_decline(self):
        expected = self.policy["candidates"][0]
        def tied(data, plan, parameters, phase):
            result = compare_backtest(data, plan, parameters, phase)
            if phase == "train":
                result["strategy"]["annualized_unit_return"] = "0.05"
                result["strategy"]["max_drawdown"] = "-0.01" if parameters == expected else "-0.20"
            return result
        with patch("worker.investor.strategy.compare_backtest", side_effect=tied): result = self.run_case()
        self.assertEqual(result["selected_parameters"], expected)

    def test_positive_drawdown_is_invalid_engine_evidence_not_a_risk_comparison(self):
        def invalid(data, plan, parameters, phase):
            result = compare_backtest(data, plan, parameters, phase)
            result["strategy"]["max_drawdown"] = "0.01"
            return result
        with patch("worker.investor.strategy.compare_backtest", side_effect=invalid): result = self.run_case(profile())
        self.assertEqual(result["status"], "insufficient_evidence")

    def test_policy_permutation_does_not_change_selection_or_training_order(self):
        original = self.run_case()
        self.policy["candidates"].reverse()
        changed = self.run_case()
        self.assertEqual(original["selected_parameters"], changed["selected_parameters"])
        self.assertEqual(original["candidates"], changed["candidates"])
        self.assertEqual(original["phase_evidence"], changed["phase_evidence"])

    def test_synthetic_input_is_rejected_by_default(self):
        with self.assertRaisesRegex(WorkbenchError, "SYNTHETIC_REFERENCE_FORBIDDEN"):
            research_reference(self.data, self.plan, self.policy, profile("0.30"))

    def test_reconstructed_input_retains_research_only_limitations_without_synthetic_switch(self):
        self.data["mode"] = "reconstructed"
        for row in self.data["observations"]:
            row["assumed_available_at"] = row.pop("published_at")
        result = research_reference(self.data, self.plan, self.policy, profile())
        self.assertEqual(result["data_mode"], "reconstructed")
        self.assertEqual(result["status"], "risk_options_ready")
        self.assertFalse(result["live_advice_eligible"])
        self.assertEqual(result["holdout_unseen_status"], "not_independently_verified")
        self.assertTrue(any("not a point-in-time archive" in value for value in result["limits"]))

    def test_unsupported_time_precision_is_not_silently_truncated(self):
        self.data["observations"][0]["ingested_at"] = "2025-01-01T00:00:00.0000001Z"
        with self.assertRaisesRegex(WorkbenchError, "TIME_PRECISION_UNSUPPORTED"): self.run_case()

    def test_profile_scope_and_unresolved_exclusions_block_before_any_backtest(self):
        cases = [({**profile("0.30"), "markets": ["US"]}, "UNIVERSE_OUTSIDE_ALLOWED_MARKETS"),
                 ({**profile("0.30"), "liquidity_need": "uncertain"}, "LIQUIDITY_REVIEW_REQUIRED"),
                 ({**profile("0.30"), "horizon_years": 2}, "HORIZON_OUTSIDE_STRATEGY_SCOPE"),
                 ({**profile("0.30"), "research_direction": "rotation"}, "ENHANCEMENT_EVIDENCE_NOT_AVAILABLE"),
                 ({**profile("0.30"), "exclusions": ["unresolved theme"]}, "EXCLUSIONS_REQUIRE_QUALIFIED_UNIVERSE")]
        for preferences, code in cases:
            with self.subTest(code=code), patch("worker.investor.strategy.compare_backtest") as runner:
                result = self.run_case(preferences)
                self.assertEqual(result["status"], "insufficient_evidence")
                self.assertIn(code, result["reason_codes"])
                runner.assert_not_called()

    def test_corporate_action_coverage_is_not_assumed(self):
        self.data["corporate_actions_complete"] = False
        self.assertEqual(self.run_case()["reason_codes"], ["CORPORATE_ACTION_COVERAGE_INCOMPLETE"])

    def test_no_equivalent_extra_trials_and_no_unfrozen_candidate(self):
        self.plan["trial_budgets"]["train"] = 4
        extra = deepcopy(self.policy["candidates"][0]); extra["weights"]["CN:ALPHA"] = "0.20"
        self.policy["candidates"].append(extra); self.plan["parameter_candidates"].append(extra)
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_ECONOMIC_CANDIDATE"): self.run_case()
        self.policy["candidates"].pop()
        with self.assertRaisesRegex(WorkbenchError, "CANDIDATES_NOT_FROZEN"): self.run_case()

    def test_limits_single_asset_scope_role_coverage_and_phase_length(self):
        for change, code in [
            (lambda: self.policy.update(maximum_single_weight="0.5"), "DIVERSIFICATION_INVALID"),
            (lambda: self.policy["roles"].update({"CN:BETA": "diversifier"}), "DIVERSIFICATION_INVALID"),
            (lambda: self.policy["roles"].pop("CN:ALPHA"), "CONTRACT_INVALID|ROLE_SCOPE"),
            (lambda: self.policy.update(minimum_phase_days=100), "WINDOW_TOO_SHORT"),
            (lambda: self.policy["stress_scenarios"][0]["role_returns"].update(growth="-1.1"), "STRESS_INVALID"),
        ]:
            self.data, self.plan, self.policy = research_input(); change()
            with self.subTest(code=code), self.assertRaisesRegex(WorkbenchError, code): self.run_case()


if __name__ == "__main__": unittest.main()
