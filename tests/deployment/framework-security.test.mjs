import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../../web/package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../../web/package-lock.json', import.meta.url), 'utf8'));
const tuple = value => /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
function atLeast(value, minimum) {
  const version = tuple(value), floor = tuple(minimum);
  return version !== null && version.some((part, i) => version.slice(0, i).every((value, j) => value === floor[j]) && part > floor[i])
    || version !== null && version.every((part, i) => part === floor[i]);
}
// Floors for these two known advisories, not a substitute for a fresh npm audit.
function knownNextFix(version) {
  const parts = tuple(version);
  return parts !== null && (parts[0] === 15 && atLeast(version, '15.5.28')
    || parts[0] === 16 && atLeast(version, '16.4.1') || parts[0] > 16);
}
function knownUriFix(version) {
  const parts = tuple(version);
  return parts !== null && (parts[0] === 2 && atLeast(version, '2.4.8')
    || parts[0] === 3 && atLeast(version, '3.1.9')
    || parts[0] === 4 && atLeast(version, '4.2.3') || parts[0] > 4);
}

test('framework pin and lock exclude the known affected Next ranges without a broad version upgrade', () => {
  for (const version of ['15.5.27', '15.4.99', '16.0.0', '16.4.0', '^15.5.28', '15.5.28-canary.0']) assert.equal(knownNextFix(version), false, version);
  for (const version of ['15.5.28', '15.5.29', '16.4.1']) assert.equal(knownNextFix(version), true, version);
  assert.ok(knownNextFix(manifest.dependencies.next));
  assert.equal(lock.packages[''].dependencies.next, manifest.dependencies.next);
  assert.equal(lock.packages['node_modules/next'].version, manifest.dependencies.next);
});

test('every optional compiler target and environment package follows the exact locked framework version', () => {
  const version = manifest.dependencies.next, targets = Object.entries(lock.packages).filter(([name]) => name.startsWith('node_modules/@next/swc-'));
  assert.ok(targets.length >= 8);
  assert.equal(lock.packages['node_modules/@next/env'].version, version);
  for (const [name, entry] of targets) assert.equal(entry.version, version, name);
});

test('image runtime override and native packages retain the vendor workaround floor', () => {
  assert.ok(atLeast(manifest.overrides.sharp, '0.35.5'));
  assert.equal(lock.packages['node_modules/sharp'].version, manifest.overrides.sharp);
  for (const [name, entry] of Object.entries(lock.packages)) if (/^node_modules\/@img\/sharp-(?!libvips)/.test(name))
    assert.ok(atLeast(entry.version, '0.35.5'), name);
});

test('validation runtime and URI parser exclude the known resource and normalization advisories', () => {
  assert.ok(atLeast(manifest.dependencies.zod, '4.6.6'));
  assert.equal(lock.packages[''].dependencies.zod, manifest.dependencies.zod);
  assert.equal(lock.packages['node_modules/zod'].version, manifest.dependencies.zod);
  assert.equal(manifest.dependencies['@hookform/resolvers'], '5.2.2');
  assert.equal(lock.packages['node_modules/@hookform/resolvers'].version, '5.2.2');
  for (const version of ['2.4.7', '3.1.8', '4.0.0', '4.2.2', '^3.1.9']) assert.equal(knownUriFix(version), false, version);
  for (const version of ['2.4.8', '3.1.9', '4.2.3']) assert.equal(knownUriFix(version), true, version);
  assert.ok(knownUriFix(manifest.overrides['fast-uri']));
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (/(?:^|\/)node_modules\/zod$/.test(name)) assert.ok(atLeast(entry.version, '4.6.6'), name);
    if (/(?:^|\/)node_modules\/fast-uri$/.test(name)) assert.ok(knownUriFix(entry.version), name);
  }
});

test('release verification still runs the high-severity audit without ignoring its failure', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const step = workflow.match(/      - name: dependency audit\n([\s\S]*?)(?=      - name:|$)/)?.[1];
  assert.ok(step); assert.match(step, /run: npm audit --audit-level=high\s*$/);
  assert.doesNotMatch(step, /continue-on-error|\|\|\s*(?:true|:)|--omit|--production/);
});
