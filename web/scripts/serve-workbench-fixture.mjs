import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateWorkbench } from '../../scripts/migrate-workbench.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(path.join(tmpdir(), 'etf-browser-fixture-'));
const password = 'SYNTHETIC-ETF-FIXTURE-ONLY-2026';
const salt = randomBytes(16);
const hash = `scrypt$32768$8$1$${salt.toString('base64url')}$${scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url')}`;
const filename = path.join(directory, 'workbench.db');
let child;
const children = new Set();
let stopped = false;
let stopping = false;
let killTimer;
function cleanup() {
  if (stopped || children.size) return;
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
  child = track(spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3147'], {
    cwd: web,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
      WORKBENCH_DIST_DIR: '.next-fixture',
      WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: path.join(directory, 'auth'),
      WORKBENCH_PASSWORD_HASH: hash, WORKBENCH_SESSION_SECRET: randomBytes(48).toString('base64url'),
      WORKBENCH_ORIGIN: 'http://127.0.0.1:3147', DB_PATH: path.join(directory, 'legacy-test-only.db'),
    }, stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32',
  }));
  for (const [flag, role] of [['--with-worker', 'core'], ['--with-verifier', 'verifier']]) {
    if (!process.argv.includes(flag)) continue;
    track(spawn(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-m', 'worker.orchestration', '--db', filename, '--poll-seconds', '0.2', '--role', role], {
      cwd: path.dirname(web), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') },
      stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform !== 'win32',
    }));
  }
  process.stdout.write('Synthetic-only fixture: http://127.0.0.1:3147/workbench\n');
  process.stdout.write(`Fixture password: ${password}\n`);
  process.stdout.write(`Synthetic fixture directory: ${directory}\n`);
  process.stdout.write('Empty migrated database; no production credentials or user accounts. Stop with Ctrl-C to remove temporary data.\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(signal));
} catch (error) { console.error(error.message); process.exitCode = 1; stop(); }
