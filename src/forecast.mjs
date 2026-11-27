import { t, convertWeather, depthNumber, depthThreshold, overnightTarget, weatherUnit } from './i18n.mjs';
import { HOUR, localParts, localDayStart, nightWindow, formatTime } from './time.mjs';
import { finite, summarizeSnowLevel } from './conditions.mjs';
import { MODELS, snowLevelBands } from './config.mjs';

export const METRICS = {
  snow: { label: 'Snowfall', field: 'snowIn', unit: 'in', mode: 'cumulative', note: 'Accumulated snow from the displayed forecast start' },
  temperature: { label: 'Temperature', field: 'temperatureF', unit: '°F', note: 'Air temperature at the selected resort forecast point' },
  precip: { label: 'Total Precip', field: 'precipIn', unit: 'in', mode: 'cumulative', note: 'Accumulated liquid equivalent, including rain and snow' },
  precip3: { label: 'Precip (3 hr)', field: 'precipIn', unit: 'in', mode: 'interval', hours: 3, note: 'Liquid equivalent during the preceding three forecast hours' },
  precip6: { label: 'Precip (6 hr)', field: 'precipIn', unit: 'in', mode: 'interval', hours: 6, note: 'Liquid equivalent during the preceding six forecast hours' },
  wind: { label: 'Wind Speed', field: 'windMph', unit: 'mph', note: 'Forecast wind speed at 10 meters above ground' },
  gust: { label: 'Wind Gust', field: 'gustMph', unit: 'mph', note: 'Forecast gusts; exposure differs from lift-top sensors' },
  cloud: { label: 'Cloud Cover', field: 'cloudPct', unit: '%', note: 'Forecast cloud cover' },
  level: { label: 'Snow Level', unit: 'ft', note: 'NWS rain/snow transition, a separate forecast reference' },
};

export function forecastWindow(now, days) {
  if (![1, 3, 5].includes(days)) throw new Error('Unsupported forecast horizon');
  const start = Math.ceil(now / HOUR) * HOUR;
  return { start, end: start + days * 24 * HOUR, hours: days * 24 };
}

function totalForHours(start, end, valueAt, onHour) {
  let sum = 0, correction = 0, covered = 0;
  const expected = (end - start) / HOUR;
  for (let time = start + HOUR; time <= end; time += HOUR) {
    const value = valueAt(time);
    if (finite(value) && value >= 0) {
      // Compensated summation keeps repeated fractions from crossing an integer
      // or a snowfall threshold solely through accumulated floating-point error.
      const corrected = value - correction;
      const next = sum + corrected;
      correction = (next - sum) - corrected;
      sum = next;
      covered++;
    }
    onHour?.(time, value, covered === (time - start) / HOUR ? Number(sum.toPrecision(15)) : null);
  }
  const complete = expected > 0 && Number.isInteger(expected) && covered === expected;
  const total = Number(sum.toPrecision(15));
  return { total: complete ? total : null, partialTotal: total, complete, covered, expected };
}

export function intervalTotal(points, start, end, field) {
  const byTime = new Map(points.map(point => [point.time, point]));
  return totalForHours(start, end, time => byTime.get(time)?.[field]);
}

export const SNOW_BLEND = Object.freeze({ nearHours: 48, preferredWeight: 0.8 });

function createHourlyBlend(data, now, models) {
  // The feed supplies a collection time but no shared initialization time.
  // Anchor every window in this snapshot to the same first full forecast hour.
  const collectedAt = data.sources?.find(source => source.id === 'forecast')?.fetchedAt ?? data.generatedAt ?? now;
  const nearEnd = (Math.ceil(collectedAt / HOUR) + SNOW_BLEND.nearHours) * HOUR;
  const inputs = models.map(model => ({
    id: model.id,
    hourly: new Map(model.points.map(point => [point.time, point])),
  }));
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  function valueAt(time, field) {
    const preferred = [], others = [];
    for (const { id, hourly } of inputs) {
      const value = hourly.get(time)?.[field];
      if (!finite(value) || value < 0) continue;
      if (id === 'ecmwf_ifs025' || (id === 'gfs_hrrr' && time <= nearEnd)) preferred.push(value);
      else others.push(value);
    }
    if (!preferred.length) return mean(others);
    if (!others.length) return mean(preferred);
    return SNOW_BLEND.preferredWeight * mean(preferred) + (1 - SNOW_BLEND.preferredWeight) * mean(others);
  }
  return { valueAt, pointsAt: time => inputs.map(model => model.hourly.get(time)).filter(Boolean) };
}

