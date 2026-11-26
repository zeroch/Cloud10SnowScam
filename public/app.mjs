import './clone/language-control.mjs';
import { t, convertWeather, overnightTarget, weatherUnit } from '/lib/i18n.mjs';
import { fetchDashboard } from '/lib/dashboard-client.mjs';
import { HOUR, nightWindow, formatDate, formatTime } from '/lib/time.mjs';
import { summarizeModel, summarizeSnowLevel, finite } from '/lib/conditions.mjs';
import { snowAmount, snowRange } from '/lib/forecast.mjs';
import { ageSnapshot, reconcileSelection, chartData, forecastStatus } from '/lib/display.mjs';
import { drawChart, METRICS, valueLabel } from './charts.mjs';

const state = { data: null, snapshot: null, days: 3, metric: 'snow', selected: new Set(), excluded: new Set(), index: 0, loading: false, chart: null, table: false, refreshFailed: false };
const el = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const statusLabel = { limited: 'Needs a check', below: 'Below your snow target', watch: 'Keep an eye on it', promising: 'Worth watching', partial: 'Remaining hours only' };
const arrow = '<span aria-hidden="true">↗</span>';
const source = id => state.data.sources.find(s => s.id === id);
const fresh = id => ['fresh', 'cached'].includes(source(id)?.status);
const startTime = () => Math.ceil(state.data.evaluatedAt / HOUR) * HOUR;

function decisionCard(item, type) {
  const isTomorrow = type === 'tomorrow';
  const label = isTomorrow ? t('Tomorrow · {0}', formatDate(item.end, { month: undefined })) : t('Right now · NWAC observations');
  return `<article class="decision ${isTomorrow ? 'decision-next' : ''}"><div class="card-kicker"><span>${label}</span><span class="decision-icon" aria-hidden="true">${isTomorrow ? '☾' : '↟'}</span></div><span class="tag ${item.status}">${t(statusLabel[item.status])}</span><h2>${escape(item.headline)}</h2><p class="decision-copy">${escape(item.detail)}</p><ul class="evidence">${item.evidence.slice(0, isTomorrow ? 3 : 2).map(text => `<li>${escape(text)}</li>`).join('')}</ul>${isTomorrow ? `<span class="card-foot">${t('Outlook uses all available models + NWAC context')}</span>` : `<a class="card-link" href="#stations">${t('Check the mountain stations')} <span aria-hidden="true">↓</span></a>`}</article>`;
}

function stationCard(station) {
  const temperature = station.temperatureF;
  const note = station.id === 'brooks' ? t('Your primary reference') : station.id === 'schmidt' ? t('Base cross-check') : t('Upper-mountain cross-check');
  const board = station.board.status === 'valid' ? t('{0} board increase', t('{0} {1}', snowAmount(station.board.changeIn), weatherUnit('in'))) : station.hasSnowBoard ? t('Snow reading unconfirmed') : finite(station.gustMph) ? t('{0} mph gusts', Math.round(station.gustMph)) : finite(station.humidityPct) ? t('{0}% humidity', Math.round(station.humidityPct)) : t('No snow measurement');
  return `<article class="station"><div class="station-top"><span class="eyebrow">${t('{0} FT', station.elevationFt.toLocaleString())}</span><span class="small-status ${station.quality}">${station.quality === 'fresh' ? t('Reporting') : station.quality === 'stale' ? t('Stale') : t('Unavailable')}</span></div><h3><a href="${escape(station.url)}" target="_blank" rel="noreferrer">${escape(station.name)} ${arrow}</a></h3><p>${note}</p><div class="station-temp">${finite(temperature) ? Math.round(convertWeather(temperature, '°F')) : '—'}<span>${weatherUnit('°F')}</span></div><div class="station-observation ${station.hasSnowBoard && station.board.status !== 'valid' ? 'unconfirmed' : ''}">${escape(board)}</div><div class="station-time">${station.at ? t('{0} · {1} PT', formatDate(station.at, { weekday: undefined }), formatTime(station.at)) : t('No recent observation')}</div><details><summary>${t('Measurement details')}</summary><p>${escape(station.board.reason)}</p>${station.notices.map(note => `<p class="source-note">${escape(note)}</p>`).join('')}</details></article>`;
}

