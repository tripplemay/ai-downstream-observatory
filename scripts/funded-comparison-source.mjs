import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function sourceFiles(root) {
  root = realpathSync(root);
  const names = [];
  function scan(relative, extensions) {
    const filename = path.join(root, relative), stat = lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error('FUNDED_COMPARISON_SOURCE_UNAVAILABLE');
    if (stat.isDirectory()) for (const child of readdirSync(filename).sort()) scan(`${relative}/${child}`, extensions);
    else if (stat.isFile() && extensions.includes(path.extname(relative))) names.push(relative);
    if (names.length > 4096) throw new Error('FUNDED_COMPARISON_SOURCE_UNAVAILABLE');
  }
  scan('web/src/server', ['.ts']); scan('contracts', ['.json']); scan('migrations', ['.sql', '.json']);
  names.push('web/scripts/funded-comparison-worker.ts', 'web/scripts/build-funded-comparison.mjs',
    'web/package.json', 'web/package-lock.json', 'web/tsconfig.json', 'scripts/funded-comparison-source.mjs');
  return Object.fromEntries(names.sort().map(relative => {
    let component = root;
    for (const name of relative.split('/')) {
      component = path.join(component, name);
      if (lstatSync(component).isSymbolicLink()) throw new Error('FUNDED_COMPARISON_SOURCE_UNAVAILABLE');
    }
    const stat = lstatSync(component);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || !realpathSync(component).startsWith(root + path.sep)) throw new Error('FUNDED_COMPARISON_SOURCE_UNAVAILABLE');
    return [relative, createHash('sha256').update(readFileSync(component)).digest('hex')];
  }));
}
