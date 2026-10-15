"""Actual admitted-source/default-core path, but all provider evidence is invented."""

from copy import deepcopy
import json
import unittest

from tests.investor import evidence_fixture as fixture, test_runtime as queue
from tests.investor.fixtures import profile, fixed_policy_input
from tests.research.bounded_fixtures import bounded_plan
from worker.investor.source_inputs import admit_evidence_input
from worker.orchestration.db import WorkbenchError, content_hash
from worker.orchestration.runtime import run_pending_once


class BoundedResearchRuntimeTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    save = queue.InvestorRuntimeTests.save
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def admit(self):
        values = fixture.create(self.db, 'w', 'synthetic-investor', fixed_policy_v2=True, admit=False)
        values['plan'] = bounded_plan(values['plan'])
        values['source'] = admit_evidence_input(self.db, 'w', 'synthetic-investor', values['captures'], values['actions'], [],
            fixture.START, fixture.END, values['plan'], values['policy'], now=queue.NOW)
        return values

    def calculate(self):
        result = run_pending_once(self.db, 'synthetic-v3-core', clock=lambda: queue.NOW)
        self.assertEqual(result['status'], 'succeeded')
        return json.loads(self.db.execute('SELECT document_json FROM investor_research_runs ORDER BY rowid DESC').fetchone()[0])

    def test_unknown_risk_uses_real_admission_and_trial_registry_but_never_holdout_or_plan(self):
        self.save()
        values = self.admit()
        run = self.calculate()
        self.assertEqual(run['result']['status'], 'risk_options_ready')
        self.assertEqual(run['registry']['phases']['train'], {'registered': 3, 'completed': 3})
        self.assertEqual(run['registry']['phases']['validation']['registered'], 0)
        self.assertEqual(run['registry']['phases']['holdout']['registered'], 0)
        experiment = json.loads(self.db.execute('SELECT document_json FROM investor_experiments').fetchone()[0])
        self.assertEqual(experiment['plan_hash'], content_hash(values['plan']))
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_reference_plans').fetchone()[0], 0)
        self.assert_no_finance()

    def test_confirmed_synthetic_risk_publishes_version_bound_reference_after_five_durable_trials(self):
        self.save(profile('0.30'))
        self.admit()
        run = self.calculate()
        self.assertEqual(run['result']['status'], 'reference_ready')
        self.assertEqual(run['registry']['phases'], {'train': {'registered': 3, 'completed': 3}, 'validation': {'registered': 1, 'completed': 1}, 'holdout': {'registered': 1, 'completed': 1}})
        self.assertIsNotNone(run['registry']['freeze_hash'])
        row = self.db.execute('SELECT document_json FROM investor_reference_plans').fetchone()
        reference = json.loads(row[0])
        self.assertEqual(reference['schema_version'], 'investor-reference-plan-v2')
        self.assertIn('+bounded-close-v1+fixed-policy-v2', reference['strategy_version'])
        self.assertIn('2%', reference['estimated_cost'])
        self.assertFalse(reference['live_advice_eligible'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_trial_intents').fetchone()[0], 5)
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_trial_results').fetchone()[0], 5)
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_models').fetchone()[0], 0)
        self.assert_no_finance()

    def test_changed_execution_bounds_create_a_new_admission_not_a_relabelled_old_receipt(self):
        self.save()
        values = self.admit()
        self.calculate()
        plan = deepcopy(values['plan'])
        plan['execution']['buy_price_buffer_bps'] = '201'
        second = admit_evidence_input(self.db, 'w', 'synthetic-investor', values['captures'], values['actions'], [],
            fixture.START, fixture.END, plan, values['policy'], now=queue.NOW)
        self.assertNotEqual(second['id'], values['source']['id'])
        self.assertNotEqual(second['request_id'], values['source']['request_id'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_trial_intents').fetchone()[0], 3)
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_research_runs').fetchone()[0], 1)
        self.assert_no_finance()

    def test_browser_cent_tolerance_is_explicit_and_frozen_before_the_synthetic_study(self):
        self.save()
        with self.assertRaisesRegex(WorkbenchError, 'SYNTHETIC_BROWSER_TOLERANCE_SCOPE'):
            fixture.create(self.db, 'w', 'synthetic-investor', fixed_policy_v2=True, browser_cent_tolerance=True)
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_data_sources').fetchone()[0], 0)
        _, original, policy = fixed_policy_input()
        self.assertTrue(all(row['tolerance']['absolute_cny'] == '0' for row in policy['candidates']))
        values = fixture.create(self.db, 'w', 'synthetic-investor', fixed_policy_v2=True,
                                bounded_execution_v3=True, browser_cent_tolerance=True)
        for candidate, baseline in zip(values['policy']['candidates'], policy['candidates']):
            expected = deepcopy(baseline); expected['tolerance']['absolute_cny'] = '0.01'
            self.assertEqual(candidate, expected)
        self.assertEqual(values['plan']['benchmark']['tolerance']['absolute_cny'], '0.01')
        self.assertEqual(original['benchmark']['tolerance']['absolute_cny'], '0')
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_trial_intents').fetchone()[0], 0)
        result = self.calculate()
        self.assertEqual(result['result']['status'], 'risk_options_ready')
        self.assertEqual(result['registry']['phases']['holdout']['registered'], 0)
        self.assert_no_finance()


if __name__ == '__main__':
    unittest.main()
