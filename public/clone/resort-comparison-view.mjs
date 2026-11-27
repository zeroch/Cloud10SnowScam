import { modelCountLabel, t, depthThreshold, depthUnitName, weatherUnit } from '/lib/i18n.mjs';
import { formatDate, formatTime } from '/lib/time.mjs';
import { snowRange } from '/lib/forecast.mjs';

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

export function renderComparison(board) {
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
    <div class="compare-controls"><p class="compare-control-label">${t('Choose a forecast window')}</p><nav class="compare-horizons" aria-label="${t('Forecast horizon')}">${[[1,t('Next morning')],[3,t('3 mornings')],[5,t('5 mornings')]].map(([d,label]) => `<button id="compare-horizon-${d}" data-compare-days="${d}"${d === days ? ' aria-current="page"' : ''}>${label}</button>`).join('')}</nav>
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
