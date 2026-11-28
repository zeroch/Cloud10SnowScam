import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { createApp } from '../server.mjs';
import { createDashboardClient } from '../src/dashboard-client.mjs';
import { createSqliteCache } from '../src/sqlite-cache.mjs';
import { parseForecast } from '../src/provider-core.mjs';
import { tomorrowForecast, personalSnowQuality, comparisonSeries } from '../src/forecast.mjs';
import { overnightFixture } from './fixtures/overnight.mjs';

const IDS = ['stevenspass', 'crystalmountain', 'summitcentral', 'mtbaker'];
const H = 3_600_000, NOW = Date.parse('2026-10-18T20:00:00Z');
function forecast(value) {
  const hourly = { time: Array.from({ length: 168 }, (_, i) => NOW / 1000 + i * 3600) };
  const hourly_units = { time: 'unixtime' };
  for (const m of config.MODELS) for (const [field, unit, v] of [
    ['snowfall','inch',value], ['temperature_2m','°F',25], ['precipitation','inch',.1],
    ['wind_speed_10m','mp/h',5], ['wind_gusts_10m','mp/h',10], ['cloud_cover','%',80],
  ]) { hourly[`${field}_${m.id}`] = hourly.time.map(() => v); hourly_units[`${field}_${m.id}`] = unit; }
  return { hourly, hourly_units };
}

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cloud10-resorts-'));
  const state = { urls: [], now: NOW, fail: false };
  const fetchFn = async input => {
    const url = new URL(input); state.urls.push(url.href);
    assert.notEqual(url.host, 'nwac.us');
    if (url.host === 'api.open-meteo.com') {
      const lat = Number(url.searchParams.get('latitude'));
      const value = lat < 47 ? 2 : lat < 47.5 ? 3 : lat > 48 ? 4 : 1;
      if (state.fail && value === 2) return new Response('', { status: 503 });
      return Response.json(forecast(value));
    }
    if (url.pathname.startsWith('/points/')) {
      return Response.json({ properties: { forecastGridData: `https://api.weather.gov/gridpoints/SEW/${url.pathname.slice(8)}` } });
    }
    const lat = Number(url.pathname.split('/').at(-1).split(',')[0]);
    return Response.json({ properties: { updateTime: new Date(state.now).toISOString(), snowLevel: { uom: 'wmoUnit:ft', values: [{ validTime: `${new Date(NOW).toISOString()}/P7D`, value: lat < 47 ? 2200 : lat < 47.5 ? 2300 : lat > 48 ? 2400 : 2100 }] } } });
  };
  const runtimes = [];
  const open = () => { const r = createRuntime({ databasePath: join(dir, 'weather.sqlite'), now: () => state.now, fetchFn, ...options }); runtimes.push(r); return r; };
  t.after(async () => { for (const r of runtimes) await r.stop(); await rm(dir, { recursive: true, force: true }); });
  return { state, runtime: open(), open, databasePath: join(dir, 'weather.sqlite') };
}

test('mid-mountain collection never relabels a saved base-area forecast', async t => {
  const { runtime, state, databasePath, open } = await setup(t);
  const cache = createSqliteCache(databasePath, { clock: () => NOW });
  await cache.get('crystalmountain-forecast-v2', async () => parseForecast({ ...forecast(.1), elevation: 1341.12 }), H / 2, { now: NOW });
  await cache.get('stevenspass-forecast-v2', async () => parseForecast(forecast(1)), H / 2, { now: NOW });
  cache.close();
  const waiting = await runtime.loadDashboard({ resortId: 'crystalmountain' });
  assert.deepEqual(waiting.models, [], 'a base-area snapshot must not appear under the new elevation');
  assert.equal(waiting.sources.find(s => s.id === 'forecast').status, 'unavailable');
  assert.equal((await runtime.loadDashboard()).models[0].points[1].snowIn, 1, 'Stevens retains its existing cache');
  state.now += 30 * 60_000;
  await runtime.collectOnce();
  const requested = state.urls.filter(url => url.includes('open-meteo')).map(url => new URL(url));
  assert.deepEqual(requested.map(url => Number(url.searchParams.get('elevation'))), [1706.88,1036.32,1310.64]);
  const crystal = await runtime.loadDashboard({ resortId: 'crystalmountain' });
  assert.equal(crystal.models[0].points[1].snowIn, 2);
  assert.equal(runtime.health().resorts.crystalmountain.forecast.status, 'cached');
  await runtime.stop();
  const restarted = open();
  const calls = state.urls.length;
  await restarted.collectOnce();
  assert.equal(state.urls.length, calls, 'the new-elevation cache survives restart');
});

