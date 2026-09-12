import { randomBytes, scryptSync } from 'node:crypto';
import { chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function initializeSecrets({ directory, deploymentRoot, origin, password, uid = 10001, requireRoot = true }) {
  if (requireRoot && process.getuid?.() !== 0) throw new Error('ROOT_OPERATOR_REQUIRED');
  const safePath = (path) => isAbsolute(path) && /^\/[A-Za-z0-9._/-]+$/.test(path) && !path.split('/').includes('..') && path !== '/';
  if (!safePath(directory) || !safePath(deploymentRoot)) throw new Error('CONTROLLED_ABSOLUTE_PATH_REQUIRED');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('HTTPS_ORIGIN_REQUIRED');
  if (typeof password !== 'string' || password.length < 16 || Buffer.byteLength(password, 'utf8') > 1024 || /[\r\n\0]/.test(password)) throw new Error('PASSWORD_LENGTH_OR_FORMAT_INVALID');
  if (existsSync(directory)) throw new Error('SECRET_DIRECTORY_ALREADY_EXISTS');
  mkdirSync(directory, { mode: 0o700 });
  try {
    const salt = randomBytes(16), hash = ['scrypt', 32768, 8, 1, salt.toString('base64url'), scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url')].join('$');
    const runtime = `WORKBENCH_PASSWORD_HASH=${hash}\nWORKBENCH_SESSION_SECRET=${randomBytes(48).toString('base64url')}\nWORKBENCH_ORIGIN=${url.origin}\n`;
    writeFileSync(join(directory, 'runtime.env'), runtime, { mode: 0o600, flag: 'wx' });
    const key = join(directory, 'backup.passphrase');
    writeFileSync(key, randomBytes(48).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
    if (requireRoot) chownSync(key, uid, uid);
    const config = `WORKBENCH_DEPLOY_ROOT=${deploymentRoot}\nWORKBENCH_LEGACY_DIR=${deploymentRoot}\nWORKBENCH_LEGACY_DATA_DIR=${deploymentRoot}/data\nWORKBENCH_DATA_DIR_HOST=${deploymentRoot}/data-workbench\nWORKBENCH_BACKUP_DIR_HOST=${deploymentRoot}/backups-workbench\nWORKBENCH_RESTORE_PARENT_DIR=${deploymentRoot}/restores-workbench\nWORKBENCH_RUNTIME_ENV_FILE=${directory}/runtime.env\nWORKBENCH_BACKUP_KEY_FILE=${directory}/backup.passphrase\nWORKBENCH_HTTP_PORT=5051\n`;
    writeFileSync(join(directory, 'release.env'), config, { mode: 0o600, flag: 'wx' });
    return { status: 'created', directory, password_stored: false, remote_replica_configured: false };
  } catch (cause) { rmSync(directory, { recursive: true, force: true }); throw cause; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('USE_ENV_AND_PASSWORD_STDIN_NO_SECRET_ARGUMENTS');
    const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    const result = initializeSecrets({ directory: process.env.WORKBENCH_SETUP_DIR ?? '/etc/etf-workbench', deploymentRoot: process.env.WORKBENCH_DEPLOY_ROOT, origin: process.env.WORKBENCH_ORIGIN, password });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (cause) { process.stderr.write(`${cause instanceof Error ? cause.message : 'SECRET_INITIALIZATION_FAILED'}\n`); process.exitCode = 1; }
}
