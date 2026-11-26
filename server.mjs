import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, join } from 'node:path';
import { createRuntime } from './src/runtime.mjs';
import { buildAdvice } from './src/advice.mjs';
import { RESORT, RESORTS, getResort } from './src/config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['public/clone/favorites.html', 'text/html']], ['/index.html', ['public/clone/favorites.html', 'text/html']],
  ['/desk', ['public/index.html', 'text/html']],
  ['/user/favorites', ['public/clone/favorites.html', 'text/html']],
  ['/user/favorites/locations/snow-summary', ['public/clone/favorites.html', 'text/html']],
  ['/location/stevenspass/snow-summary', ['public/clone/stevens.html', 'text/html']],
  ['/app.mjs', ['public/app.mjs', 'text/javascript']], ['/charts.mjs', ['public/charts.mjs', 'text/javascript']],
  ['/styles.css', ['public/styles.css', 'text/css']], ['/favicon.svg', ['public/favicon.svg', 'image/svg+xml']],
  ['/lib/conditions.mjs', ['src/conditions.mjs', 'text/javascript']], ['/lib/time.mjs', ['src/time.mjs', 'text/javascript']],
  ['/lib/display.mjs', ['src/display.mjs', 'text/javascript']], ['/lib/advice.mjs', ['src/advice.mjs', 'text/javascript']],
  ['/lib/forecast.mjs', ['src/forecast.mjs', 'text/javascript']],
  ['/lib/dashboard-client.mjs', ['src/dashboard-client.mjs', 'text/javascript']],
  ['/lib/provider-core.mjs', ['src/provider-core.mjs', 'text/javascript']],
  ['/lib/config.mjs', ['src/config.mjs', 'text/javascript']],
  ['/lib/i18n.mjs', ['src/i18n.mjs', 'text/javascript']],
  ['/lib/navigation.mjs', ['src/navigation.mjs', 'text/javascript']],
  ['/lib/resort-comparison.mjs', ['src/resort-comparison.mjs', 'text/javascript']],
]);
// Used by the static release exporter as well as the Node router.
export const browserLibraryPaths = [...files.keys()].filter(path => path.startsWith('/lib/'));
const cloneTypes = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2' };
// Register exact public paths once; request paths never become filesystem paths.
function registerCloneFiles(directory = 'public/clone') {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) registerCloneFiles(path);
    else if (entry.isFile() && cloneTypes[extname(path)]) files.set(path.replace(/^public/, ''), [path, cloneTypes[extname(path)]]);
  }
}
registerCloneFiles();
function resortPage(html, resort) {
  const point = `${resort.pointLabel} ${resort.elevationFt.toLocaleString('en-US')} ft`;
  const control = `<div class="cloud-resort-control"><label for="forecast-resort">Mountain</label><select id="forecast-resort" data-resort-select>${RESORTS.map(r => `<option value="${r.id}"${r.id === resort.id ? ' selected' : ''}>${r.name}${r.id === 'summitcentral' ? ' · Snoqualmie' : ''}</option>`).join('')}</select></div>`;
  return html.replace('<body ', `<body data-resort="${resort.id}" `)
    .replaceAll('Stevens Pass', resort.name)
    .replaceAll('/location/stevenspass/snow-summary', `/location/${resort.id}/snow-summary`)
    .replaceAll('Brooks 4,800 ft', point)
    .replaceAll(RESORT.camerasUrl, resort.camerasUrl)
    .replace('Snow stake, base area and upper-mountain views.', 'The resort’s current report and mountain views.')
    .replace('<!-- cloud-resort-control -->', control);
}
export function createApp({ load, health = () => ({ ok: true, application: 'Cloud10', version: '0.3.0' }), now = Date.now } = {}) {
  if (typeof load !== 'function') throw new Error('A read-only dashboard loader is required');
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const send = (status, body, type = 'application/json') => { response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); response.end(body); };
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); return send(405, JSON.stringify({ error: 'Read-only service' })); }
      if (url.pathname === '/api/health') { const state = health(); return send(state.ok ? 200 : 503, JSON.stringify(state)); }
      if (url.pathname === '/api/resorts') return send(200, JSON.stringify({ resorts: RESORTS }));
      const resortApi = /^\/api\/resorts\/([^/]+)\/dashboard$/.exec(url.pathname);
      if (url.pathname === '/api/dashboard' || resortApi) {
        const resort = getResort(resortApi?.[1] ?? url.searchParams.get('resort') ?? RESORT.id);
        if (!resort) return send(404, JSON.stringify({ error: 'Unknown resort' }));
        const timestamp = now();
        const data = await load({ now: timestamp, resortId: resort.id });
        return send(200, JSON.stringify({ ...data, generatedAt: timestamp, advice: buildAdvice(data, timestamp) }));
      }
      const resortRoute = /^\/location\/([^/]+)\/snow-summary$/.exec(url.pathname);
      const favoritesPage = ['/', '/index.html', '/user/favorites', '/user/favorites/locations/snow-summary'].includes(url.pathname);
      const comparePage = favoritesPage && !url.searchParams.has('resort');
      const forecastPage = resortRoute || (favoritesPage && !comparePage);
      const resort = forecastPage && getResort(resortRoute?.[1] ?? url.searchParams.get('resort') ?? RESORT.id);
      if (forecastPage && !resort) return send(404, JSON.stringify({ error: 'Unknown resort' }));
      const file = comparePage ? ['public/clone/resort-comparison.html', 'text/html'] : resortRoute ? ['public/clone/stevens.html', 'text/html'] : files.get(url.pathname);
      if (!file) return send(404, JSON.stringify({ error: 'Not found' }));
      const body = request.method === 'HEAD' ? '' : await readFile(join(root, file[0]));
      return send(200, forecastPage ? resortPage(String(body), resort) : body, file[1]);
    } catch (error) {
      console.error('Request failed:', error.message);
      send(503, JSON.stringify({ error: 'The dashboard could not refresh. Please try again.' }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 4173);
  const runtime = createRuntime({ databasePath: process.env.DATABASE_PATH || join(root, 'data/weather.sqlite'), nwacEnabled: process.env.NWAC_ENABLED === 'true', morningEnabled: true, log: console.log });
  const server = createApp({ load: runtime.loadDashboard, health: runtime.health });
  server.listen(port, host, () => { runtime.start(); console.log(`Cloud10 is ready at http://${host}:${port}; scheduled collection with nearby NWAC readings. Additional Stevens Pass NWAC feeds ${process.env.NWAC_ENABLED === 'true' ? 'enabled' : 'disabled'}`); });
  server.on('error', async error => { console.error(error.message); await runtime.stop(); process.exitCode = 1; });
  let closing = false;
  async function shutdown() {
    if (closing) return; closing = true;
    const deadline = setTimeout(() => process.exit(1), 40_000); deadline.unref();
    server.close(); server.closeIdleConnections();
    await runtime.stop(); clearTimeout(deadline);
  }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