export function createSnowfallBlend(data, now, models = data.models || []) {
  const { valueAt } = createHourlyBlend(data, now, models);
  return (start, end) => totalForHours(start, end, time => valueAt(time, 'snowIn')).total;
}

function supportsRain(warmWetModels, reportingModels) {
  return warmWetModels >= 3 && warmWetModels > reportingModels / 2;
}

function hourlyPrecipType(points, snowIn, freezingLevelFt, elevationFt) {
  if (!finite(snowIn)) return 'unknown';
  if (snowIn > 0) {
    if (!finite(freezingLevelFt) || !finite(elevationFt)) return 'unknown';
    return freezingLevelFt >= elevationFt ? 'wet' : 'snow';
  }
  const reporting = points.filter(p => finite(p.snowIn));
  const warmWet = reporting.filter(p => p.precipIn > 0 && finite(p.temperatureF) && p.temperatureF > 32);
  if (supportsRain(warmWet.length, reporting.length)) return 'rain';
  if (reporting.length && reporting.every(p => p.precipIn === 0) && !points.some(p => p.precipIn > 0)) return 'none';
  return 'unknown';
}

export function hourlySnowForecast(data, now) {
  const start = Math.ceil(now / HOUR) * HOUR;
  const status = data.sources?.find(source => source.id === 'forecast')?.status;
  const current = status === 'fresh' || status === 'cached';
  const models = current || status === 'stale' ? data.models || [] : [];
  const { valueAt, pointsAt } = createHourlyBlend(data, now, models);
  const hours = [];
  const appendHour = (to, snowIn, totalIn) => {
    const from = to - HOUR;
    // Snow covers the following hour. The freezing height is instantaneous at its start.
    const freezingLevelFt = valueAt(from, 'freezingLevelFt');
    hours.push({
      start: from, snowIn, totalIn, freezingLevelFt,
      phase: current ? hourlyPrecipType(pointsAt(to), snowIn, freezingLevelFt, data.resort?.elevationFt) : 'unknown',
    });
  };
  const { total } = totalForHours(start, start + 36 * HOUR, time => valueAt(time, 'snowIn'), appendHour);
  return { start, hours, totalIn: total };
}

export function forecastRange(models, start, end, field = 'snowIn') {
  const rows = models.map(model => ({ id: model.id, label: model.label, ...intervalTotal(model.points, start, end, field) }));
  const totals = rows.filter(m => m.complete).map(m => m.total);
  return { min: totals.length ? Math.min(...totals) : null, max: totals.length ? Math.max(...totals) : null,
    count: totals.length, contributingCount: rows.filter(row => row.covered > 0).length, models: rows };
}

export function modelMedian(range) {
  const totals = (range?.models || []).filter(m => m.complete && finite(m.total)).map(m => m.total).sort((a, b) => a - b);
  const middle = Math.floor(totals.length / 2);
  return totals.length ? totals.length % 2 ? totals[middle] : (totals[middle - 1] + totals[middle]) / 2 : null;
}

