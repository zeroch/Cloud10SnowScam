import { startLive } from './live.mjs';
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const fragment = html => new DOMParser().parseFromString(html, 'text/html').body.firstElementChild;
const page = document.body.dataset.page;
const states = await fetch('/clone/states.json').then(response => response.json());
const initialContent = $('#pageContent').outerHTML;
let preferences;
try { preferences = JSON.parse(localStorage.getItem('clould10-ui-v1') || '{}'); } catch { preferences = {}; }
let listName = preferences.listName || 'Winter';
let removed = new Set(preferences.removed || []);
let order = preferences.order || states.locations.map(location => location.id);
let locationType = 'All', sortBy = 'Your Order', editing = false, modal = null, lastFocus = null;
let toastTimer;
let selectedLocations = new Set(), editToolbar = '', uncheckedIcon = '';
const closeIcon = fragment(states.lists).querySelector('button').innerHTML;

function persist() {
  try { localStorage.setItem('clould10-ui-v1', JSON.stringify({ listName, removed: [...removed], order })); } catch { /* In-memory edits still work without storage. */ }
}
function toast(message, undo) {
  $('.clone-toast')?.remove(); clearTimeout(toastTimer);
  const element = document.createElement('div'); element.className = 'clone-toast'; element.setAttribute('role', 'status'); element.textContent = message;
  if (undo) { const button = document.createElement('button'); button.textContent = 'Undo'; button.style.cssText = 'margin-left:16px;text-decoration:underline'; button.onclick = () => { undo(); element.remove(); }; element.append(button); }
  document.body.append(element); toastTimer = setTimeout(() => element.remove(), 5500);
}
function updateName() {
  $$('.SelectFavoriteListDropdown__selectFavoriteListActiveListName').forEach(element => { element.textContent = listName; });
}
function arrangeCards() {
  const rows = $$('[data-location-row]');
  const byId = Object.fromEntries(states.locations.map(location => [location.id, location]));
  const rank = id => order.indexOf(id);
  const sortTotal = { 'Last 24 Hours': 3, 'Next 24 hours': 4, 'Next 5 Days': 4, 'Next 6-10 Days': 5, 'Next 11-15 Days': 6, 'Prev 5 Days': 2 };
  rows.sort((a, b) => {
    const left = byId[a.dataset.locationRow], right = byId[b.dataset.locationRow];
    if (sortBy === 'A-Z') return left.name.localeCompare(right.name);
    if (sortBy === 'Area Open') return Number(right.open) - Number(left.open) || rank(left.id) - rank(right.id);
    if (sortBy in sortTotal) return (right.totals[sortTotal[sortBy]] || 0) - (left.totals[sortTotal[sortBy]] || 0);
    if (sortBy.includes('Days')) {
      const total = loc => sortBy.startsWith('Next') ? loc.totals.slice(4, sortBy.includes('10') ? 6 : 7).reduce((a, b) => a + b, 0) : loc.totals.slice(sortBy.includes('10') ? 1 : 0, 3).reduce((a, b) => a + b, 0);
      return total(right) - total(left);
    }
    return rank(left.id) - rank(right.id);
  });
  rows.forEach(row => {
    const item = byId[row.dataset.locationRow];
    row.hidden = removed.has(item.id) || (locationType !== 'All' && item.type !== locationType);
    row.parentElement.append(row);
  });
}
function layout(resetScroll = false) {
  const root = $('#root');
  root.style.setProperty('--vh', `${innerHeight / 100}px`);
  root.style.setProperty('--scrollbar-width', `${innerWidth - document.documentElement.clientWidth}px`);
  $$('.SelectFavoriteListDropdown__selectFavoriteListActiveListName').forEach(element=>{element.tabIndex=0;element.setAttribute('role','button');element.setAttribute('aria-label','Choose favorite list');});
  updateName();
  document.dispatchEvent(new Event('snow:layout'));
}

