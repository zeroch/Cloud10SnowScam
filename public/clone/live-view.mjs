import { displayLanguage, t, modelCountLabel, convertWeather, depthNumber, depthThreshold, depthUnitName, overnightTarget, weatherUnit } from '/lib/i18n.mjs';
import { RESORT, MORNING_RESORTS, getResort, snowLevelBands, stationUrl } from '/lib/config.mjs';
import { HOUR, formatDate, formatTime, localParts, isPacificWeekend } from '/lib/time.mjs';
import { finite, stationSummary, summarizeSnowLevel } from '/lib/conditions.mjs';
import {
  METRICS, forecastRange, createSnowfallBlend, SNOW_BLEND, forecastPeriods, forecastBins, intervalTotal,
  tomorrowForecast, resortSnowfallForecast, horizonForecast, fifteenDayForecast, hourlySnowForecast,
  personalSnowQuality, snowAmount, snowRange, comparisonSeries,
} from '/lib/forecast.mjs';

export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const timestamp = value => finite(value) ? t('{0} {1} PT', formatDate(value), formatTime(value)) : t('Unavailable');
export function amount(value, digits = 1) {
  if (!finite(value)) return '—';
  const rounded = value.toFixed(digits).replace(/\.0$/, '');
  return rounded === '-0' ? '0' : rounded;
}
export function rangeText(range, unit = 'in', digits = 1, withUnit = true) {
  if (!finite(range?.min) || !finite(range.max)) return '—';
  const format = value => amount(convertWeather(value, unit), digits);
  const min = format(range.min), max = format(range.max);
  return `${min}${min === max ? '' : '–' + max}${unit && withUnit ? ' ' + weatherUnit(unit) : ''}`;
}
export const sourceState = (data, id) => data.sources?.find(s => s.id === id)?.status || 'unavailable';
export const sourceUsable = (data, id) => ['fresh', 'cached'].includes(sourceState(data, id));
export const selectedModels = (data, state) => data.models.filter(m => state.ids.includes(m.id));

const resortFor = data => getResort(data?.resort?.id) || RESORT;
const pointCaption = data => t('{0} · {1} ft', escape(t(resortFor(data).pointLabel)), resortFor(data).elevationFt.toLocaleString('en-US'));
const resortPath = data => `/location/${resortFor(data).id}/snow-summary`;
const reportLink = (data, className) => `<a class="${className}" href="${escape(resortFor(data).reportUrl)}" target="_blank" rel="noreferrer">${t('Check {0} · external report', escape(t(resortFor(data).reportLabel)))}</a>`;

export function controls(prefix, data, state, metrics = false) {
  return `<div class="forecast-card-toolbar">${comparisonControls(data, state, prefix)}${metrics ? metricControls(state) : ''}</div>`;
}

// Stable dash patterns let the same model remain identifiable after filtering.
export function linePattern(id) {
  return ({ ecmwf_ifs025: '', gfs_global: '8 4', icon_global: '2 4', gem_global: '9 3 2 3', gfs_hrrr: '12 3 2 3 2 3', nws: '' })[id] || '';
}

export function lineKey(model) {
  return `<svg class="live-line-key" viewBox="0 0 30 8" aria-hidden="true"><line x1="1" x2="29" y1="4" y2="4" stroke="${model.color}" stroke-width="2.5" stroke-dasharray="${linePattern(model.id)}"/></svg>`;
}

function durationControl(prefix, state) {
  return `<label class="forecast-duration" for="${prefix}-days"><span class="cloud-sr-only">${t('Comparison duration')}</span><select id="${prefix}-days" data-comparison-days>${[1,3,5].map(days => `<option value="${days}" ${state.days === days ? 'selected' : ''}>${t(days === 1 ? '{0} Day' : '{0} Days', days)}</option>`).join('')}</select></label>`;
}

export function comparisonControls(data, state, prefix = 'compare') {
  const models = selectedModels(data, state);
  const label = models.length === data.models.length && models.length ? t('All models') : models.length === 1 ? models[0].label : t('{0} models', models.length);
  return `<div class="forecast-selection-controls"><details id="${prefix}-models" class="live-model-menu live-preserve-details"><summary id="${prefix}-models-button">${escape(label)} <span class="forecast-run-label">${t('· latest')}</span>${forecastIcon('chevron')}</summary><div class="live-model-panel">
  <p>${t('Filters apply to all detailed comparisons. Snow Summary always uses all models. NWS snow level is separate.')}</p>
  <button id="${prefix}-all" data-live-all class="cloud-secondary">${t('Select all models')}</button>
  <div class="live-model-toggles" role="group" aria-label="${t('Models to compare')}">${data.models.map(m=>`<label for="${prefix}-toggle-${m.id}"><input id="${prefix}-toggle-${m.id}" type="checkbox" data-live-toggle="${m.id}" ${state.ids.includes(m.id) ? 'checked' : ''}>${lineKey(m)}<span>${escape(m.label)}<small>${escape(t(m.description))}</small></span></label>`).join('')}</div>
  <button id="${prefix}-close" data-models-close class="cloud-secondary">${t('Done')}</button></div></details>${durationControl(prefix,state)}</div>`;
}

function metricControls(state) {
  const precipitation = ['precip','precip3','precip6'].includes(state.metric);
  return `<div class="forecast-chart-toolbar"><div class="live-primary-metrics" data-live-scroll="chart-variables" role="group" aria-label="${t('Forecast variables, scroll for more')}">${[
    ['snow',t('Total snowfall'),state.metric === 'snow'], ['level',t('Snow level'),state.metric === 'level'],
    ['precip',t('Precipitation'),precipitation],
    ...[['temperature',t('Temperature')],['wind',t('Wind')],['gust',t('Gusts')],['cloud',t('Cloud cover')]].map(([id,label]) => [id,label,state.metric === id]),
  ].map(([id,label,selected])=>`<button id="metric-${id}" data-live-metric="${id === 'precip' && precipitation ? state.metric : id}" aria-pressed="${selected}">${label}</button>`).join('')}</div>
  ${precipitation ? `<div class="live-metric-options"><div class="live-horizon" role="group" aria-label="${t('Chart precipitation interval')}">${[['precip',t('Total')],['precip3',t('3 hours')],['precip6',t('6 hours')]].map(([id,label])=>`<button id="chart-${id}" data-live-metric="${id}" aria-pressed="${state.metric===id}">${label}</button>`).join('')}</div></div>` : ''}</div>`;
}

export function windowCaption(state, data) {
  return `<p class="live-caption">${t('{0} hours · {1} → {2} · {3}', state.days * 24, timestamp(state.start), timestamp(state.end), pointCaption(data))}</p>`;
}

export function forecastStatus(data) {
  const source = data.sources?.find(s => s.id === 'forecast');
  const usable = sourceUsable(data, 'forecast');
  return `<p class="live-source-status ${usable ? '' : 'live-warning'}"><span class="live-dot ${usable ? '' : 'live-dot-warning'}"></span>${usable ? t('Latest available forecasts') : source?.fetchedAt ? t('Stale forecast · last saved values') : t('Forecast unavailable')}${source?.fetchedAt ? t(' · retrieved {0}', timestamp(source.fetchedAt)) : ''}</p>`;
}

function snowLevelStatus(data) {
  const source = data.sources?.find(s => s.id === 'nws');
  return `<p class="live-caption ${sourceUsable(data, 'nws') ? '' : 'live-warning'}">${t('NWS snow level · {0}{1}. Separate from model snowfall and freezing level.', t(sourceState(data, 'nws')), source?.fetchedAt ? t(' · retrieved {0}', timestamp(source.fetchedAt)) : '')}</p>`;
}

function periodRange(models, start, end, field) {
  const values = models.flatMap(m => m.points.filter(p => p.time > start && p.time <= end).map(p => p[field])).filter(finite);
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
}

export function summary(data, state) {
  return state.horizon && state.page !== 'stevens' ? horizon(data, state) : outlook(data, state);
}

const preferredPercent = Math.round(SNOW_BLEND.preferredWeight * 100);
const snowBlendMethod = () => t('In the first {0} forecast hours, ECMWF and HRRR split {1}% equally ({2}% each). After that, ECMWF gets {3}%. Other available models share the remaining {4}% equally. We redistribute missing shares within each group every hour. When only one group has coverage, it gets the full weight.', SNOW_BLEND.nearHours, preferredPercent, preferredPercent / 2, preferredPercent, 100 - preferredPercent);

