"""Owned temporary saved foreign model: fictional callback then late FX, never live."""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

from tests.investor import confirmed_monitor_fixture, test_monitor_data as fixtures, test_confirmed_feed as feed
from worker.investor import confirmed_feed, monitor_admission
from worker.investor.data_evidence import store_source, review_source
from worker.investor.monitor_data import resolve_monitor_data
from worker.orchestration.db import WorkbenchError, canonical_json, open_database
from worker.orchestration.runtime import run_pending_once


SEED = "2026-01-02T12:05:03.000Z"
END = "2026-01-04T21:01:02.000Z"
LATE = "2026-01-04T21:02:02.000Z"
SERIES = {"authority_id":"fictional-feed-reference-series","revision_policy":"append_only_no_restatements"}


def run(db, stage):
    models = db.execute("SELECT * FROM investor_models").fetchall()
    if len(models)!=1: raise WorkbenchError("SYNTHETIC_SINGLE_MODEL_REQUIRED")
    model=models[0];workspace=model["workspace_id"];owner=db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?",(workspace,)).fetchone()[0]
    if owner!="synthetic-investor":raise WorkbenchError("SYNTHETIC_OWNER_REQUIRED")
    _,definition,_=monitor_admission.current_monitor_model(db,workspace,model["id"],SEED if stage=="blocked" else LATE)
    if {row["listing_id"] for row in definition["targets"]}!={"US:ALPHA","US:BETA"}:raise WorkbenchError("SYNTHETIC_US_REFERENCE_REQUIRED")
    for table in ("portfolios","accounts","ledger_events","postings","position_movements","approval_events","activations","reservations","execution_reports"):
        if db.execute("SELECT count(*) FROM "+table).fetchone()[0]:raise WorkbenchError("SYNTHETIC_EMPTY_FINANCIAL_DATABASE_REQUIRED")
    if stage=="blocked":
        if db.execute("SELECT 1 FROM investor_monitor_evidence_inputs").fetchone():raise WorkbenchError("SYNTHETIC_EMPTY_MONITOR_REQUIRED")
        original=fixtures.InvestorMonitorDataTests.reviewed
        def reviewed(self,kind,facts,label):
            facts=deepcopy(facts)
            if kind=="fx":facts["monitor_series"]=deepcopy(SERIES)
            return original(self,kind,facts,label)
        with patch.object(fixtures.InvestorMonitorDataTests,"reviewed",reviewed):
            _,windows,settings,_=confirmed_monitor_fixture.create(db,definition=definition,workspace=workspace,events=False,next_calendar=True)
        seed=monitor_admission.admit_monitor_data(db,workspace,owner,model["id"],windows,settings,now=SEED)
        if run_pending_once(db,"fictional-seed",clock=lambda:SEED)["status"]!="succeeded":raise WorkbenchError("SYNTHETIC_SEED_FAILED")
        result,calls,_=feed.ConfirmedFeedTests.watch(SimpleNamespace(db=db),start="2026-01-04T20:58:00.000Z",end=END)
        if (result["status"],calls)!=("succeeded",1):raise WorkbenchError("SYNTHETIC_CALLBACK_FAILED")
        run_pending_once(db,"fictional-blocked",clock=lambda:END)
        if db.execute("SELECT status FROM investor_confirmed_feed_admissions").fetchone()[0]!="blocked":raise WorkbenchError("SYNTHETIC_EXPECTED_FX_GAP")
        return {"seed_input_id":seed["id"],"blocked_at":END,"real_provider_called":False,"real_gateway_called":False}
    if db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0]!=1:raise WorkbenchError("SYNTHETIC_ONE_PRIOR_INPUT_REQUIRED")
    seed=monitor_admission.latest_monitor_evidence(db,workspace,model["id"])
    windows=confirmed_feed._windows(db,workspace,json.loads(seed["document_json"]))
    old=db.execute("SELECT document_json FROM investor_data_reviews WHERE id=?",(windows[0][1]["fx_review_ids"][0],)).fetchone()
    facts=deepcopy(json.loads(old[0])["facts"])
    if facts.get("monitor_series")!=SERIES:raise WorkbenchError("SYNTHETIC_EXPLICIT_SERIES_REQUIRED")
    facts["rows"].append({"observed_at":"2026-01-04T20:00:00Z","assumed_available_at":"2026-01-04T20:01:00Z","value":"1.3"})
    source=store_source(db,workspace,owner,"fx",{"title":"FICTIONAL late FX","reference":"synthetic://late-fx/current","excerpt":"Invented testing source, never provider permission"},now=LATE)
    current=review_source(db,workspace,owner,source["id"],"approved",facts,"Explicit fictional append-only review",fixtures.EXPIRY,now=LATE)
    run_pending_once(db,"fictional-current-fx",clock=lambda:LATE)
    row=monitor_admission.latest_monitor_evidence(db,workspace,model["id"])
    if row["id"]==seed["id"]:raise WorkbenchError("SYNTHETIC_REFRESH_NOT_COMPLETED")
    projection=resolve_monitor_data(db,workspace,definition,json.loads(row["document_json"]),now=LATE)
    if projection["unavailable_reason"]:raise WorkbenchError("SYNTHETIC_CURRENT_SOURCE_UNAVAILABLE")
    return {"seed_input_id":seed["id"],"input_id":row["id"],"current_fx_review_id":current["id"],"at":LATE,
        "projection":projection["projection"],"real_provider_called":False,"real_gateway_called":False}


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--db",required=True);parser.add_argument("--stage",choices=("blocked","current"),required=True);args=parser.parse_args()
    path=Path(args.db).resolve(strict=True)
    if path.name!="workbench.db" or path.parent.parent!=Path(tempfile.gettempdir()).resolve() or not path.parent.name.startswith("etf-investor-synthetic-"):
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db=open_database(path)
    try: print(canonical_json(run(db,args.stage)))
    finally:db.close()


if __name__=="__main__":main()
