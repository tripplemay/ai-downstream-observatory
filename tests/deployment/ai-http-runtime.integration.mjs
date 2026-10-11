import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiSourceFiles } from '../../scripts/ai-explanation-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'web/package.json'));
const host = process.env.DOCKER_HOST;
assert.match(host ?? '', /^unix:\/\/\/.*\/etf-ai-runtime\/docker\.sock$/);
assert.ok(process.env.DOCKER_CONFIG?.includes('etf-ai-colima-'));
const started = new Date().toISOString(), suffix = randomBytes(5).toString('hex');
const output = path.join(root, 'artifacts/verification/ai-http-runtime', started.replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true, mode: 0o700 });
const support = path.join(output, 'support'); mkdirSync(support, { mode: 0o700 });
const dir = '/tmp/etf-investor-synthetic-ai-http-runtime', db = `${dir}/workbench.db`;
const network = `etf-ai-runtime-${suffix}`, volume = `${network}-data`, trust = `${network}-trust`;
const aiImage = `etf-ai-runtime:${suffix}`, webImage = `etf-ai-web:${suffix}`;
const init = `${network}-init`, gateway = `${network}-gateway`, web = `${network}-web`;
const containers = new Set(), volumes = new Set(); let networkCreated = false;
const report = { status: 'RUNNING', started_at: started, cases: [], source_sha256: {}, images: {},
  real_gateway_calls: 0, real_market_calls: 0, production_changed: false, fixture: 'invented current-clock CN evidence and internal HTTPS peer',
  limitations: ['Functional Linux arm64 HTTP/worker/HTTPS integration only; not load or full-v2 acceptance.',
    'Invented source permissions do not certify provider licensing, retention, ETF eligibility or profitability.',
    'Fixture CA is trusted only in these disposable test containers; production TLS verification is unchanged.',
    'No native browser, public proxy, real gateway, real market data, cross-host restore or production deployment tested.'] };
const sha = value => createHash('sha256').update(value).digest('hex');
function sourceMap() {
  const map = aiSourceFiles(root);
  function scan(relative) {
    for (const item of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (item.name === '__pycache__') continue;
      const name = `${relative}/${item.name}`;
      if (item.isDirectory()) scan(name);
      else if (item.isFile() && /\.(ts|tsx|py|json|mjs|sh)$/.test(item.name)) map[name] = sha(readFileSync(path.join(root, name)));
    }
  }
  for (const folder of ['web/src', 'web/scripts', 'tests', 'scripts']) scan(folder);
  for (const name of ['Dockerfile.web', 'Dockerfile.ai-explanation', '.dockerignore', 'web/next.config.ts', 'web/tailwind.config.ts'])
    map[name] = sha(readFileSync(path.join(root, name)));
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
}
function command(binary, args, timeout = 120000) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 1048576 });
  if (result.status !== 0) {
    writeFileSync(path.join(output, `command-failure-${randomBytes(4).toString('hex')}.txt`), (result.stderr ?? '').slice(0, 65536), { mode: 0o600, flag: 'wx' });
    throw new Error(`FIXTURE_COMMAND_FAILED:${binary}:${args[0]}:${result.status ?? result.error?.code}`);
  }
  return result.stdout.trim();
}
const docker = args => command('docker', ['--host', host, ...args]);
async function build(image, filename, logname) {
  const fd = openSync(path.join(output, logname), 'wx', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('docker', ['--host', host, 'build', '--force-rm', '--build-arg', 'RELEASE_SHA=synthetic-runtime-fixture', '-f', filename, '-t', image, '.'],
        { cwd: root, stdio: ['ignore', fd, fd] });
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('FIXTURE_BUILD_TIMEOUT')); }, 1800000);
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`FIXTURE_BUILD_FAILED:${filename}:${code}`)); });
    });
  } finally { closeSync(fd); }
}
const env = ['-e', `WORKBENCH_DB_PATH=${db}`, '-e', `WORKBENCH_DATA_DIR=${dir}`, '-e', `WORKBENCH_AI_CONFIG_FILE=${dir}/ai.json`,
  '-e', `WORKBENCH_AI_CONSENT_FILE=${dir}/consent.json`];
const volumeArgs = ['-v', `${volume}:${dir}`];
const locked = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=96', '--memory=1g', '--cpus=1',
  '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001', '--user', '10001:10001'];
