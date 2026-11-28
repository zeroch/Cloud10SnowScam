import { depthNumber, depthThreshold, depthUnitName, displayLanguage, displayUnits, modelCountLabel, t, weatherUnit } from '/lib/i18n.mjs';
import { formatDate, formatTime, localParts } from '/lib/time.mjs';
import { snowAmount, snowRange } from '/lib/forecast.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const icon = (name, className = '') => `<img class="${className}" src="/clone/icons/phosphor/${name}.svg" width="20" height="20" alt="">`;
const morningLabel = time => `${formatDate(time, { month: undefined, day: undefined })} ${formatDate(time, { month: undefined, weekday: undefined })}`;

function agreement(row) {
  const n = row.night;
  if (row.loading && !n.source) return t('Loading models…');
  const word = { high: t('Agree'), moderate: t('Mixed'), low: t('Split') }[n.agreement.key];
  const limited = !word && n.snow.count && n.forecastState === 'current';
  const label = word || (n.agreement.label === t('Outdated') ? t('Outdated') : limited ? t('Limited') : t('Unavailable'));
  const count = word || limited ? `<span class="resort-model-count"> · ${modelCountLabel(n.snow.count)}</span>` : '';
  return `<span class="compare-sr-only">${t('Model agreement:')} </span><strong>${label}</strong>${count}`;
}

function quality(n) {
  if (n.forecastState === 'current' && n.snow.count >= 3 && n.estimate.median === 0 && n.snow.max > 0) {
    return { key: 'unknown', label: t('Snow uncertain') };
  }
  const key = n.quality.key || 'unknown';
  if (key === 'rain') return { key, label: t('Rain') };
  if (key === 'wet') return { key, label: t('Wet') };
  if (key === 'poor') return { key, label: n.snow.max === 0 ? t('No new snow') : t('Light snow') };
  if (n.quality.key && n.condition.key) return { key, label: `${n.condition.label} · ${n.quality.label}` };
  return { key, label: n.forecastState === 'stale' ? t('Quality outdated') : t('Quality unavailable') };
}

function amountLabel(n, value, loading) {
  if (loading) return t('Loading snowfall');
  if (n.estimate.blendedIn === null) return t('Snowfall unavailable');
  const spoken = value.startsWith('<') ? t('Less than {0}', value.slice(1)) : `${n.estimate.approximate ? t('About ') : ''}${value}`;
  return t('{0} {1}, blended snowfall{2}', spoken, depthUnitName(value), n.phase === 'remaining' ? t(' remaining') : '');
}

function resortRow(row) {
  const { resort, night: n } = row;
  const loading = row.loading && !n.source;
  const value = loading ? '—' : n.estimate.value;
  const q = loading ? { key: 'unknown', label: t('Loading quality…') } : quality(n);
  const note = n.forecastState === 'stale' ? t('Saved forecast · update overdue')
    : row.failed ? n.source ? t('Refresh failed · showing saved response') : t('Forecast unavailable')
    : !loading && n.estimate.blendedIn === null ? n.phase === 'ending' ? t('Final hour in progress') : t('Not enough forecast coverage')
    : n.estimate.blendedIn > 0 && q.key !== 'unknown' ? n.condition.transition : '';
  const showRange = n.forecastState === 'current' && n.snow.count >= 2 && (n.agreement.key === 'low' || !n.agreement.key);
  const range = showRange ? t('Model range: {0}', snowRange(n.snow)) : '';
  return `<li><a class="resort-row" id="compare-${resort.id}" href="${escape(row.href)}" data-resort-row="${resort.id}" data-snow-quality="${q.key}" aria-busy="${row.loading}">
    <div class="resort-identity"><h2>${escape(resort.name)}</h2><p>${t('{0} · {1} ft', escape(t(resort.pointLabel)), resort.elevationFt.toLocaleString('en-US'))}</p></div>
    <div class="resort-figure" title="${escape(q.label)}">
      <strong class="resort-amount" data-snowfall-value="${escape(value)}" aria-label="${escape(amountLabel(n, value, loading))}">${escape(value)}</strong>${!loading && n.estimate.blendedIn !== null ? `<span aria-hidden="true">${weatherUnit('in')}</span>` : ''}
      <span class="compare-sr-only">${escape(q.label)}</span>
    </div>
    <div class="resort-models">
      <p class="resort-agreement" data-model-agreement="${n.agreement.key || 'unknown'}">${agreement(row)}</p>
      ${range ? `<p class="resort-range">${escape(range)}</p>` : ''}
      ${note ? `<p class="resort-note">${escape(note)}</p>` : ''}
    </div>
    <div class="resort-snow-track" aria-hidden="true"><div style="width:${row.fraction * 100}%"></div></div>
    ${icon('caret-right-bold', 'resort-chevron')}
  </a></li>`;
}

