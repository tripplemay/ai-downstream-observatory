from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import tempfile
from threading import Barrier
import unittest

from tests.execution_sandbox.journal_fixtures import scenario
from worker.execution_sandbox.bounded_cash import digest, plan_buys
from worker.execution_sandbox.journal import JournalError, append_command, new_journal, replay_journal
from worker.execution_sandbox.journal_store import append_to_store, open_store, read_journal, register_study


def reseal(value, key):
    value[key] = digest({name: item for name, item in value.items() if name != key})


class JournalTests(unittest.TestCase):
    def test_continuous_cash_positions_and_reservations_have_hand_computed_prefixes(self):
        fixture = scenario()
        states = [replay_journal(journal) for journal in fixture['prefixes']]
        self.assertEqual([row['settled_cash_cny'] for row in states], ['0', '2204', '2204', '2204', '2304', '1391.2', '471.2'])
        self.assertEqual([row['reserved_cny'] for row in states], ['0', '0', '1002', '2004', '2004', '1002', '0'])
        self.assertEqual([row['free_cash_cny'] for row in states], ['0', '2204', '1202', '200', '300', '389.2', '471.2'])
        self.assertEqual(states[-1]['positions'], {'CN:SYNTHETIC_A': '180'})
        self.assertEqual(states[-1]['total_contributions_cny'], '2304')
        self.assertEqual(states[-1]['execution_failure_count'], 0)
        self.assertEqual(len(states[-1]['closed_batches']), 2)
        self.assertFalse(fixture['declaration']['parameters_independently_preregistered'])

    def test_missing_fill_keeps_cash_and_accumulates_not_hides_failure(self):
        state = replay_journal(scenario(second_missing=True)['journal'])
        self.assertEqual((state['settled_cash_cny'], state['reserved_cny'], state['execution_failure_count']), ('1391.2', '0', 1))
        self.assertEqual(state['positions'], {'CN:SYNTHETIC_A': '90'})

    def test_cash_and_reservations_cannot_be_forged_at_the_next_decision(self):
        fixture = scenario(); journal = fixture['prefixes'][2]
        for field, value in [('settled_cash_cny', '9999'), ('existing_reservations', []), ('unsettled_receivable_cny', '100')]:
            command = deepcopy(fixture['commands'][2]); command['payload']['input'][field] = value
            command['payload']['plan'] = plan_buys(command['payload']['input'])
            with self.assertRaises(JournalError): append_command(journal, command)

    def test_policy_batch_and_order_id_reuse_are_rejected(self):
        fixture = scenario(); journal = fixture['prefixes'][2]
        for field, value, error in [('batch_id', 'batch:1', 'BATCH_ALREADY_USED'), ('order_id', 'order:1', 'ORDER_ALREADY_USED')]:
            command = deepcopy(fixture['commands'][2]); input_value = command['payload']['input']
            if field == 'batch_id': input_value[field] = value
            else:
                input_value['orders'][0][field] = value
                # The journal must reject reuse before the independent batch planner.
            with self.assertRaisesRegex(JournalError, error): append_command(journal, command)
        command = deepcopy(fixture['commands'][2]); command['payload']['input']['policy']['price_buffer_bps'] = '300'
        with self.assertRaisesRegex(JournalError, 'FROZEN_POLICY_MISMATCH'): append_command(journal, command)

    def test_due_batches_resolve_before_later_cash_or_later_batch_outcomes(self):
        fixture = scenario(); journal = fixture['prefixes'][4]
        command = deepcopy(fixture['commands'][3]); command.update(command_id='cmd:late-cash', at='2025-01-03T08:00:00.000000Z')
        command['payload']['contribution_id'] = 'capital:late'
        with self.assertRaisesRegex(JournalError, 'RESOLVE_DUE_BATCH_FIRST'): append_command(journal, command)
        with self.assertRaisesRegex(JournalError, 'RESOLVE_DUE_BATCH_FIRST'): append_command(journal, fixture['commands'][5])

    def test_backdated_events_and_duplicate_contributions_do_not_mutate_the_journal(self):
        fixture = scenario(); journal = deepcopy(fixture['prefixes'][1]); before = deepcopy(journal)
        command = deepcopy(fixture['commands'][0]); command['command_id'] = 'cmd:duplicate-cash'
        with self.assertRaisesRegex(JournalError, 'CONTRIBUTION_ALREADY_USED'): append_command(journal, command)
        command['payload']['contribution_id'] = 'capital:other'; command['at'] = '2025-01-02T07:01:59.999999Z'
        with self.assertRaisesRegex(JournalError, 'TIME_REVERSED'): append_command(journal, command)
        self.assertEqual(journal, before)

    def test_hash_resealing_cannot_validate_wrong_cash_after_state_or_filled_quantities(self):
        fixture = scenario()
        for field in ('after_state_hash', 'before_state_hash', 'previous_hash'):
            journal = deepcopy(fixture['prefixes'][1]); journal['events'][0][field] = 'a' * 64
            reseal(journal['events'][0], 'event_hash'); journal['head_hash'] = journal['events'][0]['event_hash']; reseal(journal, 'journal_hash')
            with self.assertRaises(JournalError): replay_journal(journal)
        journal = deepcopy(fixture['prefixes'][5]); event = journal['events'][-1]
        event['payload']['result']['orders'][0]['quantity'] = '80'; reseal(event['payload']['result'], 'result_hash')
        reseal(event, 'event_hash'); journal['head_hash'] = event['event_hash']; reseal(journal, 'journal_hash')
        with self.assertRaisesRegex(JournalError, 'RESULT_REPLAY_MISMATCH'): replay_journal(journal)

    def test_reordered_dropped_events_and_changed_declaration_are_rejected(self):
        for mutate in [lambda j: j['events'].reverse(), lambda j: j['events'].pop(1),
                       lambda j: j['declaration']['policy'].update(price_buffer_bps='300')]:
            journal = deepcopy(scenario()['journal']); mutate(journal); reseal(journal, 'journal_hash')
            with self.assertRaises(JournalError): replay_journal(journal)

    def test_cash_ceiling_and_invalid_precision_block_without_mutating_the_prefix(self):
        fixture = scenario(); journal = fixture['prefixes'][0]
        command = deepcopy(fixture['commands'][0]); command['payload']['amount_cny'] = '999999999999999999.99'
        maximum = append_command(journal, command)
        extra = deepcopy(command); extra['command_id'] = 'cmd:excess'; extra['payload'] = {'contribution_id': 'capital:excess', 'amount_cny': '0.01'}
        with self.assertRaisesRegex(JournalError, 'CASH_INVARIANT_BROKEN'): append_command(maximum, extra)
        self.assertEqual(replay_journal(maximum)['settled_cash_cny'], '999999999999999999.99')
        command['payload']['amount_cny'] = '0.001'
        with self.assertRaisesRegex(JournalError, 'CONTRACT_INVALID'): append_command(journal, command)


class JournalStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        self.path = self.root / 'events.sandbox.sqlite'
        self.connection = open_store(self.path)
        self.fixture = scenario()
        self.current = register_study(self.connection, self.fixture['declaration'])

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()

    def append_all(self):
        for command in self.fixture['commands']:
            self.current = append_to_store(self.connection, self.fixture['declaration']['study_id'], command,
                                           expected_head_hash=self.current['head_hash'])['journal']
        return self.current

    def test_persist_close_reopen_and_replay_preserve_every_event_and_state(self):
        journal = self.append_all()
        self.assertEqual(journal, self.fixture['journal'])
        self.connection.close(); self.connection = open_store(self.path)
        loaded = read_journal(self.connection, self.fixture['declaration']['study_id'], expected_head_hash=journal['head_hash'])
        self.assertEqual(loaded, journal)
        self.assertEqual(replay_journal(loaded)['settled_cash_cny'], '471.2')
        self.assertEqual(self.path.stat().st_mode & 0o077, 0)

    def test_identical_retry_returns_current_state_without_duplicate_debit(self):
        self.append_all(); first = self.fixture['commands'][0]
        response = append_to_store(self.connection, self.fixture['declaration']['study_id'], first,
                                   expected_head_hash=self.fixture['prefixes'][0]['head_hash'])
        self.assertTrue(response['idempotent_replay'])
        self.assertEqual(response['event']['sequence'], 1)
        self.assertEqual(response['state']['revision'], 6)
        self.assertEqual(response['journal'], self.current)
        self.assertEqual(self.connection.execute('SELECT count(*) FROM sandbox_events').fetchone()[0], 6)
        response = append_to_store(self.connection, self.fixture['declaration']['study_id'], self.fixture['commands'][4], expected_head_hash=self.current['head_hash'])
        self.assertEqual(response['state']['positions']['CN:SYNTHETIC_A'], '180')

    def test_same_id_different_payload_and_stale_head_are_atomic_conflicts(self):
        first = self.fixture['commands'][0]
        response = append_to_store(self.connection, self.fixture['declaration']['study_id'], first, expected_head_hash=self.current['head_hash'])
        changed = deepcopy(first); changed['payload']['amount_cny'] = '2205'
        with self.assertRaisesRegex(JournalError, 'IDEMPOTENCY_CONFLICT'):
            append_to_store(self.connection, self.fixture['declaration']['study_id'], changed, expected_head_hash=response['journal']['head_hash'])
        with self.assertRaisesRegex(JournalError, 'HEAD_CONFLICT'):
            append_to_store(self.connection, self.fixture['declaration']['study_id'], self.fixture['commands'][1], expected_head_hash=self.current['head_hash'])
        self.assertEqual(self.connection.execute('SELECT count(*) FROM sandbox_events').fetchone()[0], 1)
        self.assertFalse(self.connection.in_transaction)

    def test_sql_mutation_and_deletion_of_events_and_registration_are_blocked(self):
        self.append_all()
        for statement in ('DELETE FROM sandbox_events', "UPDATE sandbox_events SET event_json='{}'",
                          'DELETE FROM sandbox_studies', "UPDATE sandbox_studies SET declaration_json='{}'"):
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'SANDBOX_APPEND_ONLY'): self.connection.execute(statement)
        self.assertEqual(read_journal(self.connection, self.fixture['declaration']['study_id']), self.current)

    def test_insert_failure_rolls_back_and_the_same_command_can_then_succeed_once(self):
        self.connection.execute("CREATE TEMP TRIGGER reject_insert BEFORE INSERT ON sandbox_events BEGIN SELECT RAISE(ABORT,'TEST_WRITE_ABORT'); END")
        first = self.fixture['commands'][0]
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'TEST_WRITE_ABORT'):
            append_to_store(self.connection, self.fixture['declaration']['study_id'], first, expected_head_hash=self.current['head_hash'])
        self.assertFalse(self.connection.in_transaction)
        self.assertEqual(read_journal(self.connection, self.fixture['declaration']['study_id']), self.current)
        self.connection.execute('DROP TRIGGER reject_insert')
        response = append_to_store(self.connection, self.fixture['declaration']['study_id'], first, expected_head_hash=self.current['head_hash'])
        self.assertEqual(response['state']['total_contributions_cny'], '2204')

    def test_two_real_writers_with_the_same_head_allow_exactly_one_append(self):
        barrier = Barrier(2); expected = self.current['head_hash']
        def write(index):
            connection = open_store(self.path)
            command = deepcopy(self.fixture['commands'][0]); command['command_id'] = 'race:' + str(index)
            command['payload']['contribution_id'] = 'race-capital:' + str(index)
            barrier.wait(timeout=5)
            try:
                append_to_store(connection, self.fixture['declaration']['study_id'], command, expected_head_hash=expected)
                return 'applied'
            except JournalError as error:
                return str(error)
            finally:
                connection.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            answers = sorted(pool.map(write, [1, 2]))
        self.assertEqual(answers, ['CASH_JOURNAL_HEAD_CONFLICT', 'applied'])
        state = replay_journal(read_journal(self.connection, self.fixture['declaration']['study_id']))
        self.assertEqual((state['revision'], state['total_contributions_cny']), (1, '2204'))

    def test_registration_conflict_is_not_a_new_policy_or_reset(self):
        self.append_all()
        self.assertEqual(register_study(self.connection, self.fixture['declaration']), self.current)
        changed = deepcopy(self.fixture['declaration']); changed['policy']['price_buffer_bps'] = '300'
        with self.assertRaisesRegex(JournalError, 'REGISTRATION_CONFLICT'): register_study(self.connection, changed)
        self.assertEqual(read_journal(self.connection, self.fixture['declaration']['study_id']), self.current)

    def test_foreign_database_insecure_files_symlinks_and_live_filenames_fail_before_writes(self):
        for name in ('etf-workbench.db', 'observatory.db', 'auth.sqlite'):
            with self.assertRaisesRegex(JournalError, 'PRIVATE_SANDBOX_PATH_REQUIRED'): open_store(self.root / name)
            self.assertFalse((self.root / name).exists())
        path = self.root / 'foreign.sandbox.sqlite'
        connection = sqlite3.connect(path); connection.execute('CREATE TABLE sentinel(value TEXT)'); connection.commit(); connection.close(); path.chmod(0o600)
        before = sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(JournalError, 'FOREIGN_DATABASE'): open_store(path)
        self.assertEqual(before, sha256(path.read_bytes()).hexdigest())
        path.chmod(0o644)
        with self.assertRaisesRegex(JournalError, 'PRIVATE_DATABASE_REQUIRED'): open_store(path)
        link = self.root / 'alias.sandbox.sqlite'; link.symlink_to(self.path)
        with self.assertRaisesRegex(JournalError, 'PRIVATE_DATABASE_REQUIRED'): open_store(link)

    def test_external_head_detects_retained_prefix_truncation_not_certified_by_hashes_alone(self):
        journal = self.append_all()
        self.connection.execute('DROP TRIGGER sandbox_events_no_delete')
        self.connection.execute('DELETE FROM sandbox_events WHERE sequence=6')
        # A valid old prefix still replays; the independently retained head is needed.
        prefix = read_journal(self.connection, self.fixture['declaration']['study_id'])
        self.assertEqual(replay_journal(prefix)['revision'], 5)
        with self.assertRaisesRegex(JournalError, 'EXTERNAL_HEAD_MISMATCH'):
            read_journal(self.connection, self.fixture['declaration']['study_id'], expected_head_hash=journal['head_hash'])


if __name__ == '__main__':
    unittest.main()
