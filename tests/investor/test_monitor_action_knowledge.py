"""Versioned retained-source monitor knowledge; fictional SDK/HTTPS substitutes only."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import test_managed_actions as managed_fixture
from tests.investor import test_monitor_data as fixture, test_confirmed_feed as feed_fixture
from tests.investor.monitor_data_fixture import late_action_receipts
from worker.investor import managed_actions
from worker.investor.data_evidence import resolve_review
from worker.investor.data_snapshot import build_dataset, build_audited_monitor_dataset
from worker.investor.monitor_action_knowledge import _availability_refs, index_availability, validate_monitor_source_dataset
from worker.investor.monitor_data import build_monitor_data, resolve_monitor_data
from worker.investor.model_state import advance_evidence_model
from worker.investor import monitor_admission
from worker.orchestration.db import WorkbenchError, content_hash, open_database
from worker.orchestration.runtime import run_pending_once
from worker.research.snapshot import validate_dataset


class MonitorActionKnowledgeTests(unittest.TestCase):
    setUp = fixture.InvestorMonitorDataTests.setUp
    reviewed = fixture.InvestorMonitorDataTests.reviewed
    workspace_id = "w"
    assert_no_finance = fixture.InvestorMonitorDataTests.assert_no_finance
    fixture = fixture.InvestorMonitorDataTests.fixture

    def prepare(self, *, late=True, confirmed=False):
        self.definition, self.windows, self.settings, self.refs = self.fixture(markets=("CN",), events=True, confirmed_latest=confirmed)
        if late: late_action_receipts(self.db, "w", self.windows, self.refs)

    def build(self, **options):
        return build_monitor_data(self.db, "w", self.definition, self.windows, self.settings, now=fixture.NOW,
            audited_action_knowledge=True, **options)

    def source(self):
        window = self.windows[0]
        return build_audited_monitor_dataset(self.db, "w", window["capture_ids"], window.get("confirmed_capture_ids", []),
            window["action_review_ids"], window["fx_review_ids"], window["start_date"], window["end_date"], now=fixture.NOW)

    def test_late_receipts_build_a_distinct_monitor_dataset_not_backdated_research(self):
        self.prepare(); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "CORPORATE_ACTION_NOT_KNOWN_AT_EVENT"):
            build_monitor_data(self.db, "w", self.definition, self.windows, self.settings, now=fixture.NOW)
        result, source = self.build(), self.source()
        self.assertEqual(result["document"]["schema_version"], "investor-monitor-data-input-v4")
        self.assertEqual(result["projection"]["schema_version"], "investor-monitor-data-projection-v2")
        self.assertEqual(source["dataset"]["schema_version"], "investor-monitor-source-dataset-v1")
        self.assertEqual({row["known_at"] for row in result["projection"]["corporate_actions"]}, {fixture.NOW})
        self.assertEqual({row["fact"]["published_at"] for row in source["dataset"]["reviewed_actions"]}, {fixture.NOW})
        with self.assertRaises(ValueError): validate_dataset(source["dataset"])
        with self.assertRaisesRegex(WorkbenchError, "CORPORATE_ACTION_NOT_KNOWN_AT_EVENT"):
            window = self.windows[0]
            build_dataset(self.db, "w", window["capture_ids"], window["action_review_ids"], [], window["start_date"], window["end_date"], now=fixture.NOW)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_legacy_projection_remains_exact_and_opt_in_does_not_rewrite_it(self):
        self.prepare(late=False)
        old = build_monitor_data(self.db, "w", self.definition, self.windows, self.settings, now=fixture.NOW)
        original = deepcopy(old); modern = self.build()
        self.assertNotEqual(modern["content_hash"], old["content_hash"])
        self.assertEqual(resolve_monitor_data(self.db, "w", self.definition, old["document"], now=fixture.NOW)["projection"], original["projection"])
        self.assertEqual(old, original); self.assert_no_finance()

    def test_current_snapshot_replay_including_confirmed_receipt_is_readonly(self):
        self.prepare(confirmed=True); value = self.build(); before = list(self.db.iterdump())
        reader = open_database(self.path, read_only=True)
        try:
            replay = resolve_monitor_data(reader, "w", self.definition, value["document"], now=fixture.NOW)
            self.assertEqual(replay["projection"], value["projection"]); self.assertEqual(reader.total_changes, 0)
        finally: reader.close()
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_forged_origin_or_earlier_known_time_cannot_survive_normal_replay(self):
        self.prepare(); value = self.build(); before = list(self.db.iterdump())
        for key, replacement in (("original_review_id", "fictional-forged-review"), ("original_review_hash", "0" * 64), ("known_at", "2025-12-01T00:00:00Z")):
            document = deepcopy(value["document"]); document["segments"][0]["snapshot"]["action_availability_refs"][0][key] = replacement
            with self.subTest(field=key), self.assertRaises(ValueError):
                resolve_monitor_data(self.db, "w", self.definition, document, now=fixture.NOW)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_extra_or_missing_availability_is_not_an_absence_assumption(self):
        self.prepare(); review = resolve_review(self.db, "w", self.refs[0]["actions"]["id"], "actions", now=fixture.NOW)
        refs = self.source()["manifest"]["action_availability_refs"]
        for modified in (refs[:-1], refs + [refs[0]]):
            with self.assertRaises(WorkbenchError): index_availability([review], modified, fixture.NOW)

    def test_submicrosecond_or_future_knowledge_cannot_be_rounded_into_admission(self):
        self.prepare(); dataset = self.source()["dataset"]
        for known in ("2026-01-03T12:00:03.0000001Z", "2026-01-03T12:00:03.000001Z", "2026-01-03"):
            value = deepcopy(dataset); value["reviewed_actions"][0]["availability"]["known_at"] = known
            with self.subTest(known=known), self.assertRaises(ValueError): validate_monitor_source_dataset(value)

    def test_tax_and_payment_semantics_do_not_disappear_in_monitor_only_mode(self):
        self.prepare(); dataset = self.source()["dataset"]
        for key, replacement in (("tax_per_unit", "-0.1"), ("tax_per_unit", "2"), ("pay_at", "2025-12-01T00:00:00Z")):
            value = deepcopy(dataset); entry = value["reviewed_actions"][0]; entry["fact"][key] = replacement
            entry["availability"]["event_hash"] = content_hash(entry["fact"])
            with self.assertRaises(ValueError): validate_monitor_source_dataset(value)

    def test_first_bootstrap_known_after_event_has_no_pre_entry_dividend_or_split(self):
        self.prepare(); projection = self.build()["projection"]
        value = advance_evidence_model(self.definition, projection, None, fixture.NOW, input_hash="a" * 64)
        self.assertIsNotNone(value["checkpoint"]); self.assertEqual(value["checkpoint"]["entitlements"], {})
        self.assertEqual(value["checkpoint"]["receivables"], []); self.assertEqual(len(value["checkpoint"]["processed_actions"]), 3)
        self.assertEqual(value["assessment"]["model_nav_cny"], "10000"); self.assert_no_finance()

    def test_unknown_quote_or_input_injection_is_not_filled_by_the_action_protocol(self):
        self.prepare()
        self.settings["max_quote_age_seconds"] = 1
        value = self.build()
        self.assertEqual(value["projection"]["quotes"], []); self.assertIn("MONITOR_PRICE_EXPIRED_CN", value["projection"]["quality_gaps"])
        self.settings["quotes"] = [{"close": "fictional-injected-price"}]
        with self.assertRaises(ValueError): self.build()

    def test_original_preview_protocol_flag_cannot_be_an_integer_or_string(self):
        self.prepare()
        for flag in (1, "yes"):
            with self.assertRaises(WorkbenchError):
                build_monitor_data(self.db, "w", self.definition, self.windows, self.settings, now=fixture.NOW, audited_action_knowledge=flag)


class ManagedActionKnowledgeTests(unittest.TestCase):
    setUp = managed_fixture.ManagedActionTests.setUp
    prepare = managed_fixture.ManagedActionTests.prepare
    policy = managed_fixture.ManagedActionTests.policy
    grant = managed_fixture.ManagedActionTests.grant
    next_source_day = managed_fixture.ManagedActionTests.next_source_day
    assert_no_finance = managed_fixture.ManagedActionTests.assert_no_finance

    def test_two_full_raw_publications_keep_original_event_review_time(self):
        self.prepare(); self.grant(); first = managed_actions.publish_current_actions(self.db, now=managed_fixture.AT)[0]
        old = managed_actions.resolve_managed_review(self.db, "w", first["publication_id"], now=managed_fixture.AT)
        before = _availability_refs(self.db, "w", [old], managed_fixture.AT, managed_fixture.AT)
        self.next_source_day(); second = managed_actions.publish_current_actions(self.db, now=managed_fixture.LATER)[0]
        new = managed_actions.resolve_managed_review(self.db, "w", second["publication_id"], now=managed_fixture.LATER)
        unchanged = list(self.db.iterdump())
        after = _availability_refs(self.db, "w", [new], managed_fixture.LATER, managed_fixture.LATER)
        self.assertNotEqual(old["review"]["created_at"], new["review"]["created_at"])
        self.assertEqual(before[0]["known_at"], after[0]["known_at"]); self.assertEqual(after[0]["known_at"], self.base["created_at"])
        self.assertEqual(before[0]["event_hash"], after[0]["event_hash"])
        self.assertNotEqual(before[0]["review_id"], after[0]["review_id"])
        self.assertEqual(after[0]["original_review_id"], self.base["id"])
        self.assertEqual(unchanged, list(self.db.iterdump())); self.assert_no_finance()


class ConfirmedFeedKnowledgeTests(unittest.TestCase):
    setUp = feed_fixture.ConfirmedFeedTests.setUp
    assert_no_finance = feed_fixture.ConfirmedFeedTests.assert_no_finance
    monitor_fixture = feed_fixture.ConfirmedFeedTests.monitor_fixture
    model = feed_fixture.ConfirmedFeedTests.model
    watch = feed_fixture.ConfirmedFeedTests.watch

    def test_next_ordinary_confirmed_feed_preserves_the_explicit_seed_protocol(self):
        original = monitor_admission.admit_monitor_data
        # Choose the new producer protocol only while constructing the fixture;
        # normal feed selection, source checks and worker commits are unpatched.
        def seed_v4(*args, **options):
            return original(*args, **{**options, "audited_action_knowledge": True})
        with patch.object(monitor_admission, "admit_monitor_data", side_effect=seed_v4): self.model()
        original_seed = dict(self.seed); self.assertEqual(json.loads(self.seed["document_json"])["schema_version"], "investor-monitor-data-input-v4")
        result, calls, _ = self.watch()
        self.assertEqual((result["status"], calls), ("succeeded", 1))
        self.assertEqual(run_pending_once(self.db, "fictional-v4-core", clock=lambda: feed_fixture.END)["status"], "succeeded")
        admission = self.db.execute("SELECT * FROM investor_confirmed_feed_admissions").fetchone()
        self.assertEqual(admission["status"], "admitted")
        row = self.db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=?", (admission["input_id"],)).fetchone()
        document = json.loads(row["document_json"])
        self.assertEqual(document["schema_version"], "investor-monitor-data-input-v4")
        self.assertEqual(document["segments"][0]["snapshot"]["schema_version"], "investor-monitor-source-snapshot-v2")
        self.assertIsNone(resolve_monitor_data(self.db, "w", self.definition, document, now=feed_fixture.END)["unavailable_reason"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 2)
        self.assertEqual(dict(self.db.execute("SELECT * FROM investor_monitor_evidence_inputs WHERE id=?", (self.seed["id"],)).fetchone()), original_seed)
        self.assert_no_finance()


if __name__ == "__main__": unittest.main()
