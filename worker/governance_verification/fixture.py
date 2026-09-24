"""Fixed isolated ledger -> valuation -> performance execution; no seeded results."""

from hashlib import sha256
import json
from pathlib import Path
import platform
import shutil
import sqlite3
import tempfile

from worker.orchestration.db import ROOT, canonical_json, open_database, stamp
from worker.market.valuation import value_portfolio
from worker.performance import prepare_performance, persist_performance
from .checker import strict_json
from .process import bounded_process, clean_environment


CHECK_ID = "E-02.cash-contribution-neutrality.v1"
FIXTURE_VERSION = "cash-contribution-neutrality-v1"
LEFT = "2026-01-01T12:00:00.000000Z"
RIGHT = "2026-01-03T12:00:00.000000Z"
NOW = "2026-01-04T00:00:00.000000Z"
RULES = {"schema_version": "valuation-rules-v1", "approved": True,
         "approval_evidence": "SYNTHETIC fixed verification fixture; not investment approval",
         "price_scope_by_market": {}, "expected_sessions": {}, "corporate_actions_complete": {},
         "max_fx_age_seconds": 0}


def _initialize(path):
    manifest = json.loads((ROOT / "migrations/manifest.json").read_text())
    db = sqlite3.connect(path, isolation_level=None)
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,filename TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)")
        for entry in manifest["migrations"]:
            sql = (ROOT / "migrations" / entry["file"]).read_bytes()
            if sha256(sql).hexdigest() != entry["sha256"]:
                raise ValueError("MIGRATION_MANIFEST_MISMATCH")
            db.executescript(sql.decode())
            db.execute("INSERT INTO schema_migrations VALUES(?,?,?,?)", (entry["version"], entry["file"], entry["sha256"], stamp()))
            db.execute("PRAGMA user_version=" + str(entry["version"]))
    finally:
        db.close()


def execute_fixture():
    node = shutil.which("node")
    script = ROOT / "web/dist/governance-fixture.mjs"
    if node is None or not script.is_file():
        raise ValueError("VERIFICATION_NODE_FIXTURE_UNAVAILABLE")
    with tempfile.TemporaryDirectory(prefix="etf-verification-synthetic-") as directory:
        path = Path(directory) / "synthetic.db"
        _initialize(path)
        output, errors = bounded_process([node, str(script), "--db", str(path)], environment=clean_environment(directory),
                                         cwd=ROOT, timeout=30, output_limit=4096, new_session=False)
        if errors:
            raise ValueError("VERIFICATION_UNEXPECTED_NODE_STDERR")
        identity = strict_json(output)
        if not isinstance(identity, dict) or set(identity) != {"portfolio_id", "account_id", "node_version"}:
            raise ValueError("VERIFICATION_NODE_IDENTITY_INVALID")
        db = open_database(path)
        try:
            portfolio = identity["portfolio_id"]
            valuations = [value_portfolio(db, portfolio, at, RULES, "restated", NOW) for at in (LEFT, RIGHT)]
            prepared = prepare_performance(db, portfolio, {"valuation_ids": [value["id"] for value in valuations],
                                                          "evaluation_timezone": "UTC"}, now=NOW)
            performance = persist_performance(db, prepared, now=NOW)
            return {"schema_version": "verification-execution-artifact-v2", "check_id": CHECK_ID,
                    "fixture_version": FIXTURE_VERSION, "data_provenance": "synthetic",
                    "fixture": {"portfolio_id": portfolio, "account_id": identity["account_id"],
                                "timeline": {"left": LEFT, "right": RIGHT, "now": NOW}},
                    "ledger": {"events": [dict(row) for row in db.execute("SELECT * FROM ledger_events ORDER BY ledger_revision")],
                               "postings": [dict(row) for row in db.execute("SELECT * FROM postings ORDER BY event_id,ledger_account")],
                               "head": dict(db.execute("SELECT * FROM ledger_heads").fetchone()),
                               "audits": [dict(row) for row in db.execute("SELECT * FROM audit_events ORDER BY created_at,id")]},
                    "valuations": [{"run": run, "items": [dict(row) for row in db.execute(
                        "SELECT * FROM valuation_items WHERE run_id=? ORDER BY item_type,id", (run["id"],))]} for run in valuations],
                    "performance": {"run": performance},
                    "runtime": {"python_version": platform.python_version(), "node_version": identity["node_version"]},
                    "process": {"exit_code": 0}}
        finally:
            db.close()


if __name__ == "__main__":
    print(canonical_json(execute_fixture()))
