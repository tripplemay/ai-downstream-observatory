#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $(uname -s) == Linux && $(id -u) == 0 ]] || { printf 'Run this isolated container fixture as root on Linux\n' >&2; exit 2; }
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/workbench-container-$run_id-XXXXXX")
project="etf-fixture-$$"
export WORKBENCH_RELEASE_SHA="verify-$run_id"
export WORKBENCH_MODE=ledger
export WORKBENCH_DATA_DIR_HOST="$temporary/data"
export WORKBENCH_LEGACY_DATA_DIR="$temporary/legacy"
export WORKBENCH_BACKUP_DIR_HOST="$temporary/backups"
export WORKBENCH_RESTORE_PARENT_DIR="$temporary/restores"
export WORKBENCH_RUNTIME_ENV_FILE="$temporary/runtime.env"
export WORKBENCH_BACKUP_KEY_FILE="$temporary/backup.passphrase"
WORKBENCH_HTTP_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
export WORKBENCH_HTTP_PORT
compose() { docker compose --env-file /dev/null -p "$project" -f "$root/docker-compose.yml" "$@"; }
cleanup() {
  result=$?
  trap - EXIT
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
  exit "$result"
}
trap cleanup EXIT
chown 10001:10001 "$temporary"
for directory in data legacy backups restores; do install -d -o 10001 -g 10001 -m 0700 "$temporary/$directory"; done
install -o 10001 -g 10001 -m 0600 /dev/null "$WORKBENCH_RUNTIME_ENV_FILE"
timeout 30 docker version --format '{{.Server.Version}}'
timeout 1200 docker compose --env-file /dev/null -p "$project" -f "$root/docker-compose.yml" build web worker
web_image="etf-workbench-web:$WORKBENCH_RELEASE_SHA"
worker_image="etf-workbench-worker:$WORKBENCH_RELEASE_SHA"
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp --volume "$temporary:/fixture" --entrypoint node "$web_image" --input-type=module -e '
  import {randomBytes,scryptSync} from "node:crypto"; import {writeFileSync} from "node:fs";
  import Database from "better-sqlite3";
  const salt=randomBytes(16),password=randomBytes(32).toString("base64url");
  const hash=["scrypt",32768,8,1,salt.toString("base64url"),scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:67108864}).toString("base64url")].join("$");
  writeFileSync("/fixture/runtime.env",`WORKBENCH_PASSWORD_HASH=${hash}\nWORKBENCH_SESSION_SECRET=${randomBytes(48).toString("base64url")}\nWORKBENCH_ORIGIN=https://fixture.invalid\n`,{mode:0o600});
  writeFileSync("/fixture/backup.passphrase",randomBytes(48).toString("base64url"),{mode:0o600});
  const db=new Database("/fixture/legacy/observatory.db");db.pragma("journal_mode=WAL"); db.exec("CREATE TABLE metrics(id TEXT PRIMARY KEY,value REAL);INSERT INTO metrics VALUES(\u0027fixture\u0027,123.25)");db.close();
'
compose --profile tools config --no-env-resolution --quiet
compose run --rm --no-deps --entrypoint /bin/true migrate
if WORKBENCH_DATA_DIR_HOST="$temporary/missing-bind-source" compose run --rm --no-deps --entrypoint /bin/true migrate >"$temporary/missing-bind.log" 2>&1; then
  printf 'Missing bind source unexpectedly allowed container startup\n' >&2; exit 1
fi
if [[ -e "$temporary/missing-bind-source" ]] || ! grep -Fq 'bind source path does not exist' "$temporary/missing-bind.log"; then
  printf 'Missing bind source guard did not fail at the expected boundary\n' >&2
  cat "$temporary/missing-bind.log" >&2; exit 1
