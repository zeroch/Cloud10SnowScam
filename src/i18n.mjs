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

// Forecasts and observations stay in their source units until display.
export let displayUnits = { temperature: 'F', depth: 'in' };

export function setDisplayUnits(preferences) {
  displayUnits = {
    temperature: preferences?.temperature === 'C' ? 'C' : 'F',
    depth: preferences?.depth === 'cm' ? 'cm' : 'in',
  };
}

export function convertWeather(value, sourceUnit) {
  if (!Number.isFinite(value)) return value;
  if (sourceUnit === '°F' && displayUnits.temperature === 'C') return (value - 32) * 5 / 9;
  if (sourceUnit === 'in' && displayUnits.depth === 'cm') return value * 2.54;
  return value;
}

export function weatherUnit(sourceUnit) {
  if (sourceUnit === '°F') return '°' + displayUnits.temperature;
  return t(sourceUnit === 'in' ? displayUnits.depth : sourceUnit);
}

export function depthUnitName(value) {
  if (displayUnits.depth === 'cm') return t(Number(value) === 1 ? 'centimeter' : 'centimeters');
  return t(Number(value) === 1 ? 'inch' : 'inches');
}

export function depthNumber(inches) {
  return Number(convertWeather(inches, 'in').toFixed(4));
}

export function depthThreshold(inches, long = false) {
  const value = depthNumber(inches);
  return `${value} ${long ? depthUnitName(value) : weatherUnit('in')}`;
}

export function overnightTarget(long = false) {
  return `${depthNumber(4)}–${depthThreshold(5, long)}`;
}
