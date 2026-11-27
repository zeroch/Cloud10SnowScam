import { RESORTS } from './config.mjs';
import { horizonForecast } from './forecast.mjs';
import { ageSnapshot } from './display.mjs';
import { createDashboardClient } from './dashboard-client.mjs';

const FULL_BAR_INCHES = 10;
const empty = resort => ({ resort, models: [], sources: [], snowLevels: [], stations: [] });

// Use one clock and one Pacific morning for every resort. These are the same
// independent nightly summaries shown on the resort detail screen, not totals
// across the selected horizon or a new forecast/quality algorithm.
export function buildResortComparison(entries, now, { days = 1, nightChoice } = {}) {
  days = [1,3,5].includes(days) ? days : 1;
  const horizon = days === 1 ? 3 : days;
  const nights = horizonForecast(empty(RESORTS[0]), now, horizon).nights.slice(0, days);
  const index = Math.max(0, nights.findIndex(n => n.nightDate === nightChoice));
  const selected = nights[index];
  const detailSection = index === 0 ? 'live-overnight' : 'live-daily';
  const rows = RESORTS.map(resort => {
    const entry = entries[resort.id] || {};
    const snapshot = entry.data?.resort?.id === resort.id ? entry.data : null;
    const data = snapshot ? ageSnapshot(snapshot, now) : empty(resort);
    const night = horizonForecast(data, now, horizon).nights[index];
    const params = new URLSearchParams({ night: selected.nightDate, compareDays: String(days), compareNight: selected.nightDate });
    if (index > 0) params.set('days', String(days));
    const wholeInches = Math.ceil(night.estimate.blendedIn ?? 0);
    return { resort, night, loading: !!entry.loading, failed: !!entry.failed,
      fraction: Math.min(wholeInches / FULL_BAR_INCHES, 1),
      href: `/location/${resort.id}/snow-summary?${params}#${detailSection}` };
  });
  return { now, days, nights, selected, maximum: FULL_BAR_INCHES, rows };
}

// Dashboard GETs read the NAS cache. Individual completion keeps a slow/failed
// resort from hiding the other three; retained responses are aged at render.
export function createResortComparisonClient({ fetchFn, now = Date.now, onUpdate = () => {} } = {}) {
  const clients = RESORTS.map(resort => [resort.id, createDashboardClient({ resortId: resort.id, fetchFn, now })]);
  let entries = Object.fromEntries(RESORTS.map(r => [r.id, {}])), running;
  return function refresh(force = false) {
    if (running) return running;
    entries = Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, { ...entry, loading: true }]));
    onUpdate(entries);
    running = Promise.all(clients.map(async ([id, load]) => {
      try {
        const data = await load(force);
        if (!['models','sources','stations','snowLevels'].every(key => Array.isArray(data[key]))) throw new Error('Incomplete forecast');
        entries = { ...entries, [id]: { data, loading: false, failed: false } };
      } catch {
        entries = { ...entries, [id]: { ...entries[id], loading: false, failed: true } };
      }
      onUpdate(entries);
    })).then(() => entries).finally(() => { running = null; });
    return running;
  };
}