function render() {
  if (!state.snapshot) {
    if (state.refreshFailed) {
      el('status').innerHTML = `<span class="status-dot warning"></span>${t('Refresh unavailable. Check your connection and try again.')}`;
      el('content').innerHTML = `<div class="loading-panel error-panel"><h2>${t('The mountain is out of reach.')}</h2><p>${t('We could not load the weather feeds. Nothing here is being treated as zero snow.')}</p><button class="primary-button" data-retry>${t('Try again')}</button></div>`;
    }
    return;
  }
  const expanded = [...document.querySelectorAll('#content details')].map(details => details.open);
  const active = document.activeElement;
  const focusSelector = active?.id ? `#${active.id}` : active?.dataset.days ? `[data-days="${active.dataset.days}"]` : active?.dataset.metric ? `[data-metric="${active.dataset.metric}"]` : null;
  state.data = ageSnapshot(state.snapshot, Date.now());
  const data = state.data, advice = data.advice;
  const allHealthy = data.sources.every(s => ['fresh', 'cached'].includes(s.status));
  el('status').innerHTML = `<span class="status-dot ${allHealthy && !state.refreshFailed ? '' : 'warning'}"></span>${state.refreshFailed ? t('Refresh failed · showing the last response') : allHealthy ? t('Latest available source data') : t('Some sources need attention')}<span class="status-separator">/</span> ${t('Checked {0} at {1} PT', formatDate(data.generatedAt), formatTime(data.generatedAt))} <span class="status-reference">${t('All times Pacific')}</span>`;
  el('content').innerHTML = `<section class="decisions" aria-label="${t('Snow suggestions')}">${decisionCard(advice.now, 'now')}${decisionCard(advice.tomorrow, 'tomorrow')}</section>
    <section class="forecast-panel" id="forecast" aria-labelledby="forecast-title"><div class="section-heading"><div><span class="eyebrow">${t('LOOKING AHEAD')}</span><h2 id="forecast-title">${t('Follow the next snowfall.')}</h2><p>${t('Brooks elevation · 4,800 ft')} <span class="dot-divider">·</span> ${t('Compare the latest available models')}</p></div><div class="segmented horizon" role="group" aria-label="${t('Forecast horizon')}"><button data-days="1" aria-pressed="${state.days === 1}">${t('1 day')}</button><button data-days="3" aria-pressed="${state.days === 3}">${t('3 days')}</button></div></div><p id="chart-source" class="chart-source"></p>
    <div class="chart-controls"><div class="metric-tabs" role="group" aria-label="${t('Weather variable')}">${Object.entries(METRICS).map(([key, value]) => `<button data-metric="${key}" aria-pressed="${state.metric === key}">${t(value.label)}</button>`).join('')}</div><span class="night-key"><span></span>${t('6 pm–6 am')}</span></div><div id="chart" class="chart"></div><div class="chart-inspection"><label for="inspect-time">${t('Inspect')} <strong id="inspect-label"></strong></label><input type="range" id="inspect-time" min="0" max="${state.days * 24}" value="${state.index}" aria-label="${t('Inspect forecast hour')}"><div id="inspect-values" class="inspect-values"></div></div>
    <div class="model-controls" id="model-controls"><div>${data.models.map(model => `<label class="model-toggle"><input type="checkbox" data-model="${model.id}" ${state.selected.has(model.id) ? 'checked' : ''}><span class="model-dot" style="--model-color:${model.color}"></span><span>${model.label}<small>${escape(t(model.description))}</small></span></label>`).join('')}</div><button id="table-toggle" class="text-button" aria-expanded="${state.table}" aria-controls="forecast-table">${t('{0} data table', state.table ? t('Hide') : t('View'))} <span aria-hidden="true">${state.table ? '−' : '+'}</span></button></div><div class="chart-caption"><span id="metric-note"></span><span>${t('Model spread is not a probability.')}</span></div><div id="forecast-table" ${state.table ? '' : 'hidden'}></div></section>
    <section class="overnights" aria-labelledby="overnight-title"><div class="section-heading compact"><div><span class="eyebrow">${t('THE HOURS THAT MATTER')}</span><h2 id="overnight-title">${t('Three nights, side by side.')}</h2></div><span class="quiet-label">${t('Your target: {0} overnight', overnightTarget())}</span></div><div id="night-list"></div><p class="section-note">${t('6 pm–6 am Pacific. Nights already underway show only forecast hours remaining. Selections above change this comparison.')}</p></section>
    <section id="stations" aria-labelledby="stations-title"><div class="section-heading"><div><span class="eyebrow">${t('ON THE MOUNTAIN')}</span><h2 id="stations-title">${t('Check it against NWAC.')}</h2><p>${t('Observed conditions, from the base to the upper lifts.')}</p></div><span class="quiet-label">${t('Station time is shown on every card')}</span></div><div class="station-grid">${advice.stations.map(stationCard).join('')}</div></section>
    <section id="sources" class="sources"><details><summary><div><span class="eyebrow">${t('TRANSPARENT BY DESIGN')}</span><h2>${t('Sources & what the numbers mean')}</h2></div><span class="details-plus" aria-hidden="true">+</span></summary><div class="source-body"><div class="source-grid">${data.sources.map(s => `<div><a href="${escape(s.url)}" target="_blank" rel="noreferrer">${escape(t(s.name))} ${arrow}</a><span class="source-state ${s.status}">${s.status === 'cached' ? t('Cached · within refresh interval') : s.status === 'fresh' ? t('Retrieved successfully') : s.status === 'stale' ? t('Stale · last successful response') : t('Unavailable')}</span><small>${s.fetchedAt ? t('Retrieved {0} {1} PT', formatDate(s.fetchedAt), formatTime(s.fetchedAt)) : t('No successful retrieval')}${s.issuedAt ? `<br>${t('Issued {0} {1} PT', formatDate(s.issuedAt), formatTime(s.issuedAt))}` : ''}</small>${s.error ? `<p class="source-note">${escape(s.error)}</p>` : ''}</div>`).join('')}</div><div class="method-notes"><p><strong>${t('Forecast snow is an estimate.')}</strong> ${t('Open-Meteo converts snowfall water equivalent to snow depth for these models, commonly at 7:1. Hourly values may be interpolated. Model estimates retain their source and retrieval time.')}</p><p><strong>${t('Snow level is a separate NWS forecast.')}</strong> ${t('The 2,000 and 4,000 ft markers reflect your preferences. A low snow level alone does not guarantee dry powder.')}</p><p><strong>${t('NWAC snow needs valid sensors.')}</strong> ${t('We exclude seasonal warnings, invalid values, resets, and gaps. Board increase is not identical to new snowfall. Missing measurements are never counted as zero.')}</p><p><strong>${t('Point and timing.')}</strong> ${t('Requested point {0}° N, {1}° W at 4,800 ft. Returned forecast grid {2}. Retrieval time is not model run time; exact run initialization is unavailable in this feed.', data.resort?.latitude, Math.abs(data.resort?.longitude || 0), data.forecastGrid ? `${data.forecastGrid.latitude}°, ${data.forecastGrid.longitude}°` : t('unavailable'))}</p></div><p class="attribution">${t('Weather data:')} <a href="https://nwac.us/weather/stations" target="_blank" rel="noreferrer">NWAC</a>, <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> ${t('(CC BY 4.0; aggregated and converted for this view), and')} <a href="https://www.weather.gov/" target="_blank" rel="noreferrer">NOAA / NWS</a>${t('. Suggestions are simple rules based on your preferences.')}</p></div></details></section>`;
  renderComparison();
  document.querySelectorAll('#content details').forEach((details, i) => { details.open = !!expanded[i]; });
  if (focusSelector) document.querySelector(focusSelector)?.focus({ preventScroll: true });
}

