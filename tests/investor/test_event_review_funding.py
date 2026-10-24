from copy import deepcopy
import unittest
from zoneinfo import ZoneInfo

from tests.investor.event_review_funding_fixtures import documents, vectors
from worker.accounting.decimal_math import decimal
from worker.investor.funded_history import prepare_funded_history
from worker.investor.long_horizon import funding_schedule
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError
from worker.research.rotation import run_continuous_portfolio


class EventReviewFundingTests(unittest.TestCase):
    def test_continuous_and_funded_versions_retain_the_new_policy_and_raw_cancellations(self):
        values = vectors()
        pending = next(row for row in values if row['name'] == 'pending_action')
        self.assertEqual(pending['prepared']['input']['schema_version'], 'investor-long-horizon-input-v4')
        self.assertEqual(pending['result']['schema_version'], 'investor-funded-history-result-v3')
        immediate = pending['result']['comparison']['runs']['immediate']
        self.assertGreater(immediate['execution_failure_count'], 0)
        self.assertEqual(immediate['terminal_execution_failure_count'], 0)
        self.assertEqual(immediate['corporate_action_cancellation_count'], immediate['resolved_corporate_action_cancellation_count'])
        self.assertEqual(immediate['unresolved_order_review_count'], 0)
        self.assertEqual(immediate['ending_nav_cny'], immediate['principal_cny'])
        for row in values:
            validate_contract(row['result'], 'investor-funded-history-result-v3.schema.json')

    def test_old_contracts_cannot_accept_a_stripped_or_relabelled_new_execution(self):
        value = documents()['pending_action']
        for schema in ('investor-funded-history-input.schema.json', 'investor-funded-history-input-v2.schema.json'):
            with self.assertRaises(WorkbenchError): validate_contract(value, schema)
        forged = deepcopy(value); forged['schema_version'] = 'investor-funded-history-input-v2'
        with self.assertRaises(WorkbenchError): prepare_funded_history(forged, allow_synthetic=True)
        missing = deepcopy(value); missing['context']['execution'].pop('order_action_policy')
        with self.assertRaises(WorkbenchError): prepare_funded_history(missing, allow_synthetic=True)

    def test_ten_years_do_not_restart_units_or_principal_and_unreleased_cash_is_never_spent(self):
        value = documents()['ten_years']
        _, kernel = prepare_funded_history(value, allow_synthetic=True)
        for staged in (False, True):
            _, releases = funding_schedule(kernel['plan'], ZoneInfo(kernel['plan']['evaluation_timezone']), staged=staged)
            run = run_continuous_portfolio(kernel['dataset'], kernel['plan'], releases)
            self.assertEqual(run['ending_nav_cny'], '4200')
            self.assertEqual(run['contributions_cny'], '3000')
            self.assertEqual(run['profit_cny'], '0')
            self.assertEqual(run['curve'][-1]['unit_nav'], '1')
            self.assertEqual(run['terminal_execution_failure_count'], 0)
            self.assertTrue(all(decimal(row['unreserved_released_cash_cny']) >= 0 for row in run['curve']))


if __name__ == '__main__': unittest.main()
