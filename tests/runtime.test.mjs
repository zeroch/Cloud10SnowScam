import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { RESORT } from '../src/config.mjs';
const module = await import('../src/runtime.mjs').catch(() => ({}));
const H = 3_600_000, INITIAL = Date.parse('2026-10-15T12:00:00Z');

function forecast(now) {
  const ids = ['ecmwf_ifs025', 'gfs_global', 'icon_global', 'gem_global', 'gfs_hrrr'];
  const hourly = { time: Array.from({ length: 168 }, (_, i) => Math.floor(now / H) * 3600 + i * 3600) };
  const units = { time: 'unixtime' };
  for (const id of ids) for (const [field, unit, value] of [
    ['snowfall', 'inch', 0.5], ['temperature_2m', '°F', 25], ['precipitation', 'inch', 0.05],
    ['wind_speed_10m', 'mp/h', 5], ['wind_gusts_10m', 'mp/h', 10], ['cloud_cover', '%', 80],
  ]) {
    hourly[`${field}_${id}`] = hourly.time.map((_, i) => id === 'gfs_hrrr' && i > 30 ? null : value);
    units[`${field}_${id}`] = unit;
  }
  return { latitude: 47.74, longitude: -121.1, elevation: 1463, hourly, hourly_units: units };
}

async function setup(t, options = {}) {
  assert.equal(typeof module.createRuntime, 'function', 'Scheduled runtime must exist');
  const dir = await mkdtemp(join(tmpdir(), 'cloud10-runtime-'));
  const state = { now: INITIAL, urls: [], bad: false, nwsEmpty: false, nwsOld: false, pointLimited: false };
  const fetchFn = async url => {
    state.urls.push(String(url));
    assert.doesNotMatch(String(url), /nwac\.us/);
    if (String(url).includes('open-meteo')) return new Response(JSON.stringify(state.bad ? forecast(INITIAL - 30 * 24 * H) : forecast(state.now)));
    if (String(url).includes('/points/')) return state.pointLimited ? new Response('', { status: 429, headers: { 'Retry-After': '7200' } }) : Response.json({ properties: { forecastGridData: 'https://api.weather.gov/gridpoints/SEW/123,45' } });
    return Response.json({ properties: { updateTime: new Date(state.nwsOld ? INITIAL - 30 * 24 * H : state.now).toISOString(), snowLevel: { uom: 'wmoUnit:ft', values: [{ validTime: `${new Date(state.now).toISOString()}/P7D`, value: state.nwsEmpty ? null : 2000 }] } } });
  };
  const runtimes = [];
  const open = () => { const r = module.createRuntime({ databasePath: join(dir, 'weather.sqlite'), resorts: [RESORT], now: () => state.now, fetchFn, ...options }); runtimes.push(r); return r; };
  t.after(async () => { for (const r of runtimes) await r.stop(); await rm(dir, { recursive: true, force: true }); });
  return { state, open, runtime: open() };
}

test('dashboard reads including forced refresh cannot collect and NWAC is disabled', async t => {
  const { runtime, state } = await setup(t);
  const empty = await runtime.loadDashboard({ force: true, now: state.now });
  assert.equal(empty.models.length, 0);
  assert.equal(state.urls.length, 0);
  assert.equal(empty.sources.filter(s => s.status === 'disabled').length, 3);
  assert.ok(empty.stations.every(s => s.sourceState === 'disabled' && s.rows.length === 0));
  await runtime.collectOnce();
  assert.equal(state.urls.length, 3);
  const server = createApp({ load: runtime.loadDashboard, health: runtime.health, now: () => state.now });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = await Promise.all(Array.from({ length: 40 }, () => fetch(`${base}/api/dashboard?refresh=1`).then(r => r.json())));
  assert.equal(state.urls.length, 3);
  assert.ok(results.every(d => d.models.length === 5 && d.forecastTransport === 'server'));
  assert.equal(results[0].sources.find(s => s.id === 'forecast').snapshotId > 0, true);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.storage, 'sqlite');
  assert.equal(health.nwacEnabled, false);
  assert.equal(health.usage.openMeteoRequests24h, 1);
  assert.equal((await fetch(`${base}/data/weather.sqlite`)).status, 404);
});