export function extendedOutlook(data, state) {
  const usable = ['fresh', 'cached', 'stale'].includes(sourceState(data, 'forecast'));
  const { days, blocks } = fifteenDayForecast({ ...data, models: usable ? data.models : [] }, state.now);
  const snowLevels = sourceUsable(data, 'nws') ? (data.snowLevels || []) : [];
  const forecastElevation = resortFor(data).elevationFt;
  const heavySnowIn = 8;
  const maximum = Math.max(0, ...days.map(day => day.blendedIn ?? 0));
  const status = sourceState(data, 'forecast') === 'stale' ? t('Saved forecast · update overdue') : usable ? t('Weighted snowfall forecast') : t('Forecast unavailable');
  const blockMarkup = blocks.map(block => {
    const total = snowAmount(block.blendedIn);
    const coverage = block.contributingCount ? modelCountLabel(block.contributingCount) : t('No models');
    const spread = block.count > 1 ? t(' · {0} range', snowRange(block)) : '';
    return `<div class="mountain-block">
      <span>${t('Days {0}–{1}', block.firstDay, block.lastDay)}</span>
      <strong>${escape(total)}${block.blendedIn !== null ? `<small> ${weatherUnit('in')}</small>` : ''}</strong>
      <small>${escape(coverage + spread)}</small>
    </div>`;
  }).join('');
  const dayMarkup = days.map((day, index) => {
    const available = day.blendedIn !== null;
    let accumulation = 'none';
    if (day.blendedIn > heavySnowIn) {
      accumulation = 'heavy';
    } else if (day.blendedIn > 0) {
      const level = summarizeSnowLevel(snowLevels, day.start, day.end);
      accumulation = level.complete && level.max < forecastElevation ? 'wet' : 'snow';
    }
    const amount = snowAmount(day.blendedIn);
    const label = index === 0 ? t('Today') : formatDate(day.calendarStart, { weekday: 'short', month: undefined, day: undefined });
    const date = formatDate(day.calendarStart, { weekday: undefined });
    const spread = day.count > 1 ? snowRange(day) : '';
    const wetNote = accumulation === 'wet' ? t(', snow level stays below forecast elevation') : '';
    const description = `${date}${index === 0 ? t(', remaining full hours') : ''}: ${available ? t('{0}, {1}{2}{3}', t('{0} {1}', amount, depthUnitName(amount)), modelCountLabel(day.contributingCount), spread ? t(', model range {0}', spread) : '', wetNote) : 'unavailable'}`;
    const minimum = snowAmount(day.min), maximumValue = snowAmount(day.max);
    const range = spread ? `${minimum}${minimum === maximumValue ? '' : '–' + maximumValue}` : '';
    const height = day.blendedIn > 0 ? Math.max(3, Math.round(day.blendedIn / maximum * 100)) : 0;
    return `<li class="mountain-day" data-accumulation="${accumulation}" aria-label="${escape(description)}">
      <span class="mountain-bar-track">
        <span class="mountain-day-amount">${available ? escape(amount) : '—'}</span>
        <span class="mountain-bar${available ? '' : ' mountain-bar-missing'}" style="--bar-height:${height}%" aria-hidden="true"></span>
      </span>
      <span class="mountain-day-label">${escape(label)}</span>
      <small>${localParts(day.calendarStart).day}</small>
      <small class="mountain-day-models">${day.contributingCount ? modelCountLabel(day.contributingCount) : t('No models')}</small>
      <small class="mountain-day-range">${escape(range)}</small>
    </li>`;
  }).join('');
  return `<article class="mountain-panel mountain-outlook" aria-labelledby="extended-heading">
    <h2 id="extended-heading">${t('15-day snowfall')}</h2>
    <p class="mountain-intro">${escape(status)}</p>
    <div id="fifteen-day-timeline" class="mountain-timeline-scroll" data-live-scroll="fifteen-day" role="region" tabindex="0" aria-label="${t('15-day snowfall timeline, scroll horizontally for later days')}">
      <div class="mountain-chart">
        <div class="mountain-blocks">${blockMarkup}</div>
        <ol class="mountain-days">${dayMarkup}</ol>
      </div>
    </div>
    <ul class="mountain-accumulation-key">
      <li data-accumulation="snow">${t('Snow')}</li>
      <li data-accumulation="wet">${t('Wet · snow level stays below forecast elevation')}</li>
      <li data-accumulation="heavy">${t('Over {0} before rounding', depthThreshold(heavySnowIn))}</li>
    </ul>
    <p class="mountain-footnote">${t('Daily and five-day forecasts add up the hourly blend, then round up to whole {1}. Counts include every contributing model. Ranges use models that cover the full period. Today shows remaining full hours only{0}.', days[0].ending ? t(' (no full hours remain)') : '', depthUnitName())}</p>
    <details id="extended-blend-method" class="forecast-context live-preserve-details"><summary>${t('How snowfall is blended')}</summary><p>${snowBlendMethod()}</p></details>
    ${forecastStatus(data)}
  </article>`;
}

function hourlyDepth(inches) {
  if (!finite(inches)) return '—';
  const value = convertWeather(inches, 'in');
  return value > 0 && value < 0.01 ? '&lt;0.01' : value.toFixed(2);
}

export function hourlySnowCard(data, state) {
  const forecast = hourlySnowForecast(data, state.now);
  const page = [0, 1, 2].includes(state.hourlyPage) ? state.hourlyPage : 0;
  const hours = forecast.hours.slice(page * 12, (page + 1) * 12);
  const resort = resortFor(data);
  const point = t('{0}, {1} ft', t(resort.pointLabel), resort.elevationFt.toLocaleString(displayLanguage));
  const unit = weatherUnit('in');
  const hourName = (time, zone) => formatTime(time, { minute: undefined, timeZoneName: zone }).replace(/AM|PM/g, s => s.toLowerCase());
  function hourLabel(time) {
    const name = hourName(time);
    // Across the fall clock change, both copies of 1 am need a zone even on adjacent pages.
    return name === hourName(time - HOUR) || name === hourName(time + HOUR) ? hourName(time, 'short') : name;
  }
  const windows = [0, 1, 2].map(index => {
    const from = forecast.hours[index * 12].start, to = from + 12 * HOUR;
    return `<button type="button" id="hourly-window-${index}" data-hourly-page="${index}" aria-pressed="${index === page}" aria-controls="hourly-table-scroll" aria-label="${escape(timestamp(from))} – ${escape(timestamp(to))}"><strong>${formatDate(from)}</strong><span>${hourLabel(from)} – ${hourLabel(to)}</span></button>`;
  }).join('');
  const headings = hours.map((hour, i) => {
    const midnight = i > 0 && localParts(hour.start).hour === 0;
    return `<th scope="col" title="${escape(timestamp(hour.start))}">${hourLabel(hour.start)}${midnight ? `<small>${formatDate(hour.start, { month: undefined, day: undefined })}</small>` : ''}</th>`;
  }).join('');
  function row(label, note, cell, className = '') {
    return `<tr class="${className}"><th scope="row">${label}${note ? `<small>${note}</small>` : ''}</th>${hours.map(hour => `<td>${cell(hour)}</td>`).join('')}</tr>`;
  }
  const maxSnow = Math.max(0, ...forecast.hours.map(hour => hour.snowIn ?? 0));
  const bars = row(t('New snow'), unit, hour => {
    const height = maxSnow && hour.snowIn > 0 ? hour.snowIn / maxSnow * 100 : 0;
    return `<div class="hourly-bar-track" data-phase="${hour.phase}"><div class="hourly-bar" style="height:${height}%"><span>${hourlyDepth(hour.snowIn)}</span></div></div>`;
  }, 'hourly-bars');
  const type = { rain: t('Rain'), wet: t('Wet snow'), snow: t('Snow'), none: t('None'), unknown: t('Unknown') };
  const weekday = formatDate(forecast.start, { month: undefined, day: undefined });
  const since = t('since {0} · {1}', `${weekday} ${hourLabel(forecast.start)}`, unit);
  const covered = forecast.hours.filter(hour => finite(hour.snowIn)).length;
  return `<article class="hourly-snow" aria-labelledby="hourly-heading">
    <header class="hourly-heading"><div><h2 id="hourly-heading">${t('Hourly snow accumulation')}</h2>
      <p>${escape(t(resort.name))} · ${escape(point)}</p></div>
      <div class="hourly-total"><strong>${hourlyDepth(forecast.totalIn)}${finite(forecast.totalIn) ? ` <small>${unit}</small>` : ''}</strong><span>${t('36-hour snow total')}</span></div>
    </header>
    <div class="hourly-nav" role="group" aria-label="${t('Next 36 hours in 12-hour windows')}">${windows}</div>
    <div class="hourly-scroll" id="hourly-table-scroll" data-live-scroll="hourly-${hours[0].start}" role="region" tabindex="0" aria-label="${t('Hourly forecast table, scroll for later hours')}">
      <table><caption class="cloud-sr-only">${t('Snowfall for each hour starting at the time shown, Pacific time')}</caption>
        <colgroup><col class="hourly-label-column"><col span="12"></colgroup>
        <thead><tr><th scope="col">${t('Hour (PT)')}</th>${headings}</tr></thead>
        <tbody>${bars}
          ${row(t('Precip. type'), '', hour => `<span class="hourly-type" data-phase="${hour.phase}">${type[hour.phase]}</span>`)}
          ${row(t('Snow total'), since, hour => hourlyDepth(hour.totalIn), 'hourly-running')}
          ${row(t('Freezing level'), t('ft above sea level'), hour => finite(hour.freezingLevelFt) ? (Math.round(hour.freezingLevelFt / 100) * 100).toLocaleString(displayLanguage) : '—')}
        </tbody></table>
    </div>
    <footer>${forecastStatus(data)}
      ${covered < forecast.hours.length ? `<p>${t('Snowfall covers {0} of 36 hours. The total needs all 36.', covered)}</p>` : ''}
      <details id="hourly-type-guide" class="live-preserve-details"><summary>${t('How types are estimated')}</summary>
        <p>${t('With snowfall, a freezing level at or above the forecast point indicates wet snow. A lower freezing level indicates snow. Rain requires zero forecast snow and warm precipitation in at least three models and a majority of reporting models.')}</p>
      </details>
    </footer>
  </article>`;
}

