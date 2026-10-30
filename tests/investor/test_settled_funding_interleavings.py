import unittest
from zoneinfo import ZoneInfo

from tests.investor.settled_funding_fixtures import release_during_settlement_case
from worker.accounting.decimal_math import decimal
from worker.investor.funded_history import prepare_funded_history
from worker.investor.long_horizon import funding_schedule
from worker.orchestration.db import content_hash, instant
from worker.research.rotation import run_continuous_portfolio


class SettledFundingInterleavingTests(unittest.TestCase):
    def test_annual_arrival_and_partial_release_during_sale_wait_keep_locked_cash_and_separate_trigger(self):
        document = release_during_settlement_case()
        _, kernel = prepare_funded_history(document, allow_synthetic=True)
        _, releases = funding_schedule(kernel['plan'], ZoneInfo(kernel['plan']['evaluation_timezone']), staged=True)
        result = run_continuous_portfolio(kernel['dataset'], kernel['plan'], releases)
        intent = result['cash_intents'][0]
        arrival = next(e for e in result['events'] if e['type'] == 'external_contribution')
        settlement = next(e for e in result['events'] if e['type'] == 'sale_cash_settlement')
        published = next(e for e in result['events'] if e['type'] == 'cash_intent_buy_published')
        self.assertLess(instant(intent['declaration']['declared_at']), instant(arrival['at']))
        self.assertLess(instant(arrival['at']), instant(settlement['at']))
        self.assertLess(instant(settlement['at']), instant(published['at']))
        preparation = published['preparation']
        point = next(row for row in result['curve'] if row['at'] == published['at'])
        self.assertEqual(sum(map(decimal, kernel['plan']['parameters']['weights'].values())), 1)
        self.assertEqual(point['locked_cash_cny'], '200')
        expected_cash = {'as_of': published['at'], 'settled_cny': point['cash_cny'], 'reserved_cny': '0', 'floor_cny': '200'}
        self.assertEqual(preparation['cash_snapshot_hash'], content_hash(expected_cash))
        self.assertEqual(decimal(preparation['available_cash_cny']), decimal(point['cash_cny']) - decimal('200'))
        self.assertEqual(decimal(point['unreserved_released_cash_cny']), decimal(preparation['available_cash_cny'])
                         - decimal(preparation['total_budget_cny']))
        self.assertEqual(result['contributions_cny'], '300')
        self.assertEqual(sum(e['type'] == 'external_contribution' for e in result['events']), 1)
        self.assertEqual(result['failed_cash_intent_count'], 0)
        self.assertTrue(all(decimal(row['cash_cny']) >= decimal(row['locked_cash_cny']) >= 0 for row in result['curve']))
        self.assertTrue(any(e['at'] > published['at'] and 'NEW_CASH_REPAIR' in e.get('trigger_codes', []) for e in result['events']))


if __name__ == '__main__': unittest.main()
