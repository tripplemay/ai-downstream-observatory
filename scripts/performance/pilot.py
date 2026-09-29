#!/usr/bin/env python3
"""Manual synthetic, resource-limited pilot. Never a release or SLA gate."""

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parents[2]
CGROUP_ROOT = Path("/sys/fs/cgroup")
MEMORY = 8 * 1024 ** 3
PROFILES = {
    "small": {"history": 30, "listings": 10, "market-rows": 50, "csv-rows": 10,
              "count": 20, "interval-ms": 250, "setup-seconds": 600, "overall-seconds": 300,
              "background-cycles": 1, "background-interval-ms": 20000},
    "full": {"history": 50000, "listings": 1000, "market-rows": 2000000, "csv-rows": 10000,
             "count": 1000, "interval-ms": 250, "setup-seconds": 1200, "overall-seconds": 1800,
             "background-cycles": 12, "background-interval-ms": 20000},
}
EVIDENCE_FILES = {"report.json", "http-attempts.jsonl", "csv-original.csv", "mapping-original.json",
                  "final-workbench.db", "server-trace.jsonl"} | {"oracle-" + phase + suffix for phase in ("baseline", "preview", "complete")
                                          for suffix in (".json", "-input.json")}
LIMITS = {"small": 1200, "full": 3600}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def run(args, timeout=10):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=timeout, check=False)
    require(result.returncode == 0, "COMMAND_FAILED:" + Path(args[0]).name)
    return result.stdout.strip()


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write("\n")
    path.chmod(0o600)


def child_error_code(error):
    value = str(error) if isinstance(error, ValueError) else type(error).__name__
    return value if re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}(?::[A-Za-z0-9_.-]{1,64})?", value) else "CHILD_FAILURE_UNCLASSIFIED"


def read_child_failure(path):
    if not path.exists():
        return None
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024
            and path.stat().st_mode & 0o777 == 0o600, "CHILD_DIAGNOSTIC_INVALID")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError("CHILD_DIAGNOSTIC_INVALID") from None
    require(isinstance(value, dict) and set(value) == {"schema_version", "error"}
            and value["schema_version"] == "workbench-pilot-child-failure-v1"
            and isinstance(value["error"], str) and child_error_code(ValueError(value["error"])) == value["error"],
            "CHILD_DIAGNOSTIC_INVALID")
    return value


def file_hash(path):
    digest = sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def profile_args(profile):
    require(profile in PROFILES, "INVALID_PROFILE")
    return [part for key, value in PROFILES[profile].items() for part in ("--" + key, str(value))] + [
        "--core-count", "1", "--poll-seconds", "5", "--max-queued", "32"]


def parse_cpus(value):
    result = set()
    for part in value.strip().split(","):
        require(re.fullmatch(r"[0-9]+(?:-[0-9]+)?", part), "CPU_SET_INVALID")
        limits = list(map(int, part.split("-")))
        low, high = limits[0], limits[-1]
        require(low <= high <= 65535, "CPU_SET_INVALID")
        result.update(range(low, high + 1))
    return sorted(result)


def key_values(path):
    return {key: int(value) for key, value in (line.split() for line in path.read_text().splitlines())}


def cgroup_values(directory):
    return {"cpu_max": directory.joinpath("cpu.max").read_text().strip(),
            "memory_max": directory.joinpath("memory.max").read_text().strip(),
            "swap_max": directory.joinpath("memory.swap.max").read_text().strip(),
            "effective_cpus": directory.joinpath("cpuset.cpus.effective").read_text().strip()}


def verify_limits(values, cpus):
    quota, period = values["cpu_max"].split()
    require(quota.isdecimal() and period.isdecimal() and int(period) > 0 and int(quota) == 4 * int(period), "CPU_LIMIT_UNVERIFIED")
    require(values["memory_max"] == str(MEMORY), "MEMORY_LIMIT_UNVERIFIED")
    require(values["swap_max"] == "0", "SWAP_LIMIT_UNVERIFIED")
    require(parse_cpus(values["effective_cpus"]) == cpus and len(cpus) == 4, "AFFINITY_LIMIT_UNVERIFIED")


