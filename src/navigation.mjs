const COMPARISON_PATH = '/user/favorites/locations/snow-summary';

function validMorning(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Return only to our own comparison route, never to an arbitrary supplied URL.
export function comparisonReturnUrl(currentUrl) {
  const current = new URL(currentUrl);
  const days = current.searchParams.get('compareDays');
  const night = current.searchParams.get('compareNight');
  if (!['1', '3', '5'].includes(days) || !validMorning(night)) return COMPARISON_PATH;
  const params = new URLSearchParams();
  if (days !== '1') {
    params.set('view', days === '3' ? '3days' : 'outlook');
    params.set('days', days);
  }
  params.set('night', night);
  return `${COMPARISON_PATH}?${params}#live-overnight`;
}

// Preserve the resort and comparison context when linking to Daily Forecast.
export function forecastDetailUrl(currentUrl, targetUrl, resortId) {
  const current = new URL(currentUrl), target = new URL(targetUrl, current);
  target.pathname = current.pathname;
  if (!current.pathname.startsWith('/location/')) target.searchParams.set('resort', resortId);
  for (const key of ['compareDays', 'compareNight']) {
    const value = current.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  return target;
}
