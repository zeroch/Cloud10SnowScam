import { updateLanguageLinks } from './language-control.mjs';
import { t } from '/lib/i18n.mjs';
import { forecastWindow, comparisonSeries, METRICS } from '/lib/forecast.mjs';
import { ageSnapshot } from '/lib/display.mjs';
import { createDashboardClient } from '/lib/dashboard-client.mjs';
import { RESORT, getResort } from '/lib/config.mjs';
import { comparisonReturnUrl, forecastDetailUrl } from '/lib/navigation.mjs';
import * as view from './live-view.mjs';
import { drawComparison, metricValue } from './live-chart.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const key = 'stevens-live-forecast-v1';
const resortId = document.body.dataset.resort || RESORT.id;
const fetchDashboard = createDashboardClient({ resortId });
let saved = {};
try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch { /* Default controls remain usable without storage. */ }
const readNightChoice = () => new URL(location.href).searchParams.get('night') || 'auto';
const readHorizon = () => {
  const value = new URL(location.href).searchParams.get('view');
  return value === '3days' ? 3 : value === 'outlook' ? 5 : null;
};
const readComparisonDays = () => {
  const value = Number(new URL(location.href).searchParams.get('days'));
  return [1,3,5].includes(value) ? value : null;
};
function redirectRetiredForecastAnchor() {
  const url = new URL(location.href);
  const oldResortDetails = url.hash === '#horizon-details' && document.body.dataset.page === 'stevens';
  if (url.hash !== '#live-night-timing' && !oldResortDetails) return;
  url.hash = 'live-daily';
  const days = url.searchParams.get('compareDays');
  if (!url.searchParams.has('days') && ['3', '5'].includes(days)) url.searchParams.set('days', days);
  history.replaceState(history.state, '', url);
}

redirectRetiredForecastAnchor();
const state = { page: document.body.dataset.page, horizon: readHorizon(), nightChoice: readNightChoice(), days: readComparisonDays() || readHorizon() || ([1, 3, 5].includes(saved.days) ? saved.days : 3), metric: METRICS[saved.metric] ? saved.metric : 'snow', ids: [], excluded: Array.isArray(saved.excluded) ? saved.excluded : [], precipHours: saved.precipHours === 3 ? 3 : 6, precipField: saved.precipField === 'precipIn' ? 'precipIn' : 'snowIn', precipTotals: saved.precipTotals === true, precipPeriod: 'all', section: 'live-daily', index: 0, snapshot: null, loading: false, failure: false };
document.body.dataset.forecastView = state.page !== 'stevens' && state.horizon ? String(state.horizon) : 'tomorrow';
let active = false, chart, setCrosshair, resizeTimer, initialSectionOpened = false;
const renderers = { summary: view.summary, 'extended-outlook': view.extendedOutlook, 'morning-conditions': view.morningConditions, 'comparison-controls': view.comparisonControls, 'daily-forecast': view.daily, 'forecast-range': view.comparison, 'precipitation-by-model': view.precipitation, outlook: view.outlook, stations: view.stations };
let renderVersion = 0, sectionFrame;

function layoutContext() {
  document.documentElement.style.setProperty('--cloud-header-height', `${$('.clould-nav')?.getBoundingClientRect().height || 64}px`);
  document.documentElement.style.setProperty('--cloud-section-nav-height', `${$('.cloud-evidence-nav')?.getBoundingClientRect().height || 0}px`);
  const toolbar = $('#live-comparison');
  const height = toolbar?.getBoundingClientRect().height || 0;
  const tall = height > Math.min(240,innerHeight * .28);
  toolbar?.toggleAttribute('data-tall-controls',tall);
  document.documentElement.style.setProperty('--cloud-controls-height', `${tall ? 0 : height}px`);
  const dailyTable = $('.live-daily-desktop'), hint = $('.forecast-table-hint');
  if (dailyTable && hint) hint.hidden = dailyTable.scrollWidth <= dailyTable.clientWidth;
}

