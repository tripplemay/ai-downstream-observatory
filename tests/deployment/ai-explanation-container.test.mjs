import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('AI sidecar retains pinned proof sources and defaults to cleanup without broker tools or public ports', () => {
  const docker = readFileSync(new URL('../../Dockerfile.ai-explanation', import.meta.url), 'utf8');
  for (const value of ['build:ai-explanation', 'ai-explanation.manifest.json', 'run-ai-explanation.mjs --check', 'USER 10001:10001',
    'WORKBENCH_AI_ENABLE_DISPATCH=0', 'worker/investor/', 'worker/ai_explanation/', 'pip check', 'ai-explanation-source.mjs', '--health'])
    assert.ok(docker.includes(value), value);
  assert.ok(!docker.includes('requirements-market-longport')); assert.ok(!docker.includes('EXPOSE'));
  const overlay = readFileSync(new URL('../../docker-compose.ai-explanation.yml', import.meta.url), 'utf8');
  for (const value of ['read_only: true', 'cap_drop: [ALL]', 'no-new-privileges:true', 'create_host_path: false',
    'WORKBENCH_AI_ENABLE_DISPATCH:-0', 'WORKBENCH_AI_BACKGROUND_ENABLED', 'service_healthy']) assert.ok(overlay.includes(value), value);
  for (const forbidden of ['ports:', 'LONGBRIDGE_', 'market-provider.env', 'runtime.env', 'WORKBENCH_PASSWORD_HASH', 'WORKBENCH_SESSION_SECRET'])
    assert.ok(!overlay.includes(forbidden), forbidden);
  const route = readFileSync(new URL('../../web/src/app/api/workbench/investor/ai-explanation/route.ts', import.meta.url), 'utf8');
  assert.ok(route.includes('enqueueInvestorAiExplanation')); assert.ok(!route.includes('explainInvestorObservation'));
  assert.ok(route.includes('? 202 : 200')); assert.ok(route.includes('WORKBENCH_AI_BACKGROUND_ENABLED !== "1"'));
});

test('AI image bootstrap keeps HTTPS hostname, peer and APT package signature checks', () => {
  const docker = readFileSync(new URL('../../Dockerfile.ai-explanation', import.meta.url), 'utf8');
  assert.equal(docker.split("require('node:tls').rootCertificates").length - 1, 2);
  assert.ok(docker.includes("replaceAll('http://deb.debian.org','https://deb.debian.org')"));
  assert.ok(docker.includes('Acquire::https::CAInfo=/tmp/apt-ca.pem'));
  assert.ok(!/Verify-(?:Peer|Host)[^\n]*false|allow-unauthenticated|AllowInsecure|trusted=yes/.test(docker));
});

test('isolated Linux fixture guards both storage volumes before image builds and owns its cleanup', () => {
  const fixture = readFileSync(new URL('./ai-http-runtime.integration.mjs', import.meta.url), 'utf8');
  assert.ok(fixture.includes('FIXTURE_VM_HOST_STORAGE_TOO_SMALL'));
  assert.ok(fixture.includes('FIXTURE_SYSTEM_STORAGE_TOO_SMALL'));
  assert.ok(fixture.indexOf("check('VM-STORAGE-PREFLIGHT'") < fixture.indexOf("check('LINUX-IMAGES'"));
  assert.ok(fixture.includes('for (const name of containers)'));
  assert.ok(fixture.includes('if (networkCreated)'));
});
