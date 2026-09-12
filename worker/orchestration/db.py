"""Open only explicit, already migrated workbench databases."""

from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[2]


class WorkbenchError(ValueError):
    pass


def instant(value=None):
    value = datetime.now(timezone.utc) if value is None else value
    if isinstance(value, str):
        if not value.endswith("Z"):
            raise WorkbenchError("UTC_INSTANT_REQUIRED")
        try:
            value = datetime.fromisoformat(value[:-1] + "+00:00")
        except ValueError as exc:
            raise WorkbenchError("INVALID_INSTANT") from exc
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise WorkbenchError("UTC_INSTANT_REQUIRED")
    return value.astimezone(timezone.utc)


def stamp(value=None):
    return instant(value).isoformat(timespec="microseconds").replace("+00:00", "Z")


def canonical_json(value):
    def normalize(item):
        if isinstance(item, float) and item.is_integer():
            return int(item)
        if isinstance(item, list):
            return [normalize(value) for value in item]
        if isinstance(item, tuple):
            return [normalize(value) for value in item]
        if isinstance(item, dict):
            return {key: normalize(value) for key, value in item.items()}
        return item
    return json.dumps(normalize(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def content_hash(value):
    return sha256(canonical_json(value).encode()).hexdigest()


def new_id(prefix):
    return prefix + ":" + uuid4().hex


def assert_writable(connection):
    if os.environ.get("WORKBENCH_MODE") == "read_only":
        raise WorkbenchError("WORKBENCH_READ_ONLY")
    database = next((row[2] for row in connection.execute("PRAGMA database_list") if row[1] == "main"), None)
    directories = [Path(database).resolve().parent] if database else []
    if os.environ.get("WORKBENCH_DATA_DIR"):
        directories.append(Path(os.environ["WORKBENCH_DATA_DIR"]).resolve())
    if any((directory / "RESTORE_PENDING_REVIEW").exists() for directory in directories):
        raise WorkbenchError("RESTORE_PENDING_REVIEW")


def open_database(database_path):
    path = Path(database_path)
    if not path.is_absolute():
        raise WorkbenchError("WORKBENCH_DB_PATH_MUST_BE_ABSOLUTE")
    path = path.resolve(strict=True)
    if not path.is_file() or path.name.lower() == "observatory.db":
        raise WorkbenchError("LEGACY_DATABASE_NOT_ALLOWED")
    connection = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, isolation_level=None, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=5000")
        if connection.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal":
            raise WorkbenchError("WAL_MODE_REQUIRED")
        manifest = json.loads((ROOT / "migrations/manifest.json").read_text())
        expected = manifest["migrations"]
        actual = connection.execute("SELECT version,checksum FROM schema_migrations ORDER BY version").fetchall()
        if (connection.execute("PRAGMA user_version").fetchone()[0] != len(expected)
                or [(row["version"], row["checksum"]) for row in actual]
                != [(item["version"], item["sha256"]) for item in expected]):
            raise WorkbenchError("SCHEMA_VERSION_MISMATCH")
        for item in expected:
            if sha256((ROOT / "migrations" / item["file"]).read_bytes()).hexdigest() != item["sha256"]:
                raise WorkbenchError("MIGRATION_MANIFEST_MISMATCH")
        return connection
    except Exception:
        connection.close()
        raise


@contextmanager
def transaction(connection, immediate=True):
    if immediate:
        assert_writable(connection)
    changes_before = connection.total_changes
    if connection.in_transaction:
        savepoint = "nested_" + uuid4().hex
        connection.execute("SAVEPOINT " + savepoint)
        try:
            yield connection
            if connection.total_changes != changes_before:
                assert_writable(connection)
            connection.execute("RELEASE SAVEPOINT " + savepoint)
        except BaseException:
            connection.execute("ROLLBACK TO SAVEPOINT " + savepoint)
            connection.execute("RELEASE SAVEPOINT " + savepoint)
            raise
    else:
        connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        try:
            yield connection
            if connection.total_changes != changes_before:
                assert_writable(connection)
            connection.execute("COMMIT")
        except BaseException:
            connection.execute("ROLLBACK")
            raise
