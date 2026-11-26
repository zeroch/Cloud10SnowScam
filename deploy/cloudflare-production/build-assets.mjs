import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

// Render through the release's actual HTTP router to preserve per-resort HTML.
// The loader is deliberately empty. No weather and no local database are uploaded.
const source = resolve(process.argv[2] || '.');
const destination = resolve(process.argv[3] || 'dist/cloudflare-production');
const { createApp, browserLibraryPaths } = await import(pathToFileURL(join(source, 'server.mjs')));
const { RESORTS } = await import(pathToFileURL(join(source, 'src/config.mjs')));
const server = createApp({ load() { throw Error('Unexpected API request during asset export'); } });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
const manifest = [];

async function save(route, asset = route.slice(1)) {
  const response = await fetch(base + route);
  if (!response.ok) throw Error('Cannot export ' + route + ' (' + response.status + ')');
  const data = Buffer.from(await response.arrayBuffer());
  const file = join(destination, 'assets', asset);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  manifest.push({ route, asset, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}

try {
  await save('/', 'index.html');
  await save('/desk', 'pages/desk.body');
  for (const resort of RESORTS) {
    await save('/?resort=' + resort.id, 'pages/favorites-' + resort.id + '.body');
    await save('/location/' + resort.id + '/snow-summary', 'pages/detail-' + resort.id + '.body');
  }
  const paths = ['/app.mjs', '/charts.mjs', '/styles.css', '/favicon.svg'];
  const legacyLibraries = ['conditions', 'time', 'display', 'advice', 'forecast', 'dashboard-client',
    'provider-core', 'config', 'navigation', 'resort-comparison'];
  paths.push(...(browserLibraryPaths ?? legacyLibraries.map(name => '/lib/' + name + '.mjs')));
  const types = new Set(['.html', '.mjs', '.css', '.json', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.woff', '.woff2']);
  async function walk(directory) {
    for (const entry of await readdir(join(source, 'public', directory), { withFileTypes: true })) {
      const relative = directory + '/' + entry.name;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile() && types.has(extname(relative))) paths.push('/' + relative);
    }
  }
  await walk('clone');
  // The dashboard static uploader treats loose JavaScript files as a Worker
  // entry point. Store these prebuilt browser modules as bytes and let the
  // application Worker supply the release's original path and MIME type.
  for (const path of paths.sort()) await save(path, path.slice(1).replace(/\.(html|mjs)$/, '.$1.body'));
  // Only the public production Worker maps these artifacts to application URLs.
  // A static-only assets Worker can also be bound as ASSETS.
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(destination + ' · ' + manifest.length + ' release responses');
} finally {
  server.close();
}
