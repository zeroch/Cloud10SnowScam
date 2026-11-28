import { updateLanguageLinks } from './language-control.mjs';
import { t } from '/lib/i18n.mjs';
import { buildResortComparison, buildResortTimeline, createResortComparisonClient } from '/lib/resort-comparison.mjs';
import { comparisonStage } from '/lib/navigation.mjs';
import { rangeLabel, renderComparison, renderTimelineDetail } from './resort-comparison-view.mjs';

const root = document.getElementById('resort-comparison');
let entries = {}, options, timelineBoard, selectedDay;

function readUrl() {
  const params = new URL(location.href).searchParams;
  const view = params.get('view');
  const mode = view === '15d' ? '15d' : 'am';
  const days = view === 'outlook' ? 5 : view === '3days' ? 3 : 1;
  options = { mode, days, nightChoice: params.get('night'), stage: comparisonStage(params.get('stage')) };
}

const scrollport = () => root.querySelector('#timeline-scroll');
const stageWidth = viewport => (viewport.scrollWidth - viewport.clientWidth) / 2;

function showTimelineStage(viewport) {
  const scrollable = stageWidth(viewport) > 1;
  for (const range of viewport.querySelectorAll('[data-timeline-range]')) {
    range.inert = scrollable && Number(range.dataset.timelineRange) !== options.stage;
  }
  const label = rangeLabel(timelineBoard.blocks[options.stage - 1]);
  const tag = root.querySelector('#timeline-current-range');
  if (tag.textContent !== label) tag.textContent = label;
}

function restoreTimelinePosition() {
  const viewport = scrollport();
  if (!viewport) return;
  const width = stageWidth(viewport);
  if (width > 1) viewport.scrollLeft = width * (options.stage - 1);
  showTimelineStage(viewport);
}

function recordTimelineStage(viewport) {
  const width = stageWidth(viewport);
  if (width <= 1) return;
  const stage = comparisonStage(Math.round(viewport.scrollLeft / width) + 1);
  if (stage === options.stage) return;
  options.stage = stage;
  showTimelineStage(viewport);
  const url = new URL(location.href);
  if (stage === 1) url.searchParams.delete('stage');
  else url.searchParams.set('stage', String(stage));
  history.replaceState(history.state, '', url);
  for (const link of viewport.querySelectorAll('[data-timeline-link]')) {
    const detail = new URL(link.href);
    detail.searchParams.set('compareStage', String(stage));
    link.href = detail.pathname + detail.search + detail.hash;
  }
}

function configureTimeline(viewport) {
  if (!viewport) return;
  restoreTimelinePosition();
  viewport.addEventListener('scroll', () => recordTimelineStage(viewport), { passive: true });
  viewport.addEventListener('keydown', event => {
    const width = stageWidth(viewport);
    if (event.target !== viewport || width <= 1 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.round(viewport.scrollLeft / width);
    const next = { ArrowLeft: Math.max(0, current - 1), ArrowRight: Math.min(2, current + 1), Home: 0, End: 2 }[event.key];
    viewport.scrollLeft = width * next;
  });
}

function render() {
  const active = document.activeElement, focusId = root.contains(active) ? active.id : null;
  const open = new Set([...root.querySelectorAll('details[open]')].map(d => d.id));
  const now = Date.now();
  const timeline = options.mode === '15d';
  const board = timeline ? buildResortTimeline(entries, now, options) : buildResortComparison(entries, now, options);
  if (timeline && timelineBoard?.days[0].calendarStart !== board.days[0].calendarStart) selectedDay = null;
  timelineBoard = timeline ? board : null;
  document.body.dataset.compareMode = options.mode;
  root.innerHTML = renderComparison(board, selectedDay);
  updateLanguageLinks(root);
  configureTimeline(scrollport());
  for (const id of open) { const details = document.getElementById(id); if (details) details.open = true; }
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  document.getElementById('comparison-status').textContent = board.rows.some(r => r.loading)
    ? t('Loading forecasts') : board.rows.some(r => r.failed) ? t('Some forecasts could not refresh. Available forecasts are shown.') : '';
}

function changeDayDetail(button) {
  const current = root.querySelector('.timeline-day[aria-expanded="true"]');
  current?.setAttribute('aria-expanded', 'false');
  selectedDay = current === button ? null : { resortId: button.dataset.timelineResort, index: Number(button.dataset.timelineDay) };
  if (selectedDay) button.setAttribute('aria-expanded', 'true');
  const panel = root.querySelector('#timeline-day-detail');
  panel.innerHTML = renderTimelineDetail(timelineBoard, selectedDay);
  panel.hidden = !selectedDay;
  if (selectedDay) panel.scrollIntoView({ block: 'nearest' });
}

const refresh = createResortComparisonClient({ onUpdate: data => { entries = data; render(); } });
root.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-compare-refresh')) { if (button.getAttribute('aria-disabled') !== 'true') refresh(true); return; }
  if (button.hasAttribute('data-timeline-day')) { changeDayDetail(button); return; }
  const url = new URL(location.href);
  const params = url.searchParams;
  const view = button.dataset.compareView;
  if (view) {
    if (view === options.mode && options.days === 1) return;
    selectedDay = null;
    for (const key of ['view', 'days', 'night', 'stage']) params.delete(key);
    if (view === '15d') params.set('view', '15d');
  } else if (button.dataset.compareNight) params.set('night', button.dataset.compareNight);
  else return;
  url.hash = 'live-overnight';
  if (url.href !== location.href) history.pushState(null, '', url);
  readUrl(); render();
  if (view) document.getElementById(button.id).scrollIntoView({ block: 'nearest' });
});
const menu = document.getElementById('compare-menu'), links = document.getElementById('compare-menu-links');
menu.addEventListener('click', () => { const open = menu.getAttribute('aria-expanded') !== 'true'; menu.setAttribute('aria-expanded', String(open)); links.hidden = !open; });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !links.hidden) { links.hidden = true; menu.setAttribute('aria-expanded','false'); menu.focus(); } });
document.addEventListener('cloud10:languagechange', render);
document.addEventListener('cloud10:unitschange', render);
window.addEventListener('popstate', () => { selectedDay = null; readUrl(); render(); });
window.addEventListener('resize', restoreTimelinePosition);
window.addEventListener('pageshow', event => { if (event.persisted) { readUrl(); render(); refresh(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); refresh(); } });
setInterval(() => { if (!document.hidden) render(); }, 60_000);
setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60_000);
readUrl(); refresh();
