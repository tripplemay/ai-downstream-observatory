"""Fictional arithmetic vectors; no database, source admission or provider calls."""

from tests.investor.test_evidence_model_state import sparse_cases
from worker.investor.model_state import advance_evidence_model
from worker.orchestration.db import WorkbenchError, canonical_json


def main():
    definition, cases = sparse_cases()
    for case in cases:
        try:
            case["result"] = advance_evidence_model(definition, case["projection"], case["previous"], case["now"], input_hash="b" * 64, sparse=True)
            case["error"] = None
        except WorkbenchError as error:
            codes = {"INVESTOR_MODEL_CHECKPOINT_LIMIT_REQUIRES_RESTART": "MONITOR_CHECKPOINT_LIMIT_REQUIRES_RESTART",
                "INVESTOR_MODEL_ACTION_RESTATEMENT_REQUIRED": "MONITOR_ACTION_RESTATEMENT_REQUIRED"}
            if str(error) not in codes: raise
            case["result"], case["error"] = None, codes[str(error)]
    print(canonical_json({"definition": definition, "cases": cases, "real_provider_called": False}))


if __name__ == "__main__": main()
