from copy import deepcopy
from dataclasses import replace
import json
import unittest

from worker.market import ingest_document, persist_valuation, prepare_valuation, publish_batch, stage_batch, value_portfolio
from worker.market.batches import OBSERVATION_COLUMNS
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, stamp
from tests.market.support import NOW, database, document, ledger_event, rules, seed_account


def unsafe_historical_publication(db, source):
    """Fault injection into a temporary DB, deliberately bypassing normalization.

    This represents pre-existing invalid stored data, not a supported import.
    The standard ingestion rejection is tested separately below.
    """
    plan = source["batch"]
    stage_batch(db, plan, now=NOW)
    raw = source["pages"][0]["observations"]
    db.execute("INSERT INTO market_batch_pages VALUES(?,?,?,?,?)",
               (plan["id"], 1, content_hash(raw), canonical_json(raw), stamp(NOW)))
    for observation in raw:
        row = {key: observation.get(key) for key in OBSERVATION_COLUMNS}
        row["ingested_at"] = stamp(NOW)
        db.execute("INSERT INTO market_observations(" + ",".join(OBSERVATION_COLUMNS) + ") VALUES(" + ",".join("?" for _ in OBSERVATION_COLUMNS) + ")",
                   tuple(row[key] for key in OBSERVATION_COLUMNS))
        db.execute("INSERT INTO market_batch_members VALUES(?,?)", (plan["id"], row["id"]))
    digest = content_hash({"synthetic_fault_injection": source})
    db.execute("UPDATE market_batches SET status='validated',received_pages=1,row_count=?,manifest_hash=?,validation_json=? WHERE id=?",
               (len(raw), digest, canonical_json({"plan": plan, "issues": [], "manifest": {"test_only_unsafe_history": True}}), plan["id"]))
    publish_batch(db, plan["id"], now=NOW)


def fx_document(unit="CNY_per_unit_currency", basis="not_applicable"):
    result = document("fx:1")
    result["batch"].update(batch_type="fx", scope="fx:global")
    row = result["pages"][0]["observations"][0]
    del row["listing_id"]
    row.update(series_key="FX:USD", metric="fx_cny_per_unit", value="7", unit=unit, price_basis=basis)
    return result


class ValuationUnitTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = database(self)
        seed_account(self.db)

    def position(self):
        ledger_event(self.db, "opening", [("inventory_cost", "100"), ("opening_equity", "-100")], quantity="10")

    def test_standard_ingestion_already_rejects_wrong_listing_currency(self):
        source = document(currency="USD")
        result = ingest_document(self.db, source, publish=True, now=NOW)
        self.assertEqual(result["status"], "failed")
        self.assertIn("PRICE_CURRENCY_MISMATCH:CN:TEST", result["validation"]["issues"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_observations").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_publications").fetchone()[0], 0)

    def test_historical_wrong_unit_price_cannot_become_cny_nav(self):
        self.position()
        unsafe_historical_publication(self.db, document(currency="USD"))
        result = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertEqual(result["quality"], "blocked")
        self.assertIsNone(result["nav_cny"])
        self.assertIn("PRICE_CURRENCY_MISMATCH:CN:TEST", json.loads(result["issues_json"])["codes"])
        item = self.db.execute("SELECT * FROM valuation_items WHERE run_id=? AND item_type='security_market_value'", (result["id"],)).fetchone()
        self.assertIsNone(item["amount"])
        self.assertIsNone(item["value_cny"])

    def test_standard_fx_ingestion_requires_cny_per_unit_and_not_applicable_basis(self):
        for index, source in enumerate((fx_document("USD_per_CNY"), fx_document(basis="total_return"))):
            source["batch"]["id"] = "fx:invalid:" + str(index)
            row = source["pages"][0]["observations"][0]
            row["batch_id"], row["id"] = source["batch"]["id"], source["batch"]["id"] + ":row"
            with self.assertRaisesRegex(WorkbenchError, "INVALID_FX_OBSERVATION"):
                ingest_document(self.db, source, publish=True, now=NOW)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_publications").fetchone()[0], 0)

    def test_historical_inverse_fx_unit_is_blocked_at_consumption(self):
        ledger_event(self.db, "opening", [("cash_settled", "100"), ("opening_equity", "-100")], currency="USD")
        unsafe_historical_publication(self.db, fx_document("USD_per_CNY"))
        config = rules()
        config["fx_scope"] = "fx:global"
        result = value_portfolio(self.db, "p", stamp(NOW), config, now=NOW)
        self.assertEqual(result["quality"], "blocked")
        self.assertIsNone(result["nav_cny"])
        self.assertIn("FX_UNIT_MISMATCH:USD", json.loads(result["issues_json"])["codes"])

    def test_adjusted_prices_never_replace_unadjusted_valuation_prices(self):
        self.position()
        source = document()
        adjusted = deepcopy(source["pages"][0]["observations"][0])
        adjusted.update(id="adjusted:1", value="999", price_basis="total_return")
        source["pages"][0]["observations"].insert(0, adjusted)
        source["batch"]["expected_rows"] = 2
        ingest_document(self.db, source, publish=True, now=NOW)
        result = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertEqual(result["nav_cny"], "100")
        self.assertEqual(result["quality"], "complete")
        only_adjusted = document("batch:adjusted", revision=1)
        only_adjusted["pages"][0]["observations"][0].update(value="999", price_basis="forward_adjusted")
        ingest_document(self.db, only_adjusted, publish=True, now=NOW)
        result = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertEqual(result["quality"], "blocked")
        self.assertIsNone(result["nav_cny"])

    def test_v4_does_not_reuse_old_immutable_v1_v2_or_v3_nav(self):
        self.position()
        unsafe_historical_publication(self.db, document(currency="USD"))
        prepared = prepare_valuation(self.db, "p", stamp(NOW), rules(), now=NOW)
        for version in (1, 2, 3):
            self.db.execute("""INSERT INTO valuation_runs
                (id,portfolio_id,ledger_revision,market_manifest,method_version,cutoff_at,quality,nav_cny,issues_json,created_at)
                VALUES(?,'p',?,?, ?,?,'complete','100','{}',?)""",
                            ("legacy:v" + str(version), prepared.ledger_revision, prepared.market_manifest,
                             "decimal-nav-cny-v" + str(version) + ":as_known", prepared.cutoff_at, stamp(NOW)))
        result = value_portfolio(self.db, "p", stamp(NOW), rules(), now=NOW)
        self.assertNotIn(result["id"], ("legacy:v1", "legacy:v2", "legacy:v3"))
        self.assertEqual(result["method_version"], "decimal-nav-cny-v4:as_known")
        self.assertEqual(result["quality"], "blocked")
        self.assertEqual(self.db.execute("SELECT nav_cny FROM valuation_runs WHERE id='legacy:v1'").fetchone()[0], "100")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM valuation_runs").fetchone()[0], 4)
        for version in (1, 2, 3):
            with self.assertRaisesRegex(WorkbenchError, "VALUATION_METHOD_SUPERSEDED"):
                persist_valuation(self.db, replace(prepared, method_version="decimal-nav-cny-v" + str(version) + ":as_known"), now=NOW)


if __name__ == "__main__":
    unittest.main()
