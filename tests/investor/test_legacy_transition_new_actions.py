"""A later explicitly reviewed event must continue the same admitted v5 model."""

from hashlib import sha256
import json
import unittest
from unittest.mock import patch

from tests.investor import action_reconciliation_fixture as sources, test_managed_actions as managed_fixture
from tests.investor import test_legacy_transition_continuation as continuation
from tests.market.test_eodhd_actions import archive as div_archive, dividend
from tests.market.test_vanguard_distributions import archive, row
from worker.investor import action_review_jobs as jobs, action_review_workflow as review, confirmed_feed, managed_actions
from worker.investor import issuer_schedule, monitor_admission, monitor_data
from worker.market.providers.eodhd_actions import parse_eodhd_actions
from worker.orchestration.db import instant, open_database
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import run_pending_once


REPORT = continuation.NEXT
PREVIEW = "2026-11-06T06:00:03.001Z"
CONFIRM = "2026-11-06T06:00:04.001Z"


class NextCollector(sources.ActionCollector):
    def __call__(self, **options):
        result = super().__call__(**options)
        if options["symbol"] == "VT.US" and options["kind"] == "div":
            raw = div_archive(dividend("987.123", date="2026-09-25", declarationDate="2026-09-20", recordDate="2026-09-25", paymentDate="2026-09-30"),
                dividend("4.321", date="2026-11-02", recordDate="2026-11-02", paymentDate="2026-11-09"),
                dividend("4", date="2026-11-05", recordDate="2026-11-05", paymentDate="2026-11-12"))
            result["raw"] = raw; result["receipt"].update(raw_sha256=sha256(raw).hexdigest(), raw_bytes=len(raw))
            result["draft"] = parse_eodhd_actions(raw, **{key: options[key] for key in ("kind", "symbol", "start_date", "end_date")}, retrieved_at=REPORT)
        return result


