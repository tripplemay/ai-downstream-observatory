"""Fictional durable history downloads through the real role/runner, no network."""

from contextlib import closing,contextmanager
from datetime import datetime,timedelta
from decimal import Decimal
import json
import sqlite3
from unittest.mock import patch
from zoneinfo import ZoneInfo

from worker.investor import epoch_history_jobs as history, epoch_history_plan as planner, data_evidence as evidence, epoch_continuation as epochs, eodhd_sources
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError,instant,open_database
from worker.orchestration.jobs import claim_job,complete_job,enqueue_job,run_one
from worker.orchestration.runtime import run_pending_once,command_handler
from tests.investor import epoch_continuation_source_fixture as sources

NOW=sources.NOW


def body(case,at=NOW,*,calls=2,key="fictional-explicit-history-download"):
    plan=planner.plan_epoch_history(case.db,"w","owner",case.epoch_id,now=at)
    return {"schema_version":"investor-epoch-history-submit-v1","epoch_id":case.epoch_id,"planned_at":at,"expected_plan_hash":plan["plan_hash"],
        "expected_revision":plan["workspace_revision"],"max_calls":calls,"idempotency_key":key,"acknowledgements":{k:True for k in history.ACKS}}


def confirm(case,request=None,at=NOW):
    request=request or body(case,at)
    return history.prepare_epoch_history_confirmation(case.db,"w","owner",request,owner_interaction=True,now=at)(case.db)


@contextmanager
def transport(case,clock,*,fail_on=None):
    calls=[];millis,parse=evidence._milliseconds,evidence.instant
    def collect(request):
        case.assertFalse(case.db.in_transaction,"SDK must not hold a writer/read snapshot")
        with closing(open_database(case.path,read_only=True)) as independent:
            marker=independent.execute("SELECT * FROM investor_epoch_history_attempts ORDER BY rowid DESC LIMIT 1").fetchone()
            case.assertIsNotNone(marker,"reservation must be committed before even an unknown I/O")
            case.assertEqual(independent.execute("SELECT status FROM job_runs WHERE id=?",(marker["job_id"],)).fetchone()[0],"running")
        calls.append(request)
        if fail_on and len(calls)==fail_on:raise RuntimeError("FICTIONAL_UNKNOWN_TRANSPORT_DO_NOT_RETRY")
        started=clock[0];returned=millis(instant(started)+timedelta(milliseconds=100));price=Decimal("10" if request["mapping"]["listing_id"]=="synthetic-0928" else "20")
        candles=[{"timestamp":datetime.fromisoformat(d).replace(tzinfo=ZoneInfo(longport._MARKETS[request["mapping"]["market"]][0])),"open":price,"high":price,"low":price,"close":price,
            "volume":1000,"turnover":price*1000,"trade_session":0} for d in request["expected_dates"]]
        result=longport._normalize(candles,request=request,sdk_version=longport.SDK_VERSION,call_started_at=started,call_returned_at=returned,
            datetime_basis="runtime_utc_from_unix_timestamp",collector_runtime="isolated_official_sdk")
        clock[0]=returned;return result
    with patch.object(longport,"_collect_isolated",side_effect=collect) as sdk, \
            patch.object(longport,"read_private_credentials_file",side_effect=AssertionError("NO_FIXTURE_CREDENTIALS")), \
            patch("socket.create_connection",side_effect=AssertionError("NO_FIXTURE_NETWORK")),patch("socket.getaddrinfo",side_effect=AssertionError("NO_FIXTURE_DNS")), \
            patch.object(evidence,"_milliseconds",side_effect=lambda value=None:millis(clock[0] if value is None else value)), \
            patch.object(evidence,"instant",side_effect=lambda value=None:parse(clock[0] if value is None else value)):
        yield calls,sdk


def default(case,clock):
    job=run_pending_once(case.db,"fictional-default-history-role",role="longport",clock=lambda:clock[0])
    case.assertIsNotNone(job);case.assertEqual(job["job_type"],history.JOB_TYPE,job)
    return job


