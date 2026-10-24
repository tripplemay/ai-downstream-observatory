"""Root-operated single-local-backup rotation after independently verified copying."""

import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys

ARCHIVE = re.compile(r"workbench-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.etfbackup\Z")
DIGEST = re.compile(r"[a-f0-9]{64}\Z")
RELEASE = re.compile(r"[a-f0-9]{40}\Z")
WORKBENCH_UID = 10001
MAX_MANIFEST = 1024 ** 2


def require(condition, code):
    if not condition:
        raise ValueError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def read_manifest(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
            and info.st_mode & 0o077 == 0 and info.st_size <= MAX_MANIFEST, "UNSAFE_OPERATOR_RECEIPTS")
    return json.loads(path.read_text(), object_pairs_hook=unique_object)


def private_directory(path, owner):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner and info.st_mode & 0o077 == 0,
            "UNSAFE_PRIVATE_DIRECTORY")


def archive_identity(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == WORKBENCH_UID
                and info.st_mode & 0o077 == 0 and 0 < info.st_size <= 32 * 1024 ** 3, "UNSAFE_ARCHIVE")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(fd, 8 * 1024 ** 2)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(fd)
        require((info.st_size, info.st_mtime_ns, info.st_ino) ==
                (after.st_size, after.st_mtime_ns, after.st_ino), "ARCHIVE_CHANGED_DURING_HASH")
        return {"name": path.name, "bytes": info.st_size, "sha256": digest.hexdigest(),
                "inode": info.st_ino, "device": info.st_dev, "mtime_ns": info.st_mtime_ns}
    finally:
        os.close(fd)


def current_release(root):
    require(root.is_absolute() and root.resolve() == root and root != Path("/"), "CANONICAL_PROJECT_ROOT_REQUIRED")
    current = root / "current"
    require(current.is_symlink(), "CURRENT_RELEASE_LINK_REQUIRED")
    target = current.resolve()
    require(target.parent == root / "releases" and RELEASE.fullmatch(target.name), "UNSAFE_RELEASE_LINK")
    require((target / ".release-sha").read_text().strip() == target.name, "RELEASE_MARKER_MISMATCH")
    require(not (root / "data-workbench/RESTORE_PENDING_REVIEW").exists()
            and not (root / "data-workbench/RESTORE_PENDING_REVIEW").is_symlink(), "RECOVERY_BLOCKS_RETENTION")
    private_directory(root / "backups-workbench", WORKBENCH_UID)
    return target.name


def validate_receipts(receipts, root, release):
    require(isinstance(receipts, dict) and set(receipts) == {
        "format", "primary_root", "source_release", "offhost_host", "offhost_directory",
        "verified_at", "keep_archive", "files", "restore_verification"}, "INVALID_RECEIPT_FIELDS")
    require(receipts["format"] == "etf-offhost-backup-receipts-v1"
            and receipts["primary_root"] == str(root) and receipts["source_release"] == release,
            "RECEIPT_SCOPE_MISMATCH")
    require(isinstance(receipts["offhost_host"], str) and receipts["offhost_host"].strip()
            and receipts["offhost_host"] != socket.gethostname()
            and isinstance(receipts["offhost_directory"], str)
            and receipts["offhost_directory"].startswith("/"), "DISTINCT_OFFHOST_ATTESTATION_REQUIRED")
    at = datetime.datetime.fromisoformat(receipts["verified_at"].replace("Z", "+00:00"))
    require(at.tzinfo is not None and at <= datetime.datetime.now(datetime.timezone.utc), "INVALID_RECEIPT_TIME")
    require(isinstance(receipts["keep_archive"], str) and ARCHIVE.fullmatch(receipts["keep_archive"]), "INVALID_KEEP_ARCHIVE")
    files = receipts["files"]
    require(isinstance(files, list) and 1 <= len(files) <= 1000, "BOUNDED_ARCHIVE_RECEIPTS_REQUIRED")
    indexed = {}
    for row in files:
        require(isinstance(row, dict) and set(row) == {"name", "bytes", "sha256"}
                and isinstance(row["name"], str) and ARCHIVE.fullmatch(row["name"])
                and row["name"] not in indexed and type(row["bytes"]) is int and row["bytes"] > 0
                and isinstance(row["sha256"], str) and DIGEST.fullmatch(row["sha256"]), "INVALID_ARCHIVE_RECEIPT")
        indexed[row["name"]] = row
    keep = indexed.get(receipts["keep_archive"])
    proof = receipts["restore_verification"]
    require(keep is not None and isinstance(proof, dict) and set(proof) == {
        "archive", "sha256", "source_release", "schema_version", "status", "network_disabled",
        "financial_and_research_match"}, "RESTORE_PROOF_REQUIRED")
    require(proof["archive"] == keep["name"] and proof["sha256"] == keep["sha256"]
            and proof["source_release"] == release and type(proof["schema_version"]) is int
            and proof["schema_version"] > 0 and proof["status"] == "verified"
            and proof["network_disabled"] is True and proof["financial_and_research_match"] is True,
            "CURRENT_OFFHOST_RESTORE_PROOF_REQUIRED")
    return indexed


