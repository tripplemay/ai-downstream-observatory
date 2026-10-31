"""Fictional owner approval in an owned temporary DB; no source or AI calls."""

import argparse
from copy import deepcopy
from datetime import date, timedelta
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

from worker.investor import data_evidence
from worker.investor.calendar_continuation import current_calendar_review
from worker.investor.source_inputs import source_unavailable_reason
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, canonical_json, open_database

AT = "2026-01-03T12:00:03.000Z"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--mode", choices=("append", "append-short", "append-long", "ordinary", "withdraw"), required=True)
    args = parser.parse_args()
    filename = Path(args.db).resolve(strict=True)
    if filename.name != "workbench.db" or filename.parent.parent != Path(tempfile.gettempdir()).resolve() or not filename.parent.name.startswith("etf-investor-synthetic-"):
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(filename)
    try:
        models = db.execute("SELECT * FROM investor_models").fetchall()
        if len(models) != 1: raise WorkbenchError("SYNTHETIC_SINGLE_MODEL_REQUIRED")
        model = models[0]; workspace = model["workspace_id"]
        if db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (workspace,)).fetchone()[0] != "synthetic-investor":
            raise WorkbenchError("SYNTHETIC_OWNER_REQUIRED")
        finance = ("portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports")
        if any(db.execute("SELECT count(*) FROM " + table).fetchone()[0] for table in finance):
            raise WorkbenchError("SYNTHETIC_EMPTY_FINANCIAL_DATABASE_REQUIRED")
        plan = json.loads(db.execute("SELECT document_json FROM investor_reference_plans WHERE id=?", (model["plan_id"],)).fetchone()[0])
        source_id = plan["reference_evidence"]["source_input_id"]
        source = json.loads(db.execute("SELECT document_json FROM investor_evidence_inputs WHERE id=?", (source_id,)).fetchone()[0])
        capture_id = source["snapshot"]["capture_refs"][0]["capture_id"]
        root_id = db.execute("SELECT calendar_review_id FROM investor_price_captures WHERE id=?", (capture_id,)).fetchone()[0]
        current = current_calendar_review(db, workspace, root_id, AT)
        facts = deepcopy(current["facts"])
        day = (date.fromisoformat(facts["range_end"]) + timedelta(days=1)).isoformat()
        facts["range_end"] = day
        facts["days"].append({"date": day, "kind": "closed", "close_at": None, "available_at": None,
            "settled_at": None, "settlement_rule_known_at": None})
        with patch.object(longport, "read_private_credentials_file", side_effect=AssertionError("REAL_CREDENTIALS_FORBIDDEN")), \
                patch.object(longport, "_collect_isolated", side_effect=AssertionError("REAL_PROVIDER_FORBIDDEN")):
            expiry = "2026-01-03T12:00:05.000Z" if args.mode == "append-short" else "2028-01-01T00:00:00.000Z" if args.mode == "append-long" else current["review"]["valid_until"]
            reviewed = data_evidence.review_source(db, workspace, "synthetic-investor", current["source"]["id"],
                "withdrawn" if args.mode == "withdraw" else "approved", None if args.mode == "withdraw" else facts,
                "FICTIONAL private calendar approval reason, never provider certification", expiry, now=AT,
                continues_calendar_review_id=current["review"]["id"] if args.mode.startswith("append") else None)
            reason = source_unavailable_reason(db, workspace, source, AT)
        print(canonical_json({"source_input_id": source_id, "original_calendar_review_id": root_id,
            "new_review_id": reviewed["id"], "calendar_continuation_id": reviewed.get("calendar_continuation_id"),
            "unavailable_reason": reason, "workspace_id": workspace, "real_provider_called": False,
            "real_gateway_called": False, "financial_facts": 0}))
    finally:
        db.close()


if __name__ == "__main__":
    main()