// Days and five-day blocks use the same hourly blend, including short-range
// models where they have coverage. Ranges use complete individual model totals.
export function fifteenDayForecast(data, now) {
  const models = data.models || [];
  const blend = createSnowfallBlend(data, now, models);
  const firstFullHour = Math.ceil(now / HOUR) * HOUR;
  const summarize = (start, end) => {
    const range = forecastRange(models, start, end);
    return { ...range, median: modelMedian(range), blendedIn: blend(start, end) };
  };
  const days = Array.from({ length: 15 }, (_, index) => {
    const calendarStart = localDayStart(now, index), end = localDayStart(now, index + 1);
    const start = index === 0 ? Math.max(calendarStart, firstFullHour) : calendarStart;
    return { calendarStart, start, end, partial: start > calendarStart,
      ending: start >= end, ...summarize(start, end) };
  });
  const blocks = [[0, 4], [5, 9], [10, 14]].map(([first, last]) => ({
    firstDay: first + 1, lastDay: last + 1,
    start: days[first].start, end: days[last].end,
    partial: days[first].partial, ...summarize(days[first].start, days[last].end),
  }));
  return { days, blocks };
}

export function comparisonSeries(data, ids, metric, start, end) {
  const times = Array.from({ length: Math.round((end - start) / HOUR) + 1 }, (_, i) => start + i * HOUR);
  if (metric === 'level') return { times, references: Object.values(snowLevelBands(data.resort)), lines: [{ id: 'nws', label: t('NWS snow level'), color: '#3498db', values: times.map(time => data.snowLevels?.find(p => p.start <= time && p.end > time)?.feet ?? null) }] };
  const spec = METRICS[metric];
  if (!spec) throw new Error('Unsupported forecast variable');
  return { times, lines: data.models.filter(m => ids.includes(m.id)).map(model => {
    const points = new Map(model.points.map(p => [p.time, p]));
    let sum = 0, broken = false;
    const values = times.map((time, index) => {
      const value = points.get(time)?.[spec.field];
      if (spec.mode === 'cumulative') {
        if (!index) return finite(points.get(time + HOUR)?.[spec.field]) ? 0 : null;
        if (!finite(value) || value < 0) broken = true;
        if (broken) return null;
        sum += value; return Number(sum.toPrecision(15));
      }
      if (spec.mode === 'interval') return index < spec.hours ? null : intervalTotal(model.points, time - spec.hours * HOUR, time, spec.field).total;
      return finite(value) ? value : null;
    });
    return { id: model.id, label: model.label, color: model.color, values };
  }) };
}

export function forecastPeriods(start, end) {
  const periods = [];
  for (let offset = -1; offset <= 7; offset++) {
    const night = nightWindow(start, offset), previous = nightWindow(start, offset - 1);
    for (const [kind, from, to] of [['Day', previous.end, night.start], ['Night', night.start, night.end]]) {
      if (to <= start || from >= end) continue;
      periods.push({ kind, start: Math.max(start, from), end: Math.min(end, to), originalStart: from, originalEnd: to, partial: from < start || to > end });
    }
  }
  return periods;
}

export function forecastBins(start, end, hours = 6) {
  if (![3, 6].includes(hours)) throw new Error('Unsupported precipitation interval');
  if (!finite(start) || !finite(end) || end <= start) return [];
  const boundaries = [], margin = (hours + 2) * HOUR;
  // Local clock boundaries keep midnight/6 am/6 pm legible through DST.
  for (let time = Math.floor((start - margin) / HOUR) * HOUR; time <= end + margin; time += HOUR) {
    if (localParts(time).hour % hours === 0) boundaries.push(time);
  }
  return boundaries.slice(0, -1).map((from, i) => ({
    start: Math.max(start, from), end: Math.min(end, boundaries[i + 1]),
    originalStart: from, originalEnd: boundaries[i + 1], partial: from < start || boundaries[i + 1] > end,
  })).filter(bin => bin.end > bin.start);
}

export function overnightForecast(data, now) {
  const window = nightWindow(now, localParts(now).hour < 6 ? -1 : 0);
  const start = Math.max(window.start, Math.ceil(now / HOUR) * HOUR);
  return { nightStart: window.start, start, end: window.end, remaining: start > window.start,
    snow: forecastRange(data.models, start, window.end),
    level: summarizeSnowLevel(data.snowLevels || [], start, window.end) };
}

