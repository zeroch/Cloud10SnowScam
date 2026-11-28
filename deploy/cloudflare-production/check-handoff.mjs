import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESORTS, resortCacheKey } from '../../src/config.mjs';

const { collectProduction, handleProduction, runScheduled } = await import(pathToFileURL(resolve(process.argv[2])));
const sql = new DatabaseSync(':memory:');
for (const file of ['../cloudflare-pilot/schema.sql', './schema.sql']) sql.exec(readFileSync(new URL(file, import.meta.url), 'utf8'));
function prepare(query, args = []) {
  const statement = sql.prepare(query);
  return { bind: (...values) => prepare(query, values), first: () => statement.get(...args),
    run: () => statement.run(...args), all: () => ({ results: statement.all(...args) }) };
}
const db = { prepare, batch: statements => {
  sql.exec('BEGIN');
  try { const values = statements.map(item => item.run()); sql.exec('COMMIT'); return values; }
  catch (error) { sql.exec('ROLLBACK'); throw error; }
} };
const start = Date.parse('2026-11-26T05:52:18Z'), minute = 60_000, hour = 60 * minute;
sql.prepare('INSERT INTO pilot_window VALUES(1,?)').run(start);
const run = (time, upstream) => collectProduction(db, time, upstream, () => time);
let calls = 0;
const limited = () => { calls++; return new Response('busy', { status: 429, headers: { 'Retry-After': '3600' } }); };
await run(start, limited);
assert.equal(calls, 0);

const stationTime = start + 39 * minute;
const stid = '50', key = 'nwac:50_snow_depth';
const columns = [{ key, stid, source: 'nwac', variable: 'snow_depth', unit: 'in' },
  { key: 'air', stid, source: 'nwac', variable: 'air_temp', unit: '°F' }];
const rows = [{ timestamp: stationTime, values: { [key]: 0, air: 32 } }];
const frame = '1:' + JSON.stringify({ columns, rows }) + '\n';
const station = () => new Response('<script>self.__next_f.push(' + JSON.stringify([1, frame]) + ')</script>');
await run(stationTime, station);
const env = { DB: db, ASSETS: { fetch: request => new Response(new URL(request.url).pathname) } };
const get = (path, now = stationTime) => handleProduction(new Request('https://release.example' + path), env, now);
sql.prepare('INSERT INTO pilot_cycles(slot,scheduled_ms,finished_ms) VALUES(0,?,?)').run(start, start + 1000);
const health = await (await get('/api/health')).json();
assert.equal(health.collector.running, true);
assert.equal(health.collector.lastScheduledAt, start);
assert.equal(health.collector.productionLastScheduledAt, stationTime);
const reading = await (await get('/api/dashboard')).json();
assert.deepEqual(reading.morning.station.depth, { value: 0, observedAt: stationTime });
assert.equal(reading.morning.station.snowfall24h, null);
assert.equal((await get('/?resort=mtbaker')).headers.get('content-type'), 'text/html; charset=utf-8');
assert.equal(await (await get('/?resort=mtbaker')).text(), '/pages/favorites-mtbaker.body');
assert.equal(await (await get('/location/mtbaker/snow-summary')).text(), '/pages/detail-mtbaker.body');
assert.equal((await get('/lib/forecast.mjs')).headers.get('content-type'), 'text/javascript; charset=utf-8');
assert.equal((await get('/location/unknown/snow-summary')).status, 404);

const handoff = Math.floor(start / minute) * minute + 24 * hour;
const productionStart = handoff + 30 * minute;
const trialStations = time => runScheduled({ cron: '31-34 * 26,27 NOV *', scheduledTime: time }, db, limited, () => time);
await trialStations(start);
await trialStations(stationTime + 24 * hour);
await trialStations(stationTime + 365 * 24 * hour);
assert.equal(calls, 0, 'finite station schedule never collects forecasts or operates beyond its deadline');
await run(productionStart - 6 * hour, limited);
assert.equal(calls, 0);
const historical = sql.prepare('INSERT INTO pilot_attempts (slot,provider,source_key,request_ms,status,outcome,retry_until) VALUES(47,?,?,?,?,?,?)');
historical.run('open-meteo','stevenspass-forecast-v2',handoff - 30 * minute,429,'http',productionStart + 30_000);
await run(productionStart + 1000, limited);
assert.equal(calls, 0, 'provider cooldown survives handoff to the first production cycle');
await run(productionStart + 61_000, limited);
await run(productionStart + 61_000, limited);
await run(productionStart + 121_000, limited);
assert.equal(calls, 1, 'one accepted request, despite replay and a second resort');
assert.equal(sql.prepare('SELECT count(*) n FROM pilot_attempts').get().n, 1, 'production leaves pilot telemetry intact');

const hosts = [];
const unavailable = url => {
  hosts.push(new URL(url).hostname);
  return new Response(null, { status: 503 });
};
for (const offset of [30 * minute, 38 * minute, hour, hour + 9 * minute]) {
  await run(productionStart + offset, unavailable);
}
assert.deepEqual(hosts, [], 'old forecast, road and station cron ticks make no upstream requests');

const saveForecast = sql.prepare('INSERT INTO pilot_latest (source_key,slot,fetched_ms,payload) VALUES (?,?,?,?)');
const saveAttempt = sql.prepare("INSERT INTO production_attempts (slot,provider,source_key,request_ms,status,outcome) VALUES (48,'open-meteo',?,?,200,'ok')");
for (const resort of RESORTS) {
  const sourceKey = resortCacheKey(resort, 'forecast');
  saveForecast.run(sourceKey, 48, productionStart, '{"models":[],"grid":null}');
  saveAttempt.run(sourceKey, productionStart);
}
const betweenCycles = productionStart + 5 * hour;
await run(Math.floor(betweenCycles / hour) * hour, unavailable);
assert.equal((await get('/api/health', betweenCycles)).status, 200);
const forecast = (await (await get('/api/resorts/mtbaker/dashboard', betweenCycles)).json()).sources.find(source => source.id === 'forecast');
assert.equal(forecast.status, 'cached');
assert.equal(forecast.refreshAfterMs, 6 * hour);

for (let phase = 0; phase < 13; phase++) {
  await run(productionStart + 6 * hour + phase * minute, unavailable);
}
assert.deepEqual(hosts, [
  ...Array(4).fill('api.open-meteo.com'),
  ...Array(4).fill('api.weather.gov'),
  'data.wsdot.wa.gov',
  ...Array(4).fill('nwac.us'),
], 'the next six-hour cycle collects every feed once');
const overdue = productionStart + 7 * hour;
await run(Math.floor(overdue / hour) * hour, unavailable);
assert.equal((await get('/api/health', overdue)).status, 503, 'missed refreshes eventually fail health');
sql.close();
console.log('Verified six-hour collections, health between cycles, pilot handoff, and browser routes.');
