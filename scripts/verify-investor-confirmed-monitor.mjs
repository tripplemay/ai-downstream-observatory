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
if (Buffer.byteLength(path.join(temporaryRoot, 'cm-123456/tsx-123456/1234567890.pipe')) > 100) throw new Error('EXTERNAL_TEMPORARY_ROOT_TOO_LONG');
const python = process.env.WORKBENCH_TEST_PYTHON;
if (!python || !path.isAbsolute(python) || !existsSync(python)) throw new Error('EXPLICIT_TEST_PYTHON_REQUIRED');
const output = path.join(root, 'artifacts/verification/investor-confirmed-monitor', new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-'));
mkdirSync(output, { recursive: true, mode: 0o700 });
function sources() {
  const result = {};
  function walk(relative) {
    const filename = path.join(root, relative), stat = lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error('MONITOR_SOURCE_SYMLINK');
    if (stat.isDirectory()) {
      for (const child of readdirSync(filename).sort()) if (!['__pycache__', 'node_modules'].includes(child)) walk(path.join(relative, child));
    } else if (stat.isFile() && /\.(?:ts|tsx|js|mjs|py|sql|json|ya?ml)$/.test(relative)) {
      if (stat.size > 4 * 1024 * 1024) throw new Error('MONITOR_SOURCE_TOO_LARGE');
      result[relative] = createHash('sha256').update(readFileSync(filename)).digest('hex');
    }
  }
  for (const folder of ['web/src', 'web/scripts', 'web/tests', 'worker', 'scripts', 'contracts', 'migrations', 'tests']) walk(folder);
  for (const filename of ['web/package.json', 'web/package-lock.json', 'web/tsconfig.json', 'requirements-workbench.txt']) walk(filename);
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}
const before = sources(), temporary = mkdtempSync(path.join(temporaryRoot, 'cm-')), stages = [];
writeFileSync(path.join(output, 'source-before.json'), JSON.stringify(before, null, 2) + '\n', { mode: 0o600 });
const env = { ...process.env, TMPDIR: temporary, TSX_DISABLE_CACHE: '1', PYTHONDONTWRITEBYTECODE: '1', NODE_OPTIONS: '', WORKBENCH_TEST_PYTHON: python };
function fence() { if (JSON.stringify(sources()) !== JSON.stringify(before)) throw new Error('MONITOR_SOURCES_CHANGED'); }
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
  const log = readFileSync(logfile, 'utf8'), tests = log.match(/^# tests (\d+)$/m) ?? log.match(/^Ran (\d+) tests? in /m);
  const passed = child.status === 0 && !child.error;
  stages.push({ name, passed, exit_code: child.status, signal: child.signal, timed_out: child.error?.code === 'ETIMEDOUT', elapsed_ms: Date.now() - start,
    ...(tests ? { tests: Number(tests[1]) } : {}), logfile: path.relative(root, logfile) });
  process.stdout.write(JSON.stringify(stages.at(-1)) + '\n'); fence();
  if (!passed) throw new Error('MONITOR_STAGE_FAILED:' + name);
}
let failure = null, migrations = 0;
try {
  const manifest = JSON.parse(readFileSync(path.join(root, 'migrations/manifest.json'), 'utf8'));
  for (const entry of manifest.migrations) {
    if (before['migrations/' + entry.file] !== entry.sha256) throw new Error('MONITOR_MIGRATION_CHECKSUM_CHANGED');
    migrations++;
  }
  for (const name of ['evaluation-worker', 'csv-background', 'governance-fixture', 'funded-comparison', 'ai-explanation'])
    run('build-' + name, process.execPath, ['--max-old-space-size=256', 'scripts/build-' + name + '.mjs'], path.join(root, 'web'));
  run('confirmed-monitor-specialties', python, ['-m', 'unittest', 'tests.investor.test_confirmed_monitor'], root);
  run('confirmed-capture-specialties', python, ['-m', 'unittest', 'tests.investor.test_confirmed_capture'], root);
  run('confirmed-receiver-specialties', python, ['-m', 'unittest', 'tests.market.test_longport_confirmed'], root);
  run('market-regression-including-receiver', python, ['-m', 'unittest', 'discover', '-s', 'tests/market', '-t', '.'], root);
  run('source-monitor-and-cli-regression', python, ['-m', 'unittest', ...['data_evidence', 'source_inputs', 'monitor_data', 'monitor_admission',
    'evidence_monitor_runtime', 'source_retention', 'data_pipeline'].map(name => 'tests.investor.test_' + name)], root);
  run('core-and-funded-regression', python, ['-m', 'unittest', ...['runtime', 'funded_study_runtime', 'funded_result_retention'].map(name => 'tests.investor.test_' + name)], root);
  for (const name of ['investor-confirmed-monitor', 'investor-confirmed-source', 'investor-monitor-source', 'investor-model-watch',
    'investor-fixed-monitor-publication', 'investor-fixed-policy-monitor', 'investor-ai-explanation'])
    run('web-' + name, process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
      'tests/' + name + '.test.ts'], path.join(root, 'web'));
  run('migration-regression', process.execPath, ['--max-old-space-size=128', '--test', '--test-reporter=tap', '--test-concurrency=1',
    ...readdirSync(path.join(root, 'tests/migrations')).filter(name => name.endsWith('.test.mjs')).sort().map(name => 'tests/migrations/' + name)], root);
  run('recovery-and-release-regression', process.execPath, ['--max-old-space-size=128', '--test', '--test-reporter=tap', '--test-concurrency=1',
    'tests/recovery/backup-restore.test.mjs', 'tests/deployment/release.test.mjs'], root);
} catch (error) {
  failure = error instanceof Error && /^MONITOR_[A-Z_]+(?::[a-z-]+)?$/.test(error.message) ? error.message : 'MONITOR_VERIFICATION_FAILED';
} finally {
  let after = null;
  try { after = sources(); writeFileSync(path.join(output, 'source-after.json'), JSON.stringify(after, null, 2) + '\n', { mode: 0o600 }); }
  catch { failure ??= 'MONITOR_SOURCE_UNAVAILABLE'; }
  const unchanged = JSON.stringify(after) === JSON.stringify(before);
  try { rmSync(temporary, { recursive: true, force: true }); }
  catch { failure ??= 'MONITOR_CLEANUP_FAILED'; }
  const result = { schema_version: 'investor-confirmed-monitor-verification-v1',
    status: !failure && unchanged ? 'SCOPED_CONFIRMED_MONITOR_PASS_NOT_RELEASE' : 'SCOPED_CONFIRMED_MONITOR_VERIFICATION_FAILED',
    recorded_at: new Date().toISOString(), node_version: process.version, source_files: Object.keys(before).length, sources_unchanged: unchanged, stages, failure,
    migration_checksums_verified: migrations, migration_tests_executed: stages.some(stage => stage.name === 'migration-regression'), temporary_fixture_removed: !existsSync(temporary),
    real_market_or_gateway_calls: 0, production_changed: false, full_typecheck_executed: false, next_production_build_executed: false,
    live_authenticated_http_executed: false, native_browser_executed: false,
    limitations: ['Fictional callbacks, reviews and stubbed transports; no real quotes or data-use certification.',
      'Confirmed means the pinned SDK local engine, not exchange signoff, wire capture or uninterrupted streaming.',
      'Versioned private monitor admission/default core/independent Node replay only; no automatic around-close collection scheduler.',
      'Derived price sessions use reviewed calendars and assumed availability; raw callback receipts do not prove provider publication time.',
      'Research snapshots remain historical-only. New monitor snapshots cannot self-certify investment/live-advice eligibility.',
      'AI preparation checks all retained source grants; positive fictional grants never authorize real data or gateway calls.',
      'No actual financial facts or orders; default core may publish fictional research observations and checkpoints.',
      'Logical SQLite deletion is not WAL, backup or physical erasure acceptance.',
      'Receiver specialty tests are already included in market regression; do not count them twice.',
      'Local synthetic recovery/SQLite upgrades are not an independent-machine production restoration acceptance.',
      'No full v2, real ETF qualification, Linux Node 22, full typecheck/Next build, native UI, performance or production release acceptance.'] };
  writeFileSync(path.join(output, 'verification-summary.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: result.status, evidence: path.relative(root, output), sources_unchanged: unchanged, failure }) + '\n');
  if (failure || !unchanged) process.exitCode = 1;
}
