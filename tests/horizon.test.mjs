import test from 'node:test';
import assert from 'node:assert/strict';
import * as forecast from '../src/forecast.mjs';
import { HOUR, localParts } from '../src/time.mjs';
import { horizonFixture, HORIZON_NOW } from './fixtures/horizon.mjs';

function horizon(data = horizonFixture(), days = 5, now = HORIZON_NOW) {
  assert.equal(typeof forecast.horizonForecast, 'function');
  return forecast.horizonForecast(data, now, days);
}

test('horizons compare independent overnight blends and preserve each night’s model coverage', () => {
  const { nights, maximum } = horizon();
  assert.deepEqual(nights.map(n => n.estimate.median), [4.7,1,7,0,3]);
  assert.deepEqual(nights.map(n => n.snow.count), [5,4,4,4,4]);
  assert.deepEqual(nights.map(n => n.agreement.label), ['Low','High','High','High','Low']);
  assert.deepEqual(nights.map(n => n.condition.label), ['Normal','Dry','Normal','No new snow','Wet']);
  assert.equal(nights[0].condition.transition, 'Wet early');
  assert.equal(nights[3].condition.key, null);
  assert.deepEqual(nights.map(n => localParts(n.end).day), [17,18,19,20,21]);
  const expected = [4.86, .8 * .9 + .2 * 3.1 / 3, .8 * 6 + .2 * 22 / 3, 0, .8 + .2 * 11 / 3];
  nights.forEach((night, i) => assert.ok(Math.abs(night.estimate.blendedIn - expected[i]) < 1e-10));
  assert.equal(maximum, nights[2].estimate.blendedIn, 'bars use the unrounded blended amounts');
  assert.deepEqual(horizon(undefined, 3).nights, nights.slice(0, 3));
});

test('missing hours and short model horizons cannot become zero snowfall or high agreement', () => {
  const data = horizonFixture();
  data.models.forEach(m => { m.points = m.points.filter(p => p.time !== Date.parse('2026-10-21T05:00Z')); });
  const last = horizon(data).nights.at(-1);
  assert.equal(last.estimate.blendedIn, null);
  assert.equal(last.agreement.key, null);
  assert.equal(last.condition.key, null);
  assert.notEqual(last.condition.label, 'No new snow');
  data.models = data.models.slice(0, 2);
  assert.equal(horizon(data).nights[1].agreement.label, 'Limited');
  assert.equal(horizon(data).nights[3].condition.label, 'Snow uncertain');
});

test('each night requires complete current NWS guidance independently of snowfall', () => {
  const data = horizonFixture();
  data.snowLevels = data.snowLevels.filter(p => p.feet !== 4300);
  const nights = horizon(data).nights;
  assert.equal(nights[0].condition.key, 'normal');
  assert.equal(nights[4].estimate.median, 3);
  assert.equal(nights[4].condition.label, 'Unavailable');
  data.sources[1].status = 'stale';
  assert.equal(horizon(data).nights[0].condition.key, null);
  data.sources[0].status = 'stale';
  assert.ok(horizon(data).nights.every(n => n.agreement.label === 'Outdated' && n.condition.key === null));
  data.sources[0].status = 'unavailable';
  assert.ok(horizon(data).nights.every(n => n.estimate.median === null));
});

test('in-progress nights show remaining hours and roll forward at 6 am without presenting observations', () => {
  const now = Date.parse('2026-10-17T09:30Z'); // 2:30 am
  const { nights } = horizon(horizonFixture(now), 3, now);
  assert.equal(nights[0].phase, 'remaining');
  assert.equal(nights[0].start, Date.parse('2026-10-17T10:00Z'));
  assert.equal(nights[0].estimate.median, 1.175);
  assert.equal(nights[1].estimate.median, 1);
  assert.equal(nights[0].condition.transition, 'Wet early');
  const end = Date.parse('2026-10-17T13:00Z');
  assert.equal(horizon(horizonFixture(end), 3, end).nights[0].nightDate, '2026-10-17');
});

