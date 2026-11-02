"""Later v5 maintenance recovery must not deadlock behind stale model prices."""

import json
import unittest
from unittest.mock import patch

from tests.investor import test_legacy_transition_source as fixture, test_managed_actions as managed_fixture
from tests.investor import action_reconciliation_fixture as source_fixture
from tests.investor.test_reviewed_action_successor import UpdatedCollector
from tests.market.test_vanguard_distributions import archive, row
from tests.investor.confirmed_capture_fixture import FictionalReceiver
from worker.investor import confirmed_capture, confirmed_feed, eodhd_sources, legacy_transition_source as bridge, managed_actions, monitor_admission, monitor_data
from worker.investor.data_evidence import _fact_validation_scope
from worker.investor.action_checkpoint_replay import checkpoint_action_review
from worker.market.providers import longport_confirmed
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, open_database
from worker.orchestration.runtime import run_pending_once


FIRST = "2026-11-04T06:00:03.000Z"
SECOND = "2026-11-05T06:00:03.000Z"
LISTEN = "2026-11-05T19:58:00.000Z"
RECEIVED = "2026-11-05T20:01:02.000Z"
NEXT = "2026-11-06T06:00:03.000Z"


class LegacyTransitionContinuationTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.LegacyTransitionSourceTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.db, self.at = self.case.db, self.case.at

    def publication(self, at):
        raw = archive(row("987.1234", exDividendDate="2026-09-25", recordDate="2026-09-25", payableDate="2026-09-30"),
            row("4.32109", exDividendDate="2026-11-02", recordDate="2026-11-02", payableDate="2026-11-09"))
        with patch.object(managed_fixture, "LATER", at), patch.object(source_fixture, "ActionCollector", UpdatedCollector), \
                patch.object(UpdatedCollector, "event_day", "2026-11-02"):
            self.case.case.case.next_source_day(issuer_raw=raw)
        results = managed_actions.publish_current_actions(self.db, now=at)
        self.assertEqual(len(results), 1); self.assertEqual(results[0]["status"], "published")
        return results[0]["publication_id"]

    def ready(self, *, publish=True, pause=True):
        # Explicit fictional holiday and absence assertion, not a real US calendar.
        self.case.prepare(completed=True, quote_ttl=151200, closed_dates=("2026-11-03", "2026-11-04"), bnd_coverage_end="2026-11-06"); self.case.admit()
        self.definition = self.case.case.definition; self.model_id = self.definition["model_id"]
        run_pending_once(self.db, "fictional-v5-first-core", clock=lambda: self.at)
        self.authority = self.case.case.confirmed["new_authority_id"]
        managed_actions.set_authority_enabled(self.db, "w", "synthetic-investor", self.authority, True, now=self.at)
        self.first_publication = self.publication(FIRST)
        self.assertTrue(confirmed_feed.refresh_monitor_sources(self.db, now=FIRST))
        run_pending_once(self.db, "fictional-v5-publication-core", clock=lambda: FIRST)
        self.seed = monitor_admission.latest_monitor_evidence(self.db, "w", self.model_id)
        self.document = json.loads(self.seed["document_json"])
        self.assertEqual(self.document["schema_version"], "investor-monitor-data-input-v5")
        self.assertIn(self.first_publication, [ref["review_id"] for segment in self.document["segments"] for ref in segment["snapshot"]["review_refs"]])
        if pause:
            self.pause()
            if publish: self.second_publication = self.publication(SECOND)

    def pause(self):
        managed_actions.set_authority_enabled(self.db, "w", "synthetic-investor", self.authority, False, now="2026-11-04T12:00:00.000Z")
        managed_actions.set_authority_enabled(self.db, "w", "synthetic-investor", self.authority, True, now="2026-11-04T12:00:01.000Z")

    def advance(self):
        original = {name: [list(row) for row in self.db.execute("SELECT rowid,* FROM " + name)] for name in
            ("investor_models", "investor_model_controls", "investor_evidence_model_checkpoints", "investor_evidence_checkpoint_payloads",
             "investor_confirmed_feed_requests", "investor_confirmed_feed_runs", "investor_confirmed_feed_admissions", "investor_confirmed_captures")}
        first_state = json.loads(original["investor_evidence_checkpoint_payloads"][0][-1])
        self.assertEqual(len(confirmed_feed.discover_confirmed_watches(self.db, now=LISTEN)), 1)
        self.assertEqual(confirmed_feed.discover_confirmed_watches(self.db, now=LISTEN), [])
        times = [LISTEN]; receiver = FictionalReceiver(now=LISTEN, received_at=RECEIVED, during=lambda: times.__setitem__(0, RECEIVED))
        millis, parse_time = confirmed_capture._milliseconds, confirmed_capture.instant
        with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=lambda request, **kwargs: receiver(request, kwargs["stop_requested"])), \
                patch.object(confirmed_capture, "_milliseconds", side_effect=lambda value=None: millis(times[0] if value is None else value)), \
                patch.object(confirmed_capture, "instant", side_effect=lambda value=None: parse_time(times[0] if value is None else value)):
            result = run_pending_once(self.db, "fictional-later-v5-listener", role="longport", clock=lambda: times[0])
        self.assertEqual(result["status"], "succeeded"); self.assertEqual(receiver.calls, 1)
        self.assertEqual((result["attempt_count"], result["max_attempts"]), (1, 1))
        confirmed_feed.admit_completed_feeds(self.db, now=RECEIVED)
        blocked = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_confirmed_feed_admissions ORDER BY rowid")]
        self.assertEqual(blocked[-1][5], "blocked")
        self.assertEqual(monitor_admission.latest_monitor_evidence(self.db, "w", self.model_id)["id"], self.seed["id"])
        self.publication(NEXT)
        for _ in range(6):
            run_pending_once(self.db, "fictional-later-v5-core", clock=lambda: NEXT)
            source = monitor_admission.latest_monitor_evidence(self.db, "w", self.model_id)
            checkpoint = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1").fetchone()
            if source["id"] != self.seed["id"] and checkpoint["input_id"] == source["id"]: break
        else: self.fail("FICTIONAL_LATER_V5_CHECKPOINT_NOT_ADVANCED")
        document = json.loads(source["document_json"])
        current = monitor_data.resolve_monitor_data(self.db, "w", self.definition, document, now=NEXT)
        self.assertEqual(document["schema_version"], "investor-monitor-data-input-v5"); self.assertIsNone(current["unavailable_reason"])
        self.assertEqual(current["projection"]["quality_gaps"], [])
        self.assertEqual({item["observed_at"] for item in current["projection"]["quotes"]}, {"2026-11-05T20:00:00.000Z"})
        payload = json.loads(self.db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?", (checkpoint["id"],)).fetchone()[0])
        self.assertEqual(payload["initialized_at"], first_state["initialized_at"])
        self.assertEqual({key: payload["processed_actions"][key] for key in first_state["processed_actions"]}, first_state["processed_actions"])
        for name, rows in original.items():
            actual = [list(row) for row in self.db.execute("SELECT rowid,* FROM " + name + " ORDER BY rowid")]
            self.assertEqual(actual if name in ("investor_models", "investor_model_controls") else actual[:len(rows)], rows, name)
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_confirmed_feed_admissions ORDER BY rowid")], blocked)
        self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=NEXT), [])
        self.case.case.case.assert_no_finance()
        return source, checkpoint

    def test_later_qualified_publication_and_stale_quotes_allow_only_readonly_listener_metadata(self):
        self.ready()
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, "w", self.definition, self.document, now=LISTEN)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=LISTEN), [])
        before = list(self.db.iterdump())
        context = confirmed_feed._seed(self.db, "w", self.model_id, self.seed["id"], LISTEN)
        self.assertTrue(context[6]["source_only"]); self.assertIsNone(context[6]["projection"])
        self.assertEqual(set(context[6]["catalog"]), {target["listing_id"] for target in self.definition["targets"]})
        self.assertIsNone(checkpoint_action_review(self.db, "w", self.first_publication, "actions", LISTEN))
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, "w", self.definition, self.document, now=LISTEN)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.assertEqual(before, list(self.db.iterdump())); self.case.case.case.assert_no_finance()

    def test_one_later_watch_and_default_core_resume_the_same_v5_model_without_replaying_prior_attempts(self):
        self.ready(); self.advance()

    def test_no_qualified_publication_and_withdrawn_provider_cannot_be_hidden_by_listener_scope(self):
        self.ready(publish=False)
        with self.assertRaises(WorkbenchError): confirmed_feed._seed(self.db, "w", self.model_id, self.seed["id"], LISTEN)
        self.assertIsNone(checkpoint_action_review(self.db, "w", self.first_publication, "actions", LISTEN))
        self.publication(SECOND)
        with patch.object(bridge, "compare_transition_monitor_data", side_effect=WorkbenchError("FICTIONAL_LISTENER_REPLAY_FAILURE")), \
                self.assertRaisesRegex(WorkbenchError, "FICTIONAL_LISTENER_REPLAY_FAILURE"):
            confirmed_feed._seed(self.db, "w", self.model_id, self.seed["id"], LISTEN)
        self.assertIsNone(checkpoint_action_review(self.db, "w", self.first_publication, "actions", LISTEN))
        with _fact_validation_scope():
            self.assertTrue(confirmed_feed._seed(self.db, "w", self.model_id, self.seed["id"], LISTEN)[6]["source_only"])
            other = open_database(self.case.case.case.path)
            try: eodhd_sources.set_authority_enabled(other, "w", "synthetic-investor", self.case.case.case.member["eodhd_authority_id"], False, now=LISTEN)
            finally: other.close()
            before = list(self.db.iterdump())
            with self.assertRaises(WorkbenchError): confirmed_feed._seed(self.db, "w", self.model_id, self.seed["id"], LISTEN)
            self.assertEqual(before, list(self.db.iterdump()))
        self.assertIsNone(checkpoint_action_review(self.db, "w", self.first_publication, "actions", LISTEN))

    def test_fully_resealed_old_projection_cannot_use_the_metadata_only_listener_branch(self):
        self.ready(); self.db.execute("SAVEPOINT fictional_listener_tamper")
        try:
            for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('investor_monitor_evidence_inputs','audit_events')").fetchall():
                self.db.execute('DROP TRIGGER "' + row[0] + '"')
            document = json.loads(self.seed["document_json"]); document["audited_projection_hash"] = "0" * 64; digest = content_hash(document)
            self.db.execute("UPDATE investor_monitor_evidence_inputs SET document_json=?,content_hash=? WHERE id=?", (canonical_json(document), digest, self.seed["id"]))
            self.db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json({"content_hash": digest}), self.seed["audit_id"]))
            with self.assertRaises(WorkbenchError): confirmed_feed._seed(self.db, "w", self.model_id, self.seed["id"], LISTEN)
            self.assertIsNone(checkpoint_action_review(self.db, "w", self.first_publication, "actions", LISTEN))
        finally: self.db.execute("ROLLBACK TO fictional_listener_tamper"); self.db.execute("RELEASE fictional_listener_tamper")
        readonly = open_database(self.case.case.case.path, read_only=True)
        try:
            context = confirmed_feed._seed(readonly, "w", self.model_id, self.seed["id"], LISTEN)
            self.assertTrue(context[6]["source_only"]); self.assertEqual(readonly.total_changes, 0)
        finally: readonly.close()


def continued_case(db, path, metadata=None):
    """Hydrate only fictional fixture state; every phase still runs real services."""
    from tests.investor.test_action_review_readmission import ActionReviewReadmissionTests
    from tests.investor.test_action_review_workflow import ActionReviewWorkflowTests
    case, source, readmission, review = LegacyTransitionContinuationTests(), fixture.LegacyTransitionSourceTests(), ActionReviewReadmissionTests(), ActionReviewWorkflowTests()
    case.db = source.db = readmission.db = review.db = db
    case.case, source.case, readmission.case = source, readmission, review
    case.at = source.at = "2026-11-03T06:00:04.002Z"; review.path, review.version = path, 0
    if metadata is not None:
        case.model_id, case.authority, case.first_publication = (metadata[key] for key in ("model_id", "authority", "first_publication"))
        case.definition = json.loads(db.execute("SELECT document_json FROM investor_models WHERE id=? AND workspace_id='w'", (case.model_id,)).fetchone()[0])
        case.seed = db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id='w'", (metadata["seed_id"],)).fetchone()
        case.document = json.loads(case.seed["document_json"]); review.member = metadata["member"]
    return case


if __name__ == "__main__": unittest.main()
