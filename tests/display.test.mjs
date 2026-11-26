import test from 'node:test';
import assert from 'node:assert/strict';
import * as display from '../src/display.mjs';
import { HOUR } from '../src/time.mjs';

const now = Date.parse('2026-01-05T04:00Z');
const snapshot = () => ({
  generatedAt: now,
  sources: ['brooks', 'forecast', 'nws'].map(id => ({ id, status: 'fresh', fetchedAt: now })),
  stations: [{ id: 'brooks', sourceState: 'fresh', fetchedAt: now, hasSnowBoard: true, rows: [
    { time: now - 2 * HOUR, boardIn: 0, temperatureF: 25 },
    { time: now - HOUR, boardIn: 2, temperatureF: 25 },
    { time: now, boardIn: 5, temperatureF: 25 },
  ] }], models: [], snowLevels: [],
});

test('retained client data ages and loses favorable NWAC advice without another response', () => {
  assert.equal(typeof display.ageSnapshot, 'function');
  const data = snapshot();
  assert.equal(display.ageSnapshot(data, now).advice.now.status, 'promising');
  const aged = display.ageSnapshot(data, now + 4 * HOUR);
  assert.equal(aged.advice.now.status, 'limited');
  assert.equal(aged.advice.stations[0].quality, 'stale');
  assert.equal(aged.sources.find(s => s.id === 'forecast').status, 'stale');
  assert.equal(data.sources[0].status, 'fresh');
  assert.equal(aged.generatedAt, now);
});

test('forecast recovery selects new models while preserving deliberate exclusions', () => {
  assert.equal(typeof display.reconcileSelection, 'function');
  assert.deepEqual([...display.reconcileSelection([], new Set())], []);
  const recovered = [{ id: 'gfs' }, { id: 'ecmwf' }];
  assert.deepEqual([...display.reconcileSelection(recovered, new Set())], ['gfs', 'ecmwf']);
  assert.deepEqual([...display.reconcileSelection(recovered, new Set(['gfs']))], ['ecmwf']);
});

test('all-missing snowfall produces unavailable chart data, not a synthetic dry forecast', () => {
  assert.equal(typeof display.chartData, 'function');
  assert.equal(typeof display.chartMessage, 'function');
  const data = { models: [{ id: 'gfs', points: [{ time: now + HOUR, snowIn: null }] }] };
  const chart = display.chartData(data, new Set(['gfs']), 'snow', now, 3);
  assert.ok(chart.lines[0].values.every(v => v === null));
  assert.match(display.chartMessage(chart, 'snow'), /No data/);
});

test('a partial zero-snow series cannot claim an entire dry forecast window', () => {
  assert.equal(typeof display.chartData, 'function');
  const data = { models: [{ id: 'gfs', points: [{ time: now + HOUR, snowIn: 0 }] }] };
  const chart = display.chartData(data, new Set(['gfs']), 'snow', now, 3);
  assert.doesNotMatch(display.chartMessage(chart, 'snow'), /No measurable snow/);
  data.models[0].points.push({ time: now + 2 * HOUR, snowIn: 0 }, { time: now + 3 * HOUR, snowIn: 0 });
  assert.match(display.chartMessage(display.chartData(data, new Set(['gfs']), 'snow', now, 3), 'snow'), /No measurable snow/);
});

test('active chart status distinguishes stale models from a current NWS snow-level feed', () => {
  assert.equal(typeof display.forecastStatus, 'function');
  const data = snapshot(); data.sources[1].status = 'stale';
  assert.match(display.forecastStatus(data, 'snow').text, /Stale.*retrieved/i);
  assert.equal(display.forecastStatus(data, 'snow').status, 'stale');
  assert.equal(display.forecastStatus(data, 'level').status, 'fresh');
});
