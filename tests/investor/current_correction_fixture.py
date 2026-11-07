"""Actual-clock correction journey over a retained, explicitly fictional v4 model."""

import argparse
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import os
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch

from tests.investor import current_action_fixture as actions, evidence_fixture
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.investor import action_review_workflow as review, data_evidence, managed_actions, monitor_admission, monitor_bootstrap
from worker.orchestration.db import ROOT, canonical_json, content_hash, instant, open_database
from worker.orchestration.runtime import run_pending_once
from worker.market.providers import longport


def actual(): return actions.stamp(datetime.now(timezone.utc))


def timeline(at):
    today = instant(at).astimezone(actions.ZONE).date()
    event = today - timedelta(days=2)
    while event.weekday() >= 5: event -= timedelta(days=1)
    old = event - timedelta(days=45)
    while old.weekday() >= 5: old -= timedelta(days=1)
    return {"event": event, "seed": event - timedelta(days=2), "old": old}


def node(db, at, operation):
    program = """import {createRequire} from 'node:module';
import {getInvestorState,executeInvestorCommand} from './web/src/server/investor/service';
const require=createRequire(process.cwd()+'/web/package.json'),Database=require('better-sqlite3');
const db=new Database(process.argv[1]),at=process.argv[2],operation=process.argv[3],actor={id:'owner'};
const denied=()=>{throw Error('FICTIONAL_NETWORK_FORBIDDEN')};
for(const name of ['node:http','node:https'])require(name).request=denied;
require('node:net').connect=denied;globalThis.fetch=denied;
try{let s=operation==='profile'?{revision:db.prepare("SELECT revision FROM investor_workspaces WHERE id='w'").get().revision}:getInvestorState(db,actor,at),value;
if(operation==='profile')value=executeInvestorCommand(db,actor,{action:'save_profile',expected_revision:s.revision,idempotency_key:'fictional-correction-profile',
profile:{schema_version:'investor-profile-v1',horizon_years:12,loss_tolerance:'0.30',liquidity_need:'none_in_horizon',markets:['US'],
product_scope:'unleveraged_long_only_etfs',research_direction:'system_design',exclusions:[],illustrative_budget_cny:null,planned_annual_contribution_cny:null}},at);
else if(operation==='model')value=executeInvestorCommand(db,actor,{action:'save_plan',plan_id:s.plan.id,expected_revision:s.revision,idempotency_key:'fictional-correction-save'},at);
else if(operation==='costs')value=executeInvestorCommand(db,actor,{action:'set_monitor_costs',model_id:s.model_watch.id,model_hash:s.monitor_costs.model_hash,
expected_cost_version:s.monitor_costs.version,expected_revision:s.revision,idempotency_key:'fictional-correction-costs',validity_days:7,
acknowledged_research_only:true,costs:{commission_bps:'1',minimum_fee_cny:'1',fx_bps:'2',slippage_bps:'3',maximum_cost_fraction:'0.01'}},at);
else throw Error('UNKNOWN_FICTIONAL_OPERATION');
console.log(JSON.stringify(value));}finally{db.close();}"""
    result = subprocess.run([str(ROOT / "web/node_modules/.bin/tsx"), "-e", program, str(db), at, operation], cwd=ROOT,
        env={"PATH": os.environ["PATH"], "NODE_ENV": "test"}, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def core(db, at=None):
    result = []
    for _ in range(32):
        value = run_pending_once(db, "fictional-correction-construction" if at else "fictional-actual-clock-correction", **({"clock": lambda: at} if at else {}))
        if value is None: return result
        assert value["status"] in ("succeeded", "skipped"), value
        result.append({"job_type": value["job_type"], "status": value["status"]})
    raise AssertionError("FICTIONAL_CORE_DID_NOT_SETTLE")


def reviewed(db, kind, facts, at, expiry, label):
    source = data_evidence.store_source(db, "w", "owner", kind, {"title": "FICTIONAL correction " + label,
        "reference": "synthetic://current-correction/" + label, "excerpt": "Invented retained source, not provider or tax certification"}, now=at)
    return data_evidence.review_source(db, "w", "owner", source["id"], "approved", facts, "Fictional isolated correction acceptance only", expiry, now=at)


def prices(db, historical, calendar, day, at):
    captures = []
    for index, listing in enumerate(historical["listings"]):
        mapping = json.loads(listing["document_json"])["facts"]
        mapping = {key: mapping[key] for key in ("listing_id", "provider_symbol", "market", "currency")}
        request = longport._request(mapping, day.isoformat(), day.isoformat(), [day.isoformat()]); price = Decimal("10" if index == 0 else "20")
        rows = [{"timestamp": datetime.combine(day, datetime.min.time(), actions.ZONE), "open": price, "high": price, "low": price,
            "close": price, "volume": 1000, "turnover": price * 1000, "trade_session": 0}]
        projection = longport._normalize(rows, request=request, sdk_version="4.3.7", call_started_at=at, call_returned_at=at,
            datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")
        millis, parse = data_evidence._milliseconds, data_evidence.instant
        with patch.object(longport, "_collect_isolated", return_value=projection), \
                patch.object(data_evidence, "_milliseconds", side_effect=lambda value=None: millis(at if value is None else value)), \
                patch.object(data_evidence, "instant", side_effect=lambda value=None: parse(at if value is None else value)):
            value = data_evidence.collect_prices(db, "w", "owner", historical["rights"]["id"], listing["id"], calendar["id"], day.isoformat(), day.isoformat())
        captures.append(value["id"])
    return captures


def admit(db, historical, calendar, bnd, day, at, expiry, action_id):
    captures = prices(db, historical, calendar, day, at)
    observed = actions.day_at(day, 15)
    model = db.execute("SELECT id FROM investor_models WHERE workspace_id='w'").fetchone()[0]
    start, prior_rates = day.isoformat(), []
    previous = monitor_admission.latest_monitor_evidence(db, "w", model)
    if previous:
        # A head-only window would leave the transition from the old cutoff uncovered.
        snapshot = json.loads(previous["document_json"])["segments"][0]["snapshot"]
        captures.extend(ref["capture_id"] for ref in snapshot["capture_refs"])
        for ref in snapshot["review_refs"]:
            if db.execute("SELECT kind FROM investor_data_sources WHERE id=?", (ref["source_id"],)).fetchone()[0] == "fx":
                prior_rates.extend(data_evidence.resolve_review(db, "w", ref["review_id"], "fx", now=at)["facts"]["rows"])
        start = snapshot["range_start"]
    fx = reviewed(db, "fx", {"currency": "USD", "unit": "CNY_per_unit_currency", "rows": [*prior_rates,
        {"observed_at": observed, "assumed_available_at": actions.stamp(instant(observed) + timedelta(minutes=1)), "value": "1.25"}]}, at, expiry, "fx-" + day.isoformat())
    row, definition, reference = monitor_admission.current_monitor_model(db, "w", model, at)
    settings = monitor_bootstrap._settings(db, "w", row, definition, reference, at)
    value = monitor_admission.admit_monitor_data(db, "w", "owner", model, [{"capture_ids": captures, "action_review_ids": [action_id, bnd["id"]],
        "fx_review_ids": [fx["id"]], "start_date": start, "end_date": day.isoformat()}], settings, now=at, audited_action_knowledge=True)
    assert json.loads(value["document_json"])["schema_version"] == "investor-monitor-data-input-v4"
    jobs = core(db, at)
    head = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE model_id=? ORDER BY sequence DESC LIMIT 1", (model,)).fetchone()
    assert head is not None
    assert head["input_id"] == value["id"], canonical_json({"expected_input": value["id"], "actual_input": head["input_id"], "jobs": jobs,
        "last_observation": json.loads(db.execute("SELECT payload FROM investor_evidence_run_payloads ORDER BY rowid DESC LIMIT 1").fetchone()[0])["observation"]})
    return head


def prepare(db, filename):
    at = actual(); current = instant(at).astimezone(actions.ZONE)
    assert current.hour >= 1, "FICTIONAL_ACCEPTANCE_REQUIRES_NY_AFTER_01"
    dates = timeline(at); seed, event = dates["seed"], dates["event"]
    assert (current.date() - seed).days <= 6
    expiry = actions.stamp(instant(at) + timedelta(days=30))
    actions.prepare(db, at, dates=dates, listing_id="synthetic-3141")
    profile_at = actions.day_at(seed, 12)
    node(filename, profile_at, "profile")
    with patch.object(evidence_fixture, "EXPIRY", expiry):
        historical = evidence_fixture.create(db, "w", "owner", now=actions.day_at(seed, 13), fixed_policy_v2=True, research_market="US", fixed_us_etfs=True)
    core(db, actions.day_at(seed, 13))
    node(filename, actions.day_at(seed, 14), "model"); node(filename, actions.day_at(seed, 14), "costs")
    calendar_at = actions.day_at(seed, 14)
    days = [seed + timedelta(days=n) for n in range((current.date() + timedelta(days=1) - seed).days + 1)]
    calendar = reviewed(db, "calendar", {"market": "US", "range_start": seed.isoformat(), "range_end": days[-1].isoformat(), "days": [
        {"date": day.isoformat(), "kind": "full" if day in (seed, event) else "closed", "close_at": actions.day_at(day, 16) if day in (seed, event) else None,
         "available_at": actions.stamp(instant(actions.day_at(day, 16)) + timedelta(minutes=1)) if day in (seed, event) else None,
         "settled_at": actions.day_at(day + timedelta(days=1), 17) if day in (seed, event) else None,
         "settlement_rule_known_at": calendar_at if day in (seed, event) else None} for day in days]}, calendar_at, expiry, "calendar")
    bnd = reviewed(db, "actions", {"listing_id": "synthetic-0928", "range_start": seed.isoformat(), "range_end": days[-1].isoformat(),
        "coverage": "reviewed_complete", "tax_assumption": "FICTIONAL explicit test assumption", "events": []}, calendar_at, expiry, "bnd")
    issuer = db.execute("SELECT id FROM investor_issuer_authorities WHERE workspace_id='w'").fetchone()[0]
    origin_at = actions.day_at(seed + timedelta(days=1), 12)
    actions.collect(db, dates, issuer, origin_at, updated=False)
    original_publications = managed_actions.publish_current_actions(db, now=origin_at)
    assert len(original_publications) == 1 and original_publications[0]["status"] == "published", original_publications
    origin = admit(db, historical, calendar, bnd, seed, origin_at, expiry, original_publications[0]["publication_id"])
    report_at = actions.day_at(event + timedelta(days=1), 12)
    actions.collect(db, dates, issuer, report_at, updated=True)
    assert managed_actions.publish_current_actions(db, now=report_at)[0]["status"] == "blocked"
    authority = db.execute("SELECT id FROM investor_action_authorities WHERE workspace_id='w'").fetchone()[0]
    revision = db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
    preview = review.register_action_review_preview(db, "w", "owner", {"authority_id": authority, "expected_revision": revision,
        "idempotency_key": "fictional-historical-new-event-preview"}, now=report_at, owner_interaction=True)
    confirmation = review.confirm_action_review(db, "w", "owner", {"schema_version": "investor-action-review-submit-v1", "preview_id": preview["preview_id"],
        "expected_revision": preview["workspace_revision"], "idempotency_key": "fictional-historical-new-event-confirm", "enable_rule": True,
        "new_events": [{"type": "dividend", "date": event.isoformat(), "at": actions.day_at(event, 10), "pay_at": actions.day_at(event + timedelta(days=7), 16), "tax_per_unit": "0.432109"}],
        "acknowledgements": {key: True for key in ("issuer_amount_unit_and_currency", "reported_differences_seen", "explicit_research_instants", "explicit_tax_amounts",
            "unchanged_tax_assumption_applies", "reported_coverage_not_objective_absence", "no_historical_restatement", "register_new_default_off_rule")}}, now=report_at)
    head = admit(db, historical, calendar, bnd, event, report_at, expiry, confirmation["new_review_id"])
    assert head["sequence"] > origin["sequence"]
    # Only retained source construction used sampled historical stamps. From this
    # point HTTP and default core use the unmodified actual wall clock.
    fresh = actual(); assert instant(fresh).astimezone(actions.ZONE).date() == current.date(), "FICTIONAL_SOURCE_DAY_ROLLED"
    calls = actions.collect(db, dates, issuer, fresh, updated=True, gross="5.32109")
    publication = managed_actions.publish_current_actions(db, now=fresh)
    assert len(publication) == 1 and publication[0]["status"] == "blocked", publication
    core(db)
    return {"fixture": "fictional_retained_v4_correction", "actual_application_clock": True, "historical_construction_only": True,
        "event_date": event.isoformat(), "effective_at": actions.day_at(event, 10), "payment_at": actions.day_at(event + timedelta(days=7), 16),
        "source_calls": calls, "source_day": current.date().isoformat(), "original_head_id": head["id"], "original_head_hash": head["content_hash"],
        "model_id": head["model_id"], "real_provider_called": False}


def inspect(db):
    names = ("investor_models", "investor_model_controls", "investor_evidence_model_checkpoints", "investor_evidence_checkpoint_payloads", "investor_monitor_evidence_inputs")
    return {"old_chain_hash": content_hash({name: [[value.hex() if isinstance(value, bytes) else value for value in row]
        for row in db.execute("SELECT rowid,* FROM " + name + " ORDER BY rowid")] for name in names}),
        "counts": {name: db.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in (*names, "investor_correction_consent_requests", "investor_correction_consents", "investor_correction_consent_results")},
        "financial": {name: db.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in actions.FINANCE}}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--db", required=True); parser.add_argument("--stage", choices=("prepare", "tick", "inspect", "withdraw"), required=True)
    args = parser.parse_args(); path = Path(args.db).resolve(strict=True)
    assert path.name == "workbench.db" and path.parent.parent == Path(tempfile.gettempdir()).resolve() and path.parent.name.startswith("etf-correction-http-")
    with offline_protocol_fixture():
        db = open_database(path)
        try:
            assert all(db.execute("SELECT count(*) FROM " + name).fetchone()[0] == 0 for name in actions.FINANCE)
            if args.stage == "prepare": value = prepare(db, path)
            elif args.stage == "tick": value = {"jobs": core(db), "actual_application_clock": True}
            elif args.stage == "inspect": value = inspect(db)
            else:
                from worker.investor import eodhd_sources
                grant = db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchall(); assert len(grant) == 1
                eodhd_sources.set_authority_enabled(db, "w", "owner", grant[0][0], False, now=actual())
                value = {"supplier_withdrawn": True, "real_provider_called": False}
            assert all(db.execute("SELECT count(*) FROM " + name).fetchone()[0] == 0 for name in actions.FINANCE)
            print(canonical_json(value))
        finally: db.close()


if __name__ == "__main__": main()