function renderComparison() {
  const data = state.data, start = startTime();
  state.index = Math.min(state.index, state.days * 24);
  state.chart = chartData(data, state.selected, state.metric, start, state.days * 24);
  const health = forecastStatus(data, state.metric);
  el('chart-source').textContent = health.text; el('chart-source').className = `chart-source ${health.status}`;
  drawChart(el('chart'), state.chart, state.metric, state.index, inspect);
  el('metric-note').textContent = t('{0}. {1} {2} – {3} {4} PT.', t(METRICS[state.metric].note), formatDate(start), formatTime(start), formatDate(start + state.days * 24 * HOUR), formatTime(start + state.days * 24 * HOUR));
  el('model-controls').classList.toggle('models-inactive', state.metric === 'level');
  el('model-controls').querySelectorAll('input').forEach(input => { input.disabled = state.metric === 'level'; });
  inspect(state.index);
  renderNights(); renderTable();
}

function inspect(index) {
  state.index = index;
  const chart = state.chart;
  if (!chart) return;
  el('inspect-time').value = index;
  el('inspect-label').textContent = `${formatDate(chart.times[index], { month: undefined })} ${formatTime(chart.times[index])}`;
  el('inspect-values').innerHTML = chart.lines.map(line => `<span><i style="background:${line.color}"></i>${line.label}<strong>${valueLabel(line.values[index], state.metric)}</strong></span>`).join('');
  const cross = document.querySelector('#chart-crosshair');
  if (cross) { const x = chart.geometry.left + index / (chart.times.length - 1) * chart.geometry.width; cross.setAttribute('x1', x); cross.setAttribute('x2', x); }
}

