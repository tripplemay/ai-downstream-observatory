import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { archiveLegacy } from '../../scripts/archive-legacy.mjs';
import { Database, backupWorkbench, sha256File } from '../../scripts/backup-workbench.mjs';
import { restoreWorkbench } from '../../scripts/restore-workbench.mjs';
import { migrateWorkbench } from '../../scripts/migrate-workbench.mjs';
import { checkRuntime } from '../../scripts/check-workbench-runtime.mjs';
import { initializeSecrets } from '../../scripts/init-workbench-secrets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
test('personal plans and local data stay outside Docker build context and Git publication', () => {
  const dockerIgnore = readFileSync(join(root, '.dockerignore'), 'utf8').split(/\r?\n/);
  for (const entry of ['.private', '**/.private', 'artifacts', 'data', 'data-workbench', '**/.env', '**/*.db', '**/*.passphrase']) assert.ok(dockerIgnore.includes(entry), entry);
  const gitIgnore = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const entry of ['.private/', 'artifacts/', 'data/', 'data-workbench/', '.env', '.env.*', '**/*.passphrase']) assert.ok(gitIgnore.includes(entry), entry);
  // A source archive need not contain Git metadata; the ignore rules still apply.
  if (existsSync(join(root, '.git'))) {
    const result = spawnSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const privateFiles = result.stdout.split('\0').filter(path => /(^|\/)(?:\.private|artifacts|data-workbench|backups-workbench|restores-workbench)(?:\/|$)/.test(path));
    assert.deepEqual(privateFiles, []);
  }
});
test('legacy research examples share an impersonal scope and label simulation-only capital', () => {
  const statement = '- 通用长期研究示例：依据证实/证伪信号而非短期波动调整研究判断，不代表任何用户的个人投资期限或偏好。';
  for (const path of ['AI下游投资观测台.md', 'worker/themes/ai_downstream.py', 'web/src/lib/seed.ts']) {
    const source = readFileSync(join(root, path), 'utf8');
    assert.equal(source.split(statement).length - 1, 1, path);
    assert.doesNotMatch(source, /本人为|我的投资期限/u, path);
    assert.ok(source.includes('- 证实信号充分 → 开始建仓'), path);
    assert.ok(source.includes('- 证实信号不充分 / 证伪信号充分 → 等待，或修正判断本身'), path);
  }
  const paper = readFileSync(join(root, 'worker/paper_trade.py'), 'utf8');
  assert.match(paper, /# Synthetic legacy simulation capital; never an actual-workbench cash default\.\nINITIAL_CASH = /);
  assert.ok(paper.includes('INSERT INTO paper_accounts'));
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'etf-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('legacy single-theme/WAL snapshot maps original rows, never actual funds, and round-trips encrypted', async (t) => {
  const directory = fixture(t), sourcePath = join(directory, 'observatory.db'), dbPath = join(directory, 'etf-workbench.db');
  const source = new Database(sourcePath);
  source.pragma('journal_mode=WAL');
  source.exec("CREATE TABLE metrics(id TEXT PRIMARY KEY,value REAL,raw BLOB);CREATE TABLE paper_accounts(id INTEGER PRIMARY KEY,cash REAL);INSERT INTO metrics VALUES('old',123.125,x'00ff');INSERT INTO paper_accounts VALUES(9007199254740993,1000000)");
  const sourceHash = await sha256File(sourcePath);
  migrateWorkbench(dbPath);
  const options = { sourcePath, dbPath, dataDir: directory, archiveDir: join(directory, 'archives'), appRef: 'fixture-release' };
  const first = await archiveLegacy(options), second = await archiveLegacy(options);
  assert.equal(first.source_rows, 2); assert.equal(first.imported, 2); assert.equal(second.reused, 2);
  assert.equal(await sha256File(sourcePath), sourceHash, 'source main file was not checkpointed/replaced');
  const db = new Database(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger_events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM portfolios').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM legacy_archives').get().n, 2);
  const account = JSON.parse(db.prepare("SELECT source_row_json FROM legacy_archives WHERE source_table='paper_accounts'").get().source_row_json);
  assert.deepEqual(account.id, { sqlite_integer: '9007199254740993' });
  const metric = JSON.parse(db.prepare("SELECT source_row_json FROM legacy_archives WHERE source_table='metrics'").get().source_row_json);
  assert.deepEqual(metric.raw, { sqlite_blob_base64: 'AP8=' });
  const snapshot = new Database(first.archive_path, { readonly: true });
  assert.equal(snapshot.prepare('SELECT COUNT(*) n FROM metrics').get().n, 1, 'WAL rows included'); snapshot.close();
  db.close(); source.close();
  const passphrase = randomBytes(48).toString('hex');
  const backup = await backupWorkbench({ dbPath, dataDir: directory, outputDir: join(directory, 'backups'), appRef: 'fixture-release', passphrase });
  const targetDir = join(directory, 'restored');
  await restoreWorkbench({ archivePath: backup.path, targetDir, passphrase });
  assert.equal(await sha256File(join(targetDir, `attachments/legacy-${first.source_sha256}.sqlite`)), first.source_sha256);
});

