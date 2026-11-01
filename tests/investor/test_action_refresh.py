"""Fictional standing-rule recovery, never source requests or trading."""

import unittest
from datetime import datetime
from decimal import Decimal
import json
import sqlite3
from unittest.mock import patch
from zoneinfo import ZoneInfo

from tests.investor import test_managed_actions as fixture
from tests.investor import evidence_fixture
from tests.investor.fixtures import profile
from worker.investor import confirmed_feed, data_evidence, managed_actions, monitor_admission, monitor_bootstrap, monitor_data
from worker.investor.model_contracts import definition_basis
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant
from worker.orchestration.runtime import run_pending_once


class ActionRefreshTests(unittest.TestCase):
    setUp = fixture.ManagedActionTests.setUp
    prepare = fixture.ManagedActionTests.prepare
    policy = fixture.ManagedActionTests.policy
    grant = fixture.ManagedActionTests.grant
    next_source_day = fixture.ManagedActionTests.next_source_day
    assert_no_finance = fixture.ManagedActionTests.assert_no_finance

    def model_and_prices(self):
        at = fixture.AT
        fixture.runtime_fixture.InvestorRuntimeTests.save(self, profile('0.30'))
        historical = evidence_fixture.create(self.db, 'w', 'synthetic-investor', now=at,
            fixed_policy_v2=True, research_market='US', fixed_us_etfs=True)
        self.assertEqual(run_pending_once(self.db, 'fictional-reference', clock=lambda: at)['status'], 'succeeded')
        plan = self.db.execute('SELECT * FROM investor_reference_plans').fetchone()
        reference = json.loads(plan['document_json'])
        preferences = self.db.execute('SELECT * FROM investor_profiles').fetchone()
        definition = {'schema_version': 'investor-model-definition-v2', 'model_id': 'fictional-action-refresh',
            'profile_id': preferences['id'], 'profile_version': preferences['version'], 'profile_hash': preferences['content_hash'],
            'plan_id': plan['id'], 'plan_hash': plan['content_hash'],
            'targets': [{key: target[key] for key in ('listing_id', 'market', 'currency', 'weight')} for target in reference['targets']],
            'created_at': at, 'valid_until': reference['valid_until'], 'data_mode': 'reconstructed',
            'scope': 'research_model', 'live_advice_eligible': False, 'fixed_policy': reference['fixed_policy']}
        definition['target_definition_hash'] = content_hash(definition_basis(definition))
        self.db.execute("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('select-action-refresh','synthetic-investor','investor_save_plan','investor_workspace','w','{}',?)", (at,))
        self.db.execute("INSERT INTO investor_plan_selections(id,workspace_id,plan_id,actor_id,created_at,audit_id) VALUES('action-selection','w',?,'synthetic-investor',?,'select-action-refresh')", (plan['id'], at))
        self.db.execute("INSERT INTO investor_models(id,workspace_id,profile_id,plan_id,selection_id,document_json,content_hash,created_at) VALUES(?,'w',?,?,'action-selection',?,?,?)",
            (definition['model_id'], preferences['id'], plan['id'], canonical_json(definition), content_hash(definition), at))
        self.db.execute("INSERT INTO investor_model_controls(id,workspace_id,model_id,version,enabled,actor_id,audit_id,created_at) VALUES('action-model-control','w',?,1,1,'synthetic-investor','select-action-refresh',?)", (definition['model_id'], at))
        self.prepare(); self.grant()
        publication = managed_actions.publish_current_actions(self.db, now=at)[0]['publication_id']
        def reviewed(kind, facts):
            source = data_evidence.store_source(self.db, 'w', 'synthetic-investor', kind,
                {'title': 'Fictional refresh ' + kind, 'reference': 'synthetic://action-refresh/' + kind,
                 'excerpt': 'Offline fixture only, not market or investment evidence'}, now=at)
            return data_evidence.review_source(self.db, 'w', 'synthetic-investor', source['id'], 'approved', facts,
                'Explicit fictional test only', '2026-11-10T00:00:00.000Z', now=at)
        day = '2026-10-30'
        calendar = reviewed('calendar', {'market': 'US', 'range_start': day, 'range_end': '2026-11-02', 'days': [
            {'date': date, 'kind': 'closed' if date in ('2026-10-31', '2026-11-01') else 'full',
             'close_at': None if date in ('2026-10-31', '2026-11-01') else date + 'T20:00:00Z',
             'available_at': None if date in ('2026-10-31', '2026-11-01') else date + 'T20:01:00Z',
             'settled_at': None if date in ('2026-10-31', '2026-11-01') else '2026-11-03T21:00:00Z',
             'settlement_rule_known_at': None if date in ('2026-10-31', '2026-11-01') else '2026-01-01T00:00:00Z'}
            for date in (day, '2026-10-31', '2026-11-01', '2026-11-02')]})
        bnd = reviewed('actions', {'listing_id': 'synthetic-0928', 'range_start': day, 'range_end': '2026-11-02',
            'coverage': 'reviewed_complete', 'tax_assumption': 'Fictional explicit assumption', 'events': []})
        fx = reviewed('fx', {'currency': 'USD', 'unit': 'CNY_per_unit_currency', 'rows': [
            {'observed_at': day + 'T20:00:00Z', 'assumed_available_at': day + 'T20:01:00Z', 'value': '1.25'}]})
        captures = []
        for index, listing in enumerate((self.member['listing_review_id'], historical['listings'][1]['id'])):
            mapping = json.loads(self.db.execute('SELECT document_json FROM investor_data_reviews WHERE id=?', (listing,)).fetchone()[0])['facts']
            mapping = {key: mapping[key] for key in ('listing_id', 'provider_symbol', 'market', 'currency')}
            request = longport._request(mapping, day, day, [day])
            price = Decimal('10' if index == 0 else '20')
            rows = [{'timestamp': datetime(2026, 10, 30, tzinfo=ZoneInfo('America/New_York')),
                'open': price, 'high': price, 'low': price, 'close': price, 'turnover': price * 1000, 'volume': 1000, 'trade_session': 0}]
            projection = longport._normalize(rows, request=request, sdk_version='4.3.7', call_started_at=at, call_returned_at=at,
                datetime_basis='runtime_utc_from_unix_timestamp', collector_runtime='isolated_official_sdk')
            millis = data_evidence._milliseconds
            with patch.object(longport, '_collect_isolated', return_value=projection), \
                    patch.object(data_evidence, '_milliseconds', side_effect=lambda value=None: millis(at if value is None else value)), \
                    patch.object(data_evidence, 'instant', side_effect=lambda value=None: instant(at if value is None else value)):
                captures.append(data_evidence.collect_prices(self.db, 'w', 'synthetic-investor', historical['rights']['id'], listing, calendar['id'], day, day)['id'])
        model, _, _ = monitor_admission.current_monitor_model(self.db, 'w', definition['model_id'], at)
        settings = monitor_bootstrap._settings(self.db, 'w', model, definition, reference, at)
        windows = [{'capture_ids': captures, 'action_review_ids': [publication, bnd['id']], 'fx_review_ids': [fx['id']], 'start_date': day, 'end_date': day}]
        seed = monitor_admission.admit_monitor_data(self.db, 'w', 'synthetic-investor', definition['model_id'], windows, settings, now=at)
        return definition, seed, publication

    def test_real_model_rebuilds_new_input_without_reopening_old_control_or_changing_frozen_state(self):
        definition, seed, old = self.model_and_prices()
        frozen = [list(row) for row in self.db.execute('SELECT rowid,* FROM investor_models')]
        managed_actions.set_authority_enabled(self.db, 'w', 'synthetic-investor', self.authority['id'], False, now=fixture.AT)
        managed_actions.set_authority_enabled(self.db, 'w', 'synthetic-investor', self.authority['id'], True, now=fixture.AT)
        self.next_source_day()
        current = managed_actions.publish_current_actions(self.db, now=fixture.LATER)[0]['publication_id']
        previous = json.loads(seed['document_json'])
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, 'w', definition, previous, now=fixture.LATER)['unavailable_reason'], 'REFERENCE_SOURCE_NO_LONGER_CURRENT')
        before = self.db.total_changes
        with patch.object(confirmed_feed, '_source_refresh_context', confirmed_feed._seed):
            self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=fixture.LATER), [])
        self.assertEqual(self.db.total_changes, before)
        with patch.object(longport, '_collect_isolated') as network, patch.object(longport, 'read_private_credentials_file') as credentials:
            refreshed = confirmed_feed.refresh_monitor_sources(self.db, now=fixture.LATER)
        network.assert_not_called(); credentials.assert_not_called()
        self.assertEqual(len(refreshed), 1)
        fresh = monitor_admission.latest_monitor_evidence(self.db, 'w', definition['model_id'])
        self.assertNotEqual(fresh['id'], seed['id'])
        document = json.loads(fresh['document_json'])
        self.assertIn(current, [ref['review_id'] for segment in document['segments'] for ref in segment['snapshot']['review_refs']])
        self.assertEqual(document['settings'], previous['settings'])
        self.assertIsNone(monitor_data.resolve_monitor_data(self.db, 'w', definition, document, now=fixture.LATER)['unavailable_reason'])
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, 'w', definition, previous, now=fixture.LATER)['unavailable_reason'], 'REFERENCE_SOURCE_NO_LONGER_CURRENT')
        self.assertEqual(self.db.execute('SELECT document_json FROM investor_monitor_evidence_inputs WHERE id=?', (seed['id'],)).fetchone()[0], seed['document_json'])
        self.assertEqual([list(row) for row in self.db.execute('SELECT rowid,* FROM investor_models')], frozen)
        self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=fixture.LATER), [])
        with patch.object(longport, '_collect_isolated') as network, patch.object(longport, 'read_private_credentials_file') as credentials:
            result = run_pending_once(self.db, 'fictional-recovered-core', clock=lambda: fixture.LATER)
        network.assert_not_called(); credentials.assert_not_called()
        self.assertEqual(result['status'], 'succeeded')
        self.assert_no_finance()

    def paused_model(self, publish=True):
        definition, seed, old = self.model_and_prices()
        managed_actions.set_authority_enabled(self.db, 'w', 'synthetic-investor', self.authority['id'], False, now=fixture.AT)
        managed_actions.set_authority_enabled(self.db, 'w', 'synthetic-investor', self.authority['id'], True, now=fixture.AT)
        current = None
        if publish:
            self.next_source_day()
            current = managed_actions.publish_current_actions(self.db, now=fixture.LATER)[0]['publication_id']
        return definition, seed, old, current

    def test_recovery_needs_a_new_qualified_publication_not_just_resume(self):
        definition, seed, old, _ = self.paused_model(publish=False)
        with self.assertRaises(WorkbenchError):
            managed_actions.paused_control_successor(self.db, 'w', old, fixture.LATER)
        with self.assertRaises(WorkbenchError):
            confirmed_feed._source_refresh_context(self.db, 'w', definition['model_id'], seed['id'], fixture.LATER)
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_monitor_evidence_inputs').fetchone()[0], 1)
        self.assert_no_finance()

    def test_new_head_cannot_mask_withdrawn_price_rights_or_expired_monitor_sources(self):
        definition, seed, old, _ = self.paused_model()
        capture_id = json.loads(seed['document_json'])['segments'][0]['snapshot']['capture_refs'][0]['capture_id']
        price = self.db.execute('SELECT * FROM investor_price_captures WHERE id=?', (capture_id,)).fetchone()
        rights = self.db.execute('SELECT * FROM investor_data_reviews WHERE id=?', (price['rights_review_id'],)).fetchone()
        data_evidence.review_source(self.db, 'w', 'synthetic-investor', rights['source_id'], 'withdrawn', None,
            'Fictional permission withdrawal', '2026-11-10T00:00:00.000Z', now=fixture.LATER)
        before = self.db.total_changes
        self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=fixture.LATER), [])
        self.assertEqual(self.db.total_changes, before)
        self.assertEqual(self.db.execute('SELECT count(*) FROM investor_monitor_evidence_inputs').fetchone()[0], 1)
        with self.assertRaises(WorkbenchError):
            confirmed_feed._source_refresh_context(self.db, 'w', definition['model_id'], seed['id'], '2026-11-11T06:00:00.000Z')
        with self.assertRaises(WorkbenchError):
            data_evidence.resolve_review(self.db, 'w', old, 'actions', now=fixture.LATER)
        self.assert_no_finance()

    def test_recovery_rejects_foreign_or_disabled_model_and_changed_source_authority(self):
        definition, seed, old, _ = self.paused_model()
        with self.assertRaises(WorkbenchError):
            confirmed_feed._source_refresh_context(self.db, 'foreign', definition['model_id'], seed['id'], fixture.LATER)
        self.db.execute('SAVEPOINT fictional_disabled_model')
        try:
            audit = data_evidence._audit(self.db, 'synthetic-investor', 'investor_set_monitoring', 'investor_workspace', 'w', {}, fixture.LATER)
            self.db.execute("INSERT INTO investor_model_controls(id,workspace_id,model_id,version,enabled,actor_id,audit_id,created_at) VALUES('fictional-disabled','w',?,2,0,'synthetic-investor',?,?)", (definition['model_id'], audit, fixture.LATER))
            with self.assertRaisesRegex(WorkbenchError, 'MODEL_DISABLED'):
                confirmed_feed._source_refresh_context(self.db, 'w', definition['model_id'], seed['id'], fixture.LATER)
            self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=fixture.LATER), [])
        finally:
            self.db.execute('ROLLBACK TO fictional_disabled_model'); self.db.execute('RELEASE fictional_disabled_model')
        from worker.investor import eodhd_sources
        eodhd_sources.set_authority_enabled(self.db, 'w', 'synthetic-investor', self.member['eodhd_authority_id'], False, now=fixture.LATER)
        before = self.db.total_changes
        with self.assertRaises(WorkbenchError):
            managed_actions.paused_control_successor(self.db, 'w', old, fixture.LATER)
        self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=fixture.LATER), [])
        self.assertEqual(self.db.total_changes, before)
        self.assert_no_finance()

    def test_header_comparison_does_not_accept_an_equal_but_unrelated_rule(self):
        self.prepare(); self.grant()
        old = managed_actions.publish_current_actions(self.db, now=fixture.AT)[0]['publication_id']
        managed_actions.set_authority_enabled(self.db, 'w', 'synthetic-investor', self.authority['id'], False, now=fixture.AT)
        replacement = managed_actions.register_authority(self.db, 'w', 'synthetic-investor', self.policy(valid_from=fixture.LATER), now=fixture.LATER)
        managed_actions.set_authority_enabled(self.db, 'w', 'synthetic-investor', replacement['id'], True, now=fixture.LATER)
        self.next_source_day()
        current = managed_actions.publish_current_actions(self.db, now=fixture.LATER)[0]['publication_id']
        with self.assertRaisesRegex(WorkbenchError, 'AUTHORITY_REVIEW_REQUIRED'):
            managed_actions.check_same_rule_extension(self.db, 'w',
                managed_actions.action_refresh_basis(self.db, 'w', old, fixture.LATER),
                data_evidence.resolve_review(self.db, 'w', current, 'actions', now=fixture.LATER), fixture.LATER)
        self.assert_no_finance()

    def test_later_quarantine_cannot_be_cleared_by_rebuilding_an_old_monitor_input(self):
        definition, seed, old, _ = self.paused_model()
        later = '2026-11-03T06:00:03.000Z'
        with patch.object(managed_actions, '_current_refs', return_value=(None, 'SOURCE_CAPTURE_TERMINAL_FAILURE')):
            blocked = managed_actions.publish_current_actions(self.db, now=later)
        self.assertEqual(blocked[0]['status'], 'blocked')
        before = self.db.total_changes
        with self.assertRaises(WorkbenchError):
            managed_actions.paused_control_successor(self.db, 'w', old, later)
        with self.assertRaises(WorkbenchError):
            confirmed_feed._source_refresh_context(self.db, 'w', definition['model_id'], seed['id'], later)
        self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=later), [])
        self.assertEqual(self.db.total_changes, before)
        self.assert_no_finance()

    def test_late_failure_rolls_back_new_input_audit_and_revision_not_old_history(self):
        _, seed, _, _ = self.paused_model()
        before = {table: [tuple(row) for row in self.db.execute('SELECT rowid,* FROM ' + table)]
            for table in ('investor_monitor_evidence_inputs', 'audit_events', 'investor_workspaces')}
        self.db.execute("CREATE TRIGGER fictional_refresh_abort BEFORE INSERT ON investor_monitor_evidence_inputs BEGIN SELECT RAISE(ABORT,'fictional refresh late failure'); END")
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'fictional refresh late failure'):
            confirmed_feed.refresh_monitor_sources(self.db, now=fixture.LATER)
        self.assertEqual({table: [tuple(row) for row in self.db.execute('SELECT rowid,* FROM ' + table)] for table in before}, before)
        self.assertEqual(self.db.execute('SELECT document_json FROM investor_monitor_evidence_inputs WHERE id=?', (seed['id'],)).fetchone()[0], seed['document_json'])
        self.assert_no_finance()

    def test_new_verified_head_can_replace_historical_paused_control_without_reviving_it(self):
        self.prepare(); self.grant()
        old = managed_actions.publish_current_actions(self.db, now=fixture.AT)[0]['publication_id']
        managed_actions.set_authority_enabled(self.db, 'w', 'synthetic-investor', self.authority['id'], False, now=fixture.AT)
        managed_actions.set_authority_enabled(self.db, 'w', 'synthetic-investor', self.authority['id'], True, now=fixture.AT)
        self.next_source_day()
        current = managed_actions.publish_current_actions(self.db, now=fixture.LATER)[0]['publication_id']
        self.assertNotEqual(current, old)
        with self.assertRaises(WorkbenchError):
            data_evidence.resolve_review(self.db, 'w', old, 'actions', now=fixture.LATER)
        data_evidence.resolve_review(self.db, 'w', current, 'actions', now=fixture.LATER)
        windows = [('US', {'action_review_ids': [old], 'start_date': '2026-10-30', 'end_date': '2026-10-30'})]
        definition = {'targets': [{'listing_id': 'synthetic-3141', 'market': 'US'}]}
        before = self.db.total_changes
        confirmed_feed._refresh_action_windows(self.db, 'w', definition, windows, fixture.LATER)
        self.assertEqual(windows[0][1]['action_review_ids'], [current])
        self.assertEqual(self.db.total_changes, before)
        with self.assertRaises(WorkbenchError):
            data_evidence.resolve_review(self.db, 'w', old, 'actions', now=fixture.LATER)
        self.assert_no_finance()
