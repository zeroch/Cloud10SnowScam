import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as providers from '../src/providers.mjs';
const fixture = async name => readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

test('the provider requests enough data for 120 future hours at any UTC hour', () => {
  assert.equal(typeof providers.forecastRequestUrl, 'function');
  const url = new URL(providers.forecastRequestUrl());
  assert.ok(Number(url.searchParams.get('forecast_days')) * 24 - 24 >= 120);
  assert.equal(url.searchParams.get('timezone'), 'UTC');
  assert.equal(url.searchParams.get('elevation'), '1463.04');
  assert.ok(url.searchParams.get('hourly').split(',').includes('cloud_cover'));
  assert.ok(url.searchParams.get('hourly').split(',').includes('freezing_level_height'));
});

test('freezing height accepts meters and feet per model and keeps unavailable heights distinct from sea level', async () => {
  const data = JSON.parse(await fixture('forecast.json'));
  const key = 'freezing_level_height_gfs_global';
  const reading = () => providers.parseForecast(data).models.find(m => m.id === 'gfs_global').points.map(p => p.freezingLevelFt);
  assert.equal(reading()[0], null);
  data.hourly[key] = [1524, null];
  data.hourly_units[key] = 'm';
  assert.equal(reading()[0], 5000);
  assert.equal(reading()[1], null);
  data.hourly[key] = [5100, 0];
  data.hourly_units[key] = 'ft';
  assert.deepEqual(reading().slice(0, 2), [5100, 0]);
  data.hourly_units[key] = 'undefined';
  assert.equal(reading()[0], null);
});

test('forecast cloud cover is optional and invalid percentages are not shown', async () => {
  const data = JSON.parse(await fixture('forecast.json'));
  data.hourly.cloud_cover_gfs_global = [78, 110];
  data.hourly_units.cloud_cover_gfs_global = '%';
  const points = providers.parseForecast(data).models.find(m => m.id === 'gfs_global').points;
  assert.equal(points[0].cloudPct, 78); assert.equal(points[1].cloudPct, null);
});

test('real Brooks payload preserves temperatures and rejects invalid seasonal snow', async () => {
  assert.equal(typeof providers.parseNwac, 'function');
  const result = providers.parseNwac(await fixture('brooks.html'), 'brooks');
  assert.equal(result.length, 1);
  assert.equal(result[0].rows[0].temperatureF, 34.41);
  assert.equal(result[0].rows[0].boardIn, null);
  assert.equal(result[0].rows[0].depthIn, null);
  assert.equal(result[0].snowBlocked, true);
  assert.ok(result[0].notices.some(n => /decommission/i.test(n)));
});

test('the shared upper station table keeps Tye Mill and Skyline distinct', async () => {
  assert.equal(typeof providers.parseNwac, 'function');
  const result = providers.parseNwac(await fixture('upper.html'), 'upper');
  assert.equal(result.find(s => s.id === 'tye').rows[0].temperatureF, 35.59);
  assert.equal(result.find(s => s.id === 'skyline').rows[0].temperatureF, 34.18);
  assert.equal(result.find(s => s.id === 'tye').rows[0].gustMph, 9.49);
  assert.ok(result.every(s => !s.hasSnowBoard));
});

test('base snow-board removal does not remove the reported base temperature', async () => {
  assert.equal(typeof providers.parseNwac, 'function');
  const [result] = providers.parseNwac(await fixture('schmidt.html'), 'schmidt');
  assert.equal(result.rows[0].temperatureF, 35.26);
  assert.equal(result.snowBlocked, true);
});

test('a changed NWAC page schema fails explicitly instead of generating zero snow', () => {
  assert.equal(typeof providers.parseNwac, 'function');
  assert.throws(() => providers.parseNwac('<html>Loading</html>', 'brooks'), /table/i);
});

test('forecast parser preserves named models, epoch times, inches, and nulls', async () => {
  assert.equal(typeof providers.parseForecast, 'function');
  const data = JSON.parse(await fixture('forecast.json'));
  data.hourly.snowfall_gfs_global[0] = null;
  const result = providers.parseForecast(data);
  assert.equal(result.models.length, 4);
  assert.equal(result.models.find(m => m.id === 'gfs_global').points[0].snowIn, null);
  assert.equal(result.models[0].points[0].time, 1791849600000);
});

test('a mismatched forecast snow unit is rejected instead of mislabeled inches', async () => {
  assert.equal(typeof providers.parseForecast, 'function');
  const data = JSON.parse(await fixture('forecast.json'));
  data.hourly_units.snowfall_ecmwf_ifs025 = 'cm';
  assert.throws(() => providers.parseForecast(data), /unit/i);
});

test('NWS snow level is converted from meters and preserves interval duration', async () => {
  assert.equal(typeof providers.parseSnowLevel, 'function');
  const data = JSON.parse(await fixture('nws.json'));
  const result = providers.parseSnowLevel(data);
  assert.equal(result.intervals[0].end - result.intervals[0].start, 10_800_000);
  assert.ok(Math.abs(result.intervals[0].feet - 3996) < 0.1);
  assert.equal(result.updatedAt, Date.parse('2026-10-12T18:26:45+00:00'));
});