test('legacy archive rejects workbench source, missing original and restored write targets', async (t) => {
  const directory = fixture(t), dbPath = join(directory, 'etf-workbench.db'); migrateWorkbench(dbPath);
  const options = { sourcePath: dbPath, archiveDir: join(directory, 'archive'), appRef: 'fixture' };
  await assert.rejects(archiveLegacy(options), /LEGACY_SOURCE_SCHEMA_NOT_RECOGNIZED/);
  await assert.rejects(archiveLegacy({ ...options, sourcePath: join(directory, 'missing.db') }));
  const sourcePath = join(directory, 'observatory.db'), source = new Database(sourcePath);
  source.exec('CREATE TABLE themes(id TEXT PRIMARY KEY)'); source.close();
  writeFileSync(join(directory, 'RESTORE_PENDING_REVIEW'), 'review');
  await assert.rejects(archiveLegacy({ ...options, sourcePath, dbPath, dataDir: directory }), /UNSAFE_LEGACY_IMPORT_TARGET/);
});

for (const withWal of [false, true]) test(`quiesced legacy WAL ${withWal ? 'with committed WAL and no SHM' : 'after clean close'} loses no rows and never edits original`, async (t) => {
  const directory = fixture(t), donorPath = join(directory, 'donor.db'), donor = new Database(donorPath);
  donor.pragma('journal_mode=WAL'); donor.exec("CREATE TABLE themes(id TEXT PRIMARY KEY);INSERT INTO themes VALUES('ai');CREATE TABLE paper_accounts(id TEXT PRIMARY KEY,cash REAL);INSERT INTO paper_accounts VALUES('simulation',1000000)");
  const legacy = join(directory, 'legacy'); mkdirSync(legacy, { mode: 0o700 });
  const sourcePath = join(legacy, 'observatory.db');
  if (withWal) { copyFileSync(donorPath, sourcePath); copyFileSync(`${donorPath}-wal`, `${sourcePath}-wal`); donor.close(); }
  else { donor.close(); copyFileSync(donorPath, sourcePath); }
  assert.equal(existsSync(`${sourcePath}-shm`), false);
  const mainHash = await sha256File(sourcePath), walHash = withWal ? await sha256File(`${sourcePath}-wal`) : null;
  const dbPath = join(directory, 'etf-workbench.db'); migrateWorkbench(dbPath);
  const result = await archiveLegacy({ sourcePath, archiveDir: join(directory, 'archive'), dbPath, dataDir: directory, appRef: 'fixture', sourceQuiesced: true });
  assert.equal(result.imported, 2); assert.equal(await sha256File(sourcePath), mainHash);
  if (withWal) assert.equal(await sha256File(`${sourcePath}-wal`), walHash);
  assert.equal(existsSync(`${sourcePath}-shm`), false);
  const snapshot = new Database(result.archive_path, { readonly: true });
  assert.equal(snapshot.prepare('SELECT cash FROM paper_accounts').get().cash, 1000000); snapshot.close();
  const target = new Database(dbPath); assert.equal(target.prepare('SELECT COUNT(*) n FROM ledger_events').get().n, 0); target.close();
});

