"""One class-owned, in-memory synthetic prerequisite; never a runtime proof cache."""

from hashlib import sha256
import json
from pathlib import Path
import os
import sqlite3
import sys
import tempfile
from time import perf_counter

from tests.investor import test_current_correction_fixture as setup
from tests.investor.epoch_continuation_source_fixture import create

MAX_BYTES = 8388608


def _path(db):
    databases = db.execute("PRAGMA database_list").fetchall()
    assert len(databases) == 1 and databases[0][1] == "main"
    supplied = Path(databases[0][2])
    assert not supplied.is_symlink() and supplied.stat().st_nlink == 1 and supplied.stat().st_uid == os.getuid()
    path = supplied.resolve(strict=True)
    assert path.name == "workbench.db" and path.parent.parent == Path(tempfile.gettempdir()).resolve()
    assert path.parent.name.startswith("etf-correction-http-")
    assert not (path.parent / "RESTORE_PENDING_REVIEW").exists()
    return path


def _schema(db):
    return [tuple(row) for row in db.execute("SELECT rowid,type,name,tbl_name,sql FROM sqlite_master ORDER BY rowid")]


def _quote(name):
    return '"' + name.replace('"', '""') + '"'


def pristine_fingerprint(db):
    try:
        _path(db)
        assert not db.in_transaction and db.execute("PRAGMA query_only").fetchone()[0] == 0
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal" and db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        assert all(db.execute("SELECT count(*) FROM " + _quote(table)).fetchone()[0] == 0
                   for table in tables if table not in ("schema_migrations", "sqlite_sequence"))
        migrations = [tuple(row) for row in db.execute("SELECT rowid,version,filename,checksum FROM schema_migrations ORDER BY version")]
        sequences = [tuple(row) for row in db.execute("SELECT name,seq FROM sqlite_sequence ORDER BY name")]
        assert all(row[1] == 0 for row in sequences)
        # Only migration application timestamps vary in otherwise fresh databases.
        value = [_schema(db), migrations, sequences, db.execute("PRAGMA user_version").fetchone()[0], db.execute("PRAGMA application_id").fetchone()[0]]
        return sha256(json.dumps(value).encode()).hexdigest()
    except (AssertionError, OSError, ValueError, sqlite3.Error):
        raise AssertionError("FICTIONAL_TEMPLATE_TARGET_NOT_PRISTINE") from None


def _fingerprint(db, forbidden=None):
    digest = sha256(json.dumps([_schema(db), db.execute("PRAGMA user_version").fetchone()[0], db.execute("PRAGMA application_id").fetchone()[0]]).encode())
    for table, in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        digest.update(json.dumps(table).encode())
        for row in db.execute("SELECT rowid,* FROM " + _quote(table) + " ORDER BY rowid"):
            values = []
            for item in row:
                if forbidden and ((isinstance(item, str) and forbidden in item) or (isinstance(item, bytes) and forbidden.encode() in item)):
                    return None
                values.append(["blob", len(item), sha256(item).hexdigest()] if isinstance(item, bytes) else [type(item).__name__, item])
            digest.update(json.dumps(values, separators=(",", ":"), allow_nan=False).encode()); digest.update(b"\n")
    return digest.hexdigest()


class FrozenEpochTemplate:
    @classmethod
    def capture(cls, source, baseline, value):
        path = _path(source)
        assert not source.in_transaction, "FICTIONAL_TEMPLATE_SOURCE_NOT_QUIESCENT"
        try: result = json.dumps(value, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError, OverflowError, RecursionError): return None
        if json.loads(result) != value or str(path.parent) in result: return None
        size = source.execute("PRAGMA page_count").fetchone()[0] * source.execute("PRAGMA page_size").fetchone()[0]
        if size + len(result.encode()) > MAX_BYTES: return None
        fingerprint = _fingerprint(source, str(path.parent))
        if fingerprint is None: return None
        memory = sqlite3.connect(":memory:", isolation_level=None)
        try:
            source.backup(memory)
            assert _fingerprint(memory) == fingerprint, "FICTIONAL_TEMPLATE_CHANGED"
            memory.execute("PRAGMA query_only=ON")
            instance = cls()
            instance._db, instance._baseline, instance._fingerprint = memory, baseline, fingerprint
            instance._result, instance._result_hash = result, sha256(result.encode()).hexdigest()
            instance.bytes, instance.copies, instance.closed = size + len(result.encode()), 0, False
            return instance
        except BaseException:
            memory.close(); raise

    def restore(self, target):
        assert not self.closed, "FICTIONAL_TEMPLATE_CLOSED"
        assert pristine_fingerprint(target) == self._baseline, "FICTIONAL_TEMPLATE_TARGET_NOT_PRISTINE"
        assert self._db.execute("PRAGMA query_only").fetchone()[0] == 1, "FICTIONAL_TEMPLATE_CHANGED"
        assert _fingerprint(self._db) == self._fingerprint and sha256(self._result.encode()).hexdigest() == self._result_hash, "FICTIONAL_TEMPLATE_CHANGED"
        # The caller owns a new, exclusive scratch database; no test writer exists yet.
        self._db.backup(target)
        assert _fingerprint(target) == self._fingerprint, "FICTIONAL_TEMPLATE_COPY_CHANGED"
        assert target.execute("PRAGMA journal_mode").fetchone()[0] == "wal" and target.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert not target.execute("PRAGMA foreign_key_check").fetchall()
        self.copies += 1
        return json.loads(self._result)

    def close(self):
        if not self.closed:
            self.closed = True; self._db.close()


def build_epoch_template():
    builder = setup.CurrentCorrectionFixtureTests(); started = perf_counter()
    try:
        builder.setUp()
        baseline = pristine_fingerprint(builder.db)
        value = create(builder.db, builder.path)
        template = FrozenEpochTemplate.capture(builder.db, baseline, value)
        try:
            print("FICTIONAL_TEMPLATE_TIMING " + json.dumps({"constructed_ms": (perf_counter() - started) * 1000,
                "bytes": template.bytes if template else 0, "template_available": template is not None}), file=sys.stderr, flush=True)
        except (OSError, ValueError): pass
        return template
    finally:
        builder.doCleanups()
