import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { aiSourceFiles } from '../../scripts/ai-explanation-source.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)), before = aiSourceFiles(root);
const entrypoint = 'web/scripts/ai-explanation-worker.ts', bundle = path.join(root, 'web/dist/ai-explanation.mjs');
await build({ absWorkingDir: root, entryPoints: [entrypoint], outfile: bundle, bundle: true, platform: 'node', target: 'node22',
  format: 'esm', external: ['better-sqlite3'], tsconfig: path.join(root, 'web/tsconfig.json'),
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' }, logLevel: 'info' });
if (JSON.stringify(before) !== JSON.stringify(aiSourceFiles(root))) throw new Error('AI_RUNTIME_SOURCE_CHANGED');
writeFileSync(path.join(root, 'web/dist/ai-explanation.manifest.json'), JSON.stringify({ schema_version: 'ai-explanation-build-v1',
  entrypoint, bundle_sha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'), source_files: before }) + '\n');
