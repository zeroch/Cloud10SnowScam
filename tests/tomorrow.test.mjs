import test from 'node:test';
import assert from 'node:assert/strict';
import * as forecast from '../src/forecast.mjs';
import { overnightFixture, EXAMPLE_NOW } from './fixtures/overnight.mjs';

function tomorrow(data = overnightFixture(), now = EXAMPLE_NOW, choice = 'auto') {
  assert.equal(typeof forecast.tomorrowForecast, 'function', 'Tomorrow presentation is available');
  return forecast.tomorrowForecast(data, now, choice);
}

test('resort snowfall switches its forecast cutoff at 8 AM and 4 PM Pacific', () => {
  assert.equal(typeof forecast.resortSnowfallForecast, 'function');
  for (const [viewed, daytime, remainingEnd, openingStart, openingEnd] of [
    ['2026-10-16T14:59Z', false, '2026-10-16T15:00Z', '2026-10-16T14:59Z', '2026-10-16T15:00Z'],
    ['2026-10-16T15:00Z', true, '2026-10-16T23:00Z', '2026-10-16T23:00Z', '2026-10-17T15:00Z'],
    ['2026-10-16T22:59Z', true, '2026-10-16T23:00Z', '2026-10-16T23:00Z', '2026-10-17T15:00Z'],
    ['2026-10-16T23:00Z', false, '2026-10-17T15:00Z', '2026-10-16T23:00Z', '2026-10-17T15:00Z'],
    ['2026-03-08T00:00Z', false, '2026-03-08T15:00Z', '2026-03-08T00:00Z', '2026-03-08T15:00Z'],
    ['2026-10-31T23:00Z', false, '2026-11-01T16:00Z', '2026-10-31T23:00Z', '2026-11-01T16:00Z'],
  ]) {
    const now = Date.parse(viewed);
    const result = forecast.resortSnowfallForecast(overnightFixture({ now }), now);
    assert.equal(result.daytime, daytime, viewed);
    assert.equal(result.remaining.start, now, viewed);
    assert.equal(result.remaining.end, Date.parse(remainingEnd), viewed);
    assert.equal(result.opening.start, Date.parse(openingStart), viewed);
    assert.equal(result.opening.end, Date.parse(openingEnd), viewed);
  }
});

test('opening totals include both 6–8 AM hours and estimate only the remaining part of the final hour', () => {
  assert.equal(typeof forecast.resortSnowfallForecast, 'function');
  const snowByHour = { 13: 12, 14: 3, 15: 2, 16: 10 };
  for (const [viewed, expected] of [['2026-10-16T13:00Z', 5], ['2026-10-16T14:30Z', 1]]) {
    const now = Date.parse(viewed);
    const data = overnightFixture({ now });
    data.models = data.models.slice(0, 1);
    for (const point of data.models[0].points) point.snowIn = snowByHour[new Date(point.time).getUTCHours()] ?? 0;
    const { opening } = forecast.resortSnowfallForecast(data, now);
    assert.equal(opening.estimate.blendedIn, expected);
    assert.equal(opening.snow.min, expected);
    assert.equal(opening.snow.max, expected);
  }
});

test('Tomorrow reports the hourly blend alongside the complete-model evidence', () => {
  const result = tomorrow();
  assert.equal(result.estimate.blendedIn, 4.86);
  assert.equal(result.estimate.median, 4.7);
  assert.equal(result.estimate.value, '5');
  assert.equal(result.estimate.approximate, true);
  assert.equal(result.estimate.label, '5-model blend');
  assert.equal(result.agreement.label, 'Low');
  assert.equal(result.condition.key, 'normal');
  assert.equal(result.condition.transition, 'Wet early');
  assert.deepEqual([result.snow.min, result.snow.max], [2.1, 7.8]);
});

test('zero snowfall and a trace cannot become a dry-snow condition or the same amount', () => {
  const zero = tomorrow(overnightFixture({ totals: [0,0,0,0,0] }));
  assert.equal(zero.estimate.value, '0');
  assert.equal(zero.estimate.approximate, false);
  assert.equal(zero.agreement.label, 'High');
  assert.equal(zero.condition.key, null);
  assert.equal(zero.condition.label, 'No new snow');
  const trace = tomorrow(overnightFixture({ totals: [.0004,.0004,.0004,.0004,.0004] }));
  assert.equal(trace.estimate.value, '1');
  assert.equal(trace.condition.key, 'normal');
  const light = tomorrow(overnightFixture({ totals: [.12,.12,.12,.12,.12] }));
  assert.equal(light.estimate.value, '1');
});

test('agreement uses unrounded spread and distinguishes clustered, moderate and split forecasts', () => {
  for (const [totals, label] of [
    [[4,4.5,5,5.5,6], 'High'],
    [[3,4,5,6,7], 'Moderate'],
    [[2,4,5,6,8], 'Low'],
    [[0,0,0,0,8], 'Low'],
  ]) assert.equal(tomorrow(overnightFixture({ totals })).agreement.label, label);
});

