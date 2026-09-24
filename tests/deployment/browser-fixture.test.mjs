import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = join(root, 'web/scripts/serve-workbench-fixture.mjs');
const output = join(root, 'artifacts/verification/browser-verification-v21');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function portAvailable() {
  const server = net.createServer();
  await new Promise((resolve_, reject) => { server.once('error', reject); server.listen(3147, '127.0.0.1', resolve_); });
  await new Promise((resolve_, reject) => server.close(error => error ? reject(error) : resolve_()));
}
function descendants(pid) {
  let children;
  try { children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/u).filter(Boolean).map(Number); }
  catch (error) { if (error.status === 1) return [pid]; throw error; }
  return [pid, ...children.flatMap(descendants)];
}
async function until(predicate, milliseconds, message) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(200); }
  throw new Error(message);
}

test('browser fixture keeps core and verifier independently selectable and waits for child close before cleanup', () => {
  const source = readFileSync(fixture, 'utf8');
  assert.match(source, /\['--with-worker', 'core'\]/u);
  assert.match(source, /\['--with-verifier', 'verifier'\]/u);
  assert.match(source, /'--role', role/u);
  assert.match(source, /process_\.once\('close'/u);
  assert.match(source, /if \(stopped \|\| children\.size\) return/u);
  assert.match(source, /process\.kill\(-process_\.pid, signal\)/u);
});

test('opt-in synthetic fixture lifecycle starts empty, stops every recorded process and releases its port and directory', {
  skip: process.env.WORKBENCH_BROWSER_FIXTURE_LIFECYCLE !== '1', timeout: 180000,
}, async t => {
  assert.notEqual(process.platform, 'win32', 'Lifecycle process-tree inspection requires POSIX tools');
  await portAvailable();
  const Database = createRequire(join(root, 'web/package.json'))('better-sqlite3');
  const child = spawn(process.execPath, [fixture, '--with-worker', '--with-verifier'], { cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      WORKBENCH_TEST_PYTHON: process.env.WORKBENCH_TEST_PYTHON || 'python3' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', ended = false;
  const exited = new Promise((resolve_, reject) => { child.once('error', reject); child.once('close', (code, signal) => { ended = true; resolve_({ code, signal }); }); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { log += value.toString(); });
  let directory, pids = [], processTree = '', outcome;
  const evidence = { scope: 'synthetic_fixture_lifecycle_only_not_native_browser_qa', launcher_pid: child.pid, started_at: new Date().toISOString() };
  t.after(async () => {
    if (!ended) { child.kill('SIGTERM'); await Promise.race([exited, delay(10000)]); }
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'fixture-lifecycle.log'), log);
    writeFileSync(join(output, 'fixture-lifecycle.json'), JSON.stringify({ ...evidence, directory, process_tree: processTree,
      recorded_pids: pids, launcher_exit: outcome, remaining_pids: pids.filter(alive), directory_removed: directory ? !existsSync(directory) : null,
      finished_at: new Date().toISOString() }, null, 2) + '\n');
  });
  await until(async () => {
    if (ended) throw new Error(`Fixture exited before readiness: ${log}`);
    directory = log.match(/^Synthetic fixture directory: (.+)$/mu)?.[1];
    if (!directory) return false;
    try { const response = await fetch('http://127.0.0.1:3147/api/auth/session', { signal: AbortSignal.timeout(2000), redirect: 'manual' }); return response.status === 401; }
    catch { return false; }
  }, 120000, 'Fixture did not expose authenticated HTTP boundary');
  evidence.http_status = 401;
  const db = new Database(join(directory, 'workbench.db'), { readonly: true, fileMustExist: true });
  try {
    evidence.empty_tables = Object.fromEntries(['portfolios', 'command_requests', 'verification_requests', 'verification_executions', 'verification_artifacts', 'job_runs']
      .map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
    for (const count of Object.values(evidence.empty_tables)) assert.equal(count, 0);
  } finally { db.close(); }
  pids = descendants(child.pid);
  processTree = execFileSync('ps', ['-p', pids.join(','), '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' });
  assert.match(processTree, /--role core/u); assert.match(processTree, /--role verifier/u); assert.match(processTree, /next-server/u);
  child.kill('SIGTERM'); outcome = await exited;
  assert.deepEqual(outcome, { code: 0, signal: null });
  await until(() => pids.every(pid => !alive(pid)), 10000, 'A recorded fixture process survived launcher shutdown');
  assert.equal(existsSync(directory), false);
  await portAvailable(); evidence.port_released = true; evidence.passed = true;
});