function closeModal() {
  modal?.remove(); modal = null; $('.clone-backdrop')?.remove(); document.body.style.overflow = ''; lastFocus?.focus({ preventScroll: true });
}
function showModal(html, kind = 'lists', trigger = document.activeElement) {
  closeModal(); lastFocus = trigger;
  const backdrop = document.createElement('div'); backdrop.className = 'clone-backdrop'; backdrop.onclick = closeModal;
  modal = document.createElement('section'); modal.className = 'clone-modal'; modal.dataset.kind = kind; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', kind === 'filter' ? 'Filter and sort locations' : 'Favorite Lists'); modal.innerHTML = html;
  if (kind === 'filter') {
    modal.classList.add('clone-filter');
    const close = document.createElement('button'); close.className = 'clone-sheet-close tw-text-gray-400'; close.innerHTML = closeIcon; close.setAttribute('aria-label', 'Close filters'); close.style.cssText = 'width:24px;height:24px'; close.onclick = closeModal;
    if (innerWidth < 992) modal.prepend(close);
    else { const rect = trigger.getBoundingClientRect(); modal.style.cssText = `left:${rect.left + 8}px;top:${rect.bottom + 4}px;transform:none;max-height:${innerHeight - rect.bottom - 12}px`; }
    $$('button', modal).forEach(button => button.classList.toggle('Button__active', button.textContent.trim() === locationType));
    $$('input[type="radio"]', modal).forEach(input => { input.checked = radioText(input) === sortBy; });
  }
  document.body.append(backdrop, modal); document.body.style.overflow = 'hidden';
  if (kind === 'lists') {
    $('button', modal).setAttribute('aria-label', 'Close lists');
    $$('button', modal).forEach(button => {
      const text = button.textContent.trim();
      if (text === 'Winter') button.textContent = listName;
      button.onclick = () => {
        if (text === 'Summer' || text === 'Add New List') { toast('Your saved list is available on this device.'); return; }
        closeModal();
      };
    });
  }
  $('button,input', modal)?.focus({ preventScroll: true });
}
function radioText(input) {
  const label = input.closest('label') || input.parentElement;
  return label.textContent.trim();
}