// Snowfall labels round up. Forecast calculations use the original amounts.
export function snowAmount(value) {
  return finite(value) && value >= 0 ? String(Math.ceil(convertWeather(value, 'in'))) : t('Unavailable');
}

export function snowRange(range, withUnit = true) {
  if (!finite(range?.min) || !finite(range?.max) || range.min < 0 || range.max < range.min) return t('Unavailable');
  const min = snowAmount(range.min), max = snowAmount(range.max);
  const span = min === max ? min : min + '–' + max;
  return withUnit ? t('{0} {1}', span, weatherUnit('in')) : span;
}

function collectionState(source, now) {
  if (!source || source.status === 'unavailable' || source.status === 'disabled' || !finite(source.fetchedAt)) return 'unavailable';
  const ttl = source.refreshAfterMs ?? (source.id === 'nws' ? HOUR : HOUR / 2);
  return !['fresh', 'cached'].includes(source.status) || now < source.fetchedAt || now - source.fetchedAt >= ttl ||
    (source.id === 'nws' && finite(source.issuedAt) && now - source.issuedAt > 24 * HOUR) ? 'stale' : 'current';
}

function overnightLevel(data, start, end, now) {
  const source = data.sources?.find(s => s.id === 'nws');
  const state = collectionState(source, now);
  const level = summarizeSnowLevel(data.snowLevels || [], start, end);
  const intervals = (data.snowLevels || []).filter(p => finite(p.feet) && p.feet >= 0 && p.start < end && p.end > start).sort((a, b) => a.start - b.start);
  const feet = n => (Math.round(n / 100) * 100).toLocaleString('en-US');
  if (!intervals.length || state === 'unavailable') return { state: 'unavailable', coverage: 'none', value: t('Unavailable'), note: t('Snow-level forecast unavailable'), source, intervals };
  const range = t('{0}{1} ft', feet(level.min), feet(level.min) === feet(level.max) ? '' : '–' + feet(level.max));
  if (state === 'stale') return { state, coverage: level.complete ? 'full' : 'partial', value: level.complete ? range : t('Partial coverage'), note: t('{0}Saved NWS forecast · update overdue', level.complete ? '' : range + t(' in available hours · ')), source, intervals };
  if (!level.complete) return { state: 'partial', coverage: 'partial', value: t('Partial coverage'), note: t('{0} in available hours', range), source, intervals };
  const first = intervals[0].feet, last = intervals.at(-1).feet;
  const falling = intervals.every((p, i) => !i || p.feet <= intervals[i - 1].feet);
  const rising = intervals.every((p, i) => !i || p.feet >= intervals[i - 1].feet);
  const value = (falling || rising) && feet(first) !== feet(last) ? t('{0} → {1} ft', feet(first), feet(last)) : range;
  const { dry, wet } = snowLevelBands(data.resort);
  const dryText = dry.toLocaleString('en-US'), wetText = wet.toLocaleString('en-US');
  const note = level.max <= dry ? t('At/below your {0} ft preference', dryText)
    : level.min >= wet ? t('At/above {0} ft throughout', wetText)
    : level.max >= wet ? falling ? t('At/above {0} ft early', wetText) : rising ? t('Reaches {0} ft later', wetText) : t('Crosses your {0} ft caution level', wetText)
    : Math.round(level.max / 100) * 100 === wet ? t('Near your {0} ft caution level', wetText) : t('Below your {0} ft caution level', wetText);
  return { state, coverage: 'full', value, note, source, intervals };
}

function nightDate(start) {
  const p = localParts(start);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function datedNight(choice) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(choice)) return null;
  // 20:00 UTC is midday in Pacific time, including either DST offset.
  const time = Date.parse(`${choice}T20:00:00Z`);
  return finite(time) && new Date(time).toISOString().slice(0, 10) === choice ? nightWindow(time) : null;
}

function precipitationAtCaution(models, intervals, start, end, wet) {
  return models.some(model => model.points.some(p => p.time > start && p.time <= end && finite(p.precipIn) && p.precipIn > 0 &&
    intervals.some(level => finite(level.feet) && level.feet >= wet && level.start < p.time && level.end > p.time - HOUR)));
}

