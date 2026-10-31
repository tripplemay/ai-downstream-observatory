"""Owned disposable DB, fictional bytes through default roles; never a live source."""

import argparse
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

from tests.investor.test_managed_fx import AT, LATER, Collector, policy, rates
from worker.investor import managed_fx as fx
from worker.orchestration.db import WorkbenchError, canonical_json, open_database
from worker.orchestration.runtime import run_pending_once


FINANCE = ("portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports")
WORKSPACE = "fictional-managed-fx-workspace"
OWNER = "synthetic-investor"


def run(db, stage):
    for table in FINANCE:
        if db.execute("SELECT count(*) FROM " + table).fetchone()[0]: raise WorkbenchError("SYNTHETIC_EMPTY_FINANCE_REQUIRED")
    if stage == "init":
        if db.execute("SELECT 1 FROM investor_fx_authorities").fetchone(): raise WorkbenchError("SYNTHETIC_FX_EMPTY_REQUIRED")
        db.execute("INSERT INTO investor_workspaces VALUES(?,?,0,?)", (WORKSPACE, OWNER, "2026-01-02T12:00:03.000Z"))
        authority = fx.register_authority(db, WORKSPACE, OWNER, policy(), now=AT)
        fx.set_authority_enabled(db, WORKSPACE, OWNER, authority["id"], True, now=AT)
    else:
        rows = db.execute("SELECT * FROM investor_fx_authorities WHERE workspace_id=?", (WORKSPACE,)).fetchall()
        if len(rows) != 1: raise WorkbenchError("SYNTHETIC_ONE_FX_AUTHORITY_REQUIRED")
        authority = rows[0]
    at = AT if stage == "init" else "2027-01-04T12:00:03.000Z" if stage == "expire" else LATER
    collector = Collector(rates(("2026-01-03", "2026-01-02", "2026-01-01"), cny="9" if stage == "restate" else "8")
        if stage in ("advance", "restate") else rates(), at)
    if stage == "withdraw": fx.set_authority_enabled(db, WORKSPACE, OWNER, authority["id"], False, now=at)
    if stage not in ("withdraw", "expire"):
        with patch.object(fx.receiver, "collect_current_fx_draft", side_effect=collector):
            result = run_pending_once(db, "fictional-source-provider", role="longport", lease_seconds=180, clock=lambda: at)
        if not result or result["status"] != "succeeded" or collector.calls != 1: raise WorkbenchError("SYNTHETIC_FX_CAPTURE_FAILED")
    run_pending_once(db, "fictional-source-core", role="core", clock=lambda: at)
    rows = db.execute("SELECT * FROM investor_fx_publications WHERE authority_id=? ORDER BY sequence", (authority["id"],)).fetchall()
    if not rows: raise WorkbenchError("SYNTHETIC_FX_PUBLICATION_REQUIRED")
    head = next(row for row in reversed(rows) if row["status"] == "published")
    doc = json.loads(head["document_json"])
    return {"workspace": WORKSPACE, "authority_id": authority["id"], "head_id": head["id"], "capture_id": head["capture_id"],
        "refs": doc["refs"], "latest_publication": json.loads(rows[-1]["document_json"]), "at": at,
        "publications": len(rows), "review_count": db.execute("SELECT count(*) FROM investor_data_reviews").fetchone()[0],
        "raw_payload_count": db.execute("SELECT count(*) FROM investor_fx_payloads").fetchone()[0],
        "models": db.execute("SELECT count(*) FROM investor_models").fetchone()[0],
        "real_provider_called": False, "real_gateway_called": False, "financial_counts": {name: db.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in FINANCE}}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--db", required=True)
    parser.add_argument("--stage", choices=("init", "advance", "unchanged", "withdraw", "restate", "expire"), required=True)
    args = parser.parse_args(); path = Path(args.db).resolve(strict=True)
    if path.name != "workbench.db" or path.parent.parent != Path(tempfile.gettempdir()).resolve() or not path.parent.name.startswith("etf-investor-synthetic-"):
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try: print(canonical_json(run(db, args.stage)))
    finally: db.close()


if __name__ == "__main__": main()
