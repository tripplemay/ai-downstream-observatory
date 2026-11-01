"""Pure invented inputs; no database, source request, authority or economic grant."""

from copy import deepcopy
import json
import unittest

from tests.market.test_eodhd_actions import archive as div_archive, dividend
from tests.market.test_vanguard_distributions import archive, row
from worker.investor.no_new_actions import check_no_new_action_extension
from worker.market.providers.eodhd_actions import action_window, parse_eodhd_actions
from worker.market.providers.vanguard_distributions import parse_vanguard_distributions
from worker.orchestration.db import WorkbenchError


def snapshot(at='2026-11-01T05:00:03.000Z', issuer_start='2025-11-02', issuer_end='2026-11-01'):
    start,end = action_window(at)
    return {
        'issuer':parse_vanguard_distributions(archive(row('987.1234',exDividendDate='2026-09-25',
            recordDate='2026-09-25',payableDate='2026-09-30')),fund_id='3141',has_distribution_yield=False,
            retrieved_at=at,start_date=issuer_start,end_date=issuer_end),
        'dividends':parse_eodhd_actions(div_archive(dividend('987.123',date='2026-09-25',recordDate='2026-09-25',
            paymentDate='2026-09-30')),kind='div',symbol='VT.US',start_date=start,end_date=end,retrieved_at=at),
        'splits':parse_eodhd_actions(b'[]',kind='splits',symbol='VT.US',start_date=start,end_date=end,retrieved_at=at)}


class NoNewActionTests(unittest.TestCase):
    def setUp(self):
        self.base = {'listing_id':'synthetic-vt','range_start':'2025-11-02','range_end':'2026-09-30',
            'coverage':'reviewed_complete','tax_assumption':'Fictional prior owner-reviewed tax model, never actual tax',
            'events':[{'id':'fictional-dividend','listing_id':'synthetic-vt','type':'dividend',
                'at':'2026-09-25T13:30:00Z','published_at':'2026-09-20T04:00:00Z','pay_at':'2026-09-30T20:00:00Z',
                'gross_per_unit':'987.1234','tax_per_unit':'98.71234','source_evidence':'synthetic://fictional-owner-review'}]}
        self.anchor = snapshot()
        self.current = snapshot('2026-11-02T06:00:03.000Z','2025-11-03','2026-11-02')

    def run_check(self):
        before = deepcopy((self.base,self.anchor,self.current))
        result = check_no_new_action_extension(self.base,self.anchor,self.current,symbol='VT.US',listing_id='synthetic-vt')
        self.assertEqual(before,(self.base,self.anchor,self.current))
        self.assertIs(result['corporate_actions_complete'],False)
        self.assertIs(result['research_admitted'],False)
        self.assertIs(result['authority_and_publication_not_verified'],True)
        for value in ('987.1234','98.71234',self.base['tax_assumption']):
            self.assertNotIn(value,json.dumps(result))
        return result

    def test_exact_old_facts_with_registered_nominal_difference_prepare_only_range_extension(self):
        result = self.run_check()
        self.assertEqual(result['status'],'eligible_candidate_only')
        self.assertEqual(result['candidate_range_end'],'2026-11-01')
        self.assertEqual(result['registered_nominal_difference_count'],1)
        self.assertEqual(result['overlap_distribution_dates'],1)

    def test_current_can_equal_anchor_for_first_coverage_extension(self):
        self.current = deepcopy(self.anchor)
        self.assertEqual(self.run_check()['candidate_range_end'],'2026-10-31')

    def test_issuer_new_event_stops_even_when_other_source_cutoff_is_earlier(self):
        event = dict(self.current['issuer']['records'][0],ex_date='2026-11-02',derived_event_key='new')
        self.current['issuer']['records'].append(event)
        with self.assertRaisesRegex(WorkbenchError,'NEW_REPORTED_ACTION'):self.run_check()

    def test_provider_new_event_stops(self):
        self.current['dividends']['records'].append(dict(self.current['dividends']['records'][0],date='2026-10-30',derived_event_key='new'))
        with self.assertRaisesRegex(WorkbenchError,'NEW_REPORTED_ACTION'):self.run_check()

    def test_new_split_stops_instead_of_guessing_ratio_or_tax(self):
        self.current['splits']['records'].append({'date':'2026-10-30','numerator':'2','denominator':'1'})
        with self.assertRaisesRegex(WorkbenchError,'NEW_REPORTED_ACTION'):self.run_check()

    def test_issuer_correction_stops(self):
        self.current['issuer']['records'][0]['distribution_amount'] = '987.1235'
        with self.assertRaisesRegex(WorkbenchError,'HISTORICAL_RECORDS_CHANGED'):self.run_check()

    def test_changed_registered_provider_difference_stops(self):
        self.current['dividends']['records'][0]['unadjusted_value'] = '987.124'
        with self.assertRaisesRegex(WorkbenchError,'HISTORICAL_RECORDS_CHANGED'):self.run_check()

    def test_missing_historical_record_stops(self):
        self.current['issuer']['records'] = []
        with self.assertRaisesRegex(WorkbenchError,'HISTORICAL_RECORDS_CHANGED'):self.run_check()

    def test_unknown_anchor_dates_cannot_be_registered_as_an_amount_only_difference(self):
        self.anchor['dividends']['records'][0]['record_date'] = None
        with self.assertRaisesRegex(WorkbenchError,'ANCHOR_NON_NOMINAL_DIFFERENCES'):self.run_check()

    def test_anchor_gross_must_match_prior_review_exactly(self):
        self.base['events'][0]['gross_per_unit'] = '987.123'
        with self.assertRaisesRegex(WorkbenchError,'BASE_AMOUNTS_DIFFER'):self.run_check()

    def test_window_cannot_skip_an_uncovered_tail(self):
        self.current['issuer']['source']['range_start'] = '2026-10-02'
        with self.assertRaisesRegex(WorkbenchError,'HISTORY_WINDOW_GAP'):self.run_check()

    def test_current_snapshot_cannot_mix_source_days(self):
        self.current['splits']['source']['retrieved_at'] = '2026-11-03T06:00:03.000Z'
        with self.assertRaisesRegex(WorkbenchError,'SOURCE_DAYS_DIFFER'):self.run_check()

    def test_wrong_instrument_cannot_reuse_same_dates(self):
        self.current['issuer']['source']['requested_fund_id'] = '0928'
        with self.assertRaisesRegex(WorkbenchError,'IDENTITY_DIFFERS'):self.run_check()

    def test_base_listing_must_match_explicit_current_identity(self):
        self.base['listing_id'] = 'other-listing'
        self.base['events'][0]['listing_id'] = 'other-listing'
        with self.assertRaisesRegex(WorkbenchError,'IDENTITY_DIFFERS'):self.run_check()

    def test_clock_regression_stops(self):
        self.anchor,self.current = self.current,self.anchor
        with self.assertRaisesRegex(WorkbenchError,'CLOCK_REGRESSION'):self.run_check()

    def test_raw_draft_cannot_self_assert_prior_approval(self):
        self.current['issuer']['owner_reviewed'] = True
        with self.assertRaisesRegex(WorkbenchError,'DRAFT_REQUIRED'):self.run_check()


if __name__ == '__main__':
    unittest.main()
