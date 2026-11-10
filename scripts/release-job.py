"""One-shot host-owned release execution. Queries never submit, retry or unlock."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import runpy
import shlex
import sqlite3
import stat
import subprocess
import sys
import time
import uuid

barrier = runpy.run_path(str(Path(__file__).with_name("release-barrier.py")))
ACTIVE = {"active", "activating", "deactivating", "reloading"}
ROLES = {"web", "worker", "verifier", "market-provider", "ai-explanation"}


def require(condition, code="RELEASE_JOB_INVALID"):
    if not condition:
        raise ValueError(code)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def pairs(rows):
    value = {}
    for key, item in rows:
        require(key not in value)
        value[key] = item
    return value


class ReleaseJob:
    def __init__(self, root, sha, workflow_run, attempt, config, *, owner_uid=0, app_uid=10001, app_gid=10001,
                 runner=subprocess.run, clock=time.time):
        barrier["_sha"](sha)
        require(re.fullmatch(r"[1-9][0-9]{0,19}", workflow_run) is not None)
        require(re.fullmatch(r"[1-9][0-9]{0,5}", attempt) is not None)
        self.root, self.config = Path(root), Path(config)
        for path in (self.root, self.config):
            require(path.is_absolute() and path.resolve() == path and re.fullmatch(r"/[A-Za-z0-9._/-]+", str(path)))
        self.sha, self.workflow_run, self.attempt = sha, workflow_run, attempt
        self.owner_uid, self.app_uid, self.app_gid = owner_uid, app_uid, app_gid
        self.runner, self.clock = runner, clock
        self.release = self.root / "releases" / sha
        self.directory = self.root / "release-jobs" / sha
        self.bundle = self.root / "incoming" / sha / f"images-{workflow_run}-{attempt}" / "release-images.json"
        self.unit = "etf-workbench-release-" + sha + ".service"

    def _directory(self, path, private=False):
        s = path.lstat()
        require(path.resolve() == path and stat.S_ISDIR(s.st_mode) and s.st_uid == self.owner_uid)
        require(not stat.S_IMODE(s.st_mode) & (0o077 if private else 0o022))

    def _file(self, path, private=True, maximum=32768):
        s = path.lstat()
        require(path.resolve() == path and stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == self.owner_uid)
        require(not stat.S_IMODE(s.st_mode) & (0o077 if private else 0o022) and s.st_size <= maximum)
        return path.read_bytes()

    def _read(self, path, maximum=32768):
        value = json.loads(self._file(path, maximum=maximum), object_pairs_hook=pairs)
        require(type(value) is dict)
        return value

    @contextmanager
    def _lock(self, path):
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            s = os.fstat(fd)
            require(stat.S_ISREG(s.st_mode) and s.st_uid == self.owner_uid and s.st_nlink == 1 and not s.st_mode & 0o077)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)

    def _write(self, name, value):
        require(name in {"intent.json", "started.json", "execution.json", "terminal.json", "reconciliation.json"})
        self._directory(self.directory, True)
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise FileExistsError("RELEASE_JOB_RECORD_EXISTS")
            bound = {**value, "release_sha": self.sha, "workflow_run": self.workflow_run, "attempt": self.attempt}
            if name != "intent.json":
                bound["intent_sha256"] = digest(self.directory / "intent.json")
            temporary = ".pending-" + uuid.uuid4().hex
            barrier["_create"](fd, temporary, bound, self.owner_uid, os.getgid())
            # The directory reserves the job; readers see only complete, synced records.
            os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
            os.unlink(temporary, dir_fd=fd)
            os.fsync(fd)
            return bound
        finally:
            os.close(fd)

    def _intent(self):
        self._directory(self.directory.parent, True)
        self._directory(self.directory, True)
        value = self._read(self.directory / "intent.json")
        require((value.get("release_sha"), value.get("workflow_run"), value.get("attempt")) ==
                (self.sha, self.workflow_run, self.attempt))
        require(value.get("config") == str(self.config) and value.get("unit") == self.unit)
        require(type(value.get("deadline_epoch")) is int)
        return value

    def _bound(self, name):
        value = self._read(self.directory / name)
        require((value.get("release_sha"), value.get("workflow_run"), value.get("attempt")) ==
                (self.sha, self.workflow_run, self.attempt))
        require(value.get("intent_sha256") == digest(self.directory / "intent.json"))
        return value

    def _source(self):
        self._directory(self.root)
        self._directory(self.release)
        require(self._file(self.release / ".release-sha", False).decode().strip() == self.sha)
        manifest = self._file(self.release / ".release-files.sha256", False, 4 * 1024**2).decode()
        names = set()
        for line in manifest.splitlines():
            match = re.fullmatch(r"([a-f0-9]{64})  \./([^\r\n]+)", line)
            require(match is not None)
            name = match[2]
            require(name not in names and all(x not in ("", ".", "..") for x in name.split("/")))
            path = self.release / name
            self._file(path, False, 128 * 1024**2)
            require(digest(path) == match[1])
            names.add(name)
        actual = set()
        for path in self.release.rglob("*"):
            require(not path.is_symlink())
            if path.is_dir():
                self._directory(path)
            elif path.name != ".release-files.sha256":
                actual.add(str(path.relative_to(self.release)))
        require(names == actual and {"scripts/deploy-workbench.sh", "scripts/release-job.py", "scripts/release-barrier.py"}.issubset(names))
        return hashlib.sha256(manifest.encode()).hexdigest()

    def _manager(self):
        command = ["systemctl", "show", self.unit, "--property=LoadState,ActiveState,SubState,MainPID,Result"]
        result = self.runner(command, text=True, capture_output=True, timeout=10)
        values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        require(result.returncode == 0 or result.returncode == 4 and values.get("LoadState") == "not-found",
                "RELEASE_MANAGER_OBSERVATION_UNAVAILABLE")
        require(set(values) == {"LoadState", "ActiveState", "SubState", "MainPID", "Result"})
        require(re.fullmatch(r"[0-9]{1,20}", values["MainPID"]) is not None)
        require(all(re.fullmatch(r"[a-z-]{0,40}", v) is not None for k, v in values.items() if k != "MainPID"))
        return values

    def submit(self, deadline):
        require(type(deadline) is int and 0 < deadline - self.clock() <= 75 * 60, "RELEASE_DEADLINE_INVALID")
        self._directory(self.root)
        source_hash = self._source()
        config_hash = hashlib.sha256(self._file(self.config, maximum=1024**2)).hexdigest()
        bundle = self._read(self.bundle, 1024**2)
        require(bundle.get("release_sha") == self.sha and type(bundle.get("market_provider")) is bool)
        require(type(bundle.get("ai_explanation", False)) is bool)
        parent = self.directory.parent
        parent.mkdir(mode=0o700, exist_ok=True)
        self._directory(parent, True)
        with self._lock(self.root / ".release-job-submit.lock"):
            require(not self.directory.exists() and not self.directory.is_symlink(), "RELEASE_ALREADY_SUBMITTED_QUERY_ONLY")
            for directory in parent.iterdir():
                self._directory(directory, True)
                require(re.fullmatch(r"[a-f0-9]{40}", directory.name) is not None)
                prior = self._read(directory / "intent.json")
                other = ReleaseJob(self.root, directory.name, prior["workflow_run"], prior["attempt"], prior["config"],
                                   owner_uid=self.owner_uid, app_uid=self.app_uid, app_gid=self.app_gid, runner=self.runner, clock=self.clock)
                terminal = (directory / "terminal.json").is_file()
                closed = other._bound("terminal.json")["status"] in {"SUCCEEDED", "FAILED_PRE_CUTOVER", "FAILED_RECOVERY_REQUIRED"} if terminal else other._reconciled()
                require(closed and other._manager()["ActiveState"] not in ACTIVE,
                        "ANOTHER_RELEASE_REQUIRES_RECONCILIATION")
            require(self._manager()["LoadState"] == "not-found", "RELEASE_UNIT_ALREADY_EXISTS")
            previous = None
            current = self.root / "current"
            if current.exists() or current.is_symlink():
                require(current.is_symlink())
                target = current.resolve()
                require(target.parent == self.root / "releases")
                previous = target.name
                barrier["_sha"](previous)
                require(self._file(target / ".release-sha", False).decode().strip() == previous)
            require(0 < deadline - self.clock() <= 75 * 60, "RELEASE_DEADLINE_EXPIRED")
            self.directory.mkdir(mode=0o700)
            intent = self._write("intent.json", {"format": "etf-release-job-v1", "unit": self.unit,
                "config": str(self.config), "config_sha256": config_hash, "source_manifest_sha256": source_hash,
                "bundle_sha256": digest(self.bundle), "market_provider": bundle["market_provider"],
                "ai_explanation": bundle.get("ai_explanation", False), "previous_release_sha": previous,
                "deadline_epoch": deadline, "created_at": datetime.now(timezone.utc).isoformat()})
            common = ["--root", str(self.root), "--release", self.sha, "--workflow-run", self.workflow_run,
                      "--attempt", self.attempt, "--config", str(self.config)]
            program = str(self.release / "scripts/release-job.py")
            require(0 < deadline - self.clock() <= 75 * 60, "RELEASE_DEADLINE_EXPIRED")
            remaining = max(1, min(75 * 60, int(deadline - self.clock())))
            command = ["systemd-run", "--quiet", "--collect", "--service-type=exec", "--unit=" + self.unit,
                "--property=Restart=no", "--property=RuntimeMaxSec=" + str(remaining) + "s", "--property=TimeoutStopSec=90s",
                "--property=KillMode=control-group", "--property=UMask=0077", "--property=StandardInput=null",
                "--property=WorkingDirectory=" + str(self.release),
                "--property=ExecStopPost=" + shlex.join(["/usr/bin/python3", program, "finalize", *common]),
                "/usr/bin/python3", program, "worker", *common]
            # Unknown submission is reconciled through status; never submit a second time.
            result = self.runner(command, text=True, capture_output=True, timeout=20)
            require(result.returncode == 0, "RELEASE_SUBMISSION_UNKNOWN_QUERY_ONLY")
            return {"status": "SUBMITTED_NOT_YET_CUT_OVER", "release_sha": self.sha, "unit": intent["unit"], "deadline_epoch": deadline}

    def worker(self):
        intent = self._intent()
        require(0 < intent["deadline_epoch"] - self.clock() <= 75 * 60, "RELEASE_DEADLINE_EXPIRED")
        require(self._source() == intent["source_manifest_sha256"])
        require(hashlib.sha256(self._file(self.config, maximum=1024**2)).hexdigest() == intent["config_sha256"])
        require(digest(self.bundle) == intent["bundle_sha256"])
        require(not list((self.root / "release-evidence").glob(self.sha + "-*")), "EXISTING_CUTOVER_REQUIRES_REVIEW")
        require(0 < intent["deadline_epoch"] - self.clock() <= 75 * 60, "RELEASE_DEADLINE_EXPIRED")
        self._write("started.json", {"pid": os.getpid(), "parent_pid": os.getppid(), "started_at": datetime.now(timezone.utc).isoformat()})
        command = ["bash", str(self.release / "scripts/deploy-workbench.sh"), "--release", self.sha,
                   "--release-dir", str(self.release), "--config", str(self.config), "--image-bundle", str(self.bundle), "--execute"]
        environment = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8",
                       "HOME": pwd.getpwuid(self.owner_uid).pw_dir, "PYTHONDONTWRITEBYTECODE": "1"}
        remaining = intent["deadline_epoch"] - self.clock()
        require(0 < remaining <= 75 * 60, "RELEASE_DEADLINE_EXPIRED")
        try:
            result = self.runner(command, cwd=self.release, env=environment, timeout=remaining)
            code = result.returncode
        except subprocess.TimeoutExpired:
            code = 124
        self._write("execution.json", {"exit_code": code, "finished_at": datetime.now(timezone.utc).isoformat()})
        if code == 0:
            # Full verification belongs to ExecStart's original absolute budget,
            # not the short failure-cleanup hook's TimeoutStopSec.
            terminal = self._finalize(None, None, None, worker_completed=True)
            return 0 if terminal["status"] == "SUCCEEDED" else 1
        return code

    def _fleet(self, project):
        result = self.runner(["docker", "ps", "--filter", "label=com.docker.compose.project=" + project, "--format", "{{.ID}}"],
                             text=True, capture_output=True, timeout=15)
        require(result.returncode == 0)
        ids = result.stdout.split()
        require(all(re.fullmatch(r"[a-f0-9]{12,64}", item) for item in ids))
        if not ids:
            return []
        result = self.runner(["docker", "inspect", *ids], text=True, capture_output=True, timeout=20)
        require(result.returncode == 0)
        value = json.loads(result.stdout, object_pairs_hook=pairs)
        require(type(value) is list and len(value) == len(ids))
        return value

    def _scope_fleet(self, fleet, phase, intent, healthy=False):
        roles = set()
        for item in fleet:
            labels = item["Config"]["Labels"]
            role = labels["com.docker.compose.service"]
            require(labels["com.docker.compose.project"] == phase["project"] and role in ROLES and role not in roles)
            roles.add(role)
            image_role = "worker" if role == "verifier" else role
            allowed = {"etf-workbench-" + image_role + ":" + x for x in (self.sha, intent["previous_release_sha"]) if x}
            require(item["Config"]["Image"] in allowed and re.fullmatch(r"[a-f0-9]{12,64}", item["Id"]))
            require(any(x.get("Type") == "bind" and x.get("Source") == phase["data_dir"] for x in item["Mounts"]))
            if healthy:
                require(item["Config"]["Image"].endswith(":" + self.sha) and item["State"]["Running"] is True
                        and item["State"]["Health"]["Status"] == "healthy"
                        and item["Config"]["User"] == "10001:10001"
                        and labels.get("org.opencontainers.image.revision") == self.sha)
        if healthy:
            expected = {"web", "worker", "verifier"}
            if intent["market_provider"]:
                expected.add("market-provider")
            if intent["ai_explanation"]:
                expected.add("ai-explanation")
            require(roles == expected)

    def _schema(self, data):
        migrations = json.loads((self.release / "migrations/manifest.json").read_text())["migrations"]
        database = data / "etf-workbench.db"
        s = database.lstat()
        require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == self.app_uid and not s.st_mode & 0o022)
        db = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
        try:
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            require(db.execute("PRAGMA quick_check").fetchone()[0] == "ok" and not db.execute("PRAGMA foreign_key_check").fetchall())
            require(db.execute("PRAGMA user_version").fetchone()[0] == len(migrations))
            require(db.execute("SELECT version,filename,checksum FROM schema_migrations ORDER BY version").fetchall() ==
                    [(x["version"], x["file"], x["sha256"]) for x in migrations] and db.total_changes == 0)
            db.execute("ROLLBACK")
            return len(migrations)
        finally:
            db.close()

    def finalize(self, service_result, exit_code, exit_status):
        return self._finalize(service_result, exit_code, exit_status, worker_completed=False)

    def _cutover_evidence(self):
        folders = list((self.root / "release-evidence").glob(self.sha + "-*"))
        require(len(folders) <= 1, "AMBIGUOUS_RELEASE_EVIDENCE_KEEP_BARRIER")
        evidence = folders[0] if folders else None
        phase, result, data = None, None, None
        if evidence:
            self._directory(evidence, True)
            if (evidence / "cutover-started.json").exists():
                phase = self._read(evidence / "cutover-started.json")
                require(phase.get("format") == "etf-release-cutover-intent-v1" and phase.get("release_sha") == self.sha)
                require(re.fullmatch(r"[a-z0-9][a-z0-9_-]*", phase.get("project", "")))
                data = Path(phase["data_dir"])
                _, fd = barrier["_directory"](data, self.app_uid)
                os.close(fd)
            if (evidence / "result.json").exists():
                result = self._read(evidence / "result.json")
                require(result.get("release_sha") == self.sha)
        return evidence, phase, result, data

    def _verify_cutover(self, intent, evidence, phase, result, data):
        require(phase is not None and result is not None and result.get("status") == "technical_cutover_verified" and result.get("local_restore_verified") is True)
        require(self._source() == intent["source_manifest_sha256"] and
                hashlib.sha256(self._file(self.config, maximum=1024**2)).hexdigest() == intent["config_sha256"])
        require((self.root / "current").is_symlink() and (self.root / "current").resolve() == self.release)
        require(not (data / "RESTORE_PENDING_REVIEW").exists() and not (data / "RESTORE_PENDING_REVIEW").is_symlink())
        fleet = self._fleet(phase["project"])
        self._scope_fleet(fleet, phase, intent, True)
        loaded = self._read(evidence / "image-bundle-verification.json")
        names = ["web", "worker"] + (["market-provider"] if intent["market_provider"] else []) + (["ai-explanation"] if intent["ai_explanation"] else [])
        image_ids = loaded["runtime_image_ids"]
        require(loaded["release_sha"] == self.sha and loaded["status"] == "loaded_images_verified"
                and type(image_ids) is list and len(image_ids) == len(names)
                and all(re.fullmatch(r"sha256:[a-f0-9]{64}", item) for item in image_ids))
        expected = {"etf-workbench-" + name + ":" + self.sha: image for name, image in zip(names, image_ids)}
        require(all(item["Image"] == expected[item["Config"]["Image"]] for item in fleet))
        schema = self._schema(data)
        fleet = self._fleet(phase["project"])
        self._scope_fleet(fleet, phase, intent, True)
        require(all(item["Image"] == expected[item["Config"]["Image"]] for item in fleet))
        require(not (data / "RESTORE_PENDING_REVIEW").exists() and not (data / "RESTORE_PENDING_REVIEW").is_symlink())
        return schema

    def _reconciled(self):
        if not (self.directory / "reconciliation.json").exists(): return False
        record = self._bound("reconciliation.json")
        return (record.get("status") == "TECHNICAL_CUTOVER_RECONCILED" and record.get("automatic_release_succeeded") is False
            and record.get("execution_sha256") == digest(self.directory / "execution.json")
            and record.get("source_manifest_sha256") == self._intent()["source_manifest_sha256"])

    def reconcile(self, acknowledge_missing_terminal=False):
        require(acknowledge_missing_terminal is True, "EXPLICIT_MANUAL_RECONCILIATION_REQUIRED")
        with self._lock(self.root / ".release-job-submit.lock"), self._lock(self.root / ".release.lock"):
            intent = self._intent()
            require(not (self.directory / "terminal.json").exists() and not (self.directory / "reconciliation.json").exists())
            require(intent["deadline_epoch"] < self.clock() and self._manager()["ActiveState"] not in ACTIVE)
            execution = self._bound("execution.json")
            require(type(execution["exit_code"]) is int and execution["exit_code"] == 0)
            evidence, phase, result, data = self._cutover_evidence()
            schema = self._verify_cutover(intent, evidence, phase, result, data)
            require(self._manager()["ActiveState"] not in ACTIVE)
            return self._write("reconciliation.json", {"status": "TECHNICAL_CUTOVER_RECONCILED",
                "automatic_release_succeeded": False, "execution_sha256": digest(self.directory / "execution.json"),
                "source_manifest_sha256": intent["source_manifest_sha256"], "schema_version": schema,
                "operator_uid": os.geteuid(), "operator_script_sha256": digest(__file__),
                "finished_at": datetime.now(timezone.utc).isoformat()})

    def _finalize(self, service_result, exit_code, exit_status, *, worker_completed):
        intent = self._intent()
        with self._lock(self.root / ".release.lock"):
            if (self.directory / "terminal.json").exists():
                return self._bound("terminal.json")
            evidence, phase, result, data = self._cutover_evidence()
            successful, schema = False, None
            try:
                execution = self._bound("execution.json")
                require(worker_completed and type(execution["exit_code"]) is int and execution["exit_code"] == 0)
                require(0 < intent["deadline_epoch"] - self.clock() <= 75 * 60, "RELEASE_DEADLINE_EXPIRED")
                schema = self._verify_cutover(intent, evidence, phase, result, data)
                require(0 < intent["deadline_epoch"] - self.clock() <= 75 * 60, "RELEASE_DEADLINE_EXPIRED")
                successful = True
            except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, subprocess.SubprocessError):
                pass
            status, cleanup = "FAILED_PRE_CUTOVER", True
            known_pre_cutover = result is not None and result.get("status") == "failed" and type(result.get("writers_stopped")) is int and result["writers_stopped"] == 0 and result.get("database_overwritten") is False
            if successful:
                status = "SUCCEEDED"
            elif phase is not None and not known_pre_cutover:
                status, cleanup = "FAILED_RECOVERY_REQUIRED", False
                try:
                    barrier["fence_release"](data, self.sha, app_uid=self.app_uid, app_gid=self.app_gid)
                finally:
                    fleet = self._fleet(phase["project"])
                    try:
                        self._scope_fleet(fleet, phase, intent)
                        if fleet:
                            stopped = self.runner(["docker", "stop", "--time", "30", *[x["Id"] for x in fleet]],
                                                  text=True, capture_output=True, timeout=60)
                            require(stopped.returncode == 0)
                        cleanup = not any(x["State"]["Running"] for x in self._fleet(phase["project"]))
                    except (ValueError, KeyError, TypeError, subprocess.SubprocessError):
                        cleanup = False
            return self._write("terminal.json", {"status": status, "cleanup_complete": cleanup,
                "schema_version": schema, "database_overwritten": False, "service_result": service_result,
                "completion_basis": "managed_worker_verification" if worker_completed else "stop_hook_failure_cleanup",
                "finished_at": datetime.now(timezone.utc).isoformat()})

    def status(self):
        intent = self._intent()
        manager = self._manager()
        state = "RUNNING" if manager["ActiveState"] in ACTIVE else "UNKNOWN_REQUIRES_REVIEW"
        if state != "RUNNING" and (self.directory / "terminal.json").exists():
            terminal = self._bound("terminal.json")
            require(terminal["status"] in {"SUCCEEDED", "FAILED_PRE_CUTOVER", "FAILED_RECOVERY_REQUIRED"})
            state = terminal["status"]
        return {"status": state, "release_sha": self.sha, "workflow_run": self.workflow_run,
                "attempt": self.attempt, "unit": self.unit, "deadline_epoch": intent["deadline_epoch"], "manager": manager}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("submit", "worker", "finalize", "status", "reconcile"))
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--release", required=True)
    parser.add_argument("--workflow-run", required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--deadline", type=int)
    parser.add_argument("--acknowledge-missing-terminal", action="store_true")
    args = parser.parse_args()
    require(os.geteuid() == 0, "AUTHORIZED_ROOT_OPERATOR_REQUIRED")
    require((args.deadline is not None) == (args.phase == "submit"))
    require(args.acknowledge_missing_terminal == (args.phase == "reconcile"))
    job = ReleaseJob(args.root, args.release, args.workflow_run, args.attempt, args.config)
    if args.phase in ("worker", "finalize"):
        require(re.fullmatch(r"[a-f0-9]{32}", os.environ.get("INVOCATION_ID", "")) is not None, "MANAGED_RELEASE_CONTEXT_REQUIRED")
    if args.phase == "submit":
        value = job.submit(args.deadline)
    elif args.phase == "worker":
        raise SystemExit(job.worker())
    elif args.phase == "finalize":
        value = job.finalize(os.environ.get("SERVICE_RESULT"), os.environ.get("EXIT_CODE"), os.environ.get("EXIT_STATUS"))
    elif args.phase == "reconcile":
        value = job.reconcile(args.acknowledge_missing_terminal)
    else:
        value = job.status()
    print(json.dumps(value, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, subprocess.SubprocessError):
        print("RELEASE_JOB_FAILED_RECONCILE_DO_NOT_RESUBMIT", file=sys.stderr)
        raise SystemExit(1)
