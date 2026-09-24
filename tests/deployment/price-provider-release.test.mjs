import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const deploy = readFileSync(join(root, 'scripts/deploy-workbench.sh'), 'utf8');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'price-provider-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function definition(name) {
  const value = deploy.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert.ok(value, name); return value;
}

test('price provider release is explicitly opt-in and requires an independent protected environment path', t => {
  const directory = fixture(t), config = join(directory, 'release.env'), sha = 'a'.repeat(40);
  const plan = extra => {
    writeFileSync(config, `WORKBENCH_DEPLOY_ROOT=${directory}\nWORKBENCH_RUNTIME_ENV_FILE=${directory}/runtime.env\nWORKBENCH_BACKUP_KEY_FILE=${directory}/backup.passphrase\n${extra}`, { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WORKBENCH_|COMPOSE_)/.test(key)));
    return spawnSync('bash', [join(root, 'scripts/deploy-workbench.sh'), '--release', sha, '--release-dir', `${directory}/releases/${sha}`, '--config', config], { encoding: 'utf8', env });
  };
  const disabled = plan(''); assert.equal(disabled.status, 0, disabled.stderr); assert.match(disabled.stdout, /Optional market provider enabled: 0/);
  for (const value of ['true', '2', '-1']) assert.notEqual(plan(`WORKBENCH_MARKET_PROVIDER_ENABLED=${value}\n`).status, 0);
  assert.notEqual(plan('WORKBENCH_MARKET_PROVIDER_ENABLED=1\n').status, 0);
  for (const path of [`${directory}/runtime.env`, `${directory}/backup.passphrase`, '/tmp/../provider.env'])
    assert.notEqual(plan(`WORKBENCH_MARKET_PROVIDER_ENABLED=1\nWORKBENCH_MARKET_PROVIDER_ENV_FILE=${path}\n`).status, 0);
  const enabled = plan(`WORKBENCH_MARKET_PROVIDER_ENABLED=1\nWORKBENCH_MARKET_PROVIDER_ENV_FILE=${directory}/market-provider.env\n`);
  assert.equal(enabled.status, 0, enabled.stderr); assert.match(enabled.stdout, /Optional market provider enabled: 1/);
  assert.doesNotMatch(enabled.stdout, /LONGPORT_|market-provider\.env/);
});

test('release command arrays build and start the provider only for explicit enablement', t => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'docker-compose.market-provider.yml'), 'services: {}\n');
  const configure = deploy.slice(deploy.indexOf('compose_options=('), deploy.indexOf('compose() {'));
  assert.ok(configure.startsWith('compose_options=('));
  for (const enabled of ['0', '1']) {
    const result = spawnSync('bash', ['-c', configure + '\nprintf \'%s\\n\' "${build_services[*]}" "${start_services[*]}" "${release_images[*]}" "${compose_options[*]}"'], {
      env: { ...process.env, WORKBENCH_MARKET_PROVIDER_ENABLED: enabled, WORKBENCH_PROJECT: 'synthetic', release_dir: directory, config: '/synthetic/release.env', release_sha: 'synthetic-sha' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines[0], `web worker${enabled === '1' ? ' market-provider' : ''}`);
    assert.equal(lines[1], `web worker verifier${enabled === '1' ? ' market-provider' : ''}`);
    assert.equal(lines[2].includes('etf-workbench-market-provider:synthetic-sha'), enabled === '1');
    assert.equal(lines[3].includes('--profile market-provider'), enabled === '1');
  }
});

test('previous provider writers are label-scoped and stopped even when the next release disables them', t => {
  const directory = fixture(t);
  const functions = ['market_provider_ids', 'stop_market_provider_writers', 'assert_market_provider_stopped'].map(definition).join('\n');
  const script = `${functions}
docker() {
  printf '%s\\n' "$*" >> "$TRACE"
  case "$1" in
    ps) printf '%s\\n' "$IDS"; return "\${LIST_STATUS:-0}" ;;
    stop) return "\${STOP_STATUS:-0}" ;;
    inspect) printf '%s\\n' "\${RUNNING:-false}" ;;
    *) return 91 ;;
  esac
}
timeout() { shift; "$@"; }
stop_market_provider_writers || exit 10
assert_market_provider_stopped || exit 11
`;
  for (const ids of ['', 'a'.repeat(12), `${'b'.repeat(64)}\n${'c'.repeat(12)}`]) {
    const trace = join(directory, `case-${ids.length}`);
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, WORKBENCH_MARKET_PROVIDER_ENABLED: '0', WORKBENCH_PROJECT: 'synthetic-price-project', IDS: ids, TRACE: trace }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(trace, 'utf8');
    for (const line of calls.split('\n').filter(line => line.startsWith('ps '))) {
      assert.ok(line.includes('--filter label=com.docker.compose.project=synthetic-price-project'));
      assert.ok(line.includes('--filter label=com.docker.compose.service=market-provider'));
    }
    assert.equal(calls.split('\n').filter(line => line.startsWith('stop ')).length, ids ? ids.split('\n').length : 0);
  }
  for (const extra of [{ IDS: 'not-a-container' }, { LIST_STATUS: '1' }, { STOP_STATUS: '1' }, { RUNNING: 'true' }]) {
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, WORKBENCH_PROJECT: 'synthetic-price-project', IDS: 'a'.repeat(12), TRACE: join(directory, 'invalid'), ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 10, JSON.stringify(extra));
  }
});

test('provider preflight, migration isolation and failure cleanup are wired into the release path', () => {
  assert.match(deploy, /secret_files\+=\("\$WORKBENCH_MARKET_PROVIDER_ENV_FILE"\)/);
  assert.match(deploy, /Market provider environment must be root-owned/);
  assert.equal((deploy.match(/writers_stopped=1\n  stop_market_provider_writers/g) ?? []).length, 2);
  assert.match(deploy, /assert_market_provider_stopped\nassert_no_recovery\nmutation_started=1/);
  assert.match(deploy, /compose stop "\$\{start_services\[@\]\}"[\s\S]*?stop_market_provider_writers[\s\S]*?RESTORE_PENDING_REVIEW/);
  assert.ok(deploy.indexOf('market-provider-configuration.txt') < deploy.indexOf('if ((first_release)); then'));
  assert.match(deploy, /market-provider-readiness\.txt/);
  assert.match(deploy, /else\n  assert_market_provider_stopped\nfi/);
  assert.doesNotMatch(deploy, /QuoteContext|collect_longport_candles/);
});

test('fresh provider enumeration rejects a writer restarted between stop and migration checks', t => {
  const directory = fixture(t);
  const functions = ['market_provider_ids', 'stop_market_provider_writers', 'assert_market_provider_stopped'].map(definition).join('\n');
  const script = `${functions}
docker() {
  case "$1" in
    ps) printf '%s\\n' aaaaaaaaaaaa ;;
    stop) return 0 ;;
    inspect)
      if [[ -e "$MARKER" ]]; then printf 'true\\n'; else touch "$MARKER"; printf 'false\\n'; fi ;;
    *) return 91 ;;
  esac
}
timeout() { shift; "$@"; }
stop_market_provider_writers || exit 10
assert_market_provider_stopped || exit 11
`;
  const result = spawnSync('bash', ['-c', script], { env: { ...process.env, WORKBENCH_PROJECT: 'synthetic-price-project', MARKER: join(directory, 'first-inspect') }, encoding: 'utf8' });
  assert.equal(result.status, 11, result.stderr);
});
