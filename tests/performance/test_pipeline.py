from datetime import timedelta
import json
import unittest

from tests.market.support import NOW, database, ledger_event, rules, seed_account
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, stamp
from worker.performance import prepare_performance, persist_performance
from worker.accounting.fact_quality import evaluate_fact_quality


class PerformanceTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path = database(self)
        seed_account(self.db)
        self.start = NOW - timedelta(days=2)
        self.end = NOW
        ledger_event(self.db, "opening", [("cash_settled", "100"), ("opening_equity", "-100")], effective=self.start - timedelta(days=1))

    def snapshot(self, identity, cutoff, nav, mode="restated", quality="complete", revision=None, portfolio="p"):
        revision = self.db.execute("SELECT revision FROM ledger_heads WHERE portfolio_id=?", (portfolio,)).fetchone()[0] if revision is None else revision
        config = rules()
        events = [dict(row) for row in self.db.execute("SELECT * FROM ledger_events WHERE portfolio_id=?", (portfolio,))]
        manifest = {"schema_version": "valuation-input-v3", "mode": mode, "rules": config,
                    "rules_hash": content_hash(config), "publications": {},
                    "ledger_fact_quality": evaluate_fact_quality(events, portfolio, revision, cutoff, NOW, mode)}
        self.db.execute("""INSERT INTO valuation_runs(id,portfolio_id,ledger_revision,market_manifest,method_version,
            cutoff_at,quality,nav_cny,created_at) VALUES(?,?,?,?,?,?,?,?,?)""",
            (identity, portfolio, revision, canonical_json(manifest), "decimal-nav-cny-v4:" + mode, stamp(cutoff), quality, nav, stamp(NOW)))
        if nav is not None:
            self.db.execute("""INSERT INTO valuation_items(id,run_id,account_id,item_type,currency,amount,fx_rate,value_cny,quality,evidence_json)
                VALUES(?,?,'a','cash_settled','CNY',?,'1',?,?,'{}')""", (identity + ":cash", identity, nav, nav, quality))

    def prepare(self, ids=("start", "end")):
        return prepare_performance(self.db, "p", {"valuation_ids": list(ids), "evaluation_timezone": "Asia/Shanghai"}, now=NOW)

    def date_flow(self, identity, day, amount, zone="Asia/Shanghai"):
        revision = self.db.execute("SELECT revision FROM ledger_heads WHERE portfolio_id='p'").fetchone()[0] + 1
        payload = {"synthetic": True, "event_id": identity}
        self.db.execute("""INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,
            time_precision,source_timezone,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id)
            VALUES(?,'p','a','synthetic_fixture',?,'date',?,?,'test',?,?,?,?, 'test')""",
            (identity, day, zone, stamp(self.start), identity, content_hash(payload), canonical_json(payload), revision))
        self.db.execute("INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES(?,?,'a','CNY','external_capital',?)",
                        (identity + ":p", identity, amount))
        self.db.execute("UPDATE ledger_heads SET revision=? WHERE portfolio_id='p'", (revision,))

    def test_no_external_flow_exact_return_profit_and_observed_drawdown(self):
        self.snapshot("start", self.start, "100")
        self.snapshot("trough", self.start + timedelta(days=1), "80")
        self.snapshot("end", self.end, "110")
        result = self.prepare(("start", "trough", "end"))
        self.assertEqual(result.method, "exact_twr")
        self.assertEqual(result.quality, "complete")
        self.assertEqual(result.result["return"]["value"], "0.1")
        self.assertEqual(result.result["net_profit_cny"], "10")
        self.assertEqual(result.result["drawdown"]["max_drawdown"], "-0.2")
        self.assertIn("drawdown_measured_at_supplied_snapshots_only", result.result["assumptions"])

    def test_contribution_is_not_profit_and_dietz_is_not_exact_twr(self):
        ledger_event(self.db, "addition", [("cash_settled", "50"), ("external_capital", "-50")], effective=self.start + timedelta(days=1))
        self.snapshot("start", self.start, "100")
        self.snapshot("end", self.end, "150")
        result = self.prepare()
        self.assertEqual(result.quality, "provisional")
        self.assertEqual(result.method, "modified_dietz_estimate")
        self.assertEqual(result.result["return"]["value"], "0")
        self.assertEqual(result.result["external_flow_cny"], "50")
        self.assertEqual(result.result["net_profit_cny"], "0")
        self.assertEqual(result.result["xirr"]["status"], "ok")

    def test_internal_transfer_does_not_become_external_capital(self):
        ledger_event(self.db, "transfer", [("cash_settled", "-30"), ("transfer_in_transit", "30")], effective=self.start + timedelta(days=1))
        self.snapshot("start", self.start, "100")
        self.snapshot("end", self.end, "100")
        result = self.prepare()
        self.assertEqual(result.method, "exact_twr")
        self.assertEqual(result.result["net_profit_cny"], "0")
        self.assertEqual(result.result["external_flow_cny"], "0")

    def test_foreign_contribution_without_contemporaneous_fx_blocks_all_totals(self):
        ledger_event(self.db, "usd", [("cash_settled", "50"), ("external_capital", "-50")], currency="USD", effective=self.start + timedelta(days=1))
        self.snapshot("start", self.start, "100")
        self.snapshot("end", self.end, "450")
        result = self.prepare()
        self.assertEqual(result.quality, "blocked")
        self.assertIsNone(result.result["net_profit_cny"])
        self.assertIsNone(result.result["return"])
        self.assertIn("FLOW_FX_EVIDENCE_REQUIRED:usd", result.result["issues"])

    def test_new_account_opening_inside_period_is_not_invented_profit(self):
        ledger_event(self.db, "later-opening", [("cash_settled", "50"), ("opening_equity", "-50")], effective=self.start + timedelta(days=1))
        self.snapshot("start", self.start, "100")
        self.snapshot("end", self.end, "150")
        result = self.prepare()
        self.assertIn("OPENING_SNAPSHOT_INSIDE_PERFORMANCE_PERIOD", result.result["issues"])
        self.assertIsNone(result.result["net_profit_cny"])

    def test_date_only_flow_uses_source_day_end_and_labels_estimate(self):
        self.date_flow("date-addition", "2025-01-02", "-50")
        self.snapshot("start", self.start, "100")
        self.snapshot("end", self.end, "150")
        result = self.prepare()
        self.assertEqual(result.quality, "provisional")
        self.assertEqual(result.result["net_profit_cny"], "0")
        self.assertEqual(result.result["external_flow_cny"], "50")
        self.assertIn("date_only_source_timezone_eod_assumption", result.result["assumptions"])

    def test_date_only_flow_unknown_order_at_intraday_snapshot_blocks(self):
        self.date_flow("date-addition", "2025-01-02", "-50")
        self.snapshot("start", self.start, "100")
        self.snapshot("intraday", self.start + timedelta(days=1), "150")
        self.snapshot("end", self.end, "150")
        result = self.prepare(("start", "intraday", "end"))
        self.assertEqual(result.quality, "blocked")
        self.assertIn("DATE_ONLY_FLOW_CROSSES_SNAPSHOT_BOUNDARY", result.result["issues"])
        self.assertIsNone(result.result["net_profit_cny"])

    def test_reversal_excludes_original_external_capital_in_restatement(self):
        ledger_event(self.db, "wrong-addition", [("cash_settled", "50"), ("external_capital", "-50")], effective=self.start + timedelta(days=1))
        revision = self.db.execute("SELECT revision FROM ledger_heads WHERE portfolio_id='p'").fetchone()[0] + 1
        payload = {"synthetic": True, "reversal_of": "wrong-addition"}
        self.db.execute("""INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,recorded_at,
            source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id,reversal_of)
            VALUES('reverse','p','a','reversal',?,?,'test','reverse',?,?,?,'test','wrong-addition')""",
            (stamp(self.start + timedelta(days=1)), stamp(NOW), content_hash(payload), canonical_json(payload), revision))
        self.db.execute("INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES('reverse:p','reverse','a','CNY','external_capital','50')")
        self.db.execute("UPDATE ledger_heads SET revision=? WHERE portfolio_id='p'", (revision,))
        self.snapshot("start", self.start, "100")
        self.snapshot("end", self.end, "100")
        result = self.prepare()
        self.assertEqual(result.quality, "complete")
        self.assertEqual(result.result["external_flow_cny"], "0")
        self.assertEqual(result.result["net_profit_cny"], "0")

    def test_incomplete_or_stale_snapshots_cannot_produce_complete_performance(self):
        self.snapshot("start", self.start, "100")
        self.snapshot("end", self.end, None, quality="blocked")
        result = self.prepare()
        self.assertEqual(result.method, "unavailable")
        self.assertIsNone(result.result["xirr"]["rate"])
        ledger_event(self.db, "new-fact", [("cash_settled", "1"), ("external_capital", "-1")])
        with self.assertRaisesRegex(WorkbenchError, "STALE_PERFORMANCE_INPUT"):
            self.prepare()

    def test_scope_order_timezone_and_mode_are_strict(self):
        self.snapshot("start", self.start, "100", mode="as_known")
        self.snapshot("end", self.end, "110")
        with self.assertRaisesRegex(WorkbenchError, "INCOMPATIBLE_PERFORMANCE_INPUTS"):
            self.prepare()
        with self.assertRaisesRegex(WorkbenchError, "VALUATION_OUT_OF_SCOPE"):
            self.prepare(("start", "missing"))
        with self.assertRaisesRegex(WorkbenchError, "SNAPSHOTS_NOT_CHRONOLOGICAL"):
            self.prepare(("end", "start"))
        with self.assertRaisesRegex(WorkbenchError, "INVALID_EVALUATION_TIMEZONE"):
            prepare_performance(self.db, "p", {"valuation_ids": ["start", "end"], "evaluation_timezone": "Invalid/Zone"})

    def test_late_as_known_changes_are_restatement_not_new_return(self):
        ledger_event(self.db, "late-fee", [("cash_settled", "-10"), ("expense", "10")], effective=self.start - timedelta(hours=1), recorded=self.start + timedelta(hours=1))
        self.snapshot("start", self.start, "100", mode="as_known")
        self.snapshot("end", self.end, "90", mode="as_known")
        result = self.prepare()
        self.assertEqual(result.quality, "blocked")
        self.assertIn("KNOWLEDGE_SET_CHANGED_RESTATE_REQUIRED", result.result["issues"])

    def test_persist_is_idempotent_append_only_and_checks_revision_and_recovery(self):
        self.snapshot("start", self.start, "100")
        self.snapshot("end", self.end, "110")
        prepared = self.prepare()
        saved = persist_performance(self.db, prepared, now=NOW)
        self.assertEqual(persist_performance(self.db, prepared, now=NOW)["id"], saved["id"])
        self.assertEqual(json.loads(saved["result_json"])["net_profit_cny"], "10")
        with self.assertRaisesRegex(Exception, "append-only"):
            self.db.execute("DELETE FROM performance_runs")
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        marker.touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            persist_performance(self.db, prepared, now=NOW)
        marker.unlink()
        ledger_event(self.db, "new", [("cash_settled", "1"), ("external_capital", "-1")])
        with self.assertRaisesRegex(WorkbenchError, "STALE_PERFORMANCE_INPUT"):
            persist_performance(self.db, prepared, now=NOW)
