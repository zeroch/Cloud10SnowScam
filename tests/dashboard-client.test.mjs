import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDashboardLoader } from '../src/provider-core.mjs';

const weather = JSON.parse(await readFile(new URL('./fixtures/forecast.json', import.meta.url), 'utf8'));
const base = { forecastTransport: 'browser', resort: { id: 'stevenspass' }, models: [], stations: [], snowLevels: [], sources: [{ id: 'forecast', status: 'unavailable', fetchedAt: null, error: null }, { id: 'nws', status: 'fresh', fetchedAt: 100_000 }] };
const storage = () => { const map = new Map(); return { getItem: k => map.get(k), setItem: (k, v) => map.set(k, v) }; };
async function implementation() {
  const module = await import('../src/dashboard-client.mjs').catch(() => ({}));
  assert.equal(typeof module.createDashboardClient, 'function', 'browser forecast transport is implemented');
  return module.createDashboardClient;
}

test('hosted browser mode never requests a forecast from the cloud server', async () => {
  const cache = { async get(key) {
    assert.ok(!key.includes('forecast'), 'browser mode must not consume the shared server forecast quota');
    return { data: null, fetchedAt: null, status: 'unavailable', error: 'fixture offline' };
  } };
  const result = await createDashboardLoader(cache, { forecastTransport: 'browser' })();
  assert.equal(result.forecastTransport, 'browser');
});

test('browser model forecasts retain their original retrieval time across page loads', async () => {
  const create = await implementation(), saved = storage();
  let calls = 0;
  const fetchFn = async url => {
    if (url.startsWith('/api/')) return Response.json(base);
    assert.equal(new URL(url).host, 'api.open-meteo.com');
    calls++; return Response.json(weather);
  };
  const first = await create({ fetchFn, storage: saved, now: () => 100_000 })();
  const second = await create({ fetchFn, storage: saved, now: () => 120_000 })(true);
  assert.equal(first.models.length, 4);
  assert.equal(second.models.length, 4);
  assert.equal(second.sources[0].fetchedAt, 100_000);
  assert.equal(second.sources[0].status, 'cached');
  assert.equal(second.sources[1].status, 'fresh');
  assert.equal(calls, 1);
});

test('a browser rate limit preserves stale data and respects Retry-After across reloads', async () => {
  const create = await implementation(), saved = storage();
  let time = 100_000, calls = 0;
  const fetchFn = async url => {
    if (url.startsWith('/api/')) return Response.json(base);
    calls++;
    return calls === 1 ? Response.json(weather) : new Response('Rate limited', { status: 429, headers: { 'Retry-After': '3600' } });
  };
  const load = create({ fetchFn, storage: saved, now: () => time });
  await load();
  time = 2_000_000;
  const failed = await load();
  assert.equal(failed.sources[0].status, 'stale');
  assert.equal(failed.sources[0].fetchedAt, 100_000);
  assert.equal(failed.models.length, 4);
  time += 400_000;
  const reloaded = await create({ fetchFn, storage: saved, now: () => time })(true);
  assert.equal(reloaded.sources[0].status, 'stale');
  assert.match(reloaded.sources[0].error, /429/);
  assert.equal(calls, 2, 'manual refresh cannot bypass the provider retry interval');
});

test('a first-use browser failure stays unavailable while station data remains usable', async () => {
  const create = await implementation();
  const result = await create({ storage: storage(), now: () => 100_000,
    fetchFn: async url => url.startsWith('/api/') ? Response.json(base) : new Response('offline', { status: 503 }),
  })();
  assert.deepEqual(result.models, []);
  assert.equal(result.sources[0].status, 'unavailable');
  assert.equal(result.sources[0].fetchedAt, null);
  assert.equal(result.sources[1].status, 'fresh');
});

test('the local server transport does not trigger an additional browser source request', async () => {
  const create = await implementation();
  const local = { ...base, forecastTransport: 'server', models: [{ id: 'existing' }] };
  const result = await create({ storage: storage(), fetchFn: async url => {
    assert.ok(url.startsWith('/api/'), 'local forecasts already come from the local server');
    return Response.json(local);
  } })();
  assert.deepEqual(result.models, local.models);
});