function helper(mode, now) {
  return JSON.parse(docker(['run', '--rm', '--network', 'none', ...locked, ...volumeArgs, ...env, aiImage, 'node', `${dir}/support/bridge.mjs`, mode, ...(now ? [now] : [])]));
}
function python(module, args) {
  return JSON.parse(docker(['run', '--rm', '--network', 'none', ...locked, ...volumeArgs, ...env, '-e', `PYTHONPATH=${dir}/support:/app`, '-w', '/app',
    aiImage, '/opt/workbench-ai/bin/python', '-m', module, '--db', db, ...args]));
}
const fixedWorker = (dispatch, extra = []) => docker(['run', '--rm', '--network', network, ...locked, ...volumeArgs, ...env,
  '-v', `${trust}:/etc/ssl/certs:ro`, '-e', `WORKBENCH_AI_ENABLE_DISPATCH=${dispatch ? '1' : '0'}`, aiImage,
  'node', 'scripts/run-ai-explanation.mjs', ...extra]);
async function check(id, operation) {
  try { const evidence = await operation(); report.cases.push({ id, status: 'PASS', evidence }); process.stdout.write(`PASS ${id}\n`); }
  catch (error) { report.cases.push({ id, status: 'FAIL', code: error instanceof Error ? error.message.slice(0, 250) : 'UNKNOWN' }); throw error; }
}
let address, cookie = '', binding;
const origin = 'https://workbench.example.test';
async function request(route, method = 'GET', body) {
  const response = await fetch(address + route, { method, redirect: 'manual', signal: AbortSignal.timeout(45000),
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(binding ? { 'X-Workbench-Session-Binding': binding } : {}),
      ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await response.text(); let json = null; try { json = JSON.parse(raw); } catch { /* Login redirects contain no JSON. */ }
  return { status: response.status, json };
}
async function login(password) {
  const response = await fetch(address + '/api/auth/login', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });
  assert.equal(response.status, 303); const header = response.headers.get('set-cookie');
  assert.match(header, /Secure/); assert.match(header, /HttpOnly/); cookie = header.split(';')[0];
  const session = await request('/api/auth/session'); assert.equal(session.status, 200); binding = session.json.session_binding;
}
try {
  report.source_sha256 = sourceMap();
  writeFileSync(path.join(output, 'source-before.json'), JSON.stringify(report.source_sha256, null, 2), { mode: 0o600, flag: 'wx' });
  await check('VM-STORAGE-PREFLIGHT', () => {
    const filesystem = statfsSync(path.dirname(host.slice('unix://'.length))), available = filesystem.bavail * filesystem.bsize;
    assert.ok(available >= 8 * 1024 ** 3, 'FIXTURE_VM_HOST_STORAGE_TOO_SMALL');
    const system = statfsSync(tmpdir()), systemAvailable = system.bavail * system.bsize;
    assert.ok(systemAvailable >= 8 * 1024 ** 3, 'FIXTURE_SYSTEM_STORAGE_TOO_SMALL');
    return { vm_host_available_bytes: available, system_available_bytes: systemAvailable, minimum_bytes_each: 8 * 1024 ** 3 };
  });
  await check('LINUX-IMAGES', async () => {
    await build(aiImage, 'Dockerfile.ai-explanation', 'ai-build.log');
    await build(webImage, 'Dockerfile.web', 'web-build.log');
    for (const image of [aiImage, webImage]) report.images[image] = JSON.parse(docker(['image', 'inspect', image, '--format', '{{json .}}']));
    for (const image of Object.values(report.images)) {
      assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'arm64'); assert.equal(image.Config.User, '10001:10001');
    }
    return { built_images: 2, platform: 'linux/arm64', nonroot_uid: 10001 };
  });
  docker(['network', 'create', '--internal', network]);
  networkCreated = true;
  assert.equal(JSON.parse(docker(['network', 'inspect', network]))[0].Internal, true);
  docker(['volume', 'create', volume]); volumes.add(volume);
  docker(['volume', 'create', trust]); volumes.add(trust);
  await require('esbuild').build({ absWorkingDir: root, entryPoints: ['tests/deployment/ai-http-runtime-bridge.ts'], outfile: path.join(support, 'bridge.mjs'),
    bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['better-sqlite3'],
    banner: { js: "import {createRequire as fixtureRequire} from 'node:module'; const require=fixtureRequire('/app/web/package.json');" } });
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(support, 'gateway.key'), '-out', path.join(support, 'gateway.pem'),
    '-days', '1', '-subj', '/CN=ai-gateway', '-addext', 'subjectAltName=DNS:ai-gateway']);
  copyFileSync(path.join(root, 'tests/deployment/ai-http-runtime-gateway.py'), path.join(support, 'gateway.py'));
  function copyPython(from, to) {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const item of readdirSync(from, { withFileTypes: true })) {
      if (item.name === '__pycache__') continue;
      if (item.isDirectory()) copyPython(path.join(from, item.name), path.join(to, item.name));
      else if (item.isFile() && item.name.endsWith('.py')) copyFileSync(path.join(from, item.name), path.join(to, item.name));
    }
  }
  copyPython(path.join(root, 'tests'), path.join(support, 'tests'));
  docker(['run', '-d', '--name', init, '--network', 'none', '--user', '0:0', ...volumeArgs, '-v', `${trust}:/fixture-certs`, ...env,
    aiImage, 'sleep', '600']);
  containers.add(init);
  docker(['cp', support, `${init}:${dir}/support`]);
  docker(['exec', init, 'cp', '-a', '/etc/ssl/certs/.', '/fixture-certs/']);
  docker(['exec', init, 'node', `${dir}/support/bridge.mjs`, 'init']);
  docker(['exec', init, 'chown', '-R', '10001:10001', dir]);
  docker(['run', '--rm', '--network', 'none', '--user', '0:0', ...volumeArgs, ...env, webImage,
    'node', '/app/scripts/migrate-workbench.mjs', '--db', db]);
  docker(['exec', init, 'chown', '-R', '10001:10001', dir]);
  docker(['rm', '-f', init]);
  containers.delete(init);
  const now = new Date(Date.now() - 60000).toISOString();
  await check('QUALIFIED-FICTIONAL-MONITOR', () => {
    helper('profile', now);
    python('tests.investor.evidence_fixture', ['--now', now, '--fixed-policy-v2', '--external-ai']);
    python('tests.investor.queue_fixture', ['--mode', 'core', '--now', now]);
    helper('save', now);
    python('tests.investor.live_monitor_fixture', ['--now', new Date().toISOString(), '--external-ai']);
    return { source: 'fictional', real_provider_called: false, finance_rows: 0 };
  });
  docker(['run', '-d', '--name', gateway, '--network', network, '--network-alias', 'ai-gateway', ...locked, ...volumeArgs,
    '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0', aiImage, '/opt/workbench-ai/bin/python', `${dir}/support/gateway.py`]);
  containers.add(gateway);
  const password = randomBytes(24).toString('base64url'), salt = randomBytes(16);
  const encoded = `scrypt$32768$8$1$${salt.toString('base64url')}$${scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 67108864 }).toString('base64url')}`;
  const authEnv = path.join(output, 'fictional-auth.env');
  writeFileSync(authEnv, `WORKBENCH_PASSWORD_HASH=${encoded}\nWORKBENCH_SESSION_SECRET=${randomBytes(48).toString('base64url')}\nWORKBENCH_ORIGIN=${origin}\n`, { mode: 0o600, flag: 'wx' });
  docker(['run', '-d', '--name', web, '--network', network, ...locked, ...volumeArgs, ...env, '--env-file', authEnv,
    '-e', 'WORKBENCH_AI_BACKGROUND_ENABLED=1', '-p', '127.0.0.1::3000', webImage]);
  containers.add(web);
  address = 'http://' + docker(['port', web, '3000/tcp']).trim();
  for (let n = 0; n < 60; n++) {
    try { if ((await request('/login')).status === 200) break; } catch { /* Wait for this fixture server only. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await login(password);
  const route = '/api/workbench/investor/ai-explanation', before = helper('inspect');
  let ready, intent;
  await check('HTTP-EXPLICIT-QUEUE', async () => {
    ready = await request(route); assert.equal(ready.status, 200); assert.equal(ready.json.status, 'available');
    intent = { observation_id: ready.json.observation_id, binding_hash: ready.json.binding_hash };
    const result = await request(route, 'POST', intent); assert.equal(result.status, 202); assert.equal(result.json.status, 'queued');
    assert.equal((await request(route)).json.status, 'queued');
    const queued = helper('inspect'); assert.equal(queued.counts.investor_ai_requests, 1); assert.equal(queued.counts.investor_ai_dispatches, 0);
    assert.equal(queued.protected_hash, before.protected_hash); return { http: 202, intents: 1, dispatches: 0 };
  });
  await check('LOGOUT-INDEPENDENT-FIXED-WORKER', async () => {
    assert.equal((await request('/api/auth/logout', 'POST')).status, 303); cookie = ''; binding = null;
    assert.equal((await request(route)).status, 401);
    fixedWorker(true, ['--once']);
    const current = helper('inspect'); assert.equal(current.counts.investor_ai_dispatches, 1); assert.equal(current.counts.investor_ai_outcomes, 1);
    assert.equal(current.counts.investor_ai_payloads, 1); assert.equal(current.protected_hash, before.protected_hash);
    await login(password); const result = await request(route); assert.equal(result.status, 200); assert.equal(result.json.status, 'complete');
    assert.equal(result.json.narrative_verified, false); assert.equal(result.json.binding_hash, intent.binding_hash);
    const calls = docker(['run', '--rm', '--network', 'none', ...locked, ...volumeArgs, aiImage, 'node', '-e',
      `console.log(require('fs').readFileSync('${dir}/gateway-calls.jsonl','utf8'))`]).split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].context.evidence, result.json.review.facts);
    report.gateway_evidence = calls; return { actual_https_calls: 1, dispatches: 1, outcomes: 1, payloads: 1, logout_cancelled: false };
  });
  await check('NO-REDISPATCH-OR-FINANCE-MUTATION', async () => {
    const duplicate = await request(route, 'POST', intent); assert.equal(duplicate.status, 200); assert.equal(duplicate.json.status, 'complete');
    fixedWorker(true, ['--once']);
    const state = helper('inspect'); assert.equal(state.counts.investor_ai_dispatches, 1); assert.equal(state.protected_hash, before.protected_hash);
    const calls = docker(['run', '--rm', '--network', 'none', ...locked, ...volumeArgs, aiImage, 'node', '-e',
      `console.log(require('fs').readFileSync('${dir}/gateway-calls.jsonl','utf8').trim().split('\\n').length)`]);
    assert.equal(calls, '1'); return { https_calls: 1, finance: state.finance, protected_state_unchanged: true };
  });
  await check('COLD-CLEANUP-WITHOUT-WEB-READ', async () => {
    docker(['stop', web]); helper('withdraw', new Date().toISOString()); fixedWorker(false, ['--once']);
    const state = helper('inspect'); assert.equal(state.counts.investor_ai_payloads, 0); assert.equal(state.counts.investor_ai_purges, 1);
    assert.equal(state.counts.investor_ai_dispatches, 1); assert.equal(state.counts.investor_ai_outcomes, 1);
    assert.equal(state.protected_hash, before.protected_hash); return { payload_rows: 0, immutable_dispatch_and_outcome_rows: 1, secure_erasure_certified: false };
  });
  assert.deepEqual(sourceMap(), report.source_sha256);
  report.status = 'SCOPED_LINUX_HTTP_FIXED_RUNTIME_HTTPS_PASS_NOT_RELEASE';
} catch (error) {
  report.status = 'FAIL'; report.error = error instanceof Error ? error.message.slice(0, 250) : 'UNKNOWN';
  process.exitCode = 1;
} finally {
  for (const name of containers) {
    const result = spawnSync('docker', ['--host', host, 'logs', name], { encoding: 'utf8', maxBuffer: 1048576 });
    if (result.status === 0) writeFileSync(path.join(output, `${name}-log.txt`), result.stdout + result.stderr, { mode: 0o600, flag: 'wx' });
    spawnSync('docker', ['--host', host, 'rm', '-f', name], { encoding: 'utf8' });
  }
  for (const name of volumes) spawnSync('docker', ['--host', host, 'volume', 'rm', name], { encoding: 'utf8' });
  if (networkCreated) spawnSync('docker', ['--host', host, 'network', 'rm', network], { encoding: 'utf8' });
  rmSync(support, { recursive: true, force: true });
  rmSync(path.join(output, 'fictional-auth.env'), { force: true });
  for (const [name, image] of Object.entries(report.images)) report.images[name] = { id: image.Id, os: image.Os, architecture: image.Architecture,
    user: image.Config.User, revision: image.Config.Labels['org.opencontainers.image.revision'] };
  report.completed_at = new Date().toISOString();
  report.source_unchanged = JSON.stringify(sourceMap()) === JSON.stringify(report.source_sha256);
  writeFileSync(path.join(output, 'verification-summary.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: report.status, evidence: path.relative(root, output), error: report.error ?? null }) + '\n');
}
