from copy import deepcopy
from decimal import Decimal, localcontext
from fractions import Fraction
import unittest

from tests.execution_sandbox.journal_fixtures import scenario as continuous
from tests.execution_sandbox.projection_fixtures import mark, scenario
from worker.execution_sandbox.bounded_cash import digest
from worker.execution_sandbox.journal import append_command, new_journal, replay_journal
from worker.execution_sandbox.projection import (ProjectionError, declare_program, decide_cash, funding_commands,
                                                 value_journal, verify_decision, verify_report)


class ProjectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = scenario()

    def fixture_copy(self):
        return deepcopy(self.fixture)

    def test_hand_computed_unitization_is_not_profit_divided_by_contributions(self):
        f = self.fixture_copy()
        report = value_journal(f['valuation_input'])
        self.assertEqual(report, f['report'])
        self.assertEqual([row['nav_cny'] for row in report['samples']], ['1000', '1000', '1000', '2500', '2500', '2500', '1250'])
        self.assertEqual([row['units'] for row in report['samples']], ['1000', '1000', '1000', '1250', '1250', '1250', '1250'])
        self.assertEqual([row['unit_nav'] for row in report['samples']], ['1', '1', '1', '2', '2', '2', '1'])
        self.assertEqual(report['samples'][3]['pre_flow_nav_cny'], '2000')
        self.assertEqual(report['samples'][3]['external_flow_cny'], '500')
        self.assertEqual(report['total_contributions_cny'], '1500')
        self.assertEqual(report['net_profit_cny'], '-250')
        self.assertEqual(report['cash_flow_adjusted_return'], '0')
        self.assertEqual(report['return_status'], 'calculated')
        self.assertEqual(report['sampled_max_drawdown'], '0.5')
        self.assertFalse(report['cash_reference']['investable_market_benchmark'])
        self.assertEqual(report['cash_reference']['difference_cny'], '-250')
        self.assertEqual(report['execution_failure_count'], 0)
        self.assertEqual(report['valuation_basis'], 'terminal_processing_not_execution_settlement')

    def test_generated_schedule_and_decisions_replay_without_implicitly_adding_future_funds(self):
        f = self.fixture_copy()
        funds = funding_commands(f['program'])
        self.assertEqual(len(funds), 2)
        self.assertEqual(funds[0]['payload']['amount_cny'], '1000')
        first = f['decisions'][0]['command']['payload']
        second = f['decisions'][1]['command']['payload']
        self.assertEqual(first['plan']['orders'][0]['quantity'], '100')
        self.assertEqual(second['plan']['orders'][0]['quantity'], '25')
        self.assertEqual(first['input']['settled_cash_cny'], '1000')
        before = deepcopy(f)
        for value, result in zip(f['decision_inputs'], f['decisions']):
            verify_decision(value, result)
        verify_report(f['valuation_input'], f['report'])
        self.assertEqual(f, before)
        empty = deepcopy(f['decision_inputs'][0])
        empty['journal'] = new_journal(empty['journal']['declaration'])
        decision = decide_cash(empty)
        self.assertEqual(decision['status'], 'no_deployable_cash')
        self.assertIsNone(decision['command'])

    def test_locked_cash_stays_in_nav_and_the_generator_waits_for_pending_batches(self):
        f = self.fixture_copy()
        value = f['decision_inputs'][0]
        value['journal'] = append_command(value['journal'], f['decisions'][0]['command'])
        value['decision_id'] = 'waiting'
        result = decide_cash(value)
        self.assertEqual(result['status'], 'waiting_for_pending_batches')
        self.assertEqual(result['nav_cny'], '1000')
        self.assertIsNone(result['command'])
        self.assertEqual(f['report']['samples'][1]['reserved_cny'], '1000')
        self.assertEqual(f['report']['samples'][1]['nav_cny'], '1000')

    def continuous_input(self):
        f = continuous()
        schedule = [{'at': command['at'], **command['payload']} for command in f['commands'] if command['kind'] == 'cash_contribution']
        program = declare_program(f['declaration'], [
            {'listing_id': 'CN:SYNTHETIC_A', 'weight_bps': 2500, 'quantity_step': '10'},
            {'listing_id': 'CN:SYNTHETIC_B', 'weight_bps': 6500, 'quantity_step': '1'}], 1000, 0, schedule)
        at = '2025-01-03T08:02:00.000000Z'
        return {'schema_version': 'bounded-cash-decision-input-v1', 'qualification': 'synthetic_test_only', 'program': program,
                'journal': f['journal'], 'decision_id': 'cash-only', 'at': at, 'execute_at': '2025-01-04T07:00:00.000000Z',
                'expires_at': '2025-01-04T08:00:00.000000Z', 'marks': [mark(at), mark(at, listing_id='CN:SYNTHETIC_B')]}

    def test_cash_only_repairs_underweight_without_selling_overweight_and_preserves_floor(self):
        value = self.continuous_input()
        result = decide_cash(value)
        self.assertEqual(result['nav_cny'], '2271.2')
        self.assertEqual(result['cash_floor_cny'], '227.12')
        self.assertEqual(result['deployable_cny'], '244.08')
        self.assertEqual([row['allocated_budget_cny'] for row in result['allocations']], ['0', '244.08'])
        orders = result['command']['payload']['input']['orders']
        self.assertEqual([row['listing_id'] for row in orders], ['CN:SYNTHETIC_B'])
        updated = replay_journal(append_command(value['journal'], result['command']))
        self.assertEqual(updated['positions'], {'CN:SYNTHETIC_A': '180'})
        self.assertGreaterEqual(Decimal(updated['free_cash_cny']), Decimal(result['cash_floor_cny']))

    def test_threshold_budget_floor_and_below_minimum_are_not_repaired_with_hindsight(self):
        value = self.continuous_input()
        p = value['program']
        value['program'] = declare_program(value['journal']['declaration'], p['targets'], p['cash_target_bps'], 10000, p['funding_schedule'])
        self.assertEqual(decide_cash(value)['status'], 'no_eligible_underweight')
        value = self.fixture_copy()['decision_inputs'][0]
        p = value['program']
        p['targets'][0]['quantity_step'] = '1000000'
        value['program'] = declare_program(value['journal']['declaration'], p['targets'], 0, 0, p['funding_schedule'])
        result = decide_cash(value)
        self.assertEqual(result['command']['payload']['plan']['orders'][0]['status'], 'below_minimum')
        self.assertEqual(result['command']['payload']['plan']['new_reserved_cny'], '0')

    def test_program_targets_schedule_and_journal_are_bound_not_independently_notarized(self):
        f = self.fixture_copy()
        p, declaration = f['program'], f['decision_inputs'][0]['journal']['declaration']
        for change, code in [({'cash_target_bps': 1}, 'WEIGHT_SUM_INVALID'),
                             ({'targets': [p['targets'][0], p['targets'][0]]}, 'TARGET_ORDER_OR_DUPLICATE'),
                             ({'funding_schedule': [p['funding_schedule'][0]] * 2}, 'FUNDING_DUPLICATE')]:
            args = {**p, **change}
            with self.assertRaisesRegex(ProjectionError, code):
                declare_program(declaration, args['targets'], args['cash_target_bps'], args['drift_threshold_bps'], args['funding_schedule'])
        value = f['decision_inputs'][0]
        value['program']['funding_schedule'][0]['amount_cny'] = '999'
        body = {key: item for key, item in value['program'].items() if key != 'program_hash'}
        value['program']['program_hash'] = digest(body)
        with self.assertRaisesRegex(ProjectionError, 'FUNDING_SCHEDULE_MISMATCH'):
            decide_cash(value)
        self.assertFalse(p['parameters_independently_preregistered'])

    def test_bad_quote_universe_age_future_expiry_and_unaccounted_actions_fail_closed(self):
        mutations = [lambda v: v['marks'].append(deepcopy(v['marks'][0])),
                     lambda v: v['marks'][0]['quote'].update(known_at='2025-01-02T08:00:00.000001Z'),
                     lambda v: v['marks'][0]['quote'].update(observed_at='2025-01-02T06:59:59.999999Z'),
                     lambda v: v['marks'][0]['quote'].update(valid_until=v['at']),
                     lambda v: v['marks'][0]['quote'].update(close='0'),
                     lambda v: v['marks'][0].update(corporate_action_unaccounted=True)]
        for mutate in mutations:
            value = self.fixture_copy()['decision_inputs'][0]
            mutate(value)
            with self.assertRaises(ProjectionError):
                decide_cash(value)

    def test_every_event_needs_same_instant_pre_and_post_flow_prices(self):
        for mutation in ['missing', 'time', 'future', 'final']:
            value = self.fixture_copy()['valuation_input']
            if mutation == 'missing':
                value['event_frames'].pop()
            elif mutation == 'time':
                value['event_frames'][0]['at'] = '2025-01-02T07:00:00.000001Z'
            elif mutation == 'future':
                value['event_frames'][0]['marks'][0]['quote']['known_at'] = '2025-01-02T07:00:00.000001Z'
            else:
                value['final_frame']['at'] = '2025-01-02T07:00:00.000000Z'
            with self.assertRaises(ProjectionError):
                value_journal(value)

    def test_quote_identity_cannot_be_rebound_within_one_report(self):
        value = self.fixture_copy()['valuation_input']
        value['final_frame'] = deepcopy(value['event_frames'][-1])
        value['final_frame']['marks'][0]['quote']['close'] = '10'
        with self.assertRaisesRegex(ProjectionError, 'QUOTE_ID_REBOUND'):
            value_journal(value)
        value = self.continuous_input()
        value['marks'][1]['quote']['id'] = value['marks'][0]['quote']['id']
        with self.assertRaisesRegex(ProjectionError, 'DUPLICATE_QUOTE_ID'):
            decide_cash(value)

    def test_coherently_resealed_outputs_cannot_forge_returns_or_budget(self):
        f = self.fixture_copy()
        result = f['report']
        result['cash_flow_adjusted_return'] = '100'
        result['report_hash'] = digest({key: item for key, item in result.items() if key != 'report_hash'})
        with self.assertRaisesRegex(ProjectionError, 'REPORT_REPLAY_MISMATCH'):
            verify_report(f['valuation_input'], result)
        decision = f['decisions'][0]
        decision['allocations'][0]['allocated_budget_cny'] = '999'
        decision['decision_hash'] = digest({key: item for key, item in decision.items() if key != 'decision_hash'})
        with self.assertRaisesRegex(ProjectionError, 'DECISION_REPLAY_MISMATCH'):
            verify_decision(f['decision_inputs'][0], decision)

    def test_empty_and_cash_only_reports_have_no_manufactured_profit_or_return(self):
        f = self.fixture_copy()
        value = f['valuation_input']
        value['journal'] = f['decision_inputs'][0]['journal']
        value['event_frames'] = value['event_frames'][:1]
        value['final_frame'] = deepcopy(value['event_frames'][0])
        self.assertEqual(value_journal(value)['cash_flow_adjusted_return'], '0')
        value['journal'] = new_journal(value['journal']['declaration'])
        value['event_frames'] = []
        report = value_journal(value)
        self.assertEqual(report['end_nav_cny'], '0')
        self.assertEqual(report['net_profit_cny'], '0')
        self.assertIsNone(report['cash_flow_adjusted_return'])
        self.assertIsNone(report['sampled_max_drawdown'])
        self.assertEqual(report['return_status'], 'no_contributed_capital')

    def test_isolated_decimal_context_is_reproducible(self):
        f = self.fixture_copy()
        with localcontext() as context:
            context.prec = 6
            self.assertEqual(value_journal(f['valuation_input']), f['report'])
            self.assertEqual(decide_cash(f['decision_inputs'][0]), f['decisions'][0])

    def test_proportional_cash_budgets_match_exact_fraction_floor_and_never_recycle_dust(self):
        for index in range(16):
            value = self.continuous_input()
            cash, a, b = 501 + index * 71, 1001 + index * 37, 2003 + index * 29
            targets = [{'listing_id': 'CN:SYNTHETIC_A', 'weight_bps': a, 'quantity_step': '10'},
                       {'listing_id': 'CN:SYNTHETIC_B', 'weight_bps': b, 'quantity_step': '1'},
                       {'listing_id': 'CN:SYNTHETIC_C', 'weight_bps': 10000 - cash - a - b, 'quantity_step': '1'}]
            value['program'] = declare_program(value['journal']['declaration'], targets, cash, 0, value['program']['funding_schedule'])
            value['marks'].append(mark(value['at'], listing_id='CN:SYNTHETIC_C'))
            result = decide_cash(value)
            deficits = [Fraction(row['underweight_cny']) for row in result['allocations']]
            deployable = Fraction(result['deployable_cny'])
            expected = [min(deficit, deficit * deployable / sum(deficits)) for deficit in deficits]
            expected = [Fraction((number * 100).__floor__(), 100) for number in expected]
            actual = [Fraction(row['allocated_budget_cny']) for row in result['allocations']]
            self.assertEqual(actual, expected)
            self.assertLessEqual(sum(actual), deployable)
            self.assertLess(deployable - sum(actual), Fraction(3, 100))

    def test_fees_skips_and_unresolved_orders_remain_visible_in_valuation(self):
        for missing in [False, True]:
            f = continuous(second_missing=missing)
            schedule = [{'at': command['at'], **command['payload']} for command in f['commands'] if command['kind'] == 'cash_contribution']
            program = declare_program(f['declaration'], [{'listing_id': 'CN:SYNTHETIC_A', 'weight_bps': 10000, 'quantity_step': '10'}], 0, 0, schedule)
            frames = [{'at': event['at'], 'marks': [mark(event['at'])]} for event in f['journal']['events']]
            value = {'schema_version': 'bounded-cash-valuation-input-v1', 'qualification': 'synthetic_test_only', 'program': program,
                     'journal': f['journal'], 'event_frames': frames, 'final_frame': deepcopy(frames[-1])}
            report = value_journal(value)
            self.assertEqual(report['execution_failure_count'], int(missing))
            self.assertEqual(report['net_profit_cny'], '-12.8' if missing else '-32.8')
            self.assertEqual(report['end_nav_cny'], '2291.2' if missing else '2271.2')
            value['journal'] = f['prefixes'][4]
            value['event_frames'] = frames[:4]
            report = value_journal(value)
            self.assertEqual(report['end_nav_cny'], '2304')
            self.assertEqual(report['open_batch_count'], 2)
            self.assertEqual(report['samples'][-1]['position_value_cny'], '0')


if __name__ == '__main__':
    unittest.main()
