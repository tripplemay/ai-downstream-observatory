"""The isolated real-clock journey fixture must use real evidence services."""

from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from tests.investor import current_action_fixture as fixture
from worker.investor import action_review_jobs as jobs, action_review_workflow as review
from worker.orchestration.db import ROOT, open_database
from worker.orchestration.runtime import run_pending_once


class CurrentActionFixtureTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix="etf-investor-synthetic-"); self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "workbench.db"
        result = subprocess.run(["node", "scripts/migrate-workbench.mjs", "--db", str(self.path)], cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.db = open_database(self.path); self.addCleanup(self.db.close)
        self.enterContext(patch("socket.create_connection", side_effect=AssertionError("NO_NETWORK")))
        self.enterContext(patch("socket.getaddrinfo", side_effect=AssertionError("NO_DNS")))
        self.enterContext(patch("worker.market.providers.eodhd_capture.read_private_token", side_effect=AssertionError("NO_CREDENTIAL_READ")))
        self.enterContext(patch("worker.market.providers.longport.read_private_credentials_file", side_effect=AssertionError("NO_CREDENTIAL_READ")))

    def test_owner_bound_current_reports_support_real_preview_and_explicit_confirmation_without_market_or_account_facts(self):
        import json
        at = "2026-11-06T06:00:03.000Z"
        baseline = fixture.prepare(self.db, at); self.assertEqual(baseline["source_calls"], {"issuer": 1, "eodhd": 4})
        current = fixture.reports(self.db, at); self.assertEqual(current["source_calls"], {"issuer": 1, "eodhd": 4})
        authority = self.db.execute("SELECT id FROM investor_action_authorities").fetchone()[0]
        request = jobs.enqueue_action_review_request(self.db, "w", "owner", "preview", {"authority_id": authority,
            "expected_revision": 0, "idempotency_key": "fictional-current-preview"}, now=at)
        result = run_pending_once(self.db, "fictional-current-owner", clock=lambda: at)
        self.assertEqual(result["status"], "succeeded")
        row = self.db.execute("SELECT document_json FROM investor_action_review_job_results WHERE request_id=?", (request["request_id"],)).fetchone()
        done = json.loads(row[0]); self.assertEqual(done["outcome"], "preview_ready")
        visible = review.resolve_action_review_preview(self.db, "w", "owner", done["resource_id"], now=at)
        preview = visible["preview"]; self.assertFalse(preview["approval_performed"])
        body = {"schema_version": "investor-action-review-submit-v1", "preview_id": preview["preview_id"],
            "expected_revision": preview["workspace_revision"], "idempotency_key": "fictional-current-confirmation", "enable_rule": False,
            "new_events": [{"type": "dividend", "date": current["new_event_date"], "at": current["effective_at"],
                "pay_at": current["payment_at"], "tax_per_unit": "0.432109"}],
            "acknowledgements": {key: True for key in ("issuer_amount_unit_and_currency", "reported_differences_seen", "explicit_research_instants", "explicit_tax_amounts",
                "unchanged_tax_assumption_applies", "reported_coverage_not_objective_absence", "no_historical_restatement", "register_new_default_off_rule")}}
        request = jobs.enqueue_action_review_request(self.db, "w", "owner", "confirmation", body, now=at)
        result = run_pending_once(self.db, "fictional-current-owner", clock=lambda: at)
        self.assertEqual(result["status"], "succeeded")
        row = self.db.execute("SELECT document_json FROM investor_action_review_job_results WHERE request_id=?", (request["request_id"],)).fetchone()
        self.assertEqual(json.loads(row[0])["outcome"], "confirmed")
        for table in fixture.FINANCE: self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)

    def test_before_daily_authorized_window_does_not_start_current_report_transport(self):
        fixture.prepare(self.db, "2026-11-06T05:30:00.000Z")
        before = list(self.db.iterdump())
        with self.assertRaisesRegex(Exception, "REQUIRES_NY_AFTER_01"), patch.object(fixture, "collect", side_effect=AssertionError("NO_EARLY_COLLECTION")):
            fixture.reports(self.db, "2026-11-06T05:30:00.000Z")
        self.assertEqual(before, list(self.db.iterdump()))


if __name__ == "__main__": unittest.main()
