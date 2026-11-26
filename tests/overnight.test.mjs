import test from 'node:test';
import assert from 'node:assert/strict';
import * as forecast from '../src/forecast.mjs';
import { overnightFixture, EXAMPLE_NOW, NIGHT_START } from './fixtures/overnight.mjs';
const H = 3_600_000;
function decision(data = overnightFixture(), now = EXAMPLE_NOW, choice = 'auto') {
  assert.equal(typeof forecast.overnightDecision, 'function', 'shared overnight decision exists');
  return forecast.overnightDecision(data, now, choice);
}

test('the overnight answer uses complete same-night model totals and explains disagreement', () => {
  const d = decision();
  assert.equal(d.phase, 'upcoming'); assert.equal(d.start, NIGHT_START); assert.equal(d.end, NIGHT_START + 12 * H);
  assert.deepEqual([d.snow.min, d.snow.max, d.snow.count, d.expectedModels], [2.1, 7.8, 5, 5]);
  assert.equal(d.amountState, 'split'); assert.match(d.headline, /Models split/);
  assert.equal(d.amount, '3–8 in');
  assert.match(d.timing, /after midnight/);
  assert.equal(d.level.value, '4,200 → 2,400 ft'); assert.match(d.level.note, /early/);
});

test('exact zero, traces, and threshold boundaries have distinct interpretations', () => {
  for (const [total, state, display] of [[0,'zero','0 in'], [.004,'below','1 in'], [3.999,'below','4 in'], [4,'lower','4 in'], [4.999,'lower','5 in'], [5,'upper','5 in']]) {
    const d = decision(overnightFixture({ totals: Array(5).fill(total) }));
    assert.equal(d.amountState, state, String(total)); assert.equal(d.amount, display);
  }
});

test('small positive totals and values just below a target survive accumulation precision', () => {
  for (const [total, state, display] of [[.0004,'below','1 in'], [3.9996,'below','4 in'], [4.9996,'lower','5 in']]) {
    const data = overnightFixture({ totals: Array(5).fill(total) }), d = decision(data);
    assert.equal(d.snow.min, total);
    assert.equal(d.amountState, state); assert.equal(d.amount, display);
    const endpoint = forecast.comparisonSeries(data, [data.models[0].id], 'snow', d.start, d.end).lines[0].values.at(-1);
    assert.equal(endpoint, d.snow.min, 'chart and summary preserve the same quantity');
  }
});

test('identical light accumulation does not imply model timing disagreement', () => {
  const d = decision(overnightFixture({ totals: Array(5).fill(.12) }));
  assert.doesNotMatch(d.timing, /differs/);
  assert.match(d.timing, /Light accumulation/);
});

test('missing and invalid hours never become a full zero total', () => {
  const data = overnightFixture({ totals: [0,0,0,0,0] });
  data.models[0].points[5].snowIn = null;
  data.models[1].points[5].snowIn = -1;
  data.models[2].points[5].snowIn = NaN;
  data.models.pop();
  const d = decision(data);
  assert.equal(d.snow.count, 1); assert.equal(d.coverage, 'single'); assert.equal(d.expectedModels, 5);
  assert.match(d.headline, /Only GDPS/); assert.equal(d.rows[0].total, null);
  assert.equal(d.rows.find(r => r.id === 'gfs_hrrr').covered, 0);
  data.models[3].points[5].snowIn = null;
  const none = decision(data); assert.equal(none.coverage, 'none'); assert.equal(none.amount, 'Unavailable');
});

test('a limited dry range is explicitly qualified and keeps its missing model', () => {
  const data = overnightFixture({ totals: [0,0,0,0,0] }); data.models.pop();
  const d = decision(data);
  assert.equal(d.coverage, 'limited'); assert.match(d.headline, /Available models show zero/);
  assert.equal(d.rows.length, 5); assert.match(d.coverageText, /4 of 5/);
});

test('short-range coverage is evaluated for tonight independently of five-day coverage', () => {
  const data = overnightFixture(), d = decision(data);
  assert.equal(d.rows.find(r => r.id === 'gfs_hrrr').complete, true);
  assert.equal(forecast.forecastRange(data.models, EXAMPLE_NOW, EXAMPLE_NOW + 120 * H).count, 4);
});

test('stale collection retains a labeled amount without a current target verdict', () => {
  const data = overnightFixture({ totals: [6,7,8,9,10] }); data.sources[0].fetchedAt -= H;
  const d = decision(data);
  assert.equal(d.forecastState, 'stale'); assert.equal(d.amount, '6–10 in');
  assert.match(d.headline, /Saved forecast/); assert.doesNotMatch(d.headline, /reach|target/);
  assert.equal(d.rows[0].target, 'Saved');
  data.sources[0].fetchedAt = EXAMPLE_NOW; data.sources[0].status = 'stale';
  assert.equal(decision(data).forecastState, 'stale');
});

