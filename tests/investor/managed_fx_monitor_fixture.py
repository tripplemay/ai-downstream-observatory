"""Fictional saved US model, standing reference FX and ordinary monitor flow."""

import argparse
from contextlib import nullcontext
from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

from tests.investor import evidence_fixture, confirmed_monitor_fixture, test_confirmed_feed as feed
from tests.investor.fixtures import monitor_input
from tests.investor.test_managed_fx import Collector, policy, rates
from worker.investor import managed_fx as fx, monitor_admission, confirmed_feed, monitor_bootstrap
from worker.investor.data_evidence import review_source
from worker.investor.source_inputs import admit_evidence_input
from worker.investor.monitor_data import resolve_monitor_data
from worker.orchestration.db import WorkbenchError, canonical_json, open_database
from worker.orchestration.runtime import run_pending_once


STUDY_AT = "2026-01-02T12:00:03.000Z"
SEED = "2026-01-02T12:05:03.000Z"
NEXT = "2026-01-04T12:00:03.000Z"
END = "2026-01-04T21:01:02.000Z"
FINANCE = ("portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports")


def output(db, model, at, calls):
    _, definition, _ = monitor_admission.current_monitor_model(db, model["workspace_id"], model["id"], at)
    latest = monitor_admission.latest_monitor_evidence(db, model["workspace_id"], model["id"])
    projected = resolve_monitor_data(db, model["workspace_id"], definition, json.loads(latest["document_json"]), now=at)
    return {"at": at, "model_id": model["id"], "workspace": model["workspace_id"], "input_id": latest["id"],
        "projection": projected["projection"], "unavailable_reason": projected["unavailable_reason"],
        "fx_mock_calls": calls, "real_provider_called": False, "real_gateway_called": False,
        "checkpoints": db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0]}


