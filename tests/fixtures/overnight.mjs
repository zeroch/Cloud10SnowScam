import { MODELS, RESORT } from '../../src/config.mjs';
export const EXAMPLE_NOW = Date.parse('2026-10-16T00:00:00Z'); // Thu Oct 15, 5 pm Pacific
export const NIGHT_START = EXAMPLE_NOW + 3_600_000;
const H = 3_600_000;
const bins = [[.2,.8,2.2,2], [0,.3,1.5,1.8], [0,0,.8,1.3], [.6,1.8,2.9,2.5], [.1,.4,1.8,2.4]];

// Test-only forecasts. Never collected or served by the production runtime.
export function overnightFixture({ now = EXAMPLE_NOW, totals = null } = {}) {
  return {
    generatedAt: now, resort: RESORT, observationsEnabled: false, forecastTransport: 'server', stations: [],
    sources: [
      { id: 'forecast', name: 'Open-Meteo', url: 'https://open-meteo.com/en/docs', status: 'cached', fetchedAt: now, refreshAfterMs: H / 2 },
      { id: 'nws', name: 'NWS', url: 'https://www.weather.gov/sew/', status: 'cached', fetchedAt: now, issuedAt: now - H, refreshAfterMs: H },
      ...['brooks','schmidt','upper'].map(id => ({ id, name: 'NWAC', url: 'https://nwac.us/', status: 'disabled', fetchedAt: null })),
    ],
    models: MODELS.map((m, index) => ({ ...m, points: Array.from({ length: 145 }, (_, i) => {
      const time = EXAMPLE_NOW + i * H, nightHour = (time - NIGHT_START) / H;
      let snowIn = 0;
      if (nightHour > 0 && nightHour <= 12) snowIn = totals ? totals[index] / 12 : bins[index][Math.floor((nightHour - 1) / 3)] / 3;
      else if (!totals && i > 13 && i <= 24) snowIn = ([6,4,3,9,5][index] - [5.2,3.6,2.1,7.8,4.7][index]) / 11;
      else if (!totals && i > 24 && i <= 72) snowIn = ([12,8,6,16,10][index] - [6,4,3,9,5][index]) / 48;
      else if (!totals && i > 72 && i <= 120) snowIn = ([18,12,8,24,15][index] - [12,8,6,16,10][index]) / 48;
      if (index === 4 && i > 48) snowIn = null;
      return { time, snowIn, precipIn: snowIn == null ? null : snowIn / 7, temperatureF: 28, cloudPct: 80, windMph: 8, gustMph: 15 };
    }) })),
    snowLevels: Array.from({ length: 48 }, (_, i) => ({ start: NIGHT_START + i * 3 * H, end: NIGHT_START + (i + 1) * 3 * H, feet: [4200,3600,2800,2400][Math.min(i, 3)] })),
  };
}