test('scheduler collects without visitors and respects persisted due times after reopening', async t => {
  const { runtime, state, open } = await setup(t, { tickMs: 20 });
  runtime.start();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(state.urls.filter(u => u.includes('open-meteo')).length, 1);
  await runtime.stop();
  const restarted = open();
  await restarted.collectOnce();
  assert.equal(state.urls.filter(u => u.includes('open-meteo')).length, 1);
  state.now += 30 * 60_000;
  await restarted.collectOnce();
  assert.equal(state.urls.filter(u => u.includes('open-meteo')).length, 2);
  assert.equal(state.urls.filter(u => u.includes('/gridpoints/')).length, 1);
  const snapshot = await restarted.loadDashboard();
  assert.equal(snapshot.sources.find(s => s.id === 'forecast').fetchedAt, state.now);
});

test('expired provider payload is rejected and the original snapshot remains stale', async t => {
  const { runtime, state } = await setup(t);
  await runtime.collectOnce();
  state.now += H; state.bad = true;
  await runtime.collectOnce();
  const result = await runtime.loadDashboard();
  const source = result.sources.find(s => s.id === 'forecast');
  assert.equal(source.status, 'stale');
  assert.equal(source.fetchedAt, INITIAL);
  assert.match(source.error, /coverage|expired/i);
  assert.equal(result.models[0].points[1].snowIn, 0.5);
});

test('disabled NWAC does not call or read its cache', async () => {
  const { createDashboardLoader } = await import('../src/provider-core.mjs');
  const keys = [];
  const data = await createDashboardLoader({ get: async key => { keys.push(key); return { data: null, status: 'unavailable' }; } }, { nwacEnabled: false })();
  assert.deepEqual(keys.sort(), ['nws', 'stevenspass-forecast-v2']);
  assert.equal(data.observationsEnabled, false);
  assert.ok(data.stations.every(s => s.rows.length === 0));
});

test('empty or old NWS grids preserve the last usable snow-level snapshot', async t => {
  const { runtime, state } = await setup(t);
  await runtime.collectOnce();
  state.now += H; state.nwsEmpty = true;
  await runtime.collectOnce();
  let data = await runtime.loadDashboard();
  assert.equal(data.sources.find(s => s.id === 'nws').status, 'stale');
  assert.equal(data.sources.find(s => s.id === 'nws').fetchedAt, INITIAL);
  assert.equal(data.snowLevels[0].feet, 2000);
  state.now += H; state.nwsEmpty = false; state.nwsOld = true;
  await runtime.collectOnce();
  data = await runtime.loadDashboard();
  assert.equal(data.sources.find(s => s.id === 'nws').fetchedAt, INITIAL);
  assert.equal(data.snowLevels[0].feet, 2000);
});

test('NWS point Retry-After prevents a chained grid fetch using an old mapping', async t => {
  const { runtime, state } = await setup(t);
  await runtime.collectOnce();
  state.now += 7 * 24 * H; state.pointLimited = true;
  await runtime.collectOnce();
  assert.equal(state.urls.filter(u => u.includes('/gridpoints/')).length, 1);
  const nws = (await runtime.loadDashboard()).sources.find(s => s.id === 'nws');
  assert.equal(nws.status, 'stale');
  assert.equal(nws.nextAttemptAt, state.now + 2 * H);
});

test('disabled observations are intentional in UI and do not hide usable overnight models', async () => {
  const { buildAdvice } = await import('../src/advice.mjs');
  const data = { models: [], stations: [], sources: [], observationsEnabled: false, snowLevels: [] };
  const advice = buildAdvice(data, INITIAL);
  assert.match(advice.now.headline, /disabled/i);
  const source = (await readFile(new URL('../public/clone/live-view.mjs', import.meta.url), 'utf8'))
    .replaceAll(/from '\/lib\/([^']+)'/g, (_, file) => `from '${new URL('../src/' + file, import.meta.url).href}'`);
  const view = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.match(view.stations(data, { now: INITIAL }), /NWAC observations are disabled/);
});
