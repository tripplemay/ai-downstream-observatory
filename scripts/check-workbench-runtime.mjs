import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Database, assertAbsolute } from './backup-workbench.mjs';
import { verifyWorkbenchSchema } from './migrate-workbench.mjs';

export async function checkRuntime({ env = process.env, http = false, configurationOnly = false } = {}) {
  const dbPath = assertAbsolute(env.WORKBENCH_DB_PATH), dataDir = assertAbsolute(env.WORKBENCH_DATA_DIR);
  const origin = new URL(env.WORKBENCH_ORIGIN ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || !/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(env.WORKBENCH_PASSWORD_HASH ?? '')
    || (env.WORKBENCH_SESSION_SECRET ?? '').length < 32) throw new Error('RUNTIME_AUTH_NOT_CONFIGURED');
  if (configurationOnly) return { status: 'configured' };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let schema;
  try { schema = verifyWorkbenchSchema(db); } finally { db.close(); }
  if (http) {
    const response = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(4000) });
    if (!response.ok || (await response.json()).status !== 'ok') throw new Error('HTTP_HEALTH_FAILED');
  }
  return { status: 'ready', schema_version: schema.version, recovery_read_only: [dataDir, dirname(dbPath)].some((directory) => existsSync(join(directory, 'RESTORE_PENDING_REVIEW'))) || env.WORKBENCH_MODE === 'read_only' };
}

if (process.argv[1]?.endsWith('check-workbench-runtime.mjs')) {
  try {
    if (process.argv.length > 3 || (process.argv.length === 3 && !['--http','--config-only'].includes(process.argv[2]))) throw new Error('INVALID_HEALTH_ARGUMENT');
    process.stdout.write(`${JSON.stringify(await checkRuntime({ http: process.argv.includes('--http'), configurationOnly: process.argv.includes('--config-only') }))}\n`);
  } catch { process.stderr.write('WORKBENCH_NOT_READY\n'); process.exitCode = 1; }
}
