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
let worker;
let stopped = false;
function cleanup() {
  if (stopped) return;
  stopped = true;
  rmSync(directory, { recursive: true, force: true });
}
try {
  migrateWorkbench(filename);
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3147'], {
    cwd: web,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
      WORKBENCH_DIST_DIR: '.next-fixture',
      WORKBENCH_DB_PATH: filename, WORKBENCH_DATA_DIR: path.join(directory, 'auth'),
      WORKBENCH_PASSWORD_HASH: hash, WORKBENCH_SESSION_SECRET: randomBytes(48).toString('base64url'),
      WORKBENCH_ORIGIN: 'http://127.0.0.1:3147', DB_PATH: path.join(directory, 'legacy-test-only.db'),
    }, stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (process.argv.includes('--with-worker')) {
    worker = spawn(process.env.WORKBENCH_TEST_PYTHON || 'python3', ['-m', 'worker.orchestration', '--db', filename, '--poll-seconds', '0.2'], {
      cwd: path.dirname(web), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, WORKBENCH_DATA_DIR: path.join(directory, 'auth') },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    worker.once('error', error => { console.error(error.message); child.kill('SIGTERM'); });
    worker.once('exit', () => { if (child.exitCode === null) child.kill('SIGTERM'); });
  }
  process.stdout.write('Synthetic-only fixture: http://127.0.0.1:3147/workbench\n');
  process.stdout.write(`Fixture password: ${password}\n`);
  process.stdout.write('Empty migrated database; no production credentials or user accounts. Stop with Ctrl-C to remove temporary data.\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { child.kill(signal); worker?.kill(signal); });
  child.once('error', error => { console.error(error.message); cleanup(); process.exitCode = 1; });
  child.once('exit', code => {
    process.exitCode = code ?? 0;
    if (worker?.pid && worker.exitCode === null && worker.signalCode === null) {
      worker.once('exit', cleanup); if (!worker.killed) worker.kill('SIGTERM');
    } else cleanup();
  });
} catch (error) { cleanup(); console.error(error.message); process.exitCode = 1; }
