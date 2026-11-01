"""Current source bindings and exact diagnostics; no real provider or economic approval."""

from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import action_reconciliation_fixture as fixture
from tests.investor import test_runtime as runtime
from worker.investor import action_reconciliation as actions, data_evidence, data_pipeline, eodhd_sources, issuer_sources
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, open_database


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        source = {'range_start':'2026-01-01','range_end':'2026-10-31'}
        self.issuer = {'source':dict(source),'records':[dict(ex_date='2026-09-25',issuer_type_code='INC',
            distribution_amount='987.1234',record_date='2026-09-25',pay_date='2026-09-30')]}
        self.dividends = {'source':dict(source),'records':[dict(date='2026-09-25',unadjusted_value='987.1234',
            value='987.1234',reported_currency='USD',record_date='2026-09-25',payment_date='2026-09-30')]}
        self.splits = {'source':dict(source),'records':[]}

    def compare(self):
        original = deepcopy((self.issuer,self.dividends,self.splits))
        result = actions._compare(self.issuer,self.dividends,self.splits,'USD')
        self.assertEqual(original,(self.issuer,self.dividends,self.splits))
        self.assertFalse(result['precision']['acceptance_tolerance_applied'])
        self.assertFalse(result['precision']['supplier_precision_contract_verified'])
        self.assertNotIn('987.1234',json.dumps(result))
        return result

    def test_exact_match_still_not_approval(self):
        self.assertEqual(self.compare()['status'],'reported_nominal_fields_match_not_approval')

    def test_components_sum_without_binary_float(self):
        self.issuer['records'][0]['distribution_amount'] = '987.1233'
        self.issuer['records'].append(dict(self.issuer['records'][0],issuer_type_code='CGLT',distribution_amount='0.0001'))
        self.assertEqual(self.compare()['counts']['nominal_amount_matches'],1)

    def test_provider_lower_precision_is_diagnosed_not_accepted(self):
        self.dividends['records'][0]['unadjusted_value'] = '987.123'
        result = self.compare()
        self.assertEqual(result['counts']['nominal_amount_differences'],1)
        self.assertEqual(result['counts']['nominal_amount_matches'],0)
        self.assertTrue(any(row['fraction_places']==3 and row['provider_equals_issuer_quantized']==1 for row in result['precision']['quantization_relationships']))

    def test_issuer_lower_precision_is_not_silently_corrected(self):
        self.issuer['records'][0]['distribution_amount'] = '987.123'
        result = self.compare()
        self.assertEqual(result['counts']['nominal_amount_differences'],1)
        self.assertTrue(any(row['fraction_places']==3 and row['issuer_equals_provider_quantized']==1 for row in result['precision']['quantization_relationships']))

    def test_adjusted_value_is_not_substituted_for_unadjusted_amount(self):
        self.dividends['records'][0]['unadjusted_value'] = '987.12'
        result = self.compare()
        self.assertEqual(result['precision']['provider_adjusted_field_equals_issuer'],1)
        self.assertEqual(result['counts']['nominal_amount_matches'],0)

    def test_optional_dates_unknown_not_matches(self):
        self.dividends['records'][0]['record_date'] = None
        self.assertEqual(self.compare()['counts']['record_date_unknown'],1)
        self.assertEqual(self.compare()['status'],'reported_differences_require_review')

    def test_mismatching_dates_not_hidden_by_matching_amount(self):
        self.dividends['records'][0]['payment_date'] = '2026-10-01'
        self.assertEqual(self.compare()['counts']['payment_date_differences'],1)

    def test_missing_records_not_zero_filled(self):
        self.dividends['records'] = []
        self.assertEqual(self.compare()['counts']['issuer_only_dates'],1)

    def test_empty_inputs_not_absence_proof(self):
        self.issuer['records'] = self.dividends['records'] = []
        self.assertEqual(self.compare()['status'],'no_matched_events_not_absence_proof')

    def test_ambiguous_component_dates_are_not_summed(self):
        self.issuer['records'].append(dict(self.issuer['records'][0],issuer_type_code='CGST',pay_date='2026-10-01'))
        result = self.compare()
        self.assertEqual(result['counts']['ambiguous_issuer_groups'],1)
        self.assertEqual(result['counts']['nominal_amount_matches'],0)

    def test_duplicate_components_are_not_summed(self):
        self.issuer['records'].append(dict(self.issuer['records'][0]))
        self.assertEqual(self.compare()['counts']['unsupported_issuer_groups'],1)

    def test_currency_difference_blocks_nominal_comparison(self):
        self.dividends['records'][0]['reported_currency'] = 'HKD'
        result = self.compare()
        self.assertEqual(result['counts']['reported_currency_mismatches'],1)
        self.assertEqual(result['counts']['nominal_amount_matches'],0)

    def test_only_window_intersection_compared_and_total_counts_preserved(self):
        self.splits['source']['range_start'] = '2026-09-26'
        result = self.compare()
        self.assertEqual(result['counts']['matched_dates'],0)
        self.assertEqual(result['counts']['issuer_input_records'],1)
        self.assertEqual(result['counts']['issuer_window_records'],0)

    def test_disjoint_windows_explicit(self):
        self.splits['source']['range_start'] = '2026-11-01'
        self.assertEqual(self.compare()['status'],'no_common_window')
        self.assertIsNone(self.compare()['common_window'])

    def test_canonical_precision_histograms_do_not_round_large_decimals(self):
        self.issuer['records'][0]['distribution_amount'] = '12345678901234567890.123456789123456789'
        self.dividends['records'][0].update(value='12345678901234567890.12345',unadjusted_value='12345678901234567890.12345')
        self.assertEqual(self.compare()['precision']['issuer_canonical_fraction_digits'],{'18':1})


