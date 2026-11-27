import test from 'node:test';
import assert from 'node:assert/strict';
import { hourlySnowForecast } from '../src/forecast.mjs';
import { HOUR } from '../src/time.mjs';

const sixAm = Date.parse('2026-11-27T14:00:00Z');
const newSnow = [0.07, 0.09, 0.13, 0.19, 0.26, 0.32, 0.38, 0.46, 0.56, 0.61, 0.68, 0.57];
function snapshot(start = sixAm, count = 12) {
  const points = Array.from({ length: count + 1 }, (_, i) => ({
    time: start + i * HOUR, snowIn: i ? newSnow[(i - 1) % 12] : 9,
    precipIn: i * 0.01, temperatureF: -4 + i,
  }));
  return {
    models: [{ id: 'ecmwf_ifs025', points }],
    sources: [{ id: 'forecast', status: 'cached', fetchedAt: start }, { id: 'nws', status: 'cached' }],
    snowLevels: [{ start, end: start + HOUR, feet: 4500 }, { start: start + HOUR, end: start + 12 * HOUR, feet: 4400 }],
  };
}

test('hour headings cover the following hour of snow and liquid, with temperature and NWS level at the heading time', () => {
  const result = hourlySnowForecast(snapshot(), sixAm);
  assert.equal(result.hours.length, 12);
  assert.deepEqual(result.hours.map(hour => hour.snowIn), newSnow);
  assert.deepEqual(result.hours.map(hour => hour.totalIn), [0.07, 0.16, 0.29, 0.48, 0.74, 1.06, 1.44, 1.90, 2.46, 3.07, 3.75, 4.32]);
  assert.equal(result.hours[0].start, sixAm);
  assert.equal(result.hours[0].precipIn, 0.01);
  assert.equal(result.hours[0].temperatureF, -4);
  assert.equal(result.hours[0].snowLevelFt, 4500);
  assert.equal(result.hours[1].snowLevelFt, 4400);
  assert.equal(result.totalIn, 4.32);
});

test('missing snowfall breaks the running total while later hourly values and true zeroes remain visible', () => {
  const data = snapshot();
  data.models[0].points[1].snowIn = 0;
  data.models[0].points[2].snowIn = null;
  data.sources[1].status = 'unavailable';
  const result = hourlySnowForecast(data, sixAm);
  assert.deepEqual(result.hours.slice(0, 3).map(h => [h.snowIn, h.totalIn]), [[0, 0], [null, null], [0.13, null]]);
  assert.equal(result.totalIn, null);
  assert.equal(result.hours[0].snowLevelFt, null);
  data.sources[0].status = 'unavailable';
  assert.ok(hourlySnowForecast(data, sixAm).hours.every(hour => hour.snowIn === null));
});

test('snow, liquid and air temperature use available model weights anchored to the forecast collection', () => {
  const data = snapshot(sixAm, 72);
  const makeModel = (id, snowIn, precipIn, temperatureF) => ({
    id, points: data.models[0].points.map(({ time }) => ({ time, snowIn, precipIn, temperatureF })),
  });
  data.models = [
    makeModel('ecmwf_ifs025', .1, .02, 10),
    makeModel('gfs_hrrr', .5, null, 20),
    makeModel('gfs_global', 1, .1, 40),
  ];
  const [near] = hourlySnowForecast(data, sixAm).hours;
  assert.ok(Math.abs(near.snowIn - .44) < 1e-12);
  assert.ok(Math.abs(near.precipIn - .036) < 1e-12);
  assert.equal(near.temperatureF, 20);
  const [far] = hourlySnowForecast(data, sixAm + 49 * HOUR).hours;
  assert.ok(Math.abs(far.snowIn - .23) < 1e-12);
});

test('hourly navigation starts at the next full hour, jumps to Pacific mornings, and stops at the last available window', () => {
  const now = Date.parse('2026-11-26T23:25:00Z');
  const first = Date.parse('2026-11-27T00:00:00Z');
  const data = snapshot(first, 120);
  const initial = hourlySnowForecast(data, now);
  assert.equal(initial.start, first);
  assert.equal(initial.previous, null);
  assert.equal(initial.next, first + 12 * HOUR);
  assert.equal(initial.days.length, 4);
  assert.equal(initial.days[1].start, sixAm);
  const friday = hourlySnowForecast(data, now, sixAm);
  assert.equal(friday.start, sixAm);
  assert.equal(friday.previous, sixAm - 12 * HOUR);
  const end = hourlySnowForecast(data, now, first + 999 * HOUR);
  assert.equal(end.start, first + 108 * HOUR);
  assert.equal(end.next, null);
});

test('the Pacific clock change keeps twelve actual hours and precisely one copy of each model interval', () => {
  const start = Date.parse('2026-11-01T07:00:00Z'); // midnight before the clocks turn back
  const result = hourlySnowForecast(snapshot(start, 60), start);
  assert.equal(result.hours[1].start, Date.parse('2026-11-01T08:00:00Z'));
  assert.equal(result.hours[2].start, Date.parse('2026-11-01T09:00:00Z'));
  assert.equal(result.totalIn, 4.32);
  assert.equal(result.days[1].start, Date.parse('2026-11-02T14:00:00Z'));
});

test('paging from a day jump keeps 12-hour steps and returns to the same window at the forecast boundary', () => {
  const first = sixAm - 15 * HOUR;
  const data = snapshot(first, 36);
  const day = hourlySnowForecast(data, first, sixAm);
  assert.equal(day.next, sixAm + 12 * HOUR);
  const tail = hourlySnowForecast(data, first, day.next);
  assert.equal(tail.previous, sixAm);
  assert.equal(tail.next, null);
  assert.equal(tail.hours.filter(hour => hour.snowIn !== null).length, 9);
  assert.equal(tail.totalIn, null);
  assert.deepEqual(hourlySnowForecast(data, first, tail.previous).hours, day.hours);

  const initial = hourlySnowForecast(data, first);
  const returned = hourlySnowForecast(data, first, initial.next);
  assert.equal(returned.previous, first);
});
