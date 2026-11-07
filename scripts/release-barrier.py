"""Write-ahead cutover identity and non-overwriting recovery fences. Never unlock."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import sys


def _sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ValueError("EXACT_RELEASE_REQUIRED")


def _directory(path, uid):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("RELEASE_DIRECTORY_ALIAS_REFUSED")
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    s = os.fstat(fd)
    if s.st_uid != uid or stat.S_IMODE(s.st_mode) & 0o077:
        os.close(fd)
        raise ValueError("RELEASE_DIRECTORY_OWNER_OR_MODE_INVALID")
    return path, fd


def _create(fd, name, value, uid, gid):
    # Existence is an unresolved intent, never permission to repeat or overwrite.
    file = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    with os.fdopen(file, "w") as stream:
        json.dump(value, stream, sort_keys=True, separators=(",", ":"), allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
        os.fchown(stream.fileno(), uid, gid)
        os.fsync(stream.fileno())
    os.fsync(fd)


def begin_cutover(evidence, data, sha, project, *, operator_uid=0, app_uid=10001):
    _sha(sha)
    if not isinstance(project, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise ValueError("RELEASE_PROJECT_INVALID")
    evidence = Path(evidence)
    if evidence.parent.name != "release-evidence" or not re.fullmatch(sha + r"-[0-9]{8}T[0-9]{6}Z", evidence.name):
        raise ValueError("RELEASE_EVIDENCE_IDENTITY_INVALID")
    data, data_fd = _directory(data, app_uid)
    try:
        _, evidence_fd = _directory(evidence, operator_uid)
        try:
            value = {"format": "etf-release-cutover-intent-v1", "release_sha": sha,
                     "data_dir": str(data), "project": project, "database_overwritten": False,
                     "recorded_at": datetime.now(timezone.utc).isoformat()}
            _create(evidence_fd, "cutover-started.json", value, operator_uid, os.getgid())
            return value
        finally:
            os.close(evidence_fd)
    finally:
        os.close(data_fd)


def fence_release(data, sha, *, app_uid=10001, app_gid=10001):
    _sha(sha)
    _, fd = _directory(data, app_uid)
    try:
        value = {"reason": "release failed; preserve new facts and reconcile before resuming", "release_sha": sha}
        try:
            _create(fd, "RESTORE_PENDING_REVIEW", value, app_uid, app_gid)
        except FileExistsError:
            s = os.stat("RESTORE_PENDING_REVIEW", dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(s.st_mode) or s.st_uid != app_uid or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) & 0o077:
                raise ValueError("RECOVERY_MARKER_UNSAFE") from None
            return {"created": False, "existing_review_preserved": True, "release_sha": sha}
        return {"created": True, "existing_review_preserved": False, "release_sha": sha}
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("begin", "fence"))
    parser.add_argument("--release", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--evidence-dir")
    parser.add_argument("--project")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("AUTHORIZED_ROOT_OPERATOR_REQUIRED")
    if args.phase == "begin":
        if not args.evidence_dir or not args.project:
            raise ValueError("CUTOVER_EVIDENCE_AND_PROJECT_REQUIRED")
        value = begin_cutover(args.evidence_dir, args.data_dir, args.release, args.project)
    else:
        if args.evidence_dir is not None or args.project is not None:
            raise ValueError("UNEXPECTED_FENCE_ARGUMENT")
        value = fence_release(args.data_dir, args.release)
    print(json.dumps(value, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        # Do not expose private path values or filesystem contents through CI.
        print(str(error) if isinstance(error, ValueError) else "RELEASE_BARRIER_IO_FAILED", file=sys.stderr)
        raise SystemExit(1)
