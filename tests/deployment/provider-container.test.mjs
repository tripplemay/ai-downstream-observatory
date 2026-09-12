import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => readFileSync(join(root, path), 'utf8');
const python = process.env.WORKBENCH_TEST_PYTHON || process.env.WORKBENCH_PYTHON || 'python3';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const adapterHash = sha(readFileSync(join(root, 'worker/market/providers/longport.py')));
const imageId = `sha256:${'a'.repeat(64)}`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'provider-deployment-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('optional native provider image is hash-pinned Python 3.11 and contains neither Web configuration nor a Node publisher', () => {
  const docker = read('Dockerfile.market-provider');
  assert.match(docker, /^FROM python:3\.11-slim-trixie@sha256:[a-f0-9]{64}$/m);
  assert.match(docker, /pip install --no-cache-dir --no-deps --require-hashes -r requirements-market-longport\.txt/);
  assert.match(docker, /pip check/);
  assert.match(docker, /from worker\.market\.providers\.longport import _load_sdk; _load_sdk\(\)/);
  for (const directory of ['worker/accounting', 'worker/market', 'worker/orchestration', 'worker/performance', 'worker/research', 'contracts', 'migrations'])
    assert.ok(docker.includes(`COPY ${directory}/ ./${directory}/`), directory);
  assert.match(docker, /^USER 10001:10001$/m);
  assert.match(docker, /^CMD \["python", "-m", "worker.orchestration", "--role", "longport"\]$/m);
  assert.doesNotMatch(docker, /^COPY (?:\.|web|data|config|\.env|\.private)(?:\/|\s)|monthly-evaluation\.mjs|\/usr\/local\/bin\/node|nodejs|npm|WORKBENCH_PASSWORD_HASH|WORKBENCH_SESSION_SECRET/m);
  assert.doesNotMatch(read('Dockerfile'), /requirements-market-longport|--role", "longport/);
  assert.doesNotMatch(read('requirements-workbench.txt'), /^longport[=<>]/m);
  const requirement = read('requirements-market-longport.txt');
  assert.match(requirement, /^--only-binary=longport$/m);
  assert.match(requirement, /^longport==4\.3\.7 \\$/m);
  const hashes = [...requirement.matchAll(/--hash=sha256:([a-f0-9]{64})/g)].map(match => match[1]);
  // The approved CPython 3.11 wheel set, not an arbitrary four-hash allowlist.
  assert.deepEqual(hashes, [
    'a7fd58bc0e5f3e60c6e2e272d7b6ef473eaac282d7849b9a174bf09e2a10e75b',
    '2a32a21a63b91c0971e8f7e0544475e9f4fcc1d9b12de579946d2b5080082051',
    '57d0224ef769307b06af35136081825af2fcec646bd51fa7de7cfb5a47d6f12e',
    '5999c06273a77f1273042fc802a5342f1e9ea6aa11d19c99e65805c883a51152',
  ]);
  assert.doesNotMatch(requirement, /--extra-index-url|--index-url|--trusted-host|https?:\/\//);
});

