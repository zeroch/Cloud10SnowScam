import test from 'node:test';
import assert from 'node:assert/strict';
import { hourlySnowForecast } from '../src/forecast.mjs';
import { HOUR } from '../src/time.mjs';

const sixAm = Date.parse('2026-11-27T14:00:00Z');
const snow = [0.07, 0.09, 0.13, 0.19, 0.26, 0.32, 0.38, 0.46, 0.56, 0.61, 0.68, 0.57];
function snapshot(start = sixAm, count = 36) {
  const points = Array.from({ length: count + 1 }, (_, i) => ({
    time: start + i * HOUR, snowIn: i ? snow[(i - 1) % 12] : 9,
    precipIn: .01, temperatureF: 29, freezingLevelFt: 4500 - i * 10,
  }));
  return {
    resort: { id: 'stevenspass', elevationFt: 4800 },
    models: [{ id: 'ecmwf_ifs025', points }],
    sources: [{ id: 'forecast', status: 'cached', fetchedAt: start }],
    snowLevels: [{ start, end: start + count * HOUR, feet: 5100 }],
  };
}

test('only the next 36 full hourly intervals are exposed, even with 15 days of guidance', () => {
  const now = sixAm - 37 * 60_000;
  const result = hourlySnowForecast(snapshot(sixAm, 360), now);
  assert.deepEqual(result.hours.map(h => h.start), Array.from({ length: 36 }, (_, i) => sixAm + i * HOUR));
  assert.deepEqual(result.hours.slice(0, 12).map(h => h.snowIn), snow);
  assert.deepEqual(result.hours.slice(0, 12).map(h => h.totalIn), [0.07, 0.16, 0.29, 0.48, 0.74, 1.06, 1.44, 1.90, 2.46, 3.07, 3.75, 4.32]);
  assert.equal(result.hours[12].totalIn, 4.39);
  assert.equal(result.hours[23].totalIn, 8.64);
  assert.equal(result.totalIn, 12.96);
  assert.equal(result.hours[0].freezingLevelFt, 4500);
  assert.equal(result.hours[1].freezingLevelFt, 4490);
});

test('missing snow leaves subsequent totals unknown across windows and preserves zero and later individual amounts', () => {
  const data = snapshot(sixAm, 25);
  data.models[0].points[1].snowIn = 0;
  data.models[0].points[12].snowIn = null;
  const result = hourlySnowForecast(data, sixAm);
  assert.equal(result.hours[0].totalIn, 0);
  assert.equal(result.hours[11].totalIn, null);
  assert.equal(result.hours[12].snowIn, snow[0]);
  assert.equal(result.hours[12].totalIn, null);
  assert.equal(result.hours[35].snowIn, null);
  assert.equal(result.totalIn, null);
});

test('hourly snowfall and freezing height reweight the models that actually supply each field', () => {
  const data = snapshot(sixAm, 90);
  const model = (id, snowIn, freezingLevelFt) => ({
    id, points: data.models[0].points.map(p => ({ ...p, snowIn, freezingLevelFt })),
  });
  data.models = [model('ecmwf_ifs025', .1, null), model('gfs_hrrr', .5, 4000), model('gfs_global', 1, 6000)];
  const [near] = hourlySnowForecast(data, sixAm).hours;
  assert.ok(Math.abs(near.snowIn - .44) < 1e-12);
  assert.equal(near.freezingLevelFt, 4400);
  const [far] = hourlySnowForecast(data, sixAm + 49 * HOUR).hours;
  assert.ok(Math.abs(far.snowIn - .23) < 1e-12);
  assert.equal(far.freezingLevelFt, 5000);
});

test('precipitation type distinguishes warm rain, wet snow, snow, dry hours and missing evidence', () => {
  const data = snapshot();
  const models = ['ecmwf_ifs025', 'gfs_hrrr', 'gfs_global', 'gem_global', 'icon_global'];
  data.models = models.map(id => ({ id, points: data.models[0].points.map(p => ({...p})) }));
  for (const { points } of data.models) {
    Object.assign(points[1], { snowIn: 0, precipIn: .03, temperatureF: 37, freezingLevelFt: 4850 });
    points[2].freezingLevelFt = 4700;
    Object.assign(points[4], { snowIn: 0, precipIn: 0 });
    Object.assign(points[5], { snowIn: 0, precipIn: .03, temperatureF: 28 });
  }
  const phases = () => hourlySnowForecast(data, sixAm).hours.map(h => h.phase);
  assert.deepEqual(phases().slice(0, 5), ['rain', 'wet', 'snow', 'none', 'unknown']);
  data.models.slice(0, 3).forEach(m => { m.points[1].temperatureF = null; });
  assert.equal(phases()[0], 'unknown');
  data.models.forEach(m => { m.points[0].freezingLevelFt = null; m.points[1].snowIn = .02; });
  assert.equal(hourlySnowForecast(data, sixAm).hours[0].freezingLevelFt, null);
  assert.equal(phases()[0], 'unknown');
  data.sources[0].status = 'stale';
  assert.ok(phases().every(p => p === 'unknown'));
  data.sources[0].status = 'unavailable';
  assert.ok(hourlySnowForecast(data, sixAm).hours.every(h => h.snowIn === null && h.freezingLevelFt === null));
});

test('36-hour coverage counts elapsed hours across both Pacific clock changes', () => {
  for (const instant of ['2026-03-08T08:00:00Z', '2026-11-01T07:00:00Z']) {
    const first = Date.parse(instant);
    const { hours, totalIn } = hourlySnowForecast(snapshot(first), first);
    assert.equal(new Set(hours.map(h => h.start)).size, 36);
    assert.equal(hours.at(-1).start, first + 35 * HOUR);
    assert.equal(totalIn, 12.96);
  }
});
