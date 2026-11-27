import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import chinese from '../public/clone/zh-CN.mjs';
import { chooseLanguage, displayUnits, setDisplayLanguage, setDisplayUnits, t } from '../src/i18n.mjs';
import { formatDate, formatTime, isPacificWeekend } from '../src/time.mjs';
import { buildResortComparison } from '../src/resort-comparison.mjs';
import { MORNING_RESORTS, RESORTS } from '../src/config.mjs';
import { COMPARISON_NOW, resortComparisonFixture } from './fixtures/resort-comparison.mjs';
import { overnightFixture } from './fixtures/overnight.mjs';

async function browserView(name) {
  const file = new URL('../public/clone/' + name + '.mjs', import.meta.url);
  const source = (await readFile(file, 'utf8')).replaceAll(/from '\/lib\/([^']+)'/g,
    (_, module) => "from '" + new URL('../src/' + module, import.meta.url).href + "'");
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const view = await browserView('live-view');
const { renderComparison } = await browserView('resort-comparison-view');

test('unit preferences convert forecast amounts without changing the forecast or snow rating', ctx => {
  ctx.after(() => setDisplayUnits({}));
  const entries = resortComparisonFixture();
  const board = () => buildResortComparison(entries, COMPARISON_NOW, { days: 5 });
  const facts = value => value.rows.map(({ night, fraction }) => [night.estimate.blendedIn, night.quality.key, fraction]);
  const original = board();
  assert.match(renderComparison(original), /data-snowfall-value="5"/);
  assert.match(renderComparison(original), /Full bar at 10 in/);
  setDisplayUnits({ depth: 'cm' });
  assert.equal(displayUnits.temperature, 'F');
  const metric = board();
  assert.deepEqual(facts(metric), facts(original));
  assert.match(renderComparison(metric), /data-snowfall-value="13"/);
  assert.match(renderComparison(metric), />cm<\/span>/);
  assert.match(renderComparison(metric), /12\.7 centimeters/);
  assert.match(renderComparison(metric), /Full bar at 25\.4 cm/);
});

test('Chinese station readings use the selected units and preserve zero and unavailable readings', ctx => {
  ctx.after(() => { setDisplayLanguage('en'); setDisplayUnits({}); });
  setDisplayLanguage('zh-CN', chinese);
  setDisplayUnits({ depth: 'cm', temperature: 'C' });
  const resort = RESORTS[0], observedAt = COMPARISON_NOW;
  const reading = value => ({ value, observedAt, state: 'fresh' });
  const station = { ...MORNING_RESORTS[resort.id].station, snowfall24h: reading(0), depth: reading(4), temperature: reading(14) };
  const render = () => view.morningConditions({ resort, sources: [], morning: { station } });
  assert.match(render(), /<strong>0<span> 厘米<\/span>/);
  assert.match(render(), /<strong>10\.2<span> 厘米<\/span>/);
  assert.match(render(), /<strong>-10<span> °C<\/span>/);
  station.temperature = null;
  assert.match(render(), /气温<\/span><strong>暂无数据<\/strong>/);
});

test('Chinese resort Today gives the report and remaining forecast separate labels and windows', ctx => {
  ctx.after(() => { setDisplayLanguage('en'); setDisplayUnits({}); });
  setDisplayLanguage('zh-CN', chinese);
  setDisplayUnits({ depth: 'cm' });
  const now = Date.parse('2026-10-16T13:00Z');
  const data = overnightFixture({ now, totals: [0, 0, 0, 0, 0] });
  data.morning = { station: { ...MORNING_RESORTS.stevenspass.station, snowfall24h: { value: 4, observedAt: now, state: 'fresh' } } };
  const html = view.summary(data, { now, page: 'stevens' });
  assert.match(html, /预计还将降雪[\s\S]*?厘米[\s\S]*?0?6:00–0?8:00/);
  assert.match(html, /已累计降雪[\s\S]*?10\.16[\s\S]*?厘米[\s\S]*?24 小时报告/);
  assert.match(view.morningConditions(data), /过去24小时降雪量<\/span>\s*<strong>10\.16<span> 厘米<\/span>/);
  assert.match(html.split('<details id="tomorrow-details"')[1], /雪场开放前降雪预报[\s\S]*?0?8:00/);
});