function renderNights() {
  const data = state.data, selected = data.models.filter(m => state.selected.has(m.id));
  el('night-list').innerHTML = Array.from({ length: 3 }, (_, i) => {
    const window = nightWindow(data.evaluatedAt, i), start = Math.max(window.start, startTime());
    const remaining = start > window.start;
    const totals = selected.map(m => summarizeModel(m.points, start, window.end)).filter(s => s.complete).map(s => s.snowIn);
    const level = summarizeSnowLevel(data.snowLevels, start, window.end);
    const low = totals.length ? Math.min(...totals) : null, high = totals.length ? Math.max(...totals) : null;
    const count = totals.length;
    const status = !fresh('forecast') || !count ? 'limited' : remaining ? 'partial' : high < 4 ? 'below' : low >= 5 ? 'promising' : 'watch';
    const amount = count ? snowRange({ min: low, max: high }, false) : '—';
    return `<article class="night-row"><div class="night-date"><span class="night-number">0${i + 1}</span><div><h3>${i === 0 ? t('Tonight') : formatDate(window.start, { month: undefined })}</h3><span>${t('{0} ski morning', formatDate(window.end, { month: undefined }))}</span></div></div><div class="night-amount"><strong>${amount}<small> ${weatherUnit('in')}</small></strong><span>${remaining ? t('Remaining {0}–6 am', formatTime(start)) : t('6 pm–6 am total')}${!fresh('forecast') ? t(' · stale/unavailable') : ''}</span></div><div class="night-level"><span>${t('SNOW LEVEL')}</span><strong>${fresh('nws') && level.complete ? t('{0}–{1} ft', Math.round(level.min / 100) * 100, Math.round(level.max / 100) * 100) : t('Unavailable / partial')}</strong></div><div class="night-confidence"><span class="tag ${status}">${status === 'below' ? t('Below target') : status === 'promising' ? t('Above target') : status === 'watch' ? t('Near target / mixed') : status === 'partial' ? t('Remaining hours only') : t('Needs data')}</span><span>${t('{0}/{1} complete models{2}', count, selected.length, remaining ? t(' · full total unknown') : '')}</span></div></article>`;
  }).join('');
}

function renderTable() {
  const chart = state.chart, step = state.days === 1 ? 1 : 3;
  el('forecast-table').innerHTML = `<div class="table-scroll"><table><caption>${t('{0} · {1} · Pacific time', t(METRICS[state.metric].label), state.days === 1 ? t('hourly') : t('every 3 hours'))}</caption><thead><tr><th scope="col">${t('Time')}</th>${chart.lines.map(line => `<th scope="col">${line.label}</th>`).join('')}</tr></thead><tbody>${chart.times.map((time, i) => i % step ? '' : `<tr><th scope="row">${formatDate(time, { month: undefined })} ${formatTime(time)}</th>${chart.lines.map(line => `<td>${valueLabel(line.values[i], state.metric)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

async function load(force = false) {
  if (state.loading) return;
  state.loading = true; el('refresh').disabled = true; el('refresh').classList.add('refreshing');
  try {
    const data = await fetchDashboard(force);
    state.selected = reconcileSelection(data.models, state.excluded);
    state.snapshot = data; state.refreshFailed = false; render();
  } catch {
    state.refreshFailed = true;
    render();
  } finally { state.loading = false; el('refresh').disabled = false; el('refresh').classList.remove('refreshing'); }
}

document.addEventListener('cloud10:languagechange', render);
document.addEventListener('cloud10:unitschange', render);
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.id === 'refresh' || button.hasAttribute('data-retry')) return load(true);
  if (button.dataset.days) { state.days = Number(button.dataset.days); render(); }
  if (button.dataset.metric) { state.metric = button.dataset.metric; render(); }
  if (button.id === 'table-toggle') { state.table = !state.table; el('forecast-table').hidden = !state.table; button.setAttribute('aria-expanded', String(state.table)); button.innerHTML = `${t('{0} data table', state.table ? t('Hide') : t('View'))} <span aria-hidden="true">${state.table ? '−' : '+'}</span>`; }
});
document.addEventListener('change', event => { if (event.target.dataset.model) { const input = event.target; input.checked ? state.excluded.delete(input.dataset.model) : state.excluded.add(input.dataset.model); state.selected = reconcileSelection(state.data.models, state.excluded); renderComparison(); } });
document.addEventListener('input', event => { if (event.target.id === 'inspect-time') inspect(Number(event.target.value)); });
load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5 * 60_000);
setInterval(() => {
  if (!state.snapshot || document.visibilityState !== 'visible') return;
  const aged = ageSnapshot(state.snapshot, Date.now());
  if (JSON.stringify(aged.sources) !== JSON.stringify(state.data.sources) || JSON.stringify(aged.advice) !== JSON.stringify(state.data.advice)) render();
}, 60_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.snapshot) { render(); load(); } });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.data) renderComparison(); }, 100); });
