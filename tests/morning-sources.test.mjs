import test from 'node:test';
import assert from 'node:assert/strict';
import { MORNING_RESORTS, RESORTS } from '../src/config.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { ageSnapshot } from '../src/display.mjs';
import { parseRoadReports } from '../src/morning-sources.mjs';

const H = 3_600_000;
const NOW = Date.parse('2026-07-01T20:30:00Z');
const roads = { features: [{ attributes: { OBJECTID: 10, PassName: 'Stevens Pass US 2', RoadCondition: '<b>icy</b>', DisplayDate: null, TravelDirection1: 'Eastbound', PublicMessage1: 'Chains required', TravelDirection2: 'Westbound', PublicMessage2: 'No restrictions' } }] };

function stationPage(stid, observations, notice = '') {
  const temperatureKey = 'nwac:' + stid + '_air_temp';
  const depthKey = 'nwac:' + stid + '_snow_depth';
  const boardKey = 'nwac:' + stid + '_snow_depth_24h';
  const columns = [
    { key: temperatureKey, stid, source: 'nwac', variable: 'air_temp', unit: '°F' },
    { key: depthKey, stid, source: 'nwac', variable: 'snow_depth', unit: 'in' },
  ];
  if (observations.some(row => row.length > 3)) columns.push({ key: boardKey, stid, source: 'nwac', variable: 'snow_depth_24h', unit: 'in' });
  const rows = observations.map(([timestamp, depth, temperature, board]) => ({
    timestamp, values: { [temperatureKey]: temperature, [depthKey]: depth, [boardKey]: board },
  }));
  const frame = '1:' + JSON.stringify(['$', 'div', null, { columns, rows }]) + '\n';
  const notes = notice ? `<aside aria-label="Station notes">${notice}</aside>` : '';
  return new Response(notes + '<script>self.__next_f.push(' + JSON.stringify([1, frame]) + ')</script>');
}

test('WSDOT report retains missing issue time and does not infer a safe route', () => {
  const result = parseRoadReports(roads)['Stevens Pass US 2'];
  assert.equal(result.issuedAt, null);
  assert.equal(result.condition, '<b>icy</b>');
  assert.deepEqual(result.directions, [{ direction: 'Eastbound', message: 'Chains required' }, { direction: 'Westbound', message: 'No restrictions' }]);
  assert.equal(result.safe, undefined);
  assert.throws(() => parseRoadReports({ error: {} }), /road/i);
});

test('each resort selects its NWAC station and corridor, and sensor ages are independent', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(MORNING_RESORTS).map(([id, entry]) => [id, entry.station.stid])), {
    stevenspass: '50', crystalmountain: '54', summitcentral: '23', mtbaker: '5',
  });
  assert.equal(new Set(Object.values(MORNING_RESORTS).map(r => r.road.passName)).size, 4);
  const data = { sources: [{ id: 'nwac', status: 'cached', fetchedAt: NOW, refreshAfterMs: H }, { id: 'wsdot', status: 'cached', fetchedAt: NOW, refreshAfterMs: H }], stations: [], models: [], snowLevels: [], morning: {
    station: { snowfall24h: { value: 3, observedAt: NOW - 2 * H }, depth: { value: 12, observedAt: NOW - 4 * H }, temperature: { value: 34, observedAt: NOW - H } }, road: { issuedAt: null },
  } };
  const aged = ageSnapshot(data, NOW);
  assert.equal(aged.morning.station.snowfall24h?.state, 'fresh');
  assert.equal(aged.morning.station.depth.state, 'stale');
  assert.equal(aged.morning.station.temperature.state, 'fresh');
  assert.equal(aged.morning.road.reportState, 'unknown');
  assert.equal(ageSnapshot(data, NOW + 2 * H).morning.station.temperature.state, 'stale');
});

