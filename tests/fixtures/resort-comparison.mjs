import { RESORTS, MODELS } from '../../src/config.mjs';
import { HOUR, nightWindow } from '../../src/time.mjs';

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
