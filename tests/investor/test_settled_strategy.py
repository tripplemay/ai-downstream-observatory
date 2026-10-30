from copy import deepcopy
import unittest

from tests.investor.fixtures import profile
from tests.research.cash_intent_fixtures import cash_intent_case
from tests.research.event_review_fixtures import case as event_case
from worker.investor.strategy import _summary, research_reference, validate_phase_summary
from worker.research.backtest import compare_backtest
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, instant


def settled_strategy_case(orphan=False):
    data, plan, parameters = cash_intent_case()
    policy = deepcopy(event_case()[2])
    policy.update(schema_version='investor-strategy-policy-v3',
                  execution_admission='settled_cash_intents_and_reviews_zero_terminal_gaps',
                  candidates=[deepcopy(parameters)])
    if orphan: plan['decision_times'] = plan['decision_times'][:2]
    for phase in ('validation', 'holdout'):
        window = plan['windows'][phase]
        plan['decision_times'].append(next(row['available_at'] for row in data['sessions']
            if instant(window['start']) <= instant(row['available_at']) < instant(window['end'])))
    return data, plan, policy


class SettledStrategyTests(unittest.TestCase):
    def test_complete_intents_are_required_for_both_sides_before_a_reference_is_ready(self):
        data, plan, policy = settled_strategy_case()
        result = research_reference(data, plan, policy, profile('0.30'), allow_synthetic=True)
        self.assertEqual(result['schema_version'], 'investor-strategy-result-v3')
        self.assertEqual(result['engine_version'], 'investor-diversified-reference-v3')
        self.assertEqual(result['status'], 'reference_ready')
        for summary in result['phase_evidence']:
            self.assertEqual(summary['schema_version'], 'investor-phase-summary-v3')
            self.assertTrue(all(summary[prefix + key] == 0 for prefix in ('', 'benchmark_')
                for key in ('failed_cash_intent_count', 'pending_cash_intent_count')))
            validate_phase_summary(summary, plan)
        with self.assertRaises(WorkbenchError): validate_contract(result, 'investor-strategy-result-v2.schema.json')

    def test_orphan_with_zero_raw_order_failures_never_freezes_or_opens_later_phases(self):
        data, plan, policy = settled_strategy_case(orphan=True)
        phases, freezes = [], []
        def evaluate(parameters, phase):
            phases.append(phase)
            return _summary(compare_backtest(data, plan, parameters, phase))
        result = research_reference(data, plan, policy, profile('0.30'), allow_synthetic=True,
            evaluate=evaluate, freeze=lambda p: freezes.append(p))
        self.assertEqual(result['status'], 'insufficient_evidence')
        summary = result['candidates'][0]['train']
        self.assertEqual(summary['execution_failure_count'], 0)
        self.assertEqual(summary['benchmark_execution_failure_count'], 0)
        self.assertEqual(summary['failed_cash_intent_count'], 1)
        self.assertEqual(summary['benchmark_failed_cash_intent_count'], 1)
        self.assertEqual(phases, ['train']); self.assertEqual(freezes, [])
        self.assertEqual(result['phase_evidence'], [])
        self.assertIsNone(result['selected_parameters'])

    def test_old_selector_or_missing_intent_fields_cannot_admit_the_new_plan(self):
        data, plan, policy = settled_strategy_case()
        old = deepcopy(policy); old.update(schema_version='investor-strategy-policy-v2', execution_admission='causal_review_zero_terminal_gaps')
        with self.assertRaises(WorkbenchError): research_reference(data, plan, old, profile('0.30'), allow_synthetic=True)
        summary = _summary(compare_backtest(data, plan, plan['benchmark'], 'train'))
        del summary['benchmark_pending_cash_intent_count']
        with self.assertRaises(WorkbenchError): validate_phase_summary(summary, plan)


if __name__ == '__main__': unittest.main()
