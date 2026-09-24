import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { build } = createRequire(path.join(root, 'web/package.json'))('esbuild');
await build({ absWorkingDir: root, entryPoints: ['tests/deployment/verification-container-bridge.ts'],
  outfile: 'web/dist/verification-container-bridge.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm',
  external: ['better-sqlite3'], tsconfig: path.join(root, 'web/tsconfig.json'),
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  sourcemap: false, logLevel: 'info' });
