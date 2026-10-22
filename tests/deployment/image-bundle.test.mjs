import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('synthetic image bundle cases cover portable runtime fingerprints, private bounded archives and rejection before daemon mutation', () => {
  const run = spawnSync(process.env.WORKBENCH_PYTHON || 'python3', ['-m', 'unittest', 'discover', '-s', 'tests/deployment', '-p', 'test_image_bundle.py', '-v'],
    { cwd: root, encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /Ran 7 tests/);
});
test('protected release builds before SSH secrets and loads a per-attempt exact bundle before the original cutover gates', () => {
  const workflow = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8');
  const deploy = readFileSync(join(root, 'scripts/deploy-workbench.sh'), 'utf8');
  assert.ok(workflow.indexOf('needs: verify') < workflow.indexOf('release-image-bundle.py build'));
  assert.ok(workflow.indexOf('release-image-bundle.py build') < workflow.indexOf('VPS_SSH_KEY:'));
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /images-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/);
  assert.match(workflow, /"set -eu; umask 077; mkdir/);
  assert.match(workflow, /--image-bundle "\$incoming\/\$image_upload\/release-images\.json"/);
  assert.match(deploy, /timeout 600 python3 "\$release_dir\/scripts\/release-image-bundle\.py" load/);
  assert.ok(deploy.indexOf('image-bundle-verification.json') < deploy.indexOf('pre-stop-backup.json'));
  assert.match(deploy, /else\n  timeout 3600 docker compose/);
  const smoke = readFileSync(join(root, 'tests/deployment/container-smoke.sh'), 'utf8');
  assert.match(smoke, /release-image-bundle\.py pack/);
  assert.match(smoke, /release-image-bundle\.py load/);
  assert.ok(smoke.indexOf('image-bundle-roundtrip.json') < smoke.indexOf('compose run --rm --no-deps migrate'));
});
test('image-bundle plans are side-effect free and reject another release, traversal or an uncontrolled directory', t => {
  const directory = mkdtempSync(join(tmpdir(), 'image-bundle-plan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'release.env'), sha = 'a'.repeat(40);
  writeFileSync(config, `WORKBENCH_DEPLOY_ROOT=${directory}\nWORKBENCH_RUNTIME_ENV_FILE=${directory}/runtime.env\nWORKBENCH_BACKUP_KEY_FILE=${directory}/backup.passphrase\n`, { mode: 0o600 });
  const plan = path => spawnSync('bash', [join(root, 'scripts/deploy-workbench.sh'), '--release', sha,
    '--release-dir', `${directory}/releases/${sha}`, '--config', config, '--image-bundle', path],
    { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(WORKBENCH_|COMPOSE_)/.test(key))) });
  const correct = plan(`${directory}/incoming/${sha}/images-123-1/release-images.json`);
  assert.equal(correct.status, 0, correct.stderr); assert.match(correct.stdout, /Verified off-host image bundle supplied: 1/);
  for (const path of [`${directory}/incoming/${'b'.repeat(40)}/images-123-1/release-images.json`,
    `${directory}/incoming/${sha}/images-123-1/../release-images.json`, `${directory}/arbitrary/release-images.json`,
    `${directory}/incoming/${sha}/images-command-1/release-images.json`]) assert.notEqual(plan(path).status, 0);
});
