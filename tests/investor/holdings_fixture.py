"""Fictional local market assertions and actual valuation code; never provider data."""

import argparse
import json
from pathlib import Path
import sys
import tempfile

from worker.market import ingest_document, value_portfolio
from worker.orchestration.db import WorkbenchError, canonical_json, open_database


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    if (path.parent.parent != Path(tempfile.gettempdir()).resolve()
            or not path.parent.name.startswith(("etf-investor-synthetic-", "etf-workbench-http-", "etf-browser-fixture-"))
            or path.name != "workbench.db"):
        raise WorkbenchError("FICTIONAL_HOLDINGS_FIXTURE_DATABASE_REQUIRED")
    request = json.loads(sys.stdin.read(1024 * 1024))
    if set(request) != {"portfolio_id", "now", "cutoff", "rules", "documents"}:
        raise WorkbenchError("FICTIONAL_HOLDINGS_FIXTURE_REQUEST_REQUIRED")
    db = open_database(path)
    try:
        for document in request["documents"]:
            if (document["batch"]["source_mode"] != "manual_verified"
                    or document["batch"]["source_evidence"] != "FICTIONAL SOFTWARE TEST ONLY, NOT PROVIDER EVIDENCE"):
                raise WorkbenchError("FICTIONAL_HOLDINGS_SOURCE_REQUIRED")
            published = ingest_document(db, document, publish=True, now=request["now"])
            if published["status"] != "published":
                raise WorkbenchError("FICTIONAL_HOLDINGS_PUBLICATION_FAILED")
        result = value_portfolio(db, request["portfolio_id"], request["cutoff"], request["rules"], "restated", now=request["now"])
        print(canonical_json({"id": result["id"], "quality": result["quality"], "nav_cny": result["nav_cny"], "real_provider_called": False}))
    finally:
        db.close()


if __name__ == "__main__":
    main()
