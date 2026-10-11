import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { aiSourceFiles } from '../../scripts/ai-explanation-source.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function verifyAiRuntime() {
  const manifestPath = path.join(root, 'web/dist/ai-explanation.manifest.json'), bundle = path.join(root, 'web/dist/ai-explanation.mjs');
  for (const file of [manifestPath, bundle]) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('AI_RUNTIME_BUILD_INVALID');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schema_version !== 'ai-explanation-build-v1' || manifest.entrypoint !== 'web/scripts/ai-explanation-worker.ts'
    || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(['bundle_sha256', 'entrypoint', 'schema_version', 'source_files'])
    || manifest.bundle_sha256 !== createHash('sha256').update(readFileSync(bundle)).digest('hex')
    || JSON.stringify(manifest.source_files) !== JSON.stringify(aiSourceFiles(root))) throw new Error('AI_RUNTIME_BUILD_INVALID');
}
try {
  verifyAiRuntime();
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') process.stdout.write('AI_RUNTIME_BUILD_VERIFIED\n');
  else {
    const worker = await import('../dist/ai-explanation.mjs');
    await worker.main(args, verifyAiRuntime);
  }
} catch {
  process.stderr.write('AI_RUNTIME_UNAVAILABLE\n'); process.exitCode = 1;
}
