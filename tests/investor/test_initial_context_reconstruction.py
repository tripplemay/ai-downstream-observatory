"""One complete reconstruction per context; fictional source changes stay fenced."""

import unittest
from unittest.mock import patch

from tests.investor import test_initial_prices as fixture
from worker.investor import data_evidence, initial_prices, source_inputs
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError


class InitialContextReconstructionTests(unittest.TestCase):
    setUp = fixture.InitialPriceTests.setUp
    prepare = fixture.InitialPriceTests.prepare
    model = fixture.InitialPriceTests.model
    monitor_fixture = fixture.InitialPriceTests.monitor_fixture
    assert_no_finance = fixture.InitialPriceTests.assert_no_finance

    def test_both_model_versions_keep_one_complete_build_and_replay_source_headers(self):
        for fixed in (False, True):
            with self.subTest(fixed=fixed):
                if fixed: self.setUp()
                self.prepare(fixed=fixed)
                count = self.db.execute("SELECT count(*) FROM investor_price_captures").fetchone()[0]
                before = self.db.total_changes
                with data_evidence._fact_validation_scope(), \
                        patch.object(source_inputs, "build_dataset", wraps=source_inputs.build_dataset) as builds, \
                        patch.object(longport, "_parse_child_projection", wraps=longport._parse_child_projection) as payloads, \
                        patch.object(longport, "_collect_isolated") as sdk:
                    context = initial_prices._context(self.db, "w", self.definition["model_id"], fixture.NOW)
                sdk.assert_not_called()
                self.assertEqual(builds.call_count, 1)
                self.assertEqual(payloads.call_count, count * (3 if fixed else 4))
                self.assertEqual(len(context[4]), 2)
                self.assertNotIn("payload", context[3])
                self.assertEqual(self.db.total_changes, before)
                self.assert_no_finance()

    def test_withdrawal_after_complete_reconstruction_is_not_hidden_by_header_reuse(self):
        self.prepare(fixed=True)
        original = source_inputs.build_dataset
        def withdrawn(*args, **kwargs):
            result = original(*args, **kwargs)
            data_evidence.review_source(self.db, "w", "synthetic-investor", self.refs[0]["rights"]["source_id"],
                "withdrawn", None, "Fictional withdrawal after reconstruction", fixture.monitor.EXPIRY, now=fixture.NOW)
            return result
        with data_evidence._fact_validation_scope(), patch.object(source_inputs, "build_dataset", side_effect=withdrawn), \
                patch.object(longport, "_collect_isolated") as sdk:
            with self.assertRaises(WorkbenchError):
                initial_prices._context(self.db, "w", self.definition["model_id"], fixture.NOW)
        sdk.assert_not_called()
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_initial_price_requests").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
        self.assert_no_finance()


if __name__ == "__main__":
    unittest.main()
