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
if (Buffer.byteLength(path.join(temporaryRoot, 'ac-123456/tsx-123456/1234567890.pipe')) > 100) throw new Error('EXTERNAL_TEMPORARY_ROOT_TOO_LONG');
const python = process.env.WORKBENCH_TEST_PYTHON;
if (!python || !path.isAbsolute(python) || !existsSync(python)) throw new Error('EXPLICIT_TEST_PYTHON_REQUIRED');
const output = path.join(root, 'artifacts/verification/investor-acquisition', new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-'));
mkdirSync(output, { recursive: true, mode: 0o700 });
function sources() {
  const result = {};
  function walk(relative) {
    const filename = path.join(root, relative), stat = lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error('ACQUISITION_SOURCE_SYMLINK');
    if (stat.isDirectory()) {
      for (const child of readdirSync(filename).sort()) if (!['__pycache__', 'node_modules'].includes(child)) walk(path.join(relative, child));
    } else if (stat.isFile() && /\.(?:ts|tsx|js|mjs|py|sql|json|ya?ml)$/.test(relative)) {
      if (stat.size > 4 * 1024 * 1024) throw new Error('ACQUISITION_SOURCE_TOO_LARGE');
      result[relative] = createHash('sha256').update(readFileSync(filename)).digest('hex');
    }
  }
  for (const folder of ['web/src', 'web/scripts', 'web/tests', 'worker', 'scripts', 'contracts', 'migrations', 'tests']) walk(folder);
  for (const filename of ['web/package.json', 'web/package-lock.json', 'web/tsconfig.json', 'requirements-workbench.txt']) walk(filename);
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}
const before = sources(), temporary = mkdtempSync(path.join(temporaryRoot, 'ac-')), stages = [];
writeFileSync(path.join(output, 'source-before.json'), JSON.stringify(before, null, 2) + '\n', { mode: 0o600 });
const env = { ...process.env, TMPDIR: temporary, TSX_DISABLE_CACHE: '1', PYTHONDONTWRITEBYTECODE: '1', NODE_OPTIONS: '', WORKBENCH_TEST_PYTHON: python };
function fence() { if (JSON.stringify(sources()) !== JSON.stringify(before)) throw new Error('ACQUISITION_SOURCES_CHANGED'); }
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
  if (!passed) throw new Error('ACQUISITION_STAGE_FAILED:' + name);
}
let failure = null, migrations = 0;
try {
  const manifest = JSON.parse(readFileSync(path.join(root, 'migrations/manifest.json'), 'utf8'));
  for (const entry of manifest.migrations) {
    if (before['migrations/' + entry.file] !== entry.sha256) throw new Error('ACQUISITION_MIGRATION_CHECKSUM_CHANGED');
    migrations++;
  }
  for (const name of ['evaluation-worker', 'csv-background', 'governance-fixture', 'funded-comparison', 'ai-explanation'])
    run('build-' + name, process.execPath, ['--max-old-space-size=256', 'scripts/build-' + name + '.mjs'], path.join(root, 'web'));
  for (const name of ['investor-acquisition', 'investor-display-clock', 'investor-client', 'investor-workspace'])
    run('web-' + name, process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'tests/' + name + '.test.ts'], path.join(root, 'web'));
  run('initial-price-specialties', python, ['-m', 'unittest', 'tests.investor.test_initial_prices'], root);
  run('prepared-history-regression', python, ['-m', 'unittest', 'tests.investor.test_prepared_prices', 'tests.investor.test_history_collection'], root);
  run('monitor-bootstrap-specialties', python, ['-m', 'unittest', 'tests.investor.test_monitor_bootstrap'], root);
  run('confirmed-feed-specialties', python, ['-m', 'unittest', 'tests.investor.test_confirmed_feed'], root);
  run('orchestration-regression', python, ['-m', 'unittest', 'discover', '-s', 'tests/orchestration', '-t', '.'], root);
  run('confirmed-monitor-specialties', python, ['-m', 'unittest', 'tests.investor.test_confirmed_monitor'], root);
  run('confirmed-capture-specialties', python, ['-m', 'unittest', 'tests.investor.test_confirmed_capture'], root);
  run('confirmed-receiver-specialties', python, ['-m', 'unittest', 'tests.market.test_longport_confirmed'], root);
  run('market-regression-including-receiver', python, ['-m', 'unittest', 'discover', '-s', 'tests/market', '-t', '.'], root);
  run('source-monitor-and-cli-regression', python, ['-m', 'unittest', ...['data_evidence', 'source_inputs', 'monitor_data', 'monitor_admission',
    'evidence_monitor_runtime', 'source_retention', 'data_pipeline'].map(name => 'tests.investor.test_' + name)], root);
  run('core-and-funded-regression', python, ['-m', 'unittest', ...['runtime', 'funded_study_runtime', 'funded_result_retention'].map(name => 'tests.investor.test_' + name)], root);
  for (const name of ['investor-initial-prices', 'investor-monitor-bootstrap', 'investor-confirmed-monitor', 'investor-confirmed-source', 'investor-monitor-source', 'investor-model-watch',
    'investor-fixed-monitor-publication', 'investor-fixed-policy-monitor', 'investor-ai-explanation'])
    run('web-' + name, process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
      'tests/' + name + '.test.ts'], path.join(root, 'web'));
  run('migration-regression', process.execPath, ['--max-old-space-size=128', '--test', '--test-reporter=tap', '--test-concurrency=1',
    ...readdirSync(path.join(root, 'tests/migrations')).filter(name => name.endsWith('.test.mjs')).sort().map(name => 'tests/migrations/' + name)], root);
  run('recovery-and-release-regression', process.execPath, ['--max-old-space-size=128', '--test', '--test-reporter=tap', '--test-concurrency=1',
    'tests/recovery/backup-restore.test.mjs', 'tests/deployment/release.test.mjs'], root);
} catch (error) {
  failure = error instanceof Error && /^ACQUISITION_[A-Z_]+(?::[a-z-]+)?$/.test(error.message) ? error.message : 'ACQUISITION_VERIFICATION_FAILED';
} finally {
  let after = null;
  try { after = sources(); writeFileSync(path.join(output, 'source-after.json'), JSON.stringify(after, null, 2) + '\n', { mode: 0o600 }); }
  catch { failure ??= 'ACQUISITION_SOURCE_UNAVAILABLE'; }
  const unchanged = JSON.stringify(after) === JSON.stringify(before);
  try { rmSync(temporary, { recursive: true, force: true }); }
  catch { failure ??= 'ACQUISITION_CLEANUP_FAILED'; }
  const result = { schema_version: 'investor-acquisition-verification-v1',
    status: !failure && unchanged ? 'SCOPED_ACQUISITION_ACTIVITY_PASS_NOT_RELEASE' : 'SCOPED_ACQUISITION_ACTIVITY_VERIFICATION_FAILED',
    recorded_at: new Date().toISOString(), node_version: process.version, source_files: Object.keys(before).length, sources_unchanged: unchanged, stages, failure,
    migration_checksums_verified: migrations, migration_tests_executed: stages.some(stage => stage.name === 'migration-regression'), temporary_fixture_removed: !existsSync(temporary),
    real_market_or_gateway_calls: 0, production_changed: false, full_typecheck_executed: false, next_production_build_executed: false,
    live_authenticated_http_executed: false, native_browser_executed: false,
    limitations: ['Acquisition activity validates recorded task metadata only, not worker liveness, source qualification or prices.',
      'Only recorded windows are displayed; missing registration does not predict the next trading day.',
      'Offline expiry and semantic rendering use deterministic hook/SSR harnesses, not styled native-browser acceptance.',
      'Display milliseconds conservatively round starts upward and deadlines downward; task authority remains microsecond-precise.',
      'Invented data, source reviews, calendars and stubbed transports; no real quotes or provider rights certification.',
      'Initial monitoring prices require a selected reconstructed research model with still-current original authorities; not first research universe acquisition.',
      'Only complete past local days are acquired; same-day post-close requests wait, not callback recovery or historical fallback.',
      'The historical endpoint keeps its 30-second transport bound and has no in-flight heartbeat or prompt stop callback; lease checks fence commit.',
      'First-source data uses, calendar, corporate actions and FX must already be reviewed. No grant creation, authority migration or automatic rebase.',
      'One SDK attempt per immutable initial request; failed or lease-dead requests do not automatically resend or recover bytes.',
      'Core bootstrap requires every target, actions and FX, and never invents costs, funding, cash or risk answers.',
      'Unknown costs with triggered changes remain blocked without checkpoints; positive frozen fictional tolerances test checkpoint publication separately.',
      'Confirmed means the pinned SDK local engine, not exchange signoff, wire capture or uninterrupted streaming.',
      'Initial provider/core/Node receipt flow uses fictional CN models; three-market live acquisition and continuous operation are not accepted.',
      'Research snapshots remain historical-only; monitor snapshots cannot certify investment or live-advice eligibility.',
      'AI consent and fictional external_ai grants never authorize real provider data or gateway traffic.',
      'Existing retention, model expiry and 1000-item limits still need explicit reviewed restarts; no ten-year unattended acceptance.',
      'Logical SQLite deletion is not WAL, backup or physical erasure acceptance.',
      'Receiver specialty tests are included in market regression and must not be counted twice.',
      'Local synthetic restore and SQLite upgrades are not independent-machine production restoration acceptance.',
      'No full v2, real ETF qualification, Linux Node 22, full typecheck/Next build, native UI, performance or production release acceptance.'] };
  writeFileSync(path.join(output, 'verification-summary.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: result.status, evidence: path.relative(root, output), sources_unchanged: unchanged, failure }) + '\n');
  if (failure || !unchanged) process.exitCode = 1;
}
