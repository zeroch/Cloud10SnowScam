import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { gitRecords, writeOutput } from './tracked-files.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');

async function entry(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Check the nearest existing parent before mkdir, reads or cleanup can follow a directory symlink.
async function checkedPath(root, path) {
  if (!path.startsWith(root + sep)) throw new Error('Unexpected sync path: ' + path);
  for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
    const info = await entry(parent);
    if (!info) continue;
    if (!info.isDirectory() || await realpath(parent) !== parent) throw new Error('Unexpected sync directory: ' + parent);
    break;
  }
  return path;
}

export async function syncSiteOutputs(root, outputs) {
  const base = await realpath(root);
  const site = join(base, 'sites/clould10');
  const current = new Map();
  for (const [path, file] of outputs) {
    await checkedPath(base, join(site, path));
    if (path.startsWith('public/')) current.set(path, digest(file.data));
  }
  await mkdir(site, { recursive: true });
  const { dev, ino } = await stat(site, { bigint: true });
  const state = await checkedPath(base, join(base, '.cache', 'site-sync-' + dev + '-' + ino + '.json'));
  const stateFile = await entry(state);
  if (stateFile && !stateFile.isFile()) throw new Error('Unexpected site sync state file: ' + state);
  const previous = new Map(stateFile ? Object.entries(JSON.parse(await readFile(state, 'utf8'))) : []);

  // Earlier versions also copied ignored and untracked source assets. Never guess ownership
  // when such a file already exists in the site and this sync has no record of writing it.
  const sourceAssets = gitRecords(base, ['ls-files', '--cached', '--others', '-z', '--', 'public'])
    .filter(path => !path.endsWith('.html') && !path.endsWith('/'));
  const stale = [];
  for (const path of new Set([...previous.keys(), ...sourceAssets])) {
    if (current.has(path)) continue;
    const target = resolve(site, path);
    if (!path.startsWith('public/') || path.split('/').some(part => part === '..' || part === '.') ||
        !target.startsWith(join(site, 'public') + sep)) throw new Error('Invalid managed public path: ' + path);
    await checkedPath(base, target);
    const info = await entry(target);
    if (!info) continue;
    if (!previous.has(path) || !info.isFile() || digest(await readFile(target)) !== previous.get(path)) {
      throw new Error('Review existing site file before syncing; its source is no longer selected: ' + path);
    }
    stale.push(target);
  }

  // Save ownership before copying so an interrupted first sync can be reconciled on retry.
  const save = files => writeOutput(state, { data: JSON.stringify(Object.fromEntries(files)) + '\n', mode: 0o600 });
  await save(new Map([...previous, ...current]));
  for (const [path, file] of outputs) await writeOutput(join(site, path), file);
  for (const target of stale) await rm(target, { force: true });
  if ([...previous.keys()].some(path => !current.has(path))) await save(current);
}
