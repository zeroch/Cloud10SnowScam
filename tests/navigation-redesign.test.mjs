import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { buildResortComparison } from '../src/resort-comparison.mjs';
import { resortComparisonFixture, COMPARISON_NOW } from './fixtures/resort-comparison.mjs';

const navigation = await import('../src/navigation.mjs');

test('a later-morning resort link opens Daily Forecast with its selected duration and comparison context', () => {
  const board = buildResortComparison(resortComparisonFixture(), COMPARISON_NOW, { days: 5, nightChoice: '2026-10-22' });
  for (const row of board.rows) {
    const link = new URL(row.href, 'https://example.test');
    assert.equal(link.searchParams.get('night'), '2026-10-22');
    assert.equal(link.searchParams.get('compareDays'), '5');
    assert.equal(link.searchParams.get('compareNight'), '2026-10-22');
    assert.equal(link.hash, '#live-daily');
    assert.equal(link.searchParams.get('days'), '5');
  }
});

test('returning to comparison restores its original morning and rejects unsafe context', () => {
  assert.equal(typeof navigation.comparisonReturnUrl, 'function');
  const detail = 'https://example.test/location/mtbaker/snow-summary?night=tonight&compareDays=5&compareNight=2026-10-22';
  const back = new URL(navigation.comparisonReturnUrl(detail), 'https://example.test');
  assert.equal(back.pathname, '/user/favorites/locations/snow-summary');
  assert.equal(back.searchParams.get('view'), 'outlook');
  assert.equal(back.searchParams.get('days'), '5');
  assert.equal(back.searchParams.get('night'), '2026-10-22');
  assert.equal(back.hash, '#live-overnight');
  assert.equal(navigation.comparisonReturnUrl('https://example.test/location/mtbaker/snow-summary'), '/user/favorites/locations/snow-summary');
  assert.equal(navigation.comparisonReturnUrl('https://example.test/location/mtbaker/snow-summary?compareDays=99&compareNight=%2F%2Fevil.test'), '/user/favorites/locations/snow-summary');
});

test('forecast detail navigation preserves comparison return context', () => {
  const current = 'https://example.test/location/mtbaker/snow-summary?compareDays=3&compareNight=2026-10-19';
  const target = '/location/mtbaker/snow-summary?night=2026-10-20&days=5#live-daily';
  const url = navigation.forecastDetailUrl(current, target, 'mtbaker');
  assert.equal(url.searchParams.get('compareDays'), '3');
  assert.equal(url.searchParams.get('compareNight'), '2026-10-19');
  assert.equal(url.searchParams.get('night'), '2026-10-20');
  assert.equal(url.searchParams.get('days'), '5');
  assert.equal(url.hash, '#live-daily');
});

test('resort detail exposes Today and forecast navigation with a comparison return', async t => {
  const server = createApp({ load: async () => ({ models: [], sources: [], stations: [], snowLevels: [] }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/location/mtbaker/snow-summary`);
  const html = await response.text();
  assert.match(html, /id="back-to-comparison"[^>]*>[^<]*Back to comparison/);
  const primary = /<nav aria-label="Forecast sections"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] || '';
  for (const [id, label] of [['live-overnight','Today'],['live-extended','15 days'],['live-conditions','Conditions'],['live-daily','Forecast'],['live-models','Models']]) {
    assert.match(primary, new RegExp(`href="#${id}"[^>]*>${label}<`));
  }
  assert.ok(html.indexOf('aria-label="Forecast sections"') < html.indexOf('id="live-summary"'), 'navigation appears before the summary');
  for (const id of ['live-daily','live-models','live-precip']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /href="#live-precip"/);
  assert.doesNotMatch(html, /id="live-night-timing"|href="#live-night-timing"/);
});
