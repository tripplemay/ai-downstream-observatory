"""Keep old frozen-order semantics while identifying the sale-credit boundary."""
from decimal import Decimal
import unittest

from tests.research.settled_funding_fixtures import sale_funded_case
from worker.research.backtest import compare_backtest


class SettledFundingBaselineTests(unittest.TestCase):
    def report(self, sale_close):
        data, plan, parameters = sale_funded_case(sale_close)
        return compare_backtest(data, plan, parameters, 'train')['strategy']

    def test_only_future_sale_price_changes_not_the_published_order_or_quantity(self):
        control, changed = self.report('20'), self.report('19.8')
        orders = lambda result: [e for e in result['events'] if e['type'] == 'research_order']
        self.assertEqual(orders(control), orders(changed))
        buy = next(e for e in orders(changed) if e['funding'] == 'waiting_for_sales')
        self.assertEqual((buy['quantity'], buy['budget_cny'], buy['worst_total_cash_cny']), ('29', '300', '295.8'))
        failure = next(e for e in changed['events'] if e['type'] == 'execution_skipped')
        self.assertEqual(failure['order_id'], buy['order_id'])
        self.assertEqual(failure['reason'], 'SETTLED_CASH_BELOW_PRECOMMITTED_BUDGET')
        self.assertEqual(failure['available_cny'], '297.4')
        self.assertGreater(Decimal(failure['available_cny']), Decimal(buy['worst_total_cash_cny']))
        self.assertLess(Decimal(failure['available_cny']), Decimal(buy['budget_cny']))
        self.assertEqual(control['execution_failure_count'], 0)
        self.assertEqual(changed['execution_failure_count'], 1)
        self.assertFalse(any(e['type'] == 'simulated_buy' and e['order_id'] == buy['order_id'] for e in changed['events']))

    def test_a_larger_sale_shortfall_cannot_fund_even_the_original_worst_case_cost(self):
        result = self.report('19')
        buy = next(e for e in result['events'] if e['type'] == 'research_order' and e['funding'] == 'waiting_for_sales')
        failure = next(e for e in result['events'] if e['type'] == 'execution_skipped')
        self.assertEqual(failure['available_cny'], '287')
        self.assertLess(Decimal(failure['available_cny']), Decimal(buy['worst_total_cash_cny']))
        self.assertEqual(result['terminal_execution_failure_count'], 1)
        self.assertEqual(result['unresolved_order_review_count'], 0)


if __name__ == '__main__':
    unittest.main()