test('explicit and saved language choices take precedence over browser preferences', () => {
  assert.equal(chooseLanguage('en', 'zh-CN', ['zh']), 'en');
  assert.equal(chooseLanguage(null, 'zh', ['en-US']), 'zh-CN');
  assert.equal(chooseLanguage('invalid', null, ['fr-CA', 'zh-SG', 'en']), 'zh-CN');
  assert.equal(chooseLanguage(null, null, ['en-US', 'zh-CN']), 'en');
  assert.equal(chooseLanguage(null, null, ['fr']), 'en');
});

test('switching languages preserves forecasts, comparison links and Pacific dates', ctx => {
  ctx.after(() => setDisplayLanguage('en'));
  const options = { days: 5, nightChoice: '2026-10-21' };
  const entries = resortComparisonFixture();
  const board = () => buildResortComparison(entries, COMPARISON_NOW, options);
  const facts = b => b.rows.map(({ night, href }) => [night.estimate.blendedIn, night.snow.count, night.quality.key, href]);
  const expected = facts(board());
  const boundary = Date.parse('2026-11-01T06:30Z'); // Still Saturday in Washington.
  setDisplayLanguage('zh-CN', chinese);
  assert.deepEqual(facts(board()), expected);
  assert.match(renderComparison(board()), /雪场对比/);
  assert.match(formatDate(boundary), /10月31日/);
  assert.equal(isPacificWeekend(boundary), true);
  assert.equal(formatTime(boundary), '23:30');
  assert.equal(t('Model range: {0}', '$&'), '模型预测范围：$&');
  setDisplayLanguage('en');
  assert.match(renderComparison(board()), /Compare resorts/);
  assert.match(formatDate(boundary), /Sat, Oct 31/);
});

test('Chinese 15-day outlook preserves zero, missing coverage and the weighted blend explanation', ctx => {
  ctx.after(() => setDisplayLanguage('en'));
  setDisplayLanguage('zh-CN', chinese);
  const hour = 3_600_000;
  const now = Date.parse('2026-11-03T20:30Z');
  const start = Math.ceil(now / hour) * hour;
  const data = { resort: RESORTS[0], sources: [{ id: 'forecast', status: 'cached', fetchedAt: now }], snowLevels: [],
    models: [{ id: 'ecmwf_ifs025', points: Array.from({ length: 160 }, (_, i) => ({ time: start + i * hour, snowIn: 0 })) }] };
  const html = view.extendedOutlook(data, { now });
  assert.match(html, /15 天降雪预报/);
  assert.match(html, /第 1 至 5 天<\/span>\s*<strong>0<small> 英寸/);
  assert.match(html, /第 11 至 15 天<\/span>\s*<strong>暂无数据/);
  assert.match(html, /前 48 个预报小时内，ECMWF 和 HRRR 平分 80%/);
  assert.doesNotMatch(html, /No models|Unavailable|undefined/);
});

test('Chinese conditions distinguish observed, stale and absent readings and retain the original advisory', ctx => {
  ctx.after(() => setDisplayLanguage('en'));
  setDisplayLanguage('zh-CN', chinese);
  const resort = RESORTS[1], observedAt = COMPARISON_NOW;
  const data = { resort, sources: [], morning: { station: { ...MORNING_RESORTS[resort.id].station,
    snowfall24h: { value: 0, observedAt, state: 'fresh' }, depth: { value: 5, observedAt, state: 'stale' } },
    road: { condition: 'Chains advised <test>', directions: [{ direction: 'Eastbound', message: 'Official advisory' }] } } };
  const html = view.morningConditions(data);
  for (const text of ['山区天气与路况', '过去24小时降雪量', '实测', '观测数据已过期', '暂无近期读数', '东行']) assert.ok(html.includes(text));
  assert.match(html, /lang="en">Chains advised &lt;test&gt;/);
});

test('Chinese messages retain every interpolated value', () => {
  const slots = message => [...message.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort();
  for (const [key, message] of Object.entries(chinese)) assert.deepEqual(slots(message), slots(key), key);
});