test('calendar windows retain Pacific 6 pm–6 am across daylight saving and year boundaries', () => {
  for (const [time, hours] of [['2026-10-31T23:00Z',13], ['2027-03-13T23:00Z',11], ['2026-12-31T23:00Z',12]]) {
    const now = Date.parse(time), { nights } = horizon(horizonFixture(now), 5, now);
    assert.equal((nights[0].end - nights[0].nightStart) / HOUR, hours);
    assert.ok(nights.every(n => localParts(n.nightStart).hour === 18 && localParts(n.end).hour === 6));
    assert.equal(new Set(nights.map(n => n.nightDate)).size, 5);
  }
  assert.throws(() => horizon(undefined, 4), /Unsupported/);
});

test('personal quality combines exact snowfall with the morning band and preserves uncertainty', () => {
  const data = horizonFixture();
  assert.deepEqual(horizon(data).nights.map(n => n.quality?.key), ['good', 'poor', 'good', 'poor', 'wet']);
  const first = (amount, feet) => {
    data.models.forEach(m => m.points.forEach(p => { if (p.snowIn !== null) p.snowIn = amount / 12; }));
    data.snowLevels.forEach(p => { p.feet = feet; });
    return horizon(data).nights[0];
  };
  assert.equal(first(5, 2000).quality.key, 'excellent');
  data.snowLevels[0].feet = 4200;
  assert.equal(horizon(data).nights[0].quality.key, 'good', 'earlier Wet guidance must prevent an Excellent rating');
  assert.equal(first(4.99, 2000).quality.key, 'good', 'rounding to 5 must not create an Excellent rating');
  assert.equal(first(7, 2600).quality.key, 'good', 'heavy Normal snow is not automatically Excellent');
  assert.equal(first(.99, 2000).quality.key, 'poor');
  assert.equal(first(8, 4300).quality.key, 'wet', 'wet guidance takes precedence over amount');
  data.snowLevels = [];
  assert.equal(horizon(data).nights[0].quality.key, null, 'missing condition is not Poor');
  data.sources[0].status = 'stale';
  assert.ok(horizon(data).nights.every(n => n.quality.key === null));
});

test('green Rain requires complete warm liquid forecasts and cannot be inferred from a Wet snow level', () => {
  const data = horizonFixture();
  const zero = () => horizon(data).nights[3];
  const rainTime = p => p.time > Date.parse('2026-10-20T01:00Z') && p.time <= Date.parse('2026-10-20T13:00Z');
  data.snowLevels.forEach(p => { p.feet = 6000; });
  assert.equal(zero().quality?.key, 'poor');
  data.models.forEach(m => m.points.filter(rainTime).forEach(p => { p.precipIn = .12 / 12; p.temperatureF = 38; }));
  assert.equal(zero().quality.key, 'rain');
  assert.equal(zero().quality.label, 'Rain');
  data.models[4].points.find(rainTime).snowIn = .5;
  assert.equal(zero().quality.key, null, 'known snow in an incomplete model still contradicts a rain-only forecast');
  assert.equal(zero().condition.label, 'Snow uncertain');
  data.models[4].points.find(rainTime).snowIn = null;
  data.models.slice(0, 2).forEach(m => { m.points.find(rainTime).precipIn = null; });
  assert.notEqual(zero().quality.key, 'rain', 'two complete rain models cannot establish Rain');
  data.models.forEach(m => m.points.filter(rainTime).forEach(p => { p.precipIn = .12 / 12; p.temperatureF = 30; }));
  assert.notEqual(zero().quality.key, 'rain', 'freezing liquid precipitation is not labeled ordinary rain');
  data.models.forEach(m => m.points.filter(rainTime).forEach(p => { p.temperatureF = null; }));
  assert.notEqual(zero().quality.key, 'rain', 'missing temperature is not a warm hour');
});
