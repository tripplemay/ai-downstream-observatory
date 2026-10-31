"""Full fictional saved models, retained callbacks and late reviewed FX; no network."""

from copy import deepcopy
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import test_confirmed_feed as feed, test_data_pipeline as pipeline, test_monitor_data as fixtures
from worker.investor import confirmed_feed, monitor_admission
from worker.investor.data_evidence import store_source, review_source
from worker.investor.monitor_data import build_monitor_data, resolve_monitor_data
from worker.market.providers import longport, longport_confirmed
from worker.orchestration.db import WorkbenchError, open_database
from worker.orchestration.runtime import run_pending_once


END = "2026-01-04T21:01:02.000Z"
LATE = "2026-01-04T21:02:02.000Z"


class CurrentFxFeedTests(unittest.TestCase):
    setUp = feed.ConfirmedFeedTests.setUp
    model = feed.ConfirmedFeedTests.model
    watch = feed.ConfirmedFeedTests.watch
    assert_no_finance = feed.ConfirmedFeedTests.assert_no_finance
    monitor_fixture = pipeline.DataPipelineCliTests.monitor_fixture

    def callback(self):
        result, calls, _ = self.watch(start="2026-01-04T20:58:00.000Z", end=END)
        self.assertEqual((result["status"], calls), ("succeeded", 1))

    def initial_fx(self):
        windows = confirmed_feed._windows(self.db, "w", json.loads(self.seed["document_json"]))
        identifier = windows[0][1]["fx_review_ids"][0]
        return self.db.execute("SELECT * FROM investor_data_reviews WHERE id=?", (identifier,)).fetchone()

    def append_fx(self, at=LATE, *, label="current", series=True, conflict=False, date="2026-01-04"):
        facts = deepcopy(json.loads(self.initial_fx()["document_json"])["facts"])
        if series is False: facts.pop("monitor_series")
        elif isinstance(series, dict): facts["monitor_series"] = series
        if conflict: facts["rows"][0]["value"] = "1.9"
        facts["rows"].append({"observed_at":date+"T10:00:00Z", "assumed_available_at":date+"T10:01:00Z", "value":"1.3"})
        source = store_source(self.db,"w","synthetic-investor","fx",{"title":"FICTIONAL FX " + label,
            "reference":"synthetic://late-fx/" + label,"excerpt":"Invented regression source; not provider certification"},now=at)
        return review_source(self.db,"w","synthetic-investor",source["id"],"approved",facts,"Explicit fictional review",fixtures.EXPIRY,now=at)

    def count(self, table): return self.db.execute("SELECT count(*) FROM "+table).fetchone()[0]

    def stable_state(self):
        names = [row[0] for row in self.db.execute("""SELECT name FROM sqlite_master WHERE type='table' AND
          (name LIKE 'research_%' OR name LIKE 'investor_research_%' OR name IN
          ('investor_models','investor_model_controls','investor_plan_selections','investor_reference_plans','investor_profiles','investor_funding_plans')) ORDER BY name""")]
        return {name:[tuple(row) for row in self.db.execute("SELECT rowid,* FROM "+name+" ORDER BY rowid")] for name in names}

    def current(self, at=LATE):
        row=monitor_admission.latest_monitor_evidence(self.db,"w",self.definition["model_id"])
        value=resolve_monitor_data(self.db,"w",self.definition,json.loads(row["document_json"]),now=at)
        self.assertIsNone(value["unavailable_reason"])
        return row,value

    def test_late_fx_after_original_block_recovers_from_retained_callback_without_changing_the_block_or_calling_sdk(self):
        self.model(market="US"); self.callback(); stable=self.stable_state()
        legacy=confirmed_feed._windows(self.db,"w",json.loads(self.seed["document_json"]))
        confirmed_feed._merge_completed(self.db,"w",self.definition["model_id"],legacy,END)
        old=build_monitor_data(self.db,"w",self.definition,[window for _,window in legacy],json.loads(self.seed["document_json"])["settings"],now=END)
        self.assertIn("MONITOR_FX_EXPIRED_USD",old["projection"]["quality_gaps"])
        run_pending_once(self.db,"fictional-before-fx",clock=lambda:END)
        blocked=dict(self.db.execute("SELECT * FROM investor_confirmed_feed_admissions").fetchone())
        self.assertEqual(blocked["status"],"blocked"); self.assertEqual(self.count("investor_monitor_evidence_inputs"),1)
        self.append_fx()
        with patch.object(longport_confirmed,"collect_confirmed_days",side_effect=AssertionError("NO_CALLBACK_RETRY")) as sdk, \
                patch.object(longport,"_collect_isolated",side_effect=AssertionError("NO_HISTORY_FALLBACK")) as history:
            run_pending_once(self.db,"fictional-after-fx",clock=lambda:LATE)
            row,value=self.current()
            self.assertNotEqual(row["id"],self.seed["id"]); self.assertEqual(value["projection"]["fx"][0]["value"],"1.3")
            self.assertEqual(dict(self.db.execute("SELECT * FROM investor_confirmed_feed_admissions").fetchone()),blocked)
            self.assertEqual(self.count("investor_evidence_model_checkpoints"),2)
            self.assertEqual(self.count("investor_monitor_evidence_inputs"),2)
            self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_refresh_monitor_source'").fetchone()[0],1)
            before=self.db.total_changes
            self.assertIsNone(run_pending_once(self.db,"fictional-repeat",clock=lambda:LATE))
            self.assertEqual(self.db.total_changes,before)
            sdk.assert_not_called();history.assert_not_called()
        self.assertEqual(self.stable_state(),stable);self.assert_no_finance()

    def test_fixed_saved_us_model_keeps_checkpoint_lineage_and_policy_after_late_fx(self):
        self.model(True,market="US");self.callback()
        run_pending_once(self.db,"fictional-block",clock=lambda:END)
        first=dict(self.db.execute("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence LIMIT 1").fetchone())
        self.append_fx();stable=self.stable_state()
        run_pending_once(self.db,"fictional-current",clock=lambda:LATE)
        row,value=self.current()
        self.assertEqual(self.count("investor_evidence_model_checkpoints"),2)
        second=self.db.execute("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1").fetchone()
        self.assertEqual(second["previous_hash"],first["content_hash"])
        self.assertEqual(dict(self.db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=?",(first["id"],)).fetchone()),first)
        self.assertEqual(value["document"]["settings"],json.loads(self.seed["document_json"])["settings"])
        self.assertEqual(self.stable_state(),stable);self.assert_no_finance()

    def test_new_fx_can_refresh_a_current_closed_day_without_new_quote_or_callback(self):
        self.model(market="US");at="2026-01-03T11:00:03.000Z"
        self.append_fx(at,date="2026-01-03")
        before=resolve_monitor_data(self.db,"w",self.definition,json.loads(self.seed["document_json"]),now=json.loads(self.seed["document_json"])["created_at"])
        run_pending_once(self.db,"fictional-fx-only",clock=lambda:at)
        row,value=self.current(at)
        self.assertEqual([q["observed_at"] for q in value["projection"]["quotes"]],[q["observed_at"] for q in before["projection"]["quotes"]])
        self.assertEqual(value["projection"]["fx"][0]["value"],"1.3")
        self.assertEqual(self.count("investor_confirmed_feed_requests"),0)
        self.assertEqual(self.count("investor_monitor_evidence_inputs"),2);self.assert_no_finance()

    def test_late_fx_refresh_preserves_a_declared_annual_plan_without_creating_cash(self):
        from tests.investor.test_planned_funding_runtime import PlannedFundingRuntimeTests
        self.model(True,market="US")
        self.plan={"schema_version":"investor-funding-plan-v1","start_date":"2026-01-02","horizon_years":1,
            "evaluation_timezone":"Asia/Shanghai","initial_capital_cny":"100.01","annual_contribution_cny":"10.01",
            "first_annual_date":"2026-01-04","entry_method":"three_tranches_60_days","actual_arrivals_confirmed":False,
            "execution_authorized":False,"live_advice_eligible":False}
        PlannedFundingRuntimeTests.funding(self,at="2026-01-03T12:00:00.000Z")
        self.callback();run_pending_once(self.db,"fictional-funding-gap",clock=lambda:END);self.append_fx();stable=self.stable_state()
        run_pending_once(self.db,"fictional-funding-fx",clock=lambda:LATE)
        self.current()
        payload=self.db.execute("SELECT payload FROM investor_evidence_run_payloads ORDER BY rowid DESC LIMIT 1").fetchone()
        assessment=json.loads(bytes(payload[0]))["assessment"]
        self.assertEqual(assessment["funding_status"],"hypothetical_due")
        self.assertEqual(assessment["outcome"],"decision_required")
        self.assertEqual(self.stable_state(),stable);self.assert_no_finance()

    def test_hong_kong_saved_model_uses_its_own_close_and_hkd_series(self):
        self.model(market="HK")
        end="2026-01-04T08:01:02.000Z"
        result,calls,_=self.watch(start="2026-01-04T07:58:00.000Z",end=end)
        self.assertEqual((result["status"],calls),("succeeded",1))
        # Publish the dated HKD rate before this market's actual assessment.
        self.append_fx(at=end,date="2026-01-03")
        run_pending_once(self.db,"fictional-hkd-core",clock=lambda:end)
        _,value=self.current(end)
        self.assertEqual(value["projection"]["fx"][0]["currency"],"HKD")
        self.assertEqual({q["observed_at"] for q in value["projection"]["quotes"]},{"2026-01-04T08:00:00.000Z"})
        self.assert_no_finance()

    def test_unrelated_or_unlabelled_fresh_authority_does_not_silently_replace_a_stale_prior_series(self):
        for index,series in enumerate((False,{"authority_id":"fictional-unrelated","revision_policy":"append_only_no_restatements"})):
            if index:self.setUp()
            self.model(market="US");self.callback();self.append_fx(series=series)
            stable=self.stable_state();run_pending_once(self.db,"fictional-reject-authority",clock=lambda:LATE)
            self.assertEqual(self.count("investor_monitor_evidence_inputs"),1)
            self.assertEqual(self.db.execute("SELECT status FROM investor_confirmed_feed_admissions").fetchone()[0],"blocked")
            self.assertEqual(self.stable_state(),stable);self.assert_no_finance()

    def test_same_series_restatement_with_stale_overlap_is_not_a_source_refresh(self):
        self.model(market="US");self.callback();self.append_fx(conflict=True)
        run_pending_once(self.db,"fictional-restatement",clock=lambda:LATE)
        self.assertEqual(self.count("investor_monitor_evidence_inputs"),1)
        self.assertEqual(self.count("investor_confirmed_feed_runs"),1);self.assert_no_finance()

    def test_withdrawal_of_the_prior_source_is_not_reinterpreted_as_fresh_authority(self):
        self.model(market="US");self.callback();current=self.append_fx()
        prior=self.initial_fx()
        review_source(self.db,"w","synthetic-investor",prior["source_id"],"withdrawn",None,"Fictional withdrawal",fixtures.EXPIRY,now=LATE)
        run_pending_once(self.db,"fictional-withdrawn",clock=lambda:LATE)
        self.assertEqual(self.count("investor_monitor_evidence_inputs"),1)
        self.assertEqual(self.db.execute("SELECT decision FROM investor_data_reviews WHERE id=?",(current["id"],)).fetchone()[0],"approved")
        self.assert_no_finance()

    def test_refresh_late_audit_failure_rolls_back_input_revision_and_normal_admission_audit(self):
        self.model(market="US");self.callback();confirmed_feed.admit_completed_feeds(self.db,now=END);self.append_fx()
        revision=self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0]
        self.db.execute("CREATE TRIGGER fictional_refresh_abort BEFORE INSERT ON audit_events WHEN NEW.action='investor_refresh_monitor_source' BEGIN SELECT RAISE(ABORT,'fictional refresh failure'); END")
        with self.assertRaisesRegex(sqlite3.IntegrityError,"fictional refresh failure"):
            confirmed_feed.refresh_monitor_sources(self.db,now=LATE)
        self.assertEqual(self.count("investor_monitor_evidence_inputs"),1)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0],revision)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_admit_monitor_source'").fetchone()[0],1)
        self.assert_no_finance()

    def test_selection_change_after_input_build_rolls_back_source_but_preserves_the_original_block(self):
        self.model(market="US");self.callback();self.append_fx(at=END)
        original=confirmed_feed.admit_monitor_data
        def interpose(*args,**kwargs):
            result=original(*args,**kwargs)
            self.append_fx(at=END,label="concurrent-unrelated",series=False)
            return result
        with patch.object(confirmed_feed,"admit_monitor_data",side_effect=interpose):
            self.assertEqual(confirmed_feed.admit_completed_feeds(self.db,now=END),1)
        admission=self.db.execute("SELECT * FROM investor_confirmed_feed_admissions").fetchone()
        self.assertEqual(admission["status"],"blocked");self.assertIsNone(admission["input_id"])
        self.assertEqual(self.count("investor_monitor_evidence_inputs"),1);self.assert_no_finance()

    def test_stop_after_input_creation_rolls_back_and_readonly_or_restore_never_refresh(self):
        self.model(market="US");self.callback();confirmed_feed.admit_completed_feeds(self.db,now=END);self.append_fx()
        original=confirmed_feed.admit_monitor_data;stop=[False]
        def interpose(*args,**kwargs):result=original(*args,**kwargs);stop[0]=True;return result
        with patch.object(confirmed_feed,"admit_monitor_data",side_effect=interpose):
            with self.assertRaisesRegex(WorkbenchError,"WORKER_STOP_REQUESTED"):
                confirmed_feed.refresh_monitor_sources(self.db,now=LATE,stop_requested=lambda:stop[0])
        self.assertEqual(self.count("investor_monitor_evidence_inputs"),1)
        with patch.dict("os.environ",{"WORKBENCH_MODE":"read_only"}):
            with self.assertRaisesRegex(WorkbenchError,"READ_ONLY"):confirmed_feed.refresh_monitor_sources(self.db,now=LATE)
        marker=self.path.parent/"RESTORE_PENDING_REVIEW";marker.write_text("Fictional restore")
        with self.assertRaisesRegex(WorkbenchError,"RESTORE_PENDING_REVIEW"):confirmed_feed.refresh_monitor_sources(self.db,now=LATE)
        marker.unlink();self.assert_no_finance()

    def test_cross_connection_replay_is_zero_write_and_provider_role_cannot_publish_fx_refresh(self):
        self.model(market="US");self.callback();confirmed_feed.admit_completed_feeds(self.db,now=END);self.append_fx()
        run_pending_once(self.db,"fictional-provider",role="longport",clock=lambda:LATE)
        self.assertEqual(self.count("investor_monitor_evidence_inputs"),1)
        self.assertEqual(len(confirmed_feed.refresh_monitor_sources(self.db,now=LATE)),1)
        other=open_database(self.path);self.addCleanup(other.close);before=other.total_changes
        self.assertEqual(confirmed_feed.refresh_monitor_sources(other,now=LATE),[])
        self.assertEqual(other.total_changes,before);self.assert_no_finance()

    def test_two_currency_windows_select_once_at_one_time_and_remain_in_market_scope(self):
        from worker.investor import monitor_bootstrap
        fixture=fixtures.InvestorMonitorDataTests();fixture.db=self.db;fixture.workspace_id="w"
        original=fixtures.InvestorMonitorDataTests.reviewed
        series={"authority_id":"fictional-multi-currency","revision_policy":"append_only_no_restatements"}
        def reviewed(self,kind,facts,label):
            facts=deepcopy(facts)
            if kind=="fx":facts["monitor_series"]=deepcopy(series)
            return original(self,kind,facts,label)
        with patch.object(fixtures.InvestorMonitorDataTests,"reviewed",reviewed):
            definition,windows,settings,_=fixture.fixture(("HK","US"))
            for currency in ("HKD","USD"):
                old=self.db.execute("SELECT document_json FROM investor_data_reviews WHERE json_extract(document_json,'$.facts.currency')=? AND json_extract(document_json,'$.facts.unit')='CNY_per_unit_currency'",(currency,)).fetchone()
                facts=deepcopy(json.loads(old[0])["facts"])
                facts["rows"].append({"observed_at":"2026-01-03T11:00:00Z","assumed_available_at":"2026-01-03T11:01:00Z","value":"1.3"})
                fixture.reviewed("fx",facts,"new-"+currency)
        labelled=list(zip(("HK","US"),windows));before=self.db.total_changes
        with patch.object(monitor_bootstrap,"select_current_fx",wraps=monitor_bootstrap.select_current_fx) as select:
            confirmed_feed._refresh_fx_windows(self.db,"w",definition,labelled,settings,fixtures.NOW)
        self.assertEqual(select.call_count,1);self.assertEqual(select.call_args.args[1],{"USD","HKD"})
        projected=build_monitor_data(self.db,"w",definition,[window for _,window in labelled],settings,now=fixtures.NOW)
        self.assertEqual({row["currency"] for row in projected["projection"]["fx"]},{"USD","HKD"})
        self.assertEqual(projected["projection"]["quality_gaps"],[])
        self.assertEqual(self.db.total_changes,before);self.assert_no_finance()


if __name__=="__main__":unittest.main()