fi
printf 'Missing bind source refused without creating the host path\n'
compose run --rm --no-deps migrate
monthly_publisher=$(compose run --rm --no-deps -T --entrypoint python worker - <<'PY_PUBLISHER'
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

from worker.orchestration.db import open_database
from worker.orchestration.external import _publisher_argv
from worker.orchestration.jobs import Lease

if (os.getuid(), os.getgid()) != (10001, 10001):
    raise SystemExit("Monthly publisher fixture must run as the image's unprivileged user")
lease = Lease("synthetic-missing-monthly-job", "synthetic-container-worker", 1, 1, "2099-01-01T00:00:00.000000Z")
argv = _publisher_argv(lease)
publisher = Path("/app/worker-bridge/monthly-evaluation.mjs")
if len(argv) != 10 or argv[1] != str(publisher):
    raise SystemExit("Monthly publisher bridge did not select the fixed deployed bundle")
node = subprocess.run([argv[0], "--version"], capture_output=True, text=True, timeout=10, check=True)
if node.stderr or not re.fullmatch(r"v22\.\d+\.\d+\n", node.stdout):
    raise SystemExit("Monthly publisher Node runtime is not the pinned major version")

def fingerprint(connection):
    digest = hashlib.sha256()
    for statement in connection.iterdump():
        digest.update(statement.encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()

connection = open_database(os.environ["WORKBENCH_DB_PATH"])
try:
    for table in ("portfolios", "accounts", "ledger_events", "proposals", "reservations", "evaluation_cycles", "job_runs"):
        if connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] != 0:
            raise SystemExit("Monthly publisher fixture is not an empty isolated database")
    before = fingerprint(connection)
    schema_version = connection.execute("PRAGMA user_version").fetchone()[0]
    rejected = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, check=False)
    # This branch is reached only after the bundle loads native SQLite and validates the migrated database.
    if rejected.returncode != 1 or rejected.stdout != "" or rejected.stderr != "STALE_OR_EXPIRED_LEASE\n":
        raise SystemExit("Monthly publisher did not reject the nonexistent lease at its database boundary")
    if fingerprint(connection) != before:
        raise SystemExit("Rejected monthly publisher changed the isolated database")
finally:
    connection.close()
with publisher.open("rb") as original:
    bundle_hash = hashlib.file_digest(original, "sha256").hexdigest()
print(json.dumps({"schema_version": "monthly-publisher-smoke-v1", "publisher_path": str(publisher),
                  "bundle_sha256": bundle_hash, "node_version": node.stdout.strip(),
                  "sqlite_schema_version": schema_version, "runtime_uid": os.getuid(),
                  "native_sqlite_loaded": True, "invalid_lease_rejected": True,
                  "logical_database_unchanged": True}, separators=(",", ":")))
PY_PUBLISHER
)
compose run --rm --no-deps -e WORKBENCH_LEGACY_QUIESCED=1 archive-legacy
backup=$(compose run --rm --no-deps backup)
archive=$(printf '%s' "$backup" | python3 -c 'import json,sys; print(json.load(sys.stdin)["path"].split("/")[-1])')
export WORKBENCH_RESTORE_ARCHIVE_NAME="$archive" WORKBENCH_RESTORE_TARGET_NAME=fixture-restore
compose run --rm --no-deps restore
if compose run --rm --no-deps restore >/dev/null 2>&1; then printf 'Existing restore destination was overwritten\n' >&2; exit 1; fi
compose run --rm --no-deps --entrypoint node migrate --input-type=module -e '
  import Database from "better-sqlite3";const db=new Database(process.env.WORKBENCH_DB_PATH,{readonly:true});
  if(db.prepare("SELECT COUNT(*) n FROM ledger_events").get().n!==0)throw Error("legacy seeded actual facts");
  if(db.prepare("SELECT COUNT(*) n FROM legacy_archives").get().n!==1)throw Error("legacy row missing");db.close();
