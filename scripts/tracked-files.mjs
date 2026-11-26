import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function gitRecords(root, args) {
  const result = execFileSync('git', args, { cwd: root });
  return new TextDecoder('utf-8', { fatal: true }).decode(result).split('\0').filter(Boolean);
}

// Git selects the inputs. Read their current working-tree contents once, before publishing anything.
export async function trackedFiles(root, { required, directories, include = () => true }) {
  const base = await realpath(root);
  const paths = ['--', ...required, ...directories];
  const index = gitRecords(base, ['ls-files', '--stage', '-z', ...paths]);
  // git add -N creates an index entry without staging the file for inclusion.
  const intentOnly = new Set(gitRecords(base, ['diff', '--name-only', '--no-renames', '--ita-invisible-in-index', '--diff-filter=A', '-z', ...paths]));
  const files = new Map();
  for (const record of index) {
    const tab = record.indexOf('\t');
    const [mode, , stage] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (intentOnly.has(path) || (!required.includes(path) && !include(path))) continue;
    const source = join(base, path);
    if (stage !== '0' || !['100644', '100755'].includes(mode) || await realpath(source) !== source) {
      throw new Error('Expected a tracked regular file: ' + path);
    }
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Expected a regular working-tree file: ' + path);
      files.set(path, { data: await handle.readFile(), mode: stat.mode & 0o777 });
    } finally {
      await handle.close();
    }
  }
  for (const path of required) {
    if (!files.has(path)) throw new Error('Required input is not tracked by Git: ' + path);
  }
  for (const directory of directories) {
    if (![...files.keys()].some(path => path.startsWith(directory + '/'))) throw new Error('No tracked inputs in required directory: ' + directory);
  }
  return files;
}

// Replace each destination atomically, including any stale symlink at that filename.
export async function writeOutput(destination, { data, mode }) {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, '.cloud10-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, data, { mode, flag: 'wx' });
    await chmod(temporary, mode);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
