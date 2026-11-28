import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { forecastWindow } from '../src/forecast.mjs';
import { setDisplayLanguage, setDisplayUnits } from '../src/i18n.mjs';
import chinese from '../public/clone/zh-CN.mjs';
import { RESORT } from '../src/config.mjs';
import { overnightFixture, EXAMPLE_NOW } from './fixtures/overnight.mjs';
import { horizonFixture, HORIZON_NOW } from './fixtures/horizon.mjs';

// Resolve the browser's /lib imports to their real source files for Node.
const source = (await readFile(new URL('../public/clone/live-view.mjs', import.meta.url), 'utf8'))
  .replaceAll(/from '\/lib\/([^']+)'/g, (_, file) => `from '${new URL('../src/' + file, import.meta.url).href}'`);
const viewUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const view = await import(viewUrl);
async function importViewModule(name) {
  const source = (await readFile(new URL(`../public/clone/${name}.mjs`, import.meta.url), 'utf8'))
    .replaceAll(/from '\/lib\/([^']+)'/g, (_, file) => `from '${new URL('../src/' + file, import.meta.url).href}'`)
    .replace("from './live-view.mjs'", `from '${viewUrl}'`);
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const { drawComparison, metricValue } = await importViewModule('live-chart');
const { renderHourlyForecast } = await importViewModule('hourly-forecast');
const H = 3600000, now = Date.parse('2026-01-05T00:00Z');
const state = { ...forecastWindow(now, 3), days: 3, metric: 'snow', ids: ['a'], now, index: 0 };
const data = () => ({
  resort: { latitude: 47.74, longitude: -121.09, elevationFt: 4800 },
  models: [{ id: 'a', label: 'Model A', color: '#3498db', description: 'Test model', points: Array.from({ length: 121 }, (_, i) => ({ time: now + i * H, snowIn: 0.5, precipIn: 0.05, temperatureF: 25, cloudPct: 90 })) }],
  sources: [{ id: 'forecast', name: 'Forecast', status: 'fresh', fetchedAt: now }, { id: 'nws', name: 'NWS', status: 'stale', fetchedAt: now - 24 * H }],
  snowLevels: [{ start: now, end: now + 121 * H, feet: 2000 }], stations: [],
});

