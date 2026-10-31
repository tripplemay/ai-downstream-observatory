"""Fictional FX standing permissions and real queue/lease boundaries, no HTTP."""

from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as runtime_fixtures
from tests.market.test_ecb_provider import xml
from worker.investor import managed_fx as fx
from worker.investor.data_evidence import resolve_review, review_source
from worker.orchestration.db import WorkbenchError, content_hash, open_database
from worker.orchestration.jobs import claim_job, run_one
from worker.orchestration.runtime import run_pending_once
from worker.investor.source_retention import purge_due_source_payloads
from worker.investor.monitor_bootstrap import _reviews


AT = "2026-01-03T12:00:03.000Z"
LATER = "2026-01-04T12:00:03.000Z"


def policy(**changes):
    return {"schema_version": "investor-fx-authority-v1", "provider": "ecb_90d_reference", "currencies": ["USD", "HKD"],
        "uses": ["private_research", "private_retention", "private_display", "private_backup"], "retention_days": 365,
        "valid_from": "2026-01-01T00:00:00.000Z", "valid_until": "2030-01-01T00:00:00.000Z",
        "clause_references": ["FICTIONAL owner standing source/derivation rule, not legal or provider certification"],
        "authorization_basis": "owner_reviewed_standing_rule_not_provider_certified", "cadence": "one_request_per_Europe_Berlin_day_after_01_00",
        "publication_rule": "append_only_concordant_with_overlap", "observation_policy": "rate_date_midnight_date_anchor_not_intraday_observation",
        "availability_policy": "next_calendar_day_midnight_Europe_Berlin", "human_review_per_publication": False, "trading_permission": False, **changes}


def rates(days=("2026-01-02", "2026-01-01"), cny="8"):
    return xml([(day, [("CNY", cny), ("USD", "2"), ("HKD", "10")]) for day in days])


class Collector:
    def __init__(self, raw=None, at=AT, during=None):
        self.raw = rates() if raw is None else raw
        self.at = at; self.during = during; self.calls = 0

    def __call__(self, **kwargs):
        self.calls += 1
        if self.during: self.during()
        receipt = {"source_url": fx.receiver.ecb.URLS[fx.receiver.FEED], "started_at": self.at, "completed_at": self.at,
            "retrieved_at": self.at, "http_status": 200, "headers": {"content-type": "application/xml", "content-length": str(len(self.raw))},
            "raw_sha256": sha256(self.raw).hexdigest(), "raw_bytes": len(self.raw), "redirects_followed": 0}
        return {"schema_version": fx.receiver.VERSION, "raw": self.raw, "receipt": receipt,
            "draft": fx.receiver.build_current_fx_draft(self.raw, retrieved_at=self.at, currencies=kwargs["currencies"])}


