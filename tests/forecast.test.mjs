import test from 'node:test';
import assert from 'node:assert/strict';
import * as forecast from '../src/forecast.mjs';
const H = 3600000;
const start = Date.parse('2026-01-05T02:00Z'); // Sunday 6 pm Pacific
const model = (id, amount = 0.25, hours = 168) => ({ id, label: id, color: '#3498db', points: Array.from({ length: hours + 1 }, (_, i) => ({ time: start + i * H, snowIn: amount, precipIn: amount / 10, temperatureF: 25 + i / 10, windMph: 8, gustMph: 20, cloudPct: 70 })) });

test('five days covers 120 full future hours even late in the UTC day', () => {
  assert.equal(typeof forecast.forecastWindow, 'function');
  const result = forecast.forecastWindow(Date.parse('2026-01-04T23:35Z'), 5);
  assert.equal(result.start, Date.parse('2026-01-05T00:00Z'));
  assert.equal(result.end, Date.parse('2026-01-10T00:00Z'));
  assert.throws(() => forecast.forecastWindow(start, 15), /horizon/i);
});

test('range sums hour-ending intervals and excludes the starting observation', () => {
  assert.equal(typeof forecast.forecastRange, 'function');
  const a = model('a'), b = model('b', 0.5);
  a.points[0].snowIn = 15;
  const result = forecast.forecastRange([a, b], start, start + 24 * H, 'snowIn');
  assert.equal(result.min, 6); assert.equal(result.max, 12);
  assert.equal(result.count, 2);
});

test('a short-range model or a missing hour is excluded from complete totals', () => {
  assert.equal(typeof forecast.forecastRange, 'function');
  const a = model('a'), b = model('b', 1, 18), c = model('c', 1);
  c.points[3].snowIn = null;
  const result = forecast.forecastRange([a, b, c], start, start + 120 * H, 'snowIn');
  assert.equal(result.min, 30); assert.equal(result.max, 30); assert.equal(result.count, 1);
  assert.equal(result.models[1].total, null); assert.equal(result.models[2].total, null);
});

test('model median uses only complete totals, including zero, and handles even and missing sets', () => {
  const range = forecast.forecastRange([model('a', 0), model('b', .5), model('c', 1), model('short', 9, 1)], start, start + 12 * H);
  assert.equal(forecast.modelMedian(range), 6);
  const even = forecast.forecastRange([model('a', 0), model('b', 1)], start, start + 12 * H);
  assert.equal(forecast.modelMedian(even), 6);
  assert.equal(forecast.modelMedian(forecast.forecastRange([model('a', 0)], start, start + 12 * H)), 0);
  assert.equal(forecast.modelMedian(forecast.forecastRange([model('short', 9, 1)], start, start + 12 * H)), null);
});

test('selected model cumulative chart endpoint equals its 1/3/5-day total', () => {
  assert.equal(typeof forecast.comparisonSeries, 'function');
  const data = { models: [model('a'), model('b', 0.5)], snowLevels: [] };
  for (const [days, expected] of [[1, 12], [3, 36], [5, 60]]) {
    const chart = forecast.comparisonSeries(data, ['b'], 'snow', start, start + days * 24 * H);
    assert.equal(chart.lines.length, 1); assert.equal(chart.lines[0].id, 'b');
    assert.equal(chart.lines[0].values.at(-1), expected);
    assert.equal(chart.times.length, days * 24 + 1);
  }
});

test('cumulative lines stop at missing data and three-hour precipitation preserves its interval', () => {
  assert.equal(typeof forecast.comparisonSeries, 'function');
  const a = model('a', 1); a.points[5].snowIn = null;
  const data = { models: [a], snowLevels: [] };
  const snow = forecast.comparisonSeries(data, ['a'], 'snow', start, start + 10 * H);
  assert.equal(snow.lines[0].values[4], 4); assert.equal(snow.lines[0].values[5], null); assert.equal(snow.lines[0].values[6], null);
  const rain = forecast.comparisonSeries(data, ['a'], 'precip3', start, start + 10 * H);
  assert.equal(rain.lines[0].values[2], null); assert.equal(rain.lines[0].values[3], 0.3);
});

test('NWS snow level is one separate reference even when multiple models are selected', () => {
  assert.equal(typeof forecast.comparisonSeries, 'function');
  const chart = forecast.comparisonSeries({ models: [model('a'), model('b')], snowLevels: [{ start, end: start + 2 * H, feet: 2500 }] }, ['a', 'b'], 'level', start, start + 3 * H);
  assert.equal(chart.lines.length, 1); assert.equal(chart.lines[0].id, 'nws');
  assert.deepEqual(chart.lines[0].values, [2500, 2500, null, null]);
});

test('day/night periods partition the forecast window without double counting', () => {
  assert.equal(typeof forecast.forecastPeriods, 'function');
  const periods = forecast.forecastPeriods(start + 2 * H, start + 26 * H);
  assert.equal(periods.length, 3);
  assert.deepEqual(periods.map(p => (p.end - p.start) / H), [10, 12, 2]);
  assert.equal(periods[0].partial, true); assert.equal(periods[1].partial, false);
  assert.equal(periods[0].kind, 'Night');
});

