#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
image="etf-workbench-market-provider:verify-$run_id"
release_sha=$(git rev-parse --verify HEAD)
timeout 1200 docker build -f Dockerfile.market-provider --build-arg "RELEASE_SHA=$release_sha" -t "$image" .
mkdir -p artifacts/verification
report="artifacts/verification/container-provider-$run_id.json"
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:mode=1777 --mount "type=bind,source=$root/tests/deployment/provider-runtime-smoke.py,target=/fixture-smoke.py,readonly" \
  --entrypoint python "$image" /fixture-smoke.py > "$report"
node - "$report" "$image" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const [file, image] = process.argv.slice(2), result = JSON.parse(readFileSync(file, 'utf8'));
const trueFields = ['native_sdk_imported', 'sdk_signature_checked', 'provider_role_isolated', 'fixed_child_rejected_untrusted_input', 'network_disabled'];
const falseFields = ['credentials_present', 'quote_context_constructed', 'real_market_data_verified'];
const keys = ['schema_version', 'status', 'runtime_uid', 'python_version', 'libc', 'sdk_version', 'sdk_native_sha256', 'adapter_sha256', ...trueFields, ...falseFields].sort();
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const adapterHash = createHash('sha256').update(readFileSync('worker/market/providers/longport.py')).digest('hex');
if (!result || typeof result !== 'object' || Array.isArray(result)
    || JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(keys)
    || result.schema_version !== 'provider-runtime-smoke-v1' || result.status !== 'passed'
    || result.runtime_uid !== 10001 || !/^3\.11\.\d+$/.test(result.python_version)
    || !Array.isArray(result.libc) || result.libc.length !== 2 || result.libc[0] !== 'glibc'
    || typeof result.libc[1] !== 'string' || !/^\d+\.\d+$/.test(result.libc[1])
    || Number(result.libc[1].split('.')[0]) < 2
    || (Number(result.libc[1].split('.')[0]) === 2 && Number(result.libc[1].split('.')[1]) < 39)
    || result.sdk_version !== '4.3.7' || !digest(result.sdk_native_sha256)
    || result.adapter_sha256 !== adapterHash
    || trueFields.some(key => result[key] !== true) || falseFields.some(key => result[key] !== false)) throw Error('Invalid provider smoke result');
result.image_id = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(result.image_id)) throw Error('Invalid provider image ID');
writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
NODE
