import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function sourceFiles(root) {
  root = realpathSync(root);
  if (readdirSync(path.join(root, 'worker')).includes('__init__.py')) throw new Error('VERIFICATION_NAMESPACE_INITIALIZER_FORBIDDEN');
  const names = [];
  function scan(relative, extensions) {
    const filename = path.join(root, relative), stat = lstatSync(filename);
    if (stat.isSymbolicLink()) throw new Error('VERIFICATION_SOURCE_SYMLINK');
    if (stat.isDirectory()) {
      for (const child of readdirSync(filename).sort()) scan(`${relative}/${child}`, extensions);
    } else if (stat.isFile() && extensions.includes(path.extname(relative))) names.push(relative);
  }
  for (const directory of ['accounting', 'market', 'orchestration', 'performance', 'research', 'governance_verification']) scan(`worker/${directory}`, ['.py']);
  scan('web/src/server', ['.ts']);
  scan('contracts', ['.json']);
  scan('migrations', ['.sql', '.json']);
  names.push('web/scripts/governance-fixture.ts', 'web/scripts/build-governance-fixture.mjs',
    'web/package.json', 'web/package-lock.json', 'web/tsconfig.json', 'requirements-workbench.txt',
    'scripts/migrate-workbench.mjs', 'scripts/verification-source.mjs');
  if (names.length > 4096) throw new Error('VERIFICATION_SOURCE_LIMIT');
  const files = {};
  for (const relative of names.sort()) {
    const filename = path.join(root, relative), stat = lstatSync(filename);
    let component = root;
    for (const name of relative.split('/')) {
      component = path.join(component, name);
      if (lstatSync(component).isSymbolicLink()) throw new Error('VERIFICATION_SOURCE_SYMLINK');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024
      || !realpathSync(filename).startsWith(root + path.sep)) throw new Error('VERIFICATION_SOURCE_INVALID');
    files[relative] = createHash('sha256').update(readFileSync(filename)).digest('hex');
  }
  return files;
}
