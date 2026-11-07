"""Read-only missing-close design for a real, explicitly active research epoch.

Planning never downloads, retries an old listener, grants use or restores advice.
"""

from datetime import timedelta
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, transaction
from . import confirmed_feed, epoch_confirmed_feed as feed, epoch_continuation as epochs, managed_actions as managed
from . import model_epoch_continuation_source as source
from .data_evidence import _fact_validation_scope, collection_binding, resolve_review
from .history_collection import MAX_BATCH_CALLS, MAX_HISTORY_DAYS
from .implementation import implementation_hash
from .model_runtime import _clock

SCHEMA = "investor-epoch-history-plan.schema.json"
ENGINE = "investor-epoch-history-planner-v1"
MAX_TILES = 128


def _check(value,code="INVALID"):
    if not value:raise WorkbenchError("INVESTOR_DATA_EPOCH_HISTORY_"+code)


def _tiles(days,available):
    result,run = [],[]
    for day in days:
        if day in available or run and (longport._day(day)-longport._day(run[0])).days>=longport.MAX_WINDOW_DAYS:
            if run:result.append(run);run=[]
        if day not in available:run.append(day)
    if run:result.append(run)
    return result


def _prior_attempts(db,workspace,model,missing,at):
    from . import initial_close
    found = []
    for kind,table,job_type,reader in (
        ("epoch_callback","investor_epoch_feed_requests",feed.JOB_TYPE,feed.request_header),
        ("legacy_callback","investor_confirmed_feed_requests",confirmed_feed.JOB_TYPE,confirmed_feed.request_header),
        ("initial_callback","investor_initial_close_requests",initial_close.JOB_TYPE,initial_close.request_header)):
        for market in sorted({m for m,_ in missing}):
            days=sorted(d for m,d in missing if m==market)
            rows=db.execute("SELECT id,market,session_date FROM "+table+" WHERE workspace_id=? AND model_id=? AND market=? AND session_date BETWEEN ? AND ? ORDER BY session_date,id LIMIT 1001",
                (workspace,model,market,days[0],days[-1])).fetchall()
            _check(len(rows)<=1000,"ATTEMPT_LIMIT")
            for row in rows:
                if (row["market"],row["session_date"]) not in missing:continue
                saved,_=reader(db,workspace,row["id"],at)
                job=db.execute("SELECT id,status,attempt_count,max_attempts FROM job_runs WHERE job_type=? AND scope=? AND period=? AND input_version=?",(job_type,workspace,saved["id"],saved["content_hash"])).fetchone()
                _check(job is None or job["max_attempts"]==1,"ATTEMPT_CHANGED")
                found.append({"kind":kind,"request":{"id":saved["id"],"content_hash":saved["content_hash"]},"market":row["market"],"session_date":row["session_date"],
                    "job_id":job["id"] if job else None,"job_status":job["status"] if job else None,"attempt_count":job["attempt_count"] if job else 0,"network_outcome_inferred":False})
                _check(len(found)<=1000,"ATTEMPT_LIMIT")
    _check(len(found)<=1000,"ATTEMPT_LIMIT")
    return found