test('NWS status remains independent of usable snowfall and retains partial coverage', () => {
  const data = overnightFixture(); data.sources[1].status = 'unavailable'; data.snowLevels = [];
  const d = decision(data); assert.equal(d.amount, '3–8 in'); assert.equal(d.level.state, 'unavailable');
  const partial = overnightFixture(); partial.snowLevels = partial.snowLevels.slice(1, 4);
  assert.equal(decision(partial).level.state, 'partial'); assert.match(decision(partial).level.value, /Partial/);
  const oscillating = overnightFixture(); oscillating.snowLevels[2].feet = 4800;
  assert.equal(decision(oscillating).level.value, '2,400–4,800 ft');
});

test('stale NWS intervals retain their partial coverage warning', () => {
  const data = overnightFixture(); data.snowLevels.splice(1, 1); data.sources[1].status = 'stale';
  const d = decision(data);
  assert.equal(d.level.state, 'stale'); assert.equal(d.level.coverage, 'partial');
  assert.equal(d.level.value, 'Partial coverage');
  assert.match(d.level.note, /available hours/); assert.match(d.level.note, /update overdue/);
  assert.equal(d.amount, '3–8 in');
});

test('snow-level wording stays consistent when a value rounds to 4,000 feet', () => {
  const data = overnightFixture(); data.snowLevels.forEach(p => { p.feet = 3999; });
  const d = decision(data); assert.equal(d.level.value, '4,000 ft');
  assert.match(d.level.note, /Near your 4,000 ft caution level/);
});

test('source failure with no forecast has no invented zero or target claim', () => {
  const data = overnightFixture(); data.models = []; data.sources[0].status = 'unavailable'; data.sources[0].fetchedAt = null;
  const d = decision(data);
  assert.equal(d.amount, 'Unavailable'); assert.match(d.headline, /Forecast unavailable/); assert.equal(d.forecastState, 'unavailable');
});

test('remaining snowfall is never compared with the full-night target', () => {
  const now = Date.parse('2026-10-16T11:30Z'), d = decision(overnightFixture({ now }), now);
  assert.equal(d.phase, 'remaining'); assert.equal(d.start, Date.parse('2026-10-16T12:00Z'));
  assert.equal(d.end, Date.parse('2026-10-16T13:00Z')); assert.equal(d.amountState, null);
  assert.match(d.headline, /Remaining/); assert.equal(d.rows[0].target, '1/1 hr');
});

test('the final partial hour is not zero snowfall or a source outage', () => {
  const atFive = Date.parse('2026-10-16T12:00Z');
  assert.equal(decision(overnightFixture({ now: atFive }), atFive).phase, 'remaining');
  const now = atFive + H/2, d = decision(overnightFixture({ now }), now);
  assert.equal(d.phase, 'ending'); assert.equal(d.amount, 'Unavailable');
  assert.match(d.headline, /Final hour/); assert.equal(d.forecastState, 'current');
});

test('6 am retains the just-ended night, while tonight is an explicit choice', () => {
  const now = Date.parse('2026-10-16T13:00Z'), data = overnightFixture({ now });
  const d = decision(data, now);
  assert.equal(d.phase, 'morning'); assert.equal(d.nightStart, NIGHT_START); assert.equal(d.end, now);
  assert.equal(d.amount, 'Unconfirmed'); assert.match(d.headline, /Last night/); assert.equal(d.amountState, null);
  const next = decision(data, now, 'tonight');
  assert.equal(next.phase, 'upcoming'); assert.equal(next.start, Date.parse('2026-10-17T01:00Z'));
  assert.equal(next.end, Date.parse('2026-10-17T13:00Z'));
});

test('noon returns to the coming night and DST nights retain actual elapsed hours', () => {
  const noon = Date.parse('2026-10-16T19:00Z');
  assert.equal(decision(overnightFixture({ now: noon }), noon).phase, 'upcoming');
  for (const [date, hours] of [['2026-03-08T01:00Z',11], ['2026-11-01T00:00Z',13]]) {
    const now = Date.parse(date), d = decision(overnightFixture({ now }), now);
    assert.equal((d.end - d.start) / H, hours);
  }
});

test('target support counts distinguish distributions with the same range', () => {
  const one = decision(overnightFixture({ totals: [0,0,0,0,8] }));
  const four = decision(overnightFixture({ totals: [0,6,6,6,8] }));
  assert.deepEqual(one.support, { four: 1, five: 1, available: 5, expected: 5 });
  assert.deepEqual(four.support, { four: 4, five: 4, available: 5, expected: 5 });
  assert.equal(one.amount, four.amount);
});

