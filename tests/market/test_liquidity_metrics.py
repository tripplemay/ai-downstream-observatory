import json
import unittest

from worker.market import ingest_document
from worker.market.contracts import observation_semantics, validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, transaction
from tests.market.support import NOW, database, document, seed_account


def liquidity_document(identity="liquidity:1", revision=0):
    result = document(identity, revision=revision)
    base = result["pages"][0]["observations"][0]
    base["revision_id"] = identity
    for metric, value, unit in (("spread_bps", "1", "bps"), ("premium_bps", "-25", "bps"),
                                ("turnover", "10000000", "CNY"), ("volume", "100000", "shares")):
        row = {**base, "id": identity + ":" + metric, "metric": metric, "value": value,
               "unit": unit, "price_basis": "not_applicable"}
        row["raw_hash"] = content_hash({"synthetic": True, "metric": metric, "value": value})
        result["pages"][0]["observations"].append(row)
    result["batch"]["expected_rows"] = 5
    return result


class LiquidityMetricTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = database(self)
        seed_account(self.db)

    def test_normal_ingestion_publishes_complete_immutable_liquidity_members(self):
        data = liquidity_document()
        result = ingest_document(self.db, data, publish=True, now=NOW)
        self.assertEqual(result["status"], "published")
        self.assertEqual(result["row_count"], 5)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_batch_members").fetchone()[0], 5)
        self.assertEqual({row["metric"]: row["value"] for row in self.db.execute("SELECT metric,value FROM market_observations")},
                         {"close": "10", "spread_bps": "1", "premium_bps": "-25", "turnover": "10000000", "volume": "100000"})
        self.assertEqual(json.loads(self.db.execute("SELECT observations_json FROM market_batch_pages").fetchone()[0]),
                         data["pages"][0]["observations"])
        self.assertEqual(ingest_document(self.db, data, publish=True, now=NOW)["manifest_hash"], result["manifest_hash"])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_publication_events").fetchone()[0], 1)

    def test_metric_domain_is_strict_without_using_risk_thresholds_as_measurement_validation(self):
        data = liquidity_document()
        rows = {row["metric"]: row for row in data["pages"][0]["observations"]}
        for metric, value in (("spread_bps", "0"), ("spread_bps", "200"), ("premium_bps", "-200"),
                              ("premium_bps", "200"), ("turnover", "0"), ("volume", "0"), ("volume", "10.0")):
            with self.subTest(metric=metric, value=value):
                observation_semantics({**rows[metric], "value": value}, data["batch"])
        invalid = [
            ("spread_bps", {"value": "-1"}), ("spread_bps", {"unit": "percent"}),
            ("premium_bps", {"unit": "CNY"}), ("turnover", {"value": "-1"}),
            ("turnover", {"unit": "cny"}), ("turnover", {"unit": "shares"}),
            ("volume", {"value": "-1"}), ("volume", {"value": "0.5"}), ("volume", {"unit": "CNY"}),
        ]
        invalid += [(metric, change) for metric in ("spread_bps", "premium_bps", "turnover", "volume")
                    for change in ({"price_basis": "unadjusted"}, {"listing_id": ""}, {"value": True}, {"value": 1.5})]
        for metric, change in invalid:
            with self.subTest(metric=metric, change=change), self.assertRaises(WorkbenchError):
                observation_semantics({**rows[metric], **change}, data["batch"])
        unknown = {**rows["volume"], "metric": "synthetic_unsupported"}
        with self.assertRaisesRegex(WorkbenchError, "CONTRACT_INVALID"):
            validate_contract(unknown, "market-observation.schema.json")

    def test_parent_batch_type_and_source_provenance_guards_are_unchanged(self):
        data = liquidity_document()
        for row in data["pages"][0]["observations"][1:]:
            for change, error in (({"batch_id": "other"}, "OBSERVATION_PARENT_MISMATCH"),
                                  ({"source_id": "other"}, "OBSERVATION_PARENT_MISMATCH")):
                with self.subTest(metric=row["metric"], change=change), self.assertRaisesRegex(WorkbenchError, error):
                    observation_semantics({**row, **change}, data["batch"])
            for kind in ("fx", "universe"):
                with self.subTest(metric=row["metric"], batch_type=kind), self.assertRaisesRegex(WorkbenchError, "BATCH_TYPE_METRIC_MISMATCH"):
                    observation_semantics(row, {**data["batch"], "batch_type": kind})
            observation_semantics(row, {**data["batch"], "batch_type": "mixed"})
            with self.assertRaisesRegex(WorkbenchError, "SYNTHETIC_SOURCE_MUST_BE_RECONSTRUCTED"):
                observation_semantics(row, {**data["batch"], "source_mode": "synthetic"})

    def test_wrong_turnover_currency_or_listing_keeps_previous_publication_and_no_partial_members(self):
        first = ingest_document(self.db, liquidity_document(), publish=True, now=NOW)
        for index, change in enumerate(({"unit": "USD"}, {"listing_id": "unknown-listing"})):
            data = liquidity_document("liquidity:bad:" + str(index), revision=1)
            data["pages"][0]["observations"][3].update(change)
            result = ingest_document(self.db, data, publish=True, now=NOW)
            self.assertEqual(result["status"], "failed")
            self.assertTrue(any(code.startswith("TURNOVER_CURRENCY_MISMATCH" if index == 0 else "UNKNOWN_LISTING")
                                for code in result["validation"]["issues"]))
            self.assertEqual(self.db.execute("SELECT batch_id FROM market_publications").fetchone()[0], first["id"])
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_observations").fetchone()[0], 5)
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_batch_members").fetchone()[0], 5)

    def test_invalid_later_page_rolls_back_the_entire_worker_style_transaction(self):
        original = liquidity_document()
        ingest_document(self.db, original, publish=True, now=NOW)
        data = liquidity_document("liquidity:atomic", revision=1)
        rows = data["pages"][0]["observations"]
        data["pages"] = [{"page_number": 1, "observations": rows[:3]}, {"page_number": 2, "observations": rows[3:]}]
        data["batch"]["expected_pages"] = 2
        data["pages"][1]["observations"][1]["value"] = "-1"
        before = {table: [tuple(row) for row in self.db.execute("SELECT * FROM " + table)]
                  for table in ("market_batches", "market_batch_pages", "market_observations", "market_batch_members", "market_publications", "market_publication_events")}
        with self.assertRaisesRegex(WorkbenchError, "INVALID_LIQUIDITY_OBSERVATION"):
            with transaction(self.db):
                ingest_document(self.db, data, publish=True, now=NOW)
        for table, rows in before.items():
            self.assertEqual([tuple(row) for row in self.db.execute("SELECT * FROM " + table)], rows)

    def test_stale_new_liquidity_publication_does_not_replace_head(self):
        ingest_document(self.db, liquidity_document(), publish=True, now=NOW)
        data = liquidity_document("liquidity:stale", revision=0)
        with self.assertRaisesRegex(WorkbenchError, "STALE_PUBLICATION_REVISION"):
            with transaction(self.db):
                ingest_document(self.db, data, publish=True, now=NOW)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM market_batches").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT revision FROM market_publications").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
