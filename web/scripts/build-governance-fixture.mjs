import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { sourceFiles } from '../../scripts/verification-source.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const before = sourceFiles(root);
await build({
  absWorkingDir: root,
  entryPoints: ['web/scripts/governance-fixture.ts'],
  outfile: 'web/dist/governance-fixture.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['better-sqlite3'],
  tsconfig: path.join(root, 'web/tsconfig.json'),
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  sourcemap: false,
  logLevel: 'info',
});
const after = sourceFiles(root);
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('VERIFICATION_SOURCE_CHANGED_DURING_BUILD');
writeFileSync(path.join(root, 'web/dist/governance-fixture.manifest.json'), JSON.stringify({
  schema_version: 'verification-fixture-build-v2', entrypoint: 'web/scripts/governance-fixture.ts',
  bundle_sha256: createHash('sha256').update(readFileSync(path.join(root, 'web/dist/governance-fixture.mjs'))).digest('hex'),
  source_files: after,
}) + '\n');