def confirmation(case):
    case.seed();request=body(case);before=list(case.db.iterdump())
    for changed in ({"max_calls":5},{"trading_permission":True},{"acknowledgements":{**request["acknowledgements"],"no_trading":False}}):
        with case.assertRaises(WorkbenchError):history.prepare_epoch_history_confirmation(case.db,"w","owner",{**request,**changed},owner_interaction=True,now=NOW)
    with case.assertRaisesRegex(WorkbenchError,"OWNER_INTERACTION_REQUIRED"):history.prepare_epoch_history_confirmation(case.db,"w","owner",request,now=NOW)
    prepared=history.prepare_epoch_history_confirmation(case.db,"w","owner",request,owner_interaction=True,now=NOW)
    case.assertEqual(before,list(case.db.iterdump()))
    enqueued=history.enqueue_job;count=[0]
    def fail_second(*args,**kwargs):
        count[0]+=1
        if count[0]==2:raise WorkbenchError("FICTIONAL_LATE_BATCH_CONFIRMATION_FAILURE")
        return enqueued(*args,**kwargs)
    with patch.object(history,"enqueue_job",side_effect=fail_second):
        with case.assertRaisesRegex(WorkbenchError,"FICTIONAL_LATE_BATCH_CONFIRMATION_FAILURE"):prepared(case.db)
    case.assertEqual(count[0],2);case.assertEqual(before,list(case.db.iterdump()))
    with patch.object(history,"plan_epoch_history",side_effect=AssertionError("NO_HEAVY_REPLAY_IN_WRITER")):
        doc=prepared(case.db)
    row,_=history.request_header(case.db,"w","owner",doc["request_id"],NOW);case.assertEqual(row["authorized_calls"],2)
    case.assertEqual(case.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0],request["expected_revision"]+1)
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_attempts").fetchone()[0],0)
    case.assertEqual(case.db.execute("SELECT count(*) FROM job_runs WHERE job_type=? AND max_attempts=1 AND attempt_count=0",(history.JOB_TYPE,)).fetchone()[0],2)
    after=list(case.db.iterdump())
    with patch.object(history,"plan_epoch_history",side_effect=AssertionError("NO_NONCE_REPLAN_OR_REENQUEUE")):
        case.assertEqual(confirm(case,request),doc)
    case.assertEqual(after,list(case.db.iterdump()))
    with case.assertRaisesRegex(WorkbenchError,"DUPLICATE_CONFLICT"):confirm(case,{**request,"max_calls":1})
    with patch.dict("os.environ",{"WORKBENCH_MODE":"read_only"}):
        with case.assertRaisesRegex(WorkbenchError,"WORKBENCH_READ_ONLY"):confirm(case,request)
    marker=case.path.parent/"RESTORE_PENDING_REVIEW";marker.touch(mode=0o600)
    try:
        with case.assertRaisesRegex(WorkbenchError,"RESTORE_PENDING_REVIEW"):confirm(case,request)
    finally:marker.unlink()
    case.assertEqual(after,list(case.db.iterdump()))
    with case.assertRaises(WorkbenchError):history.request_header(case.db,"w","foreign",doc["request_id"],NOW)
    for table in ("portfolios","accounts","ledger_events","postings"):case.assertEqual(case.db.execute("SELECT count(*) FROM "+table).fetchone()[0],0)


def positive(case):
    case.seed()
    from tests.investor.epoch_source_fixture import current
    with patch.object(current,"prices",return_value=None):sources.next_sources(case.db,case.saved)
    parent=confirm(case);clock=[NOW];initial=case.saved["checkpoint"]
    with transport(case,clock) as (calls,sdk):
        first=default(case,clock);case.assertEqual(first["status"],"succeeded",first)
        case.assertIsNone(claim_job(case.db,"fictional-too-close-second",job_type=history.JOB_TYPE,now=clock[0]))
        clock[0]=evidence._milliseconds(instant(clock[0])+timedelta(seconds=1))
        second=default(case,clock);case.assertEqual(second["status"],"succeeded",second)
    case.assertEqual(len(calls),2);case.assertEqual(sdk.call_count,2)
    case.assertTrue(all(r["expected_dates"]==["2026-10-20"] for r in calls))
    case.assertEqual(planner.plan_epoch_history(case.db,"w","owner",case.epoch_id,now=clock[0])["missing_date_count"],0)
    for table in ("requests","slots","attempts","runs"):
        table="investor_epoch_history_"+table
        for sql in ("UPDATE "+table+" SET actor_id=actor_id","DELETE FROM "+table):
            with case.assertRaisesRegex(sqlite3.IntegrityError,"immutable"):case.db.execute(sql)
    continued=run_pending_once(case.db,"fictional-history-then-default-core",clock=lambda:clock[0])
    case.assertEqual(continued["status"],"succeeded",continued)
    case.assertEqual(json.loads(continued["result_json"])["status"],"epoch_continuation_published")
    chain=epochs.read_epoch_continuation_chain(case.db,"w","owner",case.epoch_id,now=clock[0]);state=chain["source"]["candidate"]["checkpoint"]
    for k in ("initial_notional_cny","initialized_at","epoch_binding","quantities"):case.assertEqual(state[k],initial[k],k)
    case.assertEqual(state["sequence"],initial["sequence"]+1)
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_runs WHERE status='collected'").fetchone()[0],2)
    case.assertEqual(history.request_header(case.db,"w","owner",parent["request_id"],clock[0])[1],parent)
    case.assertEqual(case.db.execute("PRAGMA foreign_key_check").fetchall(),[]);case.assertEqual(case.db.execute("PRAGMA integrity_check").fetchone()[0],"ok")
    for table in ("portfolios","accounts","ledger_events","postings"):case.assertEqual(case.db.execute("SELECT count(*) FROM "+table).fetchone()[0],0)


