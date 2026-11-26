import { t } from './i18n.mjs';
import { HOUR, formatDate, formatTime } from './time.mjs';
import { finite } from './conditions.mjs';
import { buildAdvice } from './advice.mjs';

// Re-evaluate retained data against the clock, even when every refresh fails.
export function ageSnapshot(data, now) {
  const sources = data.sources.map(source => {
    const ttl = source.refreshAfterMs ?? (source.id === 'forecast' ? HOUR / 2 : source.id === 'nws' ? HOUR : HOUR / 4);
    const expired = !finite(source.fetchedAt) || now - source.fetchedAt > ttl || (source.id === 'nws' && finite(source.issuedAt) && now - source.issuedAt > 24 * HOUR);
    return { ...source, status: expired && ['fresh', 'cached'].includes(source.status) ? 'stale' : source.status };
  });
  const stations = data.stations.map(station => {
    const sourceId = station.sourceId || (['tye', 'skyline'].includes(station.id) ? 'upper' : station.id);
    const status = sources.find(source => source.id === sourceId)?.status || 'unavailable';
    return { ...station, sourceState: status };
  });
  let morning = data.morning;
  if (morning) {
    const stationSource = sources.find(source => source.id === 'nwac');
    const roadSource = sources.find(source => source.id === 'wsdot');
    const ageReading = reading => !reading ? null : { ...reading, state: !finite(reading.observedAt) || reading.observedAt > now + 5 * 60_000 || now - reading.observedAt >= 3 * HOUR || !['fresh', 'cached'].includes(stationSource?.status) ? 'stale' : 'fresh' };
    const issuedAt = morning.road?.issuedAt;
    const reportState = !finite(issuedAt) ? 'unknown' : issuedAt > now + 5 * 60_000 || now - issuedAt >= 3 * HOUR || !['fresh', 'cached'].includes(roadSource?.status) ? 'stale' : 'fresh';
    morning = {
      ...morning,
      station: {
        ...morning.station,
        snowfall24h: ageReading(morning.station?.snowfall24h),
        depth: ageReading(morning.station?.depth),
        temperature: ageReading(morning.station?.temperature),
      },
      road: morning.road ? { ...morning.road, reportState } : null,
    };
  }
  const result = { ...data, sources, stations, morning, evaluatedAt: now };
  return { ...result, advice: buildAdvice(result, now) };
}

export const reconcileSelection = (models, excluded) => new Set(models.filter(model => !excluded.has(model.id)).map(model => model.id));

export function forecastStatus(data, metric) {
  const source = data.sources.find(item => item.id === (metric === 'level' ? 'nws' : 'forecast'));
  const status = source?.status || 'unavailable';
  const label = metric === 'level' ? t('NWS snow level') : t('Model forecasts');
  const retrieved = finite(source?.fetchedAt) ? t('retrieved {0} at {1} PT', formatDate(source.fetchedAt), formatTime(source.fetchedAt)) : t('no successful retrieval');
  const issued = finite(source?.issuedAt) ? t(' · issued {0} {1} PT', formatDate(source.issuedAt), formatTime(source.issuedAt)) : '';
  return { status, text: `${status === 'stale' ? t('Stale forecast') : status === 'unavailable' ? t('Forecast unavailable') : label} · ${retrieved}${issued}${status === 'stale' ? t(' · last saved values; refresh needed') : ''}` };
}

export function chartData(data, selected, metric, start, hours) {
  const times = Array.from({ length: hours + 1 }, (_, i) => start + i * HOUR);
  if (metric === 'level') return { times, lines: [{ id: 'nws', label: t('NWS snow level'), color: '#127b83', values: times.map(time => data.snowLevels.find(p => p.start <= time && p.end > time)?.feet ?? null) }] };
  return { times, lines: data.models.filter(model => selected.has(model.id)).map(model => {
    const byTime = new Map(model.points.map(point => [point.time, point]));
    const firstSnow = byTime.get(start + HOUR)?.snowIn;
    let sum = 0, broken = false;
    const values = times.map((time, index) => {
      const point = byTime.get(time);
      if (metric === 'snow') {
        if (!index) return finite(firstSnow) && firstSnow >= 0 ? 0 : null;
        if (!finite(point?.snowIn) || point.snowIn < 0) broken = true;
        if (broken) return null;
        sum += point.snowIn; return Number(sum.toPrecision(15));
      }
      const field = metric === 'temperature' ? 'temperatureF' : 'gustMph';
      return finite(point?.[field]) ? point[field] : null;
    });
    return { id: model.id, label: model.label, color: model.color, values };
  }) };
}

export function chartMessage(chart, metric) {
  const values = chart.lines.flatMap(line => line.values).filter(finite);
  if (!values.length) return metric === 'level' ? t('Snow-level forecast unavailable') : chart.lines.length ? t('No data for this time window') : t('Select a model to compare');
  const complete = chart.lines.length && chart.lines.every(line => line.values.every(finite));
  return metric === 'snow' && complete && Math.max(...values) === 0 ? t('No measurable snow in this forecast window') : '';
}