test('provider Compose is an explicit isolated role with a separate required credential file and no new host path creation', t => {
  const source = read('docker-compose.market-provider.yml');
  assert.match(source, /profiles: \[market-provider\]/);
  assert.match(source, /env_file:\s*\n\s*- path: \$\{WORKBENCH_MARKET_PROVIDER_ENV_FILE[^\n]+\n\s*required: true\s*\n\s*format: raw/);
  assert.match(source, /bind:\s*\n\s*create_host_path: false/);
  assert.doesNotMatch(source, /WORKBENCH_RUNTIME_ENV_FILE|WORKBENCH_PASSWORD_HASH|WORKBENCH_SESSION_SECRET|ports:|docker\.sock|\.private|\/Users\//);
  const directory = fixture(t), runtime = join(directory, 'runtime.env'), provider = join(directory, 'provider.env');
  writeFileSync(runtime, 'SYNTHETIC_WEB_ONLY=not-a-secret\n', { mode: 0o600 });
  writeFileSync(provider, 'SYNTHETIC_PROVIDER_ONLY=not-a-secret\n', { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WORKBENCH_|COMPOSE_|LONGPORT_)/.test(key)));
  Object.assign(env, { WORKBENCH_RUNTIME_ENV_FILE: runtime, WORKBENCH_MARKET_PROVIDER_ENV_FILE: provider,
    WORKBENCH_DATA_DIR_HOST: join(directory, 'missing-data'), WORKBENCH_RELEASE_SHA: 'synthetic-provider', WORKBENCH_HTTP_PORT: '5051' });
  const result = spawnSync('docker', ['compose', '--env-file', '/dev/null', '-p', 'synthetic-provider-config', '--profile', 'market-provider',
    '-f', join(root, 'docker-compose.yml'), '-f', join(root, 'docker-compose.market-provider.yml'),
    'config', '--no-env-resolution', '--format', 'json'], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  if (result.error?.code === 'ENOENT') return t.skip('Compose CLI absent; actual container CI remains mandatory');
  assert.equal(result.status, 0, result.stderr);
  const service = JSON.parse(result.stdout).services['market-provider'];
  assert.equal(service.user, '10001:10001'); assert.equal(service.read_only, true); assert.equal(service.init, true);
  assert.ok(service.cap_drop.includes('ALL')); assert.ok(service.security_opt.includes('no-new-privileges:true'));
  assert.equal(service.ports, undefined); assert.equal(service.volumes.length, 1); assert.equal(service.volumes[0].target, '/app/data');
  assert.equal(service.volumes[0].source, join(directory, 'missing-data'));
  assert.ok([undefined, false].includes(service.volumes[0].bind?.create_host_path));
  if (service.env_file) {
    assert.equal(service.env_file.length, 1); assert.equal(service.env_file[0].path, provider);
    assert.equal(service.env_file[0].format, 'raw'); assert.ok([undefined, true].includes(service.env_file[0].required));
  } else assert.equal(service.environment.SYNTHETIC_PROVIDER_ONLY, 'not-a-secret');
  assert.equal(service.environment.SYNTHETIC_WEB_ONLY, undefined);
  assert.equal(service.environment.WORKBENCH_PASSWORD_HASH, undefined); assert.equal(service.environment.WORKBENCH_SESSION_SECRET, undefined);
  assert.equal(existsSync(join(directory, 'missing-data')), false);
});

test('real CLI rejects unconfigured SDK credentials or a short lease before even creating its database', t => {
  const directory = fixture(t), path = join(directory, 'must-not-exist.db');
  const env = { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' };
  for (const [extra, code, status] of [[[], 'LONGPORT_RUNTIME_NOT_CONFIGURED', 1], [['--lease-seconds', '179'], 'at least 180 seconds', 2]]) {
    const result = spawnSync(python, ['-m', 'worker.orchestration', '--role', 'longport', '--db', path, '--once', ...extra],
      { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, status, result.stderr); assert.ok(result.stderr.includes(code), result.stderr);
    assert.equal(result.stdout, ''); assert.equal(existsSync(path), false);
    assert.doesNotMatch(result.stderr, /app_secret|access_token|Traceback/);
  }
});

test('actual role, cross-connection mutex and child kernel deadline regression runs without provider credentials', () => {
  const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith('LONGPORT_')) delete env[key];
  const result = spawnSync(python, ['-m', 'unittest', 'tests.orchestration.test_provider_roles', 'tests.market.test_provider_deadline', '-v'],
    { cwd: root, env, encoding: 'utf8', timeout: 45000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 8 tests/); assert.match(result.stderr, /\nOK\s*$/);
});

test('each CLI preflight failure separately precedes database access and provider mutex spans portfolio scopes', () => {
  const code = `import contextlib,io,json,unittest
from unittest.mock import patch
from worker.orchestration import __main__ as cli
from worker.orchestration.db import WorkbenchError,open_database
from worker.orchestration.jobs import enqueue_job,claim_job
from tests.market.support import NOW,database
for sdk_error in (True,False):
    with patch('worker.market.providers.longport._load_sdk',side_effect=ValueError('synthetic private detail') if sdk_error else None) as sdk, patch('worker.market.providers.longport._credentials',side_effect=WorkbenchError('LONGPORT_CREDENTIALS_REQUIRED')) as credentials, patch.object(cli,'open_database',side_effect=AssertionError('DATABASE_OPENED')) as opened:
        output=io.StringIO()
        with contextlib.redirect_stderr(output):
            assert cli.main(['--role','longport','--db','/synthetic-unused.db','--once'])==1
        opened.assert_not_called()
        assert json.loads(output.getvalue())=={'error':'LONGPORT_RUNTIME_NOT_CONFIGURED'}
        assert credentials.call_count==(0 if sdk_error else 1)
test=unittest.TestCase()
try:
    db,path=database(test)
    for scope in ('synthetic-p1','synthetic-p2'):
        enqueue_job(db,'market_collect_prices',scope,'synthetic','synthetic',now=NOW)
    other=open_database(path)
    try:
        assert claim_job(db,'first',180,'market_collect_prices',now=NOW) is not None
        assert claim_job(other,'second',180,'market_collect_prices',now=NOW) is None
    finally: other.close()
finally: test.doCleanups()
print('CLI_PREFLIGHT_AND_GLOBAL_SCOPE_MUTEX_PASSED')
`;
  const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith('LONGPORT_')) delete env[key];
  const result = spawnSync(python, ['-c', code], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'CLI_PREFLIGHT_AND_GLOBAL_SCOPE_MUTEX_PASSED');
});

test('native runtime CI executes without network or credentials and records only synthetic evidence', () => {
  const shell = read('tests/deployment/provider-container-smoke.sh'), probe = read('tests/deployment/provider-runtime-smoke.py');
  assert.match(shell, /release_sha=\$\(git rev-parse --verify HEAD\)/);
  assert.match(shell, /--build-arg "RELEASE_SHA=\$release_sha"/);
  assert.doesNotMatch(shell, /GITHUB_SHA/);
  assert.match(shell, /docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true/);
  assert.match(shell, /--entrypoint python "\$image" \/fixture-smoke\.py/);
  assert.doesNotMatch(shell, /--env-file|LONGPORT_APP|LONGPORT_ACCESS|--network host/);
  assert.match(probe, /sdk = longport\._load_sdk\(\)/);
  assert.match(probe, /inspect\.signature\(sdk\.QuoteContext\.history_candlesticks_by_date\)/);
  assert.match(probe, /sdk_binary = native_sdk_path\(sdk\)/);
  assert.match(probe, /hashlib\.sha256\(sdk_binary\.read_bytes\(\)\)/);
  assert.doesNotMatch(probe, /sdk\.__file__/);
  assert.doesNotMatch(probe, /sdk\.QuoteContext\(|\.history_candlesticks_by_date\(/);
  const syntax = spawnSync(python, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: probe, encoding: 'utf8', timeout: 10000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /run: bash tests\/deployment\/provider-container-smoke\.sh/);
  assert.match(ci, /path: artifacts\/verification\/container-\*\.json/);
  assert.ok(ci.indexOf('run: bash tests/deployment/provider-container-smoke.sh') < ci.lastIndexOf('name: preserve container evidence'));
});

function reportFixture(t) {
  const directory = fixture(t), bin = join(directory, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\n[ "$1 $2 $3" = "image inspect synthetic-image" ] || exit 91\nprintf '%s\\n' '${imageId}'\n`, { mode: 0o700 });
  const script = read('tests/deployment/provider-container-smoke.sh').match(/<<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
  assert.ok(script);
  const proof = { schema_version: 'provider-runtime-smoke-v1', status: 'passed', runtime_uid: 10001,
    python_version: '3.11.99', libc: ['glibc', '2.41'], sdk_version: '4.3.7', sdk_native_sha256: 'b'.repeat(64),
    adapter_sha256: adapterHash, native_sdk_imported: true, sdk_signature_checked: true, provider_role_isolated: true,
    fixed_child_rejected_untrusted_input: true, credentials_present: false, network_disabled: true,
    quote_context_constructed: false, real_market_data_verified: false };
  const path = join(directory, 'report.json');
  return { proof, path, run(value) {
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return spawnSync(process.execPath, ['-', path, 'synthetic-image', root],
      { input: script, cwd: root, env: { ...process.env, PATH: bin + ':' + process.env.PATH }, encoding: 'utf8', timeout: 10000 });
  } };
}

test('native SDK hashing follows the loaded extension rather than its fileless PyO3 submodule', () => {
  const code = `import ast,sys,tempfile,types
from pathlib import Path
from importlib.machinery import ExtensionFileLoader,SourceFileLoader,ModuleSpec
tree=ast.parse(sys.stdin.read())
function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='native_sdk_path')
with tempfile.TemporaryDirectory(prefix='synthetic-sdk-binary-') as directory:
    path=Path(directory)/'synthetic-extension.so';path.write_bytes(b'synthetic-native-bytes-not-a-real-sdk')
    alternate=Path(directory)/'alternate.so';alternate.write_bytes(b'synthetic-other')
    sdk=types.SimpleNamespace()
    loader=ExtensionFileLoader('longport.longport',str(path))
    native=types.SimpleNamespace(openapi=sdk,__loader__=loader,__file__=str(path),__spec__=ModuleSpec('longport.longport',loader,origin=str(path)))
    def imported(name):
        assert name=='longport.longport'
        return native
    namespace={'Path':Path,'ExtensionFileLoader':ExtensionFileLoader,'import_module':imported}
    exec(compile(ast.Module(body=[function],type_ignores=[]),'actual-smoke-helper','exec'),namespace)
    locate=namespace['native_sdk_path']
    assert not hasattr(sdk,'__file__') and locate(sdk)==path.resolve()
    assert locate(sdk).read_bytes()==b'synthetic-native-bytes-not-a-real-sdk'
    for key,value in [('openapi',object()),('__loader__',SourceFileLoader('fake',str(path))),('__file__',str(alternate))]:
        old=getattr(native,key);setattr(native,key,value)
        try:
            try: locate(sdk)
            except AssertionError: pass
            else: raise AssertionError('unrelated native identity accepted: '+key)
        finally: setattr(native,key,old)
print('FILELESS_SUBMODULE_NATIVE_BINDING_PASSED')
`;
  const result = spawnSync(python, ['-c', code], { input: read('tests/deployment/provider-runtime-smoke.py'), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'FILELESS_SUBMODULE_NATIVE_BINDING_PASSED');
});

test('actual provider report gate accepts complete native proof and the captured image identity', t => {
  const f = reportFixture(t), result = f.run(f.proof);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.path)), { ...f.proof, image_id: imageId });
});

test('actual provider report gate never treats missing checks or SDK/runtime/hash drift as PASS', t => {
  const f = reportFixture(t);
  for (const key of Object.keys(f.proof)) {
    const missing = { ...f.proof }; delete missing[key];
    assert.notEqual(f.run(missing).status, 0, `missing ${key}`);
  }
  for (const patch of [{ runtime_uid: 0 }, { runtime_uid: '10001' }, { python_version: '3.12.1' }, { libc: ['glibc', '2.36'] },
    { sdk_version: '4.3.8' }, { sdk_native_sha256: 'invalid' }, { adapter_sha256: 'c'.repeat(64) }, { credentials_present: true },
    { quote_context_constructed: true }, { real_market_data_verified: true }, { provider_role_isolated: false },
    { sdk_signature_checked: false }, { fixed_child_rejected_untrusted_input: false }, { native_sdk_imported: 'true' },
    { network_disabled: 1 }, { unknown: true }]) assert.notEqual(f.run({ ...f.proof, ...patch }).status, 0, JSON.stringify(patch));
});