test('multi-theme pre-ETF archive preserves all rows and a late recovery lock rejects the transaction', async (t) => {
  const directory = fixture(t), sourcePath = join(directory, 'observatory.db'), source = new Database(sourcePath);
  source.exec("CREATE TABLE themes(id TEXT PRIMARY KEY);CREATE TABLE signals(theme_id TEXT,id TEXT,PRIMARY KEY(theme_id,id)) WITHOUT ROWID;INSERT INTO themes VALUES('ai'),('macro');INSERT INTO signals VALUES('ai','c1'),('macro','c1')"); source.close();
  const dbPath = join(directory, 'etf-workbench.db'); migrateWorkbench(dbPath);
  const options = { sourcePath, dbPath, dataDir: directory, archiveDir: join(directory, 'archive'), appRef: 'fixture' };
  await assert.rejects(archiveLegacy({ ...options, now: () => { writeFileSync(join(directory, 'RESTORE_PENDING_REVIEW'), 'review'); return '2026-09-12T00:00:00.000Z'; } }), /UNSAFE_LEGACY_IMPORT_TARGET/);
  const db = new Database(dbPath); assert.equal(db.prepare('SELECT COUNT(*) n FROM legacy_archives').get().n, 0); db.close();
  rmSync(join(directory, 'RESTORE_PENDING_REVIEW'));
  const result = await archiveLegacy(options); assert.equal(result.imported, 4); assert.equal(result.actual_fact_count_added, 0);
});

test('release planner has no side effects and rejects broad config and shared legacy volume', (t) => {
  const directory = fixture(t), sha = 'a'.repeat(40), config = join(directory, 'release.env');
  const writeConfig = (extra = '') => writeFileSync(config, `WORKBENCH_DEPLOY_ROOT=${directory}\nWORKBENCH_RUNTIME_ENV_FILE=${directory}/runtime.env\nWORKBENCH_BACKUP_KEY_FILE=${directory}/backup.passphrase\n${extra}`, { mode: 0o600 });
  const plan = () => spawnSync('bash', [join(root, 'scripts/deploy-workbench.sh'), '--release', sha, '--release-dir', `${directory}/releases/${sha}`, '--config', config], { encoding: 'utf8' });
  writeConfig(); const good = plan(); assert.equal(good.status, 0, good.stderr); assert.match(good.stdout, /PLAN ONLY/);
  assert.equal(existsSync(join(directory, 'data-workbench')), false);
  chmodSync(config, 0o644); assert.notEqual(plan().status, 0); chmodSync(config, 0o600);
  writeConfig(`WORKBENCH_DATA_DIR_HOST=${directory}/data\n`); assert.match(plan().stderr, /must differ/);
});

test('readiness requires protected configuration and current schema but never seeds database', async (t) => {
  const directory = fixture(t), dbPath = join(directory, 'etf-workbench.db');
  const env = { WORKBENCH_DB_PATH: dbPath, WORKBENCH_DATA_DIR: directory, WORKBENCH_ORIGIN: 'https://fixture.invalid', WORKBENCH_PASSWORD_HASH: `scrypt$32768$8$1$${'a'.repeat(22)}$${'b'.repeat(43)}`, WORKBENCH_SESSION_SECRET: 'x'.repeat(48) };
  assert.deepEqual(await checkRuntime({ env, configurationOnly: true }), { status: 'configured' });
  await assert.rejects(checkRuntime({ env })); assert.equal(existsSync(dbPath), false);
  await assert.rejects(checkRuntime({ env: { ...env, WORKBENCH_SESSION_SECRET: '' } }), /RUNTIME_AUTH_NOT_CONFIGURED/);
  migrateWorkbench(dbPath); assert.equal((await checkRuntime({ env })).recovery_read_only, false);
  writeFileSync(join(directory, 'RESTORE_PENDING_REVIEW'), 'review'); assert.equal((await checkRuntime({ env })).recovery_read_only, true);
});