def partial(case):
    case.seed();request=body(case);parent=confirm(case,request);clock=[NOW]
    with transport(case,clock,fail_on=2) as (calls,sdk):
        first=default(case,clock);case.assertEqual(first["status"],"succeeded",first)
        retained=[tuple(r) for r in case.db.execute("SELECT * FROM investor_price_captures")]
        clock[0]=evidence._milliseconds(instant(clock[0])+timedelta(seconds=1))
        last=default(case,clock);case.assertEqual(last["status"],"failed",last)
        case.assertEqual(json.loads(last["result_json"])["code"],"EPOCH_HISTORY_TRANSPORT_UNKNOWN")
    case.assertEqual(len(calls),2);case.assertEqual(sdk.call_count,2)
    case.assertEqual(retained,[tuple(r) for r in case.db.execute("SELECT * FROM investor_price_captures")])
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_attempts").fetchone()[0],2)
    before=list(case.db.iterdump());case.assertEqual(confirm(case,request),parent);case.assertEqual(before,list(case.db.iterdump()))
    fresh=body(case,clock[0],calls=1,key="fictional-new-nonce-cannot-resend-unknown")
    with case.assertRaisesRegex(WorkbenchError,"PRIOR_DOWNLOAD_UNRESOLVED"):confirm(case,fresh,clock[0])
    case.assertEqual(before,list(case.db.iterdump()))
    with patch.object(longport,"_collect_isolated",side_effect=AssertionError("NO_AUTOMATIC_HISTORY_RETRY")) as no_retry:
        case.assertIsNone(claim_job(case.db,"fictional-history-no-retry",job_type=history.JOB_TYPE,now=clock[0]))
    no_retry.assert_not_called()


def final_fences(case):
    case.seed();parent=confirm(case,body(case,calls=1));clock=[NOW]
    lease=claim_job(case.db,"fictional-history-final-fence",job_type=history.JOB_TYPE,lease_seconds=1200,now=NOW)
    case.assertIsNotNone(lease);job=dict(case.db.execute("SELECT * FROM job_runs WHERE id=?",(lease.job_id,)).fetchone())
    before_captures=[tuple(r) for r in case.db.execute("SELECT * FROM investor_price_captures")]
    with transport(case,clock) as (calls,sdk):
        prepared=history.prepare_epoch_history_job(case.db,job,lease,clock=lambda:clock[0])
        case.assertEqual(len(calls),1);case.assertEqual(sdk.call_count,1)
        before=list(case.db.iterdump());audit=history._audit
        def late(*args,**kwargs):
            if args[2]=="investor_finish_epoch_history":raise WorkbenchError("FICTIONAL_LATE_HISTORY_FAILURE")
            return audit(*args,**kwargs)
        with patch.object(history,"_audit",side_effect=late),patch.object(history,"plan_epoch_history",side_effect=AssertionError("NO_HEAVY_REPLAY_IN_COMMIT")):
            with case.assertRaisesRegex(WorkbenchError,"FICTIONAL_LATE_HISTORY_FAILURE"):complete_job(case.db,lease,{},effect=prepared["effect"],now=clock[0],clock=lambda:clock[0])
        case.assertEqual(before,list(case.db.iterdump()))
        with case.assertRaises(WorkbenchError):complete_job(case.db,lease,{},effect=prepared["effect"],now=clock[0],clock=lambda:parent["valid_until"])
        case.assertEqual(before,list(case.db.iterdump()))
        case.db.execute("SAVEPOINT fictional_source_withdrawal")
        try:
            grant=case.db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
            eodhd_sources.set_authority_enabled(case.db,"w","owner",grant,False,now=clock[0])
            with case.assertRaises(WorkbenchError):complete_job(case.db,lease,{},effect=prepared["effect"],now=clock[0],clock=lambda:clock[0])
        finally:case.db.execute("ROLLBACK TO fictional_source_withdrawal");case.db.execute("RELEASE fictional_source_withdrawal")
        case.assertEqual(before,list(case.db.iterdump()))
        with case.assertRaisesRegex(WorkbenchError,"ATTEMPT_ALREADY_RESERVED"):history.prepare_epoch_history_job(case.db,job,lease,clock=lambda:clock[0])
        case.assertEqual(sdk.call_count,1)
    case.assertEqual(before_captures,[tuple(r) for r in case.db.execute("SELECT * FROM investor_price_captures")])
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_attempts").fetchone()[0],1)
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_runs").fetchone()[0],0)
    expired=evidence._milliseconds(instant(NOW)+timedelta(seconds=1201))
    case.assertIsNone(claim_job(case.db,"fictional-expired-history-no-retry",job_type=history.JOB_TYPE,now=expired))
    case.assertEqual(case.db.execute("SELECT status,attempt_count,max_attempts FROM job_runs WHERE id=?",(lease.job_id,)).fetchone()[:],("failed",1,1))