function mainUncertainty(n, models, timingRisk) {
  const explain = (kind, text) => ({ kind, text });
  if (n.phase === 'morning') return explain('observation', t('The forecast cannot confirm what fell. Check an actual station report before leaving.'));
  if (n.forecastState === 'unavailable') return explain('unavailable', t('No usable forecast is available to assess this night.'));
  if (n.forecastState === 'stale') return explain('stale', t('Collection is overdue. The saved amounts may no longer reflect the latest forecasts.'));
  if (n.phase === 'ending') return explain('remaining', t('The last hour is in progress. Already-fallen snow and the remaining part of this hour are unconfirmed.'));
  if (n.phase === 'remaining') return explain('remaining', t('These are only the remaining full forecast hours. The full-night snowfall is still unconfirmed.'));
  if (n.coverage !== 'full') return explain('coverage', t('Only {0} of {1} models cover the full night. Missing forecasts could change the picture.', n.snow.count, n.expectedModels));
  if (n.snow.max === 0) return explain('dry', t('No model shows new snow this night. This does not describe the existing ski surface.'));
  if (n.level.state !== 'current') return explain('snow-level-data', n.level.state === 'stale'
    ? t('The NWS snow-level update is overdue; the rain/snow transition cannot be checked against a current forecast.')
    : t('NWS snow-level coverage is incomplete or unavailable, leaving the rain/snow transition uncertain.'));
  if (precipitationAtCaution(models, n.level.intervals, n.start, n.end, n.bands.wet)) return explain('snow-level',
    t('Some models forecast precipitation while NWS snow level is at/above {0} ft. Check those intervals below.', n.bands.wet.toLocaleString('en-US')));
  const { four, five, available } = n.support;
  if (four > 0 && four < available) return explain('amount', four === 1
    ? t('Only 1 of {0} models reaches {1}. The high end depends on a single forecast.', available, depthThreshold(4, true))
    : t('{0} of {1} models reach {2}, but {3} below it.', four, available, depthThreshold(4, true), available - four === 1 ? t('one model stays') : t('{0} models stay', available - four)));
  if (five > 0 && five < available) return explain('amount', t('Models agree on at least {0}, but differ on reaching {1}.', depthThreshold(4, true), depthThreshold(5, true)));
  // A display sensitivity cue, not a calibrated error bound or confidence score.
  if (n.snow.models.some(m => m.complete && [4,5].some(t => Math.abs(m.total - t) <= .5)))
    return explain('threshold', t('Some estimates are within {0} of your {1} target. Small forecast changes could alter target support.', depthThreshold(0.5, true), overnightTarget()));
  if (n.snow.max < 4) return explain('below', t('All models stay below {0}. The forecast offers little support for your fresh-snow target.', depthThreshold(4, true)));
  if (timingRisk === 'split') return explain('timing', t('Arrival timing is unresolved between models. Inspect the overnight intervals before relying on a morning total.'));
  if (timingRisk === 'late') return explain('timing', t('Most forecast accumulation is after midnight. A delay could change how much arrives by 6 am.'));
  return explain('forecast', t('Model agreement does not verify actual snowfall. Check a station report before leaving.'));
}

