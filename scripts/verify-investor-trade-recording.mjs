import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url))), args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--temporary-root' || !path.isAbsolute(args[1])) throw new Error('EXTERNAL_TEMPORARY_ROOT_REQUIRED');
const temporaryRoot = realpathSync(args[1]);
if (!lstatSync(temporaryRoot).isDirectory() || temporaryRoot === root || temporaryRoot.startsWith(root + path.sep)) throw new Error('EXTERNAL_TEMPORARY_ROOT_REQUIRED');
const python = process.env.WORKBENCH_TEST_PYTHON;
if (!python || !path.isAbsolute(python) || !existsSync(python)) throw new Error('EXPLICIT_TEST_PYTHON_REQUIRED');
const output = path.join(root, 'artifacts/verification/investor-trade-recording', new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-'));
mkdirSync(output, { recursive: true, mode: 0o700 });
function sources() {
  const result = {};
  function walk(relative) {
    const filename = path.join(root, relative), stat = lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error('TRADE_SOURCE_SYMLINK');
    if (stat.isDirectory()) {
      for (const child of readdirSync(filename).sort()) if (!['__pycache__', 'node_modules'].includes(child)) walk(path.join(relative, child));
    } else if (stat.isFile() && /\.(?:ts|tsx|js|mjs|py|sql|json|ya?ml)$/.test(relative)) {
      if (stat.size > 4 * 1024 * 1024) throw new Error('TRADE_SOURCE_TOO_LARGE');
      result[relative] = createHash('sha256').update(readFileSync(filename)).digest('hex');
    }
  }
  for (const folder of ['web/src', 'web/scripts', 'web/tests', 'worker', 'scripts', 'contracts', 'migrations', 'tests']) walk(folder);
  for (const filename of ['web/package.json', 'web/package-lock.json', 'web/tsconfig.json']) walk(filename);
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}
const before = sources(), temporary = mkdtempSync(path.join(temporaryRoot, 'etf-trade-validation-')), stages = [];
writeFileSync(path.join(output, 'source-before.json'), JSON.stringify(before, null, 2) + '\n', { mode: 0o600 });
const env = { ...process.env, TMPDIR: temporary, TSX_DISABLE_CACHE: '1', PYTHONDONTWRITEBYTECODE: '1', NODE_OPTIONS: '', WORKBENCH_TEST_PYTHON: python };
function fence() { if (JSON.stringify(sources()) !== JSON.stringify(before)) throw new Error('TRADE_SOURCES_CHANGED'); }
function run(name, command, arguments_, cwd, timeout = 180000) {
  fence(); const logfile = path.join(output, name + '.log'), fd = openSync(logfile, 'wx', 0o600), start = Date.now();
  let child;
  try { child = spawnSync(command, arguments_, { cwd, env, timeout, stdio: ['ignore', fd, fd], killSignal: 'SIGKILL' }); }
  finally { closeSync(fd); }
  const text = readFileSync(logfile, 'utf8'), tests = text.match(/^# tests (\d+)$/m) ?? text.match(/^Ran (\d+) tests? in /m);
  const passed = child.status === 0 && !child.error;
  stages.push({ name, passed, exit_code: child.status, signal: child.signal, timed_out: child.error?.code === 'ETIMEDOUT', elapsed_ms: Date.now() - start,
    ...(tests ? { tests: Number(tests[1]) } : {}), logfile: path.relative(root, logfile) });
  process.stdout.write(JSON.stringify(stages.at(-1)) + '\n'); fence();
  if (!passed) throw new Error('TRADE_STAGE_FAILED:' + name);
}
let failure = null;
try {
  for (const name of ['evaluation-worker', 'csv-background', 'governance-fixture', 'funded-comparison', 'ai-explanation'])
    run('build-' + name, process.execPath, ['--max-old-space-size=256', 'scripts/build-' + name + '.mjs'], path.join(root, 'web'));
  run('trade-specialties', process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
    ...['investor-trade-recording', 'investor-trade-recording-client', 'investor-trade-recording-route', 'investor-trade-recording-panel'].map(name => 'tests/' + name + '.test.ts')], path.join(root, 'web'));
  run('selected-web-regression', process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--test', '--test-reporter=tap', '--test-concurrency=1',
    ...['investor-accounts', 'investor-reconciliation', 'investor-holdings', 'investor-client', 'investor-workspace', 'ledger-engine', 'ledger-service',
      'ledger-imports', 'ledger-corrections', 'governance-commands', 'session-boundary-dom', 'session-request-binding',
      'investor-notifications', 'investor-notifications-route', 'investor-notifications-panel'].map(name => 'tests/' + name + '.test.ts')], path.join(root, 'web'));
  run('migration-regression', process.execPath, ['--max-old-space-size=128', '--test', '--test-reporter=tap', '--test-concurrency=1',
    ...readdirSync(path.join(root, 'tests/migrations')).filter(name => name.endsWith('.test.mjs')).sort().map(name => 'tests/migrations/' + name)], root);
  run('python-accounting-regression', python, ['-m', 'unittest', 'tests.accounting.test_accounting', 'tests.accounting.test_fact_quality', 'tests.accounting.test_golden_contract'], root);
  const compile = `import {build} from 'esbuild';
    await build({entryPoints:['src/components/workbench/investor-workspace.tsx'],bundle:true,write:false,platform:'browser',target:'es2022',tsconfig:'tsconfig.json',external:['react','react/*','react-dom','react-dom/*','next/*','lucide-react','@radix-ui/*'],logLevel:'info'});
    for (const entry of ['src/app/api/workbench/investor/route.ts','src/app/api/workbench/investor/trade-recording/route.ts'])
      await build({entryPoints:[entry],bundle:true,write:false,platform:'node',target:'node22',tsconfig:'tsconfig.json',external:['next/*','better-sqlite3','server-only'],logLevel:'info'});`;
  run('trade-bundle-compile', process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', compile], path.join(root, 'web'));
} catch (error) {
  failure = error instanceof Error && /^TRADE_[A-Z_]+(?::[a-z-]+)?$/.test(error.message) ? error.message : 'TRADE_VERIFICATION_FAILED';
} finally {
  let after = null;
  try { after = sources(); writeFileSync(path.join(output, 'source-after.json'), JSON.stringify(after, null, 2) + '\n', { mode: 0o600 }); }
  catch { failure ??= 'TRADE_SOURCE_UNAVAILABLE'; }
  const unchanged = JSON.stringify(after) === JSON.stringify(before);
  try { rmSync(temporary, { recursive: true, force: true }); }
  catch { failure ??= 'TRADE_CLEANUP_FAILED'; }
  const result = { schema_version: 'investor-trade-recording-verification-v1', status: !failure && unchanged ? 'SCOPED_TRADE_SOFTWARE_PASS_NOT_RELEASE' : 'SCOPED_TRADE_VERIFICATION_FAILED',
    recorded_at: new Date().toISOString(), node_version: process.version, source_files: Object.keys(before).length, sources_unchanged: unchanged, stages, failure,
    temporary_fixture_removed: !existsSync(temporary), real_market_or_gateway_calls: 0, production_changed: false,
    full_typecheck_executed: false, next_production_build_executed: false, live_authenticated_http_executed: false, native_browser_executed: false,
    limitations: ['Synthetic software fixtures only; route authentication and hook events are harnessed, not live Next/browser acceptance.',
      'No broker certification, account-level review list, execution-report binding, complete v2, Linux or production release qualification.',
      'Bundle compilation is not semantic TypeScript checking; local Node version differs from required production Node 22.'] };
  writeFileSync(path.join(output, 'verification-summary.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: result.status, evidence: path.relative(root, output), sources_unchanged: unchanged, failure }) + '\n');
  if (failure || !unchanged) process.exitCode = 1;
}
