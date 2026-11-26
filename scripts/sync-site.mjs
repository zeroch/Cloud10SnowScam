import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = join(root, 'sites/clould10');
async function copyAssets(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyAssets(join(source, entry.name), join(destination, entry.name));
    else if (!entry.name.endsWith('.html')) await cp(join(source, entry.name), join(destination, entry.name));
  }
}
await copyAssets(join(root, 'public'), join(site, 'public'));
await mkdir(join(site, 'content'), { recursive: true });
for (const [from, to] of [['clone/favorites.html', 'favorites'], ['clone/stevens.html', 'stevens'], ['index.html', 'desk']]) {
  await cp(join(root, 'public', from), join(site, 'content', `${to}.html`));
}
const browserModules = ['conditions', 'time', 'display', 'advice', 'forecast', 'dashboard-client', 'config', 'provider-core'];
await mkdir(join(site, 'public/lib'), { recursive: true });
await mkdir(join(site, 'weather/shared'), { recursive: true });
for (const name of browserModules) {
  await cp(join(root, `src/${name}.mjs`), join(site, `weather/shared/${name}.mjs`));
  if (browserModules.includes(name)) await cp(join(root, `src/${name}.mjs`), join(site, `public/lib/${name}.mjs`));
}
await mkdir(join(site, 'tests/fixtures'), { recursive: true });
await cp(join(root, 'tests/fixtures/forecast.json'), join(site, 'tests/fixtures/forecast.json'));
await writeFile(join(site, 'tests/dashboard-client.test.mjs'),
  (await readFile(join(root, 'tests/dashboard-client.test.mjs'), 'utf8')).replaceAll('../src/', '../weather/shared/'));
console.log('Synced Clould10 pages, assets, and shared weather logic into the Site checkout.');
