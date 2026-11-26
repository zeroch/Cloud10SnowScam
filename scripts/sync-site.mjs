import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedFiles, writeOutput } from './tracked-files.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const site = join(root, 'sites/clould10');
const pages = new Map([
  ['public/clone/favorites.html', 'content/favorites.html'],
  ['public/clone/stevens.html', 'content/stevens.html'],
  ['public/index.html', 'content/desk.html'],
]);
const browserModules = ['conditions', 'time', 'display', 'advice', 'forecast', 'dashboard-client', 'config', 'provider-core'];
const fixture = 'tests/fixtures/forecast.json';
const clientTest = 'tests/dashboard-client.test.mjs';
const inputs = await trackedFiles(root, {
  required: [...pages.keys(), ...browserModules.map(name => 'src/' + name + '.mjs'), fixture, clientTest],
  directories: ['public'],
  include: path => !path.endsWith('.html'),
});

for (const [path, file] of inputs) {
  if (path.startsWith('public/')) await writeOutput(join(site, pages.get(path) ?? path), file);
}
for (const name of browserModules) {
  const file = inputs.get('src/' + name + '.mjs');
  await writeOutput(join(site, 'weather/shared', name + '.mjs'), file);
  await writeOutput(join(site, 'public/lib', name + '.mjs'), file);
}
await writeOutput(join(site, fixture), inputs.get(fixture));
const test = inputs.get(clientTest);
await writeOutput(join(site, clientTest), { ...test, data: test.data.toString('utf8').replaceAll('../src/', '../weather/shared/') });
console.log('Synced Clould10 pages, assets, and shared weather logic into the Site checkout.');
