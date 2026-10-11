import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('web image builds and retains the fixed comparison bundle and its complete source inventory', () => {
  const docker = readFileSync(new URL('../../Dockerfile.web', import.meta.url), 'utf8');
  for (const value of ['build:funded-comparison', 'funded-comparison.mjs', 'funded-comparison.manifest.json', 'funded-comparison-worker.ts',
    'build-funded-comparison.mjs', 'funded-comparison-source.mjs', '/app/web/src/server/', '/app/web/package-lock.json', 'migrations/ /app/migrations/', 'contracts/ /app/contracts/'])
    assert.ok(docker.includes(value), value);
  const core = readFileSync(new URL('../../worker/orchestration/runtime.py', import.meta.url), 'utf8');
  assert.ok(core.indexOf('purge_due_funded_results(connection') > core.lastIndexOf('if role == "core":'));
  assert.ok(core.indexOf('purge_due_funded_results(connection') < core.lastIndexOf('elif role == "longport":'));
});
