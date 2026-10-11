"""Public product metadata is not an approved research fact or data licence."""

import json
from pathlib import Path
import unittest

from worker.investor.data_evidence import KINDS, validate_facts
from worker.orchestration.db import WorkbenchError


SOURCE = Path(__file__).resolve().parents[2] / "config" / "etf-source-candidates.json"


class SourceCandidateBoundaryTests(unittest.TestCase):
    def test_public_document_is_not_any_approved_fact_kind(self):
        document = json.loads(SOURCE.read_text(encoding="utf-8"))
        for kind in sorted(KINDS):
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(WorkbenchError, "^INVESTOR_DATA_FACTS_INVALID$"):
                    validate_facts(kind, document)

    def test_each_candidate_is_not_a_listing_fact(self):
        document = json.loads(SOURCE.read_text(encoding="utf-8"))
        self.assertEqual(len(document["candidates"]), 6)
        for candidate in document["candidates"]:
            with self.subTest(symbol=candidate["symbol"]):
                with self.assertRaisesRegex(WorkbenchError, "^INVESTOR_DATA_FACTS_INVALID$"):
                    validate_facts("listing", candidate)


if __name__ == "__main__":
    unittest.main()