class ManagedFxTests(unittest.TestCase):
    setUp = runtime_fixtures.InvestorRuntimeTests.setUp
    assert_no_finance = runtime_fixtures.InvestorRuntimeTests.assert_no_finance

    def grant(self, doc=None, enabled=True, at=AT):
        row = fx.register_authority(self.db, "w", "synthetic-investor", doc or policy(), now=at)
        if enabled: fx.set_authority_enabled(self.db, "w", "synthetic-investor", row["id"], True, now=at)
        return row

    def run_capture(self, collector=None, at=AT):
        fx.discover_current_fx(self.db, now=at)
        collector = collector or Collector(at=at)
        with patch.object(fx.receiver, "collect_current_fx_draft", side_effect=collector):
            result = run_one(self.db, "fictional-fx-worker", lambda job, lease: fx.prepare_current_fx(self.db, job, lease, clock=lambda: at),
                job_type=fx.JOB_TYPE, lease_seconds=180, clock=lambda: at)
        return result, collector

    def count(self, table): return self.db.execute("SELECT count(*) FROM " + table).fetchone()[0]

    def latest_publication(self):
        row = self.db.execute("SELECT * FROM investor_fx_publications ORDER BY rowid DESC LIMIT 1").fetchone()
        return row, json.loads(row["document_json"])

    def test_disabled_by_default_normalized_idempotent_standing_rule_not_per_rate_human_review(self):
        original = policy(); copy = deepcopy(original)
        authority = self.grant(original, enabled=False)
        self.assertEqual(original, copy)
        self.assertEqual(fx.register_authority(self.db, "w", "synthetic-investor", original, now=AT)["id"], authority["id"])
        self.assertEqual(self.count("investor_fx_authorities"), 1)
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_fx_controls").fetchone()[0], 0)
        self.assertEqual(fx.discover_current_fx(self.db, now=AT), [])
        for table in ("investor_fx_requests", "job_runs", "investor_data_reviews"):
            self.assertEqual(self.count(table), 0)
        self.assert_no_finance()

    def test_fixed_queue_capture_to_separate_automatic_source_publication(self):
        authority = self.grant()
        job, collector = self.run_capture()
        self.assertEqual(job["status"], "succeeded", job)
        self.assertEqual(collector.calls, 1)
        self.assertEqual(self.count("investor_data_reviews"), 0)
        capture = self.db.execute("SELECT * FROM investor_fx_captures").fetchone()
        value = fx.resolve_capture(self.db, "w", capture["id"], now=AT)
        self.assertEqual(value["raw"], rates())
        self.assertFalse(value["receipt"]["owner_reviewed"])
        self.assertEqual(len(fx.publish_current_fx(self.db, now=AT)), 1)
        row, doc = self.latest_publication()
        self.assertEqual(doc["status"], "published")
        self.assertFalse(doc["human_review_performed"]); self.assertFalse(doc["trading_permission"])
        self.assertEqual(set(doc["refs"]), {"USD", "HKD"})
        for currency, ref in doc["refs"].items():
            value = resolve_review(self.db, "w", ref["review_id"], "fx", now=AT)
            self.assertEqual(value["facts"]["monitor_series"]["authority_id"], authority["id"])
            self.assertEqual(content_hash(value["facts"]), ref["facts_hash"])
        before = list(self.db.iterdump())
        self.assertEqual(fx.publish_current_fx(self.db, now=AT), [])
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertEqual(self.count("investor_models"), 0)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], 0)
        self.assert_no_finance()

    def test_next_day_appends_same_explicit_series_with_monotonic_head(self):
        authority = self.grant()
        self.run_capture(); fx.publish_current_fx(self.db, now=AT)
        first, first_doc = self.latest_publication()
        self.run_capture(Collector(rates(("2026-01-03", "2026-01-02", "2026-01-01")), LATER), at=LATER)
        fx.publish_current_fx(self.db, now=LATER)
        second, doc = self.latest_publication()
        self.assertEqual(doc["status"], "published")
        self.assertEqual((doc["sequence"], doc["previous_id"], doc["previous_hash"]), (2, first["id"], first["content_hash"]))
        for ref in first_doc["refs"].values():
            fx.validate_managed_review(self.db, "w", self.db.execute("SELECT * FROM investor_data_reviews WHERE id=?", (ref["review_id"],)).fetchone(),
                json.loads(self.db.execute("SELECT document_json FROM investor_data_reviews WHERE id=?", (ref["review_id"],)).fetchone()[0])["facts"], LATER)
        self.assertEqual(self.count("investor_fx_payloads"), 2)
        self.assert_no_finance()

    def test_default_provider_collects_and_core_publishes_but_wrong_roles_never_call_http(self):
        self.grant(); collector = Collector()
        with patch.object(fx.receiver, "collect_current_fx_draft", side_effect=collector):
            self.assertIsNone(run_pending_once(self.db, "fictional-core", role="core", clock=lambda: AT))
            self.assertIsNone(run_pending_once(self.db, "fictional-verifier", role="verifier", clock=lambda: AT))
            self.assertEqual(collector.calls, 0)
            result = run_pending_once(self.db, "fictional-provider", role="longport", lease_seconds=180, clock=lambda: AT)
            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(self.count("investor_fx_publications"), 0)
            self.assertIsNone(run_pending_once(self.db, "fictional-core", role="core", clock=lambda: AT))
        self.assertEqual(collector.calls, 1); self.assertEqual(self.count("investor_data_reviews"), 2)
        self.assert_no_finance()

    def test_global_daily_slot_and_second_connection_prevent_reissue_or_new_authority_bypass(self):
        grant = self.grant(); other = open_database(self.path); self.addCleanup(other.close)
        def during():
            self.assertFalse(self.db.in_transaction)
            self.assertEqual(len(fx.discover_current_fx(other, now=AT)), 0)
            self.assertEqual(other.execute("SELECT count(*) FROM investor_fx_requests").fetchone()[0], 1)
            other.execute("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('unrelated-fx','fixture','fixture','fixture','fixture','{}',?)", (AT,))
        result, collector = self.run_capture(Collector(during=during))
        self.assertEqual(result["status"], "succeeded"); self.assertEqual(collector.calls, 1)
        self.assertIsNone(self.run_capture(collector)[0]); self.assertEqual(collector.calls, 1)
        fx.set_authority_enabled(self.db, "w", "synthetic-investor", grant["id"], False, now=AT)
        self.grant(policy(clause_references=["FICTIONAL new declaration cannot reset the daily budget"]))
        self.assertEqual(fx.discover_current_fx(self.db, now=AT), [])
        self.assertEqual(self.count("investor_fx_requests"), 1)
        self.assert_no_finance()

    def test_unstarted_or_expired_job_does_not_automatically_retry_an_unknown_attempt(self):
        self.grant(); fx.discover_current_fx(self.db, now=AT)
        lease = claim_job(self.db, "fictional-interrupted", job_type=fx.JOB_TYPE, lease_seconds=1, now=AT)
        self.assertIsNotNone(lease)
        collector = Collector(at=LATER)
        with patch.object(fx.receiver, "collect_current_fx_draft", side_effect=collector):
            self.assertIsNone(run_one(self.db, "fictional-resumer", lambda *args: self.fail("Unknown attempt cannot be rerun"),
                job_type=fx.JOB_TYPE, clock=lambda: "2026-01-03T12:00:05.000Z"))
        self.assertEqual(collector.calls, 0)
        self.assertEqual(self.db.execute("SELECT status,max_attempts FROM job_runs").fetchone()["status"], "failed")
        self.assertEqual(fx.discover_current_fx(self.db, now=AT), [])
        self.assertEqual(self.count("investor_fx_captures"), 0)

    def test_berlin_midnight_gate_and_dst_daily_identity_are_not_utc_day_slots(self):
        self.grant(at="2026-01-02T12:00:03.000Z")
        self.assertEqual(fx.discover_current_fx(self.db, now="2026-01-02T23:59:59.000Z"), [])
        self.assertEqual(len(fx.discover_current_fx(self.db, now="2026-01-03T00:00:00.000Z")), 1)
        request = self.db.execute("SELECT * FROM investor_fx_requests").fetchone()
        self.assertEqual((request["feed_day"], request["valid_until"]), ("2026-01-03", "2026-01-03T23:00:00.000Z"))
        self.assertEqual(len(fx.discover_current_fx(self.db, now="2026-03-29T00:00:00.000Z")), 1)
        spring = self.db.execute("SELECT * FROM investor_fx_requests ORDER BY rowid DESC LIMIT 1").fetchone()
        self.assertEqual((spring["feed_day"], spring["valid_until"]), ("2026-03-29", "2026-03-29T22:00:00.000Z"))

    def test_identical_raw_is_deduplicated_and_unchanged_tail_does_not_refresh_review_or_dates(self):
        self.grant(); self.run_capture(); fx.publish_current_fx(self.db, now=AT)
        first, first_doc = self.latest_publication()
        self.run_capture(Collector(at=LATER), at=LATER); fx.publish_current_fx(self.db, now=LATER)
        row, doc = self.latest_publication()
        self.assertEqual(doc["status"], "unchanged"); self.assertEqual(doc["previous_id"], first["id"])
        self.assertEqual(doc["refs"], {})
        self.assertEqual(self.count("investor_fx_payloads"), 1); self.assertEqual(self.count("investor_fx_captures"), 2)
        self.assertEqual(self.count("investor_data_reviews"), 2)
        self.assertEqual({row["review"]["id"] for row in _reviews(self.db, "w", "fx", LATER)}, {ref["review_id"] for ref in first_doc["refs"].values()})

    def test_pending_capture_waits_for_original_assumed_availability_without_another_http_request(self):
        self.grant()
        at = "2026-01-03T17:00:00.000Z"
        result, collector = self.run_capture(Collector(rates(("2026-01-03", "2026-01-02")), at), at=at)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(fx.publish_current_fx(self.db, now=at), [])
        self.assertEqual(self.count("investor_data_reviews"), 0)
        self.assertEqual(len(fx.publish_current_fx(self.db, now="2026-01-03T23:00:00.000Z")), 1)
        self.assertEqual(collector.calls, 1)
        self.assertEqual(self.latest_publication()[1]["status"], "published")

    def test_restatement_quarantines_existing_head_and_prevents_future_automatic_calls(self):
        grant = self.grant(); self.run_capture(); fx.publish_current_fx(self.db, now=AT)
        _, first = self.latest_publication()
        self.run_capture(Collector(rates(("2026-01-03", "2026-01-02"), cny="9"), LATER), at=LATER)
        fx.publish_current_fx(self.db, now=LATER)
        _, blocked = self.latest_publication()
        self.assertEqual((blocked["status"], blocked["reason_code"]), ("blocked", "FX_SOURCE_RESTATEMENT"))
        ref = first["refs"]["USD"]
        self.assertEqual(fx.managed_review_unavailable(self.db, "w", ref["review_id"], LATER), "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        with self.assertRaisesRegex(WorkbenchError, "SOURCE_QUARANTINED"): resolve_review(self.db, "w", ref["review_id"], "fx", now=LATER)
        self.assertEqual(fx.discover_current_fx(self.db, now="2026-01-05T12:00:03.000Z"), [])
        with self.assertRaisesRegex(WorkbenchError, "SOURCE_QUARANTINED"): fx.set_authority_enabled(self.db, "w", "synthetic-investor", grant["id"], True, now=LATER)
        self.assertEqual(self.count("investor_data_reviews"), 2)

    def test_disable_during_io_cannot_store_a_price_payload_or_publish(self):
        grant = self.grant()
        collector = Collector(during=lambda: fx.set_authority_enabled(self.db, "w", "synthetic-investor", grant["id"], False, now=AT))
        result, _ = self.run_capture(collector)
        self.assertEqual(result["status"], "skipped"); self.assertEqual(collector.calls, 1)
        self.assertEqual(self.db.execute("SELECT status FROM investor_fx_captures").fetchone()[0], "superseded")
        self.assertEqual(self.count("investor_fx_payloads"), 0); self.assertEqual(fx.publish_current_fx(self.db, now=AT), [])

    def test_expired_lease_during_io_cannot_commit_payload_or_automatically_claim_again(self):
        self.grant(); other = open_database(self.path); self.addCleanup(other.close)
        def expired():
            other.execute("UPDATE job_runs SET lease_until='2026-01-03T12:00:02.000Z' WHERE job_type=? AND status='running'", (fx.JOB_TYPE,))
            self.assertIsNone(claim_job(other, "fictional-after-expiry", job_type=fx.JOB_TYPE, now=AT))
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            self.run_capture(Collector(during=expired))
        self.assertEqual(self.count("investor_fx_captures"), 0); self.assertEqual(self.count("investor_fx_payloads"), 0)
        self.assertEqual(fx.discover_current_fx(self.db, now=AT), [])
        self.assertEqual(self.db.execute("SELECT status FROM job_runs").fetchone()[0], "failed")

    def test_long_lived_head_does_not_overflow_legacy_review_candidate_limit(self):
        self.grant(); start = fx.instant(AT)
        for index in range(130):
            moment = start + timedelta(days=index); at = fx._clock(moment)
            days = [(moment - timedelta(days=offset)).date().isoformat() for offset in (1, 2)]
            result, _ = self.run_capture(Collector(rates(tuple(days)), at), at=at)
            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(len(fx.publish_current_fx(self.db, now=at)), 1)
        self.assertEqual(self.count("investor_data_reviews"), 260)
        selected = _reviews(self.db, "w", "fx", at)
        self.assertEqual(len(selected), 2)
        self.assertEqual({row["review"]["created_at"] for row in selected}, {at})
        self.assertEqual(self.latest_publication()[1]["sequence"], 130)
        self.assert_no_finance()

    def test_retention_purge_is_dedup_safe_and_authority_withdrawal_never_revives_old_receipts(self):
        grant = self.grant(); self.run_capture(); fx.publish_current_fx(self.db, now=AT)
        first_capture = self.db.execute("SELECT * FROM investor_fx_captures").fetchone()
        _, first = self.latest_publication()
        self.run_capture(Collector(at=LATER), at=LATER)
        fx.set_authority_enabled(self.db, "w", "synthetic-investor", grant["id"], False, now=LATER)
        one = purge_due_source_payloads(self.db, limit=1, now=LATER)
        self.assertEqual(len(one), 1); self.assertEqual(self.count("investor_fx_payloads"), 1)
        purge_due_source_payloads(self.db, limit=1, now=LATER)
        self.assertEqual(self.count("investor_fx_payloads"), 0); self.assertEqual(self.count("investor_fx_purges"), 2)
        fx.set_authority_enabled(self.db, "w", "synthetic-investor", grant["id"], True, now=LATER)
        with self.assertRaisesRegex(WorkbenchError, "PAYLOAD_PURGED"): fx.resolve_capture(self.db, "w", first_capture["id"], now=LATER)
        self.assertEqual(fx.managed_review_unavailable(self.db, "w", first["refs"]["USD"]["review_id"], LATER), "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.assertEqual(self.count("investor_models"), 0); self.assert_no_finance()

    def test_transport_failure_is_a_single_terminal_job_with_no_rates_or_review(self):
        self.grant()
        def failed(**kwargs): raise WorkbenchError("fictional sensitive native diagnostic")
        result, _ = self.run_capture(failed)
        self.assertEqual(result["status"], "failed")
        row = self.db.execute("SELECT * FROM investor_fx_captures").fetchone()
        self.assertEqual(row["status"], "transport_failed")
        self.assertNotIn("sensitive", row["document_json"])
        self.assertEqual(self.count("investor_fx_payloads"), 0); self.assertEqual(self.count("investor_data_reviews"), 0)
        self.assertEqual(fx.discover_current_fx(self.db, now=AT), [])

    def test_active_authorities_are_explicit_unique_and_never_external_ai_or_trading_grants(self):
        self.grant()
        other = self.grant(policy(clause_references=["FICTIONAL other authority"]), enabled=False)
        with self.assertRaisesRegex(WorkbenchError, "ACTIVE_AUTHORITY_EXISTS"): fx.set_authority_enabled(self.db, "w", "synthetic-investor", other["id"], True, now=AT)
        for change in ({"uses": policy()["uses"] + ["external_ai"]}, {"trading_permission": True}, {"human_review_per_publication": True}, {"provider": "other"}):
            with self.subTest(change=change), self.assertRaises(ValueError): self.grant(policy(**change), enabled=False)

    def test_corrupt_capture_is_isolated_once_without_stalling_core_or_reissuing_http(self):
        self.grant(); self.run_capture()
        self.db.execute("DROP TRIGGER investor_fx_payload_update")
        length = self.db.execute("SELECT raw_bytes FROM investor_fx_payloads").fetchone()[0]
        self.db.execute("UPDATE investor_fx_payloads SET payload=?", (b" " * length,))
        with patch.object(fx.receiver, "collect_current_fx_draft") as transport:
            self.assertIsNone(run_pending_once(self.db, "fictional-bad-source-core", role="core", clock=lambda: AT))
            self.assertEqual(self.count("investor_fx_publications"), 0)
            self.assertEqual(self.count("investor_data_reviews"), 0)
            self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='investor.fx_publication_gap'").fetchone()[0], 1)
            before = self.db.total_changes
            self.assertIsNone(run_pending_once(self.db, "fictional-second-core", role="core", clock=lambda: AT))
            self.assertEqual(self.db.total_changes, before); transport.assert_not_called()
        self.assert_no_finance()

    def test_explicitly_withdrawn_head_stops_future_network_without_silently_reapproving_it(self):
        self.grant(); self.run_capture(); fx.publish_current_fx(self.db, now=AT)
        _, first = self.latest_publication(); ref = first["refs"]["USD"]
        review = self.db.execute("SELECT * FROM investor_data_reviews WHERE id=?", (ref["review_id"],)).fetchone()
        review_source(self.db, "w", "synthetic-investor", review["source_id"], "withdrawn", None, "FICTIONAL withdrawal", "2029-01-01T00:00:00Z", now=LATER)
        with patch.object(fx.receiver, "collect_current_fx_draft") as transport:
            self.assertEqual(fx.discover_current_fx(self.db, now=LATER), [])
            self.assertIsNone(run_pending_once(self.db, "fictional-withdrawn-provider", role="longport", lease_seconds=180, clock=lambda: LATER))
            transport.assert_not_called()
        self.assertEqual(self.count("investor_fx_requests"), 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='investor.fx_source_gap'").fetchone()[0], 1)

    def test_explicit_new_authority_excludes_disabled_heads_without_reviving_old_bound_sources(self):
        old = self.grant(); self.run_capture(); fx.publish_current_fx(self.db, now=AT)
        _, first = self.latest_publication()
        fx.set_authority_enabled(self.db, "w", "synthetic-investor", old["id"], False, now=LATER)
        current = self.grant(policy(clause_references=["FICTIONAL explicit replacement rule"]), at=LATER)
        self.run_capture(Collector(rates(("2026-01-03", "2026-01-02")), LATER), at=LATER); fx.publish_current_fx(self.db, now=LATER)
        chosen = _reviews(self.db, "w", "fx", LATER)
        self.assertEqual(len(chosen), 2)
        self.assertEqual({row["facts"]["monitor_series"]["authority_id"] for row in chosen}, {current["id"]})
        with self.assertRaisesRegex(WorkbenchError, "AUTHORITY_INACTIVE"):
            resolve_review(self.db, "w", first["refs"]["USD"]["review_id"], "fx", now=LATER)

    def test_stop_readonly_and_restore_fence_before_any_network(self):
        self.grant()
        with patch.object(fx.receiver, "collect_current_fx_draft") as transport:
            with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), self.assertRaisesRegex(WorkbenchError, "WORKBENCH_READ_ONLY"):
                fx.discover_current_fx(self.db, now=AT)
            marker = self.path.parent / "RESTORE_PENDING_REVIEW"; marker.touch()
            try:
                with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
                    fx.discover_current_fx(self.db, now=AT)
            finally: marker.unlink()
            with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
                fx.discover_current_fx(self.db, now=AT, stop_requested=lambda: True)
            transport.assert_not_called()
        self.assertEqual(self.count("investor_fx_requests"), 0)

    def test_stop_during_io_or_publication_rolls_back_all_new_payloads_and_reviews(self):
        self.grant(); fx.discover_current_fx(self.db, now=AT)
        stopped = [False]; collector = Collector(during=lambda: stopped.__setitem__(0, True))
        with patch.object(fx.receiver, "collect_current_fx_draft", side_effect=collector), self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            run_one(self.db, "fictional-stopped", lambda job, lease: fx.prepare_current_fx(self.db, job, lease, clock=lambda: AT, stop_requested=lambda: stopped[0]),
                job_type=fx.JOB_TYPE, lease_seconds=180, clock=lambda: AT)
        self.assertEqual(collector.calls, 1); self.assertEqual(self.count("investor_fx_captures"), 0)
        self.assertEqual(self.count("investor_fx_payloads"), 0)
        self.run_capture(Collector(rates(("2026-01-03", "2026-01-02")), LATER), at=LATER)
        calls = [0]
        def stop_after_source():
            calls[0] += 1
            return calls[0] >= 3
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            fx.publish_current_fx(self.db, now=LATER, stop_requested=stop_after_source)
        self.assertEqual(self.count("investor_fx_publications"), 0); self.assertEqual(self.count("investor_data_reviews"), 0)
        self.assertEqual(self.count("investor_fx_payloads"), 1)
        self.assertEqual(len(fx.publish_current_fx(self.db, now=LATER)), 1)

    def _assert_tail_blocked(self, days, expected):
        self.grant(); self.run_capture(); fx.publish_current_fx(self.db, now=AT)
        self.run_capture(Collector(rates(days), LATER), at=LATER); fx.publish_current_fx(self.db, now=LATER)
        self.assertEqual(self.latest_publication()[1]["reason_code"], expected)
        self.assertEqual(self.count("investor_data_reviews"), 2)

    def test_tail_regression_never_silently_replaces_a_head(self):
        self._assert_tail_blocked(("2026-01-01",), "FX_SOURCE_TAIL_REGRESSION")

    def test_missing_overlap_never_silently_replaces_a_head(self):
        self._assert_tail_blocked(("2026-01-03",), "FX_SOURCE_OVERLAP_MISSING")

    def test_expired_dedup_reference_cannot_delete_bytes_still_bound_to_an_unexpired_capture(self):
        self.grant(policy(retention_days=2)); self.run_capture(); fx.publish_current_fx(self.db, now=AT)
        self.run_capture(Collector(at=LATER), at=LATER); fx.publish_current_fx(self.db, now=LATER)
        at = "2026-01-05T12:00:03.000Z"
        self.assertEqual(len(purge_due_source_payloads(self.db, now=at)), 1)
        self.assertEqual(self.count("investor_fx_payloads"), 1)
        second = self.db.execute("SELECT id FROM investor_fx_captures ORDER BY rowid DESC LIMIT 1").fetchone()[0]
        self.assertEqual(fx.resolve_capture(self.db, "w", second, now=at)["raw"], rates())
        self.assertEqual(len(purge_due_source_payloads(self.db, now="2026-01-06T12:00:03.000Z")), 1)
        self.assertEqual(self.count("investor_fx_payloads"), 0)

    def test_all_standing_capture_and_publication_records_are_immutable(self):
        self.grant(); self.run_capture(); fx.publish_current_fx(self.db, now=AT)
        for name, field in (("authorities", "content_hash"), ("controls", "content_hash"), ("requests", "content_hash"), ("captures", "content_hash"), ("publications", "content_hash")):
            with self.subTest(name=name), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("UPDATE investor_fx_" + name + " SET " + field + "=?", ("0" * 64,))
            with self.subTest(delete=name), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("DELETE FROM investor_fx_" + name)
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE investor_fx_payloads SET payload=payload")
        self.assertEqual(self.db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])


if __name__ == "__main__":
    unittest.main()