test('scheduled collection reads NWAC stations independently and dashboard reads only the cache', async t => {
  const urls = [];
  const fetchFn = async input => {
    const url = String(input); urls.push(url);
    if (url.includes('/stevens-pass-brooks')) return stationPage('50', [
      [NOW + H, 20, 35, 12],
      [NOW, -2, 34.5, -1],
      [NOW - H / 2, 0, 34, 0],
    ]);
    if (url.includes('/crystal-mt-green-valley')) return stationPage('54', [[NOW, 11, 28, 7]], 'The 24-hour snow board was removed.');
    if (url.includes('/snoqualmie-pass')) return stationPage('23', [[NOW, 4, 33]]);
    if (url.includes('TravelInfoMtPassReports')) return Response.json(roads);
    return new Response('', { status: 503 });
  };
  const runtime = createRuntime({ databasePath: ':memory:', resorts: RESORTS.slice(0, 3), now: () => NOW, fetchFn, morningEnabled: true });
  t.after(() => runtime.stop());
  const before = await runtime.loadDashboard({ resortId: 'stevenspass' });
  assert.equal(urls.length, 0);
  assert.equal(before.morning.station.depth, null);
  await runtime.collectOnce();

  assert.equal(urls.filter(url => url.startsWith('https://nwac.us/weather/stations/')).length, 3);
  assert.equal(urls.filter(url => url.includes('TravelInfoMtPassReports')).length, 1);
  assert.ok(urls.every(url => !url.includes('awdbRestApi')));
  const count = urls.length;
  const stevens = await runtime.loadDashboard({ resortId: 'stevenspass' });
  const crystal = await runtime.loadDashboard({ resortId: 'crystalmountain' });
  const summit = await runtime.loadDashboard({ resortId: 'summitcentral' });
  assert.equal(urls.length, count);
  assert.deepEqual(stevens.morning.station.snowfall24h, { value: 0, observedAt: NOW - H / 2 });
  assert.deepEqual(stevens.morning.station.depth, { value: 0, observedAt: NOW - H / 2 });
  assert.deepEqual(stevens.morning.station.temperature, { value: 34.5, observedAt: NOW });
  assert.equal(stevens.morning.road.passName, 'Stevens Pass US 2');
  assert.equal(crystal.morning.station.name, 'Campbell Basin');
  assert.equal(crystal.morning.station.depth.value, 11);
  assert.equal(crystal.morning.station.snowfall24h, null);
  assert.equal(summit.morning.station.depth.value, 4);
  assert.equal(summit.morning.station.snowfall24h, null);
  assert.equal(crystal.morning.road, null);
});

test('a failed NWAC or WSDOT refresh keeps that feed’s last reading and timestamp', async t => {
  let clock = NOW, failStation = false, failRoad = false;
  const fetchFn = async input => {
    const url = String(input);
    if (url.includes('/stevens-pass-brooks')) return stationPage('50', [[clock, failStation ? -2 : 12, failStation ? null : 32, failStation ? null : 5]]);
    if (url.includes('TravelInfoMtPassReports')) return failRoad ? new Response('', { status: 503 }) : Response.json(roads);
    return new Response('', { status: 503 });
  };
  const runtime = createRuntime({ databasePath: ':memory:', resorts: RESORTS.slice(0, 1), now: () => clock, fetchFn, morningEnabled: true });
  t.after(() => runtime.stop());
  await runtime.collectOnce();

  failRoad = true;
  clock += 31 * 60_000;
  await runtime.collectOnce();
  const roadFailure = ageSnapshot(await runtime.loadDashboard({ resortId: 'stevenspass' }), clock);
  assert.equal(roadFailure.sources.find(s => s.id === 'wsdot').status, 'stale');
  assert.equal(roadFailure.sources.find(s => s.id === 'nwac')?.status, 'cached');
  assert.equal(roadFailure.morning.road.reportState, 'unknown');
  assert.equal(roadFailure.morning.road.condition, '<b>icy</b>');
  assert.equal(roadFailure.morning.station.depth.value, 12);

  failRoad = false;
  failStation = true;
  clock += 31 * 60_000;
  await runtime.collectOnce();
  const stationFailure = ageSnapshot(await runtime.loadDashboard({ resortId: 'stevenspass' }), clock);
  assert.equal(stationFailure.sources.find(s => s.id === 'wsdot').status, 'cached');
  assert.equal(stationFailure.sources.find(s => s.id === 'nwac')?.status, 'stale');
  assert.deepEqual(stationFailure.morning.station.depth, { value: 12, observedAt: NOW, state: 'stale' });
  assert.deepEqual(stationFailure.morning.station.snowfall24h, { value: 5, observedAt: NOW, state: 'stale' });
});