function updateSectionNavigation() {
  const header = $('.clould-nav')?.getBoundingClientRect().height || 64;
  const toolbarElement = $('#live-comparison'), toolbar = toolbarElement?.getBoundingClientRect();
  const sectionNav = $('.cloud-evidence-nav'), sectionNavBox = sectionNav?.getBoundingClientRect();
  const navHeight = sectionNavBox && getComputedStyle(sectionNav).position === 'sticky' && sectionNavBox.top <= header + 1 ? sectionNavBox.height : 0;
  const offset = header + navHeight + (toolbar && getComputedStyle(toolbarElement).position === 'sticky' && toolbar.top <= header + navHeight + 1 && toolbar.bottom > header ? toolbar.height : 0);
  const sections = ['live-overnight','live-extended','live-conditions','live-daily','live-models','live-precip'];
  const visible = sections.map(id => {
    const box = document.getElementById(id)?.getBoundingClientRect();
    return { id, height: box ? Math.max(0,Math.min(innerHeight,box.bottom)-Math.max(offset,box.top)) : 0 };
  }).sort((a,b)=>b.height-a.height);
  const current = visible[0]?.height ? visible[0].id : sections.filter(id => document.getElementById(id)?.getBoundingClientRect().top <= offset).at(-1) || 'live-overnight';
  const destination = current === 'live-precip' ? 'live-models' : current;
  $$('.cloud-evidence-nav a').forEach(link => { if (link.hash === '#' + destination) link.setAttribute('aria-current','location'); else link.removeAttribute('aria-current'); });
  if (['live-daily','live-models','live-precip'].includes(current)) state.section = current;
  if ($('#comparison-section')) $('#comparison-section').value = state.section;
}

function openSection(id) {
  const section = document.getElementById(id);
  if (!section) return;
  const url = new URL(location.href); url.hash = id;
  if (url.href !== location.href) history.pushState(null,'',url);
  section.scrollIntoView({block:'start'});
  const heading = section.querySelector('h1, h2');
  if (heading) { heading.tabIndex=-1; heading.focus({preventScroll:true}); }
  updateSectionNavigation();
}

function openHorizonDetails() {
  const details = $('#horizon-details');
  if (!details) return;
  details.open = true;
  details.scrollIntoView({ block: 'start' });
  $('#horizon-detail-date')?.focus({ preventScroll: true });
}

function selectHorizonNight(choice) {
  state.nightChoice = choice;
  const url = new URL(location.href); url.searchParams.set('night', choice); url.hash = 'horizon-details';
  if (url.href !== location.href) history.pushState(null, '', url);
  render(); requestAnimationFrame(openHorizonDetails);
}

function persist() {
  try { localStorage.setItem(key, JSON.stringify({ days: state.days, metric: state.metric, excluded: state.excluded, precipHours: state.precipHours, precipField: state.precipField, precipTotals: state.precipTotals })); } catch { /* Private browsing may disable persistence. */ }
}

function inspect(index, reveal = false) {
  state.index = Math.max(0, Math.min(index, chart.times.length - 1));
  const input = $('#live-inspect-time');
  if (input) { input.value = state.index; input.setAttribute('aria-valuetext',view.timestamp(chart.times[state.index])); }
  const label = $('#live-inspect-label');
  if (label) label.textContent = view.timestamp(chart.times[state.index]);
  const values = $('#live-inspect-values');
  if (values) values.innerHTML = chart.lines.map(line => `<div><span>${view.lineKey(line)}${view.escape(line.label)}</span><strong>${metricValue(line.values[state.index], state.metric)}</strong></div>`).join('');
  const periods = $$('[data-period-snow]'), time = chart.times[state.index];
  const period = periods.find(p => time >= Number(p.dataset.periodStart) && time < Number(p.dataset.periodEnd)) || periods.at(-1);
  periods.forEach(p => { p.dataset.inspected = String(p === period); });
  const pulseValue = $('#live-pulse-value');
  if (pulseValue) pulseValue.textContent = period?.dataset.periodDescription || '';
  setCrosshair?.(state.index);
  if (reveal && $('#chart-inspection')) {
    $('#chart-inspection').open = true;
    $('#chart-inspection').scrollIntoView({ block: 'nearest' });
  }
}

