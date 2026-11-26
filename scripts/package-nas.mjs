import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z');
const name = `cloud10-nas-${stamp}`;
const directory = join(root, 'dist', name);
await mkdir(directory, { recursive: true });
const included = [
  'Dockerfile', 'compose.yaml', '.dockerignore', 'LICENSE', 'package.json', 'server.mjs', 'src', 'public', 'tests',
  'deploy/cloudflare-pilot/worker.mjs', 'deploy/cloudflare-pilot/schema.sql',
];
for (const path of included) await cp(join(root, path), join(directory, path), { recursive: true, filter: path => !path.endsWith('.DS_Store') });
await cp(join(root, 'docs/deployment/nas.md'), join(directory, 'NAS-README.md'));
const manifest = [];
async function walk(relative = '') {
  for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
    const path = join(relative, item.name);
    if (item.isDirectory()) await walk(path);
    else if (item.isFile()) manifest.push({ path, sha256: createHash('sha256').update(await readFile(join(directory, path))).digest('hex') });
    else throw new Error(`Unexpected package entry: ${path}`);
  }
}
await walk();
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ application: 'Cloud10', version: '0.3.0', builtAt: new Date().toISOString(), files: manifest }, null, 2) + '\n');
execFileSync('zip', ['-qr', `${name}.zip`, name], { cwd: join(root, 'dist') });
console.log(JSON.stringify({ directory, archive: join(root, 'dist', `${name}.zip`), files: manifest.length }));
