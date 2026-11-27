import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { collect, serve } from '../deploy/cloudflare-pilot/worker.mjs';
import { buildAdvice } from '../src/advice.mjs';
import { parseForecast } from '../src/provider-core.mjs';

const halfHour = 1_800_000;
const forecast = JSON.parse(readFileSync(new URL('./fixtures/forecast.json', import.meta.url)));
forecast.hourly.freezing_level_height_gfs_global = [5100, 4900];
forecast.hourly_units.freezing_level_height_gfs_global = 'ft';
const firstHour = forecast.hourly.time[0] * 1000;
const start = firstHour + 22 * 60_000;
for (const [field, values] of Object.entries(forecast.hourly)) {
  forecast.hourly[field] = Array.from({ length: 384 }, (_, i) =>
    field === 'time' ? firstHour / 1000 + i * 3600 : values[i % values.length]);
  if (field.endsWith('_gfs_global')) {
    const shortRange = field.replace('_gfs_global', '_gfs_hrrr');
    forecast.hourly[shortRange] = forecast.hourly[field].map((value, i) => i < 48 ? value : null);
    forecast.hourly_units[shortRange] = forecast.hourly_units[field];
  }
}
const request = path => new Request('https://pilot.example' + path);

function database(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec(readFileSync(new URL('../deploy/cloudflare-pilot/schema.sql', import.meta.url), 'utf8'));
  function prepare(query, values = []) {
    const statement = sql.prepare(query);
    return {
      bind: (...args) => prepare(query, args),
      first: async () => statement.get(...values) || null,
      all: async () => ({ results: statement.all(...values) }),
      run: async () => ({ meta: { changes: statement.run(...values).changes } }),
    };
  }
  return { prepare, async batch(statements) {
    sql.exec('BEGIN');
    try {
      const results = await Promise.all(statements.map(item => item.run()));
      sql.exec('COMMIT');
      return results;
    } catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
}

function fixtureFetch(openMeteo, calls) {
  return async url => {
    const target = new URL(url);
    calls.push(target);
    if (target.hostname === 'api.open-meteo.com') return openMeteo();
    if (target.hostname === 'api.weather.gov') return Response.json({ properties: {
      snowLevel: { uom: 'wmoUnit:m', values: [{ validTime: new Date(start).toISOString() + '/P7D', value: 1300 }] },
      updateTime: new Date(start).toISOString(),
    } });
    if (target.hostname === 'data.wsdot.wa.gov') return Response.json({ features: [{ attributes: { PassName: 'Stevens Pass US 2' } }] });
    throw new Error('Unexpected upstream');
  };
}
const status = async db => (await serve(request('/pilot/status'), db, start)).json();
async function runCycle(db, scheduled, upstream) {
  for (let minute = 0; minute < 9; minute++) {
    const now = scheduled + minute * 60_000;
    await collect(db, now, upstream, () => now);
  }
}

test('one scheduled invocation fetches one feed and repeated events are harmless', async t => {
  const db = database(t), calls = [];
  const upstream = fixtureFetch(() => Response.json(forecast), calls);
  await Promise.all([collect(db, start, upstream, () => start), collect(db, start, upstream, () => start)]);
  assert.equal(calls.length, 1);
  assert.equal((await status(db)).cyclesCompleted, 0);
  await runCycle(db, start, upstream);
  assert.equal(calls.length, 9);
  assert.equal((await status(db)).cyclesCompleted, 1);
});

test('a compact night produces the same live advice and the complete 384-hour dashboard', async t => {
  const db = database(t);
  await runCycle(db, start, fixtureFetch(() => Response.json(forecast), []));
  const { bytes } = await db.prepare("SELECT length(json_extract(payload,'$.adviceDays')) AS bytes FROM pilot_latest WHERE source_key='stevenspass-forecast-v2'").first();
  assert.ok(bytes > 0);
  const expected = parseForecast(forecast).models;
  assert.equal(expected.find(model => model.id === 'gfs_global').points[0].freezingLevelFt, 5100);
  for (const now of [start, start + 8 * halfHour, start + 2 * 86400000, start + 20 * 86400000]) {
    const data = await (await serve(request('/api/dashboard'), db, now)).json();
    assert.deepEqual(data.models, expected);
    assert.deepEqual(data.advice, buildAdvice({ ...data, models: expected }, now));
  }
  // A snapshot created by the initial deployed version remains readable.
  await db.prepare("UPDATE pilot_latest SET payload=json_remove(payload,'$.adviceDays','$.adviceModelIds') WHERE source_key='stevenspass-forecast-v2'").run();
  const old = await (await serve(request('/api/dashboard'), db, start)).json();
  assert.deepEqual(old.models, expected);
  assert.deepEqual(old.advice, buildAdvice({ ...old, models: expected }, start));
});

test('four-resort data survives a failed refresh and visitor reads never collect', async t => {
  const db = database(t), calls = [];
  const upstream = fixtureFetch(() => Response.json(forecast), calls);
  await runCycle(db, start, upstream);
  assert.equal(calls.length, 9);
  const forecasts = calls.filter(url => url.hostname === 'api.open-meteo.com');
  assert.equal(new Set(forecasts.map(url => url.searchParams.get('latitude'))).size, 4);
  assert.ok(forecasts.every(url => url.searchParams.get('forecast_days') === '16' && url.searchParams.get('models').split(',').length === 5));
  await runCycle(db, start + halfHour, fixtureFetch(() => Response.json({}), calls));
  const saved = await (await serve(request('/api/resorts/stevenspass/dashboard?force=1'), db, start + halfHour + 1)).json();
  assert.ok(saved.models.length > 0);
  assert.ok(saved.advice);
  assert.equal(saved.sources.find(source => source.id === 'forecast').fetchedAt, start);
  assert.equal(saved.sources.find(source => source.id === 'forecast').status, 'stale');
  assert.equal((await status(db)).openMeteo.invalid, 4);
  assert.equal(calls.length, 14);
  assert.equal((await serve(new Request('https://pilot.example/pilot/run', { method: 'POST' }), db, start)).status, 405);
});

test('HTTP 429 is recorded once and its Retry-After applies to all resorts across ticks', async t => {
  const db = database(t), calls = [];
  const upstream = fixtureFetch(() => new Response('busy', { status: 429, headers: { 'Retry-After': '3600' } }), calls);
  await runCycle(db, start, upstream);
  await runCycle(db, start + halfHour, upstream);
  let report = await status(db);
  assert.equal(report.openMeteo.requests, 1);
  assert.equal(report.openMeteo.responses429, 1);
  assert.equal(report.openMeteo.cooldownSkips, 7);
  assert.equal(report.openMeteo.cooldownUntil, start + 2 * halfHour);
  await runCycle(db, start + 2 * halfHour, upstream);
  assert.equal((await status(db)).openMeteo.requests, 2);
});

test('Open-Meteo rejection details preserve the published limit and an HTTP-date Retry-After', async t => {
  const db = database(t);
  const retryAt = start + 4 * halfHour;
  const upstream = fixtureFetch(() => Response.json({ error: true, reason: 'Hourly API request limit exceeded.' }, {
    status: 429, headers: { 'Retry-After': new Date(retryAt).toUTCString(), 'RateLimit-Remaining': '0' },
  }), []);
  await runCycle(db, start, upstream);
  const sample = await db.prepare('SELECT retry_until,detail FROM pilot_attempts WHERE status=429').first();
  assert.equal(sample.retry_until, retryAt);
  assert.deepEqual(JSON.parse(sample.detail), { reason: 'Hourly API request limit exceeded.', headers: { 'ratelimit-remaining': '0' } });
  assert.equal((await status(db)).feeds.find(feed => feed.provider === 'nws').count, 4);
});

test('48 distinct half-hour slots cap the pilot and late or replayed events do not collect', async t => {
  const db = database(t), calls = [];
  const upstream = fixtureFetch(() => new Response(null, { status: 503 }), calls);
  for (let slot = 0; slot < 48; slot++) {
    const now = start + halfHour * slot;
    await runCycle(db, now, upstream);
  }
  const stop = start + 48 * halfHour;
  await collect(db, stop, upstream, () => stop);
  await collect(db, start + 47 * halfHour, upstream, () => stop + 1000);
  const report = await status(db);
  assert.equal(report.startMs, start);
  assert.equal(report.endMs, stop);
  assert.equal(report.cyclesCompleted, 48);
  assert.equal(report.openMeteo.requests, 192);
  assert.equal(report.openMeteo.responses429, 0);
  assert.equal(calls.filter(url => url.hostname === 'api.weather.gov').length, 96);
});

test('delivery jitter within the scheduled minute cannot consume the next half-hour slot', async t => {
  const db = database(t), calls = [];
  const upstream = fixtureFetch(() => new Response(null, { status: 503 }), calls);
  await runCycle(db, start + 1891, upstream);
  await runCycle(db, start + halfHour + 179, upstream);
  assert.equal((await status(db)).cyclesCompleted, 2);
});
