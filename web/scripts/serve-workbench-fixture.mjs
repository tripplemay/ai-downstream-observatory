import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateWorkbench } from '../../scripts/migrate-workbench.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help')) {
  process.stdout.write('Usage: node web/scripts/serve-workbench-fixture.mjs [--production] [--with-worker] [--with-verifier]\nSynthetic-only loopback server on port 3147. --production requires web/.next-fixture-production and uses a temporary self-signed HTTPS certificate.\n');
  process.exit(0);
}
if (flags.some(flag => !['--production', '--with-worker', '--with-verifier'].includes(flag))) {
  process.stderr.write('UNKNOWN_FIXTURE_ARGUMENT\n'); process.exit(2);
}
const production = flags.includes('--production');
if (production && !existsSync(path.join(web, '.next-fixture-production/BUILD_ID'))) {
  process.stderr.write('FIXTURE_PRODUCTION_BUILD_REQUIRED\n'); process.exit(2);
}
const directory = mkdtempSync(path.join(tmpdir(), 'etf-browser-fixture-'));
const password = 'SYNTHETIC-ETF-FIXTURE-ONLY-2026';
const salt = randomBytes(16);
const hash = `scrypt$32768$8$1$${salt.toString('base64url')}$${scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url')}`;
const filename = path.join(directory, 'workbench.db');
let child;
let proxy;
let proxyClosed = true;
const children = new Set();
let stopped = false;
let stopping = false;
let killTimer;
function cleanup() {
  if (stopped || children.size || !proxyClosed) return;
  stopped = true;
  clearTimeout(killTimer);
  rmSync(directory, { recursive: true, force: true });
}
function signalChild(process_, signal) {
  if (!process_.pid) return;
  try {
    if (process.platform === 'win32') process_.kill(signal);
    else process.kill(-process_.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
}
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  if (proxy) proxy.close(() => { proxyClosed = true; cleanup(); });
  for (const process_ of children) signalChild(process_, signal);
  killTimer = setTimeout(() => { for (const process_ of children) signalChild(process_, 'SIGKILL'); }, 5000);
  killTimer.unref();
  cleanup();
}
function track(process_) {
  children.add(process_);
  process_.once('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
  process_.once('close', code => {
    children.delete(process_);
    if (!stopping) { process.exitCode = code ?? 1; stop(); }
    cleanup();
  });
  return process_;
}
try {
  migrateWorkbench(filename);
  let port = 3147;
  if (production) {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const key = path.join(directory, 'fixture-tls.key'), cert = path.join(directory, 'fixture-tls.crt');
    const issued = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', key, '-out', cert], { encoding: 'utf8' });
    if (issued.error || issued.status !== 0) throw new Error('FIXTURE_TLS_GENERATION_FAILED');
    chmodSync(key, 0o600); chmodSync(cert, 0o600);
    proxy = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
      const upstream = http.request({ hostname: '127.0.0.1', port, path: request.url, method: request.method,
        headers: { ...request.headers, host: '127.0.0.1:3147', 'x-forwarded-host': '127.0.0.1:3147', 'x-forwarded-proto': 'https' } }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
      });
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(503); response.end('FIXTURE_UPSTREAM_UNAVAILABLE'); });
      request.on('aborted', () => upstream.destroy()); response.on('close', () => upstream.destroy());
      request.pipe(upstream);
    });
    proxyClosed = false;
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(3147, '127.0.0.1', resolve); });
  }
  child = track(spawn(process.execPath, ['node_modules/next/dist/bin/next', production ? 'start' : 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: web,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      NODE_ENV: production ? 'production' : 'development', NEXT_TELEMETRY_DISABLED: '1',
      WORKBENCH_DIST_DIR: production ? '.next-fixture-production' : '.next-fixture',
      WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: path.join(directory, 'auth'),
      WORKBENCH_PASSWORD_HASH: hash, WORKBENCH_SESSION_SECRET: randomBytes(48).toString('base64url'),
      WORKBENCH_ORIGIN: `${production ? 'https' : 'http'}://127.0.0.1:3147`, DB_PATH: path.join(directory, 'legacy-test-only.db'),
    }, stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32',
  }));
  for (const [flag, role] of [['--with-worker', 'core'], ['--with-verifier', 'verifier']]) {
    if (!process.argv.includes(flag)) continue;
    track(spawn(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-m', 'worker.orchestration', '--db', filename, '--poll-seconds', '0.2', '--role', role], {
      cwd: path.dirname(web), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') },
      stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32',
    }));
  }
  process.stdout.write(`Synthetic-only fixture: ${production ? 'https' : 'http'}://127.0.0.1:3147/workbench\n`);
  process.stdout.write(`Fixture password: ${password}\n`);
  process.stdout.write(`Synthetic fixture directory: ${directory}\n`);
  process.stdout.write('Empty migrated database; no production credentials or user accounts. Stop with Ctrl-C to remove temporary data.\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(signal));
} catch (error) { console.error(error.message); process.exitCode = 1; stop(); }
