import { t } from './i18n.mjs';
import { HOUR, observedNight } from './time.mjs';
export const finite = value => typeof value === 'number' && Number.isFinite(value);
export const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
const minmax = values => values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;

export function summarizeModel(points, start, end) {
  const expectedHours = Math.max(0, (end - start) / HOUR);
  const unique = new Map(points.filter(p => finite(p.time) && p.time > start && p.time <= end).map(p => [p.time, p]));
  const rows = [...unique.values()].sort((a, b) => a.time - b.time);
  let coveredHours = 0, partialSnowIn = 0;
  for (let time = start + HOUR; time <= end; time += HOUR) {
    const point = unique.get(time);
    if (point && finite(point.snowIn) && point.snowIn >= 0) { coveredHours++; partialSnowIn += point.snowIn; }
  }
  const complete = expectedHours > 0 && coveredHours === expectedHours;
  const gusts = rows.map(p => p.gustMph).filter(finite);
  return { expectedHours, coveredHours, complete, snowIn: complete ? round(partialSnowIn, 2) : null, partialSnowIn: round(partialSnowIn, 2), temperatureRange: minmax(rows.map(p => p.temperatureF).filter(finite)), gustMph: gusts.length ? Math.max(...gusts) : null };
}

export function summarizeSnowLevel(intervals, start, end) {
  const valid = intervals.filter(p => finite(p.feet) && p.feet >= 0 && p.end > start && p.start < end).sort((a, b) => a.start - b.start);
  let cursor = start, coveredMs = 0;
  for (const p of valid) {
    const from = Math.max(cursor, start, p.start), to = Math.min(end, p.end);
    if (to > from) { coveredMs += to - from; cursor = to; }
  }
  const values = valid.map(p => p.feet);
  return { min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null, complete: end > start && coveredMs >= end - start, coveredHours: coveredMs / HOUR };
}

export function stationSummary(station, now) {
  const rows = (station.rows || []).filter(p => finite(p.time) && p.time <= now + 5 * 60_000).sort((a, b) => a.time - b.time);
  const latest = rows.at(-1);
  const quality = !latest ? 'unavailable' : station.sourceState === 'stale' || station.sourceState === 'unavailable' || now - latest.time > 3 * HOUR ? 'stale' : 'fresh';
  const window = observedNight(now);
  const board = { changeIn: null, status: 'unavailable', start: window.start, end: null, reason: t('No complete snow-board record for this overnight window.') };
  if (!station.hasSnowBoard) board.reason = t('This station does not measure snow accumulation.');
  else if (station.snowBlocked) board.reason = t('NWAC has a seasonal snow-sensor notice. Snow readings are excluded.');
  else if (quality !== 'fresh') board.reason = t('Current NWAC observations are unavailable or more than 3 hours old.');
  else {
    const nightRows = rows.filter(p => p.time >= window.start && p.time <= Math.min(now, window.end));
    const first = nightRows[0], last = nightRows.at(-1);
    if (first?.time === window.start && nightRows.length >= 2 && nightRows.every(p => finite(p.boardIn) && p.boardIn >= 0 && p.boardIn <= 60)) {
      let valid = true;
      for (let i = 1; i < nightRows.length; i++) {
        const delta = nightRows[i].boardIn - nightRows[i - 1].boardIn;
        if (nightRows[i].time - nightRows[i - 1].time > 1.5 * HOUR || delta < -0.5 || delta > 12) valid = false;
      }
      const requiredEnd = now >= window.end ? window.end : Math.floor(now / HOUR) * HOUR - HOUR;
      if (valid && last.time >= requiredEnd) {
        board.changeIn = round(Math.max(0, last.boardIn - first.boardIn)); board.status = 'valid'; board.end = last.time;
        board.complete = last.time === window.end;
        board.reason = t('Net board increase since 6 pm; settling and sensor resets can affect this measurement.');
      } else board.reason = t('A gap, reset, or implausible change prevents an overnight snow estimate.');
    }
  }
  return { id: station.id, name: station.name, elevationFt: station.elevationFt, url: station.url, at: latest?.time ?? null, quality, temperatureF: finite(latest?.temperatureF) ? latest.temperatureF : null, humidityPct: finite(latest?.humidityPct) ? latest.humidityPct : null, precipIn: finite(latest?.precipIn) ? latest.precipIn : null, gustMph: finite(latest?.gustMph) ? latest.gustMph : null, windMph: finite(latest?.windMph) ? latest.windMph : null, board, notices: station.notices || [], hasSnowBoard: !!station.hasSnowBoard };
}
