import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const historicalCosts = JSON.parse(readFileSync(path.join(web, 'scripts/ci-web-costs.json'), 'utf8'));
export function partitionFiles(files, count, costs = historicalCosts.seconds_by_file) {
  if (!Number.isInteger(count) || count < 1 || count > 32 || !files.length || new Set(files).size !== files.length) throw new Error('INVALID_TEST_PARTITION');
  if (!costs || typeof costs !== 'object' || Array.isArray(costs) || Object.values(costs).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('INVALID_TEST_COST');
  const groups = Array.from({ length: count }, () => []);
  const loads = Array(count).fill(0), weight = file => Object.hasOwn(costs, file) ? costs[file] : historicalCosts.default_seconds;
  // Costs only influence placement. Discovery, assertions and deadlines stay
  // unchanged; unknown/new files are always included with a positive weight.
  [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0)).forEach(file => {
    const index = loads.indexOf(Math.min(...loads));
    groups[index].push(file); loads[index] += weight(file);
  });
  groups.forEach(group => group.sort());
  return groups;
}

async function main() {
  const { values } = parseArgs({ options: { shard: { type: 'string' }, shards: { type: 'string' }, list: { type: 'boolean' } } });
  if (!/^\d+$/.test(values.shard ?? '') || !/^\d+$/.test(values.shards ?? '')) throw new Error('SHARD_ARGUMENTS_REQUIRED');
  const shard = Number(values.shard), count = Number(values.shards);
  const files = readdirSync(path.join(web, 'tests'), { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.test.ts')).map(entry => `tests/${entry.name}`).sort();
  const groups = partitionFiles(files, count);
  if (shard >= count || !groups[shard]?.length) throw new Error('INVALID_OR_EMPTY_SHARD');
  const report = { shard, shards: count, discovered: files.length, selected_files: groups[shard],
    inventory_sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), test_concurrency: 1, status: 'DISCOVERED',
    partition_version: 'historical-cost-v1', estimated_seconds: groups[shard].reduce((sum, file) => sum + (historicalCosts.seconds_by_file[file] ?? historicalCosts.default_seconds), 0) };
  if (values.list) { console.log(JSON.stringify(report)); return; }
  report.source_sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: web, encoding: 'utf8' }).trim();
  const directory = path.join(web, '../artifacts/verification');
  mkdirSync(directory, { recursive: true });
  const base = path.join(directory, `web-shard-${shard}-of-${count}`);
  writeFileSync(base + '.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const log = createWriteStream(base + '.tap', { flags: 'wx' });
  const child = spawn(process.execPath, [path.join(web, 'node_modules/tsx/dist/cli.mjs'), '--test', '--test-concurrency=1', '--test-reporter=tap', ...groups[shard]],
    { cwd: web, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', value => { process.stdout.write(value); log.write(value); });
  child.stderr.on('data', value => { process.stderr.write(value); log.write(value); });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  await new Promise(resolve => log.end(resolve));
  const raw = readFileSync(base + '.tap', 'utf8'), stats = {};
  for (const match of raw.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)) stats[match[1]] = Number(match[2]);
  const passed = result.code === 0 && result.signal === null && stats.tests > 0 && stats.fail === 0 && stats.cancelled === 0;
  Object.assign(report, { status: passed ? 'PASS' : 'FAIL', exit_code: result.code, signal: result.signal, stats });
  writeFileSync(base + '.json', JSON.stringify(report, null, 2) + '\n');
  if (!passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
