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
write_recovery_barrier() { printf 'barrier\\n' >> "$CALLS"; printf 'fixture recovery review\\n' > "$WORKBENCH_DATA_DIR_HOST/RESTORE_PENDING_REVIEW"; }
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
  if (stopped) assert.equal(readFileSync(join(directory, 'calls'), 'utf8').split('\n')[0], 'barrier', 'fence writes before any potentially blocking stop');
  assert.equal(readFileSync(join(directory, 'data', 'etf-workbench.db'), 'utf8'), 'SYNTHETIC PRESERVED DATABASE');
});

for (const stopped of [false, true]) for (const [signal, code] of [['HUP', 129], ['INT', 130], ['TERM', 143]]) test(`${signal} ${stopped ? 'after writer stop fences recovery before cleanup' : 'before writer stop preserves running services'}`, t => {
  const source = readFileSync(join(root, 'scripts/deploy-workbench.sh'), 'utf8');
  const handler = source.match(/^failed\(\) \{\n[\s\S]*?^trap failed ERR$/m)?.[0];
  const traps = source.split('\n').filter(line => /^trap .* (HUP|INT|TERM)$/.test(line));
  assert.ok(handler); assert.equal(traps.length, 3);
  const directory = mkdtempSync(join(tmpdir(), 'release-signal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['data', 'evidence']) mkdirSync(join(directory, name));
  writeFileSync(join(directory, 'data/etf-workbench.db'), 'SYNTHETIC TAIL FACTS');
  const harness = `set -Eeuo pipefail
writers_stopped=${stopped ? 1 : 0}
mutation_started=0
release_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
evidence="$FIXTURE/evidence"
WORKBENCH_DATA_DIR_HOST="$FIXTURE/data"
start_services=(web worker verifier market-provider ai-explanation)
write_recovery_barrier() { printf 'barrier\\n' >> "$CALLS"; printf 'fixture review\\n' > "$WORKBENCH_DATA_DIR_HOST/RESTORE_PENDING_REVIEW"; }
compose() { test -f "$WORKBENCH_DATA_DIR_HOST/RESTORE_PENDING_REVIEW"; printf 'stop\\n' >> "$CALLS"; }
stop_market_provider_writers() { test -f "$WORKBENCH_DATA_DIR_HOST/RESTORE_PENDING_REVIEW"; }
stop_ai_explanation_writers() { test -f "$WORKBENCH_DATA_DIR_HOST/RESTORE_PENDING_REVIEW"; }
${handler}
${traps.join('\n')}
kill -${signal} "$$"
printf 'unreachable\\n'
`;
  const run = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, FIXTURE: directory, CALLS: join(directory, 'calls') } });
  assert.equal(run.status, code, run.stderr); assert.equal(run.signal, null);
  assert.doesNotMatch(run.stdout, /unreachable/);
  assert.equal(existsSync(join(directory, 'calls')), stopped);
  if (stopped) assert.equal(readFileSync(join(directory, 'calls'), 'utf8'), 'barrier\nstop\n');
  assert.equal(existsSync(join(directory, 'data/RESTORE_PENDING_REVIEW')), stopped);
  assert.equal(readFileSync(join(directory, 'data/etf-workbench.db'), 'utf8'), 'SYNTHETIC TAIL FACTS');
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'evidence/result.json'), 'utf8')),
    { release_sha: 'a'.repeat(40), status: 'failed', database_overwritten: false, writers_stopped: stopped ? 1 : 0 });
});