class LegacyTransitionNewActionTests(unittest.TestCase):
    def setUp(self):
        self.case = continuation.LegacyTransitionContinuationTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.db = self.case.db

    def ready(self):
        self.case.ready(pause=False)
        self.model_id, self.definition = self.case.model_id, self.case.definition
        self.original = {name: [list(row) for row in self.db.execute("SELECT rowid,* FROM " + name + " ORDER BY rowid")] for name in
            ("investor_models", "investor_model_controls", "investor_monitor_evidence_inputs", "investor_evidence_model_checkpoints",
             "investor_evidence_checkpoint_payloads", "investor_confirmed_feed_requests", "investor_confirmed_feed_runs", "investor_confirmed_captures")}
        self.prior = json.loads(self.original["investor_evidence_checkpoint_payloads"][-1][-1])

    def capture(self):
        from worker.investor import confirmed_capture
        from worker.market.providers import longport_confirmed
        from tests.investor.confirmed_capture_fixture import FictionalReceiver
        start, end = continuation.LISTEN, continuation.RECEIVED
        self.assertEqual(len(confirmed_feed.discover_confirmed_watches(self.db, now=start)), 1)
        times = [start]; receiver = FictionalReceiver(now=start, received_at=end, during=lambda: times.__setitem__(0, end))
        millis, parse_time = confirmed_capture._milliseconds, confirmed_capture.instant
        with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=lambda request, **kwargs: receiver(request, kwargs["stop_requested"])), \
                patch.object(confirmed_capture, "_milliseconds", side_effect=lambda value=None: millis(times[0] if value is None else value)), \
                patch.object(confirmed_capture, "instant", side_effect=lambda value=None: parse_time(times[0] if value is None else value)):
            result = run_pending_once(self.db, "fictional-v5-new-event-listener", role="longport", clock=lambda: times[0])
        self.assertEqual((result["status"], result["attempt_count"], result["max_attempts"], receiver.calls), ("succeeded", 1, 1, 1))
        confirmed_feed.admit_completed_feeds(self.db, now=end)
        self.admissions = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_confirmed_feed_admissions ORDER BY rowid")]
        self.assertEqual(self.admissions[-1][5], "blocked")

    def reports(self):
        pending = self.db.execute("SELECT * FROM job_runs WHERE job_type=? AND status='queued'", (issuer_schedule.JOB_TYPE,)).fetchall()
        self.assertEqual(len(pending), 1); self.assertEqual(instant(pending[0]["created_at"]), instant(continuation.LISTEN))
        with patch.object(issuer_schedule.sources.receiver, "collect_vanguard_distribution_draft", side_effect=AssertionError("NO_EXPIRED_ISSUER_REQUEST")):
            expired = run_one(self.db, "fictional-expired-issuer", lambda job, lease: issuer_schedule.prepare_issuer_capture(
                self.db, job, lease, clock=lambda: REPORT), job_type=issuer_schedule.JOB_TYPE, lease_seconds=180, clock=lambda: REPORT)
        self.assertEqual((expired["id"], expired["status"], expired["attempt_count"]), (pending[0]["id"], "skipped", 1))
        raw = archive(row("987.1234", exDividendDate="2026-09-25", recordDate="2026-09-25", payableDate="2026-09-30"),
            row("4.32109", exDividendDate="2026-11-02", recordDate="2026-11-02", payableDate="2026-11-09"),
            row("4.00009", exDividendDate="2026-11-05", recordDate="2026-11-05", payableDate="2026-11-12"))
        with patch.object(managed_fixture, "LATER", REPORT), patch.object(sources, "ActionCollector", NextCollector):
            self.case.case.case.case.next_source_day(issuer_raw=raw)
        published = managed_actions.publish_current_actions(self.db, now=REPORT)
        self.assertEqual(len(published), 1); self.assertEqual(published[0]["status"], "blocked")
        self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=REPORT), [])
        self.assertEqual(monitor_admission.latest_monitor_evidence(self.db, "w", self.model_id)["id"], self.case.seed["id"])
        self.settle(REPORT)

    def settle(self, at):
        for _ in range(8):
            if run_pending_once(self.db, "fictional-v5-new-event-core", clock=lambda: at) is None: return
        self.fail("FICTIONAL_CORE_DID_NOT_SETTLE")

    def job(self, kind, body, at):
        request = jobs.enqueue_action_review_request(self.db, "w", "synthetic-investor", kind, body, now=at)
        for _ in range(8):
            run_pending_once(self.db, "fictional-v5-new-event-core", clock=lambda: at)
            result = self.db.execute("SELECT document_json FROM investor_action_review_job_results WHERE request_id=?", (request["request_id"],)).fetchone()
            if result is not None: return request, json.loads(result[0])
        self.fail("FICTIONAL_REVIEW_JOB_DID_NOT_FINISH")

    def answers(self, witness, *, enable_rule=False):
        return {"schema_version": "investor-action-review-submit-v1", "preview_id": witness["preview_id"],
            "expected_revision": witness["workspace_revision"], "idempotency_key": "fictional-v5-next-event-confirmation", "enable_rule": enable_rule,
            "new_events": [{"type": "dividend", "date": "2026-11-05", "at": "2026-11-05T14:30:00Z", "pay_at": "2026-11-12T21:00:00Z", "tax_per_unit": "0.4"}],
            "acknowledgements": {key: True for key in ("issuer_amount_unit_and_currency", "reported_differences_seen", "explicit_research_instants",
                "explicit_tax_amounts", "unchanged_tax_assumption_applies", "reported_coverage_not_objective_absence", "no_historical_restatement", "register_new_default_off_rule")}}

    def confirm(self, *, enable_rule=False):
        revision = self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
        _, result = self.job("preview", {"authority_id": self.case.authority, "expected_revision": revision,
            "idempotency_key": "fictional-v5-next-event-preview"}, PREVIEW)
        self.assertEqual(result["outcome"], "preview_ready")
        witness = review._preview_header(self.db, "w", "synthetic-investor", result["resource_id"])[1]
        body = self.answers(witness, enable_rule=enable_rule)
        request, result = self.job("confirmation", body, CONFIRM)
        self.assertEqual(result["outcome"], "confirmed")
        self.confirmed = review.resolve_action_review_confirmation(self.db, "w", "synthetic-investor", result["resource_id"], now=CONFIRM)
        self.assertIs(self.confirmed["request"]["enable_rule"], enable_rule)
        control = self.db.execute("SELECT enabled FROM investor_action_controls WHERE id=?", (self.confirmed["new_control_id"],)).fetchone()
        self.assertEqual(control[0], int(enable_rule))
        self.assertEqual(jobs.enqueue_action_review_request(self.db, "w", "synthetic-investor", "confirmation", body, now=CONFIRM), request)

    def advanced(self):
        self.settle(CONFIRM)
        source = monitor_admission.latest_monitor_evidence(self.db, "w", self.model_id)
        self.assertNotEqual(source["id"], self.case.seed["id"])
        document = json.loads(source["document_json"])
        current = monitor_data.resolve_monitor_data(self.db, "w", self.definition, document, now=CONFIRM)
        self.assertEqual(document["schema_version"], "investor-monitor-data-input-v5"); self.assertIsNone(current["unavailable_reason"])
        self.assertEqual(current["projection"]["quality_gaps"], [])
        checkpoint = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1").fetchone()
        self.assertEqual(checkpoint["input_id"], source["id"])
        state = json.loads(self.db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?", (checkpoint["id"],)).fetchone()[0])
        self.assertEqual(state["initialized_at"], self.prior["initialized_at"])
        for key, value in self.prior["processed_actions"].items(): self.assertEqual(state["processed_actions"][key], value)
        new_event = self.confirmed["request"]["new_events"][0]
        actions = [item for item in current["projection"]["corporate_actions"] if item["effective_at"] == "2026-11-05T14:30:00.000Z"]
        self.assertEqual(len(actions), 1); self.assertEqual(actions[0]["known_at"], CONFIRM)
        self.assertIn(actions[0]["id"], state["processed_actions"]); self.assertEqual(new_event["tax_per_unit"], "0.4")
        self.assertGreater(len(state["processed_actions"]), len(self.prior["processed_actions"]))
        self.assertEqual({item["observed_at"] for item in current["projection"]["quotes"]}, {"2026-11-05T20:00:00.000Z"})
        for name, rows in self.original.items():
            actual = [list(row) for row in self.db.execute("SELECT rowid,* FROM " + name + " ORDER BY rowid")]
            self.assertEqual(actual[:len(rows)], rows, name)
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_confirmed_feed_admissions ORDER BY rowid")], self.admissions)
        self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=CONFIRM), [])
        self.case.case.case.case.assert_no_finance()
        return source, checkpoint

    def test_a_second_explicit_review_job_continues_existing_v5_with_actual_new_knowledge_and_no_history_reset(self):
        from worker.investor import eodhd_sources
        self.ready(); self.capture(); self.reports(); self.confirm(enable_rule=True); source, _ = self.advanced()
        other = open_database(self.case.case.case.case.path)
        try: eodhd_sources.set_authority_enabled(other, "w", "synthetic-investor", self.case.case.case.case.member["eodhd_authority_id"], False, now=CONFIRM)
        finally: other.close()
        before = list(self.db.iterdump())
        withdrawn = monitor_data.resolve_monitor_data(self.db, "w", self.definition, json.loads(source["document_json"]), now=CONFIRM)
        self.assertIsNone(withdrawn["projection"]); self.assertIsNotNone(withdrawn["unavailable_reason"])
        self.assertEqual(before, list(self.db.iterdump())); self.case.case.case.case.assert_no_finance()


def new_action_case(db, path, metadata=None):
    case = LegacyTransitionNewActionTests(); case.db = db
    case.case = continuation.continued_case(db, path, metadata)
    if metadata is not None:
        case.model_id, case.definition = case.case.model_id, case.case.definition
    return case


if __name__ == "__main__": unittest.main()
