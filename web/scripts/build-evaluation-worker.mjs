import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['web/scripts/monthly-evaluation.ts'],
  outfile: 'web/dist/monthly-evaluation.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['better-sqlite3'],
  tsconfig: path.join(root, 'web/tsconfig.json'),
  // Bundled CommonJS libraries still need Node's built-in module loader.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  sourcemap: false,
  logLevel: 'info',
});