def plan_epoch_history(db,workspace,actor,epoch_id,*,now=None,planned_at=None,stop_requested=None):
    checked=_clock(now);planned=checked if planned_at is None else _clock(planned_at)
    _check(instant(planned)<=instant(checked)<instant(planned)+timedelta(minutes=5),"PLAN_EXPIRED")
    with transaction(db,immediate=False),_fact_validation_scope():
        managed._stopped(db,stop_requested)
        control=db.execute("SELECT * FROM investor_epoch_controls WHERE epoch_id=? AND workspace_id=? ORDER BY version DESC LIMIT 1",(epoch_id,workspace)).fetchone()
        _check(control is not None and control["enabled"]==1,"EXPLICIT_ACTIVATION_REQUIRED")
        context=feed._context(db,workspace,actor,epoch_id,control["id"],checked,stop_requested=stop_requested)
        chain,activation,activation_doc,model,global_control,prior,document=context
        _check(instant(chain["root"]["registration"]["created_at"])<=instant(planned),"PLAN_BEFORE_REGISTRATION")
        definition=chain["definition"];_,_,reference=feed.current_monitor_model(db,workspace,model["id"],checked)
        specs=confirmed_feed._specs(db,workspace,document,{r["listing_id"]:r for r in definition["targets"]},checked)
        windows,choices_by_market,ranges,tiles,missing = [],{},[],[],set()
        deadline=min(chain["read_valid_until"],activation["valid_until"],_clock(instant(planned)+timedelta(minutes=5)),key=instant)
        all_expected,all_available,overlap = 0,0,False
        checkpoint=chain["source"]["candidate"]["checkpoint"]
        for market in sorted({r["market"] for r in definition["targets"]}):
            managed._stopped(db,stop_requested)
            zone=ZoneInfo(longport._MARKETS[market][0]);local=instant(checked).astimezone(zone).date().isoformat()
            start=instant(checkpoint["market_cutoffs"][market]).astimezone(zone).date().isoformat()
            target_ids=sorted(r["listing_id"] for r in definition["targets"] if r["market"]==market)
            calendars={i:resolve_review(db,workspace,specs[i]["calendar_review_id"],"calendar",now=checked) for i in target_ids}
            _check(len({v["review"]["id"] for v in calendars.values()})==1,"CALENDAR_AMBIGUOUS")
            calendar=next(iter(calendars.values()))["facts"]
            _check(calendar["range_start"]<=start<=local<=calendar["range_end"],"CALENDAR_COVERAGE_REQUIRED")
            past=[d for d in calendar["days"] if d["kind"]!="closed" and d["date"]<local and instant(d["available_at"])<=instant(checked)]
            past_end=max((d["date"] for d in past),default=start);end=max(start,past_end)
            _check(start<=end and (longport._day(end)-longport._day(start)).days<MAX_HISTORY_DAYS,"RANGE_INVALID")
            choices=source._retained_price_choices(db,workspace,reference,{"capture_ids":[],"confirmed_capture_ids":[],"end_date":end},document,market,start,checked)
            chosen=source._select_retained_prices(choices);window={**chosen,"start_date":start,"end_date":end};windows.append(window)
            available={k for _,_,scope in choices for k in scope}
            selected={(kind,i) for kind,ids in chosen.items() for i in ids}
            covered={k for kind,i,scope in choices if (kind,i) in selected for k in scope}
            overlap=overlap or covered!=available;choices_by_market[market]=choices
            ranges.append({"market":market,"checkpoint_date":start,"past_end_date":past_end,"current_local_date":local})
            for identity in target_ids:
                spec=specs[identity];asset=resolve_review(db,workspace,spec["listing_review_id"],"listing",now=checked)["facts"]
                dates=[d["date"] for d in past if start<d["date"]<=end and instant(d["close_at"])>=instant(asset["tradable_from"])
                    and (asset["tradable_until"] is None or instant(d["close_at"])<instant(asset["tradable_until"]))]
                retained={d for i,d in available if i==identity};all_expected+=len(dates);all_available+=sum(d in retained for d in dates)
                for days in _tiles(dates,retained):
                    binding=collection_binding(db,workspace,*(spec[k+"_review_id"] for k in ("rights","listing","calendar")),days[0],days[-1],checked)
                    _check(binding["request"]["expected_dates"]==days,"EXPECTED_DATES_CHANGED")
                    bound_until=min([binding[k]["review"]["valid_until"] for k in ("rights","listing","calendar")]+[binding["rights"]["facts"]["valid_until"]],key=instant)
                    deadline=min(deadline,bound_until,key=instant)
                    tile={"listing_id":identity,"symbol":asset["provider_symbol"],"market":market,"currency":asset["currency"],"start_date":days[0],"end_date":days[-1],"expected_dates":days,
                        **spec,"binding_hash":content_hash(binding)}
                    tiles.append(tile);missing.update((market,d) for d in days);_check(len(tiles)<=MAX_TILES,"TILE_LIMIT")
        budget=[{**w,"capture_ids":[i for kind,i,_ in choices_by_market[r["market"]] if kind=="capture_ids"],
            "confirmed_capture_ids":[i for kind,i,_ in choices_by_market[r["market"]] if kind=="confirmed_capture_ids"]} for w,r in zip(windows,ranges)]
        source._check_retained_budget(db,workspace,budget,checked)
        _check(instant(checked)<instant(deadline),"PLAN_EXPIRED")
        design={"schema_version":"investor-epoch-history-plan-v1","engine_version":ENGINE,"workspace_id":workspace,"actor_id":actor,"model_id":model["id"],"model_hash":model["content_hash"],
            "epoch":chain["root"]["registration"]["epoch"],"registration_hash":activation_doc["registration_hash"],"activation":epochs._ref(activation),
            "model_control":{"id":global_control["id"],"content_hash":content_hash(dict(global_control))},"input":epochs._ref(prior),"checkpoint":chain["head"]["checkpoint"],
            "workspace_revision":db.execute("SELECT revision FROM investor_workspaces WHERE id=?",(workspace,)).fetchone()[0],"source_fence":epochs._fence(db,workspace,actor),
            "implementation_hash":implementation_hash(),"planned_at":planned,"valid_until":deadline,"ranges":ranges,"tiles":tiles,
            "expected_date_count":all_expected,"retained_date_count":all_available,"missing_date_count":all_expected-all_available,
            "status":"overlap_review_required" if overlap else "download_confirmation_required" if tiles else "no_missing_past_closes",
            "prior_attempts":_prior_attempts(db,workspace,model["id"],missing,checked),"max_batch_calls":MAX_BATCH_CALLS,"max_window_days":longport.MAX_WINDOW_DAYS,
            "provider_calls":0,"database_writes":0,"future_calls_authorized":False,"current_source_eligibility_restored":False,"monitoring_resumed":False,"trading_permission":False,
            "market_values_output":False,"distribution":"private_owner_only_not_ai"}
        managed._stopped(db,stop_requested);_check(len(canonical_json(design).encode())<=131072,"PLAN_BYTES_LIMIT")
        result={**design,"plan_hash":content_hash(design),"checked_at":checked}
        validate_contract(result,SCHEMA);return result
