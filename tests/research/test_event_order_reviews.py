import unittest

from tests.research.event_review_fixtures import vectors
from tests.research.test_rotation import rows


class EventOrderReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = {row['kind']: row for row in vectors()}

    def result(self, name):
        return self.cases[name]['result']['strategy']

    def test_raw_cancellations_stay_visible_and_only_fully_resolved_review_closes_terminal_gaps(self):
        result = self.result('late_action')
        self.assertEqual(result['execution_failure_count'], 2)
        self.assertEqual(result['corporate_action_cancellation_count'], 2)
        self.assertEqual(result['resolved_corporate_action_cancellation_count'], 2)
        self.assertEqual(result['terminal_execution_failure_count'], 0)
        self.assertEqual(result['unresolved_order_review_count'], 0)
        self.assertEqual(result['order_reviews'][0]['status'], 'resolved')

    def test_replacements_have_new_identity_and_original_frozen_orders_are_not_resized(self):
        result = self.result('repeated_action')
        orders = rows(result, 'research_order')
        self.assertEqual([row['order_id'] for row in orders], ['order:%06d' % n for n in range(1, 7)])
        self.assertEqual([row['quantity'] for row in orders[:2]], ['23', '94'])
        self.assertEqual(orders[2]['replaces_order_ids'], ['order:000001', 'order:000002'])
        self.assertEqual(orders[4]['replaces_order_ids'], ['order:000003', 'order:000004'])
        self.assertEqual(orders[4]['quantity'], '47')
        self.assertEqual(result['execution_failure_count'], 4)
        self.assertEqual(result['terminal_execution_failure_count'], 0)

    def test_reservation_release_never_creates_a_second_cashflow_or_undoes_a_filled_leg(self):
        result = self.result('partial_fill')
        cancelled = rows(result, 'execution_skipped')
        self.assertEqual(len(cancelled), 1)
        self.assertEqual(cancelled[0]['listing_id'], 'CN:BETA')
        first_fill = rows(result, 'simulated_buy')[0]
        self.assertEqual(first_fill['listing_id'], 'US:ALPHA')
        self.assertEqual(result['ending_nav_cny'], '1200')
        self.assertEqual(result['terminal_execution_failure_count'], 0)
        self.assertEqual(result['order_reviews'][0]['listing_ids'], ['CN:BETA'])
        self.assertFalse(rows(result, 'external_contribution'))

    def test_a_price_bound_failure_is_terminal_and_never_retried_with_a_smaller_quantity(self):
        result = self.result('failed_replacement')
        self.assertGreater(result['terminal_execution_failure_count'], 0)
        self.assertEqual(result['resolved_corporate_action_cancellation_count'], 0)
        self.assertEqual(result['order_reviews'][0]['status'], 'failed')
        self.assertEqual(len(rows(result, 'research_order')), 4)

    def test_no_declared_future_decision_means_unresolved_failure_not_automatic_retry(self):
        result = self.result('no_decision')
        self.assertEqual(len(rows(result, 'research_order')), 2)
        self.assertEqual(result['unresolved_order_review_count'], 1)
        self.assertGreater(result['terminal_execution_failure_count'], 0)
        self.assertFalse(rows(result, 'order_review_reproposal'))

    def test_old_carry_is_not_a_fresh_post_action_quote(self):
        result = self.result('missing_fresh_close')
        replacements = [row for row in rows(result, 'research_order') if 'origin_review_id' in row]
        self.assertTrue(replacements)
        self.assertTrue(all(row['at'] >= '2025-01-09' for row in replacements))

    def test_new_funding_does_not_downgrade_a_cancelled_rebalance_to_partial_cash_only_repair(self):
        result = self.result('funding_during_sale_review')
        review = result['order_reviews'][0]
        self.assertTrue(review['allow_sales'])
        replacements = [row for row in rows(result, 'research_order') if row.get('origin_review_id') == review['id']]
        self.assertEqual({row['side'] for row in replacements}, {'buy', 'sell'})
        self.assertTrue(next(row for row in replacements if row['side'] == 'buy')['dependency_order_ids'])
        self.assertEqual(review['status'], 'resolved')
        self.assertEqual(result['terminal_execution_failure_count'], 0)
        self.assertEqual(result['contributions_cny'], '1')
        self.assertTrue(any('NEW_CASH_REPAIR' in event.get('trigger_codes', []) and event['at'] >= review['completed_at']
                            for event in rows(result, 'evaluation')))


if __name__ == '__main__': unittest.main()
