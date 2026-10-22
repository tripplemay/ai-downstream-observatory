"""Conservative existing-workbench backup/restore workspace gate; no cleanup."""

import argparse
import json
from pathlib import Path
import shutil
import sqlite3
import stat
import sys


HEADROOM_BYTES = 1024 ** 3


def payload_bytes(data_dir):
    data_dir = Path(data_dir)
    database = data_dir / "etf-workbench.db"
    if not database.is_file() or database.is_symlink():
        raise ValueError("DATABASE_FILE_REQUIRED")
    db = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        db.execute("PRAGMA query_only=ON")
        count, attachments = db.execute("SELECT count(*),coalesce(sum(byte_size),0) FROM attachments").fetchone()
    finally:
        db.close()
    if type(attachments) is not int or attachments < 0:
        raise ValueError("INVALID_ATTACHMENT_BYTES")
    total = attachments
    for name in ("etf-workbench.db", "etf-workbench.db-wal", "auth.sqlite", "auth.sqlite-wal"):
        path = data_dir / name
        if not path.exists() and not path.is_symlink():
            continue
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("REGULAR_INPUT_FILE_REQUIRED")
        total += info.st_size
    # Account for tar headers, padding and the JSON manifest without inspecting personal fields.
    return total + max(1024 ** 2, (count + 3) * 4096)


def check_capacity(data_dir, backup_dir, restore_parent, *, usage=shutil.disk_usage, device=None):
    payload = payload_bytes(data_dir)
    device = device or (lambda path: path.stat().st_dev)
    requirements = {}
    # Three retained archives plus snapshot/encryption staging; restore retains
    # an authenticated tar and extracted payload. Summing shared devices is conservative.
    for role, path, multiplier in (("backup", Path(backup_dir), 4), ("restore", Path(restore_parent), 2)):
        if not path.is_dir() or path.is_symlink():
            raise ValueError("EXISTING_PRIVATE_DIRECTORY_REQUIRED")
        identity = device(path)
        entry = requirements.setdefault(identity, {"roles": [], "required_bytes": HEADROOM_BYTES, "available_bytes": usage(path).free})
        entry["roles"].append(role)
        entry["required_bytes"] += multiplier * payload
        entry["available_bytes"] = min(entry["available_bytes"], usage(path).free)
    volumes = list(requirements.values())
    sufficient = all(row["available_bytes"] >= row["required_bytes"] for row in volumes)
    return {"status": "sufficient" if sufficient else "insufficient", "estimated_payload_bytes": payload,
        "headroom_bytes_per_device": HEADROOM_BYTES, "volumes": volumes,
        "cleanup_performed": False, "first_release_capacity_assessed": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--backup-dir", required=True)
    parser.add_argument("--restore-parent", required=True)
    args = parser.parse_args()
    try:
        result = check_capacity(args.data_dir, args.backup_dir, args.restore_parent)
    except (OSError, ValueError, sqlite3.Error):
        print("RELEASE_CAPACITY_CHECK_FAILED", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    if result["status"] != "sufficient":
        print("RELEASE_BACKUP_RESTORE_CAPACITY_INSUFFICIENT", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
