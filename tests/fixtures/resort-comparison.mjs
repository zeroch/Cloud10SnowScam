import { RESORTS, MODELS, MORNING_RESORTS } from '../../src/config.mjs';
import { HOUR, nightWindow, localDayStart } from '../../src/time.mjs';

export const COMPARISON_NOW = Date.parse('2026-10-19T00:00:00Z');
// The approved mockup's fictional values. Only test/preview code imports this.
export function resortComparisonFixture(now = COMPARISON_NOW) {
  const totals = [[4.5,5,5,5,5.5], [1,2,8,11,14], [1.8,2,2,2,2.2], [2,3,5,6]];
  const levels = [3000,2000,3000,2200];
  return Object.fromEntries(RESORTS.map((resort, r) => [resort.id, {
    data: {
      resort, generatedAt: now, forecastTransport: 'server', observationsEnabled: false, stations: [],
      sources: [
        { id: 'forecast', status: 'cached', fetchedAt: now, refreshAfterMs: HOUR / 2 },
        { id: 'nws', status: 'cached', fetchedAt: now, issuedAt: now, refreshAfterMs: HOUR },
      ],
      models: MODELS.slice(0, totals[r].length).map((model, m) => ({ ...model, points: Array.from({ length: 5 }, (_, day) => {
        const window = nightWindow(COMPARISON_NOW, day), hours = (window.end - window.start) / HOUR;
        return Array.from({ length: hours }, (_, i) => ({ time: window.start + (i + 1) * HOUR,
          snowIn: (day ? r + day : totals[r][m]) / hours, precipIn: .02, temperatureF: 26,
          windMph: 8, gustMph: 15, cloudPct: 80 }));
      }).flat() })),
      snowLevels: Array.from({ length: 5 }, (_, day) => ({ ...nightWindow(COMPARISON_NOW, day), feet: levels[r] })),
    }, loading: false, failed: false,
  }]));
}

// Zero medians can still have snowy outliers. These should not look like a
// confident wet/normal snow forecast, or turn a light dusting into poor quality.
export function resortComparisonUncertainFixture(now = COMPARISON_NOW) {
  const entries = resortComparisonFixture(now);
  const totals = { stevenspass: [0,0,0,0,1.2], crystalmountain: [.25,.25,.25,.25,.25], summitcentral: [0,0,0,1.5,3], mtbaker: [0,0,0,0] };
  for (const [id, entry] of Object.entries(entries)) {
    entry.data.models.forEach((model, i) => model.points.forEach(point => {
      point.snowIn = totals[id][i] / 12;
      point.precipIn = 0;
    }));
  }
  const first = entries.stevenspass.data.snowLevels[0];
  entries.stevenspass.data.snowLevels.splice(0, 1,
    { ...first, end: first.start + 6 * HOUR, feet: 6000 },
    { ...first, start: first.start + 6 * HOUR });
  return entries;
}

export const TIMELINE_NOW = Date.parse('2026-11-28T02:45Z');

// Exact sample amounts and conditions from the approved comparison render.
export function resortTimelineFixture(now = TIMELINE_NOW, overrides = {}) {
  const amounts = [
    [0,2,3,10,0, 0,1,0,3,2, 0,0,1,0,1],
    [1,2,5,10,6, 0,0,2,4,2, 0,1,2,0,0],
    [0,0,1,4,2, 0,0,0,1,1, 0,0,0,0,0],
    [2,4,7,10,5, 2,1,2,4,3, 0,1,3,2,1],
  ];
  const conditions = [
    'rww-- -w--- -rw--', 'ww--- -rw-- -----', 'rrwww -rrww --r--', 'w---- ww--- -w---',
  ].map(sequence => sequence.replaceAll(' ', ''));
  const entries = resortComparisonFixture(now);
  RESORTS.forEach((resort, index) => {
    const data = entries[resort.id].data;
    const days = amounts[index].map((amount, day) => ({
      start: day === 0 ? Math.ceil(now / HOUR) * HOUR : localDayStart(now, day),
      end: localDayStart(now, day + 1), amount: overrides[resort.id]?.[day] ?? amount,
      condition: conditions[index][day],
    }));
    const points = days.flatMap(({ start, end, amount, condition }) => {
      const hours = (end - start) / HOUR;
      return Array.from({ length: hours }, (_, hour) => ({
        time: start + (hour + 1) * HOUR,
        snowIn: amount / hours,
        precipIn: amount || condition === 'r' ? .02 : 0,
        temperatureF: condition === 'r' ? 38 : 26,
      }));
    });
    data.models = MODELS.map(model => ({ ...model, points: points.map(point => ({ ...point })) }));
    data.snowLevels = days.map(({ start, end, condition }) => ({
      start, end, feet: condition === 'w' ? resort.snowLevelBands.wet + 100 : resort.snowLevelBands.dry - 100,
    }));
    data.sources.push({ id: 'nwac', status: 'cached', fetchedAt: now, refreshAfterMs: 6 * HOUR });
    data.morning = { station: { ...MORNING_RESORTS[resort.id].station,
      snowfall24h: index === 2 ? null : { value: [3,0,0,2][index], observedAt: now - (index === 3 ? 5.25 : .75) * HOUR },
    } };
  });
  return entries;
}
