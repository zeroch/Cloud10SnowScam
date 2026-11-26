// Server-side calculations and API responses use the English source messages.
// Each browser document chooses its own display language before rendering.
export let displayLanguage = 'en';
let messages = null;

export function supportedLanguage(tag) {
  const language = typeof tag === 'string' && tag.toLowerCase().split('-')[0];
  if (language === 'zh') return 'zh-CN';
  if (language === 'en') return 'en';
  return null;
}

export function chooseLanguage(requested, saved, browserLanguages = []) {
  return [requested, saved, ...browserLanguages].map(supportedLanguage).find(Boolean) || 'en';
}

export function setDisplayLanguage(language, translations) {
  displayLanguage = supportedLanguage(language) || 'en';
  messages = displayLanguage === 'zh-CN' ? translations : null;
}

export function t(source, ...values) {
  const message = messages && Object.hasOwn(messages, source) ? messages[source] : source;
  return values.length ? message.replace(/\{(\d+)\}/g, (_, index) => values[index]) : message;
}

export function modelCountLabel(count) {
  return t(count === 1 ? '{0} model' : '{0} models', count);
}
