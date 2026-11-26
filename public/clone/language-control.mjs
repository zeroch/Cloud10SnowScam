import { chooseLanguage, displayLanguage, setDisplayLanguage, supportedLanguage, t, displayUnits, overnightTarget, setDisplayUnits } from '/lib/i18n.mjs';
import { getResort } from '/lib/config.mjs';
import chinese from './zh-CN.mjs';

const storageKey = 'cloud10-language';
const unitsKey = 'cloud10-units';
const pageLanguage = () => new URL(location.href).searchParams.get('lang');
let saved;
try { saved = localStorage.getItem(storageKey); } catch { /* The URL also carries the choice. */ }
const preferred = () => chooseLanguage(pageLanguage(), saved, navigator.languages);

// Only the initial, server-rendered shell is bound here. Forecast components
// translate their own messages each time they render.
function bindShell() {
  const resort = getResort(document.body.dataset.resort);
  const height = resort.elevationFt.toLocaleString('en-US');
  const point = resort.pointLabel + ' ' + height + ' ft';
  const bindings = [];
  function bind(source, write) {
    const text = source.trim();
    if (!text) return;
    const key = Object.hasOwn(chinese, text) ? text : text.replace(point, '{1}').replace(resort.name, '{0}');
    if (!Object.hasOwn(chinese, key)) return;
    bindings.push(() => {
      const localized = displayLanguage === 'en' ? text : t(key, resort.name, t('{0} {1} ft', t(resort.pointLabel), height));
      write(source.replace(text, () => localized));
    });
  }
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // The wordmark contains “Cloud”, which is also a weather table heading.
    if (node.parentElement.closest('script, style, noscript, .compare-wordmark, .clould-wordmark, .brand, [translate="no"]')) continue;
    bind(node.data, value => { node.data = value; });
  }
  for (const element of document.querySelectorAll('[aria-label], [title], [alt], meta[name="description"]')) {
    for (const attr of ['aria-label', 'title', 'alt', 'content']) {
      if (element.hasAttribute(attr)) bind(element.getAttribute(attr), value => element.setAttribute(attr, value));
    }
  }
  return () => bindings.forEach(update => update());
}

export function updateLanguageLinks(root = document) {
  const lang = supportedLanguage(pageLanguage());
  if (!lang) return;
  for (const link of root.querySelectorAll('a[href]')) {
    if (link.getAttribute('href').startsWith('#')) continue;
    const url = new URL(link.href);
    if (url.origin !== location.origin) continue;
    url.searchParams.set('lang', lang);
    link.href = url.href;
  }
}

const updateShell = bindShell();
const preferences = document.createElement('div');
preferences.className = 'forecast-preferences';
const languageButton = preferenceButton('forecast-language', changeLanguage);
const temperature = preferenceButton('forecast-temperature-unit', () =>
  changeUnit('temperature', displayUnits.temperature === 'F' ? 'C' : 'F'));
const depth = preferenceButton('forecast-depth-unit', () =>
  changeUnit('depth', displayUnits.depth === 'in' ? 'cm' : 'in'));
document.querySelector('#compare-menu, .clould-menu, .site-header #refresh').before(preferences);
const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = '/clone/language.css';
document.head.append(css);

function apply(language) {
  setDisplayLanguage(language, chinese);
  document.documentElement.lang = displayLanguage;
  const english = displayLanguage === 'en';
  updateButton(languageButton, 'Language', english ? 'English' : '简体中文', english ? '简体中文' : 'English');
  preferences.setAttribute('aria-label', t('Display preferences'));
  updateShell();
  updateLanguageLinks();
  updateUnitChoices();
}

function preferenceButton(id, onClick) {
  const button = preferences.appendChild(document.createElement('button'));
  button.id = id;
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function updateButton(button, name, current, next) {
  button.textContent = current;
  button.setAttribute('aria-label', t('{0}: {1}. Switch to {2}', t(name), current, next));
}

function changeUnit(key, value) {
  setDisplayUnits({ ...displayUnits, [key]: value });
  try { localStorage.setItem(unitsKey, JSON.stringify(displayUnits)); } catch { /* Use this page's choice. */ }
  updateUnitChoices();
  document.dispatchEvent(new Event('cloud10:unitschange'));
}

function updateUnitChoices() {
  const fahrenheit = displayUnits.temperature === 'F';
  const inches = displayUnits.depth === 'in';
  updateButton(temperature, 'Temperature unit', fahrenheit ? '°F' : '°C', fahrenheit ? '°C' : '°F');
  updateButton(depth, 'Snow and precipitation unit', t(inches ? 'in' : 'cm'), t(inches ? 'cm' : 'in'));
  const target = document.querySelector('[data-snow-target]');
  if (target) {
    const label = overnightTarget();
    const breakAt = label.indexOf(' ');
    target.firstChild.data = label.slice(0, breakAt);
    target.lastElementChild.textContent = label.slice(breakAt);
  }
}

function restoreUnits() {
  const previous = displayUnits;
  try { setDisplayUnits(JSON.parse(localStorage.getItem(unitsKey))); }
  catch { return; }
  if (previous.temperature === displayUnits.temperature && previous.depth === displayUnits.depth) return;
  updateUnitChoices();
  document.dispatchEvent(new Event('cloud10:unitschange'));
}

function changeLanguage() {
  saved = displayLanguage === 'en' ? 'zh-CN' : 'en';
  const url = new URL(location.href);
  url.searchParams.set('lang', saved);
  history.replaceState(history.state, '', url);
  try { localStorage.setItem(storageKey, saved); } catch { /* Keep using the URL. */ }
  apply(saved);
  document.dispatchEvent(new Event('cloud10:languagechange'));
}
function restoreLanguage() {
  try { saved = localStorage.getItem(storageKey) || saved; } catch { /* In-memory fallback. */ }
  const language = preferred();
  if (language !== displayLanguage) {
    apply(language);
    document.dispatchEvent(new Event('cloud10:languagechange'));
  }
}
window.addEventListener('popstate', restoreLanguage);
window.addEventListener('pageshow', restoreLanguage);
window.addEventListener('pageshow', restoreUnits);
window.addEventListener('storage', event => { if (!event.key || event.key === unitsKey) restoreUnits(); });
preferences.setAttribute('role', 'group');
restoreUnits();
apply(preferred());