def plan_retention(root, receipts):
    release = current_release(root)
    indexed = validate_receipts(receipts, root, release)
    paths = sorted((root / "backups-workbench").iterdir())
    require(all(ARCHIVE.fullmatch(p.name) for p in paths), "UNKNOWN_BACKUP_ENTRY_BLOCKS_RETENTION")
    require({p.name for p in paths} == set(indexed), "ARCHIVE_SET_CHANGED")
    identities = [archive_identity(p) for p in paths]
    for row in identities:
        expected = indexed[row["name"]]
        require(all(row[key] == expected[key] for key in ("bytes", "sha256")), "OFFHOST_COPY_MISMATCH")
    body = {"format": "etf-backup-retention-plan-v1", "source_release": release,
            "receipt_sha256": hashlib.sha256(canonical(receipts)).hexdigest(), "keep_archive": receipts["keep_archive"],
            "archives": identities, "remove": [row["name"] for row in identities if row["name"] != receipts["keep_archive"]]}
    return {**body, "plan_hash": hashlib.sha256(canonical(body)).hexdigest()}


def container_mounts():
    ids = subprocess.check_output(["docker", "ps", "-aq", "--no-trunc"], text=True, timeout=30).split()
    if not ids:
        return []
    rows = subprocess.check_output(["docker", "inspect", "--format", "{{json .Mounts}}", *ids], text=True, timeout=60)
    return [mount for line in rows.splitlines() for mount in json.loads(line)]


def check_mounts(root, mounts):
    directory = root / "backups-workbench"
    for mount in mounts:
        if not mount.get("Source"):
            continue
        source = Path(mount["Source"]).resolve()
        require(not (source == directory or source in directory.parents or directory in source.parents),
                "CONTAINER_REFERENCE_BLOCKS_RETENTION")


@contextlib.contextmanager
def release_lock(root):
    info = (root / ".release.lock").lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.geteuid()
            and info.st_mode & 0o022 == 0, "UNSAFE_RELEASE_LOCK")
    with (root / ".release.lock").open("r") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as cause:
            raise ValueError("RELEASE_OR_RETENTION_IN_PROGRESS") from cause
        yield


def execute_retention(root, receipts, expected_hash, journal, mounts=container_mounts):
    with release_lock(root):
        plan = plan_retention(root, receipts)
        require(plan["plan_hash"] == expected_hash, "RETENTION_PLAN_CHANGED")
        check_mounts(root, mounts())
        require(journal.parent == root / "backup-retention-evidence", "RETENTION_JOURNAL_SCOPE_INVALID")
        private_directory(journal.parent, os.geteuid())
        with open(journal, "x", opener=lambda path, flags: os.open(path, flags | os.O_NOFOLLOW, 0o600)) as log:
            fd = os.open(journal.parent, os.O_RDONLY)
            try: os.fsync(fd)
            finally: os.close(fd)
            def record(value):
                stamped = {**value, "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                log.write(json.dumps(stamped, sort_keys=True) + "\n"); log.flush(); os.fsync(log.fileno())
            record({"event": "approved_plan", "plan": plan, "operator_receipts": receipts})
            by_name = {row["name"]: row for row in plan["archives"]}
            directory = root / "backups-workbench"
            for name in plan["remove"]:
                require(current_release(root) == plan["source_release"], "RELEASE_CHANGED")
                require(archive_identity(directory / plan["keep_archive"]) == by_name[plan["keep_archive"]], "KEEP_ARCHIVE_CHANGED")
                path = directory / name
                require(archive_identity(path) == by_name[name], "CANDIDATE_CHANGED")
                record({"event": "remove_intent", "archive": by_name[name]})
                path.unlink()
                fd = os.open(directory, os.O_RDONLY)
                try: os.fsync(fd)
                finally: os.close(fd)
                record({"event": "removed_primary_copy", "archive": name})
            require(sorted(p.name for p in directory.iterdir()) == [plan["keep_archive"]], "FINAL_ARCHIVE_SET_CHANGED")
            record({"event": "complete", "retained": plan["keep_archive"], "local_archive_count": 1})
        return {"status": "single_local_backup_verified", "retained": plan["keep_archive"],
                "removed_count": len(plan["remove"]), "journal": str(journal)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--receipts", type=Path, required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--expected-plan-hash")
    parser.add_argument("--journal", type=Path)
    args = parser.parse_args()
    receipts = read_manifest(args.receipts)
    if args.execute:
        require(os.geteuid() == 0 and args.expected_plan_hash and args.journal, "ROOT_EXPLICIT_PLAN_AND_JOURNAL_REQUIRED")
        result = execute_retention(args.root, receipts, args.expected_plan_hash, args.journal)
    else:
        require(not args.expected_plan_hash and not args.journal, "EXECUTION_OPTIONS_REQUIRE_EXECUTE")
        with release_lock(args.root):
            result = plan_retention(args.root, receipts)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print("BACKUP_RETENTION_STOPPED; preserve archives and inspect operator evidence; no automatic retry", file=sys.stderr)
        raise SystemExit(1)
