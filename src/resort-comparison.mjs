import { MORNING_RESORTS, RESORTS } from './config.mjs';
import { fifteenDayForecast, horizonForecast, precipitationAtCaution, warmLiquidForecastCount } from './forecast.mjs';
import { ageSnapshot } from './display.mjs';
import { createDashboardClient } from './dashboard-client.mjs';

import { finite, summarizeSnowLevel } from './conditions.mjs';
import { comparisonStage } from './navigation.mjs';
import { isPacificWeekend } from './time.mjs';

const FULL_BAR_INCHES = 10;
const HEAVY_DAILY_INCHES = 7;
const empty = resort => ({ resort, models: [], sources: [], snowLevels: [], stations: [] });

function comparisonSnapshot(entry, resort, now) {
  return entry.data?.resort?.id === resort.id ? ageSnapshot(entry.data, now) : empty(resort);
}

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
    const data = comparisonSnapshot(entry, resort, now);
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

function dailyCategory(day, models, snowLevels, wetElevation, current) {
  const { blendedIn, start, end } = day;
  if (blendedIn > HEAVY_DAILY_INCHES) return 'heavy';
  if (!current || blendedIn === null) return 'neutral';
  if (blendedIn === 0) {
    if (day.max !== 0 || day.count < 3 || day.models.some(model => model.partialTotal > 0)) return 'neutral';
    const rainy = warmLiquidForecastCount(models, day.models, start, end);
    return rainy >= 3 && rainy > day.count / 2 ? 'rain' : 'neutral';
  }
  if (!summarizeSnowLevel(snowLevels, start, end).complete) return 'neutral';
  return precipitationAtCaution(models, snowLevels, start, end, wetElevation) ? 'wet' : 'good';
}

function subtotalCategory(days) {
  const totals = new Map();
  for (const day of days) {
    if (day.blendedIn > 0) totals.set(day.category, (totals.get(day.category) || 0) + day.blendedIn);
  }
  const highest = Math.max(0, ...totals.values());
  const leaders = [...totals].filter(([, amount]) => highest - amount < 1e-9);
  return leaders.length === 1 ? leaders[0][0] : 'neutral';
}

function stationObservation(data, resort) {
  const station = MORNING_RESORTS[resort.id].station;
  const report = data.morning?.station;
  const reading = report?.stid === station.stid ? report.snowfall24h : null;
  return { station, reading: finite(reading?.value) && reading.value >= 0 ? reading : null };
}

// Forecast windows and amounts come from the resort outlook's hourly blend.
// The categories are assigned per day before looking for the greatest depth
// contribution by color over each five-day block.
export function buildResortTimeline(entries, now, { stage = 1 } = {}) {
  stage = comparisonStage(stage);
  const rows = RESORTS.map(resort => {
    const entry = entries[resort.id] || {};
    const data = comparisonSnapshot(entry, resort, now);
    const source = data.sources.find(item => item.id === 'forecast');
    const current = ['fresh', 'cached'].includes(source?.status);
    const models = current || source?.status === 'stale' ? data.models : [];
    const nws = data.sources.find(item => item.id === 'nws');
    const snowLevels = ['fresh', 'cached'].includes(nws?.status) ? data.snowLevels : [];
    const forecast = fifteenDayForecast({ ...data, models }, now);
    const days = forecast.days.map(day => ({
      ...day, weekend: isPacificWeekend(day.calendarStart),
      category: dailyCategory(day, models, snowLevels, resort.snowLevelBands.wet, current),
      fraction: Math.min(Math.ceil(day.blendedIn ?? 0) / FULL_BAR_INCHES, 1),
    }));
    const blocks = forecast.blocks.map((block, index) => ({
      ...block, category: block.blendedIn === null ? 'neutral' : subtotalCategory(days.slice(5 * index, 5 * (index + 1))),
    }));
    const params = new URLSearchParams({ compareView: '15d', compareStage: String(stage) });
    return { resort, source, days, blocks, observation: stationObservation(data, resort),
      loading: !!entry.loading, failed: !!entry.failed,
      href: '/location/' + resort.id + '/snow-summary?' + params + '#live-extended' };
  });
  const { days, blocks } = rows[0];
  return { mode: 'timeline', stage, days, blocks, maximum: FULL_BAR_INCHES, heavy: HEAVY_DAILY_INCHES, rows };
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
