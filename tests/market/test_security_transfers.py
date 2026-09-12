"""Isolated synthetic catalog/quotes; economic facts run through the real TS ledger."""

from copy import deepcopy
from datetime import timedelta
import json
import os
import subprocess
import unittest

from tests.market.support import ROOT, NOW, database, document, rules, seed_account
from worker.market import ingest_document, value_portfolio
from worker.market.valuation import prepare_valuation
from worker.orchestration.db import stamp


START = NOW - timedelta(hours=8)


def ledger_commands(path, commands, known=None):
    source = r'''
import { openWorkbench } from "./web/src/server/workbench-db";
import { recordFact, revision } from "./web/src/server/ledger/service";
const input = JSON.parse(process.env.SECURITY_FIXTURE!);
const db = openWorkbench(input.path), ids = { ...(input.known || {}) };
for (const row of input.commands) {
  const fact = { account_id: "a", currency: input.currency || "CNY", ...row.fact };
  if (row.precision !== "date") row.at = new Date(row.at).toISOString();
  if (fact.value_evidence?.time_precision === "second") fact.value_evidence.effective_at = new Date(fact.value_evidence.effective_at).toISOString();
  if (fact.related_event_id?.startsWith("@")) fact.related_event_id = ids[fact.related_event_id.slice(1)];
  if (fact.supporting_event_ids) fact.supporting_event_ids = fact.supporting_event_ids.map((id: string) => id.startsWith("@") ? ids[id.slice(1)] : id);
  const command = { portfolio_id: "p", expected_revision: revision(db, "p"),
    idempotency_key: row.key, source_id: "synthetic-only", source_event_id: row.key,
    effective_at: row.at, time_precision: row.precision || "second", source_timezone: "UTC",
    reason: "Synthetic isolated integration fixture", fact };
  ids[row.key] = recordFact(db, { id: "synthetic-owner" }, command, new Date(row.recorded || row.at).toISOString()).event_id;
}
db.close(); console.log(JSON.stringify(ids));
'''
    environment = {**os.environ, "SECURITY_FIXTURE": json.dumps({"path": str(path), "commands": commands, "known": known})}
    result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "--eval", source],
                            cwd=ROOT, env=environment, text=True, capture_output=True)
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


def value_evidence(at, precision="second"):
    return {"schema_version": "security-transfer-value-v1", "reference": "Synthetic confirmed broker value; not live evidence",
            "effective_at": at, "time_precision": precision, "source_timezone": "UTC"}


def correct_security_fact(path, event_id, changes=None, now=NOW):
    source = r'''
import { openWorkbench } from "./web/src/server/workbench-db";
import { revision } from "./web/src/server/ledger/service";
import { correctLedger } from "./web/src/server/ledger/corrections";
import { storeJsonAttachment } from "./web/src/server/ledger/attachments";
import path from "node:path";
const input = JSON.parse(process.env.SECURITY_FIXTURE!), db = openWorkbench(input.path);
const actor = { id: "synthetic-owner" }, dataDir = path.dirname(input.path), now = new Date(input.now).toISOString();
const old = JSON.parse(db.prepare("SELECT payload_json FROM ledger_events WHERE id=?").get(input.id).payload_json);
const raw = '{"synthetic":"value/cost correction fixture only"}';
const attachment = storeJsonAttachment(db, actor, { portfolio_id: "p", account_id: "a", raw }, { dataDir, now });
storeJsonAttachment(db, actor, { portfolio_id: "p", account_id: "b", raw }, { dataDir, now });
const change = input.changes === null ? { action: "void", event_id: input.id } : {
  action: "replace", event_id: input.id, replacement: {
    effective_at: old.effective_at, time_precision: old.time_precision, source_timezone: old.source_timezone,
    fact: { ...old.fact, ...input.changes } } };
const result = correctLedger(db, actor, { portfolio_id: "p", expected_revision: revision(db, "p"),
  idempotency_key: "correction-" + revision(db, "p"), attachment_id: attachment.id,
  reason: "Synthetic correction fixture", changes: [change] }, { dataDir, now });
db.close(); console.log(JSON.stringify(result));
'''
    environment = {**os.environ, "SECURITY_FIXTURE": json.dumps({"path": str(path), "id": event_id, "changes": changes, "now": stamp(now)})}
    result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "--eval", source],
                            cwd=ROOT, env=environment, text=True, capture_output=True)
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


def security_database(test, currency="CNY", cost="40", internal=True, date_only=False, market_value="100"):
    db, path = database(test)
    seed_account(db, currency)
    db.execute("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('b','p','Target','synthetic',?,?)",
               (currency, stamp(START)))
    at = START.date().isoformat() if date_only else stamp(START + timedelta(hours=1))
    incoming = {"type": "security_in", "listing_id": "CN:TEST", "currency": currency,
                "quantity": "10", "market_value": market_value, "value_evidence": value_evidence(at, "date" if date_only else "second")}
    if cost is not None:
        incoming["cost_amount"] = cost
    commands = [{"key": "opening", "at": stamp(START - (timedelta(days=1) if date_only else timedelta(hours=1))),
                 "fact": {"type": "opening_cash", "currency": "CNY", "amount": "100"}},
                {"key": "incoming", "at": at, "recorded": stamp(START + timedelta(hours=1)),
                 "precision": "date" if date_only else "second", "fact": incoming}]
    if internal:
        for key, hours, fact in [
            ("dispatch", 2, {"type": "security_transfer_out", "quantity": "6", "target_account_id": "b"}),
            ("partial", 3, {"type": "security_transfer_in", "account_id": "b", "quantity": "2", "related_event_id": "@dispatch"}),
            ("split-source", 4, {"type": "split", "split_numerator": "2", "split_denominator": "1"}),
            ("split-target", 4, {"type": "split", "account_id": "b", "split_numerator": "2", "split_denominator": "1"}),
            ("returned", 5, {"type": "security_transfer_return", "quantity": "3", "related_event_id": "@dispatch"}),
            ("arrived", 6, {"type": "security_transfer_in", "account_id": "b", "quantity": "5", "related_event_id": "@dispatch"}),
        ]:
            commands.append({"key": key, "at": stamp(START + timedelta(hours=hours)),
                             "fact": {"listing_id": "CN:TEST", "currency": currency, **fact}})
    return db, path, ledger_commands(path, commands)


