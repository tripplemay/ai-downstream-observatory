import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function partitionFiles(files, count) {
  if (!Number.isInteger(count) || count < 1 || count > 32 || !files.length || new Set(files).size !== files.length) throw new Error('INVALID_TEST_PARTITION');
  const groups = Array.from({ length: count }, () => []);
  [...files].sort().forEach((file, index) => groups[index % count].push(file));
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
    inventory_sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), test_concurrency: 1, status: 'DISCOVERED' };
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
