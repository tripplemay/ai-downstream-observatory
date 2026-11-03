"""Component checks for the fictional setup, separate from real-clock acceptance."""

from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tests.investor import current_correction_fixture as fixture
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.investor.retained_monitor_history import read_retained_monitor_history
from worker.orchestration.db import ROOT, instant, open_database


class CurrentCorrectionFixtureTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory(prefix="etf-correction-http-"); self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "workbench.db"
        result = subprocess.run(["node", "scripts/migrate-workbench.mjs", "--db", str(self.path)], cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.db = open_database(self.path); self.addCleanup(self.db.close); self.enterContext(offline_protocol_fixture())

    def test_explicit_past_construction_has_two_real_v4_checkpoints_without_manufacturing_comparison_or_consent(self):
        at = "2026-10-20T10:00:03.000Z"
        # This frozen component clock is not the standalone actual-clock proof.
        constructed_core = fixture.core
        with patch.object(fixture, "actual", return_value=at), patch.object(fixture, "core", side_effect=lambda connection, checked=None: constructed_core(connection, checked or at)):
            value = fixture.prepare(self.db, self.path)
        self.assertEqual(value["source_day"], "2026-10-20")
        state = fixture.inspect(self.db)
        self.assertEqual(state["counts"]["investor_evidence_model_checkpoints"], 2)
        self.assertEqual(state["counts"]["investor_monitor_evidence_inputs"], 2)
        self.assertEqual(state["counts"]["investor_correction_consents"], 0)
        self.assertEqual(state["counts"]["investor_correction_consent_requests"], 0)
        self.assertTrue(all(n == 0 for n in state["financial"].values()))
        history = read_retained_monitor_history(self.db, "w", "owner", value["model_id"], now=at)
        self.assertEqual(history["proof"]["head_checkpoint_id"], value["original_head_id"])
        self.assertEqual(len(history["proof"]["input_bindings"]), 2)
        self.assertTrue(history["original_actions"])
        for row in self.db.execute("SELECT document_json FROM investor_monitor_evidence_inputs"):
            self.assertIn('"schema_version":"investor-monitor-data-input-v4"', row[0])

    def test_timeline_leaves_separate_past_source_days_and_keeps_the_original_explicit_seven_day_cost_window(self):
        for at in ("2026-11-01T05:59:00.000Z", "2026-11-01T06:01:00.000Z", "2026-11-03T00:30:00.000Z", "2026-12-01T08:00:00.000Z"):
            today = instant(at).astimezone(fixture.actions.ZONE).date(); dates = fixture.timeline(at)
            self.assertGreaterEqual((today - dates["event"]).days, 2)
            self.assertLess(dates["event"].weekday(), 5)
            self.assertLessEqual((today - dates["seed"]).days, 6)
            self.assertLess(dates["seed"], dates["seed"] + fixture.timedelta(days=1))
            self.assertLess(dates["seed"] + fixture.timedelta(days=1), dates["event"] + fixture.timedelta(days=1))
            self.assertLess(dates["event"] + fixture.timedelta(days=1), today)

    def test_current_source_window_is_not_backdated_or_bypassed_to_create_an_early_fixture(self):
        before = list(self.db.iterdump())
        with patch.object(fixture, "actual", return_value="2026-11-06T05:30:00.000Z"), \
                patch.object(fixture.actions, "prepare", side_effect=AssertionError("NO_EARLY_CONSTRUCTION")) as construct:
            with self.assertRaisesRegex(AssertionError, "REQUIRES_NY_AFTER_01"): fixture.prepare(self.db, self.path)
        construct.assert_not_called(); self.assertEqual(before, list(self.db.iterdump()))

    def test_standalone_entrypoint_refuses_a_database_outside_its_own_scratch_prefix_before_opening_it(self):
        with TemporaryDirectory(prefix="not-a-correction-fixture-") as directory:
            path = Path(directory) / "workbench.db"; path.touch(); before = path.read_bytes()
            result = subprocess.run([sys.executable, "-m", "tests.investor.current_correction_fixture", "--db", str(path), "--stage", "inspect"],
                cwd=ROOT, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0); self.assertIn("AssertionError", result.stderr); self.assertEqual(path.read_bytes(), before)


if __name__ == "__main__": unittest.main()
