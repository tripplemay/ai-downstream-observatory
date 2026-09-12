from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory

from worker.orchestration.db import canonical_json, content_hash, open_database, stamp
from worker.market.synthetic import synthetic_document


ROOT = Path(__file__).resolve().parents[2]
NOW = datetime(2025, 1, 3, 10, tzinfo=timezone.utc)


def database(test):
    temporary = TemporaryDirectory(prefix="etf-market-test-")
    test.addCleanup(temporary.cleanup)
    path = Path(temporary.name) / "workbench.db"
    db = sqlite3.connect(path, isolation_level=None)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT,applied_at TEXT)")
    manifest = json.loads((ROOT / "migrations/manifest.json").read_text())
    for migration in manifest["migrations"]:
        sql = (ROOT / "migrations" / migration["file"]).read_text()
        if sha256(sql.encode()).hexdigest() != migration["sha256"]:
            raise AssertionError("migration checksum mismatch")
        db.executescript(sql)
        db.execute("INSERT INTO schema_migrations VALUES(?,?,?)", (migration["version"], migration["sha256"], stamp(NOW)))
    db.execute("PRAGMA user_version=" + str(len(manifest["migrations"])))
    db.close()
    connection = open_database(path)
    test.addCleanup(connection.close)
    return connection, path


def seed_account(db, currency="CNY"):
    now = stamp(NOW - timedelta(days=2))
    db.execute("INSERT INTO portfolios(id,name,created_at) VALUES('p','Synthetic test portfolio',?)", (now,))
    db.execute("INSERT INTO ledger_heads(portfolio_id,revision,updated_at) VALUES('p',0,?)", (now,))
    db.execute("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('a','p','test','synthetic',?,?)", (currency, now))
    db.execute("INSERT INTO instruments(id,name,created_at) VALUES('instrument','Synthetic ETF',?)", (now,))
    db.execute("""INSERT INTO listings(id,instrument_id,market,exchange,ticker,currency,created_at)
        VALUES('CN:TEST','instrument','CN','TEST','000001',?,?)""", (currency, now))


def ledger_event(db, event_id, postings=(), quantity=None, currency="CNY", effective=None, recorded=None, listing_id="CN:TEST"):
    revision = db.execute("SELECT revision FROM ledger_heads WHERE portfolio_id='p'").fetchone()[0] + 1
    effective = NOW - timedelta(days=1) if effective is None else effective
    recorded = effective if recorded is None else recorded
    payload = {"synthetic": True, "event_id": event_id}
    db.execute("""INSERT INTO ledger_events
        (id,portfolio_id,account_id,event_type,effective_at,recorded_at,source_id,idempotency_key,payload_hash,payload_json,ledger_revision,actor_id)
        VALUES(?,'p','a','synthetic_fixture',?,?,'test',?,?,?,?, 'test')""",
               (event_id, stamp(effective), stamp(recorded), event_id, content_hash(payload), canonical_json(payload), revision))
    for index, (name, amount) in enumerate(postings):
        db.execute("INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES(?,?,'a',?,?,?)",
                   (event_id + ":p:" + str(index), event_id, currency, name, amount))
    if quantity is not None:
        db.execute("""INSERT INTO position_movements(id,event_id,account_id,listing_id,quantity,cost_amount,currency)
            VALUES(?,?,'a',?,?,'0',?)""", (event_id + ":movement", event_id, listing_id, quantity, currency))
    db.execute("UPDATE ledger_heads SET revision=?,updated_at=? WHERE portfolio_id='p'", (revision, stamp(recorded)))


def document(batch_id="batch:1", price="10", revision=0, source_mode="manual_verified", observed=None, currency="CNY"):
    result = synthetic_document(batch_id, "CN:TEST", currency=currency, price=price, scope="prices:CN",
                                expected_publication_revision=revision, observed_at=observed or NOW - timedelta(hours=3))
    result["batch"]["source_mode"] = source_mode
    if source_mode == "manual_verified":
        result["batch"]["source_evidence"] = "Synthetic test evidence, isolated test database only"
        row = result["pages"][0]["observations"][0]
        row["provenance"] = "live_observed"
        row["published_at"] = row["observed_at"]
    return result


def rules():
    return {"schema_version": "valuation-rules-v1", "approved": True,
            "approval_evidence": "Synthetic fixture rules, not an investment authorization",
            "price_scope_by_market": {"CN": "prices:CN"}, "expected_sessions": {"CN": "2025-01-03"},
            "corporate_actions_complete": {"CN:TEST": True}, "max_fx_age_seconds": 86400}