test('failed write-ahead persistence cannot stop old writers in either deployment branch', t => {
  const source = readFileSync(join(root, 'scripts/deploy-workbench.sh'), 'utf8');
  assert.equal(source.split('  record_cutover_intent\n  assert_no_recovery\n  writers_stopped=1\n').length - 1, 2);
  const intent = source.match(/^record_cutover_intent\(\) \{\n[\s\S]*?^\}/m)?.[0];
  const handler = source.match(/^failed\(\) \{\n[\s\S]*?^trap failed ERR$/m)?.[0];
  assert.ok(intent && handler);
  const directory = mkdtempSync(join(tmpdir(), 'release-write-ahead-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['data', 'evidence']) mkdirSync(join(directory, name));
  writeFileSync(join(directory, 'data/etf-workbench.db'), 'SYNTHETIC RUNNING DATABASE');
  const run = spawnSync('bash', ['-c', `set -Eeuo pipefail
writers_stopped=0
mutation_started=0
release_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
release_dir="$FIXTURE"
evidence="$FIXTURE/evidence"
WORKBENCH_DATA_DIR_HOST="$FIXTURE/data"
WORKBENCH_PROJECT=etf-workbench
start_services=(web worker verifier)
python3() { return 44; }
write_recovery_barrier() { printf 'unexpected\\n' >> "$CALLS"; }
compose() { printf 'unexpected\\n' >> "$CALLS"; }
stop_market_provider_writers() { printf 'unexpected\\n' >> "$CALLS"; }
stop_ai_explanation_writers() { printf 'unexpected\\n' >> "$CALLS"; }
${intent}
${handler}
record_cutover_intent
writers_stopped=1
compose stop
`], { encoding: 'utf8', timeout: 10000, env: { ...process.env, FIXTURE: directory, CALLS: join(directory, 'calls') } });
  assert.equal(run.status, 44, run.stderr);
  assert.equal(existsSync(join(directory, 'calls')), false);
  assert.equal(existsSync(join(directory, 'data/RESTORE_PENDING_REVIEW')), false);
  assert.equal(readFileSync(join(directory, 'data/etf-workbench.db'), 'utf8'), 'SYNTHETIC RUNNING DATABASE');
  assert.equal(JSON.parse(readFileSync(join(directory, 'evidence/result.json'), 'utf8')).writers_stopped, 0);
});

test('a recovery marker arriving during cutover-intent persistence still prevents writer stop', t => {
  const source = readFileSync(join(root, 'scripts/deploy-workbench.sh'), 'utf8');
  const handler = source.match(/^failed\(\) \{\n[\s\S]*?^trap failed ERR$/m)?.[0];
  const guard = source.match(/^assert_no_recovery\(\) \{\n[\s\S]*?^\}/m)?.[0];
  const boundary = source.match(/  record_cutover_intent\n  assert_no_recovery\n  writers_stopped=1\n/)?.[0];
  assert.ok(handler && guard && boundary);
  const directory = mkdtempSync(join(tmpdir(), 'release-late-intent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['data', 'evidence']) mkdirSync(join(directory, name));
  writeFileSync(join(directory, 'data/etf-workbench.db'), 'SYNTHETIC UNCHANGED FACTS');
  const run = spawnSync('bash', ['-c', `set -Eeuo pipefail
writers_stopped=0
mutation_started=0
release_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
evidence="$FIXTURE/evidence"
WORKBENCH_DATA_DIR_HOST="$FIXTURE/data"
start_services=(web worker verifier)
record_cutover_intent() { printf 'late independent review\\n' > "$WORKBENCH_DATA_DIR_HOST/RESTORE_PENDING_REVIEW"; }
write_recovery_barrier() { printf 'unexpected\\n' >> "$CALLS"; }
compose() { printf 'unexpected\\n' >> "$CALLS"; }
stop_market_provider_writers() { printf 'unexpected\\n' >> "$CALLS"; }
stop_ai_explanation_writers() { printf 'unexpected\\n' >> "$CALLS"; }
${guard}
${handler}
${boundary}
compose stop
`], { encoding: 'utf8', timeout: 10000, env: { ...process.env, FIXTURE: directory, CALLS: join(directory, 'calls') } });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(existsSync(join(directory, 'calls')), false);
  assert.equal(readFileSync(join(directory, 'data/RESTORE_PENDING_REVIEW'), 'utf8'), 'late independent review\n');
  assert.equal(readFileSync(join(directory, 'data/etf-workbench.db'), 'utf8'), 'SYNTHETIC UNCHANGED FACTS');
});
