import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { partitionFiles } from '../../web/scripts/ci-web-tests.mjs';

test('Web partition covers every original test file exactly once without depending on enumeration order', () => {
  const plans = Array.from({ length: 8 }, (_, shard) => JSON.parse(execFileSync(process.execPath,
    ['web/scripts/ci-web-tests.mjs', '--shard', String(shard), '--shards', '8', '--list'], { encoding: 'utf8' })));
  const files = plans.flatMap(plan => plan.selected_files), inventory = [...files].sort();
  assert.equal(new Set(files).size, files.length);
  assert.equal(files.length, plans[0].discovered);
  assert.ok(files.length > 0);
  assert.ok(plans.every(plan => plan.discovered === files.length && plan.inventory_sha256 === plans[0].inventory_sha256 && plan.test_concurrency === 1));
  assert.equal(createHash('sha256').update(JSON.stringify(inventory)).digest('hex'), plans[0].inventory_sha256);
  assert.deepEqual(partitionFiles([...inventory].reverse(), 8), partitionFiles(inventory, 8));
  for (const [input, count] of [[[], 1], [['a', 'a'], 1], [['a'], 0], [['a'], 33], [['a'], true]]) {
    assert.throws(() => partitionFiles(input, count), /INVALID_TEST_PARTITION/);
  }
});

test('all Web CI shards preserve pretest publishers and serial per-file execution, not longer fixture deadlines', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const web = ci.match(/^  web:\n[\s\S]*?(?=^  fixtures:)/m)?.[0];
  assert.ok(web);
  assert.match(web, /shard: \[0, 1, 2, 3, 4, 5, 6, 7\]/);
  assert.match(web, /npm run test:ci:shard -- --shard \$\{\{ matrix\.shard \}\} --shards 8/);
  const scripts = JSON.parse(readFileSync('web/package.json', 'utf8')).scripts;
  assert.equal(scripts['pretest:ci:shard'], 'npm run pretest');
  assert.equal(scripts['test:ci:shard'], 'node scripts/ci-web-tests.mjs');
  assert.match(readFileSync('web/scripts/ci-web-tests.mjs', 'utf8'), /'--test-concurrency=1'/);
  assert.doesNotMatch(web, /continue-on-error:/);
});

test('measured costs distribute expensive replays without omitting cheap or newly discovered files', () => {
  const costs = { a: 120, b: 110, c: 100, d: 90, e: 80, f: 70, g: 60, h: 50 };
  const files = Object.keys(costs), groups = partitionFiles(files, 4, costs);
  assert.deepEqual(groups.flat().sort(), files);
  assert.deepEqual(groups.map(group => group.reduce((sum, file) => sum + costs[file], 0)), [170, 170, 170, 170]);
  assert.ok(partitionFiles([...files, 'new-file'], 4, costs).flat().includes('new-file'));
  assert.deepEqual(partitionFiles(['constructor', '__proto__', 'toString'], 2, {}).flat().sort(), ['__proto__', 'constructor', 'toString']);
  assert.deepEqual(partitionFiles([...files].reverse(), 4, costs), groups);
  for (const value of [0, -1, NaN, Infinity, '1']) assert.throws(() => partitionFiles(files, 4, { a: value }), /INVALID_TEST_COST/);
});
