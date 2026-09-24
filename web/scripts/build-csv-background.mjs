import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['web/scripts/csv-background.ts'],
  outfile: 'web/dist/csv-background.mjs',
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