def current_cgroup():
    rows = Path("/proc/self/cgroup").read_text().splitlines()
    unified = [line[3:] for line in rows if line.startswith("0::")]
    require(len(unified) == 1 and unified[0].startswith("/"), "CGROUP_V2_REQUIRED")
    path = (CGROUP_ROOT / unified[0].lstrip("/")).resolve()
    require(path.is_relative_to(CGROUP_ROOT.resolve()), "CGROUP_PATH_INVALID")
    return path


def verify_storage(mount, devices):
    require(mount["fstype"] in ("ext4", "xfs", "btrfs"), "DISK_FILESYSTEM_UNVERIFIED")
    source = mount["source"].split("[", 1)[0]
    require(source.startswith("/dev/"), "LOCAL_BLOCK_DEVICE_REQUIRED")
    expected = os.path.realpath(source)
    rows = []

    def visit(items):
        for item in items:
            rows.append(item)
            visit(item.get("children", []))
    visit(devices)
    found = [row for row in rows if os.path.realpath(row["path"]) == expected]
    require(len(found) == 1 and found[0]["rota"] in (False, 0), "NONROTATIONAL_STORAGE_UNVERIFIED")
    return {"mount": mount, "block_device": found[0], "nonrotational_block_device_verified": True,
            "physical_ssd_independently_inspected": False}


def storage_probe(directory):
    mounts = json.loads(run(["findmnt", "--json", "--target", str(directory), "--output", "SOURCE,FSTYPE,TARGET,OPTIONS"]))["filesystems"]
    require(len(mounts) == 1, "MOUNT_UNVERIFIED")
    devices = json.loads(run(["lsblk", "--json", "--output", "PATH,TYPE,ROTA,TRAN"]))["blockdevices"]
    result = verify_storage(mounts[0], devices)
    result["free_bytes"] = shutil.disk_usage(directory).free
    require(result["free_bytes"] >= 4 * 1024 ** 3, "INSUFFICIENT_DISK_SPACE")
    return result


def sample(directory, cpus, elapsed):
    limits = cgroup_values(directory)
    verify_limits(limits, cpus)
    return {"elapsed_seconds": round(elapsed, 6), "limits": limits,
            "cpu": key_values(directory / "cpu.stat"), "memory_current": int((directory / "memory.current").read_text()),
            "memory_peak": int((directory / "memory.peak").read_text()) if (directory / "memory.peak").exists() else None,
            "memory_events": key_values(directory / "memory.events"),
            "io_stat": (directory / "io.stat").read_text().strip(),
            "cgroup_events": key_values(directory / "cgroup.events"),
            "pids": [int(value) for value in (directory / "cgroup.procs").read_text().split()]}


def wait_for_marker(path):
    until = time.monotonic() + 30
    while not path.exists():
        require(time.monotonic() < until, "SUPERVISOR_BARRIER_TIMEOUT")
        time.sleep(0.1)


def runtime_binding(args):
    files = ["requirements-workbench.txt", "web/package-lock.json", "migrations/manifest.json",
             "web/.next/BUILD_ID", "web/dist/csv-background.mjs", "web/dist/monthly-evaluation.mjs",
             "web/dist/governance-fixture.mjs", "web/dist/governance-fixture.manifest.json"]
    return {"node": run([args.node, "--version"]), "python": run([args.python, "--version"]),
            "files": {name: file_hash(ROOT / name) for name in files}}


def minimal_environment(args, scratch):
    return {"PATH": str(Path(args.node).parent) + ":" + str(Path(args.python).parent) + ":/usr/bin:/bin",
            "HOME": str(scratch / "home"), "TMPDIR": str(scratch / "tmp"), "LANG": "C.UTF-8", "TZ": "UTC",
            "WORKBENCH_TEST_PYTHON": args.python, "WORKBENCH_PYTHON": args.python, "PYTHONDONTWRITEBYTECODE": "1"}


