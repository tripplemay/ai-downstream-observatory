import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function aiSourceFiles(root) {
  root = realpathSync(root);
  const names = [];
  function scan(relative, extensions) {
    const file = path.join(root, relative), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('AI_RUNTIME_SOURCE_UNAVAILABLE');
    if (stat.isDirectory()) for (const child of readdirSync(file).sort()) scan(`${relative}/${child}`, extensions);
    else if (stat.isFile() && extensions.includes(path.extname(relative))) names.push(relative);
    if (names.length > 4096) throw new Error('AI_RUNTIME_SOURCE_UNAVAILABLE');
  }
  scan('web/src/server', ['.ts']); scan('contracts', ['.json']); scan('migrations', ['.sql', '.json']);
  for (const folder of ['accounting', 'market', 'orchestration', 'performance', 'research', 'governance_verification', 'investor', 'ai_explanation'])
    scan(`worker/${folder}`, ['.py']);
  names.push('requirements-workbench.txt', 'scripts/ai-explanation-source.mjs', 'web/scripts/ai-explanation-worker.ts',
    'web/scripts/build-ai-explanation.mjs', 'web/scripts/run-ai-explanation.mjs', 'web/package.json', 'web/package-lock.json', 'web/tsconfig.json');
  return Object.fromEntries(names.sort().map(relative => {
    let component = root;
    for (const name of relative.split('/')) {
      component = path.join(component, name);
      if (lstatSync(component).isSymbolicLink()) throw new Error('AI_RUNTIME_SOURCE_UNAVAILABLE');
    }
    const stat = lstatSync(component);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || !realpathSync(component).startsWith(root + path.sep)) throw new Error('AI_RUNTIME_SOURCE_UNAVAILABLE');
    return [relative, createHash('sha256').update(readFileSync(component)).digest('hex')];
  }));
}
