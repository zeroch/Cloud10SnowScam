import test from 'node:test';
import assert from 'node:assert/strict';
import * as time from '../src/time.mjs';
import * as conditions from '../src/conditions.mjs';
import * as advice from '../src/advice.mjs';

const H = 3_600_000;
const at = (value) => Date.parse(value);
const series = (start, count, snow = 0.5) => Array.from({ length: count }, (_, i) => ({ time: start + (i + 1) * H, snowIn: snow, temperatureF: 25, gustMph: 12 }));
const station = (overrides = {}) => ({ id: 'brooks', name: 'Brooks', elevationFt: 4800, sourceState: 'fresh', hasSnowBoard: true, snowBlocked: false, notices: [], rows: [
  { time: at('2026-01-05T02:00Z'), temperatureF: 25, boardIn: 1 },
  { time: at('2026-01-05T03:00Z'), temperatureF: 25, boardIn: 3 },
  { time: at('2026-01-05T04:00Z'), temperatureF: 24, boardIn: 6 },
], ...overrides });

test('Pacific overnight crosses spring DST in 11 elapsed hours', () => {
  assert.equal(typeof time.nightWindow, 'function');
  const result = time.nightWindow(at('2026-03-07T20:00Z'));
  assert.equal(result.start, at('2026-03-08T02:00Z'));
  assert.equal(result.end, at('2026-03-08T13:00Z'));
});

test('Pacific overnight crosses fall DST in 13 elapsed hours', () => {
  assert.equal(typeof time.nightWindow, 'function');
  const result = time.nightWindow(at('2026-10-31T20:00Z'));
  assert.equal(result.start, at('2026-11-01T01:00Z'));
  assert.equal(result.end, at('2026-11-01T14:00Z'));
});

test('early morning observations use the preceding evening', () => {
  assert.equal(typeof time.observedNight, 'function');
  assert.equal(time.observedNight(at('2026-01-05T13:00Z')).start, at('2026-01-05T02:00Z'));
});

test('hour-ending snow excludes the starting boundary and includes the final hour', () => {
  assert.equal(typeof conditions.summarizeModel, 'function');
  const result = conditions.summarizeModel([{ time: 0, snowIn: 99 }, ...series(0, 12)], 0, 12 * H);
  assert.equal(result.snowIn, 6);
  assert.equal(result.complete, true);
});

test('a missing snow interval cannot become a complete overnight total', () => {
  assert.equal(typeof conditions.summarizeModel, 'function');
  const rows = series(0, 12);
  rows[5].snowIn = null;
  const result = conditions.summarizeModel(rows, 0, 12 * H);
  assert.equal(result.complete, false);
  assert.equal(result.snowIn, null);
  assert.equal(result.coveredHours, 11);
});

test('duplicate timestamps cannot conceal a missing forecast hour', () => {
  assert.equal(typeof conditions.summarizeModel, 'function');
  const rows = series(0, 11); rows.push({ ...rows[5] });
  assert.equal(conditions.summarizeModel(rows, 0, 12 * H).complete, false);
});

test('a continuous board increase provides explicitly labeled board-change evidence', () => {
  assert.equal(typeof conditions.stationSummary, 'function');
  const result = conditions.stationSummary(station(), at('2026-01-05T04:10Z'));
  assert.equal(result.board.changeIn, 5);
  assert.equal(result.board.status, 'valid');
  assert.equal(result.temperatureF, 24);
});

test('a seasonal notice suppresses snow even when temperatures are current', () => {
  assert.equal(typeof conditions.stationSummary, 'function');
  const result = conditions.stationSummary(station({ snowBlocked: true }), at('2026-01-05T04:10Z'));
  assert.equal(result.board.changeIn, null);
  assert.equal(result.temperatureF, 24);
});

test('a snow-board reset suppresses a misleading net accumulation', () => {
  assert.equal(typeof conditions.stationSummary, 'function');
  const item = station(); item.rows[1].boardIn = 0;
  assert.equal(conditions.stationSummary(item, at('2026-01-05T04:10Z')).board.changeIn, null);
});

test('old or missing baseline readings cannot confirm current accumulation', () => {
  assert.equal(typeof conditions.stationSummary, 'function');
  assert.equal(conditions.stationSummary(station(), at('2026-01-05T08:30Z')).quality, 'stale');
  const item = station(); item.rows.shift();
  assert.equal(conditions.stationSummary(item, at('2026-01-05T04:10Z')).board.changeIn, null);
});

