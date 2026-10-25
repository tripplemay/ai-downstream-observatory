import json
import unittest

from tests.investor import evidence_fixture as fixture, test_runtime as queue, test_bounded_research_runtime as bounded
from tests.investor.fixtures import profile


class SettledResearchRuntimeTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    save = queue.InvestorRuntimeTests.save
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance
    calculate = bounded.BoundedResearchRuntimeTests.calculate

    def test_ordinary_source_core_registry_and_reference_use_the_same_v6_contract(self):
        self.save(profile('0.30'))
        fixture.create(self.db, 'w', 'synthetic-investor', fixed_policy_v2=True, settled_intent_execution_v6=True)
        run = self.calculate()
        self.assertEqual(run['result']['status'], 'reference_ready')
        self.assertEqual(run['result']['engine_version'], 'investor-diversified-reference-v3')
        self.assertEqual(run['registry']['phases'], {'train': {'registered': 3, 'completed': 3},
            'validation': {'registered': 1, 'completed': 1}, 'holdout': {'registered': 1, 'completed': 1}})
        reference = json.loads(self.db.execute('SELECT document_json FROM investor_reference_plans').fetchone()[0])
        self.assertIn('+settled-cash-v1', reference['strategy_version'])
        self.assertIn('完整交收后', reference['estimated_cost'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_models').fetchone()[0], 0)
        self.assert_no_finance()

    def test_orphan_is_durable_and_blocks_freeze_and_later_trials_even_with_zero_raw_failures(self):
        self.save(profile('0.30'))
        fixture.create(self.db, 'w', 'synthetic-investor', fixed_policy_v2=True,
            settled_intent_execution_v6=True, train_settled_orphan=True)
        run = self.calculate()
        self.assertEqual(run['result']['status'], 'insufficient_evidence')
        self.assertEqual(run['registry']['phases'], {'train': {'registered': 3, 'completed': 3},
            'validation': {'registered': 0, 'completed': 0}, 'holdout': {'registered': 0, 'completed': 0}})
        self.assertIsNone(run['registry']['freeze_hash'])
        for candidate in run['result']['candidates']:
            self.assertEqual(candidate['train']['execution_failure_count'], 0)
            self.assertGreater(candidate['train']['failed_cash_intent_count'], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_trial_results').fetchone()[0], 3)
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_reference_plans').fetchone()[0], 0)
        self.assert_no_finance()


if __name__ == '__main__': unittest.main()
