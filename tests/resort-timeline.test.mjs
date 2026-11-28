import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setDisplayLanguage, setDisplayUnits } from '../src/i18n.mjs';
import * as comparison from '../src/resort-comparison.mjs';
import { comparisonReturnUrl, forecastDetailUrl } from '../src/navigation.mjs';
import { HOUR } from '../src/time.mjs';
import zh from '../public/clone/zh-CN.mjs';
import { resortTimelineFixture, TIMELINE_NOW as NOW } from './fixtures/resort-comparison.mjs';

function timeline(entries = resortTimelineFixture(), now = NOW, options = {}) {
  assert.equal(typeof comparison.buildResortTimeline, 'function', 'the comparison exposes a 15-day view');
  return comparison.buildResortTimeline(entries, now, options);
}

const view = await readFile(new URL('../public/clone/resort-comparison-view.mjs', import.meta.url), 'utf8');
const resolved = view.replaceAll(/from '\/lib\/([^']+)'/g, (_, file) => "from '" + new URL('../src/' + file, import.meta.url).href + "'");
const { renderComparison } = await import('data:text/javascript;base64,' + Buffer.from(resolved).toString('base64'));

test('Today and Overview replace the forecast window picker', () => {
  const today = renderComparison(comparison.buildResortComparison(resortTimelineFixture(), NOW));
  const overview = renderComparison(timeline());
  const tags = html => [...html.matchAll(/<button[^>]*data-compare-view="[^"]+"[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)]
    .map(([, selected, label]) => [label, selected === 'true']);

  assert.deepEqual(tags(today), [['Today', true], ['Overview', false]]);
  assert.deepEqual(tags(overview), [['Today', false], ['Overview', true]]);
  assert.match(today, /class="compare-toolbar">\s*<div class="compare-controls">\s*<nav class="compare-view-switch"/);
  assert.doesNotMatch(today, /Choose a forecast window|data-compare-days=/);
});

test('each five-day subtotal uses the color with the most snowfall inches', () => {
  const { rows } = timeline();
  assert.deepEqual(rows.map(row => row.blocks.map(block => [block.blendedIn, block.category])), [
    [[15, 'heavy'], [6, 'good'], [2, 'neutral']],
    [[24, 'good'], [8, 'good'], [3, 'good']],
    [[7, 'wet'], [2, 'wet'], [0, 'neutral']],
    [[28, 'good'], [12, 'good'], [7, 'good']],
  ]);
  const dayColors = rows[0].days.slice(0, 5).map(day => day.category);
  assert.deepEqual(dayColors, ['rain', 'wet', 'wet', 'heavy', 'neutral']);
  assert.equal(rows[3].days[2].category, 'good', 'exactly seven inches stays blue');
});

test('the blend retains unrounded totals, uses a strict seven-inch threshold, and caps only bar fill', () => {
  const entries = resortTimelineFixture(NOW, { stevenspass: [7.01, .4, .4, .4, 13] });
  const row = timeline(entries).rows[0];
  assert.equal(row.days[0].category, 'heavy');
  assert.equal(row.days[0].blendedIn, 7.01);
  assert.equal(row.days[4].fraction, 1);
  assert.equal(row.days[4].blendedIn, 13);
  assert.equal(row.blocks[0].blendedIn, 21.21);
});

test('every resort uses matching Pacific dates, including the month rollover and DST-day length', () => {
  const result = timeline();
  assert.equal(result.rows.length, 4);
  assert.ok(result.rows.every(row => row.days.length === 15));
  assert.equal(result.days[0].start, Date.parse('2026-11-28T03:00Z'));
  assert.equal(result.days[4].calendarStart, Date.parse('2026-12-01T08:00Z'));
  assert.equal(result.days[1].weekend, true);
  assert.equal(result.days[3].weekend, false);
  const beforeMidnight = Date.parse('2026-11-01T06:30Z');
  const afterMidnight = beforeMidnight + HOUR;
  const first = timeline({}, beforeMidnight).days;
  assert.equal(first[0].calendarStart, Date.parse('2026-10-31T07:00Z'));
  assert.equal(first[1].calendarStart, Date.parse('2026-11-01T07:00Z'));
  assert.equal(first[1].end - first[1].start, 25 * HOUR);
  assert.equal(timeline({}, afterMidnight).days[0].calendarStart, first[1].calendarStart);
});

test('zero, missing coverage, and stale observations keep separate evidence behind their amounts', () => {
  const entries = resortTimelineFixture();
  entries.stevenspass.data.models.forEach(m => {
    m.points = m.points.filter(p => p.time !== Date.parse('2026-11-30T18:00Z'));
  });
  entries.summitcentral = { failed: true };
  const { rows } = timeline(entries);
  assert.equal(rows[0].days[3].blendedIn, null);
  assert.equal(rows[0].blocks[0].blendedIn, null);
  assert.equal(rows[0].blocks[0].category, 'neutral');
  assert.equal(rows[1].observation.reading.value, 0);
  assert.equal(rows[2].observation.reading, null);
  assert.equal(rows[2].days[0].blendedIn, null);
  assert.equal(rows[3].observation.reading.state, 'stale');
  assert.equal(rows[3].observation.reading.value, 2);
  const html = renderComparison(timeline(entries));
  assert.match(html, /Forecast unavailable/);
  assert.match(html, /No snow-board reading/);
  assert.match(html, /Stale/);
  assert.match(html, /data-available="false"[^>]*>[\s\S]*?>0<\/span>/);
});

test('the 15-day view renders one date axis and localized units at an equivalent bar scale', () => {
  const result = timeline();
  const html = renderComparison(result);
  assert.match(html, /Days 1–5/);
  assert.match(html, /Days 6–10/);
  assert.match(html, /Days 11–15/);
  assert.equal((html.match(/data-timeline-date=/g) || []).length, 15);
  assert.match(html, /Remaining today/);
  assert.match(html, /15″/);
  assert.match(html, /10 in/);
  try {
    setDisplayLanguage('zh-CN', zh);
    setDisplayUnits({ depth: 'cm' });
    const translated = renderComparison(result);
    assert.match(translated, /第 6 至 10 天/);
    assert.match(translated, /25\.4 厘米/);
    assert.match(translated, /39\s?厘米/);
    const heights = page => [...page.matchAll(/--timeline-bar-height:([\d.]+)%/g)].map(match => match[1]);
    assert.equal(heights(html).length, 60);
    assert.deepEqual(heights(translated), heights(html));
  } finally {
    setDisplayLanguage('en');
    setDisplayUnits({});
  }
});

test('opening a resort outlook and returning restores the comparison stage', () => {
  const { rows } = timeline(undefined, NOW, { stage: 3 });
  const detail = new URL(rows[1].href, 'https://example.test');
  assert.equal(detail.pathname, '/location/crystalmountain/snow-summary');
  assert.equal(detail.hash, '#live-extended');
  assert.equal(comparisonReturnUrl(detail), '/user/favorites/locations/snow-summary?view=15d&stage=3#live-overnight');
  const onward = forecastDetailUrl(detail, '#live-daily', 'crystalmountain');
  assert.equal(comparisonReturnUrl(onward), comparisonReturnUrl(detail));
  detail.searchParams.set('compareStage', '999');
  assert.equal(comparisonReturnUrl(detail), '/user/favorites/locations/snow-summary?view=15d#live-overnight');
});
