from copy import deepcopy
from decimal import Decimal, localcontext
import unittest

from tests.execution_sandbox.projection_fixtures import mark
from tests.execution_sandbox.run_fixtures import comparison_input, run_input, scenario
from worker.execution_sandbox.bounded_cash import digest
from worker.execution_sandbox.journal import declare_study, replay_journal
from worker.execution_sandbox.projection import declare_program
from worker.execution_sandbox.study_run import StudyRunError, compare_programs, run_program, verify_comparison, verify_run


def reprogram(side, *, targets=None, policy=None, schedule=None, cash=None):
    old = side['program']
    declaration = declare_study(side['declaration']['study_id'], old['registered_at'], policy or side['declaration']['policy'])
    side['declaration'] = declaration
    side['program'] = declare_program(declaration, targets if targets is not None else old['targets'],
                                      old['cash_target_bps'] if cash is None else cash, old['drift_threshold_bps'],
                                      schedule if schedule is not None else old['funding_schedule'])


class StudyRunTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = scenario()

    def test_hand_computed_generated_market_comparator_is_not_cash_or_an_index(self):
        result = deepcopy(self.fixture['comparison'])
        a, b = result['candidate'], result['benchmark']
        self.assertEqual(a['event_valuation']['end_nav_cny'], '1320')
        self.assertEqual(b['event_valuation']['end_nav_cny'], '1500')
        self.assertEqual(a['event_valuation']['cash_flow_adjusted_return'], '0.045')
        self.assertEqual(b['event_valuation']['cash_flow_adjusted_return'], '0.125')
        self.assertEqual(result['end_nav_difference_cny'], '-180')
        self.assertEqual(result['excess_cash_flow_adjusted_return'], '-0.08')
        self.assertEqual(replay_journal(a['journal'])['positions'], {'CN:SYNTHETIC_A': '108', 'CN:SYNTHETIC_B': '24'})
        self.assertEqual(replay_journal(b['journal'])['positions'], {'CN:SYNTHETIC_A': '50', 'CN:SYNTHETIC_B': '100'})
        self.assertTrue(a['decision_policy_compliance_verified'])
        self.assertFalse(a['event_valuation']['allocation_policy_compliance_verified'])
        self.assertEqual(result['benchmark_kind'], 'simulated_cash_only_market_portfolio_not_index_or_actual_execution')
        self.assertFalse(result['parameters_independently_preregistered'])
        self.assertFalse(result['live_advice_eligible'])

    def test_all_mark_frames_and_pre_cash_flow_values_enter_sampled_drawdown(self):
        a, b = self.fixture['comparison']['candidate'], self.fixture['comparison']['benchmark']
        self.assertEqual(a['sampled_max_drawdown'], '0.710526315789')
        self.assertEqual(b['sampled_max_drawdown'], '0.5')
        self.assertEqual(a['event_valuation']['sampled_max_drawdown'], '0.45')
        self.assertEqual(b['event_valuation']['sampled_max_drawdown'], '0.25')
        self.assertEqual(a['curve'][-2]['nav_cny'], '4560')
        self.assertEqual(a['curve'][1]['reserved_cny'], '1000')
        self.assertEqual(a['curve'][1]['nav_cny'], '1000')

    def test_future_outcomes_cannot_change_an_already_frozen_decision(self):
        original = run_program(run_input())
        value = run_input()
        value['frames'][2]['execution_observations'][0]['close'] = '10.01'
        result = run_program(value)
        self.assertEqual(original['decisions'][0], result['decisions'][0])
        self.assertEqual(result['execution_failure_count'], 1)
        self.assertEqual(result['curve'][2]['settled_cash_cny'], '900')
        event = result['journal']['events'][2]
        self.assertEqual(event['payload']['result']['orders'][0]['reason'], 'PRICE_BOUND_EXCEEDED')
        self.assertEqual(original['decisions'][0]['decision']['command']['payload']['plan'], result['decisions'][0]['decision']['command']['payload']['plan'])

    def test_missing_execution_is_counted_and_never_imputed_from_valuation_mark(self):
        value = run_input()
        value['frames'][2]['execution_observations'] = []
        result = run_program(value)
        self.assertEqual(result['execution_failure_count'], 2)
        self.assertEqual(result['curve'][2]['settled_cash_cny'], '1000')
        self.assertEqual(result['curve'][2]['position_value_cny'], '0')
        self.assertTrue(result['all_planned_batches_terminal'])
        self.assertEqual([row['reason'] for row in result['journal']['events'][2]['payload']['result']['orders']], ['MISSING_EXECUTION_OBSERVATION'] * 2)

    def test_due_resolution_precedes_same_instant_funding_and_new_decision(self):
        value = run_input()
        schedule = deepcopy(value['program']['funding_schedule'])
        schedule[1]['at'] = value['decision_points'][0]['expires_at']
        side = {'program': value['program'], 'declaration': value['declaration']}
        reprogram(side, schedule=schedule)
        value.update(side)
        value['decision_points'] = value['decision_points'][:1]
        value['frames'] = value['frames'][:3]
        result = run_program(value)
        self.assertEqual([event['kind'] for event in result['journal']['events']], ['cash_contribution', 'buy_plan', 'buy_resolution', 'cash_contribution'])
        self.assertEqual(result['curve'][-1]['nav_cny'], '1500')
        self.assertEqual(result['curve'][-1]['unit_nav'], '1')
        self.assertEqual(result['curve'][-1]['total_contributions_cny'], '1500')

    def test_pending_batches_block_a_later_decision_without_creating_orders(self):
        value = run_input()
        point = deepcopy(value['decision_points'][0])
        point.update(decision_id='waiting', at='2025-01-02T08:30:00.000000Z')
        value['decision_points'].insert(1, point)
        value['frames'].insert(2, {'at': point['at'], 'marks': [mark(point['at']), mark(point['at'], '10', 'CN:SYNTHETIC_B')], 'execution_observations': []})
        result = run_program(value)
        record = result['decisions'][1]
        self.assertEqual(record['decision']['status'], 'waiting_for_pending_batches')
        self.assertIsNone(record['decision']['command'])
        self.assertEqual(record['before_head_hash'], record['after_head_hash'])
        self.assertEqual(result['event_valuation']['end_nav_cny'], '1320')

    def test_cash_flow_cost_scope_and_step_mismatch_block_comparison(self):
        for change, code in [('flow', 'CASH_FLOW'), ('cost', 'EXECUTION_POLICY'), ('step', 'UNIVERSE_OR_STEP')]:
            value = comparison_input()
            side = value['benchmark']
            if change == 'flow':
                schedule = deepcopy(side['program']['funding_schedule'])
                schedule[0]['amount_cny'] = '1001'
                reprogram(side, schedule=schedule)
            elif change == 'cost':
                reprogram(side, policy={**side['declaration']['policy'], 'minimum_fee_cny': '1'})
            else:
                targets = deepcopy(side['program']['targets'])
                targets[0]['quantity_step'] = '2'
                reprogram(side, targets=targets)
            with self.assertRaisesRegex(StudyRunError, 'COMPARISON_' + code + '_MISMATCH'):
                compare_programs(value)

    def test_fees_and_rounding_are_real_model_debits_on_both_sides(self):
        value = comparison_input()
        for side in [value['candidate'], value['benchmark']]:
            reprogram(side, policy={**side['declaration']['policy'], 'minimum_fee_cny': '2', 'commission_bps': '3'})
        result = compare_programs(value)
        for side in [result['candidate'], result['benchmark']]:
            resolutions = [row['payload']['result'] for row in side['journal']['events'] if row['kind'] == 'buy_resolution']
            self.assertEqual(Decimal(side['fees_cny']), sum(Decimal(row['fee_cny']) for batch in resolutions for row in batch['orders']))
            self.assertEqual(Decimal(side['rounding_cny']), sum(Decimal(row['rounding_cny']) for batch in resolutions for row in batch['orders']))
            self.assertGreater(Decimal(side['fees_cny']), 0)
            self.assertEqual(side['event_valuation']['total_contributions_cny'], '1500')

    def test_uncovered_funding_decision_expiry_frames_duplicate_and_rebound_evidence_fail(self):
        for mutation in ['funding', 'expiry', 'order', 'duplicate', 'future', 'quote']:
            value = run_input()
            if mutation == 'funding':
                value['frames'].pop(0)
            elif mutation == 'expiry':
                value['frames'].pop(2)
            elif mutation == 'order':
                value['frames'].reverse()
            elif mutation == 'duplicate':
                value['frames'][2]['execution_observations'].append(deepcopy(value['frames'][2]['execution_observations'][0]))
            elif mutation == 'future':
                value['frames'][2]['execution_observations'][0]['known_at'] = '2025-01-03T08:00:00.000001Z'
            else:
                value['frames'][-1]['marks'][0]['quote']['id'] = value['frames'][-2]['marks'][0]['quote']['id']
            with self.assertRaises(StudyRunError):
                run_program(value)

    def test_no_capital_has_undefined_return_and_scheduled_future_cash_is_not_credited(self):
        value = run_input()
        value['decision_points'] = []
        at = '2025-01-02T06:30:00.000000Z'
        value['frames'] = [{'at': at, 'marks': [mark(at), mark(at, '10', 'CN:SYNTHETIC_B')], 'execution_observations': []}]
        result = run_program(value)
        self.assertIsNone(result['sampled_max_drawdown'])
        self.assertIsNone(result['curve'][0]['total_return'])
        self.assertEqual(result['curve'][0]['nav_cny'], '0')
        self.assertEqual(result['journal']['events'], [])

    def test_forged_decisions_orders_and_report_statistics_fail_full_policy_replay(self):
        value, result = self.fixture['input'], deepcopy(self.fixture['comparison'])
        result['candidate']['decisions'][0]['decision']['status'] = 'no_eligible_underweight'
        result['comparison_hash'] = digest({key: item for key, item in result.items() if key != 'comparison_hash'})
        with self.assertRaisesRegex(StudyRunError, 'COMPARISON_REPLAY_MISMATCH'):
            verify_comparison(value, result)
        result = deepcopy(self.fixture['comparison']['candidate'])
        result['sampled_max_drawdown'] = '0'
        result['result_hash'] = digest({key: item for key, item in result.items() if key != 'result_hash'})
        with self.assertRaisesRegex(StudyRunError, 'FULL_RUN_REPLAY_MISMATCH'):
            verify_run(run_input(value), result)

    def test_exact_replay_is_pure_and_decimal_context_independent(self):
        value = deepcopy(self.fixture['input'])
        before = deepcopy(value)
        with localcontext() as context:
            context.prec = 6
            self.assertEqual(compare_programs(value), self.fixture['comparison'])
        self.assertEqual(value, before)


if __name__ == '__main__':
    unittest.main()
