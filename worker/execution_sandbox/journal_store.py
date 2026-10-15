"""Private, append-only SQLite storage for synthetic studies; no live DB migrations."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import sqlite3
import stat

from .bounded_cash import digest
from .journal import JournalError, append_command, command_from_event, contract, new_journal, replay_journal, require

APPLICATION_ID = 0x4554464A
MAX_BYTES = 32 * 1024 * 1024
SCHEMA = '''
CREATE TABLE sandbox_studies (
 study_id TEXT PRIMARY KEY,
 declaration_hash TEXT NOT NULL CHECK(length(declaration_hash)=64),
 declaration_json TEXT NOT NULL
);
CREATE TABLE sandbox_events (
 study_id TEXT NOT NULL REFERENCES sandbox_studies(study_id),
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 512),
 command_id TEXT NOT NULL,
 command_hash TEXT NOT NULL CHECK(length(command_hash)=64),
 previous_hash TEXT NOT NULL CHECK(length(previous_hash)=64),
 event_hash TEXT NOT NULL CHECK(length(event_hash)=64),
 event_json TEXT NOT NULL,
 PRIMARY KEY(study_id,sequence), UNIQUE(study_id,command_id)
);
CREATE TRIGGER sandbox_studies_no_update BEFORE UPDATE ON sandbox_studies BEGIN SELECT RAISE(ABORT,'SANDBOX_APPEND_ONLY'); END;
CREATE TRIGGER sandbox_studies_no_delete BEFORE DELETE ON sandbox_studies BEGIN SELECT RAISE(ABORT,'SANDBOX_APPEND_ONLY'); END;
CREATE TRIGGER sandbox_events_no_update BEFORE UPDATE ON sandbox_events BEGIN SELECT RAISE(ABORT,'SANDBOX_APPEND_ONLY'); END;
CREATE TRIGGER sandbox_events_no_delete BEFORE DELETE ON sandbox_events BEGIN SELECT RAISE(ABORT,'SANDBOX_APPEND_ONLY'); END;
CREATE TRIGGER sandbox_events_chain BEFORE INSERT ON sandbox_events BEGIN
 SELECT CASE WHEN NEW.sequence != (SELECT count(*)+1 FROM sandbox_events WHERE study_id=NEW.study_id)
 THEN RAISE(ABORT,'SANDBOX_SEQUENCE_CONFLICT') END;
 SELECT CASE WHEN NEW.previous_hash != COALESCE(
 (SELECT event_hash FROM sandbox_events WHERE study_id=NEW.study_id ORDER BY sequence DESC LIMIT 1),
 (SELECT declaration_hash FROM sandbox_studies WHERE study_id=NEW.study_id))
 THEN RAISE(ABORT,'SANDBOX_HEAD_CONFLICT') END;
END;
'''


def _canonical(value):
    def normalize(item):
        if isinstance(item, float) and item.is_integer():
            return int(item)
        if isinstance(item, list):
            return [normalize(child) for child in item]
        if isinstance(item, dict):
            return {key: normalize(child) for key, child in item.items()}
        return item
    text = json.dumps(normalize(value), sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    require(len(text.encode()) <= MAX_BYTES, 'DOCUMENT_TOO_LARGE')
    return text


def _load(text):
    require(isinstance(text, str) and len(text.encode()) <= MAX_BYTES, 'STORED_JSON_INVALID')
    def pairs(rows):
        value = {}
        for key, item in rows:
            require(key not in value, 'DUPLICATE_JSON_KEY')
            value[key] = item
        return value
    def invalid(_value):
        raise JournalError('CASH_JOURNAL_STORED_JSON_INVALID')
    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_constant=invalid)
        require(_canonical(value) == text, 'STORED_JSON_NOT_CANONICAL')
        return value
    except (ValueError, TypeError) as error:
        raise JournalError('CASH_JOURNAL_STORED_JSON_INVALID') from error


def _check(connection):
    require(connection.execute('PRAGMA application_id').fetchone()[0] == APPLICATION_ID
            and connection.execute('PRAGMA user_version').fetchone()[0] == 1, 'FOREIGN_DATABASE')


def open_store(path):
    path = Path(path)
    require(path.is_absolute() and path.name.endswith('.sandbox.sqlite'), 'PRIVATE_SANDBOX_PATH_REQUIRED')
    parent = path.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and path.parent.resolve() == path.parent
            and parent.st_mode & 0o077 == 0, 'PRIVATE_PARENT_REQUIRED')
    if hasattr(os, 'getuid'):
        require(parent.st_uid == os.getuid(), 'PRIVATE_PARENT_OWNER_REQUIRED')
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and metadata.st_mode & 0o077 == 0, 'PRIVATE_DATABASE_REQUIRED')
    if hasattr(os, 'getuid'):
        require(metadata.st_uid == os.getuid(), 'PRIVATE_DATABASE_OWNER_REQUIRED')
    connection = sqlite3.connect(path.as_uri() + '?mode=rw', uri=True, isolation_level=None, timeout=2)
    connection.row_factory = sqlite3.Row
    try:
        tables = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
        application = connection.execute('PRAGMA application_id').fetchone()[0]
        if not tables and application == 0:
            connection.executescript('BEGIN IMMEDIATE;\n' + SCHEMA + '\nPRAGMA application_id=' + str(APPLICATION_ID) + ';\nPRAGMA user_version=1;\nCOMMIT;')
        _check(connection)
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA synchronous=FULL')
        return connection
    except Exception:
        connection.close()
        raise


@contextmanager
def _transaction(connection):
    _check(connection)
    require(not connection.in_transaction, 'NESTED_TRANSACTION_FORBIDDEN')
    connection.execute('BEGIN IMMEDIATE')
    try:
        yield
        connection.execute('COMMIT')
    except Exception:
        connection.execute('ROLLBACK')
        raise


def read_journal(connection, study_id, *, expected_head_hash=None):
    _check(connection)
    row = connection.execute('SELECT declaration_hash,declaration_json FROM sandbox_studies WHERE study_id=?', (study_id,)).fetchone()
    require(row is not None, 'STUDY_NOT_FOUND')
    value = new_journal(_load(row['declaration_json']))
    require(value['declaration_hash'] == row['declaration_hash'], 'STORED_DECLARATION_MISMATCH')
    events = connection.execute('SELECT * FROM sandbox_events WHERE study_id=? ORDER BY sequence', (study_id,)).fetchall()
    require(len(events) <= 512, 'EVENT_LIMIT')
    for row in events:
        event = _load(row['event_json'])
        contract(event, 'event')
        require(event['sequence'] == row['sequence'] and event['command_id'] == row['command_id']
                and event['previous_hash'] == row['previous_hash'] and event['event_hash'] == row['event_hash']
                and digest(command_from_event(event)) == row['command_hash'], 'STORED_EVENT_MISMATCH')
        value['events'].append(event)
    value['head_hash'] = value['events'][-1]['event_hash'] if events else value['declaration_hash']
    value['journal_hash'] = digest({key: item for key, item in value.items() if key != 'journal_hash'})
    _canonical(value)
    replay_journal(value)
    require(expected_head_hash is None or value['head_hash'] == expected_head_hash, 'EXTERNAL_HEAD_MISMATCH')
    return value


def register_study(connection, declaration):
    value = new_journal(declaration)
    with _transaction(connection):
        existing = connection.execute('SELECT declaration_hash,declaration_json FROM sandbox_studies WHERE study_id=?', (declaration['study_id'],)).fetchone()
        if existing:
            require(existing['declaration_hash'] == value['declaration_hash'] and existing['declaration_json'] == _canonical(declaration), 'REGISTRATION_CONFLICT')
        else:
            connection.execute('INSERT INTO sandbox_studies VALUES(?,?,?)',
                               (declaration['study_id'], value['declaration_hash'], _canonical(declaration)))
        return read_journal(connection, declaration['study_id'])


def append_to_store(connection, study_id, command, *, expected_head_hash):
    contract(command, 'command')
    require(isinstance(expected_head_hash, str) and re.fullmatch('[a-f0-9]{64}', expected_head_hash), 'EXPECTED_HEAD_REQUIRED')
    with _transaction(connection):
        current = read_journal(connection, study_id)
        existing = next((event for event in current['events'] if event['command_id'] == command['command_id']), None)
        if existing is not None:
            require(digest(command_from_event(existing)) == digest(command), 'IDEMPOTENCY_CONFLICT')
            return {'journal': current, 'state': replay_journal(current), 'event': deepcopy_event(existing), 'idempotent_replay': True}
        require(current['head_hash'] == expected_head_hash, 'HEAD_CONFLICT')
        updated = append_command(current, command)
        _canonical(updated)
        event = updated['events'][-1]
        connection.execute('INSERT INTO sandbox_events VALUES(?,?,?,?,?,?,?)',
                           (study_id, event['sequence'], event['command_id'], digest(command), event['previous_hash'], event['event_hash'], _canonical(event)))
        return {'journal': updated, 'state': replay_journal(updated), 'event': deepcopy_event(event), 'idempotent_replay': False}


def deepcopy_event(event):
    return _load(_canonical(event))
