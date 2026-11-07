"""Invented retained captures and owner rules; no network, credentials or trades."""

from copy import deepcopy
from datetime import datetime
from decimal import Decimal
import json
import sqlite3
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.investor import action_reconciliation_fixture as fixture
from tests.investor import test_runtime as runtime_fixture
from tests.investor import test_issuer_schedule as schedule_fixture
from tests.investor import test_data_pipeline as cli_fixture
from tests.market.test_vanguard_distributions import archive, row
from worker.investor import confirmed_feed, data_evidence, data_pipeline, eodhd_sources, issuer_sources, issuer_schedule, managed_actions as managed
from worker.investor import monitor_bootstrap, source_inputs, source_retention
from worker.investor.data_snapshot import build_dataset
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, open_database
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import run_pending_once


AT = fixture.AT
LATER = '2026-11-02T06:00:03.000Z'


class ManagedActionTests(unittest.TestCase):
    setUp = runtime_fixture.InvestorRuntimeTests.setUp
    assert_no_finance = runtime_fixture.InvestorRuntimeTests.assert_no_finance

    def prepare(self, *, official=True):
        self.members = fixture.create(self.db,official=official)
        self.member = self.members['VT.US']
        self.refs = {name:{'capture_id':self.member[key],
            'capture_hash':self.db.execute('SELECT content_hash FROM '+table+' WHERE id=?',(self.member[key],)).fetchone()[0]}
            for name,key,table in (('issuer','issuer_capture_id','investor_issuer_captures'),
                ('dividends','dividend_capture_id','investor_eodhd_captures'),('splits','split_capture_id','investor_eodhd_captures'))}
        source = data_evidence.store_source(self.db,'w','synthetic-investor','actions',{'title':'Fictional manually reviewed baseline',
            'reference':'synthetic://actions/baseline','excerpt':'Invented software fixture, never real financial evidence'},now=fixture.REGISTER)
        self.base_facts = {'listing_id':'synthetic-3141','range_start':'2025-11-02','range_end':'2026-09-30',
            'coverage':'reviewed_complete','tax_assumption':'Fictional explicit tax model; do not infer actual withholding',
            'events':[{'id':'fictional-dividend','listing_id':'synthetic-3141','type':'dividend','at':'2026-09-25T13:30:00Z',
                'published_at':'2026-09-20T04:00:00Z','pay_at':'2026-09-30T20:00:00Z','gross_per_unit':'987.1234',
                'tax_per_unit':'98.71234','source_evidence':'synthetic://fictional-owner-review'}]}
        self.base = data_evidence.review_source(self.db,'w','synthetic-investor',source['id'],'approved',self.base_facts,
            'Fictional prior manual review','2027-01-01T00:00:00.000Z',now=fixture.REGISTER)
        self.base_source = source
        return self.member

    def policy(self, **changes):
        preview = managed.preview_authority(self.db,'w','synthetic-investor',self.base['id'],self.member['listing_review_id'],self.refs,now=AT)
        return {'schema_version':'investor-action-maintenance-policy-v1',
            **{key:preview[key] for key in ('listing_id','provider_symbol','base_review_id','base_review_hash','listing_review_id',
                'listing_review_hash','anchor_captures','anchor_binding_hash')},
            'valid_from':AT,'valid_until':'2026-11-10T00:00:00.000Z','timezone':'America/New_York','run_after_hour':1,
            'standing_rule_authorized':True,'registered_nominal_differences_accepted':True,
            'coverage_basis':'selected_two_source_reports_not_objective_absence','additional_source_requests':0,
            'tax_changes_permitted':False,'trading_permission':False,'raw_ai_sharing':False,**changes}

    def grant(self, enabled=True):
        row = managed.register_authority(self.db,'w','synthetic-investor',self.policy(),now=AT)
        if enabled:managed.set_authority_enabled(self.db,'w','synthetic-investor',row['id'],True,now=AT)
        self.authority = row
        return row

    def count(self, table):
        return self.db.execute('SELECT count(*) FROM '+table).fetchone()[0]

    def next_source_day(self, issuer_raw=None):
        grant=self.db.execute('SELECT * FROM investor_issuer_authorities WHERE id=?',(self.member['issuer_authority_id'],)).fetchone()
        schedule=issuer_schedule.register_schedule(self.db,'w','synthetic-investor',
            schedule_fixture.scheduled(grant,valid_from=AT,lookback_days=365),now=AT)
        issuer_schedule.set_schedule_enabled(self.db,'w','synthetic-investor',schedule['id'],True,now=AT)
        issuer=fixture.IssuerCollector(at=LATER,raw=issuer_raw or archive(row('987.1234',exDividendDate='2026-09-25',
            recordDate='2026-09-25',payableDate='2026-09-30')))
        with patch.object(issuer_sources.receiver,'collect_vanguard_distribution_draft',side_effect=issuer):
            self.assertEqual(len(issuer_schedule.discover_issuer_requests(self.db,now=LATER)),1)
            result=run_one(self.db,'fictional-issuer-next-day',lambda job,lease:issuer_schedule.prepare_issuer_capture(
                self.db,job,lease,clock=lambda:LATER),job_type=issuer_schedule.JOB_TYPE,lease_seconds=180,clock=lambda:LATER)
            self.assertEqual(result['status'],'succeeded')
        collector=fixture.ActionCollector()
        with patch.dict('os.environ',{'WORKBENCH_EODHD_ENABLED':'1'}),patch.object(fixture,'AT',LATER), \
                patch.object(eodhd_sources.receiver,'collect_eodhd_action_draft',side_effect=collector):
            self.assertEqual(len(eodhd_sources.discover_eodhd_requests(self.db,now=LATER)),4)
            for unused in range(4):
                result=run_one(self.db,'fictional-eodhd-next-day',lambda job,lease:eodhd_sources.prepare_eodhd_capture(
                    self.db,job,lease,clock=lambda:LATER),job_type=eodhd_sources.JOB_TYPE,lease_seconds=180,clock=lambda:LATER)
                self.assertEqual(result['status'],'succeeded')
        self.assertEqual(issuer.calls,1);self.assertEqual(collector.calls,4)

    def snapshot(self, value):
        return {'valid_until':value['review']['valid_until'],'snapshot':{'review_refs':[{
            'review_id':value['review']['id'],'review_hash':value['review']['content_hash'],
            'source_id':value['source']['id'],'source_hash':value['source']['content_hash']}],'capture_refs':[]}}

    def test_disabled_rule_registration_is_audited_idempotent_and_publishes_nothing(self):
        self.prepare();policy=self.policy();original=deepcopy(policy)
        row=managed.register_authority(self.db,'w','synthetic-investor',policy,now=AT)
        self.assertEqual(policy,original)
        self.assertEqual(managed.register_authority(self.db,'w','synthetic-investor',policy,now=AT)['id'],row['id'])
        self.assertEqual(self.db.execute('SELECT enabled FROM investor_action_controls').fetchone()[0],0)
        self.assertEqual(managed.publish_current_actions(self.db,now=AT),[])
        self.assertEqual(self.count('investor_action_requests'),0)
        self.assertEqual(self.count('investor_action_publications'),0)
        self.assert_no_finance()

    def test_local_publication_has_honest_virtual_review_and_no_history_copy(self):
        self.prepare();self.grant()
        before_reviews=[list(row) for row in self.db.execute('SELECT rowid,* FROM investor_data_reviews ORDER BY rowid')]
        with patch.object(issuer_sources.receiver,'collect_vanguard_distribution_draft') as issuer, \
                patch.object(eodhd_sources.receiver,'collect_eodhd_action_draft') as eod:
            result=managed.publish_current_actions(self.db,now=AT)
        issuer.assert_not_called();eod.assert_not_called()
        self.assertEqual(len(result),1);self.assertEqual(result[0]['status'],'published')
        value=managed.resolve_managed_review(self.db,'w',result[0]['publication_id'],now=AT)
        self.assertEqual(value['facts'],{**self.base_facts,'range_end':'2026-10-31'})
        document=json.loads(value['review']['document_json'])
        self.assertEqual(document['schema_version'],'investor-data-review-v2')
        self.assertEqual(document['review_basis'],'owner_standing_no_new_actions_rule')
        self.assertFalse(result[0]['human_review_performed']);self.assertFalse(result[0]['trading_permission'])
        self.assertEqual(before_reviews,[list(row) for row in self.db.execute('SELECT rowid,* FROM investor_data_reviews ORDER BY rowid')])
        persisted=self.db.execute('SELECT document_json FROM investor_action_publications').fetchone()[0]
        for forbidden in ('987.1234','98.71234',self.base_facts['tax_assumption'],'"facts"','"events"'):
            self.assertNotIn(forbidden,persisted)
        before=self.db.total_changes
        self.assertEqual(managed.publish_current_actions(self.db,now=AT),[])
        self.assertEqual(self.db.total_changes,before)
        self.assert_no_finance()

    def test_default_core_publishes_but_provider_and_verifier_roles_do_not(self):
        self.prepare();self.grant()
        with patch.object(issuer_sources.receiver,'collect_vanguard_distribution_draft') as issuer, \
                patch.object(eodhd_sources.receiver,'collect_eodhd_action_draft') as eod:
            self.assertIsNone(run_pending_once(self.db,'fictional-provider',role='longport',clock=lambda:AT))
            self.assertIsNone(run_pending_once(self.db,'fictional-verifier',role='verifier',clock=lambda:AT))
            self.assertEqual(self.count('investor_action_publications'),0)
            self.assertIsNone(run_pending_once(self.db,'fictional-core',clock=lambda:AT))
        issuer.assert_not_called();eod.assert_not_called()
        self.assertEqual(self.db.execute('SELECT status FROM investor_action_publications').fetchone()[0],'published')
        self.assert_no_finance()

    def test_generic_resolver_and_header_only_retention_accept_the_virtual_identity(self):
        self.prepare();self.grant();publication=managed.publish_current_actions(self.db,now=AT)[0]['publication_id']
        value=data_evidence.resolve_review(self.db,'w',publication,'actions',now=AT)
        self.assertEqual(source_inputs._review_kind(self.db,'w',publication),'actions')
        header=self.db.execute('SELECT * FROM investor_review_headers WHERE id=?',(publication,)).fetchone()
        self.assertIsNone(header['document_json'])
        self.assertEqual(source_retention._review_receipt(self.db,'w',header,AT),json.loads(value['review']['document_json']))
        snapshot=self.snapshot(value)
        before=self.db.total_changes
        with patch.object(managed,'_inputs',side_effect=AssertionError('Metadata is not raw-data qualification')):
            self.assertIsNone(source_inputs.source_unavailable_reason(self.db,'w',snapshot,AT))
            self.assertIsNone(source_retention._snapshot_reason(self.db,'w',snapshot['snapshot'],snapshot['valid_until'],AT))
        self.assertEqual(self.db.total_changes,before)
        with self.assertRaises(WorkbenchError):data_evidence.resolve_review(self.db,'w',publication,'listing',now=AT)
        with self.assertRaises(WorkbenchError):data_evidence.review_header(self.db,'foreign',publication,now=AT)

    def test_disable_invalidates_derived_metadata_not_the_original_manual_reference(self):
        self.prepare();self.grant();publication=managed.publish_current_actions(self.db,now=AT)[0]['publication_id']
        value=data_evidence.resolve_review(self.db,'w',publication,'actions',now=AT)
        managed.set_authority_enabled(self.db,'w','synthetic-investor',self.authority['id'],False,now=AT)
        self.assertEqual(source_inputs.source_unavailable_reason(self.db,'w',self.snapshot(value),AT),'REFERENCE_SOURCE_NO_LONGER_CURRENT')
        self.assertEqual([r[0] for r in self.db.execute('SELECT id FROM investor_action_unavailable_headers')],[publication])
        self.assertEqual(data_evidence.review_header(self.db,'w',publication,now=AT)['review'],value['review'])
        self.assertEqual(data_evidence.resolve_review(self.db,'w',self.base['id'],'actions',now=AT)['facts'],self.base_facts)
        with self.assertRaisesRegex(WorkbenchError,'SOURCE_UNAVAILABLE'):
            data_evidence.resolve_review(self.db,'w',publication,'actions',now=AT)

    def test_expired_header_remains_verifiable_without_replaying_raw_bytes(self):
        self.prepare();self.grant();publication=managed.publish_current_actions(self.db,now=AT)[0]['publication_id']
        value=managed.resolve_managed_review(self.db,'w',publication,now=AT);expiry=value['review']['valid_until']
        with patch.object(managed,'_inputs',side_effect=AssertionError('No raw replay on expiry')):
            self.assertEqual(data_evidence.review_header(self.db,'w',publication,now=expiry)['review'],value['review'])
            self.assertEqual(managed.managed_review_unavailable(self.db,'w',publication,expiry),'REFERENCE_SOURCE_EXPIRED')
        with self.assertRaises(WorkbenchError):data_evidence.resolve_review(self.db,'w',publication,'actions',now=expiry)

    def test_current_selection_shadows_only_bound_baseline_and_filters_other_listings(self):
        self.prepare();self.grant();publication=managed.publish_current_actions(self.db,now=AT)[0]['publication_id']
        values=monitor_bootstrap._reviews(self.db,'w','actions',AT,['synthetic-3141'])
        self.assertEqual([r['review']['id'] for r in values],[publication])
        source=data_evidence.store_source(self.db,'w','synthetic-investor','actions',{'title':'Unrelated manual evidence',
            'reference':'synthetic://unrelated','excerpt':'Does not belong to this maintenance rule'},now=AT)
        other=data_evidence.review_source(self.db,'w','synthetic-investor',source['id'],'approved',self.base_facts,
            'Ambiguity must remain visible','2027-01-01T00:00:00.000Z',now=AT)
        self.assertEqual({r['review']['id'] for r in monitor_bootstrap._reviews(self.db,'w','actions',AT,['synthetic-3141'])},
            {publication,other['id']})
        with patch.object(managed,'_current_refs',return_value=(None,'SOURCE_CAPTURE_TERMINAL_FAILURE')):
            managed.publish_current_actions(self.db,now=LATER)
        self.assertEqual(monitor_bootstrap._reviews(self.db,'w','actions',LATER,['synthetic-0928']),[])
        with self.assertRaisesRegex(WorkbenchError,'ACTIONS_NOT_READY'):
            monitor_bootstrap._reviews(self.db,'w','actions',LATER,['synthetic-3141'])

    def test_monitor_window_replacement_requires_same_rule_and_preserves_old_economics(self):
        self.prepare();self.grant();publication=managed.publish_current_actions(self.db,now=AT)[0]['publication_id']
        definition={'targets':[{'listing_id':'synthetic-3141','market':'US'}]}
        windows=[('US',{'action_review_ids':[self.base['id']],'start_date':'2026-10-30','end_date':'2026-10-30'})]
        confirmed_feed._refresh_action_windows(self.db,'w',definition,windows,AT)
        self.assertEqual(windows[0][1]['action_review_ids'],[publication])
        monitor_bootstrap._check_action_selection(self.db,'w',definition,[windows[0][1]],AT)
        original={**windows[0][1],'action_review_ids':[self.base['id']]}
        with self.assertRaisesRegex(WorkbenchError,'ACTION_SELECTION_CHANGED'):
            monitor_bootstrap._check_action_selection(self.db,'w',definition,[original],AT)
        next_day=deepcopy(windows);next_day[0][1]['end_date']='2026-11-01'
        with self.assertRaisesRegex(WorkbenchError,'ACTION_COVERAGE_NOT_UNIQUE'):
            confirmed_feed._refresh_action_windows(self.db,'w',definition,next_day,AT)

    def test_second_day_extends_exactly_once_with_shared_source_payloads(self):
        self.prepare();self.grant();first=managed.publish_current_actions(self.db,now=AT)[0]
        counts=self.count('investor_issuer_payloads'),self.count('investor_eodhd_payloads')
        self.next_source_day()
        second=managed.publish_current_actions(self.db,now=LATER)[0]
        self.assertEqual(second['status'],'published')
        value=data_evidence.resolve_review(self.db,'w',second['publication_id'],'actions',now=LATER)
        self.assertEqual(value['facts'],{**self.base_facts,'range_end':'2026-11-01'})
        publication=self.db.execute('SELECT * FROM investor_action_publications WHERE id=?',(second['publication_id'],)).fetchone()
        self.assertEqual(publication['sequence'],2);self.assertEqual(publication['previous_id'],first['publication_id'])
        self.assertEqual(counts,(self.count('investor_issuer_payloads'),self.count('investor_eodhd_payloads')))
        self.assertEqual(managed.publish_current_actions(self.db,now=LATER),[])
        previous=data_evidence.resolve_review(self.db,'w',first['publication_id'],'actions',now=LATER)
        managed.check_same_rule_extension(self.db,'w',previous,value,LATER)
        self.assertEqual(managed.current_action_reviews(self.db,'w',['synthetic-3141'],LATER)[0]['review']['id'],second['publication_id'])
        self.assert_no_finance()

    def test_real_parser_new_event_stops_future_maintenance_without_altering_old_review(self):
        self.prepare();self.grant();first=managed.publish_current_actions(self.db,now=AT)[0]
        self.next_source_day(archive(row('987.1234',exDividendDate='2026-09-25',recordDate='2026-09-25',payableDate='2026-09-30'),
            row('12.34',exDividendDate='2026-10-31',recordDate='2026-10-31',payableDate='2026-11-02')))
        result=managed.publish_current_actions(self.db,now=LATER)
        self.assertEqual([(r['status'],r['failure_code']) for r in result],[('blocked','NEW_REPORTED_ACTION')])
        self.assertEqual(self.count('investor_action_publications'),2)
        self.assertEqual(managed.managed_review_unavailable(self.db,'w',first['publication_id'],LATER),'REFERENCE_SOURCE_NO_LONGER_CURRENT')
        self.assertEqual(data_evidence.resolve_review(self.db,'w',self.base['id'],'actions',now=LATER)['facts'],self.base_facts)
        with self.assertRaisesRegex(WorkbenchError,'SOURCE_QUARANTINED'):
            managed.set_authority_enabled(self.db,'w','synthetic-investor',self.authority['id'],True,now=LATER)
        self.assert_no_finance()

    def test_real_parser_historical_correction_is_not_absorbed_into_old_differences(self):
        self.prepare();self.grant();managed.publish_current_actions(self.db,now=AT)
        self.next_source_day(archive(row('987.1235',exDividendDate='2026-09-25',recordDate='2026-09-25',payableDate='2026-09-30')))
        result=managed.publish_current_actions(self.db,now=LATER)
        self.assertEqual([(r['status'],r['failure_code']) for r in result],[('blocked','HISTORICAL_RECORDS_CHANGED')])
        self.assertEqual(data_evidence.resolve_review(self.db,'w',self.base['id'],'actions',now=LATER)['facts'],self.base_facts)

    def test_stop_readonly_and_restore_barriers_precede_local_intent_and_publication(self):
        self.prepare();self.grant();before=list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError,'WORKER_STOP_REQUESTED'):
            managed.publish_current_actions(self.db,now=AT,stop_requested=lambda:True)
        with patch.dict('os.environ',{'WORKBENCH_MODE':'read_only'}),self.assertRaisesRegex(WorkbenchError,'READ_ONLY'):
            managed.publish_current_actions(self.db,now=AT)
        lock=self.path.parent/'RESTORE_PENDING_REVIEW'
        lock.write_text('Fictional restore barrier')
        with self.assertRaisesRegex(WorkbenchError,'RESTORE_PENDING_REVIEW'):
            managed.publish_current_actions(self.db,now=AT)
        lock.unlink()
        self.assertEqual(before,list(self.db.iterdump()))

    def test_heavy_replay_does_not_hold_a_writer_and_unchanged_pins_can_commit(self):
        self.prepare();self.grant();self.db.execute('CREATE TABLE fictional_replay_observations(marker TEXT)')
        other=open_database(self.path);self.addCleanup(other.close)
        original=eodhd_sources.resolve_eodhd_capture
        writes=[]
        def observed(*args,**kwargs):
            if not writes:
                other.execute("INSERT INTO fictional_replay_observations VALUES('writer remained available')")
                writes.append(True)
            return original(*args,**kwargs)
        with patch.object(eodhd_sources,'resolve_eodhd_capture',side_effect=observed):
            result=managed.publish_current_actions(self.db,now=AT)
        self.assertEqual([r['status'] for r in result],['published'])
        self.assertEqual(writes,[True]);self.assertEqual(self.count('fictional_replay_observations'),1)

    def test_other_connection_can_commit_same_day_only_once(self):
        self.prepare();self.grant();other=open_database(self.path);self.addCleanup(other.close)
        first=managed.publish_current_actions(self.db,now=AT)
        before=other.total_changes
        self.assertEqual(managed.publish_current_actions(other,now=AT),[])
        self.assertEqual(other.total_changes,before)
        self.assertEqual(self.count('investor_action_requests'),1);self.assertEqual(self.count('investor_action_publications'),1)
        self.assertEqual(data_evidence.resolve_review(other,'w',first[0]['publication_id'],'actions',now=AT)['facts']['range_end'],'2026-10-31')

    def test_private_cli_preview_and_inspection_are_readonly_registration_does_not_enable(self):
        self.prepare();policy=self.policy();expected=policy['anchor_binding_hash']
        original_clock=managed._clock
        invoke=lambda *args:cli_fixture.DataPipelineCliTests.invoke(self,*args)
        args=['preview-action-maintenance','--base-review',self.base['id'],'--listing-review',self.member['listing_review_id']]
        for flag,key in (('issuer-capture','issuer_capture_id'),('dividend-capture','dividend_capture_id'),('split-capture','split_capture_id')):
            args.extend(['--'+flag,self.member[key]])
        with patch.object(managed,'_clock',side_effect=lambda value=None:original_clock(AT if value is None else value)), \
                patch.object(issuer_sources.receiver,'collect_vanguard_distribution_draft') as issuer, \
                patch.object(eodhd_sources.receiver,'collect_eodhd_action_draft') as eod:
            before=list(self.db.iterdump())
            status,out,error=invoke(*args)
            self.assertEqual((status,error),(0,''));self.assertEqual(json.loads(out)['anchor_binding_hash'],expected)
            self.assertEqual(before,list(self.db.iterdump()))
            path=self.path.parent/'fictional-maintenance-policy.json';path.write_text(json.dumps(policy));path.chmod(0o600)
            status,out,error=invoke('register-action-maintenance','--file',str(path))
            self.assertEqual((status,error),(0,''));registered=json.loads(out)
            self.assertFalse(registered['enabled']);self.assertEqual(registered['state'],'disabled')
            identifier=registered['authority_id'];before=list(self.db.iterdump())
            status,out,error=invoke('inspect-action-maintenance','--authority',identifier)
            self.assertEqual((status,error),(0,''));self.assertEqual(json.loads(out),registered)
            self.assertEqual(before,list(self.db.iterdump()))
            status,out,error=invoke('control-action-maintenance','--authority',identifier,'--enable')
            self.assertEqual((status,error),(0,''));self.assertTrue(json.loads(out)['enabled'])
            self.assertEqual(self.count('investor_action_requests'),0);self.assertEqual(self.count('investor_action_publications'),0)
            for forbidden in ('987.1234','98.71234',self.base_facts['tax_assumption'],'AppSecret','AccessToken'):
                self.assertNotIn(forbidden,out)
        issuer.assert_not_called();eod.assert_not_called();self.assert_no_finance()

    def test_ordinary_snapshot_replays_price_fx_and_virtual_actions_without_legacy_coverage_fallback(self):
        self.prepare();self.grant();publication=managed.publish_current_actions(self.db,now=AT)[0]['publication_id']
        def reviewed(kind,facts):
            source=data_evidence.store_source(self.db,'w','synthetic-investor',kind,{'title':'Fictional snapshot '+kind,
                'reference':'synthetic://managed-snapshot/'+kind,'excerpt':'Offline fixture only'},now=AT)
            return data_evidence.review_source(self.db,'w','synthetic-investor',source['id'],'approved',facts,
                'Fictional test only','2026-11-10T00:00:00.000Z',now=AT)
        rights=reviewed('rights',{'provider':'longport','account_region':'HK','markets':['US'],
            'uses':['private_research','private_retention','private_display','private_backup'],'retention_days':30,
            'valid_from':'2026-01-01T00:00:00Z','valid_until':'2026-11-10T00:00:00.000Z','clause_references':['Fictional only']})
        day='2026-10-30'
        calendar=reviewed('calendar',{'market':'US','range_start':day,'range_end':day,'days':[{'date':day,'kind':'full',
            'close_at':day+'T20:00:00Z','available_at':day+'T20:01:00Z','settled_at':'2026-11-02T21:00:00Z',
            'settlement_rule_known_at':'2026-01-01T00:00:00Z'}]})
        fx=reviewed('fx',{'currency':'USD','unit':'CNY_per_unit_currency','rows':[{'observed_at':day+'T20:00:00Z',
            'assumed_available_at':day+'T20:01:00Z','value':'1.23'}]})
        mapping={'listing_id':'synthetic-3141','provider_symbol':'VT.US','market':'US','currency':'USD'}
        request=longport._request(mapping,day,day,[day])
        rows=[{'timestamp':datetime(2026,10,30,tzinfo=ZoneInfo('America/New_York')),'open':Decimal('10'),
            'high':Decimal('12'),'low':Decimal('9'),'close':Decimal('11.25'),'turnover':Decimal('11250'),'volume':1000,'trade_session':0}]
        projection=longport._normalize(rows,request=request,sdk_version='4.3.7',call_started_at=AT,call_returned_at=AT,
            datetime_basis='runtime_utc_from_unix_timestamp',collector_runtime='isolated_official_sdk')
        original_millis=data_evidence._milliseconds
        with patch.object(longport,'_collect_isolated',return_value=projection), \
                patch.object(data_evidence,'_milliseconds',side_effect=lambda value=None:original_millis(AT if value is None else value)), \
                patch.object(data_evidence,'instant',side_effect=lambda value=None:instant(AT if value is None else value)):
            capture=data_evidence.collect_prices(self.db,'w','synthetic-investor',rights['id'],self.member['listing_review_id'],calendar['id'],day,day)
        with self.assertRaisesRegex(WorkbenchError,'ACTION_COVERAGE_INCOMPLETE'):
            build_dataset(self.db,'w',[capture['id']],[self.base['id']],[fx['id']],day,day,now=AT)
        before=self.db.total_changes
        with patch.object(longport,'_collect_isolated') as network, \
                patch.object(longport,'read_private_credentials_file') as secrets:
            result=build_dataset(self.db,'w',[capture['id']],[publication],[fx['id']],day,day,now=AT)
            document={'snapshot':result['manifest'],'valid_until':result['valid_until']}
            source_inputs.check_source_refs(self.db,'w',document,AT)
            self.assertIsNone(source_retention._snapshot_reason(self.db,'w',result['manifest'],result['valid_until'],AT))
        network.assert_not_called();secrets.assert_not_called()
        self.assertEqual(self.db.total_changes,before);self.assertEqual(result['dataset']['mode'],'reconstructed')
        self.assertIn(publication,[ref['review_id'] for ref in result['manifest']['review_refs']])
        self.assertNotIn(self.base['id'],[ref['review_id'] for ref in result['manifest']['review_refs']])
        managed.set_authority_enabled(self.db,'w','synthetic-investor',self.authority['id'],False,now=AT)
        self.assertEqual(source_inputs.source_unavailable_reason(self.db,'w',document,AT),'REFERENCE_SOURCE_NO_LONGER_CURRENT')
        self.assertIsNone(source_retention._snapshot_reason(self.db,'w',result['manifest'],result['valid_until'],AT))
        with self.assertRaises(WorkbenchError): source_inputs.check_source_refs(self.db,'w',document,AT)
        self.assert_no_finance()

    def test_control_replacement_alias_cannot_delete_a_prior_version(self):
        self.prepare();self.grant()
        old=dict(self.db.execute('SELECT * FROM investor_action_controls ORDER BY version DESC LIMIT 1').fetchone())
        replacement={**old,'version':old['version']+1};document=json.loads(old['document_json']);document['version']=replacement['version']
        replacement['document_json']=canonical_json(document);replacement['content_hash']=content_hash(document)
        replacement['audit_id']=managed._audit(self.db,'synthetic-investor','investor_control_action_maintenance','investor_action_control',
            old['id'],{'content_hash':replacement['content_hash']},AT)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT OR REPLACE INTO investor_action_controls VALUES(?,?,?,?,?,?,?,?,?,?)',tuple(replacement.values()))
        self.assertEqual(dict(self.db.execute('SELECT * FROM investor_action_controls WHERE id=?',(old['id'],)).fetchone()),old)

    def test_pending_intent_replacement_alias_cannot_reset_the_local_day(self):
        self.prepare();self.grant();managed.discover_requests(self.db,now=AT)
        old=dict(self.db.execute('SELECT * FROM investor_action_requests').fetchone())
        replacement={**old,'id':'fictional-replacement-request'}
        replacement['audit_id']=managed._audit(self.db,'synthetic-investor','investor_request_action_maintenance','investor_action_request',
            replacement['id'],{'content_hash':replacement['content_hash']},AT)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT OR REPLACE INTO investor_action_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)',tuple(replacement.values()))
        self.assertEqual(dict(self.db.execute('SELECT * FROM investor_action_requests').fetchone()),old)

    def test_preexisting_manual_source_cannot_be_reused_as_a_derived_review(self):
        self.prepare();self.grant()
        source=data_evidence.store_source(self.db,'w','synthetic-investor','actions',{'title':'Standing no-new-action coverage',
            'reference':'investor-action-rule:'+self.authority['id']+':2026-11-01','excerpt':managed.REASON},now=AT)
        original=data_evidence.review_source(self.db,'w','synthetic-investor',source['id'],'approved',
            {**self.base_facts,'range_end':'2026-10-31'},'An independently reviewed source must retain its identity',
            '2026-11-10T00:00:00.000Z',now=AT)
        self.assertEqual(managed.publish_current_actions(self.db,now=AT),[])
        self.assertEqual(self.count('investor_action_publications'),0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='investor.action_maintenance_gap'").fetchone()[0],1)
        self.assertEqual(data_evidence.resolve_review(self.db,'w',original['id'],'actions',now=AT)['source']['id'],source['id'])
        self.assertEqual(managed.publish_current_actions(self.db,now=AT),[])
        self.assertEqual(self.db.execute("SELECT count(*) FROM outbox WHERE topic='investor.action_maintenance_gap'").fetchone()[0],1)
        check=managed._check
        with patch.object(managed,'_check',side_effect=lambda value,code='INVALID':None if code=='AUTHORITY_INPUTS_CHANGED' else check(value,code)), \
                self.assertRaisesRegex(sqlite3.IntegrityError,'publication audit differs'):
            managed.publish_current_actions(self.db,now=AT)
        self.assertEqual(self.count('investor_action_publications'),0)

    def test_publication_replacement_alias_cannot_erase_a_previous_day(self):
        self.prepare();self.grant();managed.publish_current_actions(self.db,now=AT)
        old=dict(self.db.execute('SELECT * FROM investor_action_publications').fetchone())
        managed.discover_requests(self.db,now=LATER)
        request=self.db.execute('SELECT * FROM investor_action_requests ORDER BY source_day DESC LIMIT 1').fetchone()
        replacement={**old,'request_id':request['id'],'sequence':2,'previous_id':old['id'],'source_day':request['source_day'],
            'status':'superseded','source_id':None,'review_hash':None,'coverage_end':None,'created_at':LATER}
        document=json.loads(old['document_json']);document.update({key:replacement[key] for key in
            ('request_id','sequence','previous_id','source_day','status','source_id','review_hash','coverage_end','created_at')})
        document.update(request_hash=request['content_hash'],previous_hash=old['content_hash'],reason_code='ACTION_RULE_SUPERSEDED',
            source_hash=None,capture_refs=None,checked_input_hash=None,candidate_facts_hash=None)
        replacement['document_json']=canonical_json(document);replacement['content_hash']=content_hash(document)
        replacement['audit_id']=managed._audit(self.db,'synthetic-investor','investor_publish_action_maintenance','investor_action_publication',
            old['id'],{'content_hash':replacement['content_hash']},LATER)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('INSERT OR REPLACE INTO investor_action_publications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',tuple(replacement.values()))
        self.assertEqual(dict(self.db.execute('SELECT * FROM investor_action_publications').fetchone()),old)

    def test_repeated_dst_hour_and_rule_toggle_do_not_reset_local_day_intent(self):
        self.prepare();self.grant()
        self.assertEqual(len(managed.discover_requests(self.db,now=AT)),1)
        self.assertEqual(managed.discover_requests(self.db,now='2026-11-01T06:00:03.000Z'),[])
        managed.set_authority_enabled(self.db,'w','synthetic-investor',self.authority['id'],False,now=AT)
        managed.set_authority_enabled(self.db,'w','synthetic-investor',self.authority['id'],True,now=AT)
        self.assertEqual(managed.discover_requests(self.db,now=AT),[])
        result=managed.publish_current_actions(self.db,now=AT)
        self.assertEqual([row['status'] for row in result],['superseded'])
        self.assertEqual(self.count('investor_action_requests'),1)
        self.assertEqual(self.count('investor_action_publications'),1)

    def test_source_capture_pending_waits_without_quarantine_or_provider_call(self):
        self.prepare();self.grant()
        with patch.object(managed,'_current_refs',return_value=(None,None)), \
                patch.object(eodhd_sources.receiver,'collect_eodhd_action_draft') as source:
            self.assertEqual(managed.publish_current_actions(self.db,now=AT),[])
        source.assert_not_called()
        self.assertEqual(self.count('investor_action_requests'),1)
        self.assertEqual(self.count('investor_action_publications'),0)
        self.assertEqual(managed.publish_current_actions(self.db,now=AT)[0]['status'],'published')

    def test_failed_source_blocks_once_and_pause_resume_cannot_clear_quarantine(self):
        self.prepare();self.grant()
        with patch.object(managed,'_current_refs',return_value=(None,'SOURCE_CAPTURE_TERMINAL_FAILURE')):
            result=managed.publish_current_actions(self.db,now=AT)
        self.assertEqual([row['status'] for row in result],['blocked'])
        self.assertEqual(managed.publish_current_actions(self.db,now=AT),[])
        managed.set_authority_enabled(self.db,'w','synthetic-investor',self.authority['id'],False,now=AT)
        with self.assertRaisesRegex(WorkbenchError,'SOURCE_QUARANTINED'):
            managed.set_authority_enabled(self.db,'w','synthetic-investor',self.authority['id'],True,now=AT)
        self.assertEqual(managed.discover_requests(self.db,now=LATER),[])
        self.assertEqual(self.count('investor_action_requests'),1)

    def test_expired_local_intent_stops_before_a_later_day_can_publish(self):
        self.prepare();self.grant();managed.discover_requests(self.db,now=AT)
        result=managed.publish_current_actions(self.db,now=LATER)
        self.assertEqual([row['status'] for row in result],['blocked','superseded'])
        self.assertEqual(result[0]['failure_code'],'MAINTENANCE_WINDOW_MISSED')
        self.assertEqual(self.count('investor_action_publications'),2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_action_publications WHERE status='published'").fetchone()[0],0)

    def test_invalid_or_foreign_anchor_is_not_a_new_approval(self):
        self.prepare();policy=self.policy()
        for key,value in (('anchor_binding_hash','0'*64),('base_review_hash','0'*64),('listing_id','wrong'),('provider_symbol','BND.US')):
            with self.assertRaises(WorkbenchError):
                managed.register_authority(self.db,'w','synthetic-investor',{**policy,key:value},now=AT)
        self.assertEqual(self.count('investor_action_authorities'),0)
        with self.assertRaises(WorkbenchError):managed.register_authority(self.db,'w','foreign',policy,now=AT)

    def test_injected_source_captures_cannot_register_an_ordinary_rule(self):
        self.prepare(official=False)
        with self.assertRaisesRegex(WorkbenchError,'SYNTHETIC_CAPTURE_FORBIDDEN'):
            self.policy()
        self.assertEqual(self.count('investor_action_authorities'),0)

    def test_source_withdrawal_during_prepare_cannot_publish_a_stale_snapshot(self):
        self.prepare();self.grant();other=open_database(self.path);self.addCleanup(other.close)
        original=managed._inputs
        def withdrawn(*args,**kwargs):
            result=original(*args,**kwargs)
            eodhd_sources.set_authority_enabled(other,'w','synthetic-investor',self.member['eodhd_authority_id'],False,now=AT)
            return result
        with patch.object(managed,'_inputs',side_effect=withdrawn):
            self.assertEqual(managed.publish_current_actions(self.db,now=AT),[])
        self.assertEqual(self.count('investor_action_publications'),0)
        result=managed.publish_current_actions(self.db,now=AT)
        self.assertEqual([row['status'] for row in result],['blocked'])
        self.assertEqual(data_evidence.resolve_review(self.db,'w',self.base['id'],'actions',now=AT)['facts'],self.base_facts)

    def test_late_publication_failure_rolls_back_source_and_publication_but_preserves_intent(self):
        self.prepare();self.grant();managed.discover_requests(self.db,now=AT)
        before=list(self.db.iterdump());audit=managed._audit
        def failed(*args,**kwargs):
            if args[2]=='investor_publish_action_maintenance':raise RuntimeError('FICTIONAL late publication failure')
            return audit(*args,**kwargs)
        with patch.object(managed,'_audit',side_effect=failed),self.assertRaises(RuntimeError):
            managed.publish_current_actions(self.db,now=AT)
        self.assertEqual(before,list(self.db.iterdump()))

    def test_rule_rows_are_immutable_and_manual_review_cannot_impersonate_derivation(self):
        self.prepare();self.grant();result=managed.publish_current_actions(self.db,now=AT)[0]
        for table in ('investor_action_authorities','investor_action_controls','investor_action_requests','investor_action_publications'):
            with self.assertRaises(sqlite3.IntegrityError):self.db.execute('DELETE FROM '+table)
            with self.assertRaises(sqlite3.IntegrityError):self.db.execute('UPDATE '+table+" SET actor_id='foreign'")
        value=managed.resolve_managed_review(self.db,'w',result['publication_id'],now=AT)
        with self.assertRaises(sqlite3.IntegrityError):
            data_evidence.review_source(self.db,'w','synthetic-investor',value['source']['id'],'approved',value['facts'],
                'Cannot call this a human review','2026-11-09T00:00:00.000Z',now=AT)


if __name__ == '__main__':
    unittest.main()