function editList(active) {
  editing = active;
  selectedLocations.clear();
  $('#pageContent').replaceWith(fragment(active ? states.edit : initialContent));
  if (active) {
    editToolbar = $('.BulkEditToolbar__stickyTop').outerHTML;
    uncheckedIcon = $('.js-bulk-edit-checkbox').innerHTML;
    $$('[data-edit-location]').forEach(row => { row.hidden = removed.has(row.dataset.editLocation); row.draggable = true; });
    // Only configured resorts belong in the editable list.
    const editListElement = $('[data-edit-location]')?.parentElement;
    if (editListElement) $$(':scope > li', editListElement).filter(row => !row.dataset.editLocation).forEach(row => { row.hidden = true; });
    $$('[data-edit-location]').sort((a,b) => order.indexOf(a.dataset.editLocation) - order.indexOf(b.dataset.editLocation)).forEach(row => row.parentElement.append(row));
    updateSelection();
  } else arrangeCards();
  layout(true);
}
function updateSelection() {
  $('.BulkEditToolbar__stickyTop')?.replaceWith(fragment(selectedLocations.size ? states.selectionToolbar : editToolbar));
  const clear = $$('.BulkEditToolbar__stickyTop a').find(link => link.textContent.trim() === 'Clear Selection');
  if (clear) { clear.href = '#'; clear.dataset.clearSelection = 'true'; }
  $$('[data-edit-location]').forEach(row => {
    const active = selectedLocations.has(row.dataset.editLocation), check = $('.js-bulk-edit-checkbox',row);
    check.innerHTML = active ? states.selectedCheck : uncheckedIcon; check.tabIndex = 0; check.setAttribute('role','checkbox'); check.setAttribute('aria-checked',String(active)); check.setAttribute('aria-label',`Select ${$('.js-bulk-edit-row-name',row).textContent}`);
    row.firstElementChild.classList.toggle('card-alt-background-color',active); row.firstElementChild.classList.toggle('card-background-color',!active);
    $('.js-bulk-edit-delete',row)?.remove();
    if (active) { const remove = fragment(states.selectedRemove); remove.setAttribute('aria-label',`Remove ${$('.js-bulk-edit-row-name',row).textContent}`); row.firstElementChild.lastElementChild.before(remove); }
    $('.BulkEditRow__deleteButton',row).tabIndex = -1;
  });
}
function removeLocations(ids) {
  ids.forEach(id=>removed.add(id)); persist(); editList(true);
  toast('Locations removed from this local list.',()=>{ids.forEach(id=>removed.delete(id));persist();editList(true);});
}
function renameList() {
  const editor = $$('#pageHeaderBottomRow #listNameEditor').at(-1) || $$('#listNameEditor').at(-1);
  const original = editor.outerHTML;
  const form = fragment(states.rename); editor.replaceWith(form);
  const input = $('input', form); input.value = listName; input.focus(); input.select();
  const [save, cancel] = $$('a', form);
  save.href = '#'; cancel.href = '#';
  const commit = () => { if (!input.value.trim()) return; listName = input.value.trim().slice(0, 60); persist(); form.replaceWith(fragment(original)); updateName(); };
  save.onclick = event => { event.preventDefault(); commit(); };
  cancel.onclick = event => { event.preventDefault(); form.replaceWith(fragment(original)); };
  input.onkeydown = event => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') { form.replaceWith(fragment(original)); } };
}
function addLocations() {
  const dialog = fragment(states.add); dialog.classList.add('clone-dialog'); document.body.append(dialog); dialog.showModal();
  const close = () => { dialog.close(); dialog.remove(); };
  $('button', dialog).onclick = close;
  dialog.addEventListener('cancel', () => dialog.remove());
  const input = $('input[type="search"]', dialog); input.removeAttribute('readonly'); input.setAttribute('aria-label', 'Search locations'); input.placeholder = 'Search locations';
  const commit = $$('button', dialog).find(button => button.textContent.trim() === 'Add Locations');
  let selected;
  const options = document.createElement('div'); options.className = 'clone-results'; options.style.cssText = 'position:relative;margin:4px 0;box-shadow:none'; input.closest('[role="combobox"]').after(options);
  input.oninput = () => {
    selected = null; commit.disabled = true; options.replaceChildren();
    states.locations.filter(location => location.name.toLowerCase().includes(input.value.trim().toLowerCase())).slice(0, 6).forEach(location => {
      const button = document.createElement('button'); button.textContent = location.name; button.onclick = () => { selected = location; input.value = location.name; options.replaceChildren(); commit.disabled = false; }; options.append(button);
    });
  };
  commit.onclick = () => { if (!selected) return; removed.delete(selected.id); persist(); close(); editList(true); };
  input.focus();
}