test('hourly card groups dates at local midnight, including both daylight-saving changes', () => {
  for (const [clock, expected] of [
    ['2026-11-28T03:04Z', [4,24,8]], ['2026-11-01T05:40Z', [1,25,10]], ['2026-03-08T06:40Z', [1,23,12]],
  ]) {
    const html = renderHourlyForecast({ resort: RESORT, models: [], sources: [] }, { now: Date.parse(clock) });
    assert.deepEqual([...html.matchAll(/scope="colgroup" colspan="(\d+)"/g)].map(m => Number(m[1])), expected);
    assert.equal(new Set([...html.matchAll(/<time datetime="([^"]+)"/g)].map(m => m[1])).size, 36);
    assert.match(html, /class="hourly-total"><strong>—<\/strong>/);
    assert.equal(html.match(/data-level-band="missing"/g).length, 36);
    if (expected[1] === 25) {
      assert.match(html, /1 AM PDT/);
      assert.match(html, /1 AM PST/);
    }
  }
});

test('hourly card localizes snowfall and gives each weather glyph a visible key', ctx => {
  ctx.after(() => { setDisplayUnits({}); setDisplayLanguage('en'); });
  setDisplayUnits({ depth: 'cm' });
  setDisplayLanguage('zh-CN', chinese);
  const points = Array.from({ length: 37 }, (_, i) => ({
    time: now + i * H, snowIn: i === 1 ? 1 : 0, precipIn: 0.1, temperatureF: 29,
  }));
  const html = renderHourlyForecast({ resort: RESORT, models: [{ id: 'ecmwf_ifs025', points }] }, { now, ids: [] });
  assert.match(html, /逐小时预报/);
  assert.match(html, /class="hourly-total"><strong>2.54 厘米/);
  assert.match(html, /第 1–6 小时，共 36 小时/);
  const [grid, key] = html.split('<div class="hourly-footer">');
  assert.equal(grid.match(/role="img"/g).length, 36);
  for (const [, name] of grid.matchAll(/hourly-weather\.svg#([^"]+)"/g)) {
    assert.ok(key.includes('hourly-weather.svg#' + name + '"'), name);
  }
  assert.match(key, /降水类型不确定/);
  assert.doesNotMatch(grid, /<select|Liquid precip/);
});

test('folded snowfall flags a stale ECMWF snapshot independently of NWS snow levels', () => {
  const data = { resort: RESORT, models: [], sources: [{ id: 'forecast', status: 'cached' }, { id: 'nws', status: 'stale' }] };
  const summary = () => renderHourlyForecast(data, { now }).split('</summary>')[0];
  assert.doesNotMatch(summary(), /stale forecast/);
  data.sources[0].status = 'stale';
  assert.match(summary(), /36-hour snowfall · stale forecast/);
});

test('rounded ranges do not imply a spread smaller than displayed precision', () => {
  assert.equal(view.rangeText({ min: 0, max: 0.004 }), '0 in');
  assert.equal(view.rangeText({ min: 4.81, max: 4.84 }), '4.8 in');
});

test('chart inspection rounds snowfall up while preserving zero, missing and liquid precipitation', () => {
  assert.equal(metricValue(.0004, 'snow'), '1 in');
  assert.equal(metricValue(3.996, 'snow'), '4 in');
  assert.equal(metricValue(0, 'snow'), '0 in');
  assert.equal(metricValue(null, 'snow'), 'Unavailable');
  assert.equal(metricValue(.39, 'precip'), '0.39 in');
});

test('daily and chart displays convert temperature and precipitation independently', ctx => {
  ctx.after(() => setDisplayUnits({}));
  const snapshot = data();
  setDisplayUnits({ temperature: 'C' });
  assert.equal(metricValue(32, 'temperature'), '0 °C');
  assert.equal(metricValue(-40, 'temperature'), '-40 °C');
  assert.equal(metricValue(.5, 'precip'), '0.50 in');
  setDisplayUnits({ depth: 'cm' });
  assert.equal(metricValue(32, 'temperature'), '32 °F');
  assert.equal(metricValue(.5, 'precip'), '1.27 cm');
  assert.equal(metricValue(.00001, 'snow'), '1 cm');
  assert.equal(metricValue(null, 'snow'), 'Unavailable');
  assert.match(view.daily(snapshot, state), /Liquid precip<br>cm/);
  const cells = view.precipitation(snapshot, { ...state, precipField: 'precipIn', precipHours: 6, precipPeriod: 'all' });
  assert.match(cells, /0\.762 cm[^>]*data-amount="0\.3">0\.76<\/td>/);
});

test('coverage identifies missing values for the selected variable', () => {
  const snapshot = data();
  snapshot.models[0].points.forEach(p => { p.cloudPct = null; });
  const html = view.comparison(snapshot, { ...state, metric: 'cloud' }).replace(/<[^>]+>/g, '');
  assert.doesNotMatch(html, /Model A · full window/);
  assert.match(html, /Model A · unavailable/);
  snapshot.models[0].points[10].snowIn = null;
  assert.match(view.comparison(snapshot, state).replace(/<[^>]+>/g, ''), /Model A · ends Mon, Jan 5 1:00 AM PT/);
});

test('day/night forecast shows NWS freshness beside its separate values', () => {
  const html = view.daily(data(), state);
  assert.match(html, /NWS snow level · stale/i);
  assert.match(html, /live-warning/);
});

test('precipitation grid distinguishes a dry interval from a missing one', () => {
  const snapshot = data();
  snapshot.models[0].points.forEach(p => { p.precipIn = 0; });
  snapshot.models[0].points[12].precipIn = null;
  const html = view.precipitation(snapshot, { ...state, precipHours: 6, precipField: 'precipIn', precipTotals: false });
  assert.match(html, /data-amount="0"[^>]*>0\.00</);
  assert.match(html, /data-missing="true"[^>]*><span aria-hidden="true">—<\/span><span class="cloud-sr-only">Unavailable; 5\/6 hours/);
  assert.doesNotMatch(html, /NaN|undefined/);
  snapshot.models[0].points.forEach(point => { point.snowIn = 0.05; });
  const snow = view.precipitation(snapshot, { ...state, precipHours: 6, precipField: 'snowIn' });
  assert.match(snow, /title="[^"]* · 1 in" data-amount="0\.3">1<\/td>/);
});

test('precipitation window totals agree with the selected model and preserve incomplete horizons', () => {
  const snapshot = data();
  snapshot.models.push({ ...snapshot.models[0], id: 'b', label: 'Short model', points: snapshot.models[0].points.slice(0, 20) });
  const html = view.precipitation(snapshot, { ...state, ids: ['a', 'b'], precipTotals: true });
  assert.match(html, /data-model-total="a"[\s\S]*?36 in/);
  assert.match(html, /data-model-total="b"[\s\S]*?Incomplete window/);
});

test('stale snow forecasts cannot produce a favorable overnight headline', () => {
  const snapshot = overnightFixture(); snapshot.sources[0].status = 'stale';
  const options = { ...state, now: EXAMPLE_NOW };
  assert.match(view.outlook(snapshot, options), /Saved forecast/);
  assert.doesNotMatch(view.outlook(snapshot, options), /Models split on your target/);
  assert.match(view.summary(snapshot, options), /Saved forecast/);
});

test('a partially dry live chart cannot claim the complete window is dry', () => {
  // Only the DOM boundary is stubbed; the real SVG renderer and data are exercised.
  const container = { clientWidth: 1000, innerHTML: '', querySelector: () => ({ addEventListener() {} }) };
  const times = Array.from({ length: 121 }, (_, i) => now + i * H);
  const line = { id: 'hrrr', label: 'HRRR', color: '#3498db', values: times.map((_, i) => i <= 18 ? 0 : null) };
  for (const metric of ['snow', 'precip']) {
    drawComparison(container, { times, lines: [line] }, metric, 0, () => {});
    assert.equal(container.innerHTML.includes('No measurable'), false, `${metric}: partial dry hours are not a dry five-day forecast`);
    drawComparison(container, { times, lines: [{ ...line, values: times.map(() => 0) }] }, metric, 0, () => {});
    assert.equal(container.innerHTML.includes('No measurable'), true, `${metric}: a fully covered dry forecast can be labeled`);
  }
});

test('remaining overnight snow is not classified against the full-night target', () => {
  const now = Date.parse('2026-10-16T11:30Z');
  const html = view.outlook(overnightFixture({ now }), { ...state, now });
  assert.doesNotMatch(html, /Below your 4–5 inch target/);
  assert.match(html, /Remaining overnight forecast/);
  assert.match(html, /Already fallen: unconfirmed/);
});

test('a single available model cannot imply agreement between models', () => {
  const snapshot = overnightFixture(); snapshot.models = snapshot.models.slice(0, 1);
  const html = view.outlook(snapshot, { ...state, now: EXAMPLE_NOW });
  assert.match(html, /Only ECMWF/); assert.match(html, /1 of 5/); assert.doesNotMatch(html, /Models split/);
});

test('the same all-model overnight evidence leads the summary even with filtered exploration', () => {
  const data = overnightFixture(), options = { ...state, ...forecastWindow(EXAMPLE_NOW,3), now: EXAMPLE_NOW, ids: ['icon_global'] };
  const detail = view.outlook(data, options), summary = view.summary(data, options);
  assert.ok(summary.startsWith(detail));
  assert.match(detail, /3–8 in/);
  for (const name of ['ECMWF','GFS','ICON','GDPS','HRRR']) assert.ok(detail.includes(name));
  assert.match(detail, /All available models/);
  assert.match(summary, /Actual snowfall unconfirmed/);
  assert.doesNotMatch(summary, /Recheck NWAC in the morning/);
});

test('morning review hides forecast totals as observed snow and offers an explicit next-night choice', () => {
  const now = Date.parse('2026-10-16T13:00Z');
  const html = view.outlook(overnightFixture({ now }), { ...state, now });
  assert.match(html, /Last night/); assert.match(html, /Unconfirmed/);
  assert.match(html, /data-night-choice="tonight"/);
  assert.doesNotMatch(html, /data-night-model=/);
  assert.match(html, /https:\/\/nwac.us\/weather\/stations\/stevens-pass-brooks/);
});

test('the final hour cannot label a stale collection as current', () => {
  const now = Date.parse('2026-10-16T12:30Z');
  const snapshot = overnightFixture({ now }); snapshot.sources[0].status = 'stale';
  const html = view.outlook(snapshot, { ...state, now });
  assert.match(html, /Saved forecast/);
  assert.doesNotMatch(html, /Forecast collection current/);
});

test('partial NWS coverage exposes its actual available intervals in the disclosure', () => {
  const snapshot = overnightFixture(); snapshot.snowLevels.splice(1, 1);
  const html = view.summary(snapshot, { ...state, now: EXAMPLE_NOW });
  assert.match(html, /Partial coverage/);
  assert.match(html, /NWS intervals available for this window/);
  assert.match(html, /6:00 PM PT → Thu, Oct 15 9:00 PM PT/);
  assert.doesNotMatch(html, /9:00 PM PT → Fri, Oct 16 12:00 AM PT/);
});

test('both summary surfaces expose threshold counts for their full forecast windows', () => {
  for (const page of ['favorites','stevens']) {
    const now = page === 'stevens' ? EXAMPLE_NOW - H : EXAMPLE_NOW;
    const snapshot = overnightFixture({ now });
    if (page === 'stevens') snapshot.snowLevels.unshift({ start: now, end: EXAMPLE_NOW + H, feet: 4200 });
    const html=view.summary(snapshot,{...state,now,page,ids:['icon_global']});
    assert.match(html,/data-target-inches="4"[\s\S]*?3 of 5/);
    assert.match(html,/data-target-inches="5"[\s\S]*?2 of 5/);
    assert.doesNotMatch(html, /data-night-timing|#live-night-timing/);
    assert.match(html,/class="cloud-range-note"[^>]*>[^<]*actual snowfall can differ/i);
    assert.match(html,/data-uncertainty="snow-level"/);
  }
});

test('missing model counts say available models, and stale counts are not presented as current support', () => {
  const snapshot=overnightFixture();snapshot.models.pop();
  const html=view.outlook(snapshot,{...state,now:EXAMPLE_NOW});
  assert.match(html,/2 of 4/);assert.match(html,/available models/);
  snapshot.sources[0].status='stale';
  assert.doesNotMatch(view.outlook(snapshot,{...state,now:EXAMPLE_NOW}),/data-target-inches/);
});

test('snow-level mode identifies NWS before the plot and does not offer irrelevant model filters', () => {
  const snapshot = data();
  snapshot.sources[0].status = 'unavailable';
  snapshot.sources[1].status = 'cached';
  const html = view.comparison(snapshot, { ...state, metric: 'level' });
  assert.doesNotMatch(html, /data-live-model|data-live-toggle|Forecast unavailable/);
  assert.ok(html.indexOf('NWS snow level') < html.indexOf('id="live-chart"'));
  assert.match(html, /[Mm]odel selection does not apply/);
});

test('the scrollable daily table keeps snowfall and NWS coverage together without turning a trace into zero', () => {
  const snapshot = data(); snapshot.models[0].points.forEach(p => { p.snowIn = .00001; });
  snapshot.snowLevels = [{ start: now + 3 * H, end: now + 4 * H, feet: 2500 }];
  const html = view.daily(snapshot, state);
  assert.match(html, /aria-label="Full day and night forecast table, scroll horizontally"/);
  assert.match(html, /Blended snowfall 1 in/);
  assert.match(html, /Partial coverage/);
  assert.match(html, /Snowfall[\s\S]*?Snow level/);
});

test('precipitation period selection clips to the remaining night and falls back when a horizon excludes it', () => {
  assert.equal(typeof view.precipitationWindow, 'function');
  const start = Date.parse('2026-10-16T06:00Z'); // 11 pm Pacific
  const window = { start, end: start + 24 * H, days: 1 };
  const selected = view.precipitationWindow({ ...window, precipPeriod: 'next-night' });
  assert.equal(selected.start, start);
  assert.equal(selected.end, Date.parse('2026-10-16T13:00Z'));
  assert.equal(selected.partial, true);
  const expired = view.precipitationWindow({ ...window, precipPeriod: '0' });
  assert.equal(expired.key, selected.key);
  const full = view.precipitationWindow({ ...window, precipPeriod: 'all' });
  assert.equal(full.end, start + 24 * H);
});

test('precipitation period selection preserves the real duration across the fall DST night', () => {
  assert.equal(typeof view.precipitationWindow, 'function');
  const start = Date.parse('2026-11-01T01:00Z'); // Oct 31 6 pm PDT
  const period = view.precipitationWindow({ start, end: start + 24 * H, days: 1 });
  assert.equal(period.end, Date.parse('2026-11-01T14:00Z')); // Nov 1 6 am PST
  assert.equal((period.end - period.start) / H, 13);
});

test('phone precipitation totals retain missing-hour evidence for both snowfall and liquid precipitation', () => {
  const snapshot = data(); snapshot.models[0].points[12].precipIn = null;
  const html = view.precipitation(snapshot, { ...state, precipTotals: true });
  const mobile = html.match(/<div class="live-totals-mobile">([\s\S]*?)<!-- end mobile totals -->/)?.[1];
  assert.ok(mobile, 'phone totals are present');
  assert.match(mobile, /36 in/);
  assert.match(mobile, /71\/72 hours/);
  assert.match(mobile, /Unavailable/);
});

test('Tomorrow leads with forecast facts and keeps detailed model evidence in a closed disclosure', () => {
  const html = view.summary(overnightFixture(), { ...state, now: EXAMPLE_NOW, page: 'favorites' });
  const entry = html.split('<details id="tomorrow-details"')[0];
  assert.match(entry, /data-snowfall-value="5"/);
  assert.match(entry, /5-model blend/);
  assert.doesNotMatch(html, /\$\{morning/);
  assert.match(entry, /data-model-agreement="low"/);
  assert.match(entry, /data-condition="normal"[^>]*data-selected="true"/);
  assert.match(entry, /Wet early/);
  assert.doesNotMatch(entry, /ECMWF|HRRR|What to watch/);
  assert.match(html, /<details id="tomorrow-details"[^>]*><summary/);
  assert.doesNotMatch(html, /<details id="tomorrow-details"[^>]*\bopen\b/);
  assert.match(html.split('<details id="tomorrow-details"')[1], /3–8 in/);
  assert.match(html, /data-tomorrow-horizon="3"/);
  assert.match(html, /data-tomorrow-horizon="5"/);
});

test('resort Today names the opening forecast and separates it from the past 24h report', () => {
  const now = Date.parse('2026-10-16T13:00Z');
  const snapshot = overnightFixture({ now });
  snapshot.morning = { station: { stid: '50', snowfall24h: { value: 4, observedAt: now, state: 'fresh' } } };
  snapshot.models.forEach((model, index) => {
    for (const point of model.points) point.snowIn = point.time === Date.parse('2026-10-16T15:00Z') ? (index === 0 ? 1 : 3) : 0;
  });
  const current = { ...state, page: 'stevens', now };
  const html = view.summary(snapshot, current);
  const [card, details] = html.split('<details id="tomorrow-details"');
  assert.match(card, /Today<\/h2><p>Fri, Oct 16<\/p>/);
  assert.match(card, /Still expected to fall[\s\S]*?1–3[\s\S]*?6:00 AM–8:00 AM · Fri, Oct 16 PT/);
  assert.match(card, /Already accumulated[\s\S]*?<strong>4<\/strong>[\s\S]*?Past 24h report · as of Fri, Oct 16 6:00 AM PT/);
  assert.doesNotMatch(card, /No recent snowfall report/);
  assert.ok(card.indexOf('Still expected to fall') < card.indexOf('Already accumulated'));
  assert.match(details, /Opening forecast[\s\S]*?8:00 AM/);
  assert.match(details, /Personal snow rating: Good/);
  assert.doesNotMatch(details, /data-target-inches=/);
  assert.doesNotMatch(html, /Forecast horizon|Night to review|6 pm–6 am/);
  assert.equal(view.summary(snapshot, { ...current, horizon: 5, nightChoice: '2026-10-18' }), html);
});

test('resort Today leads with reported zero by day and keeps the next opening forecast in Details', () => {
  const now = Date.parse('2026-10-16T18:00Z');
  const snapshot = overnightFixture({ now });
  snapshot.morning = { station: { stid: '50', snowfall24h: { value: 0, observedAt: now - H, state: 'fresh' } } };
  snapshot.models.forEach((model, index) => {
    for (const point of model.points) point.snowIn = point.time === Date.parse('2026-10-16T23:00Z') ? (index === 0 ? 0 : 1)
      : point.time === Date.parse('2026-10-17T15:00Z') ? 7 : 0;
  });
  const current = { ...state, page: 'stevens', now };
  const [card, details] = view.summary(snapshot, current).split('<details id="tomorrow-details"');
  assert.match(card, /Already accumulated[\s\S]*?<strong>0<\/strong>[\s\S]*?Past 24h report · as of Fri, Oct 16 10:00 AM PT/);
  assert.match(card, /Still expected to fall[\s\S]*?0–1[\s\S]*?11:00 AM–4:00 PM · Fri, Oct 16 PT/);
  assert.ok(card.indexOf('Already accumulated') < card.indexOf('Still expected to fall'));
  assert.match(details, /Opening forecast[\s\S]*?Fri, Oct 16 4:00 PM PT → Sat, Oct 17 8:00 AM PT[\s\S]*?7 in/);

  snapshot.sources[0].status = 'stale';
  const saved = view.summary(snapshot, current).split('<details id="tomorrow-details"')[0];
  assert.match(saved, /Still expected to fall[\s\S]*?Saved forecast · update overdue/);
  snapshot.sources[0].status = 'cached';
  snapshot.morning.station.snowfall24h.state = 'stale';
  snapshot.models.forEach(model => model.points.find(point => point.time === now + H).snowIn = null);
  const missing = view.summary(snapshot, current).split('<details id="tomorrow-details"')[0];
  assert.match(missing, /Already accumulated[\s\S]*?No recent snowfall report/);
  assert.match(missing, /Still expected to fall[\s\S]*?Forecast unavailable/);
});

test('resort Today uses the blend when the complete-model range omits a snowfall signal', () => {
  const now = Date.parse('2026-10-16T13:00Z');
  const snapshot = overnightFixture({ now, totals: [0, 0, 0, 0, 0] });
  const preferred = snapshot.models[0];
  preferred.points.find(point => point.time === Date.parse('2026-10-16T14:00Z')).snowIn = null;
  preferred.points.find(point => point.time === Date.parse('2026-10-16T15:00Z')).snowIn = 2;
  const [card, details] = view.summary(snapshot, { ...state, page: 'stevens', now }).split('<details id="tomorrow-details"');
  assert.match(card, /Still expected to fall[\s\S]*?<strong>1<\/strong>/);
  assert.doesNotMatch(details, /Available models show no snow/);
});

test('Tomorrow uses the same quality rules as the horizon without coloring missing data as good snow', () => {
  const snapshot = horizonFixture();
  const entry = view.summary(snapshot, { ...state, now: HORIZON_NOW, nightChoice: 'tonight' }).split('<details id="tomorrow-details"')[0];
  assert.match(entry, /data-snow-quality="good"/);
  assert.ok(entry.indexOf('aria-label="Forecast horizon"') < entry.indexOf('data-snowfall-value'), 'horizon navigation precedes the forecast');
  snapshot.sources.find(s => s.id === 'forecast').status = 'stale';
  const saved = view.summary(snapshot, { ...state, now: HORIZON_NOW, nightChoice: 'tonight' }).split('<details id="tomorrow-details"')[0];
  assert.match(saved, /data-snow-quality="unknown"/);
  assert.doesNotMatch(saved, /data-snow-quality="good"/);
});

test('both forecast entry pages expose the summary, daily table and model comparisons together', async () => {
  for (const page of ['favorites', 'stevens']) {
    const html = await readFile(new URL(`../public/clone/${page}.html`, import.meta.url), 'utf8');
    for (const slot of ['summary', 'daily-forecast', 'forecast-range', 'precipitation-by-model']) {
      assert.equal(html.split(`data-live-slot="${slot}"`).length - 1, 1, `${page} includes one ${slot}`);
    }
  }
});

test('each detailed comparison has its own controls with unique IDs and the shared selected state', () => {
  const snapshot = data();
  const html = [view.daily(snapshot, state), view.comparison(snapshot, state), view.precipitation(snapshot, state)].join('');
  for (const prefix of ['daily', 'range', 'precip']) {
    assert.match(html, new RegExp(`id="${prefix}-days" data-comparison-days`));
    assert.match(html, new RegExp(`id="${prefix}-models"`));
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('forecast variables remain directly selectable and expose the selected metric', () => {
  for (const metric of ['snow', 'level', 'temperature', 'wind', 'gust', 'cloud']) {
    const html = view.comparison(data(), { ...state, metric });
    assert.match(html, new RegExp(`id="metric-${metric}" data-live-metric="${metric}" aria-pressed="true"`));
    for (const other of ['snow', 'level', 'temperature', 'wind', 'gust', 'cloud'])
      assert.match(html, new RegExp(`id="metric-${other}"`));
  }
});

test('daily snowfall uses the blend and keeps the full-period model range and coverage visible', () => {
  const snapshot = data();
  const start = Date.parse('2026-01-05T02:00Z'); // 6 pm Pacific
  snapshot.models = [0, .4, .8, null].map((total, index) => ({
    ...snapshot.models[0], id: String(index), label: `Model ${index}`,
    points: snapshot.models[0].points.map(p => ({ ...p, snowIn: total === null ? null : total / 12 })),
  }));
  const html = view.daily(snapshot, { ...state, start, end: start + 12 * H, ids: ['0', '1', '2', '3'] });
  assert.match(html, /Snowfall<br>blend · in/);
  assert.match(html, /<strong>1<\/strong>/);
  assert.match(html, /Range: 0–1 · 3\/4 models/);
  assert.match(html, /blended snowfall from the selected models/i);
  snapshot.models[1].points.forEach(p => { p.snowIn = 0; });
  const split = view.daily(snapshot, { ...state, start, end: start + 12 * H, ids: ['0', '1', '2', '3'] });
  assert.match(split, /data-no-snow="false"[^>]*>[\s\S]*?<strong>1<\/strong>/);
  assert.match(split, /Range: 0–1 · 3\/4 models/);
});

test('daily snow level compares the NWS range with the resort forecast elevation', () => {
  const snapshot = data(), start = Date.parse('2026-01-05T02:00Z');
  snapshot.resort.id = 'crystalmountain';
  snapshot.sources[1].status = 'fresh';
  const options = { ...state, start, end: start + 12 * H };
  const intervals = (low, high) => [
    { start, end: start + 6 * H, feet: low },
    { start: start + 6 * H, end: start + 12 * H, feet: high },
  ];
  snapshot.snowLevels = intervals(2800, 3300);
  let html = view.daily(snapshot, options);
  assert.match(html, /vs 5,600 ft · NWS/);
  assert.match(html, /Below point[\s\S]*?2,800–3,300 ft/);
  assert.match(html, /forecast point.*not the resort base/i);
  snapshot.snowLevels = intervals(6000, 6300);
  assert.match(view.daily(snapshot, options), /Above point/);
  snapshot.snowLevels = intervals(5000, 6000);
  assert.match(view.daily(snapshot, options), /Crosses point/);
  snapshot.snowLevels = intervals(5555, 5599);
  assert.match(view.daily(snapshot, options), /Near point/);
  snapshot.snowLevels = intervals(2800, 3300).slice(0, 1);
  html = view.daily(snapshot, options);
  assert.match(html, /Partial coverage[\s\S]*?2,800 ft in available hours · Below point/);
  snapshot.snowLevels = [];
  assert.match(view.daily(snapshot, options), /Unavailable[\s\S]*?No NWS coverage/);
  snapshot.snowLevels = intervals(2800, 3300);
  snapshot.sources[1].status = 'stale';
  assert.match(view.daily(snapshot, options), /2,800–3,300 ft · saved NWS forecast/);
});

test('compact daily cells preserve coverage and units without treating unavailable snow as zero', () => {
  const html = view.daily(data(), state);
  assert.match(html, /1 model/);
  assert.match(html, /Snowfall<br>blend · in/);
  const snapshot = data();
  snapshot.models[0].points.forEach(p => { p.snowIn = null; });
  const unavailable = view.daily(snapshot, state);
  assert.match(unavailable, /data-snow-available="false"/);
  assert.match(unavailable, /Unavailable/);
  assert.doesNotMatch(unavailable, /<strong>0<\/strong>/);
});

test('the day/night snow timeline uses available hourly forecasts and preserves missing periods', () => {
  assert.equal(typeof view.snowTimeline, 'function');
  const snapshot = data();
  const start = Date.parse('2026-01-05T02:00Z'); // 6 pm Pacific
  const options = { ...state, start, end: start + 24 * H };
  snapshot.models.push({ ...snapshot.models[0], id: 'b', label: 'Model B', points: snapshot.models[0].points.map(p => ({ ...p, snowIn: 1 })) });
  snapshot.models.push({ ...snapshot.models[0], id: 'c', label: 'Incomplete', points: [] });
  let html = view.snowTimeline(snapshot, { ...options, ids: ['a','b','c'] });
  assert.match(html, /data-period-snow="9"/); // Both available models share the fallback weight.
  assert.match(html, /2 of 3 models/);
  html = view.snowTimeline(snapshot, { ...options, ids: ['c'] });
  assert.match(html, /data-period-snow="missing"/);
  assert.doesNotMatch(html, /data-period-snow="0"/);
  snapshot.models[0].points.forEach(p => { p.snowIn = 0; });
  assert.match(view.snowTimeline(snapshot, { ...options, ids: ['a'] }), /data-period-snow="0"/);
});

test('the visible Tomorrow surface retains source gaps and elapsed-night warnings', () => {
  const data = overnightFixture(); data.snowLevels.splice(1, 1); data.models.pop();
  const entry = view.summary(data, { ...state, now: EXAMPLE_NOW }).split('<details id="tomorrow-details"')[0];
  assert.match(entry, /4 of 5 models/);
  assert.match(entry, /Partial data/);
  assert.doesNotMatch(entry, /data-selected="true"/);
  const now = Date.parse('2026-10-16T13:00Z');
  const morning = view.summary(overnightFixture({ now }), { ...state, now }).split('<details id="tomorrow-details"')[0];
  assert.match(morning, /Unconfirmed/);
  assert.match(morning, /data-night-choice="tonight"/);
  assert.match(morning, /https:\/\/nwac.us\/weather\/stations\/stevens-pass-brooks/);
  assert.doesNotMatch(morning, /data-selected="true"/);
});

test('an earlier wet condition retains its dated NWS evidence after snowfall switches to remaining hours', () => {
  const now = Date.parse('2026-10-16T11:30Z');
  const html = view.summary(overnightFixture({ now }), { ...state, now });
  assert.match(html.split('<details id="tomorrow-details"')[0], /Wet early/);
  const evidence = html.match(/<ul class="cloud-source-periods">([\s\S]*?)<\/ul>/)?.[1];
  assert.match(evidence, /Thu, Oct 15 6:00 PM PT/);
  assert.match(evidence, /4200 ft/);
});

test('each horizon uses all complete models and links the selected morning to Daily Forecast', () => {
  for (const horizon of [3,5]) {
    const html = view.summary(horizonFixture(), { ...state, now: HORIZON_NOW, horizon, ids: ['icon_global'], nightChoice: '2026-10-17' });
    const entry = html.split('<details id="horizon-details"')[0];
    assert.equal([...entry.matchAll(/data-snowfall-value=/g)].length, horizon);
    assert.match(entry, /aria-label="Approximately 5 inches"/);
    assert.match(entry, /5 models/);
    assert.match(entry, /4 models/);
    assert.match(entry, /Wet early/);
    assert.doesNotMatch(entry, /ECMWF|3–8 in/);
    assert.doesNotMatch(html, /data-night-timing|#live-night-timing/);
    assert.ok(html.includes(`night=2026-10-17&days=${horizon}#live-daily`), 'full comparison preserves the chosen horizon without local storage');
    assert.match(html, /<h2>Sun, Oct 18<\/h2>/);
    assert.match(html, /HRRR<\/th><td>—<\/td><td>0\/12/);
    assert.doesNotMatch(html, /NaN|undefined/);
  }
});

test('horizon overview makes remaining, stale and missing states visible before Details', () => {
  const now = Date.parse('2026-10-17T09:30Z');
  const snapshot = horizonFixture(now), options = { ...state, now, horizon: 5 };
  const entry = view.summary(snapshot, options).split('<details id="horizon-details"')[0];
  assert.match(entry, /remaining hours only · already fallen unconfirmed/);
  assert.match(entry, /inches, remaining/);
  snapshot.sources[0].status = 'stale';
  const saved = view.summary(snapshot, options).split('<details id="horizon-details"')[0];
  assert.match(saved, /Saved forecast · update overdue/);
  assert.match(saved, /Outdated/);
  assert.doesNotMatch(saved, /data-model-agreement="high"|data-morning-condition="wet"/);
  snapshot.sources[0].status = 'unavailable';
  const missing = view.summary(snapshot, options).split('<details id="horizon-details"')[0];
  assert.match(missing, /Forecast unavailable/);
  assert.doesNotMatch(missing, /data-snowfall-value="0"/);
});

test('after-midnight horizon evidence uses the actual remaining date and does not invent a zero-hour final forecast', () => {
  const now = Date.parse('2026-10-17T09:30Z');
  const html = view.summary(horizonFixture(now), { ...state, now, horizon: 5 });
  assert.match(html, /Sat, Oct 17 3 am → Sat, Oct 17 6 am PT · remaining hours/);
  const ending = Date.parse('2026-10-17T12:30Z');
  const end = view.summary(horizonFixture(ending), { ...state, now: ending, horizon: 5 });
  assert.match(end, /Final hour in progress/);
  assert.doesNotMatch(end, /6 am → 6 am|<td>0\/0<\/td>/);
});

test('the overnight summary shows forecast range and collection time before detailed evidence', () => {
  const snapshot = overnightFixture();
  const entry = view.summary(snapshot, { ...state, now: EXAMPLE_NOW, page: 'favorites' }).split('<details id="tomorrow-details"')[0];
  assert.match(entry, /Model range: 3–8 in/);
  assert.match(entry, /Forecast collected Thu, Oct 15 5:00 PM PT/);
  snapshot.sources.find(source => source.id === 'forecast').status = 'stale';
  const saved = view.summary(snapshot, { ...state, now: EXAMPLE_NOW, page: 'favorites' }).split('<details id="tomorrow-details"')[0];
  assert.match(saved, /Saved forecast · update overdue/);
  assert.doesNotMatch(saved, /Model range:/);
});

test('the elapsed-night summary explains why actual snowfall is unconfirmed', () => {
  const now = Date.parse('2026-10-16T13:00Z');
  const entry = view.outlook(overnightFixture({ now }), { ...state, now }).split('<details id="tomorrow-details"')[0];
  assert.match(entry, /Unconfirmed/);
  assert.match(entry, /Forecasts cannot confirm what fell/);
  assert.match(entry, /external report/);
});

test('the multi-night link to detailed daily forecast is marked to retain comparison context', () => {
  const snapshot = horizonFixture();
  const html = view.horizon(snapshot, { ...state, now: HORIZON_NOW, horizon: 5, days: 5, nightChoice: '2026-10-18' });
  assert.match(html, /data-forecast-detail[^>]*href="[^\"]+#live-daily"/);
});

test('forecast summary identifies estimated condition and model agreement before details', () => {
  const entry = view.summary(overnightFixture(), { ...state, now: EXAMPLE_NOW }).split('<details id="tomorrow-details"')[0];
  assert.match(entry, /Estimated morning condition/);
  assert.match(entry, /Model agreement/);
  assert.match(entry, /5 models<\/span> <strong>split<\/strong>/);
  assert.match(entry, /Tonight · 6 pm–6 am PT/);
});

test('chart identifies its selected model lines without opening the reading guide', () => {
  const snapshot = data();
  snapshot.models.push({ ...snapshot.models[0], id: 'b', label: 'Model B' });
  const beforeGuide = view.comparison(snapshot, { ...state, ids: ['a'] }).split('<details id="chart-reading-guide"')[0];
  const legend = beforeGuide.match(/<ul[^>]*aria-label="Forecast model legend"[^>]*>([\s\S]*?)<\/ul>/)?.[1];
  assert.ok(legend, 'the model legend is visible beside the chart');
  assert.match(legend, /Model A/);
  assert.doesNotMatch(legend, /Model B/);
  assert.match(legend, /<svg[^>]*class="live-line-key"/);
  assert.doesNotMatch(view.comparison(snapshot, { ...state, metric: 'level' }), /aria-label="Forecast model legend"/);
});

test('daily forecast explains how to reveal columns on scrollable screens', () => {
  assert.match(view.daily(data(), state), /Scroll horizontally to see all forecast fields/);
});

test('multi-night overview tells sighted users dates open their evidence', () => {
  const html = view.horizon(horizonFixture(), { ...state, now: HORIZON_NOW, horizon: 5 });
  const overview = html.split('<details id="horizon-details"')[0];
  assert.match(overview, /Select a morning for details/);
  assert.match(overview, /aria-controls="horizon-details"/);
});

test('rain-only summary does not attribute the rain estimate solely to snow level', () => {
  const snapshot = overnightFixture({ totals: [0, 0, 0, 0, 0] });
  for (const model of snapshot.models) for (const point of model.points) {
    if (point.time > Date.parse('2026-10-16T01:00Z') && point.time <= Date.parse('2026-10-16T13:00Z')) {
      point.precipIn = .02; point.temperatureF = 38;
    }
  }
  const entry = view.outlook(snapshot, { ...state, now: EXAMPLE_NOW }).split('<details id="tomorrow-details"')[0];
  assert.match(entry, /data-snow-quality="rain"/);
  assert.match(entry, />Rain<\/strong>/);
  assert.match(entry, /Forecast precipitation/);
  assert.doesNotMatch(entry, /Estimated morning condition|Based on NWS snow level/);
});

test('daily table and timeline filters apply independently of the all-model resort card', () => {
  const snapshot = overnightFixture({ totals: [12, 0, 0, 0, 0] });
  const start = EXAMPLE_NOW + H;
  const options = { ...state, now: EXAMPLE_NOW, start, end: start + 12 * H, ids: snapshot.models.map(model => model.id) };
  assert.match(view.daily(snapshot, options), /Blended snowfall 5 in/);
  assert.match(view.snowTimeline(snapshot, options), /data-period-snow="4.8"/);
  const filtered = { ...options, ids: ['ecmwf_ifs025', 'gfs_global'] };
  assert.match(view.daily(snapshot, filtered), /Blended snowfall 10 in/);
  assert.match(view.snowTimeline(snapshot, filtered), /data-period-snow="9.6"/);
  const today = view.summary(snapshot, { ...filtered, page: 'stevens' });
  assert.match(today, /Still expected to fall[\s\S]*?0–12/);
  assert.match(today, /5 in · 5-model blend/);
  assert.match(today, /5-model blend/);
  assert.match(today, /ECMWF and HRRR split 80% equally \(40% each\)/);
});