export function renderComparison(board, selectedDay) {
  if (board.mode === 'timeline') return renderTimeline(board, selectedDay);
  const { selected: n, days } = board;
  const remaining = n.phase === 'remaining', ending = n.phase === 'ending';
  const timestamps = board.rows.map(row => row.night.source?.fetchedAt).filter(Number.isFinite);
  const oldest = timestamps.length ? Math.min(...timestamps) : null;
  const freshness = oldest === null ? t('Forecasts are loading or unavailable') : t('Oldest forecast collected {0} {1} PT', formatDate(oldest), formatTime(oldest));
  return `<header class="compare-title club-landscape">
    <h1 id="comparison-heading">${t('Compare resorts')}</h1>
    <p>${t('Overnight snowfall in the Washington Cascades')}</p>
  </header>
  <section class="compare-report" aria-labelledby="compare-period">
    <div class="compare-toolbar">
    <div class="compare-controls">
    ${viewSwitch(false)}
    ${days > 1 ? `<nav class="compare-dates" aria-label="${t('Morning to compare')}">${board.nights.map(date => `<button id="compare-date-${date.nightDate}" data-compare-night="${date.nightDate}" aria-label="${formatDate(date.end)}" aria-pressed="${date.nightDate === n.nightDate}">${morningLabel(date.end)}</button>`).join('')}</nav>` : ''}</div>
    <div class="compare-period-line"><h2 id="compare-period">${formatDate(n.end)} · ${remaining ? t('Left by 6 am') : ending ? t('Final hour') : t('Snow by 6 am')}</h2><p class="compare-window">${remaining ? t('{0}–6 am PT · {1} left', formatTime(n.start, { minute: undefined }).toLowerCase(), depthUnitName()) : t('6 pm–6 am PT · {0}', depthUnitName())}</p></div>
    </div>
    ${remaining || ending ? `<p class="compare-notice">${t('Already-fallen snow is unconfirmed.')}</p>` : ''}
    <div class="compare-columns" aria-hidden="true"><span>${t('Mountain')}</span><span>${t('Snowfall')}</span><span>${t('Model agreement')}</span></div>
  <ul class="resort-comparison-list" aria-label="${t('Resorts, overnight snowfall, model agreement and estimated quality')}">${board.rows.map(resortRow).join('')}</ul>
    <div class="compare-metadata"><p>${t('Blended snowfall · estimated quality')} · ${t('Full bar at {0}', depthThreshold(board.maximum))}</p><p>${escape(freshness)}</p></div>
  </section>
  <div class="compare-foot">
  <details id="compare-quality-key" class="compare-quality-key"><summary id="compare-quality-button"><span>${t('How snow quality works')}</span>${icon('caret-right-bold','compare-chevron')}</summary>
    <ul class="compare-quality-colors">${[['poor',t('Little / no snow')],['good',t('Good')],['excellent',t('Excellent')],['rain',t('Rain')],['wet',t('Wet')]].map(([key,label]) => `<li data-snow-quality="${key}">${label}</li>`).join('')}</ul>
    <p>${t('Personal new-snow preferences, estimated from each resort’s snow level and snowfall. Not measured surface conditions.')}</p>
    <p>${t('Excellent: at least {0} with Dry snow and no earlier Wet interval. Good: at least {1} with Dry/Normal snow. Gray indicates little or no new snow. Purple indicates Wet snow. Green indicates models support rain.', depthThreshold(5, true), depthThreshold(1, true))}</p>
    <p>${t('Snow uncertain: the middle model forecast is zero, but some models predict snow. Light snow: less than {0} of new snow. Uncertain or unavailable quality is also gray.', depthThreshold(1, true))}</p>
    <p>${t('Agree, mixed and split describe High, Medium and Low model agreement about snowfall, not the probability of snow. Open a resort for exact model totals and condition rules.')}</p>
  </details>
  <details id="compare-sources" class="compare-sources"><summary id="compare-sources-button"><span>${t('Sources & updates')}</span>${icon('caret-right-bold','compare-chevron')}</summary><ul>${board.rows.map(({ resort, night, failed }) => `<li><strong>${escape(resort.name)}</strong><span>${night.source?.fetchedAt ? t('{0} {1} {2} PT', night.forecastState === 'stale' ? t('Saved') : t('Collected'), formatDate(night.source.fetchedAt), formatTime(night.source.fetchedAt)) : t('No saved forecast')}${failed ? t(' · refresh failed') : ''}</span></li>`).join('')}</ul><p>${t('Model forecasts from')} <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> ${t('(CC BY 4.0); snow levels from')} <a href="https://www.weather.gov/" target="_blank" rel="noreferrer">NWS</a>${t('. Snowfall uses an hourly weighted blend rounded up to whole {0}. Bars use whole-inch increments.', depthUnitName())}</p><p>${t('Collection runs on a schedule. This checks for newer saved forecasts.')}</p><button id="compare-refresh" data-compare-refresh aria-disabled="${board.rows.some(r => r.loading)}">${board.rows.some(r => r.loading) ? t('Checking…') : t('Check saved forecasts')}</button></details></div>`;
}

