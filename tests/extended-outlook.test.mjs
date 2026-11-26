import test from 'node:test';
import assert from 'node:assert/strict';
import * as forecast from '../src/forecast.mjs';
import * as time from '../src/time.mjs';
import { forecastRequestUrl } from '../src/provider-core.mjs';

const H = 3_600_000;
const NOW = Date.parse('2026-11-03T20:30:00Z'); // Nov 3, 12:30 Pacific
const START = Date.parse('2026-11-03T08:00:00Z');
const makeModel = (id, hours, value = () => 0) => ({ id, label: id, points: Array.from({ length: hours + 1 }, (_, i) => ({ time: START + i * H, snowIn: value(i) })) });

test('15-day outlook uses Pacific calendar days and labels the partial first day', () => {
  const result = forecast.fifteenDayForecast({ models: [makeModel('a', 400, () => 0.25)] }, NOW);
  assert.equal(result.days.length, 15);
  assert.equal(result.days[0].calendarStart, START);
  assert.equal(result.days[0].start, Date.parse('2026-11-03T21:00:00Z'));
  assert.equal(result.days[0].end, Date.parse('2026-11-04T08:00:00Z'));
  assert.equal(result.days[0].partial, true);
  assert.equal(result.days[0].median, 2.75);
  assert.deepEqual(result.blocks.map(x => [x.firstDay, x.lastDay]), [[1,5],[6,10],[11,15]]);
});

test('calendar-day boundaries span 23 and 25 actual hours across daylight saving', () => {
  for (const [now, expected] of [['2026-03-08T09:00:00Z', 23], ['2026-11-01T08:00:00Z', 25]]) {
    assert.equal((time.localDayStart(Date.parse(now), 1) - time.localDayStart(Date.parse(now), 0)) / H, expected);
  }
});

test('block median uses complete model totals, not a sum of daily medians', () => {
  const models = [1,2,3].map(day => makeModel(`m${day}`, 400, i => i > (day - 1) * 24 && i <= day * 24 ? 1 / 24 : 0));
  const result = forecast.fifteenDayForecast({ models }, START);
  assert.equal(result.days.slice(0, 3).reduce((a, d) => a + d.median, 0), 0);
  assert.equal(result.blocks[0].count, 3);
  assert.ok(Math.abs(result.blocks[0].median - 1) < 1e-10);
});

test('short and missing model coverage remains unavailable rather than zero', () => {
  const full = makeModel('full', 400, () => 0.1);
  const short = makeModel('short', 168, () => 0.2);
  const result = forecast.fifteenDayForecast({ models: [full, short] }, START);
  assert.equal(result.days[0].count, 2);
  assert.equal(result.blocks[2].count, 1);
  assert.equal(result.blocks[2].min, result.blocks[2].max);
  const old = forecast.fifteenDayForecast({ models: [short] }, START);
  assert.equal(old.days[14].median, null);
  assert.equal(old.blocks[2].count, 0);
});

test('no full hour left today is an ending state, never zero snow', () => {
  const now = Date.parse('2026-11-04T07:30:00Z'); // 11:30 pm Pacific
  const result = forecast.fifteenDayForecast({ models: [makeModel('full', 400)] }, now);
  assert.equal(result.days[0].median, null);
  assert.equal(result.days[0].ending, true);
  assert.equal(result.days[0].count, 0);
});

test('forecast provider requests sixteen UTC calendar days', () => {
  assert.equal(new URL(forecastRequestUrl()).searchParams.get('forecast_days'), '16');
});

test('five-day totals include short-range HRRR hours and sum the unrounded daily blends', () => {
  const models = [makeModel('ecmwf_ifs025', 360, () => 1), makeModel('gfs_hrrr', 6, () => 3), makeModel('gfs_global', 360)];
  const {days, blocks} = forecast.fifteenDayForecast({ models }, START);
  assert.equal(days[0].blendedIn, 24);
  assert.equal(blocks[0].blendedIn, 100.8);
  assert.equal(blocks[0].contributingCount, 3);
  assert.equal(blocks[0].count, 2);
  for (const block of blocks) {
    const sum = days.slice(block.firstDay - 1, block.lastDay).reduce((value, day) => value + day.blendedIn, 0);
    assert.ok(Math.abs(block.blendedIn - sum) < 1e-10);
  }
  assert.equal(blocks[2].blendedIn, 96);
});