export function overnightDecision(data, now, choice = 'auto') {
  const hour = localParts(now).hour, morningHours = hour >= 6 && hour < 12;
  const requested = datedNight(choice);
  const review = requested ? requested.end <= now : morningHours && choice !== 'tonight';
  const night = requested || nightWindow(now, hour < 6 || review ? -1 : 0);
  const morning = morningHours || review;
  const start = review ? night.start : Math.max(night.start, Math.ceil(now / HOUR) * HOUR);
  const phase = review ? 'morning' : start >= night.end ? 'ending' : start > night.start ? 'remaining' : 'upcoming';
  const source = data.sources?.find(s => s.id === 'forecast');
  const forecastState = collectionState(source, now);
  const models = MODELS.map(m => ({ ...m, points: data.models?.find(p => p.id === m.id)?.points || [] }));
  const snow = forecastRange(models, start, night.end);
  const coverage = snow.count === MODELS.length ? 'full' : snow.count > 1 ? 'limited' : snow.count === 1 ? 'single' : 'none';
  const complete = snow.models.filter(m => m.complete);
  const subject = coverage === 'full' ? t('All models') : t('Available models');
  let amountState = null, headline, amount = snowRange(snow);
  if (phase === 'morning') { headline = night.start === nightWindow(now, -1).start ? t('Last night\'s snowfall is unconfirmed') : t('That night\'s snowfall is unconfirmed'); amount = t('Unconfirmed'); }
  else if (forecastState === 'unavailable') { headline = t('Forecast unavailable'); amount = t('Unavailable'); }
  else if (forecastState === 'stale') headline = t('Saved forecast · update overdue');
  else if (phase === 'ending') headline = t('Final hour in progress');
  else if (!snow.count) headline = t('Full-period model totals unavailable');
  else if (phase === 'remaining') headline = t('Remaining overnight forecast');
  else if (coverage === 'single') headline = t('Only {0} covers this night', complete[0].label);
  else {
    amountState = snow.max === 0 ? 'zero' : snow.max < 4 ? 'below' : snow.min < 4 ? 'split' : snow.min < 5 ? 'lower' : 'upper';
    headline = {
      zero: coverage === 'full' ? t('No snow forecast overnight') : t('Available models show zero'),
      below: coverage === 'full' ? t('Below your {0} target', overnightTarget()) : t('Available models fall below your target'),
      split: coverage === 'full' ? t('Models split on your target') : t('Available models split on your target'),
      lower: t('{0} reach at least {1}', subject, depthThreshold(4, true)), upper: t('{0} reach at least {1}', subject, depthThreshold(5, true)),
    }[amountState];
  }
  const rows = snow.models.map((row, i) => ({ ...row, color: models[i].color,
    target: !row.complete ? t('Missing hours') : forecastState !== 'current' ? t('Saved') : phase !== 'upcoming' ? t('{0}/{1} hr', row.covered, row.expected)
      : row.total === 0 ? t('No snow') : row.total < 4 ? t('Below {0}', depthNumber(4)) : row.total < 5 ? overnightTarget() : t('At least {0}', depthNumber(5)),
    targetState: !row.complete || forecastState !== 'current' || phase !== 'upcoming' ? 'neutral' : row.total < 4 ? 'below' : 'meets',
  }));
  const bins = forecastBins(start, night.end, 3).map(bin => ({ ...bin,
    snow: forecastRange(models, bin.start, bin.end), liquid: forecastRange(models, bin.start, bin.end, 'precipIn'),
    level: overnightLevel(data, bin.start, bin.end, now),
  }));
  let timing = t('Timing unavailable'), timingRisk = null;
  if (phase === 'morning') timing = t('The 6 pm–6 am window has ended');
  else if (phase === 'ending') timing = t('Remaining amount unavailable for this partial hour');
  else if (forecastState !== 'current') timing = forecastState === 'stale' ? t('Timing belongs to the saved forecast') : t('Waiting for usable forecast data');
  else if (snow.count) {
    if (snow.max === 0) timing = t('{0} in {1}', coverage === 'full' ? t('No snow') : t('Available models show no snow'), phase === 'remaining' ? t('the remaining hours') : t('this night'));
    else if (snow.max < .1) timing = t('Only trace accumulation shown');
    else if (phase === 'remaining') timing = t('Full future forecast hours only');
    else {
      const midnight = bins.find(b => localParts(b.start).hour === 0)?.start;
      const snowModels = models.filter(m => complete.some(r => r.id === m.id && r.total >= .1));
      const late = midnight && snowModels.every(m => intervalTotal(m.points, midnight, night.end, 'snowIn').total > complete.find(r => r.id === m.id).total / 2);
      timingRisk = late ? 'late' : null;
      timing = late ? t('{0} after midnight', snowModels.length < complete.length ? t('Snow-producing models: more') : t('More snow')) : t('Arrival timing differs · compare models');
      if (!late) {
        const starts = snowModels.map(m => bins.find(b => intervalTotal(m.points, b.start, b.end, 'snowIn').total >= .1)?.start).filter(finite);
        if (!starts.length) timing = t('Light accumulation · no clear arrival window');
        else if (starts.length < snowModels.length) {
          timing = t('Arrival window unclear · compare models');
          timingRisk = 'split';
        } else if (new Set(starts).size === 1) {
          timing = t('Accumulation from {0} window', formatTime(starts[0], { minute: undefined }));
        } else timingRisk = 'split';
      }
    }
  }
  const support = phase === 'upcoming' && forecastState === 'current' && complete.length ? {
    four: complete.filter(m => m.total >= 4).length, five: complete.filter(m => m.total >= 5).length,
    available: complete.length, expected: MODELS.length,
  } : null;
  const result = { phase, morning, nightDate: nightDate(night.start), lastNightDate: nightDate(nightWindow(now, -1).start),
    nightStart: night.start, start, end: night.end, source, forecastState, snow, rows, bins, coverage, support,
    bands: snowLevelBands(data.resort), expectedModels: MODELS.length, coverageText: t('{0} of {1} models cover {2}', snow.count, MODELS.length, phase === 'remaining' ? t('these hours') : t('this night')),
    amountState, headline, amount, timing, level: overnightLevel(data, start, night.end, now),
  };
  result.uncertainty = mainUncertainty(result, models, timingRisk);
  return result;
}

