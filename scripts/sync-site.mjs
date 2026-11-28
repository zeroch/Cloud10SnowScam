import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncSiteOutputs } from './site-sync-output.mjs';
import { trackedFiles } from './tracked-files.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pages = new Map([
  ['public/clone/favorites.html', 'content/favorites.html'],
  ['public/clone/stevens.html', 'content/stevens.html'],
  ['public/index.html', 'content/desk.html'],
]);
const browserModules = ['conditions', 'time', 'display', 'advice', 'forecast', 'hourly-forecast', 'dashboard-client', 'config', 'provider-core'];
const fixture = 'tests/fixtures/forecast.json';
const clientTest = 'tests/dashboard-client.test.mjs';
const inputs = await trackedFiles(root, {
  required: [...pages.keys(), ...browserModules.map(name => 'src/' + name + '.mjs'), fixture, clientTest],
  directories: ['public'],
  include: path => !path.endsWith('.html'),
});

const outputs = new Map();
for (const [path, file] of inputs) {
  if (path.startsWith('public/')) outputs.set(pages.get(path) ?? path, file);
}
for (const name of browserModules) {
  const file = inputs.get('src/' + name + '.mjs');
  outputs.set('weather/shared/' + name + '.mjs', file);
  outputs.set('public/lib/' + name + '.mjs', file);
}
outputs.set(fixture, inputs.get(fixture));
const test = inputs.get(clientTest);
outputs.set(clientTest, { ...test, data: test.data.toString('utf8').replaceAll('../src/', '../weather/shared/') });
await syncSiteOutputs(root, outputs);
console.log('Synced Clould10 pages, assets, and shared weather logic into the Site checkout.');