function viewSwitch(timeline) {
  return `<nav class="compare-view-switch" aria-label="${t('Comparison view')}">
    <button type="button" id="compare-view-today" data-compare-view="am" aria-pressed="${!timeline}">${t('Today')}</button>
    <button type="button" id="compare-view-overview" data-compare-view="15d" aria-pressed="${timeline}">${t('Overview')}</button>
  </nav>`;
}

export const rangeLabel = block => t('Days {0}–{1}', block.firstDay, block.lastDay);
const timelineUnit = amount => t('{0} {1}', amount, depthUnitName(amount));
const shortDepth = amount => displayUnits.depth === 'in' ? `${amount}″` : `${amount} ${weatherUnit('in')}`;
const rangeTime = value => Number.isFinite(value) ? t('{0} {1} PT', formatDate(value), formatTime(value)) : t('Report time unavailable');
const dayKey = (row, index) => `timeline-day-${row.resort.id}-${index}`;

function conditionLabel(category, heavy) {
  return {
    rain: t('Rain'),
    wet: t('Wet snow'),
    good: t('Good snow'),
    heavy: t('Over {0} before rounding', depthThreshold(heavy)),
  }[category];
}

function dayDescription(row, day, index, heavy) {
  const amount = day.blendedIn === null ? t('Forecast unavailable') : timelineUnit(snowAmount(day.blendedIn));
  return [row.resort.name, formatDate(day.calendarStart), index === 0 && day.partial && t('Remaining today'),
    amount, conditionLabel(day.category, heavy), modelCountLabel(day.contributingCount),
    day.count > 1 && t('Model range: {0}', snowRange(day)),
    row.source?.status === 'stale' && t('Stale forecast')].filter(Boolean).join(' · ');
}

export function renderTimelineDetail(board, selectedDay) {
  const row = board.rows.find(r => r.resort.id === selectedDay?.resortId);
  const index = selectedDay?.index;
  const day = row?.days[index];
  if (!day) return '';
  const collected = row.source?.fetchedAt;
  const window = day.ending ? t('Final hour in progress') : index === 0 && day.partial
    ? t('{0}–{1} · {2} PT', formatTime(day.start), formatTime(day.end), t('Remaining today')) : '';
  return `<p>${escape(dayDescription(row, day, index, board.heavy))}</p>
    ${window ? `<p>${escape(window)}</p>` : ''}
    ${Number.isFinite(collected) ? `<p>${escape(t('Retrieved {0} {1} PT', formatDate(collected), formatTime(collected)))}</p>` : ''}`;
}