// Presentation for the focused Tomorrow screen. The original totals and source
// states remain available in Details; these summaries never replace that evidence.
export function tomorrowForecast(data, now, choice = 'auto', blend = createSnowfallBlend(data, now)) {
  const night = overnightDecision(data, now, choice);
  const canForecast = !['morning', 'ending'].includes(night.phase) && night.forecastState !== 'unavailable';
  const blendedIn = canForecast ? blend(night.start, night.end) : null;
  const usable = blendedIn !== null;
  const median = canForecast ? modelMedian(night.snow) : null;
  const value = usable ? snowAmount(blendedIn) : night.phase === 'morning' ? t('Unconfirmed') : '—';
  const contributors = night.rows.filter(row => row.covered > 0);
  const estimate = { blendedIn, median, value, approximate: usable && blendedIn > 0,
    label: !usable ? night.phase === 'morning' ? t('Actual snowfall') : night.phase === 'ending' ? t('Final hour in progress') : t('Forecast unavailable')
      : contributors.length === 1 ? t('{0} only', contributors[0].label) : t('{0}-model blend', contributors.length) };

  // Descriptive model spread, not calibrated confidence. Fewer than three
  // complete models cannot support a tier; missing coverage stays visible.
  let agreement = { key: null, label: night.forecastState === 'stale' && canForecast ? t('Outdated') : t('Unavailable') };
  if (usable && night.forecastState === 'current' && night.snow.count > 1) {
    if (night.snow.count < 3) agreement = { key: null, label: t('Limited') };
    else {
      const spread = night.snow.max - night.snow.min;
      const key = spread === 0 || spread <= median * .4 ? 'high' : spread <= median ? 'moderate' : 'low';
      agreement = { key, label: { high: t('High'), moderate: t('Moderate'), low: t('Low') }[key] };
    }
  }

  // These are personal elevation-relative snow-level bands, not snow-density
  // measurements. Never classify stale/partial guidance or an observed surface.
  let condition = { key: null, label: t('Unavailable'), transition: '' };
  if (usable && night.forecastState === 'current') {
    if (blendedIn === 0 || night.snow.max === 0) condition.label = night.coverage === 'full' ? t('No new snow') : t('Snow uncertain');
    else if (night.level.state === 'current' && night.level.coverage === 'full') {
      const { dry, wet } = snowLevelBands(data.resort);
      const band = feet => feet <= dry ? 'dry' : feet >= wet ? 'wet' : 'normal';
      const labels = { dry: t('Dry'), normal: t('Normal'), wet: t('Wet') };
      // Snowfall uses the remaining hours; an earlier wet interval still matters
      // to the morning condition. Keep available full-night forecast history.
      const history = overnightLevel(data, night.nightStart, night.end, now);
      const sequence = history.intervals.map(p => band(p.feet));
      const key = band(night.level.intervals.at(-1).feet);
      const earlier = sequence.slice(0, -1);
      const different = earlier.includes('wet') && key !== 'wet' ? 'wet' : earlier.find(value => value !== key);
      const early = sequence[0] === different && history.intervals[0].start <= night.nightStart;
      let transition = different ? `${labels[different]} ${early ? t('early') : t('earlier')}` : '';
      if (history.coverage !== 'full') transition = transition ? t('{0} · gaps', transition) : t('Earlier: partial data');
      condition = { key, label: labels[key], transition, history };
    } else condition.label = night.level.state === 'stale' ? t('Outdated') : night.level.coverage === 'partial' ? t('Partial data') : t('Unavailable');
  }
  return { ...night, estimate, agreement, condition };
}