'
timeout 120 docker compose --env-file /dev/null -p "$project" -f "$root/docker-compose.yml" up -d --no-build --wait --wait-timeout 90 web worker
compose exec -T web node /app/scripts/check-workbench-runtime.mjs --http
compose exec -T worker python -c 'import os; from worker.orchestration.db import open_database; import worker.performance; import worker.research; c=open_database(os.environ["WORKBENCH_DB_PATH"]); c.close(); print("worker schema ready")'
[[ $(curl --max-time 5 --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$WORKBENCH_HTTP_PORT/api/workbench") == 401 ]]
for image in "$web_image" "$worker_image"; do
  [[ $(docker image inspect "$image" --format '{{.Config.User}}') == '10001:10001' ]]
  docker run --rm --read-only --entrypoint sh "$image" -c 'test ! -e /app/data/observatory.db && test ! -e /app/config/gateway.json && test ! -e /app/.env && test ! -e /app/.private'
done
publish_container_report() {
  python3 - "$root" "$run_id" "$1" "$2" "$monthly_publisher" <<'PY_REPORT'
import json
import os
import re
import stat
import sys

root, run_id, web_image, worker_image, publisher_json = sys.argv[1:]
if len(publisher_json.encode("utf-8")) > 4096:
    raise SystemExit("Monthly publisher proof is oversized")
try:
    publisher = json.loads(publisher_json)
    with open(os.path.join(root, "migrations", "manifest.json"), encoding="utf-8") as source:
        schema_version = len(json.load(source)["migrations"])
    keys = {"schema_version", "publisher_path", "bundle_sha256", "node_version", "sqlite_schema_version",
            "runtime_uid", "native_sqlite_loaded", "invalid_lease_rejected", "logical_database_unchanged"}
    if (not isinstance(publisher, dict) or set(publisher) != keys
            or publisher["schema_version"] != "monthly-publisher-smoke-v1"
            or publisher["publisher_path"] != "/app/worker-bridge/monthly-evaluation.mjs"
            or not isinstance(publisher["bundle_sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", publisher["bundle_sha256"])
            or not isinstance(publisher["node_version"], str) or not re.fullmatch(r"v22\.\d+\.\d+", publisher["node_version"])
            or type(publisher["sqlite_schema_version"]) is not int or publisher["sqlite_schema_version"] != schema_version
            or type(publisher["runtime_uid"]) is not int or publisher["runtime_uid"] != 10001
            or any(publisher[key] is not True for key in ("native_sqlite_loaded", "invalid_lease_rejected", "logical_database_unchanged"))):
        raise ValueError("Invalid monthly publisher proof")
except (ValueError, TypeError, KeyError, OSError) as error:
    raise SystemExit("Monthly publisher runtime proof is missing or invalid") from error
caller = [os.environ.get("SUDO_UID"), os.environ.get("SUDO_GID")]
if caller == [None, None]:
    uid, gid = os.getuid(), os.getgid()
elif any(value is None or not re.fullmatch(r"0|[1-9][0-9]{0,9}", value) for value in caller):
    raise SystemExit("Invalid report caller identity")
else:
    uid, gid = map(int, caller)
if max(uid, gid) >= 4294967295 or (os.geteuid() != 0 and (uid, gid) != (os.getuid(), os.getgid())):
    raise SystemExit("Report caller identity is out of scope")
if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9]+", run_id) or any(not re.fullmatch(r"sha256:[a-f0-9]{64}", value) for value in (web_image, worker_image)):
    raise SystemExit("Invalid synthetic report metadata")
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
directories = [os.open(root, flags)]
try:
    for name in ("artifacts", "verification"):
        try:
            os.mkdir(name, mode=0o700, dir_fd=directories[-1])
        except FileExistsError:
            pass
        descriptor = os.open(name, flags, dir_fd=directories[-1])
        directories.append(descriptor)
        info = os.fstat(descriptor)
        if info.st_uid not in (0, uid) or stat.S_IMODE(info.st_mode) & 0o022:
            raise SystemExit("Unsafe synthetic report directory")
    name = "container-" + run_id + ".json"
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directories[-1])
    try:
        report = {"run_id": run_id, "status": "passed", "non_root": True,
                  "missing_bind_source_rejected": True,
                  "legacy_actual_facts": 0, "encrypted_local_restore": True,
                  "independent_host_restore": False, "web_image": web_image,
                  "worker_image": worker_image, "monthly_publisher": publisher}
        with os.fdopen(os.dup(descriptor), "w", encoding="utf-8") as output:
            json.dump(report, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, uid, gid)
        # Hand off only the completed report and root-owned parent directories, never their contents.
        for directory in reversed(directories[1:]):
            if os.fstat(directory).st_uid == 0:
                os.fchown(directory, uid, gid)
        os.fsync(directories[-1])
    except BaseException:
        os.unlink(name, dir_fd=directories[-1])
        raise
    finally:
        os.close(descriptor)
finally:
    for directory in reversed(directories):
        os.close(directory)
PY_REPORT
}
publish_container_report "$(docker image inspect "$web_image" --format '{{.Id}}')" "$(docker image inspect "$worker_image" --format '{{.Id}}')"
printf 'Container migration, fixed Node publisher, legacy isolation, encrypted restore and HTTP fixture passed\n'
