import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RESORTS } from '../src/config.mjs';
import { HOUR } from '../src/time.mjs';
import { resortComparisonFixture, resortComparisonUncertainFixture, COMPARISON_NOW as NOW } from './fixtures/resort-comparison.mjs';

const comparison = await import('../src/resort-comparison.mjs').catch(() => ({}));
const board = (entries = resortComparisonFixture(), options = {}, now = NOW) => {
  assert.equal(typeof comparison.buildResortComparison, 'function');
  return comparison.buildResortComparison(entries, now, options);
};
const viewSource = await readFile(new URL('../public/clone/resort-comparison-view.mjs', import.meta.url), 'utf8');
const resolvedView = viewSource.replaceAll(/from '\/lib\/([^']+)'/g, (_, f) => `from '${new URL('../src/' + f, import.meta.url).href}'`);
const { renderComparison } = await import('data:text/javascript;base64,' + Buffer.from(resolvedView).toString('base64'));
const renderedRows = result => [...renderComparison(result).matchAll(/<a class="resort-row"[\s\S]*?<\/a>/g)].map(match => match[0]);

// Catches mixed resort identities, independent bar scales, rounded quality
// thresholds, or agreement calculated from a model count instead of spread.
test('four resorts share a date and bar scale while retaining their own forecasts and elevation bands', () => {
  const result = board();
  assert.deepEqual(result.rows.map(r => r.resort.id), ['stevenspass','crystalmountain','summitcentral','mtbaker']);
  assert.deepEqual(result.rows.map(r => r.night.estimate.value), ['5','8','2','3']);
  assert.deepEqual(result.rows.map(r => r.night.agreement.key), ['high','low','high','moderate']);
  assert.deepEqual(result.rows.map(r => r.night.quality.key), ['good','excellent','wet','good']);
  assert.deepEqual(result.rows.map(r => r.night.snow.count), [5,5,5,4]);
  const amounts = [5, 7.4, 2, .8 * 2 + .2 * 14 / 3];
  result.rows.forEach((row, i) => assert.ok(Math.abs(row.fraction - amounts[i] / 7.4) < 1e-10));
  assert.equal(result.selected.nightDate, '2026-10-18');
  assert.ok(result.rows.every(r => {
    const url = new URL(r.href, 'https://example.test');
    return url.pathname === `/location/${r.resort.id}/snow-summary` && url.searchParams.get('night') === '2026-10-18' && url.hash === '#live-overnight';
  }));
});

test('3-day and Outlook choices compare one morning, not cumulative snow or blended quality', () => {
  const result = board(undefined, { days: 3, nightChoice: '2026-10-19' });
  assert.equal(result.nights.length, 3);
  assert.deepEqual(result.rows.map(r => r.night.estimate.value), ['1','2','3','4']);
  assert.equal(result.selected.nightDate, '2026-10-19');
  assert.equal(new URL(result.rows[2].href, 'https://example.test').searchParams.get('night'), '2026-10-19');
  assert.equal(board(undefined, { days: 5 }).nights.length, 5);
  assert.equal(board(undefined, { days: 3, nightChoice: '1900-01-01' }).selected.nightDate, '2026-10-18');
});

test('missing, stale, and mismatched forecasts never look like current zero snow or favorable quality', () => {
  const entries = resortComparisonFixture();
  entries.crystalmountain.data.sources[0].fetchedAt = NOW - HOUR;
  entries.summitcentral = { failed: true, loading: false };
  entries.mtbaker.data.resort = RESORTS[0];
  const rows = board(entries).rows;
  assert.equal(rows[0].night.estimate.value, '5');
  assert.equal(rows[1].night.estimate.value, '8');
  assert.equal(rows[1].night.agreement.label, 'Outdated');
  assert.equal(rows[1].night.quality.key, null);
  assert.equal(rows[2].night.estimate.median, null);
  assert.equal(rows[3].night.estimate.median, null);
  assert.ok(rows.slice(2).every(r => r.fraction === 0 && r.night.quality.key === null));
  assert.ok(board(entries, {}, NOW + HOUR).rows.every(r => r.night.quality.key === null));
});

