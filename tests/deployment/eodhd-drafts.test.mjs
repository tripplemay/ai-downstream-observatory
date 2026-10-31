import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const python = process.env.WORKBENCH_TEST_PYTHON ?? 'python3';

test('EODHD deploy flag is default off, requires isolated provider and an independent non-data credential path', t => {
  const directory = mkdtempSync(join(tmpdir(), 'eodhd-deploy-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'release.env'), sha = 'a'.repeat(40);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WORKBENCH_|COMPOSE_|EODHD_)/.test(key)));
  const plan = extra => {
    writeFileSync(config, `WORKBENCH_DEPLOY_ROOT=${directory}\nWORKBENCH_RUNTIME_ENV_FILE=${directory}/runtime.env\nWORKBENCH_BACKUP_KEY_FILE=${directory}/backup.passphrase\n${extra}`, { mode: 0o600 });
    return spawnSync('bash', [new URL('scripts/deploy-workbench.sh', root).pathname, '--release', sha,
      '--release-dir', `${directory}/releases/${sha}`, '--config', config], { encoding: 'utf8', env });
  };
  const disabled = plan(''); assert.equal(disabled.status, 0, disabled.stderr); assert.match(disabled.stdout, /EODHD drafts available: 0/);
  const provider = `WORKBENCH_MARKET_PROVIDER_ENABLED=1\nWORKBENCH_MARKET_PROVIDER_ENV_FILE=${directory}/provider.env\n`;
  for (const value of ['true', '2', '-1']) assert.notEqual(plan(`${provider}WORKBENCH_EODHD_ENABLED=${value}\n`).status, 0);
  assert.notEqual(plan(`WORKBENCH_EODHD_ENABLED=1\nWORKBENCH_EODHD_CREDENTIALS_FILE=${directory}/eodhd.env\n`).status, 0);
  assert.notEqual(plan(`${provider}WORKBENCH_EODHD_ENABLED=1\n`).status, 0);
  for (const path of ['runtime.env', 'backup.passphrase', 'provider.env', 'release.env', 'data-workbench/key.env', 'backups-workbench/key.env', 'restores-workbench/key.env', 'releases/key.env', '../eodhd.env'])
    assert.notEqual(plan(`${provider}WORKBENCH_EODHD_ENABLED=1\nWORKBENCH_EODHD_CREDENTIALS_FILE=${directory}/${path}\n`).status, 0, path);
  const enabled = plan(`${provider}WORKBENCH_EODHD_ENABLED=1\nWORKBENCH_EODHD_CREDENTIALS_FILE=${directory}/eodhd.env\n`);
  assert.equal(enabled.status, 0, enabled.stderr); assert.match(enabled.stdout, /EODHD drafts available: 1 \(not source authorization\)/);
  assert.doesNotMatch(enabled.stdout + enabled.stderr, /EODHD_API_TOKEN|eodhd\.env/);
});

test('real Compose grants only provider a readonly existing secret bind, never web, core, verifier or backups', t => {
  const directory = mkdtempSync(join(tmpdir(), 'eodhd-compose-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['runtime.env', 'provider.env', 'eodhd.env']) writeFileSync(join(directory, name), 'FICTIONAL_ONLY=not-a-secret\n', { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WORKBENCH_|COMPOSE_|EODHD_|LONGPORT_|LONGBRIDGE_)/.test(key)));
  Object.assign(env, { WORKBENCH_RUNTIME_ENV_FILE: join(directory, 'runtime.env'), WORKBENCH_MARKET_PROVIDER_ENV_FILE: join(directory, 'provider.env'),
    WORKBENCH_EODHD_CREDENTIALS_FILE: join(directory, 'eodhd.env'), WORKBENCH_DATA_DIR_HOST: join(directory, 'data') });
  const options = ['compose', '--env-file', '/dev/null', '--profile', 'market-provider'];
  for (const name of ['docker-compose.yml', 'docker-compose.market-provider.yml', 'docker-compose.eodhd-drafts.yml']) options.push('-f', new URL(name, root).pathname);
  const result = spawnSync('docker', [...options, 'config', '--no-env-resolution', '--format', 'json'], { env, encoding: 'utf8', timeout: 15000 });
  if (result.error?.code === 'ENOENT') return t.skip('Compose absent; real container CI still required');
  assert.equal(result.status, 0, result.stderr);
  for (const [name, service] of Object.entries(JSON.parse(result.stdout).services)) {
    const mounts = (service.volumes ?? []).filter(item => item.source === join(directory, 'eodhd.env'));
    assert.equal(mounts.length, name === 'market-provider' ? 1 : 0, name);
    assert.equal(service.environment?.EODHD_API_TOKEN, undefined);
    if (name === 'market-provider') {
      assert.equal(mounts[0].target, '/run/etf-workbench/eodhd.env'); assert.equal(mounts[0].read_only, true);
      assert.ok([undefined, false].includes(mounts[0].bind?.create_host_path));
      assert.equal(service.environment.WORKBENCH_EODHD_ENABLED, '1');
    } else assert.equal(service.environment?.EODHD_CREDENTIALS_FILE, undefined, name);
  }
});

test('actual startup rejects enabled malformed credentials before DB access and preflight never authorizes collection or calls network', () => {
  const result = spawnSync(python, ['-c', `
import contextlib,io,json,os,socket
from unittest.mock import patch
from worker.market.providers import eodhd_capture as c
from worker.orchestration import __main__ as cli
def forbidden(*a,**k):raise AssertionError('OFFLINE_NETWORK_FORBIDDEN')
socket.create_connection=forbidden;socket.getaddrinfo=forbidden
for flag in ('1','invalid'):
 with patch.dict(os.environ,{'WORKBENCH_EODHD_ENABLED':flag,'EODHD_CREDENTIALS_FILE':'/fictional/missing'}),patch('worker.market.providers.longport._load_sdk'),patch('worker.market.providers.longport._credentials'),patch.object(cli,'open_database') as opened:
  output=io.StringIO()
  with contextlib.redirect_stderr(output):assert cli.main(['--role','longport','--db','/fictional/unused.db','--once'])==1
  assert json.loads(output.getvalue())=={'error':'EODHD_CAPTURE_RUNTIME_NOT_CONFIGURED'}
  opened.assert_not_called()
with patch.dict(os.environ,{'WORKBENCH_EODHD_ENABLED':'0'}),patch.object(c,'read_private_token') as read:
 assert c.check_runtime_configuration()=={'available':False,'network_called':False,'collection_authorized':False}
 read.assert_not_called()
with patch.dict(os.environ,{'WORKBENCH_EODHD_ENABLED':'1'},clear=True),patch.object(c,'read_private_token',return_value='FICTIONAL-only-token') as read:
 assert c.check_runtime_configuration()=={'available':True,'network_called':False,'collection_authorized':False}
 assert read.call_count==1
with patch.dict(os.environ,{'WORKBENCH_EODHD_ENABLED':'1','EODHD_API_TOKEN':'FICTIONAL-never-environment'}),patch.object(c,'read_private_token') as read:
 try:c.check_runtime_configuration()
 except Exception as e:assert str(e)=='EODHD_CAPTURE_RUNTIME_NOT_CONFIGURED'
 else:raise AssertionError('environment secret accepted')
 read.assert_not_called()
print('OFFLINE_EODHD_PREFLIGHT_PASSED')
`], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'OFFLINE_EODHD_PREFLIGHT_PASSED');
  const deploy = read('scripts/deploy-workbench.sh');
  assert.match(deploy, /stat -c '%u:%a:%h'[\s\S]*?10001:600:1/);
  assert.ok(deploy.indexOf('eodhd-configuration.json') < deploy.indexOf('if ((first_release)); then'));
});

test('actual release credential guard rejects parent aliases, shared inodes and UID/mode/link drift without reading the secret', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'eodhd-path-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const privateDir = join(directory, 'private'); mkdirSync(privateDir);
  const credential = join(privateDir, 'eodhd.env'); writeFileSync(credential, 'FICTIONAL-DO-NOT-ECHO\n', { mode: 0o600 });
  symlinkSync(privateDir, join(directory, 'alias')); linkSync(credential, join(directory, 'shared.env'));
  const definition = read('scripts/deploy-workbench.sh').match(/^assert_eodhd_credentials\(\) \{\n[\s\S]*?^\}/m)?.[0]; assert.ok(definition);
  const body = `${definition}\nstat() { [[ "$1" == -c && "$2" == '%u:%a:%h' ]] || return 99; printf '%s\\n' "\${METADATA:-10001:600:1}"; }\nassert_eodhd_credentials\n`;
  const env = { PATH: process.env.PATH, WORKBENCH_EODHD_ENABLED: '1', WORKBENCH_EODHD_CREDENTIALS_FILE: credential,
    WORKBENCH_RUNTIME_ENV_FILE: join(directory, 'runtime.env'), WORKBENCH_BACKUP_KEY_FILE: join(directory, 'backup.key'),
    WORKBENCH_MARKET_PROVIDER_ENV_FILE: join(directory, 'provider.env'), config: join(directory, 'release.env') };
  const invoke = extra => spawnSync('bash', ['-c', body], { env: { ...env, ...extra }, encoding: 'utf8' });
  assert.equal(invoke({}).status, 0);
  for (const extra of [{ WORKBENCH_EODHD_CREDENTIALS_FILE: join(directory, 'alias', 'eodhd.env') },
    { WORKBENCH_RUNTIME_ENV_FILE: join(directory, 'shared.env') }, { METADATA: '0:600:1' }, { METADATA: '10001:640:1' }, { METADATA: '10001:600:2' }]) {
    const result = invoke(extra); assert.notEqual(result.status, 0, JSON.stringify(extra)); assert.doesNotMatch(result.stdout + result.stderr, /FICTIONAL-DO-NOT-ECHO/);
  }
  assert.equal(invoke({ WORKBENCH_EODHD_ENABLED: '0', WORKBENCH_EODHD_CREDENTIALS_FILE: '/fictional/missing' }).status, 0);
});
