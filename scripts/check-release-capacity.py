"""Conservative existing-workbench backup/restore workspace gate; no cleanup."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
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


def check_capacity(data_dir, backup_dir, restore_parent, *, stage="before_online_backup", usage=shutil.disk_usage, device=None):
    if stage not in ("before_online_backup", "after_online_backup"):
        raise ValueError("INVALID_CAPACITY_STAGE")
    payload = payload_bytes(data_dir)
    device = device or (lambda path: path.stat().st_dev)
    requirements = {}
    # Three retained archives plus snapshot/encryption staging; restore retains
    # an authenticated tar and extracted payload. Summing shared devices is conservative.
    backup_multiplier = 3 if stage == "after_online_backup" else 4
    for role, path, multiplier in (("backup", Path(backup_dir), backup_multiplier), ("restore", Path(restore_parent), 2)):
        if not path.is_dir() or path.is_symlink():
            raise ValueError("EXISTING_PRIVATE_DIRECTORY_REQUIRED")
        identity = device(path)
        entry = requirements.setdefault(identity, {"roles": [], "required_bytes": HEADROOM_BYTES, "available_bytes": usage(path).free})
        entry["roles"].append(role)
        entry["required_bytes"] += multiplier * payload
        entry["available_bytes"] = min(entry["available_bytes"], usage(path).free)
    volumes = list(requirements.values())
    sufficient = all(row["available_bytes"] >= row["required_bytes"] for row in volumes)
    return {"status": "sufficient" if sufficient else "insufficient", "stage": stage, "estimated_payload_bytes": payload,
        "headroom_bytes_per_device": HEADROOM_BYTES, "volumes": volumes,
        "cleanup_performed": False, "first_release_capacity_assessed": False}


def check_upload_capacity(data_dir, backup_dir, restore_parent, incoming, releases, docker_root, budget,
                          *, usage=shutil.disk_usage, device=None):
    fields = {"format", "release_sha", "image_archive_bytes", "image_archive_sha256", "image_content_bytes",
              "image_expanded_bytes", "source_archive_bytes", "source_archive_sha256", "source_expanded_bytes"}
    if type(budget) is not dict or set(budget) != fields or budget["format"] != "etf-upload-budget-v1":
        raise ValueError("INVALID_UPLOAD_BUDGET")
    if not re.fullmatch(r"[a-f0-9]{40}", budget["release_sha"]):
        raise ValueError("INVALID_RELEASE")
    for field in ("image_archive_sha256", "source_archive_sha256"):
        if not re.fullmatch(r"[a-f0-9]{64}", budget[field]):
            raise ValueError("INVALID_ARCHIVE_HASH")
    for field in fields - {"format", "release_sha", "image_archive_sha256", "source_archive_sha256"}:
        maximum = 256 * 1024 ** 2 if field.startswith("source_") else 8 * 1024 ** 3
        if type(budget[field]) is not int or not 0 < budget[field] <= maximum:
            raise ValueError("INVALID_UPLOAD_BYTES")
    if budget["image_expanded_bytes"] < budget["image_content_bytes"]:
        raise ValueError("INVALID_IMAGE_EXPANSION")
    payload = payload_bytes(data_dir)
    device = device or (lambda path: path.stat().st_dev)
    volumes = {}
    def add(role, path, upload, recovery):
        path = Path(path)
        if not path.is_dir() or path.is_symlink() or path.resolve() != path:
            raise ValueError("CANONICAL_EXISTING_DIRECTORY_REQUIRED")
        entry = volumes.setdefault(device(path), {"roles": [], "available_bytes": usage(path).free,
            "image_import_bytes": HEADROOM_BYTES, "backup_restore_bytes": HEADROOM_BYTES})
        entry["roles"].append(role)
        entry["available_bytes"] = min(entry["available_bytes"], usage(path).free)
        entry["image_import_bytes"] += upload
        entry["backup_restore_bytes"] += recovery
    transfer = budget["image_archive_bytes"] + budget["source_archive_bytes"] + 2 * 1024 ** 2
    add("incoming", incoming, transfer, transfer)
    source = budget["source_expanded_bytes"] + 1024 ** 2
    add("source", releases, source, source)
    # Reserve content plus extracted layers; import additionally allows a full temporary layer copy.
    retained = budget["image_content_bytes"] + budget["image_expanded_bytes"] + 64 * 1024 ** 2
    add("docker", docker_root, retained + budget["image_expanded_bytes"], retained)
    add("backup", backup_dir, 0, 4 * payload)
    add("restore", restore_parent, 0, 2 * payload)
    rows = list(volumes.values())
    for row in rows:
        row["required_bytes"] = max(row["image_import_bytes"], row["backup_restore_bytes"])
    return {"status": "sufficient" if all(r["available_bytes"] >= r["required_bytes"] for r in rows) else "insufficient",
        "stage": "before_upload", "release_sha": budget["release_sha"], "estimated_payload_bytes": payload,
        "budget_sha256": hashlib.sha256(json.dumps(budget, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "volumes": rows, "cleanup_performed": False, "first_release_capacity_assessed": False}


def configured_upload_paths(root, config):
    config = Path(config)
    info = config.lstat()
    if config.resolve() != config or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise ValueError("PRIVATE_ROOT_CONFIG_REQUIRED")
    command = 'set -eu; source "$1"; printf "%s\\0" "$WORKBENCH_DEPLOY_ROOT" "${WORKBENCH_DATA_DIR_HOST:-$WORKBENCH_DEPLOY_ROOT/data-workbench}" "${WORKBENCH_BACKUP_DIR_HOST:-$WORKBENCH_DEPLOY_ROOT/backups-workbench}" "${WORKBENCH_RESTORE_PARENT_DIR:-$WORKBENCH_DEPLOY_ROOT/restores-workbench}"'
    paths = subprocess.check_output(["bash", "-c", command, "upload-preflight", str(config)],
                                   env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}, stderr=subprocess.DEVNULL, timeout=15).decode().split("\0")
    if len(paths) != 5 or paths[-1] != "" or paths[0] != root:
        raise ValueError("CONFIG_ROOT_MISMATCH")
    if not all(re.fullmatch(r"/[A-Za-z0-9._/-]+", p) and str(Path(p).resolve()) == p for p in paths[:-1]):
        raise ValueError("INVALID_CONFIGURED_PATH")
    docker = subprocess.check_output(["docker", "info", "--format", "{{.DockerRootDir}}"],
                                     stderr=subprocess.DEVNULL, timeout=30).decode().strip()
    return (*paths[1:-1], str(Path(root) / "incoming"), str(Path(root) / "releases"), docker)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir")
    parser.add_argument("--backup-dir")
    parser.add_argument("--restore-parent")
    parser.add_argument("--stage", choices=("before_online_backup", "after_online_backup"), default="before_online_backup")
    parser.add_argument("--pre-upload-root")
    parser.add_argument("--config", default="/etc/etf-workbench/release.env")
    parser.add_argument("--upload-budget")
    parser.add_argument("--release")
    args = parser.parse_args()
    try:
        if args.pre_upload_root:
            if any((args.data_dir, args.backup_dir, args.restore_parent)) or args.stage != "before_online_backup":
                raise ValueError("AMBIGUOUS_CAPACITY_MODE")
            if not args.upload_budget or len(args.upload_budget) > 8192:
                raise ValueError("BOUNDED_UPLOAD_BUDGET_REQUIRED")
            budget = json.loads(base64.b64decode(args.upload_budget, validate=True))
            if budget.get("release_sha") != args.release:
                raise ValueError("UPLOAD_RELEASE_MISMATCH")
            paths = configured_upload_paths(args.pre_upload_root, args.config)
            result = check_upload_capacity(*paths, budget)
        else:
            if not all((args.data_dir, args.backup_dir, args.restore_parent)) or args.upload_budget or args.release:
                raise ValueError("EXPLICIT_CAPACITY_PATHS_REQUIRED")
            result = check_capacity(args.data_dir, args.backup_dir, args.restore_parent, stage=args.stage)
    except (OSError, ValueError, TypeError, AttributeError, sqlite3.Error, subprocess.SubprocessError):
        print("RELEASE_CAPACITY_CHECK_FAILED", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    if result["status"] != "sufficient":
        print("RELEASE_BACKUP_RESTORE_CAPACITY_INSUFFICIENT", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