test('overnight comparison labels remaining hours and rolls all resorts forward at 6 am', () => {
  const remaining = board(resortComparisonFixture(NOW + 9.5 * HOUR), {}, NOW + 9.5 * HOUR);
  assert.equal(remaining.selected.phase, 'remaining');
  assert.equal(remaining.selected.start, Date.parse('2026-10-19T10:00Z'));
  const morning = board(resortComparisonFixture(NOW + 13 * HOUR), {}, NOW + 13 * HOUR);
  assert.equal(morning.selected.nightDate, '2026-10-19');
  assert.ok(morning.rows.every(r => r.night.phase === 'upcoming'));
});

// Real dashboard clients exercise the fetch boundary. A failed resort must not
// erase its neighbors or overwrite a previously successful response.
test('comparison reads each cached resort independently and retains data on a partial refresh failure', async () => {
  assert.equal(typeof comparison.createResortComparisonClient, 'function');
  const entries = resortComparisonFixture(), urls = [], updates = [];
  let failing = true, releaseSlowResort, ready;
  const slowResort = new Promise(resolve => { releaseSlowResort = resolve; });
  const availableFirst = new Promise(resolve => { ready = resolve; });
  const client = comparison.createResortComparisonClient({ now: () => NOW, onUpdate: e => {
    updates.push(e);
    if (e.stevenspass.data && e.summitcentral.loading) ready();
  }, fetchFn: async path => {
    urls.push(path);
    const id = path.startsWith('/api/dashboard') ? 'stevenspass' : /resorts\/([^/]+)\//.exec(path)[1];
    if (failing && id === 'summitcentral') { await slowResort; throw Error('Temporarily offline'); }
    return Response.json(entries[id].data);
  } });
  const pending = client();
  await availableFirst;
  assert.equal(updates.at(-1).summitcentral.loading, true);
  releaseSlowResort();
  const first = await pending;
  assert.equal(first.summitcentral.failed, true);
  assert.equal(first.mtbaker.data.resort.id, 'mtbaker');
  assert.equal(updates.some(e => e.stevenspass.data && e.summitcentral.loading), true, 'available resorts render before every request completes');
  assert.equal(urls.length, 4);
  assert.ok(urls.every(u => u.startsWith('/api/')));
  failing = false; await client();
  failing = true;
  const final = await client(true);
  assert.equal(final.summitcentral.failed, true);
  assert.equal(final.summitcentral.data.resort.id, 'summitcentral');
});

test('comparison markup exposes amounts, quality and agreement together with working resort/date links', () => {
  const result = board();
  const html = renderComparison(result);
  const rows = renderedRows(result);
  const headings = html.match(/class="compare-columns"[^>]*>(.*?)<\/div>/s)[1];
  assert.deepEqual([...headings.matchAll(/<span>(.*?)<\/span>/g)].map(match => match[1]),
    ['Mountain', 'Snowfall', 'Model agreement']);
  for (const [index, status, count] of [[0,'Agree',5],[1,'Split',5],[3,'Mixed',4]]) {
    assert.match(rows[index], new RegExp(`<strong>${status}</strong>[\\s\\S]*?${count} models`));
    assert.match(rows[index], /Model agreement:/);
  }
  assert.match(html, /Normal · Good/);
  assert.match(html, /Dry · Excellent/);
  assert.doesNotMatch(html, /Sample data|≈|NaN|undefined/);
  for (const row of result.rows) assert.ok(html.includes(`href="${row.href.replaceAll('&', '&amp;')}"`));
  const stale = resortComparisonFixture(); stale.crystalmountain.data.sources[0].status = 'stale';
  const rendered = renderComparison(board(stale));
  assert.match(rendered, /Saved forecast/);
  assert.match(rendered, /Outdated/);
  assert.doesNotMatch(rendered, /Dry · Excellent/);
});