function assertExplicitBindGuards(source) {
  const declarations = source.match(/^[ \t]*(?:- )?type: bind[ \t]*$/gm) ?? [];
  const options = source.match(/^[ \t]*bind:[ \t]*$/gm) ?? [];
  const guards = source.match(/^[ \t]*bind:[ \t]*\n[ \t]+create_host_path: false[ \t]*$/gm) ?? [];
  assert.ok(declarations.length > 0);
  assert.equal(options.length, declarations.length, 'every long bind has explicit options');
  assert.equal(guards.length, declarations.length, 'every bind options block explicitly disables path creation');
}

test('all source bind declarations retain explicit missing-path guards', () => {
  const source = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
  assertExplicitBindGuards(source);
  for (const match of source.matchAll(/create_host_path: false/g)) {
    for (const replacement of ['create_host_path: true', '']) {
      assert.throws(() => assertExplicitBindGuards(source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length)));
    }
  }
});

test('compose tools resolve without secrets and use fail-closed mounts and non-root containers', (t) => {
  const directory = fixture(t), runtimeFile = join(directory, 'runtime.env');
  writeFileSync(runtimeFile, 'WORKBENCH_CONFIG_FIXTURE_MARKER=synthetic-config-fixture\n', { mode: 0o600 });
  // Some Compose versions stat required env files even with --no-env-resolution.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WORKBENCH_') && !key.startsWith('COMPOSE_')));
  Object.assign(env, {
    WORKBENCH_RUNTIME_ENV_FILE: runtimeFile,
    WORKBENCH_DATA_DIR_HOST: join(directory, 'data'),
    WORKBENCH_LEGACY_DATA_DIR: join(directory, 'legacy'),
    WORKBENCH_BACKUP_DIR_HOST: join(directory, 'backups'),
    WORKBENCH_RESTORE_PARENT_DIR: join(directory, 'restores'),
    WORKBENCH_BACKUP_KEY_FILE: join(directory, 'backup.passphrase'),
    WORKBENCH_RELEASE_SHA: 'config-fixture', WORKBENCH_HTTP_PORT: '5051', WORKBENCH_MODE: 'ledger',
    WORKBENCH_RESTORE_ARCHIVE_NAME: 'fixture.etfbackup', WORKBENCH_RESTORE_TARGET_NAME: 'fixture-restore',
  });
  const result = spawnSync('docker', ['compose', '--env-file', '/dev/null', '-p', 'etf-config-fixture', '--profile', 'tools', '-f', join(root, 'docker-compose.yml'), 'config', '--no-env-resolution', '--format', 'json'], { encoding: 'utf8', env, timeout: 15000 });
  if (result.error?.code === 'ENOENT') return t.skip('Docker Compose CLI not installed; container CI is mandatory');
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  for (const [name, service] of Object.entries(config.services)) {
    assert.equal(service.user, '10001:10001', name); assert.equal(service.read_only, true, name);
    assert.ok(service.cap_drop.includes('ALL'), name);
    for (const volume of service.volumes ?? []) {
      assert.equal(volume.type, 'bind', name);
      // Compose v2 omits false JSON fields; the source and container behavior are checked separately.
      assert.ok([false, undefined].includes(volume.bind?.create_host_path), name);
    }
  }
  assert.equal(config.services.web.ports[0].host_ip, '127.0.0.1');
  if (config.services.web.env_file === undefined) {
    assert.equal(config.services.web.environment.WORKBENCH_CONFIG_FIXTURE_MARKER, 'synthetic-config-fixture');
  } else {
    assert.equal(config.services.web.env_file.length, 1);
    assert.equal(config.services.web.env_file[0].path, runtimeFile);
    assert.ok([true, undefined].includes(config.services.web.env_file[0].required));
    assert.equal(config.services.web.env_file[0].format, 'raw');
    assert.equal(config.services.web.environment.WORKBENCH_CONFIG_FIXTURE_MARKER, undefined);
  }
  assert.match(readFileSync(join(root, 'docker-compose.yml'), 'utf8'), /env_file:\s*\n\s*- path: \$\{WORKBENCH_RUNTIME_ENV_FILE[^\n]+\n\s*required: true\s*\n\s*format: raw/);
  assert.equal(config.services.web.environment.WORKBENCH_PASSWORD_HASH, undefined);
  assert.equal(config.services.web.environment.WORKBENCH_SESSION_SECRET, undefined);
  for (const service of Object.values(config.services)) for (const volume of service.volumes ?? []) {
    assert.ok(volume.source.startsWith(`${directory}/`), volume.source);
  }
});

test('release workflow remains manual and failure path cannot restore over actual facts', () => {
  const workflow = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /^  (push|pull_request):/m);
  assert.match(workflow, /environment: production/); assert.match(workflow, /cancel-in-progress: false/);
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.ok(ci.indexOf('run: npm ci') < ci.indexOf('run: python -m unittest'));
  const deploy = readFileSync(join(root, 'scripts/deploy-workbench.sh'), 'utf8');
  assert.match(deploy, /RESTORE_PENDING_REVIEW/); assert.doesNotMatch(deploy, /git reset|docker compose down|cp .*etf-workbench\.db/);
  assert.match(deploy, /^compose config --no-env-resolution --quiet$/m);
});

