"""Fictional private-study lifecycle, attempt history and fenced commits."""

from copy import deepcopy
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tests.investor.fixtures import profile
from tests.investor.funded_history_fixtures import funded_input
from worker.investor.funded_study_runtime import DENIALS, JOB_TYPE, prepare_funded_study_job, sync_funded_study_requests
from worker.investor.funded_study_input import prepare_funded_study_inputs
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash, open_database, transaction
from worker.orchestration.jobs import claim_job, complete_job, run_one
from worker.orchestration.runtime import command_handler, run_pending_once


NOW = "2026-01-02T12:00:04.000Z"


class FundedStudyRuntimeTests(unittest.TestCase):
    def test_calendar_study_does_not_ignore_personal_exclusions_markets_liquidity_or_strategy_scope(self):
        raw = funded_input()
        source = {"payload": {"dataset": raw["dataset"], "plan": {"evaluation_timezone": "Asia/Shanghai"}, "policy": {"minimum_horizon_years": 5}}}
        for change, code in [({"liquidity_need": "uncertain"}, "FUNDED_STUDY_LIQUIDITY_REVIEW_REQUIRED"),
                             ({"exclusions": ["Fictional exclusion"]}, "FUNDED_STUDY_EXCLUSIONS_REQUIRE_QUALIFIED_UNIVERSE"),
                             ({"markets": ["HK"]}, "FUNDED_STUDY_UNIVERSE_OUTSIDE_ALLOWED_MARKETS"),
                             ({"horizon_years": 1}, "FUNDED_STUDY_HORIZON_OUTSIDE_STRATEGY_SCOPE"),
                             ({"research_direction": "rotation"}, "FUNDED_STUDY_ENHANCEMENT_EVIDENCE_REQUIRED")]:
            result = prepare_funded_study_inputs(raw["funding_plan"], source, NOW, {**profile(), **change})
            self.assertEqual(result["reason_codes"], [code])
            self.assertEqual(result["inputs"], [])

    def setUp(self):
        temporary = TemporaryDirectory(prefix="etf-investor-synthetic-")
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "workbench.db"
        node = "/opt/homebrew/bin/node" if Path("/opt/homebrew/bin/node").exists() else "node"
        result = subprocess.run([node, str(ROOT / "scripts/migrate-workbench.mjs"), "--db", str(self.path)],
                                cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.db = open_database(self.path)
        self.addCleanup(self.db.close)
        preferences = profile()
        self.plan = deepcopy(funded_input()["funding_plan"])
        with transaction(self.db):
            self.db.execute("INSERT INTO investor_workspaces VALUES('w','fictional-owner',1,?)", (NOW,))
            self.audit("profile-audit", "save_profile", {})
            self.db.execute("INSERT INTO investor_profiles VALUES('profile','w',1,?,?, 'fictional-owner',?,'profile-audit')",
                            (canonical_json(preferences), content_hash(preferences), NOW))
        self.funding_version = 0
        self.save_funding()

    def audit(self, identifier, action, value):
        self.db.execute("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,'fictional-owner',?,'investor_workspace','w',?,?)",
                        (identifier, "investor_" + action, canonical_json(value), NOW))

    def save_funding(self):
        self.funding_version += 1
        identifier = "funding-" + str(self.funding_version)
        profile_hash = content_hash(profile())
        with transaction(self.db):
            revision = self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0]
            self.audit(identifier + "-audit", "save_funding_plan", {
                "input": {"action": "save_funding_plan", "expected_revision": revision, "idempotency_key": identifier, "funding_plan": self.plan},
                "result": {"funding_plan_id": identifier, "version": self.funding_version, "profile_id": "profile", "profile_hash": profile_hash,
                           "actual_arrivals_confirmed": False, "execution_authorized": False}})
            self.db.execute("INSERT INTO investor_funding_plans VALUES(?,'w','profile',?,?,?,?, 'fictional-owner',?,?)",
                (identifier, self.funding_version, profile_hash, canonical_json(self.plan), content_hash(self.plan), NOW, identifier + "-audit"))
            self.db.execute("UPDATE investor_workspaces SET revision=revision+1")
        return identifier

    def request(self):
        document = {"schema_version": "investor-funded-study-request-v1", "workspace_id": "w", "profile_id": "profile",
            "profile_hash": content_hash(profile()), "funding_plan_id": "funding-1", "funding_plan_hash": content_hash(self.plan),
            "source_head_id": None, "evidence_input_id": None, "input_hash": None, "comparison_declared_at": NOW,
            "window_selection": "earliest_complete_same_calendar_anchor_v1", "historical_start_date": None,
            "candidate_hashes": [], "reason_codes": ["FUNDED_STUDY_REVIEWED_SOURCE_REQUIRED"], **DENIALS}
        digest = content_hash(document)
        with transaction(self.db):
            revision = self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0]
            self.audit("request-audit", "compare_funding", {"input": {"action": "compare_funding", "expected_revision": revision, "idempotency_key": "request"},
                "result": {"request_id": "request", "input_version": digest, "execution_authorized": False}})
            self.db.execute("INSERT INTO investor_funded_study_requests VALUES('request','w','profile','funding-1',NULL,?,?,'fictional-owner',?,'request-audit')",
                            (digest, canonical_json(document), NOW))
            self.db.execute("UPDATE investor_workspaces SET revision=revision+1")
        return document

    def claim(self, owner="test", seconds=60, now=NOW):
        sync_funded_study_requests(self.db, now=now)
        lease = claim_job(self.db, owner, seconds, JOB_TYPE, now=now)
        return dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()), lease

    def no_finance(self):
        for table in ("portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0, table)

    def test_default_core_discovers_private_comparison_without_accounts_or_market_calls(self):
        self.request()
        result = run_pending_once(self.db, "core", clock=lambda: NOW)
        self.assertEqual(result["status"], "succeeded")
        run = json.loads(self.db.execute("SELECT document_json FROM investor_funded_study_runs").fetchone()[0])
        self.assertEqual(run["status"], "blocked")
        self.assertEqual(run["candidates"], [])
        self.assertEqual(run["reason_codes"], ["FUNDED_STUDY_REVIEWED_SOURCE_REQUIRED"])
        self.assertIsNone(run_pending_once(self.db, "core", clock=lambda: NOW))
        self.no_finance()

    def test_lease_takeover_cannot_commit_old_attempt_and_keeps_attempt_history(self):
        self.request(); job, old = self.claim("old", 1)
        prepared = prepare_funded_study_job(self.db, job, old, clock=lambda: NOW)
        later = "2026-01-02T12:00:06.000Z"
        winner_job, winner = self.claim("winner", 60, later)
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            complete_job(self.db, old, {}, effect=prepared["effect"], now=later)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_funded_study_runs").fetchone()[0], 0)
        latest = prepare_funded_study_job(self.db, winner_job, winner, clock=lambda: later)
        complete_job(self.db, winner, {}, effect=latest["effect"], now=later)
        self.assertEqual(self.db.execute("SELECT count(*) FROM job_attempts").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_funded_study_runs").fetchone()[0], 1)
        self.no_finance()

    def test_new_funding_before_commit_skips_instead_of_publishing_old_binding(self):
        self.request(); job, lease = self.claim()
        prepared = prepare_funded_study_job(self.db, job, lease, clock=lambda: NOW)
        self.save_funding()
        complete_job(self.db, lease, {}, effect=prepared["effect"], now=NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "skipped")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_funded_study_runs").fetchone()[0], 0)
        self.no_finance()

    def test_restore_lock_created_during_commit_rolls_back_run_and_workspace_revision(self):
        self.request(); job, lease = self.claim()
        prepared = prepare_funded_study_job(self.db, job, lease, clock=lambda: NOW)
        before = self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0]
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        def effect(db):
            result = prepared["effect"](db)
            marker.write_text("FICTIONAL RECOVERY LOCK\n")
            return result
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            complete_job(self.db, lease, {}, effect=effect, now=NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_funded_study_runs").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], before)

    def test_stop_keeps_request_and_failed_attempt_without_reclassifying_as_success(self):
        self.request(); sync_funded_study_requests(self.db, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            run_one(self.db, "stop", command_handler(self.db, clock=lambda: NOW, stop_requested=lambda: True), job_type=JOB_TYPE, clock=lambda: NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "retry_queued")
        self.assertEqual(self.db.execute("SELECT status FROM job_attempts").fetchone()[0], "failed")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_funded_study_requests").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_funded_study_runs").fetchone()[0], 0)
        self.no_finance()

    def test_provider_worker_cannot_claim_or_run_comparison_and_implementation_change_skips_commit(self):
        self.request(); sync_funded_study_requests(self.db, now=NOW)
        self.assertIsNone(run_pending_once(self.db, "provider", role="longport", lease_seconds=180, clock=lambda: NOW))
        job, lease = self.claim()
        with self.assertRaisesRegex(WorkbenchError, "JOB_REQUIRES_DIFFERENT_WORKER_ROLE"):
            command_handler(self.db, role="longport")(job, lease)
        with patch("worker.investor.funded_study_runtime.implementation_hash", side_effect=["a" * 64, "b" * 64]):
            prepared = prepare_funded_study_job(self.db, job, lease, clock=lambda: NOW)
            complete_job(self.db, lease, {}, effect=prepared["effect"], now=NOW)
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "skipped")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_funded_study_runs").fetchone()[0], 0)
        self.no_finance()


if __name__ == "__main__":
    unittest.main()