function render(trigger = null) {
  const back = $('#back-to-comparison');
  if (back) back.href = comparisonReturnUrl(location.href);
  if (!state.snapshot) {
    updateLanguageLinks();
    if (state.failure) $$('[data-live-slot]').forEach(slot => { slot.innerHTML = `<p class="live-warning" role="status">${t('Forecast unavailable. Cloud10 couldn’t load the forecast. Try again.')}</p><button class="live-retry cloud-secondary" data-live-refresh>${t('Try again')}</button>`; });
    return;
  }
  document.body.dataset.forecastView = state.page !== 'stevens' && state.horizon ? String(state.horizon) : 'tomorrow';
  const version = ++renderVersion;
  // Pointer activation need not focus buttons in every browser. Anchor explicitly
  // to the control the user changed, not a possibly unrelated activeElement.
  const candidate = trigger?.id ? trigger : document.activeElement;
  const anchor = candidate === document.body || candidate === document.documentElement ? null : candidate;
  const focus = anchor?.id;
  const focusTop = focus ? anchor.getBoundingClientRect().top : null;
  const visibleAnchor = focusTop >= 0 && focusTop < innerHeight;
  // A sticky setting cannot anchor the content below it: its own top never moves.
  const sectionAnchor = anchor?.closest?.('#live-comparison') ? document.getElementById(state.section) : null;
  const sectionTop = sectionAnchor?.getBoundingClientRect().top;
  const scrolls = new Map($$('[data-live-scroll]').map(element => [element.dataset.liveScroll, element.scrollLeft]));
  const openIds = new Set($$('.live-preserve-details[open]').map(d=>d.id));
  state.now = Date.now(); Object.assign(state, forecastWindow(state.now, state.days));
  state.precipPeriod = view.precipitationWindow(state).key;
  const data = ageSnapshot(state.snapshot, state.now);
  state.ids = data.models.filter(m => !state.excluded.includes(m.id)).map(m => m.id);
  $$('[data-live-slot]').forEach(slot => {
    const renderer = renderers[slot.dataset.liveSlot];
    if (renderer) {
      slot.innerHTML = renderer(data, state);
      if (state.failure) slot.insertAdjacentHTML('afterbegin', `<p class="live-warning" role="status">${t('Refresh failed. Showing the last response with its source timestamps.')}</p>`);
    }
  });
  // Preserve the comparison return context for normal and modified link clicks.
  $$('a[data-forecast-detail]').forEach(link => {
    link.href = forecastDetailUrl(location.href, link.href, resortId).href;
  });
  updateLanguageLinks();
  const container = $('#live-chart');
  if (container) {
    chart = comparisonSeries(data, state.ids, state.metric, state.start, state.end);
    state.index = Math.min(state.index, chart.times.length - 1);
    setCrosshair = drawComparison(container, chart, state.metric, state.index, inspect);
    inspect(state.index);
    $('#live-chart-table').innerHTML = `<table class="live-table"><thead><tr><th scope="col">${t('Pacific time')}</th>${chart.lines.map(l => `<th scope="col">${view.escape(l.label)}</th>`).join('')}</tr></thead><tbody>${chart.times.map((time, i) => `<tr><th scope="row">${view.timestamp(time)}</th>${chart.lines.map(line => `<td>${metricValue(line.values[i], state.metric)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  $$('[data-live-scroll]').forEach(element => { element.scrollLeft = scrolls.get(element.dataset.liveScroll) || 0; });
  $$('.live-preserve-details').forEach(element => { element.open = openIds.has(element.id); });
  for (const nav of $$('.tomorrow-horizons, .live-primary-metrics')) {
    const current = nav.querySelector('[aria-current], [aria-pressed="true"]');
    if (!current || nav.scrollWidth <= nav.clientWidth) continue;
    const navBox = nav.getBoundingClientRect(), buttonBox = current.getBoundingClientRect();
    if (buttonBox.right > navBox.right) nav.scrollLeft += buttonBox.right - navBox.right;
    else if (buttonBox.left < navBox.left) nav.scrollLeft -= navBox.left - buttonBox.left;
  }
  layoutContext();
  const restore = () => {
    if (version !== renderVersion) return;
    const element = focus && document.getElementById(focus);
    if (element) {
      element.focus({preventScroll:true});
      if (sectionAnchor) window.scrollBy(0,sectionAnchor.getBoundingClientRect().top-sectionTop);
      else if (visibleAnchor) window.scrollBy(0,element.getBoundingClientRect().top-focusTop);
    }
    updateSectionNavigation();
  };
  restore(); requestAnimationFrame(restore);
}

async function refresh(force = false) {
  if (state.loading) return;
  const trigger = document.activeElement?.matches('[data-live-refresh]') ? document.activeElement : null;
  state.loading = true;
  $$('[data-live-refresh]').forEach(button => { button.disabled = true; button.textContent = t('Refreshing…'); });
  try {
    const data = await fetchDashboard(force);
    if (!Array.isArray(data.models) || !Array.isArray(data.sources) || !Array.isArray(data.stations) || !data.resort) throw new Error('Dashboard response incomplete');
    state.snapshot = data; state.failure = false;
  } catch {
    state.failure = true;
  } finally {
    state.loading = false;
    // Disabling the refresh button can blur it. Restore only that lost focus;
    // a user who moved to another control during the request keeps their place.
    render(document.activeElement === document.body ? trigger : null);
    // Deep links must land after async forecasts establish each section's position.
    if (state.snapshot && !initialSectionOpened) {
      initialSectionOpened = true;
      const section = location.hash.slice(1);
      if (section === 'horizon-details') openHorizonDetails();
      else if (['live-overnight','live-conditions','live-extended','live-daily','live-models','live-precip'].includes(section)) openSection(section);
    }
  }
}

export function startLive() {
  if (active || !document.body.dataset.live) return;
  active = true;
  document.addEventListener('cloud10:languagechange', () => render());
  document.addEventListener('cloud10:unitschange', () => render());
  const back = $('#back-to-comparison');
  if (back) back.href = comparisonReturnUrl(location.href);
  updateLanguageLinks();
  document.addEventListener('click', event => {
    const sectionLink = event.target.closest('.cloud-evidence-nav a, .cloud-section-jump, a[href="#live-comparison"]');
    if (sectionLink && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
      event.preventDefault();
      if (sectionLink.hash === '#live-comparison') {
        $('#live-comparison')?.scrollIntoView({block:'start'});
        $(`#compare-days-${state.days}`)?.focus({preventScroll:true});
      } else openSection(sectionLink.hash.slice(1));
      return;
    }
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.tomorrowHorizon) {
      state.horizon = state.days = Number(button.dataset.tomorrowHorizon); state.index = 0; persist();
      state.nightChoice = 'auto';
      const url = new URL(location.href); url.searchParams.set('view', state.horizon === 3 ? '3days' : 'outlook'); url.searchParams.set('days', String(state.horizon)); url.searchParams.delete('night'); url.hash = 'live-overnight';
      if (url.href !== location.href) history.pushState(null, '', url);
      render(button); requestAnimationFrame(() => openSection('live-overnight'));
    }
    else if (button.hasAttribute('data-tomorrow-home')) {
      state.horizon = null; state.nightChoice = 'tonight';
      const url = new URL(location.href); url.searchParams.delete('view'); url.searchParams.set('night', 'tonight'); url.hash = 'live-overnight';
      history.pushState(null, '', url); render(button); requestAnimationFrame(() => openSection('live-overnight'));
    }
    else if (button.dataset.horizonNight) selectHorizonNight(button.dataset.horizonNight);
    else if (button.hasAttribute('data-night-details')) {
      const details = $('.cloud-night-details'); details.open = true;
      details.querySelector('summary').focus(); details.scrollIntoView({ block: 'start' });
    }
    else if (button.dataset.nightChoice) {
      state.nightChoice = button.dataset.nightChoice;
      const url = new URL(location.href); url.searchParams.set('night', state.nightChoice);
      history.pushState(null, '', url); render(button);
    }
    else if (button.dataset.liveDays) {
      state.days = Number(button.dataset.liveDays); state.index = 0; persist();
      const url = new URL(location.href); url.searchParams.set('days', String(state.days)); history.replaceState(null, '', url);
      render(button);
    }
    else if (button.dataset.liveMetric) { state.metric = button.dataset.liveMetric; persist(); render(button); }
    else if (button.dataset.precipHours) { state.precipHours = Number(button.dataset.precipHours); persist(); render(button); }
    else if (button.dataset.precipField) { state.precipField = button.dataset.precipField; persist(); render(button); }
    else if (button.dataset.precipMode) { state.precipTotals = button.dataset.precipMode === 'totals'; persist(); render(button); }
    else if (button.dataset.precipStep) {
      const window = view.precipitationWindow(state), index = window.periods.findIndex(p=>p.key===window.key);
      const next = window.periods[index + Number(button.dataset.precipStep)];
      if (next) { state.precipPeriod = next.key; render(button); }
    }
    else if (button.hasAttribute('data-live-all')) { state.excluded=[]; persist(); render(button); }
    else if (button.hasAttribute('data-models-close')) { const menu = button.closest('.live-model-menu'); menu.open=false; menu.querySelector('summary').focus({preventScroll:true}); }
    else if (button.hasAttribute('data-live-refresh')) refresh(true);
  });
  document.addEventListener('change', event => {
    if (event.target.matches('[data-resort-select]')) {
      const resort = getResort(event.target.value);
      if (!resort) return;
      const url = new URL(location.href);
      if (url.pathname.startsWith('/location/')) { url.pathname = `/location/${resort.id}/snow-summary`; url.searchParams.delete('resort'); }
      else url.searchParams.set('resort', resort.id);
      url.hash = 'live-overnight';
      location.assign(url);
      return;
    }
    if (event.target.matches('[data-horizon-detail-date]')) selectHorizonNight(event.target.value);
    else if (event.target.matches('[data-comparison-days]')) {
      state.days = Number(event.target.value); state.index = 0; persist();
      const url = new URL(location.href); url.searchParams.set('days', String(state.days)); history.replaceState(null, '', url);
      render(event.target);
    } else if (event.target.matches('[data-live-model]')) {
      const id = event.target.value;
      if (id !== 'custom') state.excluded = state.snapshot.models.filter(m => id !== 'all' && m.id !== id).map(m => m.id);
      persist(); render(event.target);
    } else if (event.target.matches('[data-live-toggle]')) {
      const id = event.target.dataset.liveToggle;
      state.excluded = event.target.checked ? state.excluded.filter(value => value !== id) : [...new Set([...state.excluded, id])];
      persist(); render(event.target);
    } else if (event.target.matches('[data-precip-period]')) {
      state.precipPeriod=event.target.value; render(event.target);
    } else if (event.target.id === 'comparison-section') {
      openSection(event.target.value);
    }
  });
  document.addEventListener('input', event => { if (event.target.id === 'live-inspect-time') inspect(Number(event.target.value)); });
  document.addEventListener('snow:layout', () => {
    // Favorites edit replaces pageContent. Rehydrate that new summary slot only.
    if ($('[data-live-slot="summary"]') && !$('#night-headline')) render();
  });
  document.fonts?.ready.then(layoutContext);
  window.addEventListener('resize', () => { layoutContext(); clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
  window.addEventListener('scroll',()=>{ cancelAnimationFrame(sectionFrame); sectionFrame=requestAnimationFrame(updateSectionNavigation); },{passive:true});
  document.addEventListener('keydown',event=>{
    const menu = event.target.closest?.('.live-model-menu[open]');
    if (event.key==='Escape' && menu) { menu.open=false; menu.querySelector('summary').focus({preventScroll:true}); }
  });
  window.addEventListener('popstate', () => {
    redirectRetiredForecastAnchor();
    state.horizon = readHorizon(); state.nightChoice = readNightChoice();
    if (state.horizon || readComparisonDays()) state.days = readComparisonDays() || state.horizon;
    render();
    if (location.hash === '#horizon-details') openHorizonDetails();
    else if (['#live-overnight','#live-conditions','#live-extended','#live-daily','#live-models','#live-precip'].includes(location.hash)) openSection(location.hash.slice(1));
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); refresh(); } });
  setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60_000);
  setInterval(() => { if (!document.hidden) render(); }, 60_000);
  refresh();
}