function timelineObservation(row) {
  const { station, reading } = row.observation;
  const short = { 54: 'Campbell', 23: 'East Shed', 5: 'Heather Mdws' }[station.stid] || station.name;
  const amount = depthNumber(reading?.value ?? 0);
  const observedAt = reading?.observedAt;
  const when = Number.isFinite(observedAt) ? formatTime(observedAt) : '';
  const compactTime = displayLanguage === 'en' ? when.replace(/(?::00)?\s*(AM|PM)$/i, (_, period) => period[0].toLowerCase()) : when;
  const stale = reading?.state === 'stale';
  const title = [t('Past 24h snow accumulation'), 'NWAC', t(station.name),
    reading ? timelineUnit(amount) : t('No snow-board reading'),
    reading && rangeTime(observedAt), stale && t('Stale reading')].filter(Boolean).join(' · ');
  return `<div class="timeline-reading" data-observation-state="${reading?.state || 'unavailable'}" title="${escape(title)}">
    <span class="compare-sr-only">${escape(title)}</span>
    <span aria-hidden="true">${escape(shortDepth(amount))}</span>
    <small aria-hidden="true">${escape(t(short))}${!stale && compactTime ? ' · ' + escape(compactTime) : ''}</small>
    ${stale ? `<small class="timeline-stale" aria-hidden="true">${escape([compactTime, t('Stale')].filter(Boolean).join(' · '))}</small>` : ''}
  </div>`;
}

function timelineForecastStatus(row) {
  const { source } = row;
  if (row.loading && !source) return t('Loading forecasts');
  if (source?.status === 'stale') return t('Saved') + ' · ' + rangeTime(source.fetchedAt);
  if (!['fresh', 'cached'].includes(source?.status)) return t('Forecast unavailable');
  return row.failed ? t('Refresh failed · showing saved response') : '';
}

function timelineResort(row, board, selectedDay) {
  const { resort } = row;
  const status = timelineForecastStatus(row);
  const point = t('{0} · {1} ft', t(resort.pointLabel), resort.elevationFt.toLocaleString('en-US'));
  const shortName = resort.id === 'crystalmountain' && displayLanguage === 'en' ? 'Crystal Mtn' : resort.name;
  const blocks = row.blocks.map((block, blockIndex) => {
    const amount = snowAmount(block.blendedIn ?? 0);
    const subtotal = [rangeLabel(block), block.blendedIn === null ? t('Forecast unavailable') : timelineUnit(amount),
      conditionLabel(block.category, board.heavy), modelCountLabel(block.contributingCount),
      block.count > 1 && t('Model range: {0}', snowRange(block))].filter(Boolean).join(' · ');
    const days = row.days.slice(blockIndex * 5, (blockIndex + 1) * 5).map((day, offset) => {
      const index = blockIndex * 5 + offset;
      const selected = selectedDay?.resortId === resort.id && selectedDay.index === index;
      const description = dayDescription(row, day, index, board.heavy);
      return `<button type="button" class="timeline-day" id="${dayKey(row, index)}" data-timeline-day="${index}" data-timeline-resort="${resort.id}" data-category="${day.category}" data-available="${day.blendedIn !== null}" aria-controls="timeline-day-detail" aria-expanded="${selected}" aria-label="${escape(description)}" title="${escape(description)}">
        <span aria-hidden="true" class="timeline-bar-track" style="--timeline-bar-height:${day.fraction * 100}%">
          <span class="timeline-bar"></span><span class="timeline-day-value">${snowAmount(day.blendedIn ?? 0)}</span>
        </span>
      </button>`;
    }).join('');
    return `<div class="timeline-range" data-timeline-range="${blockIndex + 1}">
      <p class="timeline-total" data-category="${block.category}" title="${escape(subtotal)}"><span class="compare-sr-only">${escape(subtotal)}</span><span aria-hidden="true">${escape(shortDepth(amount))}</span></p>
      <div class="timeline-slots">${days}</div>
    </div>`;
  }).join('');
  return `<li class="timeline-row" aria-label="${escape(resort.name)}" aria-busy="${row.loading}">
    <div class="timeline-pin">
      <div class="timeline-identity">
        <a id="timeline-resort-${resort.id}" data-timeline-link href="${escape(row.href)}" aria-label="${escape(resort.name + ' · ' + point)}">${escape(shortName)}</a>
        <p class="timeline-point" title="${escape(point)}">${escape(t('{0} ft', resort.elevationFt.toLocaleString('en-US')))}</p>
      </div>
      ${timelineObservation(row)}
      ${status ? `<p class="timeline-status">${escape(status)}</p>` : ''}
    </div>
    ${blocks}
  </li>`;
}