test('container smoke executes the deployed monthly publisher against SQLite before reporting runtime success', () => {
  const smoke = readFileSync(join(root, 'tests/deployment/container-smoke.sh'), 'utf8');
  const probe = smoke.match(/<<'PY_PUBLISHER'\n([\s\S]*?)\nPY_PUBLISHER/)?.[1];
  assert.ok(probe);
  const syntax = spawnSync(process.env.WORKBENCH_PYTHON || 'python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: probe, encoding: 'utf8', timeout: 10000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(smoke, /monthly_publisher=\$\(compose run --rm --no-deps -T --entrypoint python worker - <<'PY_PUBLISHER'/);
  assert.ok(smoke.indexOf('compose run --rm --no-deps migrate\n') < smoke.indexOf('monthly_publisher=$('));
  assert.ok(smoke.indexOf('monthly_publisher=$(') < smoke.indexOf('up -d --no-build --wait'));
  assert.match(probe, /from worker\.orchestration\.external import _publisher_argv/);
  assert.match(probe, /argv = _publisher_argv\(lease\)/);
  assert.match(probe, /Path\("\/app\/worker-bridge\/monthly-evaluation\.mjs"\)/);
  assert.match(probe, /open_database\(os\.environ\["WORKBENCH_DB_PATH"\]\)/);
  assert.match(probe, /rejected = subprocess\.run\(argv, stdin=subprocess\.DEVNULL, capture_output=True, text=True, timeout=30, check=False\)/);
  assert.match(probe, /rejected\.returncode != 1 or rejected\.stdout != "" or rejected\.stderr != "STALE_OR_EXPIRED_LEASE\\n"/);
  assert.match(probe, /if fingerprint\(connection\) != before:/);
  assert.match(probe, /\(os\.getuid\(\), os\.getgid\(\)\) != \(10001, 10001\)/);
  assert.match(probe, /hashlib\.file_digest\(original, "sha256"\)/);
  assert.match(smoke, /python3 - "\$root" "\$run_id" "\$1" "\$2" "\$monthly_publisher" <<'PY_REPORT'/);
  assert.match(smoke, /test ! -e \/app\/\.private/);
});

test('release rechecks recovery after build, before stopping writers, migration and startup', (t) => {
  const deploy = readFileSync(join(root, 'scripts/deploy-workbench.sh'), 'utf8');
  const definition = deploy.match(/^assert_no_recovery\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(definition);
  const directory = fixture(t);
  const check = () => spawnSync('bash', ['-c', `${definition}\nassert_no_recovery`], { encoding: 'utf8', env: { ...process.env, WORKBENCH_DATA_DIR_HOST: directory } });
  assert.equal(check().status, 0);
  writeFileSync(join(directory, 'RESTORE_PENDING_REVIEW'), 'synthetic late recovery marker');
  assert.notEqual(check().status, 0); assert.match(check().stderr, /Pending recovery review/);
  assert.match(deploy, /backup-key-check\.txt"\nassert_no_recovery/);
  assert.match(deploy, /legacy-online-snapshot\.json"\n  assert_no_recovery\n  writers_stopped=1/);
  assert.match(deploy, /pre-stop-backup\.json"\n  assert_no_recovery\n  writers_stopped=1/);
  assert.match(deploy, /assert_no_recovery\nmutation_started=1\ncompose run --rm --no-deps migrate/);
  assert.match(deploy, /local-restore-rehearsal\.json"\nassert_no_recovery\ntimeout 180/);
  assert.match(deploy, /assert_no_recovery\nln -s /);
});

test('secret setup creates private unique credentials without storing password or overwriting', (t) => {
  const directory = fixture(t), secrets = join(directory, 'secrets'), password = randomBytes(32).toString('base64url');
  const options = { directory: secrets, deploymentRoot: directory, origin: 'https://fixture.invalid', password, requireRoot: false };
  const result = initializeSecrets(options);
  const runtime = readFileSync(join(secrets, 'runtime.env'), 'utf8');
  assert.equal(result.password_stored, false); assert.ok(!JSON.stringify(result).includes(password)); assert.ok(!runtime.includes(password));
  assert.match(runtime, /WORKBENCH_PASSWORD_HASH=scrypt\$32768\$8\$1\$/);
  assert.throws(() => initializeSecrets(options), /SECRET_DIRECTORY_ALREADY_EXISTS/);
  assert.equal(readFileSync(join(secrets, 'runtime.env'), 'utf8'), runtime);
});

test('initial password UTF-8 limit matches login and rejects oversized input before creating secrets', (t) => {
  const directory = fixture(t), options = { directory: join(directory, 'secrets'), deploymentRoot: directory, origin: 'https://fixture.invalid', requireRoot: false };
  for (const password of ['x'.repeat(1025), '\u5bc6'.repeat(342)]) {
    assert.ok(Buffer.byteLength(password) > 1024);
    assert.throws(() => initializeSecrets({ ...options, password }), /PASSWORD_LENGTH_OR_FORMAT_INVALID/);
    assert.equal(existsSync(options.directory), false);
  }
  const password = '\u5bc6'.repeat(341) + 'x';
  assert.equal(Buffer.byteLength(password), 1024);
  initializeSecrets({ ...options, password });
  const runtime = readFileSync(join(options.directory, 'runtime.env'), 'utf8');
  const encoded = runtime.split('\n').find((line) => line.startsWith('WORKBENCH_PASSWORD_HASH=')).split('=')[1];
  const parts = encoded.split('$');
  assert.equal(scryptSync(password, Buffer.from(parts[4], 'base64url'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url'), parts[5]);
  const loginSource = readFileSync(join(root, 'web/src/server/auth/core.ts'), 'utf8');
  assert.match(loginSource, /Buffer\.byteLength\(password\) > 1024/);
  assert.ok(!runtime.includes(password));
});
