from copy import deepcopy
import unittest

from tests.investor.fixtures import profile
from tests.research.event_review_fixtures import case, vectors
from worker.investor.strategy import _summary, research_reference, validate_phase_summary
from worker.research.backtest import compare_backtest
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError


class EventReviewStrategyTests(unittest.TestCase):
    def test_explicit_new_selector_requires_resolved_reviews_without_erasing_raw_failures(self):
        data, plan, policy = case()
        result = research_reference(data, plan, policy, profile("0.30"), allow_synthetic=True)
        self.assertEqual(result["schema_version"], "investor-strategy-result-v2")
        self.assertEqual(result["status"], "reference_ready")
        for candidate in result["candidates"]:
            summary = candidate["train"]
            self.assertGreater(summary["execution_failure_count"], 0)
            self.assertEqual(summary["terminal_execution_failure_count"], 0)
            self.assertEqual(summary["unresolved_order_review_count"], 0)
            self.assertEqual(summary["execution_failure_count"], summary["resolved_corporate_action_cancellation_count"])
            validate_phase_summary(summary, plan)
        self.assertEqual([row["phase"] for row in result["phase_evidence"]], ["train", "validation", "holdout"])
        with self.assertRaises(WorkbenchError):
            validate_contract(result, "investor-strategy-result.schema.json")
        forged = deepcopy(result["candidates"][0]["train"])
        forged["terminal_execution_failure_count"] = 1
        with self.assertRaises(WorkbenchError): validate_phase_summary(forged, plan)

    def test_policy_pairing_is_explicit_and_legacy_zero_raw_failure_rule_is_unchanged(self):
        data, plan, policy = case()
        old_policy = deepcopy(policy)
        old_policy.update(schema_version="investor-strategy-policy-v1")
        old_policy.pop("execution_admission")
        with self.assertRaises(WorkbenchError):
            research_reference(data, plan, old_policy, profile("0.30"), allow_synthetic=True)
        plan["schema_version"] = "research-plan-v4"
        plan["execution"]["order_action_policy"] = "defer_known_scheduled_action_before_commit"
        with self.assertRaises(WorkbenchError):
            research_reference(data, plan, policy, profile("0.30"), allow_synthetic=True)
        result = research_reference(data, plan, old_policy, profile("0.30"), allow_synthetic=True)
        self.assertEqual(result["schema_version"], "investor-strategy-result-v1")
        self.assertEqual(result["status"], "insufficient_evidence")
        self.assertIsNone(result["selected_parameters"])
        self.assertTrue(all(row["train"]["execution_failure_count"] > 0 for row in result["candidates"]))

    def test_terminal_or_unresolved_reviews_never_open_validation_or_holdout(self):
        _, _, policy = case()
        for vector in vectors():
            if vector["kind"] not in ("failed_replacement", "no_decision", "missing_fresh_close"): continue
            with self.subTest(kind=vector["kind"]):
                data, plan = deepcopy(vector["input"]["dataset"]), deepcopy(vector["input"]["plan"])
                if vector["kind"] == "missing_fresh_close":
                    plan["decision_times"] = [at for at in plan["decision_times"] if at < "2025-01-09"]
                result = research_reference(data, plan, policy, profile("0.30"), allow_synthetic=True)
                self.assertEqual(result["status"], "insufficient_evidence")
                self.assertIsNone(result["selected_parameters"])
                self.assertEqual(result["phase_evidence"], [])

    def test_unknown_risk_remains_train_only_and_freeze_precedes_later_phase(self):
        data, plan, policy = case()
        result = research_reference(data, plan, policy, profile(), allow_synthetic=True)
        self.assertEqual(result["status"], "risk_options_ready")
        self.assertIsNone(result["selected_parameters"])
        self.assertEqual(result["phase_evidence"], [])
        self.assertIn("RISK_BUDGET_UNCONFIRMED", result["reason_codes"])
        sequence = []
        def evaluate(parameters, phase):
            sequence.append(phase)
            return _summary(compare_backtest(data, plan, parameters, phase))
        research_reference(data, plan, policy, profile("0.30"), allow_synthetic=True,
                           evaluate=evaluate, freeze=lambda _: sequence.append("freeze"))
        self.assertEqual(sequence, ["train", "train", "train", "freeze", "validation", "holdout"])


if __name__ == "__main__": unittest.main()