test('only the missing HRRR hour loses its blend weight and agreement uses complete models', () => {
  const data = overnightFixture();
  data.models[4].points[5].snowIn = null;
  const limited = tomorrow(data);
  assert.ok(Math.abs(limited.estimate.blendedIn - (4.86 + .4 * (.8 - .4) / 3)) < 1e-10);
  assert.equal(limited.estimate.median, 4.4);
  assert.equal(limited.estimate.label, '5-model blend');
  assert.equal(limited.coverage, 'limited');
  data.models = data.models.slice(0, 2);
  assert.equal(tomorrow(data).agreement.label, 'Limited');
  data.models = data.models.slice(0, 1);
  assert.equal(tomorrow(data).agreement.label, 'Unavailable');
  assert.match(tomorrow(data).estimate.label, /ECMWF/);
});

test('stale or unavailable forecasts cannot present current agreement or an estimated condition', () => {
  const data = overnightFixture(); data.sources[0].status = 'stale';
  const saved = tomorrow(data);
  assert.equal(saved.estimate.value, '5');
  assert.equal(saved.agreement.key, null);
  assert.equal(saved.condition.key, null);
  data.sources[0].status = 'unavailable';
  const unavailable = tomorrow(data);
  assert.equal(unavailable.estimate.value, '—');
  assert.equal(unavailable.estimate.blendedIn, null);
  assert.equal(unavailable.condition.key, null);
});

test('the condition uses unrounded morning snow level and the personal Stevens bands', () => {
  for (const [level, key] of [[1999,'dry'],[2000,'dry'],[2001,'normal'],[3999,'normal'],[4000,'wet'],[4800,'wet']]) {
    const data = overnightFixture(); data.snowLevels.forEach(p => { p.feet = level; });
    const result = tomorrow(data);
    assert.equal(result.condition.key, key, String(level));
    assert.equal(result.condition.transition, '');
  }
});

test('a wet interval during the night is retained even when the morning estimate is dry', () => {
  const data = overnightFixture();
  [1800,4200,1800,1800].forEach((feet,i) => { data.snowLevels[i].feet = feet; });
  const result = tomorrow(data);
  assert.equal(result.condition.key, 'dry');
  assert.equal(result.condition.transition, 'Wet earlier');
});

test('remaining snowfall retains earlier wet guidance and discloses gaps in the full-night condition history', () => {
  const now = Date.parse('2026-10-16T11:30Z');
  const data = overnightFixture({ now });
  [4200,1800,1800,1800].forEach((feet,i) => { data.snowLevels[i].feet = feet; });
  const remaining = tomorrow(data, now);
  assert.equal(remaining.estimate.value, '1');
  assert.equal(remaining.condition.key, 'dry');
  assert.equal(remaining.condition.transition, 'Wet early');
  data.snowLevels.splice(1, 1);
  assert.equal(tomorrow(data, now).condition.transition, 'Wet early · gaps');
  data.snowLevels.splice(0, 1);
  assert.equal(tomorrow(data, now).condition.key, 'dry');
  assert.equal(tomorrow(data, now).condition.transition, 'Earlier: partial data');
});

test('partial, missing and stale NWS guidance leaves the condition unselected without erasing snowfall', () => {
  for (const scenario of ['partial','missing','stale']) {
    const data = overnightFixture();
    if (scenario === 'partial') data.snowLevels.splice(1, 1);
    if (scenario === 'missing') data.snowLevels = [];
    if (scenario === 'stale') data.sources[1].status = 'stale';
    const result = tomorrow(data);
    assert.equal(result.estimate.value, '5', scenario);
    assert.equal(result.condition.key, null, scenario);
    assert.notEqual(result.condition.label, 'Normal', scenario);
  }
});

test('remaining amounts stay in their own window and an ended night never displays forecast as observed snow', () => {
  const remainingNow = Date.parse('2026-10-16T11:30Z');
  const remaining = tomorrow(overnightFixture({ now: remainingNow }), remainingNow);
  assert.equal(remaining.phase, 'remaining');
  assert.equal(remaining.estimate.value, '1');
  for (const [time, value] of [['2026-10-16T12:30Z','—'],['2026-10-16T13:00Z','Unconfirmed']]) {
    const now = Date.parse(time);
    const result = tomorrow(overnightFixture({ now }), now);
    assert.equal(result.estimate.value, value);
    assert.equal(result.agreement.key, null);
    assert.equal(result.condition.key, null);
  }
});

test('complementary hourly coverage can produce a blend without a complete individual model', () => {
  const data = overnightFixture({ totals: [12, 0, 0, 0, 12] });
  const ecmwf = data.models[0], hrrr = data.models[4];
  data.models = [ecmwf, hrrr];
  ecmwf.points.forEach((point, i) => { if (i % 2 === 0) point.snowIn = null; });
  hrrr.points.forEach((point, i) => { if (i % 2 === 1) point.snowIn = null; });
  const night = tomorrow(data);
  assert.equal(night.estimate.blendedIn, 12);
  assert.equal(night.estimate.label, '2-model blend');
  assert.equal(night.snow.count, 0);
  assert.equal(night.agreement.label, 'Unavailable');
  hrrr.points[2].snowIn = null;
  assert.equal(tomorrow(data).estimate.blendedIn, null);
});
