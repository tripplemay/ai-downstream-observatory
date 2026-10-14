import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('protected deploy plan bounds the core lease and defaults to fifteen minutes without mutating files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'core-lease-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'release.env'), sha = 'a'.repeat(40);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WORKBENCH_|COMPOSE_)/.test(key)));
  const plan = value => {
    writeFileSync(config, `WORKBENCH_DEPLOY_ROOT=${directory}\nWORKBENCH_RUNTIME_ENV_FILE=${directory}/runtime.env\nWORKBENCH_BACKUP_KEY_FILE=${directory}/backup.passphrase\n${value === null ? '' : `WORKBENCH_CORE_LEASE_SECONDS=${value}\n`}`, { mode: 0o600 });
    return spawnSync('bash', [join(root, 'scripts/deploy-workbench.sh'), '--release', sha, '--release-dir', `${directory}/releases/${sha}`, '--config', config], { env, encoding: 'utf8' });
  };
  for (const value of [null, '300', '900', '3600']) {
    const result = plan(value); assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Core research lease seconds: ${value ?? '900'}`));
  }
  for (const value of ['299', '3601', '0900', '900.5', '-900', '0', '99999999999999999999', 'not-an-integer']) {
    const result = plan(value); assert.notEqual(result.status, 0); assert.match(result.stderr, /Core lease/);
  }
});
test('actual Compose config sets only the core command and honors the approved lease', t => {
  const directory = mkdtempSync(join(tmpdir(), 'core-lease-compose-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = join(directory, 'runtime.env'); writeFileSync(runtime, 'SYNTHETIC_WEB_ONLY=not-a-secret\n');
  for (const seconds of [undefined, '300', '900', '3600']) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WORKBENCH_|COMPOSE_|LONGPORT_|LONGBRIDGE_)/.test(key)));
    Object.assign(env, { WORKBENCH_RUNTIME_ENV_FILE: runtime, WORKBENCH_RELEASE_SHA: 'synthetic-lease' });
    if (seconds) env.WORKBENCH_CORE_LEASE_SECONDS = seconds;
    const result = spawnSync('docker', ['compose', '--env-file', '/dev/null', '-p', 'synthetic-lease', '-f', join(root, 'docker-compose.yml'),
      'config', '--no-env-resolution', '--format', 'json'], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    if (result.error?.code === 'ENOENT') return t.skip('Compose CLI absent; real container CI remains required');
    assert.equal(result.status, 0, result.stderr);
    const services = JSON.parse(result.stdout).services;
    assert.deepEqual(services.worker.command, ['python', '-m', 'worker.orchestration', '--role', 'core', '--lease-seconds', seconds ?? '900']);
    assert.deepEqual(services.verifier.command, ['python', '-m', 'worker.orchestration', '--role', 'verifier']);
    assert.equal(services.worker.env_file, undefined);
  }
});
test('deploy exports the bounded lease and checks the running core command before recording cutover', () => {
  const source = readFileSync(join(root, 'scripts/deploy-workbench.sh'), 'utf8');
  assert.match(source, /export WORKBENCH_CORE_LEASE_SECONDS/);
  assert.match(source, /docker inspect "\$\(compose ps -q worker\)" --format '\{\{json \.Config\.Cmd\}\}'/);
  assert.ok(source.indexOf('core-lease-readiness.txt') < source.indexOf('technical_cutover_verified'));
  assert.doesNotMatch(source, /core-research-lease\.override\.yml/);
});