// Each column is an independent Pacific overnight forecast, never a cumulative
// total. Build dates on the local calendar so DST nights keep their actual hours.
export function horizonForecast(data, now, days) {
  if (![3, 5].includes(days)) throw new Error('Unsupported forecast horizon');
  const offset = localParts(now).hour < 6 ? -1 : 0;
  const blend = createSnowfallBlend(data, now);
  const nights = Array.from({ length: days }, (_, i) => {
    const night = tomorrowForecast(data, now, nightDate(nightWindow(now, offset + i).start), blend);
    // Later nights often exceed HRRR's horizon. The board exposes the available
    // model count beside every amount; zero describes those complete forecasts.
    if (night.forecastState === 'current' && night.estimate.blendedIn === 0 && night.snow.max === 0 && night.snow.count >= 3 && !night.rows.some(row => row.partialTotal > 0))
      night.condition = { ...night.condition, label: t('No new snow') };
    return { ...night, quality: personalSnowQuality(data, night) };
  });
  return { nights, maximum: Math.max(1, ...nights.map(n => n.estimate.blendedIn ?? 0)) };
}

// Personal new-snow preference, not observed surface quality. Missing evidence
// stays unknown, and exact amounts (not the rounded display) set the thresholds.
export function personalSnowQuality(data, night) {
  const unknown = { key: null, label: t('Unknown') };
  const amount = night.estimate.blendedIn;
  if (night.forecastState !== 'current' || amount === null || night.snow.count < 3) return unknown;
  if (night.snow.max === 0) {
    if (night.rows.some(row => row.partialTotal > 0)) return unknown;
    const complete = new Set(night.rows.filter(row => row.complete).map(row => row.id));
    const rainModels = data.models.filter(model => {
      if (!complete.has(model.id)) return false;
      const liquid = intervalTotal(model.points, night.start, night.end, 'precipIn');
      if (!liquid.complete || liquid.total < .01) return false;
      const wetHours = model.points.filter(p => p.time > night.start && p.time <= night.end && p.precipIn > 0);
      return wetHours.length > 0 && wetHours.every(p => finite(p.temperatureF) && p.temperatureF > 32);
    }).length;
    if (supportsRain(rainModels, night.snow.count)) return { key: 'rain', label: t('Rain'), rainModels };
    return { key: 'poor', label: t('Poor') };
  }
  if (!night.condition.key) return unknown;
  if (night.condition.key === 'wet') return { key: 'wet', label: t('Wet') };
  if (amount < 1) return { key: 'poor', label: t('Poor') };
  const history = night.condition.history;
  const dryNight = history?.coverage === 'full' && history.intervals.every(p => p.feet < snowLevelBands(data.resort).wet);
  if (amount >= 5 && night.condition.key === 'dry' && dryNight) return { key: 'excellent', label: t('Excellent') };
  return { key: 'good', label: t('Good') };
}