document.addEventListener('click', event => {
  const target = event.target;
  const button = target.closest('button');
  const text = button?.textContent.trim();
  const check = target.closest('.js-bulk-edit-checkbox');
  if (editing && check) { const id=check.closest('[data-edit-location]').dataset.editLocation; selectedLocations.has(id)?selectedLocations.delete(id):selectedLocations.add(id); updateSelection(); return; }
  if (editing && target.closest('[data-clear-selection]')) { event.preventDefault(); selectedLocations.clear(); updateSelection(); return; }
  if (editing && button?.classList.contains('js-bulk-edit-delete')) { removeLocations([button.closest('[data-edit-location]').dataset.editLocation]); return; }
  if (editing && button?.closest('.BulkEditToolbar__stickyTop')) {
    if (text?.startsWith('Delete')) { removeLocations([...selectedLocations]); return; }
    if (text === 'Move to Top' || text === 'Move to Bottom') { const selected=order.filter(id=>selectedLocations.has(id)), rest=order.filter(id=>!selectedLocations.has(id));order=text==='Move to Top'?[...selected,...rest]:[...rest,...selected];persist();editList(true);return; }
    if (text?.includes('Another List')) { toast('Your saved list is available on this device.'); return; }
  }
  if (button?.classList.contains('clould-menu')) {
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(expanded)); $('#clould-nav-links').classList.toggle('is-open', expanded); return;
  }
  if (target.closest('.clould-nav a')) {
    $('#clould-nav-links').classList.remove('is-open');
    $('button.clould-menu').setAttribute('aria-expanded', 'false');
  }
  if (button?.dataset.filter) { showModal(states.filter, 'filter', button); return; }
  if (button?.closest('#pageHeader')) {
    if (text === 'Edit') { editList(true); return; }
    if (text === 'Done') { persist(); editList(false); return; }
    if (text === 'Rename List') { renameList(); return; }
    if (text === 'Delete List') { toast('Individual locations can be removed and restored from this list.'); return; }
  }
  if (button && editing && text === 'Add Locations') { addLocations(); return; }
  if (button && editing && text === 'Remove') {
    const row = button.closest('[data-edit-location]'); if (!row) return; const id = row.dataset.editLocation;
    removed.add(id); row.hidden = true; persist(); toast('Location removed from this local list.', () => { removed.delete(id); persist(); editList(true); }); return;
  }
  if (target.closest('.SelectFavoriteListDropdown__selectFavoriteListActiveListName')) { showModal(states.lists); return; }
  if (button && modal?.dataset.kind === 'filter' && modal.contains(button)) {
    if (['All', 'Ski Resort', 'Heli Ski Operation', 'Cat Ski Operation', 'City'].includes(text)) {
      locationType = text; $$('button', modal).forEach(item => item.classList.toggle('Button__active', item === button)); arrangeCards(); return;
    }
  }
});
document.addEventListener('change', event => {
  if (event.target.matches('input[type="radio"]') && modal?.dataset.kind === 'filter') {
    sortBy = radioText(event.target); arrangeCards();
  }
});
document.addEventListener('input', event => {
  const input = event.target;
  if (!input.matches('nav input[type="search"]')) return;
  $('nav .clone-results')?.remove();
  const query = input.value.trim().toLowerCase(); if (!query) return;
  const results = document.createElement('div'); results.className = 'clone-results'; results.setAttribute('role', 'listbox');
  states.locations.filter(location => location.name.toLowerCase().includes(query)).slice(0, 7).forEach(location => {
    const link = document.createElement('a'); link.textContent = location.name; link.href = location.href; if (location.id !== 'stevenspass') { link.target = '_blank'; link.rel = 'noopener'; } results.append(link);
  });
  if (!results.children.length) { const message = document.createElement('p'); message.textContent = 'No matching locations'; results.append(message); }
  input.closest('.tw-relative').append(results);
});
let dragged;
document.addEventListener('dragstart', event => { dragged = event.target.closest('[data-edit-location]'); dragged?.classList.add('clone-dragging'); });
document.addEventListener('dragover', event => { if (event.target.closest('[data-edit-location]') && dragged) event.preventDefault(); });
document.addEventListener('drop', event => {
  const target = event.target.closest('[data-edit-location]'); if (!target || !dragged) return; event.preventDefault(); target.before(dragged); order = $$('[data-edit-location]').map(row => row.dataset.editLocation); persist();
});
document.addEventListener('dragend', () => { dragged?.classList.remove('clone-dragging'); dragged = null; });
document.addEventListener('keydown', event => {
  if (event.target.matches('.SelectFavoriteListDropdown__selectFavoriteListActiveListName') && ['Enter',' '].includes(event.key)) { event.preventDefault(); showModal(states.lists); }
  if (event.target.matches('.js-bulk-edit-checkbox') && ['Enter',' '].includes(event.key)) { event.preventDefault(); event.target.click(); }
  if (event.key === 'Escape') {
    closeModal(); $$('.clone-results').forEach(element => element.remove());
    $('#clould-nav-links')?.classList.remove('is-open'); $('button.clould-menu')?.setAttribute('aria-expanded', 'false');
    $('dialog[open]')?.close();
  }
  const activeDialog = modal;
  if (activeDialog && event.key === 'Tab') {
    const focusable = $$('button,a[href],input,[tabindex="0"]', activeDialog).filter(element => !element.disabled && element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
window.addEventListener('resize', () => layout(true));
arrangeCards(); layout(true);
await document.fonts.ready;
layout(true);
startLive();