test('scheduled collection isolates four resort forecasts and NWS grids across restart', async t => {
  const { runtime, state, open } = await setup(t);
  await runtime.collectOnce();
  const data = await Promise.all(IDS.map(resortId => runtime.loadDashboard({ resortId, force: true })));
  assert.deepEqual(data.map(d => d.resort.id), IDS);
  assert.deepEqual(data.map(d => d.models[0].points[1].snowIn), [1,2,3,4]);
  assert.deepEqual(data.map(d => d.snowLevels[0].feet), [2100,2200,2300,2400]);
  assert.ok(data.slice(1).every(d => d.stations.length === 0 && !d.observationsEnabled));
  assert.equal(state.urls.length, 12);
  assert.equal(runtime.health().usage.openMeteoRequests24h, 4);
  assert.deepEqual(Object.keys(runtime.health().resorts), IDS);
  await runtime.stop();
  const restarted = open();
  await restarted.collectOnce();
  assert.equal(state.urls.length, 12, 'restart must honor every saved due time');
  state.now += 6 * H; state.fail = true;
  await restarted.collectOnce();
  const crystal = await restarted.loadDashboard({ resortId: 'crystalmountain' });
  assert.equal(crystal.sources.find(s => s.id === 'forecast').status, 'stale');
  assert.equal(crystal.models[0].points[1].snowIn, 2);
  assert.equal((await restarted.loadDashboard({ resortId: 'mtbaker' })).sources.find(s => s.id === 'forecast').status, 'cached');
});

test('provider cooldown applies to all resorts without losing independent NWS collection', async t => {
  const calls = [];
  const { runtime } = await setup(t, { fetchFn: async url => {
    calls.push(url);
    return new Response('', { status: 429, headers: { 'Retry-After': '3600' } });
  } });
  await runtime.collectOnce();
  assert.equal(calls.filter(u => u.includes('open-meteo')).length, 1);
  assert.equal(calls.filter(u => u.includes('api.weather.gov')).length, 1);
  const values = await Promise.all(IDS.map(resortId => runtime.loadDashboard({ resortId })));
  assert.deepEqual(values.map(d => d.resort.id), IDS);
  assert.ok(values.every(d => !d.models.length && !d.snowLevels.length));
});

test('shutdown finishes the in-flight resort without starting another network collection', async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = [];
  const { runtime } = await setup(t, { fetchFn: async url => {
    calls.push(url); await gate;
    if (url.includes('open-meteo')) return Response.json(forecast(1));
    if (url.includes('/points/')) return Response.json({ properties: { forecastGridData: 'https://api.weather.gov/gridpoints/SEW/1,1' } });
    return Response.json({ properties: { updateTime: new Date(NOW).toISOString(), snowLevel: { uom: 'wmoUnit:ft', values: [{ validTime: `${new Date(NOW).toISOString()}/P7D`, value: 2000 }] } } });
  } });
  const pending = runtime.collectOnce();
  const stopping = runtime.stop(); release();
  await pending; await stopping;
  assert.equal(calls.filter(u => u.includes('open-meteo')).length, 1);
});

