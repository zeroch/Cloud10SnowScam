import test from 'node:test';
import assert from 'node:assert/strict';
import { hourlyForecast } from '../src/hourly-forecast.mjs';
import { RESORTS } from '../src/config.mjs';
import { HOUR } from '../src/time.mjs';

const start = Date.parse('2026-11-28T04:00Z'); // Friday 8 PM at Brooks
function dashboard(at = start) {
  const points = Array.from({ length: 37 }, (_, i) => ({
    time: at + i * HOUR, snowIn: 0, precipIn: 0, temperatureF: 36, windMph: i, cloudPct: i,
  }));
  return {
    resort: RESORTS[0], sources: [{ id: 'forecast', status: 'cached' }, { id: 'nws', status: 'fresh' }],
    models: [
      { id: 'gfs_global', points: points.map(p => ({ ...p, snowIn: 10, windMph: 95 })) },
      { id: 'ecmwf_ifs025', points },
    ],
    snowLevels: [{ start: at, end: at + 3 * HOUR, feet: 2800 }],
  };
}

test('ECMWF amounts end each displayed hour while wind and cloud start it', () => {
  const data = dashboard();
  const points = data.models[1].points;
  points[0].snowIn = 9;
  points[1].snowIn = 0.08;
  points[36].snowIn = 1.25;
  const { hours, totalSnowIn } = hourlyForecast(data, start - 31 * 60_000);
  assert.equal(hours.length, 36);
  assert.deepEqual(hours.map(h => h.time), Array.from({ length: 36 }, (_, i) => start + i * HOUR));
  assert.deepEqual(hours.slice(0, 2).map(h => [h.snowIn, h.windMph, h.cloudPct]), [[0.08, 0, 0], [0, 1, 1]]);
  assert.equal(hours.at(-1).snowIn, 1.25);
  assert.equal(totalSnowIn, 1.33);
  assert.equal(hourlyForecast(data, start).hours[0].time, start);
});

test('missing coverage stays independent by field, model and source', () => {
  const data = dashboard();
  assert.equal(hourlyForecast(data, start).totalSnowIn, 0);
  data.models[1].points[1].windMph = null;
  data.models[1].points[3].snowIn = null;
  let result = hourlyForecast(data, start);
  assert.equal(result.hours[1].windMph, null);
  assert.equal(result.hours[1].cloudPct, 1);
  assert.equal(result.hours[2].snowIn, null);
  assert.equal(result.totalSnowIn, null);
  data.models.pop();
  result = hourlyForecast(data, start);
  assert.ok(result.hours.every(h => h.snowIn === null && h.windMph === null && h.weather === 'unknown'));
  assert.deepEqual(result.hours.slice(0, 4).map(h => h.snowLevelFt), [2800, 2800, 2800, null]);
  data.snowLevels = [{ start: start + HOUR / 2, end: start + 2 * HOUR, feet: 0 }];
  assert.deepEqual(hourlyForecast(data, start).hours.slice(0, 3).map(h => h.snowLevelFt), [null, 0, null]);
});

test('snow level uses whole feet relative to each resort with inclusive blue and purple boundaries', () => {
  const offsets = [-2001, -2000, -1999, -301, -300, 0, 100, 300, 301];
  for (const resort of RESORTS) {
    const data = { ...dashboard(), resort };
    data.snowLevels = offsets.map((offset, i) => ({
      start: start + i * HOUR, end: start + (i + 1) * HOUR, feet: resort.elevationFt + offset + 0.01,
    }));
    const { hours } = hourlyForecast(data, start);
    assert.deepEqual(hours.slice(0, 10).map(h => h.levelBand),
      ['blue', 'blue', 'neutral', 'neutral', 'purple', 'purple', 'purple', 'purple', 'green', 'missing']);
  }
});

test('weather uses the stored precipitation phase first and distinguishes day, night and gaps', () => {
  const data = dashboard();
  const points = data.models[1].points;
  points[1].snowIn = 1;
  points[2].precipIn = 0.1;
  points[2].temperatureF = 31;
  points[3].precipIn = 0.1;
  points[4].precipIn = null;
  points[4].cloudPct = 95;
  points[5].cloudPct = 70;
  points[6].cloudPct = 40;
  points[7].cloudPct = 0;
  points[8].cloudPct = 20;
  points[14].cloudPct = 40; // 10 AM Saturday
  points[15].cloudPct = 10;
  points[16].cloudPct = 0;
  const { hours } = hourlyForecast(data, start);
  assert.deepEqual(hours.slice(0, 9).map(h => h.weather),
    ['snow', 'rain', 'precipitation', 'unknown', 'cloudy', 'mostly-cloudy', 'partly-cloudy-night', 'clear', 'mostly-clear']);
  assert.deepEqual(hours.slice(14, 17).map(h => h.weather), ['partly-cloudy-day', 'mostly-sunny', 'sunny']);
});
