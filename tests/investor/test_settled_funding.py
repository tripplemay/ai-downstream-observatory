from copy import deepcopy
import unittest
from zoneinfo import ZoneInfo

from tests.investor.settled_funding_fixtures import documents, settled_input
from worker.accounting.decimal_math import decimal
from worker.investor.funded_history import calculate_funded_history, prepare_funded_history
from worker.investor.long_horizon import funding_schedule
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError
from worker.research.rotation import run_continuous_portfolio


class SettledFundingTests(unittest.TestCase):
    def test_sales_settle_before_a_new_frozen_buy_and_orphans_block_even_with_zero_raw_errors(self):
        for name in ('sale_settlement', 'orphan'):
            document = documents()[name]
            _, kernel = prepare_funded_history(document, allow_synthetic=True)
            self.assertEqual(kernel['schema_version'], 'investor-long-horizon-input-v5')
            self.assertEqual(kernel['plan']['schema_version'], 'investor-long-horizon-plan-v5')
            self.assertEqual(kernel['plan']['execution'], document['context']['execution'])
            result = calculate_funded_history(document, allow_synthetic=True)
            validate_contract(result, 'investor-funded-history-result-v4.schema.json')
            self.assertEqual(result['comparison']['schema_version'], 'investor-long-horizon-result-v5')
            immediate = result['comparison']['runs']['immediate']
            self.assertEqual(immediate['engine_version'], 'continuous-settled-intent-funding-v1')
            _, releases = funding_schedule(kernel['plan'], ZoneInfo(kernel['plan']['evaluation_timezone']), staged=False)
            trace = run_continuous_portfolio(kernel['dataset'], kernel['plan'], releases)
            self.assertGreater(len(trace['cash_intents']), 0)
            if name == 'sale_settlement':
                self.assertEqual(result['comparison']['status'], 'computed')
                self.assertEqual(immediate['failed_cash_intent_count'], 0)
                self.assertEqual(immediate['pending_cash_intent_count'], 0)
                self.assertTrue(all(row['state'] == 'resolved' for row in trace['cash_intents']))
            else:
                self.assertEqual(result['comparison']['status'], 'execution_gaps')
                self.assertEqual(immediate['execution_failure_count'], 0)
                self.assertEqual(immediate['terminal_execution_failure_count'], 0)
                self.assertEqual(immediate['failed_cash_intent_count'], 1)
                self.assertEqual(immediate['pending_cash_intent_count'], 0)

    def test_old_versions_and_missing_funding_policy_cannot_silently_downgrade(self):
        document = settled_input()
        for version in ('investor-funded-history-input-v1', 'investor-funded-history-input-v2', 'investor-funded-history-input-v3'):
            forged = deepcopy(document); forged['schema_version'] = version
            with self.assertRaises(WorkbenchError): prepare_funded_history(forged, allow_synthetic=True)
        missing = deepcopy(document); missing['context']['execution'].pop('buy_funding_policy')
        with self.assertRaises(WorkbenchError): prepare_funded_history(missing, allow_synthetic=True)

    def test_ten_year_strategy_and_holding_baseline_keep_principal_units_and_locked_cash(self):
        document = documents()['ten_years']
        _, kernel = prepare_funded_history(document, allow_synthetic=True)
        for staged in (False, True):
            _, releases = funding_schedule(kernel['plan'], ZoneInfo(kernel['plan']['evaluation_timezone']), staged=staged)
            for holding in (False, True):
                run = run_continuous_portfolio(kernel['dataset'], kernel['plan'], releases, holding_baseline=holding)
                self.assertEqual(run['engine_version'], 'continuous-settled-intent-hold-v1' if holding else 'continuous-settled-intent-funding-v1')
                self.assertEqual(run['ending_nav_cny'], '4200')
                self.assertEqual(run['contributions_cny'], '3000')
                self.assertEqual(run['profit_cny'], '0')
                self.assertEqual(run['curve'][-1]['unit_nav'], '1')
                self.assertEqual(run['failed_cash_intent_count'], 0)
                self.assertEqual(run['pending_cash_intent_count'], 0)
                self.assertTrue(all(decimal(row['unreserved_released_cash_cny']) >= 0 and
                    decimal(row['cash_cny']) >= decimal(row['locked_cash_cny']) >= 0 for row in run['curve']))


if __name__ == '__main__': unittest.main()
