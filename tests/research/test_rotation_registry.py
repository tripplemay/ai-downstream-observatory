"""Implementation identity changes are simulated without editing source files."""

from copy import deepcopy
from hashlib import sha256
import json
import unittest
from unittest.mock import patch

from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash
from worker.research.backtest import ENGINE_VERSION as LEGACY_ENGINE_VERSION
from worker.research.registry import (
    implementation_manifest, persist_trial, prepare_trial, register_experiment,
    register_trial, run_trial,
)
from worker.research.rotation import ENGINE_VERSION as ROTATION_ENGINE_VERSION
from tests.market.support import NOW, database, ledger_event, seed_account
from tests.research.rotation_fixtures import dataset, parameters, plan


class RotationRegistryTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = database(self)
        seed_account(self.db)
        ledger_event(self.db, "synthetic-existing-capital", (("cash_settled", "240"), ("external_capital", "-240")))
        register_experiment(self.db, "rotation:implementation", "p", plan(), dataset(), "synthetic-human", now=NOW)
        self.trial = register_trial(self.db, "rotation:implementation", "train", parameters(), "rotation:trial", "synthetic-human", now=NOW)

    def state(self):
        tables = [row[0] for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return {name: sorted((dict(row) for row in self.db.execute('SELECT * FROM "' + name.replace('"', '""') + '"')), key=canonical_json)
                for name in tables}

    def changed_manifest(self):
        manifest = deepcopy(implementation_manifest("UTC"))
        manifest["source_hashes"]["worker/research/rotation_signals.py"] = sha256(b"Synthetic hypothetical signal implementation change").hexdigest()
        self.assertNotEqual(manifest, implementation_manifest("UTC"))
        return manifest

    def test_manifest_binds_actual_rotation_versions_sources_and_contract_bytes(self):
        manifest = implementation_manifest("UTC")
        self.assertEqual(manifest["engine_version"], LEGACY_ENGINE_VERSION)
        self.assertEqual(manifest["rotation_engine_version"], ROTATION_ENGINE_VERSION)
        required = {"worker/research/rotation.py", "worker/research/rotation_signals.py",
                    "contracts/v1/research-plan.schema.json", "contracts/v1/research-dataset.schema.json",
                    "contracts/v1/research-parameters.schema.json", "contracts/v1/research-rotation-parameters.schema.json",
                    "contracts/v1/research-fixed-rebalance-parameters.schema.json"}
        self.assertTrue(required <= set(manifest["source_hashes"]))
        for relative, digest in manifest["source_hashes"].items():
            with self.subTest(relative=relative):
                self.assertEqual(digest, sha256((ROOT / relative).read_bytes()).hexdigest())
        run = self.db.execute("SELECT input_manifest FROM research_runs WHERE id=?", (self.trial["run_id"],)).fetchone()
        self.assertEqual(json.loads(run["input_manifest"])["implementation"], manifest)
        prepared = prepare_trial(self.db, self.trial["id"])
        report = json.loads(prepared.result_json)
        self.assertEqual(report["implementation"], manifest)
        self.assertEqual(report["strategy"]["engine_version"], ROTATION_ENGINE_VERSION)
        self.assertEqual(report["benchmark"]["engine_version"], ROTATION_ENGINE_VERSION)

    def test_signal_source_change_before_prepare_rejects_without_any_db_mutation(self):
        before = self.state()
        with patch("worker.research.registry.implementation_manifest", return_value=self.changed_manifest()):
            with self.assertRaisesRegex(WorkbenchError, "RESEARCH_IMPLEMENTATION_CHANGED_REGISTER_NEW_TRIAL"):
                prepare_trial(self.db, self.trial["id"])
        self.assertEqual(self.state(), before)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM simulation_events").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT status FROM research_runs WHERE id=?", (self.trial["run_id"],)).fetchone()[0], "queued")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM research_trials").fetchone()[0], 1)

    def test_signal_source_change_after_prepare_rejects_persist_atomically(self):
        prepared = prepare_trial(self.db, self.trial["id"])
        before = self.state()
        with patch("worker.research.registry.implementation_manifest", return_value=self.changed_manifest()):
            with self.assertRaisesRegex(WorkbenchError, "RESEARCH_IMPLEMENTATION_CHANGED_DURING_COMPUTATION"):
                persist_trial(self.db, prepared, now=NOW)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM simulation_events").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT status FROM research_runs WHERE id=?", (self.trial["run_id"],)).fetchone()[0], "queued")

    def test_completed_report_remains_original_bytes_hash_and_events_after_source_change(self):
        prepared = prepare_trial(self.db, self.trial["id"])
        original = persist_trial(self.db, prepared, now=NOW)
        original_bytes = original["result_json"].encode("utf-8")
        original_digest = sha256(original_bytes).hexdigest()
        original_report = json.loads(original_bytes)
        self.assertEqual(original_report["result_hash"], content_hash({key: value for key, value in original_report.items() if key != "result_hash"}))
        self.assertGreater(self.db.execute("SELECT COUNT(*) FROM simulation_events").fetchone()[0], 0)
        before = self.state()
        with patch("worker.research.registry.implementation_manifest", return_value=self.changed_manifest()) as current:
            reread = run_trial(self.db, self.trial["id"], now=NOW)
            repeated_persist = persist_trial(self.db, prepared, now=NOW)
            current.assert_not_called()
        self.assertEqual(reread, original)
        self.assertEqual(repeated_persist, original)
        self.assertEqual(reread["result_json"].encode("utf-8"), original_bytes)
        self.assertEqual(sha256(reread["result_json"].encode("utf-8")).hexdigest(), original_digest)
        self.assertEqual(json.loads(reread["result_json"])["result_hash"], original_report["result_hash"])
        self.assertEqual(self.state(), before)


if __name__ == "__main__":
    unittest.main()
