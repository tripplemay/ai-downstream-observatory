import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url))), args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--temporary-root' || !path.isAbsolute(args[1])) throw new Error('EXTERNAL_TEMPORARY_ROOT_REQUIRED');
const temporaryRoot = realpathSync(args[1]), metadata = lstatSync(temporaryRoot);
if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700 || metadata.uid !== process.getuid()
  || temporaryRoot === root || temporaryRoot.startsWith(root + path.sep)) throw new Error('PRIVATE_EXTERNAL_TEMPORARY_ROOT_REQUIRED');
if (Buffer.byteLength(path.join(temporaryRoot, 'pf-123456/tsx-123456/1234567890.pipe')) > 100) throw new Error('EXTERNAL_TEMPORARY_ROOT_TOO_LONG');
const python = process.env.WORKBENCH_TEST_PYTHON;
if (!python || !path.isAbsolute(python) || !existsSync(python)) throw new Error('EXPLICIT_TEST_PYTHON_REQUIRED');
const output = path.join(root, 'artifacts/verification/planned-funding-monitor', new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-'));
mkdirSync(output, { recursive: true, mode: 0o700 });
function sources() {
  const result = {};
  function scan(relative) {
    const filename = path.join(root, relative), stat = lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error('PLANNED_FUNDING_SOURCE_SYMLINK');
    if (stat.isDirectory()) {
      for (const child of readdirSync(filename).sort()) if (!['__pycache__', 'node_modules'].includes(child)) scan(path.join(relative, child));
    } else if (stat.isFile() && /\.(?:ts|tsx|js|mjs|py|sql|json|ya?ml)$/.test(relative)) {
      if (stat.size > 4 * 1024 * 1024) throw new Error('PLANNED_FUNDING_SOURCE_TOO_LARGE');
      result[relative] = createHash('sha256').update(readFileSync(filename)).digest('hex');
    }
  }
  for (const folder of ['web/src', 'web/scripts', 'web/tests', 'worker', 'scripts', 'contracts', 'migrations', 'tests']) scan(folder);
  for (const filename of ['web/package.json', 'web/package-lock.json', 'web/tsconfig.json', 'requirements-workbench.txt']) scan(filename);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
const before = sources(), temporary = mkdtempSync(path.join(temporaryRoot, 'pf-')), stages = [];
writeFileSync(path.join(output, 'source-before.json'), JSON.stringify(before, null, 2) + '\n', { mode: 0o600 });
const env = { ...process.env, TMPDIR: temporary, TSX_DISABLE_CACHE: '1', PYTHONDONTWRITEBYTECODE: '1', NODE_OPTIONS: '', WORKBENCH_TEST_PYTHON: python };
const fence = () => { if (JSON.stringify(sources()) !== JSON.stringify(before)) throw new Error('PLANNED_FUNDING_SOURCES_CHANGED'); };
function run(name, command, arguments_, cwd, timeout = 300000) {
  fence();
  const system = statfsSync(path.parse(root).root), available = system.bavail * system.bsize;
  if (available < 2 * 1024 ** 3) throw new Error('PLANNED_FUNDING_RESOURCE_STOP');
  const logfile = path.join(output, name + '.log'), fd = openSync(logfile, 'wx', 0o600), started = Date.now();
  let child;
  try {
    child = spawnSync(command, arguments_, { cwd, env, timeout, detached: true, stdio: ['ignore', fd, fd], killSignal: 'SIGKILL' });
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } finally { closeSync(fd); }
  const log = readFileSync(logfile, 'utf8'), count = log.match(/^# tests (\d+)$/m) ?? log.match(/^Ran (\d+) tests? in /m);
  const passed = child.status === 0 && !child.error;
  stages.push({ name, passed, child_pid: child.pid, exit_code: child.status, signal: child.signal, timed_out: child.error?.code === 'ETIMEDOUT', elapsed_ms: Date.now() - started,
    system_disk_available_before_bytes: available,
    ...(count ? { tests: Number(count[1]) } : {}), logfile: path.relative(root, logfile) });
  process.stdout.write(JSON.stringify(stages.at(-1)) + '\n'); fence();
  if (!passed) throw new Error('PLANNED_FUNDING_STAGE_FAILED:' + name);
}
let failure = null, migrationChecksums = 0;
try {
  for (const entry of JSON.parse(readFileSync(path.join(root, 'migrations/manifest.json'), 'utf8')).migrations) {
    if (before['migrations/' + entry.file] !== entry.sha256) throw new Error('PLANNED_FUNDING_MIGRATION_CHANGED');
    migrationChecksums++;
  }
  for (const name of ['evaluation-worker', 'csv-background', 'governance-fixture', 'funded-comparison', 'ai-explanation'])
    run('build-' + name, process.execPath, ['--max-old-space-size=256', 'scripts/build-' + name + '.mjs'], path.join(root, 'web'));
  run('python-planned-funding', python, ['-m', 'unittest', 'tests.investor.test_funding_plan', 'tests.investor.test_planned_funding_monitor'], root);
  for (const name of ['investor-planned-funding-monitor', 'investor-planned-funding-source', 'investor-funding'])
    run('web-' + name, process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'tests/' + name + '.test.ts'], path.join(root, 'web'));
  for (const name of ['planned_funding_runtime', 'evidence_monitor_runtime', 'fixed_monitor_runtime', 'policy_monitor', 'funded_study_runtime', 'funded_result_retention'])
    run('python-' + name.replaceAll('_', '-'), python, ['-m', 'unittest', 'tests.investor.test_' + name], root);
  for (const name of ['investor-planned-funding-publication', 'investor-planned-funding-ai', 'investor-model-watch', 'investor-fixed-monitor-publication', 'investor-fixed-policy-monitor', 'investor-funded-study', 'investor-ai-explanation'])
    run('web-' + name, process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'tests/' + name + '.test.ts'], path.join(root, 'web'));
  for (const name of ['investor-display-clock', 'investor-current-display', 'investor-ai-panel', 'investor-workspace-display', 'investor-economic-panels-display', 'investor-risk', 'investor-funded-comparison', 'investor-acquisition', 'investor-client', 'investor-evidence-research'])
    run('web-' + name, process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1', 'tests/' + name + '.test.ts'], path.join(root, 'web'));
  run('migration-regression', process.execPath, ['--max-old-space-size=128', '--test', '--test-reporter=tap', '--test-concurrency=1',
    ...readdirSync(path.join(root, 'tests/migrations')).filter(name => name.endsWith('.test.mjs')).sort().map(name => 'tests/migrations/' + name)], root);
  run('recovery-and-release-regression', process.execPath, ['--max-old-space-size=128', '--test', '--test-reporter=tap', '--test-concurrency=1',
    'tests/recovery/backup-restore.test.mjs', 'tests/deployment/release.test.mjs'], root);
} catch (error) {
  failure = error instanceof Error && /^PLANNED_FUNDING_[A-Z_]+(?::[a-z-]+)?$/.test(error.message) ? error.message : 'PLANNED_FUNDING_VERIFICATION_FAILED';
} finally {
  let after = null;
  try { after = sources(); writeFileSync(path.join(output, 'source-after.json'), JSON.stringify(after, null, 2) + '\n', { mode: 0o600 }); }
  catch { failure ??= 'PLANNED_FUNDING_SOURCE_UNAVAILABLE'; }
  const unchanged = JSON.stringify(after) === JSON.stringify(before);
  try { rmSync(temporary, { recursive: true, force: true }); } catch { failure ??= 'PLANNED_FUNDING_CLEANUP_FAILED'; }
  const result = { schema_version: 'planned-funding-monitor-verification-v1',
    status: !failure && unchanged ? 'SCOPED_PLANNED_FUNDING_CORE_AI_DISPLAY_PASS_NOT_RELEASE' : 'SCOPED_PLANNED_FUNDING_CORE_AI_DISPLAY_FAILED',
    recorded_at: new Date().toISOString(), node_version: process.version, source_files: Object.keys(before).length, sources_unchanged: unchanged,
    stages, failure, migration_checksums_verified: migrationChecksums, temporary_fixture_removed: !existsSync(temporary), real_market_or_gateway_calls: 0,
    default_core_integration_executed: !failure && unchanged, planned_funding_ai_flow_executed: !failure && unchanged,
    display_expiry_event_harness_executed: !failure && unchanged,
    production_changed: false, full_typecheck_executed: false, next_production_build_executed: false,
    historical_private_plan_replay_executed: !failure && unchanged, stable_release_context_replay_executed: !failure && unchanged,
    live_authenticated_http_executed: false, native_browser_executed: false,
    limitations: ['Fictional saved-plan default core publication, archived checkpoint lineage, independent Node/current-state and strict-client replay; not a production or native UI acceptance.',
      'Invented owner plans, research sources, model controls, calendars and prices; no real ETF evidence, provider terms certification or private-plan modification.',
      'The later of model creation and plan declaration is the exact anchor. Earlier annual releases, including same-day past midnight, are excluded without backfill.',
      'Initial-entry tranches are excluded; normalization uses the plan initial capital denominator and fixed 10000 research units, not model cash or personal NAV.',
      'Due annual releases accumulate as an unexecuted hypothetical pool. User review decisions do not confirm, consume or execute deposits.',
      'The projection validity bounds only planned release changes and the plan horizon, not model expiry, quote freshness, source retention or provider rights.',
      'Pure supplied IDs and hashes do not prove authority; private readers additionally check current owner, profile, selected model, original research sources and saved-plan audit.',
      'Historical readers verify a specified saved plan/model/profile and exact command audit, not current market/source eligibility. Pause, newer plans or profiles do not rewrite old assumptions.',
      'Stable context hashes change at plan/model binding, release and horizon boundaries, not each poll. They are internal binding evidence, not a source or provider-use attestation.',
      'Pure funding projections remain unadmitted as market/AI inputs. Only the owner/audit-bound v2 request and v4 core path use them as unexecuted assessment context, with v3 checkpoint binding.',
      'Old contract and SQL bytes are immutable. Migration 45 only appends funding request/payload/run guards; manifest entries 1-44 retain their original checksums.',
      'Model/quote/source lifetime and all old ancestors remain independent gates; funding dates cannot extend them. A second raw funding intent is a conflict, never an added budget.',
      'Saved funding v4 observations pass independent Node/Python closed AI contexts and cold Node background lifecycle with fictional injected transports. No real gateway, fixed sidecar CLI, HTTPS, browser or authenticated HTTP acceptance.',
      'Queued release-boundary and plan-version changes purge old intents before dispatch; in-flight changes discard output; cold maintenance removes old payloads without browser reads. New observations require a fresh explicit AI request.',
      'AI maintains the deterministic decision even when its opinion differs. Original research and monitoring external-AI rights remain separate gates; plan IDs, dates and amounts never become AI evidence.',
      'Actual AI/workspace components and display clock run in deterministic hook/event harnesses: known expiry retires current conclusion/cards/review/NAV/AI, rollback does not revive them, GET failure does not promote old state, and server history is retained. Child panels/design-system/DOM/native layout are not fully exercised.',
      'Risk candidates, funded summaries and path analysis use the same conservative clock. Explicit GETs cannot revive expired results; scope/session changes suppress obsolete reads. Child chart/design-system/DOM/native integration still needs acceptance.',
      'The display clock advances from checked time using local wall and elapsed time, never certifies market freshness or replaces server-side authority. System disk is checked before every stage; there is no in-stage resource watchdog.',
      'No full v2, Linux Node 22, semantic typecheck/Next production build, authenticated HTTP/native UI, performance or deployment acceptance.'] };
  writeFileSync(path.join(output, 'verification-summary.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: result.status, evidence: path.relative(root, output), sources_unchanged: unchanged, failure }) + '\n');
  if (failure || !unchanged) process.exitCode = 1;
}