def run(db, stage, fixed=False, owner_costs=False, legacy_seed=False):
    for name in FINANCE:
        if db.execute("SELECT count(*) FROM " + name).fetchone()[0]: raise WorkbenchError("SYNTHETIC_EMPTY_FINANCE_REQUIRED")
    if stage == "history":
        row = db.execute("SELECT * FROM investor_profiles ORDER BY version DESC LIMIT 1").fetchone()
        if row is None or row["actor_id"] != "synthetic-investor": raise WorkbenchError("SYNTHETIC_OWNER_PROFILE_REQUIRED")
        values = evidence_fixture.create(db, row["workspace_id"], row["actor_id"], now=STUDY_AT, admit=False,
            research_market="US", fixed_policy_v2=fixed)
        # Freeze this fictional dated-reference ceiling BEFORE any study/model.
        # Never change an existing model's age policy to make its sources pass.
        plan = deepcopy(values["plan"]); plan["execution"]["max_fx_age_seconds"] = 518400
        source = admit_evidence_input(db, row["workspace_id"], row["actor_id"], values["captures"], values["actions"],
            [db.execute("SELECT r.id FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id WHERE s.workspace_id=? AND s.kind='fx' ORDER BY r.version DESC LIMIT 1", (row["workspace_id"],)).fetchone()[0]],
            evidence_fixture.START, evidence_fixture.END, plan, values["policy"], now=STUDY_AT)
        return {"source_input_id": source["id"], "frozen_max_fx_age_seconds": 518400, "real_provider_called": False, "real_gateway_called": False}
    models = db.execute("SELECT * FROM investor_models").fetchall()
    if len(models) != 1: raise WorkbenchError("SYNTHETIC_ONE_SAVED_MODEL_REQUIRED")
    model = models[0]; workspace = model["workspace_id"]
    owner = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (workspace,)).fetchone()[0]
    if owner != "synthetic-investor": raise WorkbenchError("SYNTHETIC_OWNER_REQUIRED")
    if stage == "seed":
        if db.execute("SELECT 1 FROM investor_monitor_evidence_inputs").fetchone(): raise WorkbenchError("SYNTHETIC_EMPTY_MONITOR_REQUIRED")
        if bool(db.execute("SELECT 1 FROM investor_monitor_cost_assumptions").fetchone()) != owner_costs:
            raise WorkbenchError("SYNTHETIC_EXPLICIT_OWNER_COST_MODE_REQUIRED")
        _, definition, _ = monitor_admission.current_monitor_model(db, workspace, model["id"], SEED)
        _, windows, _, _ = confirmed_monitor_fixture.create(db, definition=definition, workspace=workspace, events=False, next_calendar=True)
        # These NEW fixture-only manual current reviews are never used as input.
        # The original immutable historical research reviews are untouched.
        for identity in {identity for window in windows for identity in window["fx_review_ids"]}:
            row = db.execute("SELECT * FROM investor_data_reviews WHERE id=?", (identity,)).fetchone()
            review_source(db, workspace, owner, row["source_id"], "withdrawn", None, "Fixture uses managed reference FX, not this unused manual input", "2027-01-01T00:00:00Z", now=SEED)
        grant = fx.register_authority(db, workspace, owner, policy(currencies=["USD"]), now=SEED)
        fx.set_authority_enabled(db, workspace, owner, grant["id"], True, now=SEED)
        collector = Collector(rates(("2026-01-01", "2025-12-31")), SEED)
        with patch.object(fx.receiver, "collect_current_fx_draft", side_effect=collector):
            completed = run_pending_once(db, "fictional-first-reference-provider", role="longport", lease_seconds=180, clock=lambda: SEED)
        if not completed or completed["status"] != "succeeded" or collector.calls != 1: raise WorkbenchError("SYNTHETIC_FX_INITIAL_CAPTURE_FAILED")
        original_admission = monitor_bootstrap.admit_monitor_data
        def legacy_first_input(*args, **kwargs):
            assert kwargs.pop("audited_action_knowledge") is True
            return original_admission(*args, **kwargs, audited_action_knowledge=False)
        # Explicit isolated legacy fixture, never migrate an existing input or
        # expose a protocol selector in the ordinary production bootstrap.
        with patch.object(monitor_bootstrap, "admit_monitor_data", side_effect=legacy_first_input) if legacy_seed else nullcontext():
            run_pending_once(db, "fictional-first-reference-core", role="core", clock=lambda: SEED)
        value = output(db, model, SEED, collector.calls)
        reasons = [json.loads(row[0])["reason_codes"] for row in db.execute("SELECT document_json FROM investor_evidence_monitor_runs")]
        expected = value["checkpoints"] == 1 and len(reasons) == 1 and "CANNOT_COMPARE_CHANGE_COST" not in reasons[0] if owner_costs else value["checkpoints"] == 0 and reasons == [["CANNOT_COMPARE_CHANGE_COST"]]
        if value["unavailable_reason"] or not expected:
            diagnostic = {"unavailable_reason": value["unavailable_reason"], "checkpoints": value["checkpoints"],
                "quality_gaps": value["projection"].get("quality_gaps") if value["projection"] else None,
                "monitor_runs": [json.loads(row[0])["reason_codes"] for row in db.execute("SELECT document_json FROM investor_evidence_monitor_runs")],
                "jobs": [dict(row) for row in db.execute("SELECT job_type,status,result_json FROM job_runs ORDER BY rowid")]}
            raise WorkbenchError("SYNTHETIC_MANAGED_BOOTSTRAP_FAILED:" + canonical_json(diagnostic))
        value["expected_cost_gap"] = None if owner_costs else "CANNOT_COMPARE_CHANGE_COST"
        return value
    if stage == "costs":
        at = "2026-01-02T12:05:04.000Z"
        previous = monitor_admission.latest_monitor_evidence(db, workspace, model["id"])
        document = json.loads(previous["document_json"])
        if document["settings"]["policy"]["costs"] is not None: raise WorkbenchError("SYNTHETIC_UNKNOWN_COSTS_REQUIRED")
        settings = deepcopy(document["settings"])
        # Explicit invented owner assumptions, not fees inferred from research
        # or a silent production default. Source/model limits stay frozen.
        settings["policy"]["costs"] = monitor_input()["policy"]["costs"]
        windows = [window for _, window in confirmed_feed._windows(db, workspace, document)]
        monitor_admission.admit_monitor_data(db, workspace, owner, model["id"], windows, settings, now=at,
            audited_action_knowledge=document["schema_version"] == "investor-monitor-data-input-v4")
        completed = run_pending_once(db, "fictional-explicit-cost-core", role="core", clock=lambda: at)
        value = output(db, model, at, 0)
        if not completed or completed["status"] != "succeeded" or value["unavailable_reason"] or value["checkpoints"] != 1:
            raise WorkbenchError("SYNTHETIC_EXPLICIT_COST_MONITOR_FAILED")
        return value
    if stage == "advance":
        collector = Collector(rates(("2026-01-03", "2026-01-02", "2026-01-01", "2025-12-31")), NEXT)
        with patch.object(fx.receiver, "collect_current_fx_draft", side_effect=collector):
            completed = run_pending_once(db, "fictional-next-reference-provider", role="longport", lease_seconds=180, clock=lambda: NEXT)
        if not completed or completed["status"] != "succeeded" or collector.calls != 1: raise WorkbenchError("SYNTHETIC_FX_NEXT_CAPTURE_FAILED")
        run_pending_once(db, "fictional-next-reference-core", role="core", clock=lambda: NEXT)
        result, calls, _ = feed.ConfirmedFeedTests.watch(SimpleNamespace(db=db), start="2026-01-04T20:58:00.000Z", end=END)
        if not result or result["status"] != "succeeded" or calls != 1: raise WorkbenchError("SYNTHETIC_FX_CONFIRMED_CAPTURE_FAILED")
        run_pending_once(db, "fictional-next-quote-core", role="core", clock=lambda: END)
        value = output(db, model, END, collector.calls)
        if value["unavailable_reason"] or value["checkpoints"] < 2: raise WorkbenchError("SYNTHETIC_MANAGED_ADVANCE_FAILED")
        return value
    at = "2026-01-04T21:02:02.000Z"
    grant = db.execute("SELECT * FROM investor_fx_authorities WHERE workspace_id=?", (workspace,)).fetchone()
    fx.set_authority_enabled(db, workspace, owner, grant["id"], False, now=at)
    run_pending_once(db, "fictional-source-withdrawal-core", role="core", clock=lambda: at)
    return {"at": at, "workspace": workspace, "model_id": model["id"], "raw_fx_payload_count": db.execute("SELECT count(*) FROM investor_fx_payloads").fetchone()[0],
        "real_provider_called": False, "real_gateway_called": False}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--db", required=True)
    parser.add_argument("--stage", choices=("history", "seed", "costs", "advance", "withdraw"), required=True)
    parser.add_argument("--fixed-policy-v2", action="store_true")
    parser.add_argument("--owner-costs-before-seed", action="store_true")
    parser.add_argument("--legacy-monitor-input", action="store_true"); args = parser.parse_args()
    if args.owner_costs_before_seed and args.stage != "seed": raise WorkbenchError("SYNTHETIC_OWNER_COSTS_SEED_ONLY")
    if args.legacy_monitor_input and args.stage != "seed": raise WorkbenchError("SYNTHETIC_LEGACY_SEED_ONLY")
    path = Path(args.db).resolve(strict=True)
    if path.name != "workbench.db" or path.parent.parent != Path(tempfile.gettempdir()).resolve() or not path.parent.name.startswith("etf-investor-synthetic-"):
        raise WorkbenchError("SYNTHETIC_FIXTURE_DATABASE_REQUIRED")
    db = open_database(path)
    try: print(canonical_json(run(db, args.stage, args.fixed_policy_v2, args.owner_costs_before_seed, args.legacy_monitor_input)))
    finally: db.close()


if __name__ == "__main__": main()