function timelineDate(days, index) {
  const day = days[index], date = day.calendarStart, { month } = localParts(date);
  const weekday = formatDate(date, { month: undefined, day: undefined });
  const monthLabel = index === 0 || localParts(days[index - 1].calendarStart).month !== month;
  const number = formatDate(date, { weekday: undefined, month: monthLabel ? 'numeric' : undefined });
  const partial = index === 0 && day.partial;
  return `<span class="timeline-date" data-timeline-date="${date}"${day.weekend ? ' data-weekend' : ''} title="${escape(formatDate(date))}">
    <span class="compare-sr-only">${escape(formatDate(date) + (partial ? ' · ' + t('Remaining today') : ''))}</span>
    <span aria-hidden="true">${escape(displayLanguage === 'en' ? weekday.slice(0, 2) : weekday)}</span>
    <span aria-hidden="true">${escape(number)}${partial ? '*' : ''}</span>
  </span>`;
}

function renderTimeline(board, selectedDay) {
  const detail = renderTimelineDetail(board, selectedDay);
  return `<header class="timeline-title">
    <h1 id="comparison-heading">${t('Compare resorts')}</h1>
    ${viewSwitch(true)}
  </header>
  <section class="timeline-report" aria-label="${t('15-day snowfall')}">
    <div class="timeline-mobile-heading">
      <span class="timeline-observed-label">${t('24h')}</span>
      <p id="timeline-current-range" class="timeline-current-range" aria-live="polite">${rangeLabel(board.blocks[board.stage - 1])}</p>
    </div>
    <div id="timeline-scroll" class="timeline-scroll" tabindex="0" role="region" aria-label="${t('15-day snowfall timeline, scroll horizontally for later days')}" aria-describedby="timeline-keyboard">
      <p id="timeline-keyboard" class="compare-sr-only">${t('Swipe or use the arrow keys to compare later dates.')}</p>
      <div class="timeline-content">
        <div class="timeline-heading" aria-hidden="true">
          <span class="timeline-observed-label">${t('24h')}</span>
          ${board.blocks.map((block, index) => `<span data-timeline-stage="${index + 1}">${rangeLabel(block)}</span>`).join('')}
        </div>
        <ul class="timeline-list" aria-label="${t('Resort snowfall by day')}">${board.rows.map(row => timelineResort(row, board, selectedDay)).join('')}</ul>
        <div class="timeline-calendar">
          <span class="timeline-calendar-pin" aria-hidden="true"></span>
          ${board.blocks.map((_, index) => `<div class="timeline-slots">${Array.from({ length: 5 }, (_, offset) => timelineDate(board.days, index * 5 + offset)).join('')}</div>`).join('')}
        </div>
      </div>
    </div>
    <div id="timeline-day-detail" class="timeline-day-detail" aria-live="polite"${detail ? '' : ' hidden'}>${detail}</div>
    <div class="timeline-caption">
      <ul class="timeline-legend">
        <li data-category="rain">${t('Rain')}</li>
        <li data-category="wet">${t('Wet')}</li>
        <li data-category="good">${t('Good')}</li>
        <li data-category="heavy">&gt;${escape(shortDepth(depthNumber(board.heavy)))}</li>
      </ul>
      <p>${board.days[0].partial ? '* ' + t('Remaining today') + ' · ' : ''}${t('Full bar at {0}', depthThreshold(board.maximum))} · ${t('PT')}</p>
    </div>
  </section>
  <div class="compare-foot timeline-foot">
    <details id="compare-timeline-sources" class="compare-sources"><summary id="compare-timeline-sources-button"><span>${t('Sources & updates')}</span>${icon('caret-right-bold', 'compare-chevron')}</summary>
      <p>${t('The NWAC 24-hour board measures snow since it was last cleared.')}</p>
      <p>${t('Missing values display as zero. Select a day to check availability, models, and collection time.')}</p>
      <ul>${board.rows.map(({ resort, source }) => `<li><strong>${escape(resort.name)}</strong><span>${Number.isFinite(source?.fetchedAt) ? escape(t('{0} {1} {2} PT', source.status === 'stale' ? t('Saved') : t('Collected'), formatDate(source.fetchedAt), formatTime(source.fetchedAt))) : t('No saved forecast')}</span></li>`).join('')}</ul>
      <button id="compare-refresh" data-compare-refresh aria-disabled="${board.rows.some(r => r.loading)}">${board.rows.some(r => r.loading) ? t('Checking…') : t('Check saved forecasts')}</button>
    </details>
  </div>`;
}