test('support uses unrounded complete totals and explicitly excludes missing coverage', () => {
  const data = overnightFixture({ totals: [3.9996,4,4.9996,5,8] });
  data.models[4].points[5].snowIn = null;
  assert.deepEqual(decision(data).support, { four: 3, five: 1, available: 4, expected: 5 });
});

test('full-night target counts are withheld for stale, unavailable and elapsed-night scopes', () => {
  const stale = overnightFixture(); stale.sources[0].status = 'stale';
  assert.equal(decision(stale).support, null);
  const unavailable = overnightFixture(); unavailable.models = [];
  assert.equal(decision(unavailable).support, null);
  for (const date of ['2026-10-16T11:30Z','2026-10-16T12:30Z','2026-10-16T13:00Z']) {
    const now = Date.parse(date);
    assert.equal(decision(overnightFixture({ now }), now).support, null);
  }
});

test('the main uncertainty differentiates one optimistic model from one low outlier', () => {
  const sample = totals => { const d = overnightFixture({ totals }); d.snowLevels.forEach(p => { p.feet = 2000; }); return decision(d); };
  assert.match(sample([0,0,0,0,8]).uncertainty.text, /Only 1 of 5.*4 inches/);
  assert.match(sample([0,6,6,6,8]).uncertainty.text, /4 of 5.*4 inches.*one model/i);
  assert.equal(sample([5.01,5.02,5.03,5.04,5.05]).uncertainty.kind, 'threshold');
  assert.notEqual(sample([7,8,9,10,11]).uncertainty.kind, 'threshold');
});

test('snow-level caution requires temporal overlap with forecast precipitation', () => {
  const wet = overnightFixture({ totals: [6,6,6,6,6] });
  assert.equal(decision(wet).uncertainty.kind, 'snow-level');
  assert.match(decision(wet).uncertainty.text, /precipitation.*4,000 ft/);
  const dryEarly = overnightFixture({ totals: [6,6,6,6,6] });
  for (const model of dryEarly.models) for (const point of model.points) {
    if (point.time <= NIGHT_START + 3 * H) { point.precipIn = 0; point.snowIn = 0; }
    else if (point.time <= NIGHT_START + 12 * H) { point.precipIn = .1; point.snowIn = 1; }
  }
  assert.notEqual(decision(dryEarly).uncertainty.kind, 'snow-level');
});

test('data gaps take precedence over interpreting agreement or snow-level risk', () => {
  const data = overnightFixture(); data.models.pop();
  assert.equal(decision(data).uncertainty.kind, 'coverage');
  assert.match(decision(data).uncertainty.text, /4 of 5/);
  const nws = overnightFixture(); nws.sources[1].status = 'stale';
  assert.equal(decision(nws).uncertainty.kind, 'snow-level-data');
  assert.match(decision(nws).uncertainty.text, /overdue/);
});

test('timing bins align per-model snowfall, liquid precipitation and independent NWS intervals', () => {
  const data = overnightFixture(), d = decision(data);
  assert.equal(d.bins.length, 4);
  assert.deepEqual(d.bins.map(b => [b.start,b.end]), [
    [NIGHT_START,NIGHT_START+3*H],[NIGHT_START+3*H,NIGHT_START+6*H],
    [NIGHT_START+6*H,NIGHT_START+9*H],[NIGHT_START+9*H,NIGHT_START+12*H],
  ]);
  assert.deepEqual(d.bins[0].snow.models.map(m => m.total), [.2,0,0,.6,.1]);
  assert.equal(d.bins[0].liquid.count, 5);
  assert.equal(d.bins[0].level.value, '4,200 ft');
  data.snowLevels.splice(1,1);
  assert.equal(decision(data).bins[1].level.state, 'unavailable');
});

test('dated timing links keep the requested night across the morning and noon transition', () => {
  assert.equal(decision().nightDate, '2026-10-15');
  for (const date of ['2026-10-16T13:00Z','2026-10-16T20:00Z']) {
    const now=Date.parse(date), d=decision(overnightFixture({now}),now,'2026-10-15');
    assert.equal(d.nightStart,NIGHT_START); assert.equal(d.phase,'morning');
    assert.equal(d.support,null); assert.equal(d.amount,'Unconfirmed');
  }
  const now=Date.parse('2026-10-16T13:00Z');
  const next=decision(overnightFixture({now}),now,'2026-10-16');
  assert.equal(next.nightDate,'2026-10-16'); assert.equal(next.phase,'upcoming');
  assert.equal(decision(undefined,EXAMPLE_NOW,'2026-02-30').nightDate,'2026-10-15');
});
