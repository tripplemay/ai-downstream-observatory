import json
import subprocess
import sys
import unittest

from tests.market.support import ROOT, database, seed_account
from tests.research.fixtures import dataset, parameters, plan


class ResearchCLITests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = database(self)
        seed_account(self.db)
        for name, value in (("plan", plan()), ("dataset", dataset()), ("parameters", parameters())):
            (self.path.parent / (name + ".json")).write_text(json.dumps(value), encoding="utf-8")

    def cli(self, *arguments):
        return subprocess.run([sys.executable, "-m", "worker.research", "--db", str(self.path), *arguments],
                              cwd=ROOT, capture_output=True, text=True, check=False)

    def test_cli_registration_trial_run_and_restore_lock(self):
        registration = self.cli("register", "--experiment", "cli:1", "--portfolio", "p", "--actor", "human",
                                "--plan", str(self.path.parent / "plan.json"), "--dataset", str(self.path.parent / "dataset.json"))
        self.assertEqual(registration.returncode, 0, registration.stderr)
        self.assertEqual(set(json.loads(registration.stdout)), {"experiment_id", "plan_hash", "dataset_hash"})
        arguments = ("trial", "--experiment", "cli:1", "--phase", "train", "--actor", "human", "--key", "cli-train",
                     "--parameters", str(self.path.parent / "parameters.json"))
        trial = self.cli(*arguments)
        self.assertEqual(trial.returncode, 0, trial.stderr)
        trial_id = json.loads(trial.stdout)["id"]
        execution = self.cli("run", "--trial", trial_id)
        self.assertEqual(execution.returncode, 0, execution.stderr)
        report = json.loads(json.loads(execution.stdout)["result_json"])
        self.assertFalse(report["live_advice_eligible"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM ledger_events").fetchone()[0], 0)
        (self.path.parent / "RESTORE_PENDING_REVIEW").touch()
        blocked = self.cli(*arguments)
        self.assertEqual(blocked.returncode, 1)
        self.assertIn("RESTORE_PENDING_REVIEW", blocked.stderr)

    def test_invalid_portfolio_returns_structured_cli_error(self):
        result = self.cli("register", "--experiment", "cli:1", "--portfolio", "missing", "--actor", "human",
                          "--plan", str(self.path.parent / "plan.json"), "--dataset", str(self.path.parent / "dataset.json"))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr)["error"], "IntegrityError")


if __name__ == "__main__":
    unittest.main()
