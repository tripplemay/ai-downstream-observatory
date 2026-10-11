"""Retention metadata clocks do not relax source evidence precision."""

from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest

from worker.investor.funded_result_retention import purge_due_funded_results
from worker.orchestration.db import ROOT, WorkbenchError, instant, open_database


class FundedResultRetentionTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix="etf-investor-synthetic-")
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "workbench.db"
        node = "/opt/homebrew/bin/node" if Path("/opt/homebrew/bin/node").exists() else "node"
        result = subprocess.run([node, str(ROOT / "scripts/migrate-workbench.mjs"), "--db", str(path)], cwd=ROOT, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0)
        self.db = open_database(path)
        self.addCleanup(self.db.close)

    def test_runtime_datetime_clock_is_metadata_and_does_not_break_empty_maintenance(self):
        before = self.db.total_changes
        self.assertEqual(purge_due_funded_results(self.db, now=instant("2026-01-02T12:00:03.123456Z")), [])
        self.assertEqual(self.db.total_changes, before)

    def test_explicit_evidence_precision_and_batch_limits_are_not_relaxed(self):
        with self.assertRaisesRegex(WorkbenchError, "CLOCK_PRECISION"):
            purge_due_funded_results(self.db, now="2026-01-02T12:00:03.123456Z")
        for limit in (0, 1001, True, 1.5):
            with self.assertRaisesRegex(WorkbenchError, "PURGE_LIMIT"):
                purge_due_funded_results(self.db, now="2026-01-02T12:00:03.123Z", limit=limit)


if __name__ == "__main__":
    unittest.main()
