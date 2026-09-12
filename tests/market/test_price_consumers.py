"""Actual audited SDK captures consumed independently by NAV/performance/research."""

import json
import unittest
from unittest.mock import patch

from worker.market import prepare_valuation, persist_valuation
from worker.market.price_collection import prepare_price_collection, persist_price_collection
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, stamp
from worker.orchestration.jobs import JobCommit, claim_job, complete_job, enqueue_job
from worker.performance import prepare_performance
from worker.research.snapshot import snapshot_from_publications
from tests.market.support import ledger_event
from tests.market.test_collection import add_request, db_state, fixture, utc_now
from tests.market.test_price_collection import calendar, fake_collect, mapping, price_payload, publish_reference
from tests.research.fixtures import dataset


class PriceConsumerTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = fixture(self)
        self.db.execute("INSERT INTO catalog_entries VALUES('p','CN:TEST','2025-01-01T00:00:00.000000Z')")
        self.mapping = publish_reference(self, self.path, "mapping", mapping())
        self.calendar = publish_reference(self, self.path, "calendar", calendar())
        payload = price_payload([self.mapping["id"]], [self.calendar["id"]])
        request = add_request(self.db, "consumer:price", payload, kind="market_collect_prices")
        job = enqueue_job(self.db, "market_collect_prices", "p", request["created_at"][:10], request["id"],
                          command_request_id=request["id"])
        lease = claim_job(self.db, "synthetic-provider", 300, "market_collect_prices")
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (job["id"],)).fetchone())
        with patch("worker.market.providers.longport.collect_longport_candles", fake_collect):
            prepared = prepare_price_collection(self.db, request, job, lease)
        now = utc_now()
        complete_job(self.db, lease, {}, effect=lambda db: JobCommit(persist_price_collection(db, prepared, now=now)), now=now)
        self.publication = dict(self.db.execute("SELECT * FROM market_publication_events").fetchone())
        ledger_event(self.db, "synthetic-position", quantity="2")
        self.rules = {"schema_version": "valuation-rules-v1", "approved": True,
                      "approval_evidence": "Synthetic fixture data-quality approval only; not investment approval",
                      "price_scope_by_market": {"CN": self.publication["scope"]}, "expected_sessions": {"CN": "2025-06-06"},
                      "corporate_actions_complete": {"CN:TEST": True}, "max_fx_age_seconds": 86400}

    def nav(self, cutoff="2025-06-07T06:00:00Z", rules=None, mode="restated", portfolio="p"):
        return prepare_valuation(self.db, portfolio, cutoff, rules or self.rules, mode, now=utc_now())

    def snapshots(self):
        return [persist_valuation(self.db, self.nav(at), now=utc_now()) for at in
                ("2025-06-07T06:00:00Z", "2025-06-08T06:00:00Z")]

    def performance(self, snapshots):
        return prepare_performance(self.db, "p", {"valuation_ids": [row["id"] for row in snapshots],
                                                  "evaluation_timezone": "Asia/Shanghai"}, now=utc_now())

    def test_restated_nav_has_precise_price_but_original_as_known_is_unavailable(self):
        value = self.nav()
        self.assertEqual(value.quality, "complete")
        self.assertEqual(value.nav_cny, "260.200000000000000002")
        self.assertEqual(value.method_version, "decimal-nav-cny-v4:restated")
        historical = self.nav(mode="as_known")
        self.assertEqual(historical.quality, "blocked")
        self.assertIsNone(historical.nav_cny)

    def test_wrong_expected_session_or_calendar_outside_range_blocks_nav(self):
        wrong = {**self.rules, "expected_sessions": {"CN": "2025-06-05"}}
        for value in (self.nav(rules=wrong), self.nav("2025-06-09T06:00:00Z")):
            self.assertEqual(value.quality, "blocked")
            self.assertIsNone(value.nav_cny)
            self.assertIn("PRICE_CALENDAR_UNVERIFIED:CN:TEST", value.issues)

    def test_performance_independently_recomputes_calendar_not_just_nav_complete(self):
        snapshots = self.snapshots()
        original = self.performance(snapshots)
        self.assertEqual(original.quality, "complete")
        self.assertEqual(original.result["return"]["value"], "0")
        # Deliberate corrupted persisted NAV: all financial inputs remain genuine.
        for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='valuation_runs'").fetchall():
            self.db.execute('DROP TRIGGER "' + row[0] + '"')
        snapshot = snapshots[0]
        manifest = json.loads(snapshot["market_manifest"])
        manifest["rules"]["expected_sessions"]["CN"] = "2025-06-05"
        manifest["rules_hash"] = content_hash(manifest["rules"])
        self.db.execute("UPDATE valuation_runs SET market_manifest=? WHERE id=?", (canonical_json(manifest), snapshot["id"]))
        before = db_state(self.db)
        refused = self.performance(snapshots)
        self.assertEqual(refused.quality, "blocked")
        self.assertIsNone(refused.result["return"])
        self.assertIn("VALUATION_MARKET_EVIDENCE_INVALID:" + snapshot["id"], refused.result["issues"])
        self.assertEqual(before, db_state(self.db))

    def other_portfolio(self):
        self.db.execute("INSERT INTO portfolios(id,name,created_at) VALUES('other','Synthetic other portfolio','2025-01-01T00:00:00Z')")
        self.db.execute("INSERT INTO ledger_heads VALUES('other',1,'2025-01-01T00:00:00Z')")
        self.db.execute("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('other-account','other','Synthetic','synthetic','CNY','2025-01-01T00:00:00Z')")
        payload = {"synthetic": True}
        self.db.execute("""INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id)
            VALUES('other-position','other','other-account','synthetic_fixture','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z','synthetic','other-position',?,?,1,'synthetic')""",
                        (content_hash(payload), canonical_json(payload)))
        self.db.execute("INSERT INTO position_movements(id,event_id,account_id,listing_id,quantity,cost_amount,currency) VALUES('other-move','other-position','other-account','CN:TEST','2','0','CNY')")

    def test_private_capture_cannot_value_another_portfolio_holding_same_listing(self):
        self.other_portfolio()
        result = self.nav(portfolio="other")
        self.assertEqual(result.quality, "blocked")
        self.assertIsNone(result.nav_cny)
        self.assertIn("PRICE_CALENDAR_UNVERIFIED:CN:TEST", result.issues)

    def test_performance_refuses_genuine_capture_attached_to_wrong_portfolio_snapshot(self):
        snapshots = self.snapshots()
        self.other_portfolio()
        # Simulate damaged stored NAV ownership, without altering the capture,
        # source, reference audits, or provider/job proof to make it pass.
        for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='valuation_runs'").fetchall():
            self.db.execute('DROP TRIGGER "' + row[0] + '"')
        self.db.execute("UPDATE valuation_runs SET portfolio_id='other',ledger_revision=1")
        result = prepare_performance(self.db, "other", {"valuation_ids": [row["id"] for row in snapshots],
                                                        "evaluation_timezone": "Asia/Shanghai"}, now=utc_now())
        self.assertEqual(result.quality, "blocked")
        self.assertIsNone(result.result["return"])
        for snapshot in snapshots:
            self.assertIn("VALUATION_MARKET_EVIDENCE_INVALID:" + snapshot["id"], result.result["issues"])

    def test_research_private_scope_checked_before_dataset_and_date_precision_never_upgraded(self):
        metadata = dataset()
        metadata.pop("observations")
        metadata.pop("publication_refs")
        ref = {key: self.publication[key] for key in ("scope", "revision", "batch_id", "manifest_hash")}
        before = db_state(self.db)
        for portfolio in (None, "other"):
            with self.assertRaisesRegex(WorkbenchError, "RESEARCH_PRIVATE_SOURCE_OUT_OF_SCOPE"):
                snapshot_from_publications(self.db, metadata, [ref], portfolio_id=portfolio)
        for mode in ("synthetic", "actual_replay", "historical_point_in_time"):
            candidate = {**metadata, "mode": mode, "historical_archive_verified": mode == "historical_point_in_time"}
            with self.assertRaisesRegex(WorkbenchError, "RESEARCH_REQUIRES_EXPLICIT_OBSERVATION_INSTANTS"):
                snapshot_from_publications(self.db, candidate, [ref], portfolio_id="p")
        self.assertEqual(before, db_state(self.db))

    def test_new_calendar_version_invalidates_current_nav_but_not_frozen_historical_performance_inputs(self):
        snapshots = self.snapshots()
        publish_reference(self, self.path, "calendar", calendar(), version=1, at=stamp())
        current = self.nav()
        self.assertEqual(current.quality, "blocked")
        self.assertIsNone(current.nav_cny)
        # Frozen restated snapshots retain their original explicit knowledge time;
        # current freshness/eligibility is a separate consumer decision.
        result = self.performance(snapshots)
        self.assertEqual(result.quality, "complete")
        self.assertEqual(result.result["return"]["value"], "0")


if __name__ == "__main__":
    unittest.main()
