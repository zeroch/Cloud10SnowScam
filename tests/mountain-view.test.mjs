import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MORNING_RESORTS, RESORTS } from '../src/config.mjs';
import { ageSnapshot } from '../src/display.mjs';

const source = (await readFile(new URL('../public/clone/live-view.mjs', import.meta.url), 'utf8'))
  .replaceAll(/from '\/lib\/([^']+)'/g, (_, file) => `from '${new URL('../src/' + file, import.meta.url).href}'`);
const view = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const H = 3_600_000, NOW = Date.parse('2026-11-03T20:30:00Z');
const data = resort => ({ resort, generatedAt: NOW, models: [{ id: 'a', label: 'Model A', points: Array.from({ length: 400 }, (_, i) => ({ time: Date.parse('2026-11-03T08:00:00Z') + i * H, snowIn: 0.01 })) }],
  sources: [{ id: 'forecast', status: 'cached', fetchedAt: NOW, refreshAfterMs: H }, { id: 'nwac', status: 'cached', fetchedAt: NOW, refreshAfterMs: H }, { id: 'wsdot', status: 'cached', fetchedAt: NOW, refreshAfterMs: H }], stations: [], snowLevels: [],
  morning: { station: { ...MORNING_RESORTS[resort.id].station, snowfall24h: { value: 2.4, observedAt: NOW - 2 * H }, depth: { value: 12, observedAt: NOW - H }, temperature: { value: 33, observedAt: NOW - 4 * H } },
    road: { passName: 'Stevens Pass US 2', condition: '<script>bad</script>', directions: [{ direction: 'Eastbound', message: 'Chains advised' }], issuedAt: null, url: 'https://wsdot.com/travel/real-time/mountainpasses/stevens' },
    roadLink: 'https://wsdot.com/travel/real-time/mountainpasses/stevens' } });

test('15-day view shows full and partial model coverage without creating snowfall for missing data', () => {
  assert.equal(typeof view.extendedOutlook, 'function');
  const d = data(RESORTS[0]); d.models[0].points.splice(24 * 7);
  const html = view.extendedOutlook(d, { now: NOW });
  assert.match(html, /15.day snowfall/i);
  assert.match(html, /Days 1–5<\/span>\s*<strong>2<small> in<\/small>/);
  assert.match(html, /Days 6–10/);
  assert.match(html, /Days 11–15<\/span>\s*<strong>Unavailable<\/strong>/);
  assert.match(html, /class="mountain-day-amount">1<\/span>/);
  assert.match(html, /1 model/); assert.match(html, /Unavailable/); assert.match(html, /remaining/i);
  assert.match(html, /class="mountain-day-models">1 model</);
  assert.match(html, /id="fifteen-day-timeline"[^>]*tabindex="0"/);
  assert.doesNotMatch(html, /NaN|undefined/);
});

test('15-day snowfall colors use current snow levels and a strict eight-inch threshold', () => {
  const snapshot = data(RESORTS[1]);
  const end = Date.parse('2026-11-04T08:00:00Z');
  const belowPoint = { start: NOW, end, feet: snapshot.resort.elevationFt - 1 };
  const source = { id: 'nws', status: 'cached', fetchedAt: NOW };
  snapshot.sources.push(source);
  snapshot.snowLevels = [belowPoint];
  const points = snapshot.models[0].points;
  points.forEach(point => { point.snowIn = 0; });
  const lastHour = points.find(point => point.time === end);
  const today = snowfall => {
    lastHour.snowIn = snowfall;
    const html = view.extendedOutlook(snapshot, { now: NOW });
    return html.match(/<li class="mountain-day"[\s\S]*?<\/li>/)[0];
  };

  assert.match(today(8), /data-accumulation="wet"/);
  const heavy = today(8.01);
  assert.match(heavy, /data-accumulation="heavy"/);
  assert.match(heavy, /class="mountain-day-amount">9<\/span>/);
  assert.match(today(8.5), /class="mountain-day-amount">9<\/span>/);
  assert.match(today(0), /data-accumulation="none"/);
  assert.match(today(null), /mountain-bar-missing/);

  snapshot.snowLevels = [{ ...belowPoint, feet: snapshot.resort.elevationFt }];
  assert.match(today(3), /data-accumulation="snow"/);
  snapshot.snowLevels = [{ ...belowPoint, end: end - H }];
  assert.match(today(3), /data-accumulation="snow"/);
  snapshot.snowLevels = [belowPoint];
  source.status = 'stale';
  assert.match(today(3), /data-accumulation="snow"/);
});

test('a saved road report with an unknown issue time also reports overdue collection', () => {
  const d = data(RESORTS[0]);
  d.sources.find(source => source.id === 'wsdot').fetchedAt = NOW - 2 * H;
  const html = view.morningConditions(ageSnapshot(d, NOW));
  assert.match(html, /report time unavailable/i);
  assert.match(html, /saved report.*update overdue/i);
});

test('morning decision separates observed snowfall from station depth and escapes road text', () => {
  assert.equal(typeof view.morningConditions, 'function');
  const html = view.morningConditions(ageSnapshot(data(RESORTS[0]), NOW), { now: NOW });
  assert.match(html, /Nearby station · Brooks/);
  assert.match(html, /NWAC · 4,800 ft/);
  assert.match(html, /snow depth/i);
  assert.match(html, /total snow on the ground at this station/i);
  assert.match(html, /Past 24h snow accumulation<\/span>\s*<strong>2\.4<span> in<\/span><\/strong><small>Observed/);
  assert.match(html, /since the board was last cleared/i);
  assert.match(html, /report time unavailable/i); assert.match(html, /Chains advised/);
  assert.match(html, /id="nwac-station-link"[^>]*href="https:\/\/nwac\.us\/weather\/stations\/stevens-pass-brooks"/);
  assert.match(html, /id="wsdot-road-link"/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /stale/i);
});

test('missing morning data produces explicit unavailable states for each resort', () => {
  assert.equal(typeof view.morningConditions, 'function');
  for (const resort of RESORTS) {
    const snapshot = data(resort);
    const previous = { ...snapshot.morning, station: { name: 'Old station', triplet: '791:WA:SNTL', depth: snapshot.morning.station.depth } };
    for (const morning of [undefined, previous]) {
      const html = view.morningConditions({ ...snapshot, morning });
      assert.match(html, /no snow-board reading/i);
      assert.doesNotMatch(html, /12 in|Old station/);
    }
  }
});