class ActionSourceTests(unittest.TestCase):
    setUp = runtime.InvestorRuntimeTests.setUp
    assert_no_finance = runtime.InvestorRuntimeTests.assert_no_finance

    def prepare(self, *, official=False):
        self.members = fixture.create(self.db,official=official)
        self.member = self.members['VT.US']

    def read(self, db=None, *, now=fixture.AT, allow_synthetic=True, **changes):
        args = {key:self.member[key] for key in ('listing_review_id','issuer_capture_id','dividend_capture_id','split_capture_id')}
        args.update(changes)
        return actions.check_action_crosscheck(db or self.db,'w','synthetic-investor',**args,now=now,allow_synthetic=allow_synthetic)

    def test_replays_exact_sources_in_readonly_snapshot_without_finance_audit_job_or_source_writes(self):
        self.prepare()
        before = list(self.db.iterdump())
        ro = open_database(self.path,read_only=True);self.addCleanup(ro.close)
        with patch.object(issuer_sources.receiver,'collect_vanguard_distribution_draft') as issuer, \
                patch.object(eodhd_sources.receiver,'collect_eodhd_action_draft') as eod:
            result = self.read(ro)
        issuer.assert_not_called();eod.assert_not_called()
        self.assertEqual(ro.total_changes,0)
        self.assertEqual(before,list(self.db.iterdump()))
        validate_contract(result,actions.SCHEMA)
        self.assertEqual(result['evidence_mode'],'synthetic_test_only')
        self.assertEqual(result['comparison']['counts']['nominal_amount_differences'],1)
        for flag in ('owner_reviewed','corporate_actions_complete','research_admitted','live_advice_eligible','trading_permission','market_values_output','empty_split_list_is_absence_proof'):
            self.assertIs(result[flag],False)
        for forbidden in ('987.1234','987.123','raw_base64','distribution_amount','tax_per_unit','source_url','clause_references'):
            self.assertNotIn(forbidden,json.dumps(result))
        self.assert_no_finance()

    def test_default_rejects_synthetic_captures(self):
        self.prepare()
        with self.assertRaisesRegex(WorkbenchError,'SYNTHETIC_CAPTURE_FORBIDDEN'):
            self.read(allow_synthetic=False)

    def test_current_eodhd_control_required_even_when_old_capture_is_retained(self):
        self.prepare()
        authority = self.member['eodhd_authority_id']
        eodhd_sources.set_authority_enabled(self.db,'w','synthetic-investor',authority,False,now=fixture.AT)
        with self.assertRaisesRegex(WorkbenchError,'AUTHORITY_INACTIVE'):
            self.read()
        eodhd_sources.set_authority_enabled(self.db,'w','synthetic-investor',authority,True,now=fixture.AT)
        with self.assertRaisesRegex(WorkbenchError,'AUTHORITY_INACTIVE'):
            self.read()

    def test_current_issuer_control_required(self):
        self.prepare()
        issuer_sources.set_authority_enabled(self.db,'w','synthetic-investor',self.member['issuer_authority_id'],False,now=fixture.AT)
        with self.assertRaisesRegex(WorkbenchError,'AUTHORITY_INACTIVE'):
            self.read()

    def test_wrong_symbol_kind_and_fund_do_not_match_by_row_count(self):
        self.prepare()
        for changes in ({'issuer_capture_id':self.members['BND.US']['issuer_capture_id']},
                {'dividend_capture_id':self.member['split_capture_id']},
                {'split_capture_id':self.members['BND.US']['split_capture_id']}):
            with self.assertRaisesRegex(WorkbenchError,'TARGET_BINDING_DIFFERS'):
                self.read(**changes)

    def test_captures_from_different_source_days_are_not_joined(self):
        from tests.investor.test_issuer_sources import Collector
        self.prepare()
        later = '2026-11-02T06:00:03.000Z'
        captured = issuer_sources.collect_issuer_draft(self.db,'w','synthetic-investor',self.member['issuer_authority_id'],
            '3'*32,'2025-11-02','2026-11-02',now=later,test_collector=Collector(at=later))
        with self.assertRaisesRegex(WorkbenchError,'SOURCE_DAYS_DIFFER'):
            self.read(now=later,issuer_capture_id=captured['capture_id'])

    def test_foreign_actor_and_workspace_rejected(self):
        self.prepare()
        args = [self.member[key] for key in ('listing_review_id','issuer_capture_id','dividend_capture_id','split_capture_id')]
        for workspace,actor in (('foreign','synthetic-investor'),('w','foreign')):
            with self.assertRaises(WorkbenchError):
                actions.check_action_crosscheck(self.db,workspace,actor,*args,now=fixture.AT,allow_synthetic=True)

    def test_listing_withdrawal_and_old_review_rejected(self):
        self.prepare()
        data_evidence.review_source(self.db,'w','synthetic-investor',self.member['listing_source_id'],'withdrawn',None,
            'Fictional withdrawal','2027-01-01T00:00:00.000Z',now=fixture.AT)
        with self.assertRaisesRegex(WorkbenchError,'SUPERSEDED'):
            self.read()

    def test_payload_corruption_is_replayed_not_trusted_from_capture_metadata(self):
        self.prepare()
        self.db.execute('DROP TRIGGER investor_eodhd_payload_update')
        self.db.execute("UPDATE investor_eodhd_payloads SET payload=CAST(replace(CAST(payload AS TEXT),'987.123','987.124') AS BLOB) WHERE length(payload)>2")
        with self.assertRaises(WorkbenchError):
            self.read()

    def test_retention_expiry_rejected(self):
        self.prepare()
        with self.assertRaisesRegex(WorkbenchError,'RETENTION_EXPIRED'):
            self.read(now='2026-11-12T05:00:03.000Z')

    def test_readonly_connection_cannot_be_upgraded_by_disabling_query_only(self):
        ro = open_database(self.path,read_only=True);self.addCleanup(ro.close)
        ro.execute('PRAGMA query_only=OFF')
        with self.assertRaises(sqlite3.OperationalError):
            ro.execute("UPDATE investor_workspaces SET revision=revision+1")
        for value in (0,1,None,'true'):
            with self.assertRaisesRegex(WorkbenchError,'READ_ONLY_FLAG_INVALID'):
                open_database(self.path,read_only=value)

    def test_cli_official_route_fixture_is_metadata_only_no_overrides_and_db_opened_readonly(self):
        self.prepare(official=True)
        self.path.chmod(0o600)
        args = ['--db',str(self.path),'--workspace','w','--actor','synthetic-investor','check-action-crosscheck']
        for flag,key in (('listing-review','listing_review_id'),('issuer-capture','issuer_capture_id'),
                ('dividend-capture','dividend_capture_id'),('split-capture','split_capture_id')):
            args.extend(['--'+flag,self.member[key]])
        before = list(self.db.iterdump())
        out,error = io.StringIO(),io.StringIO()
        with redirect_stdout(out),redirect_stderr(error),patch.object(actions,'_clock',return_value=fixture.AT), \
                patch.object(data_pipeline,'open_database',wraps=open_database) as opened:
            self.assertEqual(data_pipeline.main(args),0,error.getvalue())
        opened.assert_called_once_with(self.path,read_only=True)
        result = json.loads(out.getvalue())
        self.assertEqual(result['evidence_mode'],'official_capture_replay')
        self.assertNotIn('987.123',out.getvalue())
        self.assertEqual(before,list(self.db.iterdump()))
        for override in ('--now','--url','--allow-synthetic','--test-collector','--approve','--tax-rate'):
            with redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):
                data_pipeline.main(args+[override,'FICTIONAL'])
        self.assert_no_finance()


if __name__ == '__main__':
    unittest.main()