export function morningConditions(data) {
  const config = MORNING_RESORTS[resortFor(data).id];
  const observation = data.morning?.station;
  const station = observation?.stid === config.station.stid ? observation : config.station;
  const road = data.morning?.road;
  const source = id => data.sources?.find(item => item.id === id);
  const reading = (item, unit, { format = value => amount(convertWeather(value, unit)), unavailable = t('No recent reading') } = {}) => {
    if (!item || !finite(item.value)) return `<strong>${t('Unavailable')}</strong><small>${escape(unavailable)}</small>`;
    const status = item.state === 'fresh' ? t('Observed') : t('Stale reading');
    return `<strong>${escape(format(item.value))}<span> ${weatherUnit(unit)}</span></strong><small>${status} · ${escape(timestamp(item.observedAt))}</small>`;
  };
  const overdue = road && !['fresh', 'cached'].includes(sourceState(data, 'wsdot')) ? t('Saved report · update overdue · ') : '';
  const reportAge = !road ? t('Report unavailable') : overdue + (road.reportState === 'fresh' ? t('Reported {0}', timestamp(road.issuedAt)) : road.reportState === 'stale' ? t('Stale report · {0}', timestamp(road.issuedAt)) : t('Report time unavailable'));
  const roadDetails = road ? `${road.condition ? `<p lang="en">${escape(road.condition)}</p>` : ''}${road.weather ? `<p><b>${t('Weather:')}</b> <span lang="en">${escape(road.weather)}</span></p>` : ''}${(road.directions || []).map(item => `<p><b>${escape(t(item.direction))}:</b> <span lang="en">${escape(item.message)}</span></p>`).join('')}` : `<p>${t('No corridor report is available.')}</p>`;
  const fetchedAt = source('wsdot')?.fetchedAt;
  return `<article class="mountain-panel mountain-conditions" aria-labelledby="morning-heading"><div class="mountain-panel-heading"><div><p class="mountain-eyebrow">${t('BEFORE YOU GO')}</p><h2 id="morning-heading">${t('Mountain &amp; road conditions')}</h2></div><span class="mountain-heading-tag">${t('Observations')}</span></div><div class="mountain-condition-grid"><section class="mountain-observation"><div class="mountain-condition-title"><span class="mountain-condition-icon" aria-hidden="true">✳</span><div><h3>${t('Nearby station · {0}', escape(station.name))}</h3><p>${t('NWAC · {0} ft', station.elevationFt.toLocaleString('en-US'))}</p></div></div><div class="mountain-readings">
      <div class="mountain-reading-snowfall"><span>${t('Past 24h snow accumulation')}</span>${reading(station.snowfall24h, 'in', { format: depthNumber, unavailable: t('No snow-board reading') })}</div>
      <div><span>${t('Snow depth')}</span>${reading(station.depth, 'in')}</div>
      <div><span>${t('Air temperature')}</span>${reading(station.temperature, '°F')}</div>
    </div>
    <p class="mountain-footnote">${t('NWAC’s 24-hour board measures snow since the board was last cleared. Snow depth is the total snow on the ground at this station.')}</p><a id="nwac-station-link" class="mountain-source-link" href="${escape(stationUrl(config.station))}" target="_blank" rel="noreferrer">${t('View NWAC station ↗')}</a></section><section class="mountain-road"><div class="mountain-condition-title"><span class="mountain-condition-icon mountain-road-icon" aria-hidden="true">↗</span><div><h3>${t('Drive · {0}', escape(config.road.passName))}</h3><p class="mountain-road-age">${escape(reportAge)}${finite(fetchedAt) ? t(' · retrieved {0}', escape(timestamp(fetchedAt))) : ''}</p></div></div><div class="mountain-road-details">${road && displayLanguage === 'zh-CN' ? `<p class="mountain-footnote">${t('English road report')}</p>` : ''}${roadDetails}</div><p class="mountain-footnote">${t('WSDOT corridor report; it may not cover the entire route or resort access.')}</p><a id="wsdot-road-link" class="mountain-source-link" href="${escape(config.road.url)}" target="_blank" rel="noreferrer">${t('Check WSDOT report ↗')}</a></section></div></article>`;
}

const forecastIcon = name => `<span class="tomorrow-icon tomorrow-icon-${name}" aria-hidden="true"></span>`;

function mountainHeading(data) {
  return `<header class="tomorrow-heading club-landscape"><div>
    <h1 id="night-headline">${escape(data.resort?.name || 'Stevens Pass')}</h1>
    <p>${t('{0} · Washington Cascades', pointCaption(data))}</p>
  </div></header>`;
}