test('zero medians with snowy outliers show uncertainty without a wet or favorable quality color', () => {
  const result = board(resortComparisonUncertainFixture());
  const rows = renderedRows(result);
  assert.equal(result.rows[0].night.condition.transition, 'Wet early');
  for (const [index, display] of [[0, '1'], [2, '2']]) {
    assert.equal(result.rows[index].night.estimate.median, 0);
    assert.ok(rows[index].includes(`data-snowfall-value="${display}"`));
    assert.match(rows[index], /data-snow-quality="unknown"/);
    assert.match(rows[index], /Snow uncertain/);
    assert.doesNotMatch(rows[index], /Normal · Poor|>Wet<|Wet early/);
  }
});

test('little or no new snow is described as an amount rather than a poor surface-quality rating', () => {
  const rows = renderedRows(board(resortComparisonUncertainFixture()));
  assert.match(rows[1], /data-snow-quality="poor"/);
  assert.match(rows[1], /Light snow/);
  assert.doesNotMatch(rows[1], /Dry · Poor/);
  assert.match(rows[3], /No new snow/);
  assert.doesNotMatch(rows[3], /Snow uncertain|Quality unavailable/);
});

test('rain and positive wet snow stay distinct from zero-snow uncertainty', () => {
  const entries = resortComparisonFixture();
  entries.stevenspass.data.models.forEach(model => model.points.forEach(point => {
    point.snowIn = 0; point.precipIn = .02; point.temperatureF = 38;
  }));
  const rows = renderedRows(board(entries));
  assert.match(rows[0], /data-snow-quality="rain"/);
  assert.match(rows[2], /data-snow-quality="wet"/);
  for (const [index, amount, quality] of [[0, '0', 'Rain'], [2, '2', 'Wet']]) {
    const figure = rows[index].match(/class="resort-figure"[^>]*>(.*?)<\/div>/s)[1];
    assert.ok(figure.includes(`data-snowfall-value="${amount}"`));
    assert.ok(figure.includes(`>${quality}<`), `The snowfall amount should include the ${quality} label`);
  }
  assert.doesNotMatch(rows[0] + rows[2], /Snow uncertain|Light snow/);
});

test('stale and incomplete model evidence cannot gain a current quality or agreement label', () => {
  const entries = resortComparisonUncertainFixture();
  entries.stevenspass.data.sources[0].status = 'stale';
  entries.crystalmountain.data.models = entries.crystalmountain.data.models.slice(0, 1);
  entries.summitcentral = { loading: true };
  const rows = renderedRows(board(entries));
  assert.match(rows[0], /Quality outdated/);
  assert.doesNotMatch(rows[0], /Snow uncertain|>Split</);
  assert.match(rows[1], /<strong>Limited<\/strong>[\s\S]*?1 model/);
  assert.match(rows[1], /Quality unavailable/);
  assert.doesNotMatch(rows[1], />Agree<|Light snow/);
  assert.match(rows[2], /Loading models/);
  assert.match(rows[2], /Loading quality/);
});

test('comparison labels the blended snowfall and shows the complete-model spread when agreement is limited', () => {
  const html = renderComparison(board());
  const rows = renderedRows(board());
  assert.match(html, /Blended snowfall · estimated quality/);
  assert.match(rows[1], /aria-label="About 8 inches, blended snowfall"/);
  assert.match(rows[1], /Model range: 1–14 in/);
  const entries = resortComparisonFixture();
  entries.crystalmountain.data.models = entries.crystalmountain.data.models.slice(0, 2);
  const limited = renderedRows(board(entries))[1];
  assert.match(limited, /<strong>Limited<\/strong>/);
  assert.match(limited, /Model range: 1–2 in/);
});

test('freshness is visible and stale model ranges are not presented as current', () => {
  const entries = resortComparisonFixture();
  entries.crystalmountain.data.sources[0].fetchedAt = NOW - HOUR;
  const html = renderComparison(board(entries));
  const stale = renderedRows(board(entries))[1];
  assert.match(html, /Oldest forecast collected/);
  assert.match(stale, /Saved forecast · update overdue/);
  assert.doesNotMatch(stale, /Model range:|Dry · Excellent/);
  assert.match(html, /Check saved forecasts/);
});
