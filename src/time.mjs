import { displayLanguage } from './i18n.mjs';

export const HOUR = 3_600_000;
export const ZONE = 'America/Los_Angeles';
const formatter = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

export function localParts(value) {
  return Object.fromEntries(formatter.formatToParts(new Date(value)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}

function localInstant(year, month, day, hour) {
  const desired = Date.UTC(year, month - 1, day, hour);
  let result = desired;
  for (let i = 0; i < 4; i++) {
    const p = localParts(result);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const delta = desired - represented;
    result += delta;
    if (!delta) break;
  }
  return result;
}

// Calendar boundaries, rather than 24-hour additions, preserve 23/25-hour
// Pacific dates when daylight-saving time changes.
export function localDayStart(value, offsetDays = 0) {
  const p = localParts(value);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + offsetDays));
  return localInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0);
}

export function nightWindow(value, offsetDays = 0, { startHour = 18, endHour = 6 } = {}) {
  const p = localParts(value);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + offsetDays));
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + offsetDays + 1));
  return {
    start: localInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), startHour),
    end: localInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), endHour),
  };
}

export function observedNight(value) {
  return nightWindow(value, localParts(value).hour < 18 ? -1 : 0);
}

export function formatTime(value, options = {}) {
  return new Intl.DateTimeFormat(displayLanguage === 'en' ? 'en-US' : displayLanguage, { timeZone: ZONE, hour: 'numeric', minute: '2-digit', ...options }).format(new Date(value));
}

export function formatDate(value, options = {}) {
  return new Intl.DateTimeFormat(displayLanguage === 'en' ? 'en-US' : displayLanguage, { timeZone: ZONE, weekday: 'short', month: 'short', day: 'numeric', ...options }).format(new Date(value));
}

export function isPacificWeekend(value) {
  const { year, month, day } = localParts(value);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}