def publish_security_prices(db, currency="CNY", split=True):
    early = START - timedelta(minutes=30)
    first = document("security:price:1", currency=currency, observed=early)
    result = ingest_document(db, first, publish=True, now=early)
    if result["status"] != "published":
        raise AssertionError(result)
    if split:
        at = START + timedelta(hours=4)
        archive = deepcopy(first)
        archive["batch"].update(id="security:price:2", expected_rows=2, expected_publication_revision=1)
        old = archive["pages"][0]["observations"][0]
        old.update(batch_id="security:price:2", id="security:price:2:old")
        row = document("security:price:2", currency=currency, price="5", observed=at)["pages"][0]["observations"][0]
        archive["pages"][0]["observations"].append(row)
        result = ingest_document(db, archive, publish=True, now=at)
        if result["status"] != "published":
            raise AssertionError(result)


class SecurityTransferTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path, self.events = security_database(self)
        publish_security_prices(self.db)

    def valuation(self, hours, mode="restated"):
        return value_portfolio(self.db, "p", stamp(START + timedelta(hours=hours)), rules(), mode=mode, now=NOW)

    def test_real_ledger_partial_receive_return_and_split_keep_total_nav(self):
        expected = [(1.5, "100", None), (2.5, "40", "60"), (3.5, "60", "40"),
                    (4.5, "60", "40"), (5.5, "75", "25"), (6.5, "100", None)]
        for mode in ("restated", "as_known"):
            for hours, settled, transit in expected:
                with self.subTest(mode=mode, hours=hours):
                    run = self.valuation(hours, mode)
                    self.assertEqual(run["quality"], "complete", run)
                    self.assertEqual(run["nav_cny"], "200")
                    self.assertEqual(run["method_version"], "decimal-nav-cny-v4:" + mode)
                    items = [dict(row) for row in self.db.execute("SELECT * FROM valuation_items WHERE run_id=?", (run["id"],))]
                    from decimal import Decimal
                    self.assertEqual(sum(Decimal(row["amount"]) for row in items if row["item_type"] == "security_market_value"), Decimal(settled))
                    pending = [row for row in items if row["item_type"] == "security_in_transit_market_value"]
                    self.assertEqual(len(pending), 0 if transit is None else 1)
                    if pending:
                        self.assertEqual(pending[0]["account_id"], "a")
                        self.assertEqual(pending[0]["amount"], transit)
                        evidence = json.loads(pending[0]["evidence_json"])
                        self.assertEqual(evidence["target_account_id"], "b")
                        self.assertEqual(evidence["transfer_event_id"], self.events["dispatch"])
                        self.assertEqual(set(evidence), {"quantity", "transfer_event_id", "target_account_id", "price_observation_id", "fx_observation_id"})
        self.assertEqual([tuple(row) for row in self.db.execute("SELECT account_id,quantity,cost_amount,cost_known FROM position_projections ORDER BY account_id")],
                         [("a", "11", "22", 1), ("b", "9", "18", 1)])

    def test_unknown_cost_and_capital_basis_never_become_nav_or_income(self):
        for cost in (None, "0", "200"):
            db, path, events = security_database(self, cost=cost)
            publish_security_prices(db)
            run = value_portfolio(db, "p", stamp(START + timedelta(hours=5.5)), rules(), mode="restated", now=NOW)
            self.assertEqual(run["nav_cny"], "200")
            self.assertEqual(db.execute("SELECT count(*) FROM postings WHERE ledger_account IN ('income','cash_settled') AND event_id=?", (events["incoming"],)).fetchone()[0], 0)
            self.assertEqual({row[0] for row in db.execute("SELECT cost_known FROM position_projections")}, {0 if cost is None else 1})

    def test_transit_only_holdings_need_price_and_foreign_fx(self):
        for currency in ("CNY", "USD"):
            db, path, events = security_database(self, currency=currency, internal=False)
            ledger_commands(path, [{"key": "all-pending", "at": stamp(START + timedelta(hours=2)), "fact": {
                "type": "security_transfer_out", "listing_id": "CN:TEST", "currency": currency, "quantity": "10", "target_account_id": "b"}}])
            missing_price = prepare_valuation(db, "p", stamp(NOW), rules(), mode="restated", now=NOW)
            self.assertIsNone(missing_price.nav_cny)
            self.assertEqual(missing_price.quality, "blocked")
            publish_security_prices(db, currency, split=False)
            after_price = prepare_valuation(db, "p", stamp(NOW), rules(), mode="restated", now=NOW)
            self.assertEqual(after_price.nav_cny, "200" if currency == "CNY" else None)
            self.assertEqual(len([item for item in after_price.items if item["item_type"] == "security_market_value"]), 0)
            self.assertEqual(len([item for item in after_price.items if item["item_type"] == "security_in_transit_market_value"]), 1)


if __name__ == "__main__":
    unittest.main()
