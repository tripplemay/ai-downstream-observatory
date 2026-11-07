#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $(uname -s) == Linux ]] || { printf 'AI native fixture requires Linux\n' >&2; exit 2; }
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
sha=$(git rev-parse --verify HEAD)
image="etf-workbench-ai-explanation:$sha"
web_image="etf-workbench-web:$sha"
volume="etf-ai-release-$run_id"
container="etf-ai-release-$run_id"
project="etf-ai-release-${run_id//[TZ]/}"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/workbench-ai-images-$run_id-XXXXXX")
volume_created=0
cleanup_resources() {
  local result=0 ids id
  ids=$(docker ps --all --filter "label=etf.fixture.ai-release=$run_id" --format '{{.ID}}') || return 1
  for id in $ids; do
    [[ "$id" =~ ^[a-f0-9]{12,64}$ ]] || { result=1; continue; }
    docker rm --force "$id" >/dev/null || result=1
  done
  if ((volume_created)); then
    if [[ $(docker volume inspect "$volume" --format '{{index .Labels "etf.fixture.ai-release"}}') == "$run_id" ]]; then
      docker volume rm "$volume" >/dev/null || result=1
    else result=1; fi
  fi
  rm -rf -- "$temporary"
  return "$result"
}
cleanup() {
  result=$?
  trap - EXIT
  cleanup_resources || result=1
  exit "$result"
}
trap cleanup EXIT
[[ $(docker image inspect "$web_image" --format '{{.Config.User}}') == 10001:10001 ]]
timeout 1200 docker build --platform linux/amd64 --file Dockerfile.ai-explanation --build-arg "RELEASE_SHA=$sha" --tag "$image" .
[[ $(docker image inspect "$image" --format '{{.Config.User}}') == 10001:10001 ]]
[[ $(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$sha" ]]
python3 scripts/release-image-bundle.py pack --release "$sha" --directory "$temporary/images" --ai-explanation 1 >/dev/null
python3 scripts/release-image-bundle.py load --release "$sha" --directory "$temporary/images" --ai-explanation 1 > "$temporary/bundle.json"
docker volume create --label "etf.fixture.ai-release=$run_id" "$volume" >/dev/null
volume_created=1
[[ $(docker volume inspect "$volume" --format '{{index .Labels "etf.fixture.ai-release"}}') == "$run_id" ]]
docker run --rm --network none --read-only --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --user 0:0 --mount "type=volume,src=$volume,dst=/fixture" --entrypoint sh "$image" -c 'chown 10001:10001 /fixture; chmod 0700 /fixture'
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp --mount "type=volume,src=$volume,dst=/app/data" \
  --entrypoint node "$web_image" /app/scripts/migrate-workbench.mjs --db /app/data/etf-workbench.db >/dev/null
docker run --rm --interactive --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp --mount "type=volume,src=$volume,dst=/fixture" \
  --entrypoint node "$web_image" --input-type=module - <<'NODE_CONFIG'
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const config={schema_version:'readonly-ai-gateway-v1',base_url:'https://no-network.example.test/v1',api_key:'FICTIONAL_LOCAL_ONLY',model:'fictional-release-model',max_output_tokens:512};
const canonical=value=>value&&typeof value==='object'&&!Array.isArray(value)?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const audience=createHash('sha256').update(canonical({base_url:config.base_url,model:config.model,request_profile:null})).digest('hex');
const now=Date.now(),consent={schema_version:'investor-ai-sharing-consent-v1',principal_id:'owner',gateway_audience_hash:audience,decision:'allow',
  allowed_categories:['model_ratios','target_deviation','strategy_trigger_codes'],source:'explicit_user_confirmation',
  valid_from:new Date(now-60000).toISOString(),valid_until:new Date(now+3600000).toISOString()};
writeFileSync('/fixture/gateway.json',JSON.stringify(config),{mode:0o600});writeFileSync('/fixture/consent.json',JSON.stringify(consent),{mode:0o600});
NODE_CONFIG
configuration=$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp \
  --mount "type=volume,src=$volume,dst=/fixture,readonly" -e WORKBENCH_DB_PATH=/must-not-open.db -e WORKBENCH_AI_ENABLE_DISPATCH=1 \
  -e WORKBENCH_AI_CONFIG_FILE=/fixture/gateway.json -e WORKBENCH_AI_CONSENT_FILE=/fixture/consent.json \
  --entrypoint node "$image" scripts/run-ai-explanation.mjs --config-check)
docker run --detach --name "$container" --label "etf.fixture.ai-release=$run_id" --label "com.docker.compose.project=$project" --label com.docker.compose.service=ai-explanation --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:mode=1777 --pids-limit 64 --memory 1g --cpus 1 --mount "type=volume,src=$volume,dst=/app/data" -e WORKBENCH_AI_ENABLE_DISPATCH=0 "$image" >/dev/null
ready=0
for ((attempt=0;attempt<45;attempt++)); do
  if docker exec "$container" node scripts/run-ai-explanation.mjs --health >/dev/null 2>&1; then ready=1; break; fi
  [[ $(docker inspect "$container" --format '{{.State.Running}}') == true ]] || { printf 'AI fixture exited before health\n' >&2; exit 1; }
  sleep 2
done
((ready)) || { printf 'AI cleanup runtime did not become ready\n' >&2; exit 1; }
[[ $(docker inspect "$container" --format '{{.HostConfig.NetworkMode}}') == none ]]
[[ $(docker exec "$container" id -u) == 10001 ]]
counts=$(docker run --rm --interactive --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp \
  --mount "type=volume,src=$volume,dst=/app/data" --entrypoint node "$web_image" --input-type=module - <<'NODE_COUNTS'
import Database from 'better-sqlite3';
const db=new Database('/app/data/etf-workbench.db',{readonly:true,fileMustExist:true});
try {
  const tables=['portfolios','accounts','ledger_events','postings','position_movements','approval_events','activations','reservations','execution_reports',
    'investor_ai_requests','investor_ai_dispatches','investor_ai_outcomes'];
  if(tables.some(name=>db.prepare('SELECT count(*) n FROM '+name).get().n!==0))throw Error('AI_FIXTURE_UNEXPECTED_FACTS_OR_INTENTS');
  console.log(JSON.stringify({financial_facts:0,automatic_requests:0,dispatches:0,sqlite_schema_version:db.pragma('user_version',{simple:true})}));
}finally{db.close();}
NODE_COUNTS
)
functions=$(python3 - <<'PY_WRITERS'
from pathlib import Path
import re
source=Path('scripts/deploy-workbench.sh').read_text()
for name in ('ai_explanation_ids','stop_ai_explanation_writers','assert_ai_explanation_stopped'):
    value=re.search(r'^'+name+r'\(\) \{\n[\s\S]*?^\}',source,re.M)
    if value is None: raise SystemExit('AI writer fixture could not find the fixed release function')
    print(value[0])
PY_WRITERS
)
# Execute only these reviewed release functions, never the deployment script.
eval "$functions"
export WORKBENCH_PROJECT=$project
export WORKBENCH_AI_ENABLED=0
stop_ai_explanation_writers
assert_ai_explanation_stopped
bundle=$(< "$temporary/bundle.json")
cleanup_resources
[[ -z $(docker ps --all --filter "label=etf.fixture.ai-release=$run_id" --format '{{.ID}}') ]]
[[ -z $(docker volume ls --filter "label=etf.fixture.ai-release=$run_id" --format '{{.Name}}') ]]
volume_created=0
trap - EXIT
mkdir -p artifacts/verification
node --input-type=module - "$run_id" "$sha" "$image" "$configuration" "$counts" "$bundle" <<'NODE_REPORT'
import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const [run,sha,image,configuration,counts,bundleJson]=process.argv.slice(2),config=JSON.parse(configuration),facts=JSON.parse(counts),bundle=JSON.parse(bundleJson);
if(bundle.status!=='loaded_images_verified'||bundle.image_count!==3||!Array.isArray(bundle.runtime_fingerprints)||bundle.runtime_fingerprints.length!==3)throw Error('AI_FIXTURE_NATIVE_BUNDLE_INVALID');
if(JSON.stringify(config)!==JSON.stringify({status:'ai_configuration_checked',dispatch_enabled:true,settings_checked:true,database_opened:false,transport_called:false}))throw Error('AI_FIXTURE_CONFIGURATION_PROOF_INVALID');
if(facts.financial_facts!==0||facts.automatic_requests!==0||facts.dispatches!==0||!Number.isInteger(facts.sqlite_schema_version)||facts.sqlite_schema_version<1)throw Error('AI_FIXTURE_FACT_PROOF_INVALID');
const identity=execFileSync('docker',['image','inspect',image,'--format','{{.Id}}'],{encoding:'utf8'}).trim();
if(!/^sha256:[a-f0-9]{64}$/.test(identity))throw Error('AI_FIXTURE_IMAGE_ID_INVALID');
const result={schema_version:'ai-release-container-smoke-v1',status:'passed',release_sha:sha,image_id:identity,runtime_uid:10001,
  network_disabled:true,configuration_without_database:true,configuration_without_transport:true,cleanup_runtime_healthy:true,
  ...facts,native_ai_bundle_roundtrip:true,image_count:3,native_writer_fence_verified:true,owned_resources_removed:true,real_gateway_called:false,real_market_data_verified:false};
writeFileSync('artifacts/verification/container-ai-'+run+'.json',JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));
NODE_REPORT
