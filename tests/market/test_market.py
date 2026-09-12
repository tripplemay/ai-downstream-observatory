from copy import deepcopy
from datetime import timedelta
import json
import sqlite3
import unittest

from worker.market import (
    ingest_document, persist_valuation, prepare_valuation, publish_batch, stage_batch,
    stage_page, validate_batch, value_portfolio,
)
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, stamp

try:
    from tests.market.support import NOW, database, document, ledger_event, rules, seed_account
except ModuleNotFoundError:
    from support import NOW, database, document, ledger_event, rules, seed_account


class MarketTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = database(self)
        seed_account(self.db)

    def test_full_batch_is_atomic_versioned_and_ingestion_clock_not_backdated(self):
        data = document()
        original = data["pages"][0]["observations"][0]["ingested_at"]
        result = ingest_document(self.db, data, publish=True, now=NOW)
        self.assertEqual(result["status"], "published")
        row = self.db.execute("SELECT * FROM market_observations").fetchone()
        self.assertEqual(row["ingested_at"], stamp(NOW))
        self.assertNotEqual(row["ingested_at"], original)
        raw = self.db.execute("SELECT observations_json FROM market_batch_pages").fetchone()[0]
        self.assertEqual(json.loads(raw)[0]["ingested_at"], original)
        self.assertEqual(self.db.execute("SELECT revision FROM market_publications").fetchone()[0], 1)
        self.assertEqual(ingest_document(self.db, data, publish=True, now=NOW)["status"], "published")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_observations").fetchone()[0], 1)

    def test_empty_or_partial_never_replaces_publication_or_disables_listing(self):
        ingest_document(self.db, document(), publish=True, now=NOW)
        partial = document("batch:partial", revision=1)
        partial["batch"]["expected_pages"] = 2
        partial["batch"]["expected_rows"] = 2
        result = ingest_document(self.db, partial, publish=True, now=NOW)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(self.db.execute("SELECT revision FROM market_publications").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT status FROM listings").fetchone()[0], "unverified")
        empty = document("batch:empty", revision=1)
        stage_batch(self.db, empty["batch"], now=NOW)
        self.assertEqual(validate_batch(self.db, "batch:empty", now=NOW)["status"], "partial")
        with self.assertRaises(WorkbenchError):
            publish_batch(self.db, "batch:empty", now=NOW)

    def test_page_idempotency_conflict_and_duplicate_row_failed(self):
        data = document()
        stage_batch(self.db, data["batch"], now=NOW)
        page = data["pages"][0]
        stage_page(self.db, "batch:1", 1, page["observations"], now=NOW)
        changed = deepcopy(page["observations"])
        changed[0]["value"] = "11"
        with self.assertRaises(WorkbenchError):
            stage_page(self.db, "batch:1", 1, changed, now=NOW)
        duplicate = document("batch:dup")
        duplicate["batch"]["expected_rows"] = 2
        duplicate["pages"][0]["observations"] *= 2
        self.assertEqual(ingest_document(self.db, duplicate, publish=True, now=NOW)["status"], "failed")

    def test_reused_observation_preserves_first_ingestion_and_new_membership(self):
        original = document()
        ingest_document(self.db, original, publish=True, now=NOW)
        repeated = document("batch:2", revision=1)
        ingest_document(self.db, repeated, publish=True, now=NOW + timedelta(hours=1))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_observations").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_batch_members").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT ingested_at FROM market_observations").fetchone()[0], stamp(NOW))

    def test_same_revision_different_value_fails_without_old_overwrite(self):
        ingest_document(self.db, document(), publish=True, now=NOW)
        changed = document("batch:conflict", price="99", revision=1)
        result = ingest_document(self.db, changed, publish=True, now=NOW)
        self.assertEqual(result["status"], "failed")
        self.assertIn("OBSERVATION_REVISION_CONFLICT", result["validation"]["issues"])
        self.assertEqual(self.db.execute("SELECT value FROM market_observations").fetchone()[0], "10")

    def test_stale_publication_cas_rejects_without_partial_history(self):
        first, stale = document(), document("batch:stale")
        ingest_document(self.db, stale, now=NOW)
        ingest_document(self.db, first, publish=True, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "STALE_PUBLICATION"):
            publish_batch(self.db, "batch:stale", now=NOW)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_publication_events").fetchone()[0], 1)

    def test_contracts_reject_float_extra_fields_timezone_and_bad_calendar_date(self):
        data = document()
        data["pages"][0]["observations"][0]["value"] = 0.1
        with self.assertRaises(WorkbenchError):
            ingest_document(self.db, data, now=NOW)
        invalid = rules()
        invalid["expected_sessions"]["CN"] = "2025-02-30"
        with self.assertRaises(WorkbenchError):
            validate_contract(invalid, "valuation-rules.schema.json")
        invalid = rules()
        invalid["approved"] = True
        del invalid["approval_evidence"]
        with self.assertRaises(WorkbenchError):
            validate_contract(invalid, "valuation-rules.schema.json")
        invalid = rules()
        invalid["live_advice"] = True
        with self.assertRaises(WorkbenchError):
            validate_contract(invalid, "valuation-rules.schema.json")

    def test_future_observation_and_synthetic_live_claims_rejected(self):
        future = document(observed=NOW + timedelta(days=1))
        self.assertEqual(ingest_document(self.db, future, publish=True, now=NOW)["status"], "failed")
        synthetic = document("batch:synthetic", source_mode="synthetic")
        synthetic["pages"][0]["observations"][0]["provenance"] = "live_observed"
        with self.assertRaisesRegex(WorkbenchError, "SYNTHETIC_SOURCE"):
            ingest_document(self.db, synthetic, now=NOW)

    def test_price_basis_keeps_separate_observation_keys(self):
        data = document()
        row = deepcopy(data["pages"][0]["observations"][0])
        row["id"] += ":adjusted"
        row["price_basis"] = "forward_adjusted"
        row["value"] = "8"
        data["batch"]["expected_rows"] = 2
        data["pages"][0]["observations"].append(row)
        self.assertEqual(ingest_document(self.db, data, publish=True, now=NOW)["row_count"], 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_observations").fetchone()[0], 2)


class ValuationTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = database(self)
        seed_account(self.db)

    def fund(self, currency="CNY"):
        ledger_event(self.db, "opening", [("cash_settled", "100000"), ("opening_equity", "-100000")], currency=currency)

    def test_cash_only_and_trade_date_nav_then_settlement(self):
        self.fund()
        first = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertEqual(first["quality"], "complete")
        self.assertEqual(first["nav_cny"], "100000")
        ledger_event(self.db, "buy", [("inventory_cost", "10000"), ("expense", "10"), ("trade_payable", "-10010")], quantity="1000")
        ingest_document(self.db, document(), publish=True, now=NOW)
        second = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertEqual(second["nav_cny"], "99990")
        ledger_event(self.db, "settle", [("cash_settled", "-10010"), ("trade_payable", "10010")])
        third = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertEqual(third["nav_cny"], "99990")
        self.assertEqual(len({first["id"], second["id"], third["id"]}), 3)
        self.assertEqual(value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)["id"], third["id"])
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE valuation_runs SET nav_cny='999' WHERE id=?", (third["id"],))

    def test_missing_price_and_missing_fx_do_not_generate_zero_nav(self):
        self.fund("USD")
        run = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertEqual(run["quality"], "blocked")
        self.assertIsNone(run["nav_cny"])
        ledger_event(self.db, "position", quantity="1000")
        run = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertIsNone(run["nav_cny"])
        self.assertIn("MISSING_PUBLICATION", run["issues_json"])

    def test_foreign_cash_uses_published_fx_and_staleness_is_not_complete(self):
        ledger_event(self.db, "usd-opening", [("cash_settled", "1000"), ("opening_equity", "-1000")], currency="USD")
        data = document("batch:fx", price="7")
        data["batch"]["batch_type"] = "fx"
        data["batch"]["scope"] = "fx:CNY"
        row = data["pages"][0]["observations"][0]
        del row["listing_id"]
        row.update(series_key="FX:USD", metric="fx_cny_per_unit", unit="CNY_per_unit_currency", price_basis="not_applicable")
        ingest_document(self.db, data, publish=True, now=NOW)
        config = rules()
        config["fx_scope"] = "fx:CNY"
        result = value_portfolio(self.db, "p", stamp(NOW), config, now=NOW)
        self.assertEqual(result["quality"], "complete")
        self.assertEqual(result["nav_cny"], "7000")
        config["max_fx_age_seconds"] = 1
        result = value_portfolio(self.db, "p", stamp(NOW), config, now=NOW)
        self.assertEqual(result["quality"], "provisional")
        self.assertIsNone(result["nav_cny"])
        items = self.db.execute("SELECT quality FROM valuation_items WHERE run_id=?", (result["id"],)).fetchall()
        self.assertEqual([item[0] for item in items], ["provisional"])

    def test_unclassified_income_clearing_never_adds_to_nav(self):
        ledger_event(self.db, "unknown-cost-sale", [("trade_receivable", "1000"), ("unclassified_income", "-1000")])
        result = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertEqual(result["nav_cny"], "1000")
        self.assertEqual([row[0] for row in self.db.execute("SELECT item_type FROM valuation_items WHERE run_id=?", (result["id"],))], ["trade_receivable"])

    def test_uninitialized_budget_does_not_create_assets(self):
        result = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertIsNone(result["nav_cny"])
        self.assertIn("PORTFOLIO_NOT_INITIALIZED", result["issues_json"])

    def test_lookahead_future_ledger_events_and_late_recordings_excluded(self):
        self.fund()
        ledger_event(self.db, "future", [("cash_settled", "10000"), ("external_capital", "-10000")], effective=NOW + timedelta(days=1), recorded=NOW)
        ledger_event(self.db, "late", [("cash_settled", "20000"), ("external_capital", "-20000")], effective=NOW - timedelta(days=1), recorded=NOW + timedelta(hours=1))
        as_known = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertEqual(as_known["nav_cny"], "100000")
        restated = value_portfolio(self.db, "p", stamp(NOW), rules(), mode="restated", now=NOW + timedelta(hours=2))
        self.assertEqual(restated["nav_cny"], "120000")
        self.assertNotEqual(as_known["method_version"], restated["method_version"])

    def test_historical_publication_snapshot_not_latest_head(self):
        self.fund()
        ledger_event(self.db, "position", quantity="1000")
        ingest_document(self.db, document(), publish=True, now=NOW)
        revised = document("batch:revision", price="12", revision=1)
        revised["pages"][0]["observations"][0]["revision_id"] = "new-revision"
        ingest_document(self.db, revised, publish=True, now=NOW + timedelta(hours=1))
        old = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW + timedelta(hours=2))
        new = value_portfolio(self.db, "p", stamp(NOW + timedelta(hours=2)), rules(), now=NOW + timedelta(hours=2))
        self.assertEqual(old["nav_cny"], "110000")
        self.assertEqual(new["nav_cny"], "112000")
        restated = value_portfolio(self.db, "p", stamp(NOW), rules(), mode="restated", now=NOW + timedelta(hours=2))
        self.assertEqual(restated["nav_cny"], "112000")
        self.assertNotEqual(restated["market_manifest"], old["market_manifest"])

    def test_worker_commit_checks_ledger_and_market_heads(self):
        self.fund()
        prepared = prepare_valuation(self.db, "p", stamp(NOW), rules(), now=NOW)
        ledger_event(self.db, "deposit", [("cash_settled", "1"), ("external_capital", "-1")])
        with self.assertRaisesRegex(WorkbenchError, "STALE_LEDGER"):
            persist_valuation(self.db, prepared, now=NOW)
        prepared = prepare_valuation(self.db, "p", stamp(NOW), rules(), now=NOW)
        ingest_document(self.db, document(), publish=True, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "STALE_MARKET"):
            persist_valuation(self.db, prepared, now=NOW)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM valuation_runs").fetchone()[0], 0)

    def test_synthetic_published_data_never_values_actual_portfolio_as_complete(self):
        self.fund()
        ledger_event(self.db, "position", quantity="1000")
        ingest_document(self.db, document(source_mode="synthetic"), publish=True, now=NOW)
        run = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertEqual(run["quality"], "blocked")
        self.assertIsNone(run["nav_cny"])
        self.assertIn("SYNTHETIC_DATA_NOT_ACTUAL", run["issues_json"])

    def test_calendar_holiday_valid_stale_session_and_unknown_actions_provisional(self):
        self.fund()
        ledger_event(self.db, "position", quantity="1000")
        ingest_document(self.db, document(observed=NOW - timedelta(days=1)), publish=True, now=NOW)
        config = rules()
        config["expected_sessions"]["CN"] = "2025-01-02"
        self.assertEqual(value_portfolio(self.db, "p", stamp(NOW), config, now=NOW)["quality"], "complete")
        self.assertEqual(value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)["quality"], "provisional")
        config["corporate_actions_complete"] = {}
        self.assertEqual(value_portfolio(self.db, "p", stamp(NOW), config, now=NOW)["quality"], "provisional")


if __name__ == "__main__":
    unittest.main()