test('NWS snow-level gaps do not imply full-period coverage', () => {
  assert.equal(typeof conditions.summarizeSnowLevel, 'function');
  const result = conditions.summarizeSnowLevel([{ start: 0, end: 2 * H, feet: 2000 }], 0, 3 * H);
  assert.equal(result.complete, false);
  assert.equal(result.min, 2000);
});

const forecastData = (snow = 0.5) => ({
  stations: [station({ rows: [{ time: at('2026-01-04T20:00Z'), temperatureF: 25, boardIn: 0 }], snowBlocked: true })],
  models: ['a', 'b', 'c', 'd'].map(id => ({ id, label: id, points: series(at('2026-01-05T02:00Z'), 12, snow) })),
  snowLevels: [{ start: at('2026-01-05T02:00Z'), end: at('2026-01-05T14:00Z'), feet: 2000 }],
  sources: [{ id: 'forecast', status: 'fresh' }, { id: 'nws', status: 'fresh' }],
});

test('missing observed snow remains unconfirmed even with favorable forecasts', () => {
  assert.equal(typeof advice.buildAdvice, 'function');
  const result = advice.buildAdvice(forecastData(), at('2026-01-04T20:10Z'));
  assert.equal(result.now.status, 'limited');
  assert.equal(result.tomorrow.status, 'promising');
  assert.equal(result.tomorrow.range.min, 6);
  assert.ok(result.tomorrow.evidence.some(line => /NWAC/.test(line)));
});

test('low forecasts produce a below-target suggestion rather than a powder claim', () => {
  assert.equal(typeof advice.buildAdvice, 'function');
  assert.equal(advice.buildAdvice(forecastData(0.1), at('2026-01-04T20:10Z')).tomorrow.status, 'below');
});

test('high snow level moderates an otherwise favorable forecast', () => {
  assert.equal(typeof advice.buildAdvice, 'function');
  const data = forecastData(); data.snowLevels[0].feet = 5000;
  assert.equal(advice.buildAdvice(data, at('2026-01-04T20:10Z')).tomorrow.status, 'watch');
});

test('stale NWAC prevents an affirmative tomorrow suggestion', () => {
  assert.equal(typeof advice.buildAdvice, 'function');
  const data = forecastData(); data.stations[0].sourceState = 'stale';
  assert.equal(advice.buildAdvice(data, at('2026-01-04T20:10Z')).tomorrow.status, 'limited');
});

test('a stale model cache cannot support a favorable future recommendation', () => {
  assert.equal(typeof advice.buildAdvice, 'function');
  const data = forecastData(); data.sources[0].status = 'stale';
  assert.equal(advice.buildAdvice(data, at('2026-01-04T20:10Z')).tomorrow.status, 'limited');
});

test('a current snow signal needs a valid Brooks temperature before becoming favorable', () => {
  const item = station(); item.rows.at(-1).temperatureF = null;
  const result = advice.buildAdvice({ ...forecastData(), stations: [item] }, at('2026-01-05T04:10Z'));
  assert.equal(result.now.status, 'limited');
  assert.match(result.now.detail, /temperature/i);
});

test('a completed overnight board estimate requires the 6 am endpoint', () => {
  const start = at('2026-01-05T02:00Z');
  const rows = Array.from({ length: 12 }, (_, i) => ({ time: start + i * H, boardIn: i * 0.5, temperatureF: 25 }));
  assert.equal(conditions.stationSummary(station({ rows }), start + 12.2 * H).board.status, 'unavailable');
  rows.push({ time: start + 12 * H, boardIn: 6, temperatureF: 25 });
  assert.equal(conditions.stationSummary(station({ rows }), start + 12.2 * H).board.changeIn, 6);
});

test('low remaining forecasts cannot classify the full overnight target as missed', () => {
  const data = forecastData(0); data.stations = [station()];
  const result = advice.buildAdvice(data, at('2026-01-05T04:00Z'));
  assert.equal(result.tomorrow.remaining, true);
  assert.equal(result.tomorrow.status, 'partial');
  assert.match(result.tomorrow.headline, /additional/i);
  assert.match(result.tomorrow.detail, /full.night/i);
});
