import { overnightFixture } from './overnight.mjs';
import { HOUR, nightWindow } from '../../src/time.mjs';

export const HORIZON_NOW = Date.parse('2026-10-17T00:50:00Z'); // Fri, 5:50 pm Pacific
// The approved Option 4 example. HRRR intentionally stops after the first night.
export function horizonFixture(now = HORIZON_NOW) {
  const data = overnightFixture({ now });
  const totals = [[5.2,3.6,2.1,7.8,4.7], [.9,1,1.1,1], [6,7,7,8], [0,0,0,0], [1,2,4,5]];
  const levels = [[4200,3600,2800,2400], [1800], [2600], [3000], [4300]];
  data.models.forEach((model, index) => {
    model.points = totals.flatMap((values, day) => {
      const window = nightWindow(HORIZON_NOW, day), hours = (window.end - window.start) / HOUR;
      return Array.from({ length: hours }, (_, i) => ({
        time: window.start + (i + 1) * HOUR,
        snowIn: values[index] == null ? null : values[index] / hours,
        precipIn: values[index] == null ? null : values[index] / hours / 7,
        temperatureF: 28, windMph: 8, gustMph: 15, cloudPct: 80,
      }));
    });
  });
  data.snowLevels = levels.flatMap((values, day) => {
    const window = nightWindow(HORIZON_NOW, day), interval = (window.end - window.start) / values.length;
    return values.map((feet, i) => ({ start: window.start + i * interval, end: window.start + (i + 1) * interval, feet }));
  });
  return data;
}
