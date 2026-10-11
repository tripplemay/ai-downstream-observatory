import json
import subprocess
import sys
import unittest

from tests.investor.fixtures import MONITOR_NOW, monitor_input, profile, research_input
from worker.investor.__main__ import MAX_INPUT_BYTES, parse_request
from worker.market.contracts import validate_contract
from worker.orchestration.db import ROOT, WorkbenchError


class InvestorKernelCliTests(unittest.TestCase):
    def run_cli(self, raw, *arguments):
        return subprocess.run([sys.executable, "-m", "worker.investor", *arguments], input=raw, text=True,
                              cwd=ROOT, capture_output=True, timeout=30, check=False)

    def test_monitor_cli_three_outcomes_use_shared_output_contract(self):
        for kind in ("observe", "decision_required", "insufficient_evidence"):
            document = monitor_input()
            if kind == "decision_required": document["funding_intent"] = {"id": "synthetic-flow", "amount_cny": "2000", "expected_at": MONITOR_NOW}
            if kind == "insufficient_evidence": document["quality_gaps"] = ["IDENTITY_NOT_VERIFIED"]
            process = self.run_cli(json.dumps({"action": "monitor", "document": document, "now": MONITOR_NOW}))
            self.assertEqual(process.returncode, 0, process.stderr)
            result = json.loads(process.stdout)
            validate_contract(result, "investor-model-assessment.schema.json")
            self.assertEqual(result["outcome"], kind)
            self.assertEqual(process.stderr, "")

    def test_synthetic_research_requires_explicit_flag_and_unknown_risk_stays_unknown(self):
        dataset, plan, policy = research_input()
        raw = json.dumps({"action": "research", "dataset": dataset, "plan": plan, "policy": policy, "profile": profile()})
        rejected = self.run_cli(raw)
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(json.loads(rejected.stderr), {"error": "INVESTOR_SYNTHETIC_REFERENCE_FORBIDDEN"})
        process = self.run_cli(raw, "--allow-synthetic")
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        validate_contract(result, "investor-strategy-result.schema.json")
        self.assertEqual(result["status"], "risk_options_ready")
        self.assertIsNone(result["selected_parameters"])
        self.assertFalse(result["live_advice_eligible"])

    def test_duplicates_nonfinite_overlarge_and_deep_json_are_bounded(self):
        for raw, code in [(b'{"action":"monitor","action":"research"}', "DUPLICATE_JSON_KEY"),
                          (b'{"action":NaN}', "NONFINITE_JSON"), (b" " * (MAX_INPUT_BYTES + 1), "INPUT_TOO_LARGE"),
                          (b"[" * 2000 + b"]" * 2000, "JSON_INVALID")]:
            with self.subTest(code=code), self.assertRaisesRegex(WorkbenchError, code): parse_request(raw)

    def test_errors_do_not_echo_private_input_or_accept_caller_prepared_result(self):
        marker = "PRIVATE_TEST_MARKER_NOT_A_REAL_SECRET"
        for raw in [json.dumps({"action": "monitor", "document": marker, "now": MONITOR_NOW}),
                    json.dumps({"action": "monitor", "document": monitor_input(), "now": MONITOR_NOW, "result": {"outcome": "observe"}}),
                    '{"action": "' + marker]:
            process = self.run_cli(raw)
            self.assertEqual(process.returncode, 1)
            self.assertEqual(process.stdout, "")
            self.assertNotIn(marker, process.stderr)
            self.assertRegex(json.loads(process.stderr)["error"], "^(CONTRACT_INVALID|INVESTOR_KERNEL_JSON_INVALID)$")


if __name__ == "__main__": unittest.main()
