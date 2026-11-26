import { updateLanguageLinks } from './language-control.mjs';
import { t } from '/lib/i18n.mjs';
import { buildResortComparison, createResortComparisonClient } from '/lib/resort-comparison.mjs';
import { renderComparison } from './resort-comparison-view.mjs';

const root = document.getElementById('resort-comparison');
let entries = {}, options;
function readUrl() {
  const url = new URL(location.href);
  options = { days: url.searchParams.get('view') === 'outlook' ? 5 : url.searchParams.get('view') === '3days' ? 3 : 1,
    nightChoice: url.searchParams.get('night') };
}
function render() {
  const active = document.activeElement, focusId = root.contains(active) ? active.id : null;
  const open = new Set([...root.querySelectorAll('details[open]')].map(d => d.id));
  const board = buildResortComparison(entries, Date.now(), options);
  root.innerHTML = renderComparison(board);
  updateLanguageLinks(root);
  for (const id of open) { const details = document.getElementById(id); if (details) details.open = true; }
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  document.getElementById('comparison-status').textContent = board.rows.some(r => r.loading)
    ? t('Loading forecasts') : board.rows.some(r => r.failed) ? t('Some forecasts could not refresh. Available forecasts are shown.') : '';
}
const refresh = createResortComparisonClient({ onUpdate: data => { entries = data; render(); } });
root.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-compare-refresh')) { if (button.getAttribute('aria-disabled') !== 'true') refresh(true); return; }
  if (!button.dataset.compareDays && !button.dataset.compareNight) return;
  const url = new URL(location.href);
  if (button.dataset.compareDays) {
    const days = Number(button.dataset.compareDays);
    if (days === 1) { url.searchParams.delete('view'); url.searchParams.delete('days'); }
    else { url.searchParams.set('view', days === 3 ? '3days' : 'outlook'); url.searchParams.set('days', String(days)); }
    url.searchParams.delete('night');
  } else url.searchParams.set('night', button.dataset.compareNight);
  url.hash = 'live-overnight';
  if (url.href !== location.href) history.pushState(null, '', url);
  readUrl(); render();
});
const menu = document.getElementById('compare-menu'), links = document.getElementById('compare-menu-links');
menu.addEventListener('click', () => { const open = menu.getAttribute('aria-expanded') !== 'true'; menu.setAttribute('aria-expanded', String(open)); links.hidden = !open; });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !links.hidden) { links.hidden = true; menu.setAttribute('aria-expanded','false'); menu.focus(); } });
document.addEventListener('cloud10:languagechange', render);
window.addEventListener('popstate', () => { readUrl(); render(); });
window.addEventListener('pageshow', event => { if (event.persisted) { readUrl(); render(); refresh(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); refresh(); } });
setInterval(() => { if (!document.hidden) render(); }, 60_000);
setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60_000);
readUrl(); refresh();
