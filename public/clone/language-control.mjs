import { chooseLanguage, displayLanguage, setDisplayLanguage, supportedLanguage, t } from '/lib/i18n.mjs';
import { getResort } from '/lib/config.mjs';
import chinese from './zh-CN.mjs';

const storageKey = 'cloud10-language';
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
  function bind(source, write, messageKey) {
    const text = source.trim();
    if (!text) return;
    const key = messageKey ?? (Object.hasOwn(chinese, text) ? text : text.replace(point, '{1}').replace(resort.name, '{0}'));
    if (!Object.hasOwn(chinese, key)) return;
    bindings.push(() => {
      const localized = displayLanguage === 'en' ? text : t(key, resort.name, t('{0} {1} ft', t(resort.pointLabel), height));
      write(source.replace(text, () => localized));
    });
  }
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const messageKey = parent.dataset.i18n;
    // Inside the wordmark, only explicitly labeled text follows the language switch.
    if (!messageKey && parent.closest('script, style, noscript, .compare-wordmark, .clould-wordmark, .brand, [translate="no"]')) continue;
    bind(node.data, value => { node.data = value; }, messageKey);
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
const select = document.createElement('select');
select.id = 'forecast-language';
for (const [value, name] of [['en', 'English'], ['zh-CN', '简体中文']]) {
  const option = new Option(name, value);
  option.lang = value;
  select.add(option);
}
document.querySelector('#compare-menu, .clould-menu, .site-header #refresh').before(select);
const css = document.createElement('link');
css.rel = 'stylesheet';
css.href = '/clone/language.css';
document.head.append(css);

function apply(language) {
  setDisplayLanguage(language, chinese);
  document.documentElement.lang = displayLanguage;
  select.value = displayLanguage;
  select.setAttribute('aria-label', t('Language'));
  updateShell();
  updateLanguageLinks();
}

select.addEventListener('change', () => {
  saved = select.value;
  const url = new URL(location.href);
  url.searchParams.set('lang', saved);
  history.replaceState(history.state, '', url);
  try { localStorage.setItem(storageKey, saved); } catch { /* Keep using the URL. */ }
  apply(saved);
  document.dispatchEvent(new Event('cloud10:languagechange'));
});
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
apply(preferred());
