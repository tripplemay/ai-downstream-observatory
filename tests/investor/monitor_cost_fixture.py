"""Owned temporary cost-expiry journey with invented callbacks; never live."""

import argparse
import json
import os
from pathlib import Path
import tempfile
import subprocess
from types import SimpleNamespace
from unittest.mock import patch

from tests.investor.test_confirmed_feed import ConfirmedFeedTests
from worker.investor.monitor_admission import current_monitor_model, latest_monitor_evidence
from worker.investor.monitor_data import resolve_monitor_data
from worker.investor import managed_fx
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, open_database
from worker.orchestration.jobs import claim_job, complete_job
from worker.orchestration.runtime import run_pending_once


FINANCE = ("portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports")


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--db", required=True)
    parser.add_argument("--stage", choices=("close", "expire", "race"), required=True); args = parser.parse_args()
    path = Path(args.db).resolve(strict=True)
    if path.name != "workbench.db" or path.parent.parent != Path(tempfile.gettempdir()).resolve() or not path.parent.name.startswith("etf-investor-synthetic-"):
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try:
        if any(db.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in FINANCE): raise WorkbenchError("SYNTHETIC_EMPTY_FINANCE_REQUIRED")
        models = db.execute("SELECT m.*,w.owner_id FROM investor_models m JOIN investor_workspaces w ON w.id=m.workspace_id").fetchall()
        if len(models) != 1 or models[0]["owner_id"] != "synthetic-investor": raise WorkbenchError("SYNTHETIC_ONE_SAVED_OWNER_MODEL_REQUIRED")
        model = models[0]; calls = 0
        if args.stage == "race":
            from worker.investor.evidence_monitor_runtime import discover_evidence_monitor_requests, prepare_evidence_monitor_job
            from worker.investor.implementation import implementation_hash
            clock = ["2026-01-02T12:16:04.000Z"]
            discover_evidence_monitor_requests(db, now=clock[0])
            lease = claim_job(db, "fictional-cost-race", job_type="investor_evidence_monitor", lease_seconds=300, now=clock[0])
            if lease is None: raise WorkbenchError("SYNTHETIC_COST_RACE_JOB_REQUIRED")
            job = dict(db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
            prepared = prepare_evidence_monitor_job(db, job, lease, clock=lambda: clock[0])
            original_implementation = implementation_hash()
            original_input = latest_monitor_evidence(db, model["workspace_id"], model["id"])["id"]
            if "effect" not in prepared or db.in_transaction: raise WorkbenchError("SYNTHETIC_COST_RACE_PREPARATION_REQUIRED")
            names = ("investor_observations", "investor_evidence_monitor_runs", "investor_evidence_model_checkpoints")
            before = {name: db.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in names}
            program = """import { createRequire } from 'node:module';
import { getInvestorState, executeInvestorCommand } from './web/src/server/investor/service';
const require=createRequire(process.cwd()+'/web/package.json'), Database=require('better-sqlite3');
const db=new Database(process.argv[1]), at=process.argv[2], actor={id:'synthetic-investor'};
try { const s=getInvestorState(db,actor,at), {assumption_hash,...costs}=s.monitor_costs.costs;
const receipt=executeInvestorCommand(db,actor,{action:'set_monitor_costs',model_id:s.model_watch.id,
model_hash:s.monitor_costs.model_hash,expected_cost_version:s.monitor_costs.version,expected_revision:s.revision,
idempotency_key:'fictional-concurrent-cost-change',costs:{...costs,fx_bps:'5'},validity_days:30,acknowledged_research_only:true},at);
console.log(JSON.stringify({id:receipt.resource_id})); } finally {db.close();}"""
            changed = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "-e", program, str(path), "2026-01-02T12:16:04.001Z"],
                cwd=ROOT, env={"PATH": os.environ.get("PATH", ""), "NODE_NO_WARNINGS": "1"}, capture_output=True, text=True, timeout=30)
            if changed.returncode != 0: raise WorkbenchError("SYNTHETIC_COST_RACE_COMMAND_FAILED:" + changed.stderr)
            clock[0] = "2026-01-02T12:16:04.003Z"
            complete_job(db, lease, {}, effect=prepared["effect"], now=clock[0])
            final = db.execute("SELECT status,result_json FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()
            after = {name: db.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in names}
            print(canonical_json({"status": final["status"], "result": json.loads(final["result_json"]), "unchanged": before == after,
                "implementation_unchanged": implementation_hash() == original_implementation,
                "source_input_unchanged": latest_monitor_evidence(db, model["workspace_id"], model["id"])["id"] == original_input,
                "at": clock[0], "real_provider_called": False, "real_gateway_called": False}))
            return
        at = "2026-01-04T21:01:02.000Z" if args.stage == "close" else "2026-01-03T12:05:04.000Z"
        if args.stage == "close":
            with patch.object(managed_fx.receiver, "collect_current_fx_draft", side_effect=AssertionError("OFFLINE_REFERENCE_NETWORK_FORBIDDEN")):
                result, calls, _ = ConfirmedFeedTests.watch(SimpleNamespace(db=db), start="2026-01-04T20:58:00.000Z", end=at)
            if not result or result["status"] != "succeeded" or calls != 1:
                diagnostic = {"result": result, "calls": calls,
                    "requests": [dict(row) for row in db.execute("SELECT market,session_date,not_before,latest_start,stop_at FROM investor_confirmed_feed_requests")],
                    "runs": [dict(row) for row in db.execute("SELECT status FROM investor_confirmed_feed_runs")]}
                raise WorkbenchError("SYNTHETIC_COST_CALLBACK_FAILED:" + canonical_json(diagnostic))
        run_pending_once(db, "fictional-cost-" + args.stage, role="core", clock=lambda: at)
        source = latest_monitor_evidence(db, model["workspace_id"], model["id"])
        _, definition, _ = current_monitor_model(db, model["workspace_id"], model["id"], at)
        replay = resolve_monitor_data(db, model["workspace_id"], definition, json.loads(source["document_json"]), now=at)
        print(canonical_json({"input_id": source["id"], "at": at, "projection": replay["projection"], "unavailable_reason": replay["unavailable_reason"],
            "mock_provider_calls": calls, "real_provider_called": False, "real_gateway_called": False,
            "financial_counts": {name: db.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in FINANCE}}))
    finally: db.close()


if __name__ == "__main__": main()
