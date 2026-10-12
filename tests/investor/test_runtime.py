"""Synthetic workspace queue, fenced publication and zero financial writes."""

from copy import deepcopy
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tests.investor.fixtures import profile, research_input
from worker.investor.runtime import prepare_research_job, register_synthetic_input, sync_research_requests
from worker.investor.strategy import ENGINE_VERSION, research_reference
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash, open_database, transaction
from worker.orchestration.jobs import claim_job, complete_job, run_one
from worker.orchestration.runtime import run_pending_once


NOW = "2026-01-02T12:00:03.000Z"
FINANCIAL_TABLES = ("portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports")


class InvestorRuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix="etf-investor-synthetic-")
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "workbench.db"
        result = subprocess.run(["/opt/homebrew/bin/node" if Path("/opt/homebrew/bin/node").exists() else "node",
                                 str(ROOT / "scripts/migrate-workbench.mjs"), "--db", str(self.path)],
                                cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.db = open_database(self.path)
        self.addCleanup(self.db.close)
        self.db.execute("INSERT INTO investor_workspaces(id,owner_id,revision,created_at) VALUES('w','synthetic-investor',0,?)", (NOW,))
        self.version = 0

    def save(self, preferences=None):
        self.version += 1
        identifier = "profile-" + str(self.version)
        audit = "audit-" + str(self.version)
        value = preferences or profile()
        with transaction(self.db):
            self.db.execute("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,'synthetic-investor','investor_save_profile','investor_workspace','w','{}',?)", (audit, NOW))
            self.db.execute("INSERT INTO investor_profiles(id,workspace_id,version,document_json,content_hash,actor_id,created_at,audit_id) VALUES(?,'w',?,?,?,'synthetic-investor',?,?)",
                            (identifier, self.version, canonical_json(value), content_hash(value), NOW, audit))
            self.db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id='w'")
        return identifier

    def request(self):
        preferences = self.db.execute("SELECT * FROM investor_profiles ORDER BY version DESC LIMIT 1").fetchone()
        source = self.db.execute("SELECT * FROM investor_research_inputs ORDER BY created_at DESC,rowid DESC LIMIT 1").fetchone()
        document = {"schema_version": "investor-research-request-v1", "engine_version": ENGINE_VERSION,
                    "profile_hash": preferences["content_hash"], "input_hash": source["content_hash"] if source else None}
        digest, identifier = content_hash(document), "request-" + str(self.db.execute("SELECT count(*) FROM investor_research_requests").fetchone()[0])
        self.db.execute("INSERT INTO investor_research_requests(id,workspace_id,profile_id,input_id,input_version,document_json,created_at) VALUES(?,'w',?,?,?,?,?)",
                        (identifier, preferences["id"], source["id"] if source else None, digest, canonical_json(document), NOW))
        return identifier

    def synthetic(self, modify=None):
        data, plan, policy = research_input()
        if modify: modify(data, plan, policy)
        return register_synthetic_input(self.db, "w", data, plan, policy, now=NOW)

    def calculate(self, allow=True):
        sync_research_requests(self.db, now=NOW)
        return run_one(self.db, "fixture", lambda job, lease: prepare_research_job(self.db, job, lease,
                       clock=lambda: NOW, allow_synthetic=allow), job_type="investor_research", clock=lambda: NOW)

    def assert_no_finance(self):
        for table in FINANCIAL_TABLES:
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0, table)

    def test_core_worker_completes_missing_input_check_without_account_or_order(self):
        self.save(); self.request()
        result = run_pending_once(self.db, "core-test", clock=lambda: NOW)
        self.assertEqual(result["status"], "succeeded")
        run = self.db.execute("SELECT * FROM investor_research_runs").fetchone()
        document = json.loads(run["document_json"])
        self.assertEqual(document["status"], "blocked")
        self.assertEqual(document["reason_codes"], ["REFERENCE_DATASET_NOT_READY", "REFERENCE_STRATEGY_NOT_READY"])
        self.assertIsNone(document["result"])
        self.assertEqual(content_hash(document), run["content_hash"])
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], 2)
        self.assertIsNone(run_pending_once(self.db, "core-test", clock=lambda: NOW))
        self.assert_no_finance()

    def test_production_core_never_runs_synthetic_even_when_it_is_registered(self):
        self.save(); self.synthetic(); self.request()
        result = run_pending_once(self.db, "core-test", clock=lambda: NOW)
        self.assertEqual(result["status"], "succeeded")
        document = json.loads(self.db.execute("SELECT document_json FROM investor_research_runs").fetchone()[0])
        self.assertEqual(document["reason_codes"], ["SYNTHETIC_RESEARCH_DISABLED"])
        self.assertIsNone(document["result"])
        self.assert_no_finance()

    def test_test_only_pipeline_publishes_train_options_not_a_selected_plan(self):
        self.save(); self.synthetic(); self.request()
        result = self.calculate()
        self.assertEqual(result["status"], "succeeded")
        document = json.loads(self.db.execute("SELECT document_json FROM investor_research_runs").fetchone()[0])
        self.assertEqual(document["result"]["status"], "risk_options_ready")
        self.assertIsNone(document["result"]["selected_parameters"])
        self.assertEqual(document["result"]["phase_evidence"], [])
        self.assertEqual(len(document["result"]["candidates"]), 3)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_reference_plans").fetchone()[0], 0)
        observation = json.loads(self.db.execute("SELECT document_json FROM investor_observations").fetchone()[0])
        self.assertEqual(observation["outcome"], "insufficient_evidence")
        self.assertEqual(observation["monitoring"], "not_enabled")
        self.assertEqual(observation["profile_id"], document["profile_id"])
        self.assert_no_finance()

    def test_confirmed_test_risk_does_not_promote_exploratory_result_to_personal_portfolio(self):
        self.save(profile("0.30")); self.synthetic(); self.request(); self.calculate()
        document = json.loads(self.db.execute("SELECT document_json FROM investor_research_runs").fetchone()[0])
        self.assertEqual(document["result"]["status"], "reference_ready")
        self.assertEqual(document["result"]["qualification"], "exploratory_research_only")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_reference_plans").fetchone()[0], 0)
        self.assert_no_finance()

    def test_superseded_profile_is_skipped_without_revision_or_observation_writes(self):
        self.save(); self.request(); self.save({**profile(), "horizon_years": 13})
        self.assertEqual(self.calculate()["status"], "skipped")
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_observations").fetchone()[0], 0)

    def test_inputs_updated_during_calculation_cannot_publish_old_result(self):
        self.save(); self.synthetic(); self.request()
        def changed(**kwargs):
            result = research_reference(**kwargs)
            self.synthetic(lambda data, plan, policy: policy["stress_scenarios"][0].update(label="Changed synthetic scenario"))
            return result
        with patch("worker.investor.runtime.research_reference", side_effect=changed):
            self.assertEqual(self.calculate()["status"], "skipped")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_research_runs").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_observations").fetchone()[0], 0)

    def test_lease_takeover_fences_old_effect_and_only_winner_publishes(self):
        self.save(); self.request(); sync_research_requests(self.db, now=NOW)
        old = claim_job(self.db, "old", 1, "investor_research", now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs").fetchone())
        prepared = prepare_research_job(self.db, job, old, clock=lambda: NOW)
        later = "2026-01-02T12:00:05.000Z"
        winner = claim_job(self.db, "new", 60, "investor_research", now=later)
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            complete_job(self.db, old, {}, effect=prepared["effect"], now=later)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_research_runs").fetchone()[0], 0)
        latest_job = dict(self.db.execute("SELECT * FROM job_runs").fetchone())
        latest = prepare_research_job(self.db, latest_job, winner, clock=lambda: later)
        complete_job(self.db, winner, {}, effect=latest["effect"], now=later)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_research_runs").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM job_attempts").fetchone()[0], 2)
        self.assert_no_finance()

    def test_restore_marker_during_effect_rolls_back_result_observation_and_revision(self):
        self.save(); self.request(); sync_research_requests(self.db, now=NOW)
        lease = claim_job(self.db, "test", 60, "investor_research", now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs").fetchone())
        prepared = prepare_research_job(self.db, job, lease, clock=lambda: NOW)
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        def effect(db):
            result = prepared["effect"](db)
            marker.write_text("Synthetic recovery lock")
            return result
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            complete_job(self.db, lease, {}, effect=effect, now=NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_research_runs").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_observations").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], 1)

    def test_failed_schema_diagnostics_do_not_echo_private_values_to_job_history(self):
        self.save(); self.request()
        with patch("worker.investor.runtime.validate_contract", side_effect=ValueError("Private fixture value must not leak")):
            with self.assertRaisesRegex(WorkbenchError, "^INVESTOR_RESEARCH_PREPARATION_FAILED$"):
                self.calculate()
        attempt = self.db.execute("SELECT error_json FROM job_attempts").fetchone()[0]
        self.assertNotIn("Private", attempt)
        self.assertIn("INVESTOR_RESEARCH_PREPARATION_FAILED", attempt)

    def test_input_request_and_run_cannot_update_delete_or_replace(self):
        self.save(); self.synthetic(); self.request(); self.calculate()
        for table in ("investor_research_inputs", "investor_research_requests", "investor_research_runs"):
            with self.subTest(table=table):
                with self.assertRaisesRegex(Exception, "immutable"):
                    self.db.execute("UPDATE " + table + " SET created_at=?", (NOW,))
                with self.assertRaisesRegex(Exception, "immutable"):
                    self.db.execute("DELETE FROM " + table)
                row = dict(self.db.execute("SELECT * FROM " + table).fetchone())
                with self.assertRaises(Exception):
                    self.db.execute("INSERT OR REPLACE INTO " + table + "(" + ",".join(row) + ") VALUES(" + ",".join("?" for _ in row) + ")", tuple(row.values()))

    def test_worker_role_separation_and_bounded_discovery(self):
        self.save(); self.request(); sync_research_requests(self.db, now=NOW)
        self.assertIsNone(run_pending_once(self.db, "verifier", role="verifier", clock=lambda: NOW))
        self.assertIsNone(run_pending_once(self.db, "prices", role="longport", clock=lambda: NOW))
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "queued")
        for limit in (0, True, 1001):
            with self.assertRaisesRegex(WorkbenchError, "DISCOVERY_LIMIT"): sync_research_requests(self.db, limit=limit)

    def test_real_input_cannot_be_registered_through_synthetic_importer(self):
        self.save()
        data, plan, policy = research_input(); data["mode"] = "historical_point_in_time"
        with self.assertRaisesRegex(WorkbenchError, "SYNTHETIC_INPUT_REQUIRED"):
            register_synthetic_input(self.db, "w", data, plan, policy, now=NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_research_inputs").fetchone()[0], 0)
