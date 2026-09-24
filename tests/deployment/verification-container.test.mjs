import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => readFileSync(join(root, name), 'utf8');

test('both container builds preserve the same complete verifier source inventory and fixed bundle location', () => {
  for (const name of ['Dockerfile', 'Dockerfile.web']) {
    const source = read(name);
    for (const directory of ['accounting', 'market', 'orchestration', 'performance', 'research', 'governance_verification'])
      assert.match(source, new RegExp(`COPY worker/${directory}/ `), `${name}: worker/${directory}`);
    for (const value of ['requirements-workbench.txt', 'web/package.json', 'web/package-lock.json', 'web/tsconfig.json',
      'governance-fixture.mjs', 'governance-fixture.manifest.json', 'verification-source.mjs', 'migrate-workbench.mjs',
      'build:verification-worker', 'build-verification-smoke.mjs', 'verification-container-bridge.mjs']) assert.ok(source.includes(value), `${name}: ${value}`);
    assert.match(source, /^USER 10001:10001$/m);
    assert.doesNotMatch(source, /LONGPORT_|requirements-market-longport|COPY .*\.env/);
  }
  const worker = read('Dockerfile'), web = read('Dockerfile.web');
  assert.match(worker, /governance-fixture\.manifest\.json \.\/web\/dist\//);
  assert.match(worker, /COPY --from=evaluation-builder \/build\/web\/src\/server\/ \.\/web\/src\/server\//);
  assert.match(worker, /better-sqlite3\/ \.\/web\/node_modules\/better-sqlite3\//);
  assert.match(web, /\/app\/web\/src\/server\/ \.\/src\/server\//);
  assert.match(web, /governance-fixture\.manifest\.json \.\/dist\//);
  assert.match(web, /\/app\/worker\/ \/app\/worker\//);
});

test('Compose verifier is a credential-free no-network role with no personal or recurring default plan', t => {
  const directory = mkdtempSync(join(tmpdir(), 'verification-compose-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = join(directory, 'runtime.env'); writeFileSync(runtime, 'SYNTHETIC_WEB_ONLY=not-a-secret\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WORKBENCH_|COMPOSE_|LONGPORT_)/u.test(key)));
  Object.assign(env, { WORKBENCH_RUNTIME_ENV_FILE: runtime, WORKBENCH_DATA_DIR_HOST: join(directory, 'not-created'), WORKBENCH_RELEASE_SHA: 'synthetic-verifier' });
  const configured = spawnSync('docker', ['compose', '--env-file', '/dev/null', '-p', 'synthetic-verifier', '-f', join(root, 'docker-compose.yml'),
    'config', '--no-env-resolution', '--format', 'json'], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  if (configured.error?.code === 'ENOENT') return t.skip('Compose CLI absent; real container CI remains required');
  assert.equal(configured.status, 0, configured.stderr);
  const service = JSON.parse(configured.stdout).services.verifier;
  assert.equal(service.image, 'etf-workbench-worker:synthetic-verifier');
  assert.deepEqual(service.command, ['python', '-m', 'worker.orchestration', '--role', 'verifier']);
  assert.equal(service.network_mode, 'none'); assert.equal(service.networks, undefined); assert.equal(service.ports, undefined);
  assert.equal(service.env_file, undefined); assert.equal(service.user, '10001:10001'); assert.equal(service.read_only, true);
  assert.ok(service.cap_drop.includes('ALL')); assert.ok(service.security_opt.includes('no-new-privileges:true'));
  assert.equal(service.volumes.length, 1); assert.equal(service.volumes[0].target, '/app/data');
  assert.ok([undefined, false].includes(service.volumes[0].bind?.create_host_path));
  assert.deepEqual(Object.keys(service.environment).sort(), ['WORKBENCH_DATA_DIR', 'WORKBENCH_DB_PATH', 'WORKBENCH_MODE']);
  assert.doesNotMatch(read('docker-compose.yml'), /LONGPORT_|schedule|portfolio_id|verification_request/);
});

test('container smoke performs normal TS request, dedicated real runner and independently rechecked TS proof before reporting', () => {
  const probe = read('tests/deployment/verification-runtime-smoke.py'), bridge = read('tests/deployment/verification-container-bridge.ts');
  assert.match(probe, /source = source_manifest\(\)/); assert.match(probe, /web == expected_web/);
  assert.match(probe, /socket\.if_nameindex\(\)/); assert.match(probe, /key\.startswith\("LONGPORT_"\)/);
  assert.match(probe, /subprocess\.run\(\[\*bridge, "request", str\(path\)\]/);
  assert.match(probe, /subprocess\.run\(\[\*argv, "verifier"\]/);
  assert.match(probe, /subprocess\.run\(\[\*bridge, "read", str\(path\)\]/);
  assert.match(probe, /result = check_bytes\(bytes\(artifact\["body"\]\), artifact\["body_sha256"\]\)/);
  assert.doesNotMatch(probe, /INSERT INTO verification_|INSERT INTO command_requests|unittest\.mock|mock\.patch/);
  for (const operation of ['currentVerificationSource(sourceRoot)', 'requestVerification(db, actor, input', 'getVerificationState(db, {},', 'readVerificationArtifact(db,'])
    assert.ok(bridge.includes(operation), operation);
  const shell = read('tests/deployment/container-smoke.sh');
  assert.match(shell, /--entrypoint node "\$web_image" \/app\/web\/dist\/verification-container-bridge\.mjs source/);
  assert.match(shell, /--entrypoint python verifier \/fixture-smoke\.py "\$web_verification_source"/);
  assert.match(shell, /up -d --no-build --wait --wait-timeout 90 web worker verifier/);
  const ci = read('.github/workflows/ci.yml');
  assert.ok(ci.indexOf('run: npm run build:verification-worker') < ci.indexOf('run: python -m unittest discover'));
  assert.match(ci, /run: sudo --preserve-env=PATH bash tests\/deployment\/container-smoke\.sh/);
  const parsed = spawnSync(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'],
    { input: probe, encoding: 'utf8', timeout: 10000 });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test('deployment discovers only known previous writers and safely handles both v20 and verifier-enabled Compose', t => {
  const directory = mkdtempSync(join(tmpdir(), 'verification-stop-writers-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const deploy = read('scripts/deploy-workbench.sh');
  const definitions = ['writer_services', 'stop_writers', 'assert_stopped'].map(name => {
    const value = deploy.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'm'))?.[0];
    assert.ok(value, name); return value;
  }).join('\n');
  const script = `${definitions}
fake() {
  case "$1" in
    config) printf '%s\\n' "$SERVICES"; return "\${CONFIG_STATUS:-0}" ;;
    stop) printf '%s\\n' "$*" >> "$TRACE" ;;
    ps) printf '%s\\n' "$*" >> "$TRACE"; printf '%s\\n' "$IDS" ;;
    *) return 91 ;;
  esac
}
docker() { [[ "$1" == inspect ]] || return 92; if [[ "$2" == "\${RUNNING_ID:-}" ]]; then printf 'true\\n'; else printf 'false\\n'; fi; }
stop_writers fake || exit 10
assert_stopped fake || exit 11
`;
  for (const verifier of [false, true]) {
    const trace = join(directory, verifier ? 'v21.log' : 'v20.log');
    const services = ['web', 'worker', ...(verifier ? ['verifier'] : []), 'migrate', 'backup', 'restore', 'archive-legacy'];
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, SERVICES: services.join('\n'), IDS: ['web-id', 'worker-id', ...(verifier ? ['verifier-id'] : [])].join('\n'), TRACE: trace }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const suffix = verifier ? ' verifier' : '';
    assert.equal(readFileSync(trace, 'utf8'), `stop web worker${suffix}\nps --all --quiet web worker${suffix}\n`);
  }
  for (const extra of [{ SERVICES: 'web\nworker\nunknown-writer' }, { SERVICES: 'web' }, { CONFIG_STATUS: '1' }]) {
    const trace = join(directory, `rejected-${Object.keys(extra)[0]}-${Object.values(extra)[0].length}.log`);
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, SERVICES: 'web\nworker\nverifier', IDS: 'web-id\nworker-id\nverifier-id', TRACE: trace, ...extra }, encoding: 'utf8' });
    assert.equal(result.status, 10); assert.throws(() => readFileSync(trace), /ENOENT/);
  }
  const running = spawnSync('bash', ['-c', script], { env: { ...process.env, SERVICES: 'web\nworker\nverifier', IDS: 'web-id\nworker-id\nverifier-id', RUNNING_ID: 'verifier-id', TRACE: join(directory, 'running.log') }, encoding: 'utf8' });
  assert.equal(running.status, 11, 'migration cannot continue while the old verifier remains running');
  assert.match(deploy, /compose stop web worker verifier >\/dev\/null/);
  assert.match(deploy, /up -d --no-build --wait --wait-timeout 150 web worker verifier/);
  assert.match(deploy, /compose exec -T verifier python -c/);
  assert.match(deploy, /"\$previous_sha" stop_writers docker compose/);
});
