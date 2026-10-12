import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url))), args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--temporary-root' || !path.isAbsolute(args[1])) throw new Error('EXTERNAL_TEMPORARY_ROOT_REQUIRED');
const temporaryRoot = realpathSync(args[1]), stat = lstatSync(temporaryRoot);
if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()
  || temporaryRoot === root || temporaryRoot.startsWith(root + path.sep)) throw new Error('PRIVATE_EXTERNAL_TEMPORARY_ROOT_REQUIRED');
if (Buffer.byteLength(path.join(temporaryRoot, 'ec-123456/tsx-123456/1234567890.pipe')) > 100) throw new Error('EXTERNAL_TEMPORARY_ROOT_TOO_LONG');
const python = process.env.WORKBENCH_TEST_PYTHON;
if (!python || !path.isAbsolute(python) || !existsSync(python)) throw new Error('EXPLICIT_TEST_PYTHON_REQUIRED');
const output = path.join(root, 'artifacts/verification/longport-confirmed-receiver', new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-'));
mkdirSync(output, { recursive: true, mode: 0o700 });
function sources() {
  const result = {};
  function walk(relative) {
    const filename = path.join(root, relative), stat = lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error('CONFIRMED_SOURCE_SYMLINK');
    if (stat.isDirectory()) {
      for (const child of readdirSync(filename).sort()) if (!['__pycache__', 'node_modules'].includes(child)) walk(path.join(relative, child));
    } else if (stat.isFile() && /\.(?:ts|tsx|js|mjs|py|sql|json|ya?ml)$/.test(relative)) {
      if (stat.size > 4 * 1024 * 1024) throw new Error('CONFIRMED_SOURCE_TOO_LARGE');
      result[relative] = createHash('sha256').update(readFileSync(filename)).digest('hex');
    }
  }
  for (const folder of ['web/src', 'web/scripts', 'web/tests', 'worker', 'scripts', 'contracts', 'migrations', 'tests']) walk(folder);
  for (const filename of ['web/package.json', 'web/package-lock.json', 'web/tsconfig.json', 'requirements-workbench.txt']) walk(filename);
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}
const before = sources(), temporary = mkdtempSync(path.join(temporaryRoot, 'ec-')), stages = [];
writeFileSync(path.join(output, 'source-before.json'), JSON.stringify(before, null, 2) + '\n', { mode: 0o600 });
const env = { ...process.env, TMPDIR: temporary, TSX_DISABLE_CACHE: '1', PYTHONDONTWRITEBYTECODE: '1', NODE_OPTIONS: '', WORKBENCH_TEST_PYTHON: python };
function fence() { if (JSON.stringify(sources()) !== JSON.stringify(before)) throw new Error('CONFIRMED_SOURCES_CHANGED'); }
function run(name, command, arguments_, cwd, timeout = 300000) {
  fence(); const logfile = path.join(output, name + '.log'), fd = openSync(logfile, 'wx', 0o600), start = Date.now();
  let child;
  try {
    child = spawnSync(command, arguments_, { cwd, env, timeout, detached: true, stdio: ['ignore', fd, fd], killSignal: 'SIGKILL' });
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } finally { closeSync(fd); }
  const text = readFileSync(logfile, 'utf8'), tests = text.match(/^# tests (\d+)$/m) ?? text.match(/^Ran (\d+) tests? in /m);
  const passed = child.status === 0 && !child.error;
  stages.push({ name, passed, exit_code: child.status, signal: child.signal, timed_out: child.error?.code === 'ETIMEDOUT', elapsed_ms: Date.now() - start,
    ...(tests ? { tests: Number(tests[1]) } : {}), logfile: path.relative(root, logfile) });
  process.stdout.write(JSON.stringify(stages.at(-1)) + '\n'); fence();
  if (!passed) throw new Error('CONFIRMED_STAGE_FAILED:' + name);
}
let failure = null, migrations = 0;
try {
  const manifest = JSON.parse(readFileSync(path.join(root, 'migrations/manifest.json'), 'utf8'));
  for (const entry of manifest.migrations) {
    if (before['migrations/' + entry.file] !== entry.sha256) throw new Error('CONFIRMED_MIGRATION_CHECKSUM_CHANGED');
    migrations++;
  }
  for (const name of ['evaluation-worker', 'csv-background', 'governance-fixture', 'funded-comparison', 'ai-explanation'])
    run('build-' + name, process.execPath, ['--max-old-space-size=256', 'scripts/build-' + name + '.mjs'], path.join(root, 'web'));
  run('confirmed-receiver-specialties', python, ['-m', 'unittest', 'tests.market.test_longport_confirmed'], root);
  run('market-regression-including-specialties', python, ['-m', 'unittest', 'discover', '-s', 'tests/market', '-t', '.'], root);
  run('source-and-monitor-regression', python, ['-m', 'unittest', ...['data_evidence', 'source_inputs', 'monitor_data', 'monitor_admission',
    'evidence_monitor_runtime', 'source_retention'].map(name => 'tests.investor.test_' + name)], root);
  run('core-and-funded-regression', python, ['-m', 'unittest', ...['runtime', 'funded_study_runtime', 'funded_result_retention'].map(name => 'tests.investor.test_' + name)], root);
  for (const name of ['investor-monitor-source', 'investor-model-watch', 'investor-fixed-monitor-publication', 'investor-fixed-policy-monitor'])
    run('web-' + name, process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
      'tests/' + name + '.test.ts'], path.join(root, 'web'));
} catch (error) {
  failure = error instanceof Error && /^CONFIRMED_[A-Z_]+(?::[a-z-]+)?$/.test(error.message) ? error.message : 'CONFIRMED_VERIFICATION_FAILED';
} finally {
  let after = null;
  try { after = sources(); writeFileSync(path.join(output, 'source-after.json'), JSON.stringify(after, null, 2) + '\n', { mode: 0o600 }); }
  catch { failure ??= 'CONFIRMED_SOURCE_UNAVAILABLE'; }
  const unchanged = JSON.stringify(after) === JSON.stringify(before);
  try { rmSync(temporary, { recursive: true, force: true }); }
  catch { failure ??= 'CONFIRMED_CLEANUP_FAILED'; }
  const result = { schema_version: 'longport-confirmed-receiver-verification-v1',
    status: !failure && unchanged ? 'SCOPED_CONFIRMED_RECEIVER_PASS_NOT_RELEASE' : 'SCOPED_CONFIRMED_RECEIVER_VERIFICATION_FAILED',
    recorded_at: new Date().toISOString(), node_version: process.version, source_files: Object.keys(before).length, sources_unchanged: unchanged, stages, failure,
    migration_checksums_verified: migrations, migration_tests_executed: false, temporary_fixture_removed: !existsSync(temporary),
    real_market_or_gateway_calls: 0, production_changed: false, full_typecheck_executed: false, next_production_build_executed: false,
    live_authenticated_http_executed: false, native_browser_executed: false,
    limitations: ['Fictional SDK callbacks/credentials/transports. Offline installed SDK inspection does not connect to the provider.',
      'Confirmed means the pinned SDK local engine, not an exchange signoff, wire capture or proof of uninterrupted streaming.',
      'Receiver only: no source-rights/owner-bound before-after-I/O persistence, Node admission, scheduler or default-core integration.',
      'Subscription history snapshots are ignored. No retrospective fallback fills missed confirmed events.',
      'Logical SQLite retention regression is not WAL, backup or physical erasure acceptance.',
      'Specialty test count is included in market regression and must not be added twice.',
      'No full v2, real ETF qualification, Linux Node 22, native UI, performance, restoration or production release acceptance.'] };
  writeFileSync(path.join(output, 'verification-summary.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: result.status, evidence: path.relative(root, output), sources_unchanged: unchanged, failure }) + '\n');
  if (failure || !unchanged) process.exitCode = 1;
}
