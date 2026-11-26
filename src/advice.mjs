import { t, convertWeather, overnightTarget, weatherUnit } from './i18n.mjs';
import { RESORT, getResort, snowLevelBands } from './config.mjs';
import { HOUR, nightWindow, formatDate, formatTime } from './time.mjs';
import { stationSummary, summarizeModel, summarizeSnowLevel, finite } from './conditions.mjs';
import { snowAmount, snowRange } from './forecast.mjs';

const usable = (data, id) => ['fresh', 'cached'].includes(data.sources?.find(s => s.id === id)?.status);
const temp = (station) => finite(station?.temperatureF) ? `${Math.round(convertWeather(station.temperatureF, '°F'))}${weatherUnit('°F')}` : t('temperature unavailable');

export function buildAdvice(data, now) {
  const resort = getResort(data.resort?.id) || RESORT;
  const stations = (data.stations || []).map(item => stationSummary(item, now));
  const brooks = stations.find(s => s.id === 'brooks');
  const base = stations.find(s => s.id === 'schmidt');
  const upper = stations.find(s => s.id === 'tye');
  const observations = [];
  if (brooks?.at) observations.push(t('NWAC Brooks {0} at {1}{2}.', temp(brooks), formatTime(brooks.at), brooks.quality !== 'fresh' ? t(' (stale)') : ''));
  if (base?.at) observations.push(t('Base {0}{1}; compare with conditions at 4,800 ft.', temp(base), base.quality !== 'fresh' ? t(' (stale)') : ''));
  if (upper?.quality === 'fresh' && finite(upper.gustMph)) observations.push(t('Tye Mill gusts {0} mph.', Math.round(upper.gustMph)));
  let current = { status: 'limited', headline: t('Fresh snow unconfirmed'), detail: t('Check the station record before making a snow-driven trip.'), evidence: [...observations] };
  if (data.observationsEnabled === false) {
    current.headline = t('NWAC observations are disabled');
    current.detail = t('This deployment shows forecasts only. Observed snowfall and current station conditions are not being collected.');
  } else if (!brooks || brooks.quality !== 'fresh') {
    current.headline = t('Waiting for a current NWAC check');
    current.detail = t('Brooks observations are missing or stale. Current snowfall cannot be confirmed.');
  } else if (brooks.board.status === 'valid') {
    const snow = brooks.board.changeIn;
    current.status = snow >= 5 ? 'promising' : snow >= 4 ? 'watch' : 'below';
    current.headline = snow >= 5 ? t('Fresh-snow signal at Brooks') : snow >= 4 ? t('Close to your snow target') : t('Limited snow signal so far');
    current.detail = t('{0} board increase from 6 pm to {1}. Your fresh-snow target is {2}.', t('{0} {1}', snowAmount(snow), weatherUnit('in')), formatTime(brooks.board.end), overnightTarget());
    if (snow >= 4 && brooks.temperatureF > 34) { current.status = 'watch'; current.headline = t('Snow signal, with warm conditions'); }
    if (!finite(brooks.temperatureF)) {
      current.status = 'limited'; current.headline = t('Snow signal; temperature check missing');
      current.detail += t(' Brooks temperature is unavailable, so current snow quality needs a check.');
    }
    current.evidence.push(brooks.board.reason);
  } else {
    current.detail = brooks.board.reason;
    current.evidence.push(t('The measured snowfall is unknown.'));
  }
  const window = nightWindow(now);
  const start = Math.max(window.start, Math.ceil(now / HOUR) * HOUR);
  const summaries = (data.models || []).map(model => ({ id: model.id, label: model.label, ...summarizeModel(model.points, start, window.end) }));
  const complete = summaries.filter(s => s.complete);
  const totals = complete.map(s => s.snowIn);
  const range = totals.length ? { min: Math.min(...totals), max: Math.max(...totals) } : null;
  const snowLevel = usable(data, 'nws') ? summarizeSnowLevel(data.snowLevels || [], start, window.end) : { min: null, max: null, complete: false };
  const remaining = start > window.start;
  const future = { status: 'limited', headline: t('Waiting for the overnight forecast'), detail: t('At least two complete model forecasts are needed for a useful comparison.'), evidence: [], range, snowLevel, models: summaries, start, end: window.end, nightStart: window.start, remaining, label: formatDate(window.end), hours: (window.end - start) / HOUR };
  if (complete.length >= 2 && usable(data, 'forecast')) {
    future.status = range.max < 4 ? 'below' : range.min >= 5 ? 'promising' : 'watch';
    future.headline = future.status === 'below' ? t('Little snow in the forecast') : future.status === 'promising' ? t('A promising overnight setup') : t('Models are split on overnight snow');
    future.detail = t('{0} {1} at {2} ({3} ft). {4}', snowRange(range), remaining ? t('forecast remaining') : t('forecast overnight'), t(resort.pointLabel), resort.elevationFt.toLocaleString('en-US'), remaining ? t('From {0} to 6 am.', formatTime(start)) : t('6 pm to 6 am Pacific.'));
    if (remaining) {
      future.status = 'partial';
      future.headline = range.max < 4 ? t('Little additional snow expected') : t('Additional snow still in the forecast');
      future.detail += t(' This does not establish the full-night total.');
    }
    future.evidence.push(t('{0} complete model forecasts compared. Their range is not a probability.', complete.length));
    if (snowLevel.complete) {
      future.evidence.push(t('NWS snow level {0}–{1} ft.', Math.round(snowLevel.min / 100) * 100, Math.round(snowLevel.max / 100) * 100));
      if (range.max >= 4 && snowLevel.max > snowLevelBands(resort).wet) { future.status = 'watch'; future.headline = t('Snow potential, with a warm edge'); }
    } else {
      future.evidence.push(t('A complete snow-level forecast is unavailable. Rain/snow quality needs another check.'));
      if (future.status === 'promising') future.status = 'watch';
    }
    if (data.observationsEnabled === false) {
      future.evidence.push(t('Forecast only. NWAC collection is disabled; fresh snow has not been confirmed by observations.'));
    } else if (!brooks || brooks.quality !== 'fresh' || !finite(brooks.temperatureF)) {
      future.status = 'limited'; future.headline = t('Forecast ready; NWAC check missing');
      future.evidence.push(t('Current Brooks temperature cannot support the conditions check.'));
    } else {
      future.evidence.push(t('NWAC baseline: Brooks {0} now{1}. This is observed context, not tomorrow’s temperature.', temp(brooks), base?.quality === 'fresh' && finite(base.temperatureF) ? t(', base {0}', temp(base)) : ''));
      if (brooks.board.status !== 'valid') future.evidence.push(t('Observed snow is unconfirmed. Recheck NWAC in the morning.'));
    }
  } else if (!usable(data, 'forecast')) {
    future.detail = t('Forecast access is unavailable or cached data is stale. Check the source before planning tomorrow.');
  }
  return { now: current, tomorrow: future, stations };
}
