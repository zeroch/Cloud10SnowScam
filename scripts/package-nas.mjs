import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedFiles, writeOutput } from './tracked-files.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readme = 'docs/deployment/nas.md';
const inputs = await trackedFiles(root, {
  required: ['Dockerfile', 'compose.yaml', '.dockerignore', 'LICENSE', 'package.json', 'server.mjs',
    'deploy/cloudflare-pilot/worker.mjs', 'deploy/cloudflare-pilot/schema.sql', readme],
  directories: ['src', 'public', 'tests'],
  include: path => basename(path) !== '.DS_Store',
});

const dist = join(root, 'dist');
await mkdir(dist, { recursive: true });
const staging = await mkdtemp(join(dist, '.nas-'));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z');
const name = 'cloud10-nas-' + stamp + '-' + basename(staging).slice('.nas-'.length);
const directory = join(dist, name);
const archive = directory + '.zip';
try {
  const manifest = [];
  for (const [source, file] of inputs) {
    const path = source === readme ? 'NAS-README.md' : source;
    await writeOutput(join(staging, name, path), file);
    manifest.push({ path, sha256: createHash('sha256').update(file.data).digest('hex') });
  }
  await writeFile(join(staging, name, 'manifest.json'),
    JSON.stringify({ application: 'Cloud10', version: '0.3.0', builtAt: new Date().toISOString(), files: manifest }, null, 2) + '\n');
  // zip updates an existing archive in place. Always run it in the fresh staging directory.
  execFileSync('zip', ['-qr', name + '.zip', name], { cwd: staging });
  await rename(join(staging, name), directory);
  try {
    await rename(join(staging, name + '.zip'), archive);
  } catch (error) {
    await rm(directory, { recursive: true });
    throw error;
  }
  console.log(JSON.stringify({ directory, archive, files: manifest.length }));
} finally {
  await rm(staging, { recursive: true, force: true });
}