def stopped_batch(case):
    case.seed();confirm(case);clock=[NOW];retained=[tuple(r) for r in case.db.execute("SELECT * FROM investor_price_captures")]
    with transport(case,clock,fail_on=1) as (calls,sdk):
        first=default(case,clock);case.assertEqual(first["status"],"failed",first)
        clock[0]=evidence._milliseconds(instant(clock[0])+timedelta(seconds=1))
        last=default(case,clock);case.assertEqual(last["status"],"skipped",last)
        case.assertEqual(json.loads(last["result_json"])["code"],"EPOCH_HISTORY_BLOCKED_PREDECESSOR")
    case.assertEqual(sdk.call_count,1);case.assertEqual(len(calls),1)
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_attempts").fetchone()[0],1)
    case.assertEqual(retained,[tuple(r) for r in case.db.execute("SELECT * FROM investor_price_captures")])


def preclose(case):
    from worker.investor import epoch_confirmed_feed as callback
    case.seed();early="2026-10-21T19:55:00.000Z";at="2026-10-21T19:57:00.000Z"
    case.assertEqual(len(callback.discover_epoch_watches(case.db,now=early)),1)
    confirm(case,body(case,at,calls=4),at);case.assertEqual(case.db.execute("SELECT authorized_calls FROM investor_epoch_history_requests").fetchone()[0],2)
    with patch.object(longport,"_collect_isolated",side_effect=AssertionError("NO_PRECLOSE_HISTORY_CALL")) as sdk:
        case.assertIsNone(claim_job(case.db,"fictional-history-yields-to-close",job_type=history.JOB_TYPE,now=at))
        lease=claim_job(case.db,"fictional-callback-mutex",job_type=callback.JOB_TYPE,lease_seconds=1200,now="2026-10-21T19:58:00.000Z")
        case.assertIsNotNone(lease)
        case.assertIsNone(claim_job(case.db,"fictional-history-shared-mutex",job_type=history.JOB_TYPE,now="2026-10-21T19:58:00.000Z"))
        enqueue_job(case.db,"market_collect_prices","fictional-unrelated-scope","period","version",now=at)
        case.assertIsNone(claim_job(case.db,"fictional-price-shared-mutex",job_type="market_collect_prices",now="2026-10-21T19:58:00.000Z"))
        expired="2026-10-21T20:19:00.000Z"
        outcomes=[]
        for _ in range(2):
            skipped=run_one(case.db,"fictional-expired-bounded-history",command_handler(case.db,clock=lambda:expired,role="longport"),job_type=history.JOB_TYPE,clock=lambda:expired)
            case.assertEqual(skipped["status"],"skipped",skipped);outcomes.append(json.loads(skipped["result_json"])["code"])
        case.assertCountEqual(outcomes,["EPOCH_HISTORY_SUPERSEDED","EPOCH_HISTORY_BLOCKED_PREDECESSOR"])
    sdk.assert_not_called();case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_history_attempts").fetchone()[0],0)