def unit_command(args, user, unit, cpus_text, scratch):
    # Retain exited unit metadata until the supervisor records it and explicitly stops it.
    properties = ["Type=exec", "RemainAfterExit=yes", "CPUAccounting=yes", "MemoryAccounting=yes", "IOAccounting=yes",
                  "CPUQuota=400%", "CPUQuotaPeriodSec=100ms", "AllowedCPUs=" + cpus_text,
                  "MemoryMax=" + str(MEMORY), "MemorySwapMax=0", "TasksMax=512", "KillMode=control-group",
                  "TimeoutStopSec=15s", "SendSIGKILL=yes", "NoNewPrivileges=yes", "RuntimeMaxSec=" + str(LIMITS[args.profile])]
    return ["systemd-run", "--unit=" + unit, *["--property=" + value for value in properties],
            "/usr/sbin/runuser", "--user", user, "--", "/usr/bin/env", "-i",
            *[key + "=" + value for key, value in minimal_environment(args, scratch).items()],
            args.python, str(Path(__file__).resolve()), "--child", "--profile", args.profile,
            "--commit", args.commit, "--node", args.node, "--python", args.python,
            "--unit", unit, "--cpus", cpus_text, "--scratch", str(scratch)]


def clean_terminal(state, quiescent, forced):
    return not forced and quiescent and state.get("ActiveState") == "active" and state.get("SubState") == "exited" \
        and state.get("Result") == "success" and state.get("ExecMainCode") == "1" and state.get("ExecMainStatus") == "0"


def settled_terminal(state, quiescent, forced):
    if clean_terminal(state, quiescent, forced):
        return True
    return not forced and quiescent and state.get("ActiveState") == "failed" and state.get("Result") == "exit-code" \
        and state.get("ExecMainCode") == "1" and state.get("ExecMainStatus") == "1"


def retained_backup(outcome, evidence):
    proof = outcome.get("retained_database", {})
    database = evidence / "final-workbench.db"
    return outcome.get("owned_processes_stopped") is True and outcome.get("uncertain_writers") is False \
        and outcome.get("retention_verified") is True and proof.get("path") == database.name \
        and isinstance(proof.get("sha256"), str) and bool(re.fullmatch(r"[a-f0-9]{64}", proof["sha256"])) \
        and database.is_file() and not database.is_symlink() and file_hash(database) == proof["sha256"]