function forecastNavigation(active = 1) {
  return `<nav class="tomorrow-horizons" aria-label="${t('Forecast horizon')}">${[[1,t('1 night'),'home'],[3,t('3 nights'),'three'],[5,t('5 nights'),'outlook']].map(([days,label,id]) => `<button id="tomorrow-${id}" ${days === 1 ? 'data-tomorrow-home' : `data-tomorrow-horizon="${days}"`} ${active === days ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav>`;
}

function qualityGuide(id) {
  return `<details id="${id}" class="horizon-quality-guide live-preserve-details"><summary id="${id}-button"><span>${t('Snow quality')}</span>${forecastIcon('chevron')}</summary><ul class="horizon-quality-key" aria-label="${t('Personal snow quality colors')}">${[['poor',t('Poor')],['good',t('Good')],['excellent',t('Excellent')],['rain',t('Rain')],['wet',t('Wet')]].map(([key,label]) => `<li data-snow-quality="${key}">${label}</li>`).join('')}</ul><p>${t('Your new-snow preferences, not measured surface conditions. See Details for the rules.')}</p></details>`;
}

function compactAgreement(n) {
  const word = { high: t('agree'), moderate: t('vary'), low: t('split') }[n.agreement.key];
  return `<p class="forecast-agreement" data-model-agreement="${n.agreement.key || 'unknown'}" aria-label="${t('{0} snowfall agreement, {1} models', escape(n.agreement.label), n.snow.count)}">${word ? `<span>${modelCountLabel(n.snow.count)}</span> <strong>${word}</strong>` : `<strong>${escape(n.agreement.label)}</strong>`}</p>`;
}

export function horizon(data, state) {
  const { nights, maximum } = horizonForecast(data, state.now, state.horizon);
  const first = nights[0], last = nights.at(-1);
  const selected = nights.find(n => n.nightDate === state.nightChoice) || first;
  const selectedState = { ...state, nightChoice: selected.nightDate };
  const date = value => formatDate(value, { weekday: undefined });
  const sameMonth = localParts(first.end).month === localParts(last.end).month;
  const span = `${date(first.end)}–${sameMonth ? (displayLanguage === 'zh-CN' ? localParts(last.end).day + '日' : localParts(last.end).day) : date(last.end)}`;
  const pending = first.phase === 'remaining';
  const notice = first.forecastState === 'stale' ? t('Saved forecast · update overdue')
    : first.forecastState === 'unavailable' ? t('Forecast unavailable')
    : first.phase === 'ending' ? t('{0}: final hour in progress · remaining amount unconfirmed', formatDate(first.end, { month: undefined, day: undefined }))
    : pending ? t('{0}: remaining hours only · already fallen unconfirmed', formatDate(first.end, { month: undefined, day: undefined })) : '';
  const columnId = n => `morning-${n.nightDate}`;
  return `<article class="cloud-tomorrow cloud-horizon" id="live-overnight" aria-labelledby="night-headline" data-horizon="${state.horizon}" data-first-phase="${first.phase}" data-forecast-state="${first.forecastState}">
  ${mountainHeading(data)}${forecastNavigation(state.horizon)}
  ${notice ? `<p class="tomorrow-notice" role="status">${escape(notice)}</p>` : ''}
  <div class="forecast-section-heading"><h2 id="horizon-snow-label">${t('Snow Summary')}</h2><p>${t('{0} · overnight {1}', span, depthUnitName())}</p></div>
  <section class="horizon-comparison forecast-summary-card" aria-labelledby="horizon-snow-label"><div class="horizon-summary-layout">
  <aside class="forecast-feature" data-snow-quality="${selected.quality.key || 'unknown'}" aria-label="${t('Selected morning forecast')}"><h3>${selected.phase === 'remaining' ? t('Left to fall') : t('By 6 am')}</h3><strong class="forecast-feature-amount">${escape(selected.estimate.value)}</strong><p>${formatDate(selected.end)}</p><span class="forecast-feature-condition">${selected.quality.key === 'rain' ? t('Rain') : escape(selected.condition.label)}</span></aside>
  <div class="forecast-timeline"><p class="horizon-window">${state.horizon === 3 ? t('Next 3 mornings') : t('Next 5 mornings')} <span>${t('6 pm–6 am PT')}</span></p>
  <p class="horizon-select-hint">${t('Select a morning for details.')}</p>
  <div class="horizon-board-scroll" data-live-scroll="horizon" tabindex="0" role="region" aria-label="${t('Compare mornings, scroll horizontally if needed')}" style="--horizon-columns:${state.horizon}"><table class="horizon-board"><caption class="cloud-sr-only">${t('Snowfall for each morning, model agreement and estimated condition. Select a date for its evidence. All amounts use the preceding night, not daytime or cumulative totals.')}</caption>
  <tbody><tr class="horizon-snow-row">${nights.map(n => `<td headers="${columnId(n)}" data-night="${n.nightDate}" data-snow-quality="${n.quality.key || 'unknown'}"><div class="horizon-bar-track" style="--horizon-bar-height:${(n.estimate.blendedIn ?? 0) / maximum * 100}%"><p class="horizon-amount ${n.estimate.value.length > 1 ? 'horizon-amount-wide' : ''}" data-snowfall-value="${escape(n.estimate.value)}" aria-label="${n.estimate.approximate ? t('Approximately ') : ''}${escape(n.estimate.value)}${n.estimate.blendedIn !== null ? ' ' + depthUnitName(n.estimate.value) : t(', snowfall unavailable')}${n.phase === 'remaining' ? t(', remaining') : ''}"><strong>${escape(n.estimate.value)}</strong></p><div class="horizon-bar" aria-hidden="true"></div></div></td>`).join('')}</tr>
  <tr class="horizon-dates-row">${nights.map(n => `<th id="${columnId(n)}" scope="col"><button id="horizon-date-${n.nightDate}" data-horizon-night="${n.nightDate}" data-weekend="${isPacificWeekend(n.end)}" aria-controls="horizon-details" aria-label="${t('Details for {0}', formatDate(n.end))}" ${n.nightDate === selected.nightDate ? 'aria-pressed="true"' : 'aria-pressed="false"'}><strong>${formatDate(n.end, { month: undefined, day: undefined })}</strong><span>${localParts(n.end).day}</span></button></th>`).join('')}</tr>
  ${nights.some(n => ['remaining','ending'].includes(n.phase)) ? `<tr class="horizon-phase-row">${nights.map(n => `<td headers="${columnId(n)}">${n.phase === 'remaining' ? `<p class="horizon-phase">${t('Left to fall')}</p>` : n.phase === 'ending' ? `<p class="horizon-phase">${t('Final hour')}</p>` : ''}</td>`).join('')}</tr>` : ''}
  <tr class="horizon-inline-condition">${nights.map(n => {
    const rain = n.quality.key === 'rain';
    const label = rain ? t('Rain') : n.condition.label === t('Unavailable') ? t('No data') : n.condition.label;
    return `<td headers="${columnId(n)}" data-snow-quality="${n.quality.key || 'unknown'}"><p class="horizon-condition" data-morning-condition="${rain ? 'rain' : n.condition.key || 'unknown'}" aria-label="${t('Estimated morning condition: {0}. Personal snow rating: {1}', label, n.quality.label)}">${rain || n.condition.key ? forecastIcon(rain || n.condition.key === 'wet' ? 'drop' : 'snow') : ''}<strong>${label}</strong></p>${n.condition.transition ? `<small class="horizon-transition">${escape(n.condition.transition)}</small>` : ''}${!n.quality.key && n.condition.key ? `<small class="horizon-quality-unknown">${t('No rating')}</small>` : ''}</td>`;
  }).join('')}</tr>
  <tr class="horizon-inline-agreement">${nights.map(n => {
    const word = { high: t('agree'), moderate: t('vary'), low: t('split') }[n.agreement.key];
    const label = n.agreement.label === t('Unavailable') ? t('No data') : n.agreement.key === 'moderate' ? t('Medium') : n.agreement.label;
    const compactLabel = label === t('Outdated') ? t('Stale') : label;
    return `<td headers="${columnId(n)}"><p class="horizon-agreement" data-model-agreement="${n.agreement.key || 'unknown'}" title="${t('{0} snowfall agreement · {1} models', label, n.snow.count)}" aria-label="${t('{0} snowfall agreement, {1} models', label, n.snow.count)}"><span>${modelCountLabel(n.snow.count)}</span> <strong>${word || compactLabel}</strong></p></td>`;
  }).join('')}</tr>
  </tbody></table></div>${selected.forecastState === 'current' && selected.snow.count >= 2 ? `<p class="horizon-selected-evidence">${t('{0} · Model range: {1}', formatDate(selected.end), escape(snowRange(selected.snow)))}</p>` : ''}${selected.source?.fetchedAt ? `<p class="horizon-selected-evidence">${t('{0} collected {1}', selected.forecastState === 'stale' ? t('Saved forecast') : t('Forecast'), timestamp(selected.source.fetchedAt))}</p>` : ''}</div></div>${qualityGuide('horizon-quality-guide')}</section>
  <details id="horizon-details" class="tomorrow-details live-preserve-details"><summary id="horizon-details-button">${forecastIcon('list')}<span>${t('Details')}</span>${forecastIcon('chevron')}</summary><div class="tomorrow-details-body">
  <div class="horizon-date-picker"><label for="horizon-detail-date">${t('Morning')}</label><select id="horizon-detail-date" data-horizon-detail-date>${nights.map(n => `<option value="${n.nightDate}" ${n.nightDate === selected.nightDate ? 'selected' : ''}>${formatDate(n.end)}</option>`).join('')}</select></div>
  ${horizonEvidence(data, selectedState, selected)}${forecastGuide(data, selectedState, selected)}
  </div></details></article>`;
}

function horizonEvidence(data, state, night) {
  const time = value => formatTime(value, { minute: undefined }).toLowerCase();
  const remaining = night.phase === 'remaining', ending = night.phase === 'ending';
  return `<section class="horizon-evidence" aria-label="${t('Selected night evidence')}"><h2>${formatDate(night.end)}</h2><p>${ending ? t('Final hour in progress · remaining amount unconfirmed') : t('{0} {1} → {2} {3} PT{4}', formatDate(night.start), time(night.start), formatDate(night.end), time(night.end), remaining ? t(' · remaining hours') : '')}</p>
  ${ending ? '' : `<p>${escape(night.coverageText)}. ${remaining ? t('Already-fallen snow is unconfirmed.') : t('Overnight snowfall only.')}</p>`}
  ${ending ? `<p>${t('Forecasts cover full hours; they cannot resolve the current partial hour.')}</p>` : `<div class="live-table-scroll horizon-model-evidence-scroll" tabindex="0" aria-label="${t('Selected night model evidence, scroll horizontally')}"><table class="cloud-night-models"><caption>${t('Snowfall by model{0}', night.forecastState === 'stale' ? t(' · saved forecast') : '')}</caption><thead><tr><th scope="col">${t('Model')}</th><th scope="col">${t('Snowfall')}</th><th scope="col">${t('Hours')}</th></tr></thead><tbody>${night.rows.map(row => `<tr><th scope="row">${escape(row.label)}</th><td>${row.complete && night.forecastState !== 'unavailable' ? t('{0} {1}', escape(snowAmount(row.total)), weatherUnit('in')) : '—'}</td><td>${row.covered}/${row.expected}</td></tr>`).join('')}</tbody></table></div>`}
  <p>${t('{0}Collected {1}.', night.snow.count < night.expectedModels ? t('Individual model totals require coverage of every hour. ') : '', timestamp(night.source?.fetchedAt))}</p>
  <p><strong>${t('Snowfall agreement: {0}', night.agreement.key === 'moderate' ? t('Medium') : escape(night.agreement.label))}</strong> ${t('· {0} models', night.snow.count)}</p>
  <p><strong>${t('Personal snow rating: {0}', escape(night.quality.label))}</strong>${night.quality.key === 'rain' ? t(' · {0} models forecast at least {1} of liquid precipitation, no snow and above-freezing temperatures during precipitation.', night.quality.rainModels, depthThreshold(0.01)) : ''}</p>
  <p><strong>${t('Estimated condition: {0}', escape(night.condition.label))}</strong>${night.condition.transition ? ` · ${escape(night.condition.transition)}` : ''}<br>${t('NWS snow level: {0}. {1}.', escape(night.level.value), escape(night.level.note))}</p>
  <a class="horizon-detail-link" data-forecast-detail href="${resortPath(data)}?night=${night.nightDate}&days=${state.horizon}#live-daily">${t('Daytime, wind & full model comparison {0}', forecastIcon('chevron'))}</a></section>`;
}

function forecastGuide(data, state, night) {
  const level = night.condition.history || night.level;
  const levelStart = night.condition.history ? night.nightStart : night.start;
  const bands = snowLevelBands(data.resort);
  const dry = bands.dry.toLocaleString('en-US'), wet = bands.wet.toLocaleString('en-US');
  const conditionRule = night.opening
    ? t('Opening snow quality uses the last forecast interval before {0}. Snow levels at {1} indicate dry snow at or below {2} ft, wet snow at or above {3} ft, and normal snow in between.', formatTime(night.end), pointCaption(data), dry, wet)
    : t('personal snow-level bands for {0} at {1}. Dry: at/below {2} ft; Normal: above {3} and below {4} ft; Wet: at/above {5} ft. The bands use the same elevation gaps as your original rule: 2,800 ft and 800 ft below the forecast point, rounded to 100 ft. The selected state describes the last forecast interval before 6 am, with earlier changes retained. These are snow-level-based estimates, not measured snow density or the condition of the entire ski surface. Temperature and snow-to-liquid ratio can change actual snow texture.', escape(resortFor(data).name), pointCaption(data), dry, dry, wet, wet);
  const timingRule = night.opening
    ? t('The {0} target applies to the full evening-to-opening window. The forecast uses a proportional estimate for the time left in the current hour.', overnightTarget())
    : t('The {0} target applies to the full 6 pm–6 am night. During the night, only full future forecast hours are included; the hour in progress is excluded. Already-fallen snow is unconfirmed.', overnightTarget());
  return `<details id="tomorrow-method" class="live-data-details live-preserve-details cloud-night-details"><summary id="tomorrow-method-button">${t('How to read this forecast')}</summary>
  <p>${t('{0} We add up the hourly forecasts and round the final total up to a whole {1}.', snowBlendMethod(), depthUnitName(1))}</p>
  <p><strong>${t('Model agreement:')}</strong> ${t('High means the highest-to-lowest spread is at most 40% of the median; {0} is at most 100%; Low is wider. Identical zero totals are High. Fewer than three complete models cannot support a tier. This describes model spread, not the probability of snow or forecast accuracy.', state.horizon ? t('Medium') : t('Moderate'))}</p>
  <p><strong>${t('Estimated condition:')}</strong> ${conditionRule}</p>
  ${state.horizon || state.qualityGuide ? `<p><strong>${t('Your quality colors:')}</strong> ${t('Orange: at least {0} with a Dry morning and complete guidance showing no earlier Wet interval. Blue: at least {1} with Dry/Normal snow. Gray: less than {1} or no new snow. Purple: Wet snow at any amount. Green: a majority of available models and at least three complete forecasts show warm liquid precipitation, with no model predicting snow. Gray also indicates missing or stale guidance. Ratings reflect personal new-snow preferences and use unrounded thresholds.', depthThreshold(5), depthThreshold(1))}</p><p><strong>${t('Compact agreement:')}</strong> ${t('agree = High; vary = Medium; split = Low. These labels describe snowfall totals, including zero-snow forecasts, not agreement about rain.')}</p>` : ''}
  <p>${t('The overnight blend uses all available models. The Daily Forecast filter applies to that table’s blend.')}</p>
  <p>${timingRule}</p>
  <p>${t('A model range is not a probability. Snow level alone does not establish dry powder or current base conditions.')}</p>
  <p>${t('Target counts use unrounded totals from models that cover the entire night. Missing models are excluded and their coverage is shown separately. Counts are not probabilities. A {0} proximity cue flags estimates near your target; it is not a measured forecast error or confidence score.', depthThreshold(0.5, true))}</p>
  <p>${t('The main uncertainty considers data gaps, forecast precipitation overlapping the NWS {0} ft snow-level reference, model disagreement, proximity to the target, and timing. NWS snow level does not change the model snowfall amounts.', wet)}</p>
  <p>${t('NWS snow level checked {0}. Its forecast is separate from model snowfall.', timestamp(data.sources?.find(s => s.id === 'nws')?.fetchedAt))}</p>
  ${night.phase !== 'morning' && level.state !== 'unavailable' && level.intervals.length ? `<p>${t('NWS intervals available for {0}{1}{2}:', night.condition.history ? t('the full night') : t('this window'), level.coverage === 'partial' ? t(' · partial coverage') : '', level.state === 'stale' ? t(' · saved forecast') : '')}</p><ul class="cloud-source-periods">${level.intervals.map(p => `<li>${timestamp(Math.max(levelStart, p.start))} → ${timestamp(Math.min(night.end, p.end))}: <strong>${t('{0} ft', Math.round(p.feet / 100) * 100)}</strong></li>`).join('')}</ul>` : ''}
  <p>${t('Model snowfall is forecast at the requested elevation. Nearby NWAC stations report measured snowfall.')}</p>
  <button id="summary-refresh" data-live-refresh class="cloud-secondary" ${state.loading ? 'disabled' : ''}>${state.loading ? t('Checking…') : t('Check for updates')}</button>
  <p>${t('Checks the shared forecast cache. Collection time is not model initialization time.')}</p>
  </details>`;
}

function levelForPeriod(data, period) {
  const level = summarizeSnowLevel(data.snowLevels || [], period.start, period.end);
  if (sourceState(data, 'nws') === 'unavailable' || !finite(level.min)) return { value: t('Unavailable'), note: t('No NWS coverage') };
  const roundedMin = Math.round(level.min / 100) * 100, roundedMax = Math.round(level.max / 100) * 100;
  const min = roundedMin.toLocaleString('en-US'), max = roundedMax.toLocaleString('en-US');
  const value = t('{0}{1} ft', min, min === max ? '' : '–' + max);
  const point = resortFor(data).elevationFt;
  const relation = roundedMax < point ? t('Below point') : roundedMin > point ? t('Above point')
    : level.min < point && level.max > point ? t('Crosses point') : t('Near point');
  const saved = sourceUsable(data, 'nws') ? '' : t(' · saved NWS forecast');
  return { value: level.complete ? relation : t('Partial coverage'), note: `${value}${level.complete ? '' : t(' in available hours · {0}', relation)}${saved}` };
}

function periodLabel(p) {
  return `${formatDate(p.originalStart)} · ${t(p.kind)}`;
}

export function daily(data, state) {
  const models = selectedModels(data, state), periods = forecastPeriods(state.start, state.end);
  const blend = createSnowfallBlend(data, state.now, models);
  const rows = periods.map(p => {
    const snow = forecastRange(models, p.start, p.end);
    return { ...p, date: formatDate(p.originalStart), snow, blendedIn: blend(p.start, p.end), liquid: forecastRange(models, p.start, p.end, 'precipIn') };
  });
  const maximum = Math.max(1, ...rows.map(p => p.blendedIn ?? 0));
  const dates = [...new Set(rows.map(p => p.date))];
  const weatherValue = (p, field, unit = '') => rangeText(periodRange(models, p.start, p.end, field), unit, 0, false);
  const desktop = `<table class="live-table live-daily"><caption class="cloud-sr-only">${t('Day and night forecasts at {0}, Pacific time', escape(resortFor(data).name))}</caption><thead><tr><th scope="col">${t('Date')}</th><th scope="col">${t('Period')}</th><th scope="col" class="live-daily-snow-heading">${t('Snowfall')}<br>${t('blend · {0}', weatherUnit('in'))}</th><th scope="col" class="live-daily-level-heading">${t('Snow level')}<br>${t('vs {0} ft · NWS', resortFor(data).elevationFt.toLocaleString('en-US'))}</th><th scope="col">${t('Temp')}<br>${weatherUnit('°F')}</th><th scope="col">${t('Liquid precip')}<br>${weatherUnit('in')}</th><th scope="col">${t('Wind')}<br>${t('mph')}</th><th scope="col">${t('Gust')}<br>${t('mph')}</th><th scope="col">${t('Cloud')}<br>%</th></tr></thead>${dates.map(date => `<tbody>${rows.filter(p => p.date === date).map((p, i, group) => {
    const level = levelForPeriod(data,p), elapsed = (p.end-p.start)/HOUR;
    const periodTime = `${formatTime(p.start, { minute: undefined })}–${formatTime(p.end, { minute: undefined })}`;
    const rangeLabel = p.snow.count ? t('Full-period model range {0}', snowRange(p.snow)) : t('No full-period model totals');
    const snowLabel = t('{0} · {1}/{2} models contributed · {3}', p.blendedIn === null ? t('Unavailable') : t('Blended snowfall {0}', t('{0} {1}', snowAmount(p.blendedIn), weatherUnit('in'))), p.snow.contributingCount, models.length, rangeLabel);
    const modelCount = p.snow.count < models.length ? t('{0}/{1} models cover period', p.snow.count, models.length) : modelCountLabel(p.snow.count);
    const snowDetail = p.snow.count > 1 ? t('Range: {0} · {1}', snowRange(p.snow, false), modelCount) : p.snow.contributingCount ? modelCount : t('No model data');
    return `<tr class="${p.kind === 'Night' ? 'live-night-row' : ''}">${i === 0 ? `<th class="live-daily-date" scope="rowgroup" rowspan="${group.length}">${formatDate(p.originalStart, { month: undefined, day: undefined })}<small>${formatDate(p.originalStart, { weekday: undefined })}</small></th>` : ''}<th class="live-daily-period" scope="row" title="${t('{0} · {1} Pacific', t(p.kind), periodTime)}"><span>${t(p.kind)}</span><small class="${p.partial || elapsed !== 12 ? '' : 'cloud-sr-only'}">${periodTime}</small>${p.partial || elapsed !== 12 ? `<small class="live-partial">${elapsed} ${t(elapsed===1?'hour':'hours')}${p.partial ? t(' · partial') : t(' · DST')}</small>` : ''}</th><td class="live-daily-snow" data-no-snow="${p.blendedIn === 0}" data-snow-available="${p.blendedIn !== null}" title="${escape(snowLabel)}"><div class="live-snow-cell"><span class="live-snow-track" aria-hidden="true"><span class="live-daily-snowbar" style="--snow-fraction:${p.blendedIn === null ? 0 : p.blendedIn / maximum}"></span></span><strong>${p.blendedIn === null ? `—<span class="cloud-sr-only">${t('Unavailable')}</span>` : escape(snowAmount(p.blendedIn))}</strong><small>${escape(snowDetail)}</small></div></td><td class="live-daily-level"><strong>${escape(level.value)}</strong><small>${escape(level.note)}</small></td><td class="live-daily-temperature">${weatherValue(p,'temperatureF','°F')}</td><td>${rangeText(p.liquid,'in',2,false)}</td><td>${weatherValue(p,'windMph','')}</td><td>${weatherValue(p,'gustMph','')}</td><td>${weatherValue(p,'cloudPct','')}</td></tr>`;
  }).join('')}</tbody>`).join('')}</table>`;
  return `${controls('daily',data,state)}${forecastStatus(data)}${sourceUsable(data,'nws') ? '' : snowLevelStatus(data)}${models.length ? '' : `<p class="live-empty">${t('No models selected. Choose models using the filter above; NWS snow level remains available.')}</p>`}<p class="forecast-table-hint">${t('Scroll horizontally to see all forecast fields.')}</p><div class="live-daily-desktop live-table-scroll" data-live-scroll="daily" tabindex="0" aria-label="${t('Full day and night forecast table, scroll horizontally')}">${desktop}</div><details id="daily-context" class="forecast-context live-preserve-details"><summary>${t('How to read this forecast')}</summary>${windowCaption(state, data)}<p class="live-caption">${t('Day 6 am–6 pm · Night 6 pm–6 am Pacific. Bars show blended snowfall from the selected models. Ranges compare individual models with full-period coverage.')}</p><p class="live-caption">${snowBlendMethod()}</p><p class="live-caption">${t('NWS snow level is compared with the {0} forecast point ({1} ft), not the resort base or observed snow conditions.', escape(t(resortFor(data).pointLabel)), resortFor(data).elevationFt.toLocaleString('en-US'))}</p><p class="live-caption">${t('Partial periods show only the labeled hours. Missing snowfall stays unavailable; it never becomes zero.')}</p>${sourceUsable(data,'nws') ? snowLevelStatus(data) : ''}</details>`;
}

export function snowTimeline(data, state) {
  const models = selectedModels(data, state);
  if (!models.length) return '';
  const blend = createSnowfallBlend(data, state.now, models);
  const periods = forecastPeriods(state.start, state.end).map(period => {
    const range = forecastRange(models, period.start, period.end);
    const blendedIn = blend(period.start, period.end);
    const hours = (period.end - period.start) / HOUR;
    const description = t('{0} {1}: {2} · {3} of {4} models{5}', formatDate(period.originalStart), t(period.kind.toLowerCase()), blendedIn === null ? t('Unavailable') : t('{0} {1}', snowAmount(blendedIn), weatherUnit('in')), range.contributingCount, models.length, hours !== 12 ? t(' · {0} hours', hours) : '');
    return { ...period, blendedIn, description };
  });
  const maximum = Math.max(1, ...periods.map(p => p.blendedIn ?? 0));
  return `<figure class="forecast-snow-timeline"><figcaption><strong>${t('Day / night snowfall')}</strong><span>${t('{0} · weighted blend', weatherUnit('in'))}</span></figcaption><ol aria-label="${t('Snowfall per day and night')}">${periods.map(p => `<li data-period-start="${p.start}" data-period-end="${p.end}" data-period-description="${escape(p.description)}" data-period-snow="${p.blendedIn ?? 'missing'}" style="flex-basis:${(p.end - p.start) / (state.end - state.start) * 100}%;--period-height:${(p.blendedIn ?? 0) / maximum * 100}%" title="${escape(p.description)}"><span class="forecast-period-bar ${p.blendedIn === null ? 'live-heat-missing' : ''}" aria-hidden="true"></span><span class="forecast-period-value" aria-hidden="true">${p.blendedIn === null ? '—' : escape(snowAmount(p.blendedIn))}</span><span class="cloud-sr-only">${escape(p.description)}</span></li>`).join('')}</ol><p id="live-pulse-value" class="live-caption"></p></figure>`;
}

export function comparison(data, state) {
  const models = selectedModels(data, state), nws = state.metric === 'level';
  const series = comparisonSeries(data, state.ids, state.metric, state.start, state.end);
  return `${nws ? `<div class="forecast-card-toolbar">${durationControl('range',state)}${metricControls(state)}</div><p class="live-comparison-selection"><strong>${t('{0}-day reference', state.days)}</strong><span>${t('NWS · independent of selected models')}</span></p>` : controls('range',data,state,true)}
    ${nws ? `<div class="live-nws-reference"><strong>${t('NWS snow level')}</strong><p>${t('One separate forecast. Model selection does not apply.')}</p>${snowLevelStatus(data)}</div>` : ''}<div class="forecast-chart-meta">${windowCaption(state, data)}${nws ? '' : forecastStatus(data)}</div>
    <div id="live-chart" class="live-chart"></div>${!nws && models.length ? `<ul class="forecast-chart-legend" aria-label="${t('Forecast model legend')}">${models.map(model => `<li>${lineKey(model)}<span>${escape(model.label)}</span></li>`).join('')}</ul>` : ''}${state.metric === 'snow' ? snowTimeline(data,state) : ''}<p class="live-caption">${t('Shaded hours: overnight · gaps: missing data')}</p>
    <div class="forecast-chart-tools"><details id="chart-inspection" class="forecast-context live-preserve-details"><summary id="chart-inspection-button">${t('Inspect values')}</summary><div class="live-inspection"><label for="live-inspect-time">${t('Inspect')} <strong id="live-inspect-label"></strong></label><input id="live-inspect-time" type="range" min="0" max="${state.days * 24}" value="${Math.min(state.index, state.days * 24)}" aria-label="${t('Inspect forecast time')}"><div id="live-inspect-values" class="live-inspect-values"></div></div></details>
    <details id="chart-reading-guide" class="forecast-context live-preserve-details"><summary>${t('How to read this forecast')}</summary><p class="live-chart-description">${t(METRICS[state.metric].note)}. ${nws ? t('Reference lines: {0} ft preference and {1} ft caution.', snowLevelBands(data.resort).dry.toLocaleString('en-US'), snowLevelBands(data.resort).wet.toLocaleString('en-US')) : t('Compare the line styles and model names below.')}</p><p class="live-caption">${t('Shading marks 6 pm–6 am. Gaps and early line endings mean no data. Tap the plot or open Inspect values to use the time slider.')}</p>${nws ? '' : `<div class="live-model-coverage">${models.map(m => {
      const values = series.lines.find(line => line.id === m.id)?.values || [];
      const offset = METRICS[state.metric].hours || 0, valid = values.slice(offset).filter(finite).length;
      const lastIndex = values.findLastIndex(finite), last = series.times[lastIndex];
      const status = !valid ? t('unavailable') : valid === values.length - offset ? t('full window') : last < state.end ? t('ends {0}', timestamp(last)) : t('incomplete window');
      return `<span>${lineKey(m)}<strong>${escape(m.label)}</strong> · ${status}</span>`;
    }).join('')}</div>`}<details id="chart-data-details" class="live-data-details live-preserve-details"><summary>${t('View chart data table')}</summary><div id="live-chart-table" class="live-table-scroll" tabindex="0" aria-label="${t('Forecast chart data, scroll horizontally')}"></div></details>${sources(data)}</details></div>`;
}

// Selection changes only the interval matrix, never the shared forecast window.
export function precipitationWindow(state) {
  const periods = forecastPeriods(state.start,state.end).map(p=>({...p,key:String(p.originalStart)}));
  if (state.precipPeriod === 'all') return { start:state.start,end:state.end,key:'all',periods };
  const period = periods.find(p=>p.key===state.precipPeriod) || periods.find(p=>p.kind==='Night') || periods[0];
  return { ...period, periods };
}

export function precipitation(data, state) {
  const models = selectedModels(data,state), hours = state.precipHours === 3 ? 3 : 6;
  const field = state.precipField === 'snowIn' ? 'snowIn' : 'precipIn', snow = field === 'snowIn';
  const levels = snow ? [0, 0.1, 0.5, 1, 3] : [0, 0.01, 0.05, 0.15, 0.4];
  const legend = ['0', t('trace'), ...levels.slice(1).map(value => depthNumber(value) + '+')];
  const totals = state.precipTotals === true, selected = precipitationWindow(state), bins = forecastBins(selected.start,selected.end,hours);
  const groups = [];
  for (const bin of bins) {
    const date = formatDate(bin.originalStart);
    if (groups.at(-1)?.date === date) groups.at(-1).count++;
    else groups.push({ date,label:formatDate(bin.originalStart),count:1 });
  }
  const periodIndex = selected.periods.findIndex(p=>p.key===selected.key);
  const modeControls = `<div class="live-precip-mode live-horizon" role="group" aria-label="${t('Precipitation view')}"><button id="precip-intervals" data-precip-mode="intervals" aria-pressed="${!totals}">${t('By interval')}</button><button id="precip-totals" data-precip-mode="totals" aria-pressed="${totals}">${t('Window totals')}</button></div>`;
  const intervalControls = totals ? '' : `<div class="live-precip-options"><div class="live-horizon" role="group" aria-label="${t('Precipitation amount')}"><button id="precip-liquid" data-precip-field="precipIn" aria-pressed="${!snow}">${t('Liquid precip')}</button><button id="precip-snow" data-precip-field="snowIn" aria-pressed="${snow}">${t('Snowfall')}</button></div><div class="live-horizon" role="group" aria-label="${t('Precipitation interval')}">${[3,6].map(h=>`<button id="precip-hours-${h}" data-precip-hours="${h}" aria-pressed="${hours===h}">${t('{0} hours', h)}</button>`).join('')}</div></div>`;
  const periodPicker = totals ? '' : `<details id="precip-focus" class="forecast-period-focus live-preserve-details"><summary>${t('Focus a day or night')}</summary><div class="live-period-picker"><label for="precip-period">${t('Compare a day or night')}<select id="precip-period" data-precip-period>${selected.periods.map(p=>`<option value="${p.key}" ${p.key===selected.key?'selected':''}>${escape(periodLabel(p))}${p.partial?t(' · partial'):''}</option>`).join('')}<option value="all" ${selected.key==='all'?'selected':''}>${t('Full {0}-day timeline', state.days)}</option></select></label><div class="live-period-arrows"><button id="precip-prev" data-precip-step="-1" aria-label="${t('Previous forecast period')}" ${periodIndex<=0?'disabled':''}><img src="/clone/icons/arrow-right.svg" alt="" width="20" height="20"></button><button id="precip-next" data-precip-step="1" aria-label="${t('Next forecast period')}" ${periodIndex<0 || periodIndex>=selected.periods.length-1?'disabled':''}><img src="/clone/icons/arrow-right.svg" alt="" width="20" height="20"></button></div></div></details>`;
  const modelHeading = m => `<th scope="row">${escape(m.label)}<small>${escape(t(m.description))}</small></th>`;
  const totalRows = models.map(m=>({m,snow:forecastRange([m],state.start,state.end),liquid:forecastRange([m],state.start,state.end,'precipIn')}));
  const totalTable = `<table class="live-table live-model-table"><caption class="cloud-sr-only">${t('Complete {0}-day forecast window totals', state.days)}</caption><thead><tr><th scope="col">${t('Latest forecast')}</th><th scope="col">${t('Snowfall')}<br>${t('{0}-day total', state.days)}</th><th scope="col">${t('Liquid precipitation')}<br>${t('{0}-day total', state.days)}</th><th scope="col">${t('Snow / liquid hours')}<br>${t('available')}</th></tr></thead><tbody>${totalRows.map(({m,snow,liquid})=>`<tr>${modelHeading(m)}<td data-model-total="${m.id}"><strong>${escape(snowRange(snow))}</strong>${!snow.count?`<small>${t('Incomplete window')}</small>`:''}</td><td><strong>${rangeText(liquid,'in',2)}</strong>${!liquid.count?`<small>${t('Incomplete window')}</small>`:''}</td><td>${snow.models[0].covered} / ${state.days*24}<br>${liquid.models[0].covered} / ${state.days*24}</td></tr>`).join('')}</tbody></table>`;
  const mobileTotals = `<div class="live-totals-mobile">${totalRows.map(({m,snow,liquid})=>`<article class="live-period-card"><header><h3>${lineKey(m)}${escape(m.label)}</h3><p>${escape(t(m.description))}</p></header><dl class="live-primary-facts"><div><dt>${t('Snowfall')}</dt><dd>${escape(snowRange(snow))}<small>${t('{0}/{1} hours{2}', snow.models[0].covered, state.days*24, snow.count?'':t(' · incomplete'))}</small></dd></div><div><dt>${t('Liquid precipitation')}</dt><dd>${liquid.count?rangeText(liquid,'in',2):t('Unavailable')}<small>${t('{0}/{1} hours{2}', liquid.models[0].covered, state.days*24, liquid.count?'':t(' · incomplete'))}</small></dd></div></dl></article>`).join('')}</div><!-- end mobile totals -->`;
  const grid = `<table class="live-table live-precip-grid ${selected.key==='all'?'live-full-timeline':'live-period-grid'} ${snow?'live-precip-snow':'live-precip-liquid'}"><caption class="cloud-sr-only">${t('{0} by selected model and interval, Pacific time', snow?t('Snowfall'):t('Liquid precipitation'))}</caption><thead><tr><th scope="col" rowspan="2">${t('Model')}</th>${groups.map(g=>`<th scope="colgroup" colspan="${g.count}">${g.label}</th>`).join('')}</tr><tr>${bins.map(b=>`<th scope="col" title="${timestamp(b.start)} → ${timestamp(b.end)}">${formatTime(b.start,{minute:undefined}).replace(' ','').toLowerCase()}<span>–${formatTime(b.end,{minute:undefined}).replace(' ','').toLowerCase()}${b.partial?'*':''}</span></th>`).join('')}</tr></thead><tbody>${models.map(m=>`<tr>${modelHeading(m)}${bins.map(b=>{
    const result=intervalTotal(m.points,b.start,b.end,field),value=result.total;
    const title=`${escape(m.label)} · ${timestamp(b.start)} → ${timestamp(b.end)}`;
    if (!result.complete) return `<td class="live-heat-missing" title="${t('{0} · {1}/{2} hours available', title, result.covered, result.expected)}" data-missing="true"><span aria-hidden="true">—</span><span class="cloud-sr-only">${t('Unavailable; {0}/{1} hours', result.covered, result.expected)}</span></td>`;
    const intensity = (value > 0 ? 1 : 0) + levels.slice(1).filter(level => value >= level).length;
    const displayed = convertWeather(value, 'in');
    const trace = displayed > 0 && displayed < 0.01;
    const text = snow ? snowAmount(value) : trace ? '<0.01' : displayed.toFixed(2);
    const withUnit = t('{0} {1}', snow || trace ? text : depthNumber(value), weatherUnit('in'));
    return `<td class="live-heat-${intensity}" title="${title} · ${escape(withUnit)}" data-amount="${value}">${escape(text)}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table>`;
  return `<div class="forecast-precip-toolbar">${comparisonControls(data,state,'precip')}${intervalControls}${modeControls}</div>${periodPicker}${forecastStatus(data)}${totals ? windowCaption(state, data) : `<p class="live-period-window"><strong>${selected.key==='all'?t('Full {0}-day timeline', state.days):escape(periodLabel(selected))}</strong> · ${timestamp(selected.start)} → ${timestamp(selected.end)}</p>`}
  <p class="live-caption">${totals?t('Totals cover the full selected forecast window.'):t('{0}, {1} per interval.{2}', snow?t('Snowfall depth'):t('Liquid equivalent of rain and snow'), depthUnitName(), selected.key==='all'?t(' Scroll the full timeline horizontally.'):'')}</p>
  ${models.length ? totals ? `${mobileTotals}<div class="live-totals-desktop live-table-scroll" data-live-scroll="precip-totals" tabindex="0" aria-label="${t('Full window precipitation totals')}">${totalTable}</div>` : `<div class="live-table-scroll" data-live-scroll="precip-${selected.key}-${hours}-${field}" tabindex="0" aria-label="${t('Precipitation by model and interval, Pacific time')}">${grid}</div>` : `<p class="live-empty">${t('No models selected. Choose models using the filter above.')}</p>`}
  ${totals?'':`<div class="live-heat-legend ${snow?'live-precip-snow':'live-precip-liquid'}"><span>${weatherUnit('in')}</span>${legend.map((label, index) => `<span class="live-heat-${index}">${label}</span>`).join('')}<span class="live-heat-missing">${t('— Unavailable')}</span></div>`}
  <p class="live-caption">${t('{0}Missing hours stay unavailable; short-range models end at their available horizon. Liquid precipitation includes rain and snow.', totals?'':t('* Partial edge interval. Periods use the Pacific clock, including daylight-saving changes. '))}</p>`;
}

function snowfallWindow(start, end) {
  const date = formatDate(end);
  return formatDate(start) === date
    ? t('{0}–{1} · {2} PT', formatTime(start), formatTime(end), date)
    : t('{0} → {1}', timestamp(start), timestamp(end));
}

function resortSnowfallMetric(title, value, period, status) {
  return `<div class="resort-snowfall-metric">
    <h3>${title}</h3>
    ${value === null ? `<p class="resort-snowfall-status">${status}</p>`
      : `<p class="resort-snowfall-value"><strong>${escape(value)}</strong> <span>${weatherUnit('in')}</span></p>`}
    ${period ? `<p class="resort-snowfall-period">${escape(period)}</p>` : ''}
    ${value !== null && status ? `<p class="resort-snowfall-status">${status}</p>` : ''}
  </div>`;
}

function resortSnowfallCard(data, state) {
  const { now } = state;
  const { daytime, remaining, opening } = resortSnowfallForecast(data, now);
  const station = MORNING_RESORTS[resortFor(data).id].station;
  const reported = data.morning?.station;
  const reading = reported?.stid === station.stid ? reported.snowfall24h : null;
  const observed = reading?.state === 'fresh' && finite(reading.value) && reading.value >= 0 &&
    finite(reading.observedAt) && reading.observedAt <= now;
  const report = resortSnowfallMetric(t('Already accumulated'), observed ? depthNumber(reading.value) : null,
    observed ? t('Past 24h report · as of {0}', timestamp(reading.observedAt)) : '',
    observed ? '' : t('No recent snowfall report'));
  const { blendedIn } = remaining.estimate;
  const { min, max, count } = remaining.snow;
  const showRange = count >= 2 && blendedIn >= min && blendedIn <= max;
  const forecastAmount = blendedIn === null ? null : showRange ? snowRange(remaining.snow, false) : snowAmount(blendedIn);
  const forecastStatus = blendedIn === null ? t('Forecast unavailable')
    : remaining.forecastState === 'stale' ? t('Saved forecast · update overdue') : '';
  const forecast = resortSnowfallMetric(t('Still expected to fall'), forecastAmount,
    snowfallWindow(remaining.start, remaining.end), forecastStatus);
  const observationSource = observed ? `<p class="live-caption">${t('NWAC · {0}', escape(station.name))} · ${escape(timestamp(reading.observedAt))}. ${t('NWAC’s 24-hour board measures snow since the board was last cleared.')}</p>` : '';
  return `<article class="cloud-tomorrow" id="live-overnight" aria-labelledby="night-headline">
    ${mountainHeading(data)}
    <div class="forecast-section-heading"><h2 id="tomorrow-snow-label">${t('Today')}</h2><p>${formatDate(now)}</p></div>
    <section class="forecast-summary-card resort-snowfall-card" aria-labelledby="tomorrow-snow-label">
      ${daytime ? report + forecast : forecast + report}
    </section>
    <details id="tomorrow-details" class="tomorrow-details live-preserve-details"><summary id="tomorrow-details-button">${forecastIcon('list')}<span>${t('Details')}</span>${forecastIcon('chevron')}</summary><div class="tomorrow-details-body">
      ${observationSource}${overnightEvidence(data, opening)}${forecastGuide(data, { ...state, horizon: null, qualityGuide: true }, opening)}
    </div></details>
    ${qualityGuide('tomorrow-quality-guide')}
  </article>`;
}

export function outlook(data, state) {
  if (state.page === 'stevens') return resortSnowfallCard(data, state);
  const n = tomorrowForecast(data, state.now, state.nightChoice);
  const morning = n.phase === 'morning', remaining = n.phase === 'remaining', ending = n.phase === 'ending';
  const dateKey = time => { const p = localParts(time); return `${p.year}-${p.month}-${p.day}`; };
  const day = morning ? t('Last night') : dateKey(n.end) === dateKey(state.now) ? t('This morning')
    : dateKey(n.end) === dateKey(state.now + 24 * HOUR) ? t('Tomorrow') : t('Overnight');
  const displayDate = `${day} · ${formatDate(n.end)}`;
  const numeric = n.estimate.blendedIn !== null;
  const time = value => formatTime(value, { minute: undefined }).toLowerCase();
  const window = morning ? t('6 pm–6 am PT · ended') : ending ? t('Final hour in progress')
    : remaining ? t('{0}–6 am PT · remaining', time(n.start)) : t('{0} · 6 pm–6 am PT', dateKey(n.nightStart) === dateKey(state.now) ? t('Tonight') : formatDate(n.nightStart));
  const notice = n.forecastState === 'stale' ? t('Saved forecast · update overdue')
    : n.forecastState === 'unavailable' ? t('Forecast unavailable')
    : remaining ? t('Already fallen: unconfirmed') : ending ? t('Remaining amount unconfirmed')
    : !morning && n.coverage !== 'full' ? t('{0} of {1} models cover the full period', n.snow.count, n.expectedModels) : '';
  const choice = n.morning ? `<div class="cloud-night-choice" role="group" aria-label="${t('Night to review')}"><button id="night-last" data-night-choice="${n.lastNightDate}" aria-pressed="${morning && n.nightDate === n.lastNightDate}">${t('Last night')}</button><button id="night-next" data-night-choice="tonight" aria-pressed="${!morning}">${t('Tonight’s forecast')}</button></div>` : '';
  const quality = personalSnowQuality(data, n);
  const condition = quality.key === 'rain' ? t('Rain') : n.condition.label;
  const summaryRange = !morning && n.forecastState === 'current' && n.snow.count >= 2 ? t('Model range: {0}', snowRange(n.snow)) : '';
  const collection = !morning && n.source?.fetchedAt ? t('{0} collected {1}', n.forecastState === 'stale' ? t('Saved forecast') : t('Forecast'), timestamp(n.source.fetchedAt)) : '';
  return `<article class="cloud-tomorrow" id="live-overnight" aria-labelledby="night-headline" data-night-phase="${n.phase}" data-forecast-state="${n.forecastState}">
  ${mountainHeading(data)}${forecastNavigation()}
  ${choice}${notice ? `<p class="tomorrow-notice" role="status">${escape(notice)}</p>` : ''}
  <div class="forecast-section-heading"><h2 id="tomorrow-snow-label">${t('Snow Summary')}</h2><p>${displayDate}</p></div>
  <section class="forecast-summary-card forecast-tomorrow-card ${numeric ? '' : 'forecast-summary-word'}" data-snow-quality="${quality.key || 'unknown'}" aria-labelledby="tomorrow-snow-label">
    <div class="forecast-feature"><h3>${remaining ? t('Left to fall') : morning ? t('Actual snowfall') : t('By 6 am')}</h3>
      <p class="tomorrow-amount ${numeric ? n.estimate.value.length > 1 ? 'tomorrow-amount-wide' : '' : 'tomorrow-amount-word'}" data-snowfall-value="${escape(n.estimate.value)}" aria-label="${n.estimate.approximate ? t('Approximately ') : ''}${escape(n.estimate.value)}${numeric ? ' ' + depthUnitName(n.estimate.value) : ''}"><strong>${escape(n.estimate.value)}</strong>${numeric ? `<span class="forecast-amount-unit" aria-hidden="true">${weatherUnit('in')}</span>` : ''}</p>
      <p class="tomorrow-median">${morning ? t('Observation not available') : escape(n.estimate.label)}</p>
    </div>
    <div class="forecast-feature-facts">${morning ? `<p class="forecast-morning-note">${t('Forecasts cannot confirm what fell. Check the mountain report for observations.')}</p>` : `<div class="forecast-condition-fact"><p class="forecast-fact-label">${quality.key === 'rain' ? t('Forecast precipitation') : t('Estimated morning condition')}</p>
      <p class="forecast-condition" ${n.condition.key ? `data-condition="${n.condition.key}" data-selected="true"` : ''}>${n.condition.key || quality.key === 'rain' ? forecastIcon(quality.key === 'rain' || n.condition.key === 'wet' ? 'drop' : 'snow') : ''}<strong>${escape(condition)}</strong></p>
      ${n.condition.key && quality.key !== 'rain' ? `<p class="forecast-condition-basis">${t('Based on NWS snow level')}</p>` : ''}
      ${n.condition.transition ? `<p class="forecast-transition">${escape(n.condition.transition)}</p>` : ''}
      ${!quality.key && n.condition.key ? `<p class="forecast-rating-unknown">${t('Snow quality unrated')}</p>` : ''}</div>
      <div class="forecast-agreement-fact"><p class="forecast-fact-label">${t('Model agreement')}</p>${compactAgreement(n)}</div>`}</div>
    <div class="forecast-summary-evidence"><p class="tomorrow-window">${escape(window)}${numeric ? t(' · {0}', depthUnitName()) : ''}</p>${summaryRange ? `<p>${escape(summaryRange)}</p>` : ''}${collection ? `<p>${escape(collection)}</p>` : ''}</div>
  </section>
  ${morning ? reportLink(data, 'tomorrow-report') : ''}
  <details id="tomorrow-details" class="tomorrow-details live-preserve-details"><summary id="tomorrow-details-button">${forecastIcon('list')}<span>${t('Details')}</span>${forecastIcon('chevron')}</summary><div class="tomorrow-details-body">${overnightEvidence(data, n)}${forecastGuide(data, { ...state, qualityGuide: true }, n)}</div></details>
  ${qualityGuide('tomorrow-quality-guide')}
  </article>`;
}

function overnightEvidence(data, n) {
  const morning = n.phase === 'morning', ending = n.phase === 'ending';
  const shortTime = value => formatTime(value, { minute: undefined }).toLowerCase();
  const date = n.opening ? t('Opening forecast') : `${formatDate(n.nightStart)} → ${formatDate(n.end)}`;
  const period = n.opening ? snowfallWindow(n.start, n.end)
    : n.phase === 'remaining' ? t('{0}–6 am remaining · Pacific', shortTime(n.start)) : t('6 pm–6 am · Pacific');
  const checked = n.source?.fetchedAt ? t('checked {0}', n.forecastState === 'current' && !n.opening ? formatTime(n.source.fetchedAt).toLowerCase() + t(' PT') : timestamp(n.source.fetchedAt)) : t('no successful collection');
  const target = n.phase === 'remaining' ? (n.opening ? '' : t('Already fallen: unconfirmed · full-night total unknown'))
    : morning ? t('Check a station report for actual snowfall')
    : ending ? t('The feed cannot resolve only the remaining part of this hour')
    : n.forecastState === 'stale' ? t('Saved model estimates · full-night target {0}', overnightTarget()) : t('Your overnight target: {0}', overnightTarget());
  const supportPrefix = n.support && n.support.available < n.support.expected ? t('{0} of {1} available models · ', n.support.available, n.support.expected) : '';
  const supportNote = n.opening ? t('{0}Through {1} · model counts', supportPrefix, formatTime(n.end))
    : t('{0}Full night to 6 am · counts, not probabilities', supportPrefix);
  const quality = n.opening ? personalSnowQuality(data, n) : null;
  const openingFacts = quality ? `<div><dt>${quality.key === 'rain' ? t('Forecast precipitation') : t('Estimated morning condition')}</dt>
    <dd>${escape(quality.key === 'rain' ? t('Rain') : n.condition.label)}
      ${n.condition.transition ? `<small>${escape(n.condition.transition)}</small>` : ''}
      <small>${t('Personal snow rating: {0}', escape(quality.label))}</small>
    </dd></div>
    <div><dt>${t('Model agreement')}</dt><dd>${compactAgreement(n)}</dd></div>` : '';
  const rangeLabel = n.opening ? t('range of complete forecasts') : n.forecastState === 'stale' ? t('saved model range') : t('model range');
  return `<article class="cloud-night" id="night-evidence" aria-labelledby="night-evidence-heading">
  <div class="cloud-night-top">
    <div class="cloud-night-window"><img src="/clone/icons/moon.svg" width="28" height="28" alt=""><div><strong>${date}</strong><span>${period}</span></div></div>
    <h2 id="night-evidence-heading">${escape(n.headline)}</h2>
    <div class="cloud-night-amount ${n.amount.length > 16 ? 'cloud-amount-word' : ''}"><strong>${escape(n.amount)}</strong>${!morning && n.amount !== t('Unavailable') ? `<span>${rangeLabel}</span>` : ''}</div>
    ${n.opening && n.estimate.blendedIn !== null ? `<p class="cloud-range-note">${escape(t('{0} · {1}', t('{0} {1}', n.estimate.value, weatherUnit('in')), n.estimate.label))}</p>` : ''}
    ${n.support ? `<div class="cloud-target-support" role="group" aria-label="${t('Models reaching your full-night snowfall target')}">${[[4,n.support.four],[5,n.support.five]].map(([threshold,count]) => `<div data-target-inches="${threshold}"><span>${t('At least {0}', depthThreshold(threshold, true))}</span><strong>${t('{0} of {1}', count, n.support.available)} <small>${t('models')}</small></strong></div>`).join('')}</div><p class="cloud-support-note">${supportNote}</p>` : target ? `<p class="cloud-night-target">${target}</p>` : ''}
    ${!morning ? `<p class="cloud-night-uncertainty" data-uncertainty="${n.uncertainty.kind}"><strong>${t('What to watch')}</strong> ${escape(n.uncertainty.text)}</p>` : ''}
  </div>
  <div class="cloud-night-evidence">
  ${!morning && !ending ? `<div class="cloud-night-table-scroll" tabindex="0" role="region" aria-label="${t('Overnight model comparison, scroll horizontally if needed')}"><table class="cloud-night-models"><caption class="cloud-sr-only">${t('Overnight snowfall by model. {0}.', escape(n.coverageText))}</caption><thead><tr><th scope="col">${t('Model')}</th><th scope="col">${t('Snowfall')}</th><th scope="col">${n.phase === 'remaining' ? t('Coverage') : n.forecastState === 'current' ? t('Target') : t('Status')}</th></tr></thead><tbody>${n.rows.map(m => `<tr data-night-model="${m.id}"><th scope="row"><i aria-hidden="true" style="background:${m.color}"></i>${escape(m.label)}</th><td>${m.complete && n.forecastState !== 'unavailable' ? escape(t('{0} {1}', snowAmount(m.total), weatherUnit('in'))) : '—'}</td><td class="cloud-target-${m.targetState}">${escape(n.forecastState === 'unavailable' ? t('Unavailable') : m.target)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  <dl class="cloud-night-facts"><div><dt>${t('Timing')}</dt><dd>${escape(n.timing)}</dd></div>${!morning && !ending ? `<div><dt>${t('Snow level · NWS')}</dt><dd>${escape(n.level.value)}<small class="${n.level.state === 'current' ? '' : 'cloud-caution'}">${escape(n.level.note)}</small>${n.level.coverage === 'partial' ? `<button class="cloud-inline-link" data-night-details>${t('See available times')}</button>` : ''}</dd></div>` : ''}
    ${openingFacts}
  </dl>
  </div>
  <div class="cloud-night-footer">
    ${morning ? '' : `<p class="cloud-night-source ${n.forecastState === 'current' && n.coverage === 'full' ? '' : 'cloud-caution'}">${ending ? t('Forecast collection {0}', n.forecastState === 'stale' ? t('overdue') : t(n.forecastState)) : n.coverageText} · ${checked}</p>`}
    ${n.opening ? '' : `<p class="cloud-observation-note" id="live-observations">${t('Actual snowfall unconfirmed{0}', data.observationsEnabled === false ? t(' · NWAC off') : t(' · forecast view'))}</p>`}
    ${!morning && !ending && n.snow.count && n.forecastState !== 'unavailable' ? `<p class="cloud-range-note">${t('Range of model forecasts; actual snowfall can differ.')}</p>` : ''}
    ${morning ? reportLink(data, 'cloud-primary') : ''}
    <span class="cloud-sr-only">${t('All available models.')}</span>
  </div></article>`;
}

export function stations(data, state) {
  if (data.observationsEnabled === false) return `<div class="live-empty"><strong>${t('NWAC observations are disabled')}</strong><p>${t('Forecasts are available below. Observed snowfall and current station conditions are not being collected during this test.')}</p></div>`;
  return `<div class="live-stations">${data.stations.map(s => stationSummary(s, state.now)).map(s => `<article><header><a href="${escape(s.url)}" target="_blank" rel="noreferrer">NWAC ${escape(t(s.name))}</a><span>${t('{0} ft', s.elevationFt.toLocaleString())}</span></header><div class="live-station-values"><strong>${finite(s.temperatureF) ? Math.round(convertWeather(s.temperatureF, '°F')) + weatherUnit('°F') : '—'}</strong><span>${finite(s.gustMph) ? t('Gust {0} mph', Math.round(s.gustMph)) : t('Wind unavailable')}</span></div><p class="${s.quality === 'fresh' ? '' : 'live-warning'}">${s.quality === 'fresh' ? t('Observed') : t(s.quality)} · ${timestamp(s.at)}</p>${s.hasSnowBoard ? `<p><strong>${s.board.status === 'valid' ? t('{0} board increase since 6 pm', t('{0} {1}', snowAmount(s.board.changeIn), weatherUnit('in'))) : t('Fresh snow unconfirmed')}</strong><small>${escape(s.board.reason)}</small></p>` : ''}${s.notices.length ? `<details><summary>${t('Station notice')}</summary><p>${escape(s.notices.join(' '))}</p></details>` : ''}</article>`).join('')}</div>`;
}

export function sources(data) {
  return `<details id="forecast-sources" class="live-data-details live-preserve-details"><summary>${t('Sources, updates & forecast methods')}</summary><div class="live-sources">${data.sources.map(s => `<p><a href="${escape(s.url)}" target="_blank" rel="noreferrer">${escape(t(s.name))}</a> · ${escape(t(s.status))}<small>${t('Retrieved {0}{1}', timestamp(s.fetchedAt), s.issuedAt ? t(' · issued {0}', timestamp(s.issuedAt)) : '')}</small>${s.error ? `<small>${escape(s.error)}</small>` : ''}</p>`).join('')}<p>${t('Open-Meteo provides the named model forecasts (CC BY 4.0, aggregated for this view). Snowfall uses provider conversions, commonly 7:1, and hourly values can be interpolated.')}</p><p>${t('Retrieval time is not model initialization time; exact run timestamps are unavailable in this feed. Model spread is not a probability. NWS snow level is separate from freezing level.')}</p><p>${t('Requested forecast point: {0}, {1}, {2} ft. NWAC measurements are separate station observations; missing snow is never zero snowfall.', data.resort.latitude, data.resort.longitude, data.resort.elevationFt.toLocaleString())}</p></div></details>`;
}
