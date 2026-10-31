"""An empty recent-receipt search is not source qualification or a cache hit."""

import unittest
from unittest.mock import patch

from tests.investor import test_initial_prices as fixture
from worker.investor import data_evidence, monitor_bootstrap, source_inputs
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError
from worker.orchestration.runtime import run_pending_once


class EmptyBootstrapCandidatesTests(unittest.TestCase):
    setUp = fixture.InitialPriceTests.setUp
    prepare = fixture.InitialPriceTests.prepare
    model = fixture.InitialPriceTests.model
    monitor_fixture = fixture.InitialPriceTests.monitor_fixture
    clocked = fixture.InitialPriceTests.clocked
    transport = fixture.InitialPriceTests.transport
    assert_no_finance = fixture.InitialPriceTests.assert_no_finance

    def fresh_prices(self):
        with self.clocked(), self.transport() as sdk:
            for unused in range(2):
                self.assertEqual(run_pending_once(self.db, "fictional-empty-recovery", role="longport", clock=lambda: fixture.NOW)["status"], "succeeded")
        self.assertEqual(sdk.call_count, 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)

    def test_empty_recent_headers_skip_reconstruction_without_claiming_ready(self):
        self.prepare(fixed=True); before = self.db.total_changes
        with patch.object(monitor_bootstrap, "current_monitor_model", wraps=monitor_bootstrap.current_monitor_model) as model, \
                patch.object(source_inputs, "build_dataset", wraps=source_inputs.build_dataset) as builds, \
                patch.object(longport, "_collect_isolated") as sdk:
            with self.assertRaisesRegex(WorkbenchError, "INVESTOR_BOOTSTRAP_PRICES_NOT_READY"):
                monitor_bootstrap.plan_bootstrap(self.db, "w", self.definition["model_id"], fixture.NOW)
        model.assert_not_called(); builds.assert_not_called(); sdk.assert_not_called()
        self.assertEqual(self.db.total_changes, before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
        self.assert_no_finance()

    def test_arriving_receipts_after_empty_search_still_require_full_model_and_source_checks(self):
        self.prepare(fixed=True)
        with self.assertRaisesRegex(WorkbenchError, "PRICES_NOT_READY"):
            monitor_bootstrap.plan_bootstrap(self.db, "w", self.definition["model_id"], fixture.NOW)
        self.fresh_prices(); before = self.db.total_changes
        with patch.object(monitor_bootstrap, "current_monitor_model", wraps=monitor_bootstrap.current_monitor_model) as model, \
                patch.object(source_inputs, "build_dataset", wraps=source_inputs.build_dataset) as builds, \
                patch.object(longport, "_collect_isolated") as sdk:
            value = monitor_bootstrap.plan_bootstrap(self.db, "w", self.definition["model_id"], fixture.NOW)
        self.assertGreater(model.call_count, 0); self.assertGreater(builds.call_count, 0); sdk.assert_not_called()
        self.assertEqual(len(value[3]), 1)
        self.assertEqual(len(value[3][0]["capture_ids"]), 2)
        self.assertEqual(self.db.total_changes, before)
        self.assert_no_finance()

    def test_fresh_headers_with_withdrawn_authority_never_admit_or_default_sources(self):
        self.prepare(fixed=True); self.fresh_prices()
        data_evidence.review_source(self.db, "w", "synthetic-investor", self.refs[0]["rights"]["source_id"],
            "withdrawn", None, "Fictional authority withdrawal with recent headers", fixture.monitor.EXPIRY, now=fixture.NOW)
        with patch.object(monitor_bootstrap, "current_monitor_model", wraps=monitor_bootstrap.current_monitor_model) as model, \
                patch.object(longport, "_collect_isolated") as sdk:
            self.assertEqual(monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=fixture.NOW), [])
        self.assertGreater(model.call_count, 0); sdk.assert_not_called()
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
        self.assert_no_finance()

    def test_one_recent_target_cannot_fill_the_other_from_old_history(self):
        self.prepare(fixed=True)
        with self.clocked(), self.transport() as sdk:
            self.assertEqual(run_pending_once(self.db, "fictional-partial-receipt", role="longport", clock=lambda: fixture.NOW)["status"], "succeeded")
        self.assertEqual(sdk.call_count, 1); before = self.db.total_changes
        with patch.object(monitor_bootstrap, "current_monitor_model", wraps=monitor_bootstrap.current_monitor_model) as model, \
                patch.object(longport, "_collect_isolated") as sdk:
            with self.assertRaisesRegex(WorkbenchError, "PRICES_NOT_READY"):
                monitor_bootstrap.plan_bootstrap(self.db, "w", self.definition["model_id"], fixture.NOW)
        self.assertGreater(model.call_count, 0); sdk.assert_not_called()
        self.assertEqual(self.db.total_changes, before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
        self.assert_no_finance()

    def test_foreign_or_missing_model_does_not_scan_private_receipts(self):
        self.prepare(fixed=True); before = self.db.total_changes
        with patch.object(monitor_bootstrap, "current_monitor_model") as model, patch.object(monitor_bootstrap, "_candidate") as candidate:
            with self.assertRaises(WorkbenchError):
                monitor_bootstrap.plan_bootstrap(self.db, "foreign", self.definition["model_id"], fixture.NOW)
        model.assert_not_called(); candidate.assert_not_called()
        self.assertEqual(self.db.total_changes, before)
        self.assert_no_finance()


if __name__ == "__main__":
    unittest.main()