def safe_collect(source, destination, include_database):
    """Only known synthetic receipts; never copy runtime auth storage or env files."""
    destination.mkdir(mode=0o700)
    copied = []
    candidates = [source / name for name in sorted(EVIDENCE_FILES) if (source / name).exists()]
    attachments = source / "attachments"
    if include_database and attachments.exists():
        require(attachments.is_dir() and not attachments.is_symlink(), "ATTACHMENT_DIRECTORY_INVALID")
        (destination / "attachments").mkdir(mode=0o700)
        candidates.extend(sorted(attachments.iterdir()))
    for original in candidates:
        relative = original.relative_to(source)
        if not include_database and (str(relative) == "final-workbench.db" or relative.parts[0] == "attachments"):
            continue
        require(original.is_file() and not original.is_symlink() and original.stat().st_nlink == 1, "EVIDENCE_FILE_INVALID")
        require(re.fullmatch(r"[A-Za-z0-9_.:-]+", original.name), "EVIDENCE_NAME_INVALID")
        require(original.stat().st_size <= 8 * 1024 ** 3, "EVIDENCE_FILE_LIMIT")
        if original.name == "final-workbench.db":
            db = sqlite3.connect(original.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
            try:
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                require("ledger_events" in tables and not tables & {"sessions", "auth_sessions", "users"}, "AUTH_DATABASE_FORBIDDEN")
            finally:
                db.close()
        digest = file_hash(original)
        target = destination / relative
        with original.open("rb") as incoming, target.open("xb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)
        target.chmod(0o600)
        require(file_hash(target) == digest, "EVIDENCE_COPY_HASH_MISMATCH")
        copied.append({"path": str(relative), "sha256": digest, "bytes": target.stat().st_size})
    return copied


def child(args):
    require(sys.platform == "linux" and os.getuid() != 0 and os.geteuid() == os.getuid(), "NONROOT_LINUX_REQUIRED")
    cpus = parse_cpus(args.cpus)
    directory = current_cgroup()
    require(directory.name == args.unit + ".service", "WRONG_CGROUP")
    verify_limits(cgroup_values(directory), cpus)
    require(sorted(os.sched_getaffinity(0)) == cpus, "PROCESS_AFFINITY_MISMATCH")
    scratch = Path(args.scratch).resolve()
    require(Path(os.environ["TMPDIR"]).resolve() == scratch / "tmp", "TMPDIR_MISMATCH")
    preflight = {"status": "verified", "uid": os.getuid(), "gid": os.getgid(), "pid": os.getpid(),
                 "cgroup": str(directory), "limits": cgroup_values(directory), "affinity": cpus,
                 "storage": storage_probe(scratch / "tmp"), "commit": args.commit, "runtime": runtime_binding(args),
                 "performance_gate": False, "production": False}
    write_json(scratch / "resource-preflight.json", preflight)
    # Barrier lets the external sampler observe the live unit before workload dispatch.
    wait_for_marker(scratch / "supervisor-ready")
    command = [args.node, "--import", "tsx", "scripts/benchmark-workbench-mixed.ts", *profile_args(args.profile),
               "--output", str(scratch / "evidence/report.json")]
    with (scratch / "harness-stdout.log").open("xb") as stdout, (scratch / "harness-stderr.log").open("xb") as stderr:
        result = subprocess.run(command, cwd=ROOT / "web", stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, check=False)
    write_json(scratch / "child-result.json", {"exit_code": result.returncode, "performance_gate": False})
    # Preserve cumulative cgroup counters after all harness work, before systemd removes its cgroup.
    wait_for_marker(scratch / "supervisor-final-sample")
    return result.returncode if 0 <= result.returncode <= 125 else 1


def unit_properties(unit):
    keys = ("ActiveState", "SubState", "Result", "ExecMainCode", "ExecMainStatus", "ControlGroup", "MainPID")
    raw = run(["systemctl", "show", unit, "--property=" + ",".join(keys)])
    return dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)


def stop_unit(unit, directory):
    subprocess.run(["systemctl", "kill", "--kill-who=all", "--signal=SIGTERM", unit], capture_output=True, timeout=10)
    for signal, duration in ((None, 15), ("SIGKILL", 3)):
        if signal:
            subprocess.run(["systemctl", "kill", "--kill-who=all", "--signal=" + signal, unit], capture_output=True, timeout=10)
        until = time.monotonic() + duration
        while time.monotonic() < until:
            if not directory.exists() or key_values(directory / "cgroup.events").get("populated") == 0:
                return True
            time.sleep(0.2)
    return False


def supervisor(args):
    require(sys.platform == "linux" and os.geteuid() == 0, "LINUX_SUPERVISOR_REQUIRES_SUDO")
    require(re.fullmatch(r"[a-f0-9]{40}", args.commit), "EXACT_COMMIT_REQUIRED")
    require(args.profile in PROFILES, "INVALID_PROFILE")
    caller = pwd.getpwnam(os.environ.get("SUDO_USER", ""))
    require(caller.pw_uid != 0, "NONROOT_CALLER_REQUIRED")
    git = ["git", "-c", "safe.directory=" + str(ROOT)]
    require(run([*git, "rev-parse", "HEAD"]) == args.commit, "COMMIT_MISMATCH")
    run([*git, "merge-base", "--is-ancestor", args.commit, "refs/remotes/origin/main"])
    require(not run([*git, "status", "--porcelain", "--untracked-files=no"]), "TRACKED_SOURCE_DIRTY")
    for executable in (args.node, args.python):
        require(Path(executable).is_absolute() and Path(executable).is_file() and os.access(executable, os.X_OK), "EXECUTABLE_INVALID")
    cpus = sorted(os.sched_getaffinity(0))[:4]
    require(len(cpus) == 4, "FOUR_CPUS_REQUIRED")
    cpus_text = ",".join(map(str, cpus))
    identity = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    unit = "workbench-pilot-" + identity.lower()
    parent = ROOT / "artifacts/verification"
    parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="pilot-private-", dir=parent))
    for path in (scratch, scratch / "tmp", scratch / "home", scratch / "evidence"):
        path.mkdir(mode=0o700, exist_ok=True)
        path.chmod(0o700); os.chown(path, caller.pw_uid, caller.pw_gid)
    output = parent / "performance-pilot" / identity
    output.mkdir(parents=True, mode=0o700)
    report = {"schema_version": "workbench-resource-pilot-v1", "status": "FAILED", "profile": args.profile,
              "commit": args.commit, "tree": run([*git, "rev-parse", "HEAD^{tree}"]), "unit": unit,
              "requested": PROFILES[args.profile], "performance_gate": False, "production": False,
              "unknown_writer_outcome": True, "forced_stop": False, "errors": [], "sample_count": 0,
              "boundaries": ["Manual synthetic pilot; no SLA, release, genuine gate, provider or investment approval.",
                             "All workload descendants and the in-process HTTP generator share the same 4-CPU/8-GiB cgroup.",
                             "Only kernel-reported nonrotational local block storage is checked, not independent physical SSD inspection.",
                             "HTTP wall and benchmark-only server trace are distinct clocks; first/subsequent samples are not an independently cold server.",
                             "Current fixed fixture has sparse active positions and finite scheduled update cycles, not representative continuous market load.",
                             "Forced/uncertain termination never proves rollback; original temporary state is not removed by this supervisor."]}
    directory = CGROUP_ROOT / "system.slice" / (unit + ".service")
    started = False
    samples = output / "resource-samples.jsonl"
    try:
        # Fixed argv only. No shell and no inherited auth/provider/runtime environment.
        command = unit_command(args, caller.pw_name, unit, cpus_text, scratch)
        started = True  # A timed-out launcher may already have created the unit.
        run(command, 30)
        began = time.monotonic(); last = None
        with samples.open("x", encoding="utf-8") as stream:
            while time.monotonic() - began < LIMITS[args.profile] + 30:
                state = unit_properties(unit)
                if state.get("ControlGroup"):
                    directory = (CGROUP_ROOT / state["ControlGroup"].lstrip("/")).resolve()
                    require(directory.is_relative_to(CGROUP_ROOT.resolve()), "UNIT_CGROUP_INVALID")
                if directory.exists():
                    try:
                        last = sample(directory, cpus, time.monotonic() - began)
                        stream.write(json.dumps(last, sort_keys=True) + "\n"); stream.flush()
                        report["sample_count"] += 1
                    except FileNotFoundError:
                        require(state.get("ActiveState") in ("inactive", "failed"), "LIVE_CGROUP_DISAPPEARED")
                if (scratch / "resource-preflight.json").exists() and not (scratch / "supervisor-ready").exists():
                    require(last is not None, "SAMPLER_NOT_READY")
                    (scratch / "supervisor-ready").touch(mode=0o600)
                if (scratch / "child-result.json").exists() and not (scratch / "supervisor-final-sample").exists():
                    require(last is not None and directory.exists(), "FINAL_SAMPLE_MISSING")
                    report["post_harness_resource_sample"] = last
                    (scratch / "supervisor-final-sample").touch(mode=0o600)
                if state.get("ActiveState") in ("inactive", "failed") or state.get("SubState") == "exited":
                    report["unit_terminal"] = state
                    break
                time.sleep(1)
            else:
                report["forced_stop"] = True
                report["errors"].append("SUPERVISOR_DEADLINE")
                report["group_empty_after_forced_stop"] = stop_unit(unit, directory)
        report["last_resource_sample"] = last
        state = report.get("unit_terminal") or unit_properties(unit)
        quiescent = not directory.exists() or key_values(directory / "cgroup.events").get("populated") == 0
        settled = settled_terminal(state, quiescent, report["forced_stop"])
        report["unit_quiescent"] = quiescent
        report["unknown_writer_outcome"] = not settled
        if (scratch / "resource-preflight.json").exists():
            report["resource_preflight"] = json.loads((scratch / "resource-preflight.json").read_text())
        require(settled, "UNIT_TERMINATION_UNCERTAIN")
        require(report.get("resource_preflight", {}).get("status") == "verified" and report["sample_count"] > 0, "RESOURCE_PREFLIGHT_MISSING")
        require("post_harness_resource_sample" in report, "FINAL_SAMPLE_MISSING")
        outcome = json.loads((scratch / "evidence/report.json").read_text())
        report["retained_backup_verified"] = retained_backup(outcome, scratch / "evidence")
        run(["systemctl", "stop", unit], 20)
        require(last is not None and all(last["memory_events"].get(key, 0) == 0 for key in ("oom", "oom_kill")), "OOM_OBSERVED")
        require(clean_terminal(state, quiescent, report["forced_stop"]), "HARNESS_EXIT_FAILURE")
        require(outcome.get("status") == "PASS" and outcome.get("owned_processes_stopped") is True
                and outcome.get("uncertain_writers") is False and outcome.get("retention_verified") is True, "HARNESS_NOT_VERIFIED_SUCCESS")
        require(report["retained_backup_verified"], "RETAINED_BACKUP_UNVERIFIED")
        report["status"] = "PILOT_PASSED"
    except Exception as error:
        report["errors"].append(str(error) if isinstance(error, ValueError) else type(error).__name__)
        if started and report["unknown_writer_outcome"]:
            report["forced_stop"] = True
            report["unknown_writer_outcome"] = True
            try:
                report["group_empty_after_forced_stop"] = stop_unit(unit, directory)
            except Exception:
                report["group_empty_after_forced_stop"] = False
    finally:
        try:
            failure = read_child_failure(scratch / "child-failure.json")
            if failure is not None:
                report["child_failure"] = failure
        except Exception:
            report["errors"].append("CHILD_DIAGNOSTIC_INVALID")
        try:
            include_database = report.get("retained_backup_verified") is True and not report["unknown_writer_outcome"]
            report["synthetic_evidence"] = safe_collect(scratch / "evidence", output / "synthetic", include_database)
            for name in ("harness-stdout.log", "harness-stderr.log", "resource-preflight.json", "child-result.json"):
                original = scratch / name
                if original.is_file() and not original.is_symlink():
                    require(original.stat().st_size <= 1024 ** 2, "DIAGNOSTIC_LIMIT")
                    shutil.copyfile(original, output / name); (output / name).chmod(0o600)
        except Exception as error:
            report["status"] = "FAILED"; report["errors"].append("EVIDENCE_RETENTION:" + type(error).__name__)
        report["scratch_retained"] = True
        report["scratch_path"] = str(scratch.relative_to(ROOT))
        report["authentication_database_uploaded"] = False
        report["environment_or_credentials_uploaded"] = False
        write_json(output / "pilot-result.json", report)
        for path in output.rglob("*"):
            os.chown(path, caller.pw_uid, caller.pw_gid)
        os.chown(output, caller.pw_uid, caller.pw_gid)
        print(json.dumps({"status": report["status"], "output": str(output.relative_to(ROOT)), "performance_gate": False}))
    return 0 if report["status"] == "PILOT_PASSED" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=sorted(PROFILES), default="small")
    parser.add_argument("--commit", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    for option in ("unit", "cpus", "scratch"):
        parser.add_argument("--" + option, help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        return child(args) if args.child else supervisor(args)
    except Exception as error:
        if args.child and args.scratch:
            try:
                scratch = Path(args.scratch)
                if scratch.is_absolute() and scratch.is_dir() and not scratch.is_symlink() and scratch.stat().st_uid == os.geteuid():
                    write_json(scratch / "child-failure.json", {"schema_version": "workbench-pilot-child-failure-v1", "error": child_error_code(error)})
            except (OSError, ValueError):
                pass
        print(json.dumps({"status": "FAILED", "error": child_error_code(error) if args.child else str(error) if isinstance(error, ValueError) else type(error).__name__, "performance_gate": False}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