test('resort APIs and deep links validate identity and reads never trigger collection', async t => {
  const { runtime, state } = await setup(t);
  const server = createApp({ load: runtime.loadDashboard, health: runtime.health, now: () => NOW });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const catalogResponse = await fetch(`${base}/api/resorts`);
  assert.equal(catalogResponse.status, 200);
  assert.deepEqual((await catalogResponse.json()).resorts.map(r => r.id), IDS);
  for (const id of IDS) {
    const data = await (await fetch(`${base}/api/resorts/${id}/dashboard?refresh=1`)).json();
    assert.equal(data.resort.id, id); assert.deepEqual(data.models, []);
    const page = await (await fetch(`${base}/location/${id}/snow-summary`)).text();
    assert.match(page, new RegExp(`data-resort="${id}"`));
    if (id !== 'stevenspass') assert.doesNotMatch(page.replace(/<select id="forecast-resort"[\s\S]*?<\/select>/, ''), /Stevens Pass|stevenspass|Brooks|stevens-pass/);
  }
  const favorites = await (await fetch(`${base}/user/favorites/locations/snow-summary?resort=summitcentral`)).text();
  assert.match(favorites, /Summit Central/);
  assert.doesNotMatch(favorites.replace(/<select id="forecast-resort"[\s\S]*?<\/select>/, ''), /Stevens Pass/);
  assert.equal((await (await fetch(`${base}/api/dashboard`)).json()).resort.id, 'stevenspass');
  for (const path of ['/api/resorts/unknown/dashboard', '/api/dashboard?resort=unknown', '/location/unknown/snow-summary', '/user/favorites?resort=unknown'])
    assert.equal((await fetch(base + path)).status, 404);
  assert.equal(state.urls.length, 0);
});

test('client refuses another resort payload and server transport only reads selected cache', async () => {
  const urls = [];
  const create = id => createDashboardClient({ resortId: id, fetchFn: async url => {
    urls.push(url);
    return Response.json({ resort: { id: 'stevenspass' }, forecastTransport: 'server', models: [] });
  } });
  await assert.rejects(create('crystalmountain')(), /resort/i);
  assert.deepEqual(urls, ['/api/resorts/crystalmountain/dashboard']);
});

test('forecast detail links keep the selected resort through reloadable Favorites and detail URLs', async () => {
  const navigation = await import('../src/navigation.mjs').catch(() => ({}));
  assert.equal(typeof navigation.forecastDetailUrl, 'function');
  const favorites = navigation.forecastDetailUrl('https://example.com/user/favorites/locations/snow-summary?resort=summitcentral&view=3days', '/location/summitcentral/snow-summary?night=2026-10-18#live-daily', 'summitcentral');
  assert.equal(favorites.href, 'https://example.com/user/favorites/locations/snow-summary?night=2026-10-18&resort=summitcentral#live-daily');
  const detail = navigation.forecastDetailUrl('https://example.com/location/mtbaker/snow-summary?view=outlook', '/location/mtbaker/snow-summary?night=2026-10-18#live-daily', 'mtbaker');
  assert.equal(detail.href, 'https://example.com/location/mtbaker/snow-summary?night=2026-10-18#live-daily');
});

test('each resort condition and reference chart use its own elevation bands', () => {
  assert.equal(typeof config.getResort, 'function');
  const d = overnightFixture({ totals: [6,6,6,6,6] });
  const now = d.generatedAt;
  d.snowLevels.forEach(p => { p.feet = 3000; });
  d.resort = config.getResort('summitcentral');
  const central = tomorrowForecast(d, now, 'tonight');
  assert.equal(central.condition.key, 'wet');
  assert.equal(personalSnowQuality(d, central).key, 'wet');
  d.resort = config.getResort('crystalmountain');
  assert.equal(tomorrowForecast(d, now, 'tonight').condition.key, 'normal');
  const chart = comparisonSeries(d, [], 'level', now, now + H);
  assert.deepEqual(chart.references, [2800,4800]);
});

test('rendered forecasts and evidence link only to the selected resort', async () => {
  assert.equal(typeof config.getResort, 'function');
  const source = (await readFile(new URL('../public/clone/live-view.mjs', import.meta.url), 'utf8'))
    .replaceAll(/from '\/lib\/([^']+)'/g, (_, file) => `from '${new URL('../src/' + file, import.meta.url).href}'`);
  const view = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const data = overnightFixture(); data.resort = config.getResort('summitcentral');
  const state = { now: data.generatedAt, horizon: 3, nightChoice: 'tonight', days: 3, ids: data.models.map(m => m.id), start: data.generatedAt, end: data.generatedAt + 72 * H, metric: 'snow', index: 0 };
  for (const renderer of [view.horizon, view.outlook, view.daily, view.comparison]) {
    const html = renderer(data, state);
    assert.doesNotMatch(html, /Brooks|Stevens Pass|stevenspass|stevens-pass/);
  }
  assert.match(view.horizon(data, state), /\/location\/summitcentral\/snow-summary/);
});
