import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

for (const stopped of [false, true]) test(`nested Compose failure ${stopped ? 'fences writers and recovery' : 'preserves running services before cutover'}`, t => {
  const source = readFileSync(join(root, 'scripts/deploy-workbench.sh'), 'utf8');
  const options = source.match(/^set -[^\n]+/m)?.[0];
  const handler = source.match(/^failed\(\) \{\n[\s\S]*?^trap failed ERR$/m)?.[0];
  const compose = source.match(/^compose\(\) \{[^\n]+/m)?.[0];
  assert.ok(options && handler && compose);
  const directory = mkdtempSync(join(tmpdir(), 'release-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['bin', 'data', 'evidence']) mkdirSync(join(directory, name));
  writeFileSync(join(directory, 'data', 'etf-workbench.db'), 'SYNTHETIC PRESERVED DATABASE');
  writeFileSync(join(directory, 'bin', 'docker'), '#!/usr/bin/env bash\nif [[ "$*" == *" stop "* ]]; then printf "stopped\\n" >> "$CALLS"; exit 0; fi\nexit 42\n', { mode: 0o700 });
  const harness = `${options}
umask 077
compose_options=(--fixture)
writers_stopped=${stopped ? 1 : 0}
mutation_started=${stopped ? 1 : 0}
release_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
evidence="$FIXTURE/evidence"
WORKBENCH_DATA_DIR_HOST="$FIXTURE/data"
start_services=(web worker verifier market-provider)
chown() { :; }
stop_market_provider_writers() { printf 'provider_stopped\\n' >> "$CALLS"; }
${compose}
${handler}
compose run --rm --no-deps backup
printf 'unreachable\\n'
`;
  const run = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH}`, FIXTURE: directory, CALLS: join(directory, 'calls') } });
  assert.equal(run.status, 42, run.stderr);
  assert.doesNotMatch(run.stdout, /unreachable/);
  const result = JSON.parse(readFileSync(join(directory, 'evidence', 'result.json'), 'utf8'));
  assert.equal(result.status, 'failed');
  assert.equal(result.database_overwritten, false);
  assert.equal(result.writers_stopped, stopped ? 1 : 0);
  assert.equal(existsSync(join(directory, 'data', 'RESTORE_PENDING_REVIEW')), stopped);
  assert.equal(existsSync(join(directory, 'calls')), stopped);
  assert.equal(readFileSync(join(directory, 'data', 'etf-workbench.db'), 'utf8'), 'SYNTHETIC PRESERVED DATABASE');
});
