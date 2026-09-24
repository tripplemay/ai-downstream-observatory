#!/usr/bin/env bash
set -euo pipefail
umask 077

execute=0
release_sha=""
release_dir=""
config=""
while (($#)); do
  case "$1" in
    --release) release_sha="${2:?missing release SHA}"; shift 2 ;;
    --release-dir) release_dir="${2:?missing release directory}"; shift 2 ;;
    --config) config="${2:?missing private configuration}"; shift 2 ;;
    --execute) execute=1; shift ;;
    *) printf 'Unknown argument\n' >&2; exit 2 ;;
  esac
done
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || { printf 'Exact 40-character release SHA required\n' >&2; exit 2; }
safe_path() { [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ && "$1" != *'/../'* && "$1" != */.. && "$1" != '/' ]]; }
if ! safe_path "$release_dir" || ! safe_path "$config"; then printf 'Absolute controlled paths required\n' >&2; exit 2; fi
[[ -f "$config" && ! -L "$config" ]] || { printf 'Private release configuration missing\n' >&2; exit 2; }
mode=$(stat -c '%a' "$config" 2>/dev/null || stat -f '%Lp' "$config")
(( (8#$mode & 077) == 0 )) || { printf 'Release configuration must have no group/other permissions\n' >&2; exit 2; }
if ((execute)); then
  owner=$(stat -c '%u' "$config" 2>/dev/null || stat -f '%u' "$config")
  [[ "$owner" == 0 ]] || { printf 'Executable release configuration must be root-owned\n' >&2; exit 2; }
fi
set -a
# The root-owned private configuration is shell input, never downloaded model/file content.
# shellcheck source=/dev/null
source "$config"
set +a
: "${WORKBENCH_DEPLOY_ROOT:?Set deployment root}"
: "${WORKBENCH_RUNTIME_ENV_FILE:?Set protected runtime env file}"
: "${WORKBENCH_BACKUP_KEY_FILE:?Set protected backup key file}"
WORKBENCH_LEGACY_DIR=${WORKBENCH_LEGACY_DIR:-$WORKBENCH_DEPLOY_ROOT}
WORKBENCH_LEGACY_DATA_DIR=${WORKBENCH_LEGACY_DATA_DIR:-$WORKBENCH_LEGACY_DIR/data}
WORKBENCH_DATA_DIR_HOST=${WORKBENCH_DATA_DIR_HOST:-$WORKBENCH_DEPLOY_ROOT/data-workbench}
WORKBENCH_BACKUP_DIR_HOST=${WORKBENCH_BACKUP_DIR_HOST:-$WORKBENCH_DEPLOY_ROOT/backups-workbench}
WORKBENCH_RESTORE_PARENT_DIR=${WORKBENCH_RESTORE_PARENT_DIR:-$WORKBENCH_DEPLOY_ROOT/restores-workbench}
WORKBENCH_PROJECT=${WORKBENCH_PROJECT:-etf-workbench}
WORKBENCH_LEGACY_PROJECT=${WORKBENCH_LEGACY_PROJECT:-observatory}
WORKBENCH_HTTP_PORT=${WORKBENCH_HTTP_PORT:-5051}
WORKBENCH_RELEASE_SHA=$release_sha
COMPOSE_PARALLEL_LIMIT=${COMPOSE_PARALLEL_LIMIT:-1}
for value in "$WORKBENCH_DEPLOY_ROOT" "$WORKBENCH_LEGACY_DIR" "$WORKBENCH_LEGACY_DATA_DIR" "$WORKBENCH_DATA_DIR_HOST" "$WORKBENCH_BACKUP_DIR_HOST" "$WORKBENCH_RESTORE_PARENT_DIR" "$WORKBENCH_RUNTIME_ENV_FILE" "$WORKBENCH_BACKUP_KEY_FILE"; do
  safe_path "$value" || { printf 'Invalid configured path\n' >&2; exit 2; }
done
[[ "$WORKBENCH_DATA_DIR_HOST" != "$WORKBENCH_LEGACY_DATA_DIR" ]] || { printf 'Legacy and actual data directories must differ\n' >&2; exit 2; }
[[ "$release_dir" == "$WORKBENCH_DEPLOY_ROOT/releases/$release_sha" ]] || { printf 'Release directory does not match approved SHA\n' >&2; exit 2; }
[[ "$WORKBENCH_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ && "$WORKBENCH_LEGACY_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ && "$WORKBENCH_HTTP_PORT" =~ ^[0-9]+$ ]] || { printf 'Invalid project or port\n' >&2; exit 2; }
(( WORKBENCH_HTTP_PORT > 1024 && WORKBENCH_HTTP_PORT < 65536 )) || exit 2
export WORKBENCH_RELEASE_SHA WORKBENCH_DATA_DIR_HOST WORKBENCH_BACKUP_DIR_HOST WORKBENCH_RESTORE_PARENT_DIR WORKBENCH_LEGACY_DATA_DIR WORKBENCH_RUNTIME_ENV_FILE WORKBENCH_BACKUP_KEY_FILE WORKBENCH_HTTP_PORT
export COMPOSE_PARALLEL_LIMIT

if ((execute == 0)); then
  printf 'PLAN ONLY: %s\n' "$release_sha"
  printf '%s\n' 'Validate protected configuration and isolated UID 10001 volumes' 'Build exact release-tagged web/worker images before stopping existing services' 'Back up current workbench with its compatible previous image, or snapshot legacy SQLite online' 'Stop previous writers; take final backup; migrate new schema explicitly' 'Archive legacy rows only as legacy research; never create actual funds' 'Create encrypted backup and restore into a new rehearsal directory' 'Start isolated workbench project; verify schema, auth, HTTP and worker health' 'Failure stops new writers and preserves all new facts; no database overwrite rollback'
  exit 0
fi

[[ $(id -u) == 0 ]] || { printf 'Deployment execution requires an authorized root operator\n' >&2; exit 2; }
for command in docker curl python3 flock timeout; do command -v "$command" >/dev/null; done
[[ -f "$release_dir/docker-compose.yml" && -f "$release_dir/.release-sha" ]] || { printf 'Prepared release artifact missing\n' >&2; exit 2; }
[[ ! -L "$release_dir" && $(realpath "$release_dir") == "$release_dir" ]] || { printf 'Release directory must not alias another path\n' >&2; exit 2; }
read -r staged_sha < "$release_dir/.release-sha"
[[ "$staged_sha" == "$release_sha" ]] || { printf 'Release marker mismatch\n' >&2; exit 2; }
[[ -f "$release_dir/.release-files.sha256" ]] || { printf 'Release file integrity manifest missing\n' >&2; exit 2; }
(cd "$release_dir" && sha256sum --check --quiet .release-files.sha256)
[[ -z $(find "$release_dir" -type l -print -quit) ]] || { printf 'Symlinked release source rejected\n' >&2; exit 2; }
(cd "$release_dir" && diff -u <(find . -type f ! -name .release-files.sha256 | LC_ALL=C sort) <(sed -E 's/^[a-f0-9]{64}  //' .release-files.sha256 | LC_ALL=C sort))
for secret_file in "$WORKBENCH_RUNTIME_ENV_FILE" "$WORKBENCH_BACKUP_KEY_FILE"; do
  [[ -f "$secret_file" && ! -L "$secret_file" ]] || { printf 'Secret file missing or symlinked\n' >&2; exit 2; }
  mode=$(stat -c '%a' "$secret_file")
  (( (8#$mode & 077) == 0 )) || { printf 'Secret file permissions too broad\n' >&2; exit 2; }
done
[[ $(stat -c '%u' "$WORKBENCH_BACKUP_KEY_FILE") == 10001 ]] || { printf 'Backup key must be readable by UID 10001 and mode 0600\n' >&2; exit 2; }
[[ $(stat -c '%u' "$WORKBENCH_RUNTIME_ENV_FILE") == 0 ]] || { printf 'Runtime environment must be root-owned\n' >&2; exit 2; }
mkdir -p "$WORKBENCH_DEPLOY_ROOT"
exec 9>"$WORKBENCH_DEPLOY_ROOT/.release.lock"
flock -n 9 || { printf 'Another release is active\n' >&2; exit 2; }
for directory in "$WORKBENCH_DATA_DIR_HOST" "$WORKBENCH_BACKUP_DIR_HOST" "$WORKBENCH_RESTORE_PARENT_DIR"; do
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" && $(stat -c '%u' "$directory") == 10001 ]] || { printf 'Existing workbench volume owner/path invalid; legacy ownership was not changed\n' >&2; exit 2; }
    mode=$(stat -c '%a' "$directory")
    (( (8#$mode & 077) == 0 )) || { printf 'Existing workbench volume must have no group/other permissions\n' >&2; exit 2; }
  else install -d -o 10001 -g 10001 -m 0700 "$directory"; fi
done
[[ $(realpath "$WORKBENCH_DATA_DIR_HOST") != $(realpath "$WORKBENCH_LEGACY_DATA_DIR") ]] || { printf 'Resolved legacy and actual data paths collide\n' >&2; exit 2; }
assert_no_recovery() {
  [[ ! -e "$WORKBENCH_DATA_DIR_HOST/RESTORE_PENDING_REVIEW" && ! -L "$WORKBENCH_DATA_DIR_HOST/RESTORE_PENDING_REVIEW" ]] || { printf 'Pending recovery review prohibits deployment\n' >&2; return 1; }
}
assert_no_recovery

evidence="$WORKBENCH_DEPLOY_ROOT/release-evidence/$release_sha-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$evidence"
compose() { docker compose --env-file "$config" -p "$WORKBENCH_PROJECT" -f "$release_dir/docker-compose.yml" "$@"; }
writer_services() {
  local configured service found_web=0 found_worker=0
  configured=$("$@" config --no-env-resolution --services) || return 1
  while IFS= read -r service; do
    case "$service" in
      web) found_web=1; printf '%s\n' "$service" ;;
      worker) found_worker=1; printf '%s\n' "$service" ;;
      verifier) printf '%s\n' "$service" ;;
      migrate|backup|restore|archive-legacy) ;;
      *) printf 'Unrecognized previous Compose service; writer review required: %s\n' "$service" >&2; return 1 ;;
    esac
  done <<< "$configured"
  ((found_web && found_worker)) || { printf 'Previous Compose is missing required writer services\n' >&2; return 1; }
}
stop_writers() {
  local discovered service
  local -a writers=()
  discovered=$(writer_services "$@") || return 1
  while IFS= read -r service; do writers+=("$service"); done <<< "$discovered"
  "$@" stop "${writers[@]}"
}
assert_stopped() {
  local ids id discovered service
  local -a writers=()
  discovered=$(writer_services "$@") || return 1
  while IFS= read -r service; do writers+=("$service"); done <<< "$discovered"
  ids=$("$@" ps --all --quiet "${writers[@]}") || return 1
  [[ -n "$ids" ]] || { printf 'Cannot establish previous writer container state\n' >&2; return 1; }
  for id in $ids; do [[ $(docker inspect "$id" --format '{{.State.Running}}') == false ]] || return 1; done
}
previous=""
if [[ -L "$WORKBENCH_DEPLOY_ROOT/current" ]]; then
  previous=$(readlink -f "$WORKBENCH_DEPLOY_ROOT/current")
  [[ "$previous" == "$WORKBENCH_DEPLOY_ROOT/releases/"* && -f "$previous/.release-sha" ]] || { printf 'Invalid current release link\n' >&2; exit 2; }
fi
first_release=0
if [[ -e "$WORKBENCH_DATA_DIR_HOST/etf-workbench.db" ]]; then
  [[ -n "$previous" ]] || { printf 'Untracked existing workbench database; explicit recovery/adoption review required\n' >&2; exit 2; }
else
  [[ -z "$previous" ]] || { printf 'Current release has lost its database; refusing to create empty replacement\n' >&2; exit 2; }
  first_release=1
fi
writers_stopped=0
mutation_started=0
failed() {
  result=$?
  trap - ERR
  if ((writers_stopped || mutation_started)); then
    compose stop web worker verifier >/dev/null 2>&1 || true
    printf '%s\n' '{"reason":"release failed; preserve new facts and reconcile before resuming"}' > "$WORKBENCH_DATA_DIR_HOST/RESTORE_PENDING_REVIEW"
    chown 10001:10001 "$WORKBENCH_DATA_DIR_HOST/RESTORE_PENDING_REVIEW"
    chmod 0600 "$WORKBENCH_DATA_DIR_HOST/RESTORE_PENDING_REVIEW"
  fi
  printf '{"release_sha":"%s","status":"failed","database_overwritten":false,"writers_stopped":%s}\n' "$release_sha" "$writers_stopped" > "$evidence/result.json"
  printf 'Release failed; sources and new facts preserved. Review %s\n' "$evidence" >&2
  exit "$result"
}
trap failed ERR
compose config --no-env-resolution --quiet
timeout 30 docker version --format '{{.Server.Version}}' > "$evidence/docker-version.txt"
timeout 3600 docker compose --env-file "$config" -p "$WORKBENCH_PROJECT" -f "$release_dir/docker-compose.yml" build --pull web worker
for image in "etf-workbench-web:$release_sha" "etf-workbench-worker:$release_sha"; do
  [[ $(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$release_sha" ]]
  [[ $(docker image inspect "$image" --format '{{.Config.User}}') == '10001:10001' ]]
done
docker image inspect "etf-workbench-web:$release_sha" "etf-workbench-worker:$release_sha" --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' > "$evidence/image-identities.txt"
compose run --rm --no-deps web node /app/scripts/check-workbench-runtime.mjs --config-only > "$evidence/auth-configuration.json"
compose run --rm --no-deps --entrypoint node backup --input-type=module -e 'import {readPassphrase} from "/app/scripts/backup-workbench.mjs"; await readPassphrase(); console.log("backup key configured");' > "$evidence/backup-key-check.txt"
assert_no_recovery

if ((first_release)); then
  compose run --rm --no-deps -e WORKBENCH_DB_PATH= archive-legacy > "$evidence/legacy-online-snapshot.json"
  assert_no_recovery
  writers_stopped=1
  stop_writers docker compose -p "$WORKBENCH_LEGACY_PROJECT" -f "$WORKBENCH_LEGACY_DIR/docker-compose.yml"
  assert_stopped docker compose -p "$WORKBENCH_LEGACY_PROJECT" -f "$WORKBENCH_LEGACY_DIR/docker-compose.yml"
else
  read -r previous_sha < "$previous/.release-sha"
  [[ "$previous_sha" =~ ^[a-f0-9]{40}$ ]]
  WORKBENCH_RELEASE_SHA="$previous_sha" docker compose --env-file "$config" -p "$WORKBENCH_PROJECT" -f "$previous/docker-compose.yml" run --rm --no-deps backup > "$evidence/pre-stop-backup.json"
  assert_no_recovery
  writers_stopped=1
  WORKBENCH_RELEASE_SHA="$previous_sha" stop_writers docker compose --env-file "$config" -p "$WORKBENCH_PROJECT" -f "$previous/docker-compose.yml"
  WORKBENCH_RELEASE_SHA="$previous_sha" assert_stopped docker compose --env-file "$config" -p "$WORKBENCH_PROJECT" -f "$previous/docker-compose.yml"
  WORKBENCH_RELEASE_SHA="$previous_sha" docker compose --env-file "$config" -p "$WORKBENCH_PROJECT" -f "$previous/docker-compose.yml" run --rm --no-deps backup > "$evidence/final-pre-migration-backup.json"
fi
assert_no_recovery
mutation_started=1
compose run --rm --no-deps migrate > "$evidence/migration.json"
assert_no_recovery
if ((first_release)); then compose run --rm --no-deps -e WORKBENCH_LEGACY_QUIESCED=1 archive-legacy > "$evidence/final-legacy-archive.json"; fi
compose run --rm --no-deps backup > "$evidence/pre-start-backup.json"
archive_path=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["path"])' < "$evidence/pre-start-backup.json")
WORKBENCH_RESTORE_ARCHIVE_NAME=$(basename "$archive_path")
WORKBENCH_RESTORE_TARGET_NAME="release-$release_sha-$(date -u +%s)"
export WORKBENCH_RESTORE_ARCHIVE_NAME WORKBENCH_RESTORE_TARGET_NAME
[[ "$WORKBENCH_RESTORE_ARCHIVE_NAME" =~ ^workbench-[a-f0-9-]+\.etfbackup$ ]]
compose run --rm --no-deps restore > "$evidence/local-restore-rehearsal.json"
assert_no_recovery
timeout 180 docker compose --env-file "$config" -p "$WORKBENCH_PROJECT" -f "$release_dir/docker-compose.yml" up -d --no-build --wait --wait-timeout 150 web worker verifier
compose exec -T web node /app/scripts/check-workbench-runtime.mjs --http > "$evidence/runtime-readiness.json"
compose exec -T worker python -c 'import os; from worker.orchestration.db import open_database; c=open_database(os.environ["WORKBENCH_DB_PATH"]); c.close(); print("worker schema ready")' > "$evidence/worker-readiness.txt"
compose exec -T verifier python -c 'import os; from worker.orchestration.db import open_database; from worker.governance_verification.source import source_manifest; from worker.orchestration.runtime import role_commands; assert role_commands("verifier") == ("governance_verification_v2",); assert not any(k.startswith("LONGPORT_") or k in ("WORKBENCH_PASSWORD_HASH","WORKBENCH_SESSION_SECRET") for k in os.environ); c=open_database(os.environ["WORKBENCH_DB_PATH"]); c.close(); source_manifest(); print("verifier schema and fixed source ready")' > "$evidence/verifier-readiness.txt"
[[ $(docker inspect "$(compose ps -q verifier)" --format '{{.HostConfig.NetworkMode}}') == none ]]
[[ $(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$WORKBENCH_HTTP_PORT/api/workbench") == 401 ]]
assert_no_recovery
ln -s "$release_dir" "$WORKBENCH_DEPLOY_ROOT/.current-$release_sha-$$"
mv -Tf "$WORKBENCH_DEPLOY_ROOT/.current-$release_sha-$$" "$WORKBENCH_DEPLOY_ROOT/current"
printf '{"release_sha":"%s","status":"technical_cutover_verified","local_restore_verified":true,"independent_host_restore_verified":false,"investment_gates_unchanged":true}\n' "$release_sha" > "$evidence/result.json"
trap - ERR
printf 'Technical cutover verified; investment and independent-host recovery gates remain separate. Evidence: %s\n' "$evidence"
