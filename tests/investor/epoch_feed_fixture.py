"""Offline callback lifecycle on a real fictional epoch, never a provider grant."""

import json
import sqlite3
from unittest.mock import patch

from tests.investor.confirmed_capture_fixture import FictionalReceiver
from tests.investor.epoch_continuation_source_fixture import next_sources, NOW
from tests.investor.epoch_source_fixture import NOW as FIRST
from worker.investor import confirmed_capture, epoch_confirmed_feed as feed, epoch_continuation as epochs, eodhd_sources
from worker.market.providers import longport_confirmed as receiver
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant
from worker.orchestration.jobs import claim_job, complete_job, enqueue_job
from worker.orchestration.runtime import run_pending_once

EARLY = "2026-10-20T19:55:00.000Z"
START = "2026-10-20T19:58:00.000Z"
END = "2026-10-20T20:01:02.000Z"


def watch(case, *, during=None, manual=None):
    clock = [START]
    def advance():
        clock[0] = END
        if during: during()
    mock = FictionalReceiver(now=START,received_at=END,during=advance)
    millis,parse = confirmed_capture._milliseconds,confirmed_capture.instant
    with patch.object(receiver,"collect_confirmed_days",side_effect=lambda request,**kwargs:mock(request,kwargs["stop_requested"])) as transport, \
            patch.object(confirmed_capture,"_milliseconds",side_effect=lambda value=None:millis(clock[0] if value is None else value)), \
            patch.object(confirmed_capture,"instant",side_effect=lambda value=None:parse(clock[0] if value is None else value)):
        if manual:
            lease = claim_job(case.db,"fictional-epoch-feed-fence",lease_seconds=1200,job_type=feed.JOB_TYPE,now=START)
            case.assertIsNotNone(lease);job = dict(case.db.execute("SELECT * FROM job_runs WHERE id=?",(lease.job_id,)).fetchone())
            result = manual(job,lease,clock)
        else:
            result = run_pending_once(case.db,"fictional-default-epoch-feed",role="longport",clock=lambda:clock[0])
    case.assertEqual(mock.calls,1);case.assertEqual(transport.call_count,1)
    return result


def positive(case):
    case.seed();before = list(case.db.iterdump())
    case.assertEqual(feed.discover_epoch_watches(case.db,now=EARLY),[]);case.assertEqual(before,list(case.db.iterdump()))
    case.activate();case.run_core(FIRST)
    original = {table:[tuple(r) for r in case.db.execute("SELECT rowid,* FROM "+table)] for table in
        ("investor_model_epochs","investor_models","investor_evidence_model_checkpoints","investor_epoch_controls")}
    scheduled = feed.discover_epoch_watches(case.db,now=EARLY);case.assertEqual(len(scheduled),1)
    again = feed.discover_epoch_watches(case.db,now=EARLY);case.assertEqual([r["id"] for r in again],[])
    request = case.db.execute("SELECT * FROM investor_epoch_feed_requests").fetchone();doc = json.loads(request["document_json"])
    case.assertEqual(doc["epoch"],case.saved["registration"]["epoch"]);case.assertEqual(doc["session_date"],"2026-10-20")
    case.assertEqual((doc["not_before"],doc["stop_at"]),("2026-10-20T19:58:00.000000Z","2026-10-20T20:03:00.000000Z"))
    case.assertTrue(all(t["session_date"]=="2026-10-20" for t in doc["targets"]))
    result = watch(case);case.assertEqual(result["job_type"],feed.JOB_TYPE);case.assertEqual(result["status"],"succeeded",result)
    run = case.db.execute("SELECT * FROM investor_epoch_feed_runs").fetchone();case.assertEqual(run["status"],"complete")
    resolved = confirmed_capture.resolve_confirmed_capture(case.db,"w",run["capture_id"],now=END)
    case.assertEqual({r["observed_at"] for r in resolved["records"]},{"2026-10-20"})
    for table,rows in original.items():case.assertEqual(rows,[tuple(r) for r in case.db.execute("SELECT rowid,* FROM "+table)],table)
    # Prepare the next audited action/FX reports without fabricating an SDK close.
    from tests.investor.epoch_source_fixture import current
    with patch.object(current,"prices",return_value=None) as omitted_history:
        next_sources(case.db,case.saved)
    omitted_history.assert_called_once()
    continued = case.run_core(NOW);case.assertEqual(continued["result"]["status"],"epoch_continuation_published")
    chain = epochs.read_epoch_continuation_chain(case.db,"w","owner",case.epoch_id,now=NOW)
    state = chain["source"]["candidate"]["checkpoint"]
    case.assertGreater(state["sequence"],case.saved["checkpoint"]["sequence"])
    case.assertEqual(state["quantities"],case.saved["checkpoint"]["quantities"])
    for key in ("initial_notional_cny","initialized_at","epoch_binding"):
        case.assertEqual(state[key],case.saved["checkpoint"][key],key)
    refs = [r for s in chain["source"]["input"]["segments"] for r in s["snapshot"]["capture_refs"]]
    case.assertIn(run["capture_id"],{r["capture_id"] for r in refs if r.get("kind")=="confirmed_sdk"})
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_confirmed_feed_requests").fetchone()[0],0)
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_epoch_feed_requests").fetchone()[0],1)
    for table in ("portfolios","accounts","ledger_events","postings"):
        case.assertEqual(case.db.execute("SELECT count(*) FROM "+table).fetchone()[0],0)