test('early morning outlook uses the ongoing night and DST preserves actual elapsed hours', () => {
  assert.equal(typeof forecast.overnightForecast, 'function');
  const ongoing = forecast.overnightForecast({ models: [model('a')], snowLevels: [] }, Date.parse('2026-01-05T10:00Z'));
  assert.equal(ongoing.nightStart, start); assert.equal(ongoing.end, Date.parse('2026-01-05T14:00Z'));
  assert.equal(ongoing.remaining, true); assert.equal(ongoing.snow.min, 1);
  const spring = forecast.overnightForecast({ models: [], snowLevels: [] }, Date.parse('2026-03-08T01:00Z'));
  assert.equal((spring.end - spring.start) / H, 11);
  const fall = forecast.overnightForecast({ models: [], snowLevels: [] }, Date.parse('2026-11-01T00:00Z'));
  assert.equal((fall.end - fall.start) / H, 13);
});

test('precipitation bins align to Pacific clock boundaries and partition partial edges', () => {
  const from = start + 5 * H; // 11 pm Pacific
  const to = from + 24 * H;
  const bins = forecast.forecastBins(from, to, 6);
  assert.deepEqual(bins.map(b => (b.end - b.start) / H), [1, 6, 6, 6, 5]);
  assert.equal(bins[0].partial, true); assert.equal(bins[1].partial, false);
  assert.equal(bins.at(-1).partial, true);
  assert.equal(bins[0].start, from); assert.equal(bins.at(-1).end, to);
  assert.ok(bins.slice(1).every((b, i) => b.start === bins[i].end));
  const a = model('a');
  const sum = bins.reduce((total, b) => total + forecast.intervalTotal(a.points, b.start, b.end, 'precipIn').total, 0);
  assert.ok(Math.abs(sum - forecast.intervalTotal(a.points, from, to, 'precipIn').total) < 1e-9);
});

test('Pacific precipitation bins include all hours through both DST changes', () => {
  for (const [from, to, duration] of [
    ['2026-03-08T08:00Z', '2026-03-08T13:00Z', 5],
    ['2026-11-01T07:00Z', '2026-11-01T14:00Z', 7],
  ]) {
    const bins = forecast.forecastBins(Date.parse(from), Date.parse(to), 6);
    assert.equal(bins.length, 1); assert.equal(bins[0].partial, false);
    assert.equal((bins[0].end - bins[0].start) / H, duration);
  }
});

test('six-hour precipitation requires six available hour-ending measurements', () => {
  const a = model('a', 1);
  const data = { models: [a], snowLevels: [] };
  const series = forecast.comparisonSeries(data, ['a'], 'precip6', start, start + 12 * H).lines[0].values;
  assert.equal(series[5], null); assert.equal(series[6], 0.6);
  a.points[4].precipIn = null;
  const missing = forecast.comparisonSeries(data, ['a'], 'precip6', start, start + 12 * H).lines[0].values;
  assert.equal(missing[6], null); assert.equal(missing[9], null); assert.equal(missing[10], 0.6);
});

test('hourly snowfall blends ECMWF and HRRR through hour 48, then favors ECMWF', () => {
  const models = [model('ecmwf_ifs025', 10), model('gfs_hrrr', 4), model('gfs_global', 2), model('icon_global', 1), model('gem_global', 0)];
  const data = { models, generatedAt: start + 24 * H, sources: [{ id: 'forecast', fetchedAt: start }] };
  const blend = forecast.createSnowfallBlend(data, start + 24 * H);
  assert.equal(blend(start, start + H), 5.8);
  assert.equal(blend(start + 47 * H, start + 48 * H), 5.8);
  assert.equal(blend(start + 48 * H, start + 49 * H), 8.35);
  assert.equal(blend(start + 47 * H, start + 49 * H), 14.15);
});

test('hourly weights follow available models and preserve zero and missing snowfall', () => {
  const models = [model('ecmwf_ifs025', 10, 4), model('gfs_hrrr', 0, 4), model('gfs_global', 2, 4), model('icon_global', 4, 4)];
  const data = { models };
  models[1].points[2].snowIn = null;
  models[0].points[3].snowIn = null;
  models[0].points[4].snowIn = models[1].points[4].snowIn = null;
  const blend = forecast.createSnowfallBlend(data, start);
  assert.equal(blend(start, start + H), 4.6);
  assert.equal(blend(start + H, start + 2 * H), 8.6);
  assert.equal(blend(start + 2 * H, start + 3 * H), 0.6);
  assert.equal(blend(start + 3 * H, start + 4 * H), 3);
  assert.equal(blend(start, start + 5 * H), null);
  assert.equal(forecast.createSnowfallBlend(data, start, [models[1]])(start, start + H), 0);
  assert.equal(forecast.createSnowfallBlend(data, start, models.slice(0, 2))(start, start + H), 5);
  assert.equal(forecast.createSnowfallBlend(data, start, [])(start, start + H), null);
});