def paused_and_budget(case):
    case.seed();case.activate();case.run_core(FIRST);feed.discover_epoch_watches(case.db,now=EARLY)
    row,doc = feed.request_header(case.db,"w",case.db.execute("SELECT id FROM investor_epoch_feed_requests").fetchone()[0],START)
    for statement in ("UPDATE investor_epoch_feed_requests SET market='HK'","DELETE FROM investor_epoch_feed_requests"):
        with case.assertRaises(sqlite3.IntegrityError):case.db.execute(statement)
    case.db.execute("SAVEPOINT fictional_legacy_duplicate")
    try:
        old = {k:v for k,v in doc.items() if k not in ("epoch","registration_hash","activation","implementation_hash")}
        old.update(schema_version="investor-confirmed-feed-request-v1",engine_version="investor-confirmed-market-producer-v1")
        from worker.investor.data_evidence import _audit
        audit = _audit(case.db,"owner","investor_schedule_confirmed_feed","investor_confirmed_feed_request","fictional-duplicate-watch",{"content_hash":content_hash(old)},START)
        with case.assertRaisesRegex(sqlite3.IntegrityError,"epoch feed session already consumed"):
            case.db.execute("INSERT INTO investor_confirmed_feed_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",("fictional-duplicate-watch","w",row["model_id"],row["control_id"],row["input_id"],
                row["market"],row["session_date"],row["not_before"],row["latest_start"],row["stop_at"],canonical_json(old),content_hash(old),"owner",START,audit))
    finally:case.db.execute("ROLLBACK TO fictional_legacy_duplicate");case.db.execute("RELEASE fictional_legacy_duplicate")
    def during():
        enqueue_job(case.db,"market_collect_prices","fictional-other-owner","same-slot","fictional-version",now=START)
        case.assertIsNone(claim_job(case.db,"fictional-concurrent-price",job_type="market_collect_prices",now=START))
        epochs.set_epoch_continuation_control(case.db,"w","owner",case.body(False,"fictional-pause-during-epoch-watch"),owner_interaction=True,now=END)
    result = watch(case,during=during);case.assertEqual(result["status"],"skipped",result)
    case.assertEqual(case.db.execute("SELECT status FROM investor_epoch_feed_runs").fetchone()[0],"superseded")
    case.assertEqual(case.db.execute("SELECT count(*) FROM investor_confirmed_captures").fetchone()[0],0)
    with patch.object(receiver,"collect_confirmed_days",side_effect=AssertionError("NO_AUTOMATIC_RETRY")):
        case.assertEqual(feed.discover_epoch_watches(case.db,now=END),[])
    case.assertEqual(case.db.execute("SELECT attempt_count,max_attempts FROM job_runs WHERE job_type=?",(feed.JOB_TYPE,)).fetchone()[:],(1,1))
    case.assertEqual(case.db.execute("SELECT enabled FROM investor_model_controls ORDER BY version DESC LIMIT 1").fetchone()[0],1)


def final_fences(case):
    case.seed();case.activate();case.run_core(FIRST)
    original = epochs.read_epoch_continuation_chain;deadline = "2026-10-20T20:04:00.000Z"
    def bounded(*args,**kwargs):
        value = original(*args,**kwargs);value["read_valid_until"] = min(value["read_valid_until"],deadline,key=instant);return value
    with patch.object(epochs,"read_epoch_continuation_chain",side_effect=bounded):
        feed.discover_epoch_watches(case.db,now=EARLY)
        def manual(job,lease,clock):
            finish = [False];actual_run = feed._run
            def publish(*args,**kwargs):
                value = actual_run(*args,**kwargs);finish[0]=True;return value
            with patch.object(feed,"_run",side_effect=publish):
                prepared = feed.prepare_epoch_watch(case.db,job,lease,clock=lambda:deadline if finish[0] else clock[0])
            before = list(case.db.iterdump())
            with patch.object(feed,"enqueue_notification",side_effect=WorkbenchError("FICTIONAL_LATE_FEED_FAILURE")):
                with case.assertRaisesRegex(WorkbenchError,"CONFIRMED_FEED_COMMIT_FAILED"):
                    complete_job(case.db,lease,{},effect=prepared["effect"],now=END,clock=lambda:END)
            case.assertEqual(before,list(case.db.iterdump()))
            with patch.object(epochs,"read_epoch_continuation_chain",side_effect=AssertionError("NO_CHAIN_REPLAY_IN_WRITER")):
                with case.assertRaisesRegex(WorkbenchError,"EPOCH_FEED_EXPIRED"):
                    complete_job(case.db,lease,{},effect=prepared["effect"],now=END,clock=lambda:deadline if finish[0] else END)
            case.assertEqual(before,list(case.db.iterdump()));finish[0]=False
            grant = case.db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
            eodhd_sources.set_authority_enabled(case.db,"w","owner",grant,False,now=END)
            revoked = list(case.db.iterdump())
            complete_job(case.db,lease,{},effect=prepared["effect"],now=END,clock=lambda:END)
            case.assertEqual(case.db.execute("SELECT status FROM investor_epoch_feed_runs").fetchone()[0],"superseded")
            case.assertEqual(case.db.execute("SELECT count(*) FROM investor_confirmed_captures").fetchone()[0],0)
            case.assertGreater(len(list(case.db.iterdump())),len(revoked))
        watch(case,manual=manual)
