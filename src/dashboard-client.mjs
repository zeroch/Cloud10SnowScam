import { forecastRequestUrl, parseForecast } from './provider-core.mjs';
import { RESORT, getResort } from './config.mjs';

const TTL = 30 * 60_000;
const CACHE_KEY = 'clould10-browser-forecast-v1';
function browserStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

// Personal hosted Sites use the provider's supported CORS API from the device.
// No user location, authentication cookie, or Site credential is sent upstream.
export function createDashboardClient({ resortId = RESORT.id, fetchFn = (...args) => fetch(...args), storage = browserStorage(), now = Date.now } = {}) {
  const resort = getResort(resortId);
  if (!resort) throw new Error('Unknown resort');
  const cacheKey = resortId === RESORT.id ? CACHE_KEY : `${CACHE_KEY}-${resortId}`;
  let saved;
  const url = forecastRequestUrl(resort);
  function restore() {
    if (saved) return;
    try {
      const entry = JSON.parse(storage?.getItem(cacheKey) || 'null');
      if (entry?.url === url && (!entry.data || (Number.isFinite(entry.fetchedAt) &&
          Array.isArray(entry.data.models) && entry.data.models.every(m => Array.isArray(m.points))))) saved = entry;
    } catch { /* Missing or damaged browser storage is a cache miss. */ }
  }
  function persist() {
    try { storage?.setItem(cacheKey, JSON.stringify(saved)); } catch { /* In-memory data still works with storage disabled. */ }
  }
  async function forecast(force) {
    restore();
    const timestamp = now();
    if (saved?.retryAt > timestamp) return { ...saved, status: saved.data ? 'stale' : 'unavailable' };
    const age = saved?.data ? timestamp - saved.fetchedAt : Infinity;
    if (age >= 0 && age < (force ? 60_000 : TTL)) return { ...saved, status: 'cached', error: null };
    let retryAt = timestamp + 5 * 60_000;
    try {
      const response = await fetchFn(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        const header = response.headers.get('Retry-After');
        const delay = header && /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - timestamp;
        if (Number.isFinite(delay)) retryAt = Math.max(retryAt, timestamp + delay);
        throw new Error(`Forecast source responded HTTP ${response.status}. Refresh will retry after the provider cooldown.`);
      }
      const data = parseForecast(await response.json());
      saved = { url, data, fetchedAt: timestamp, retryAt: 0, error: null };
      persist();
      return { ...saved, status: 'fresh' };
    } catch (error) {
      saved = { url, data: saved?.data ?? null, fetchedAt: saved?.fetchedAt ?? null, retryAt,
        error: String(error.message || 'Forecast source unavailable').slice(0, 180) };
      persist();
      return { ...saved, status: saved.data ? 'stale' : 'unavailable' };
    }
  }
  return async function load(force = false) {
    const path = resortId === RESORT.id ? '/api/dashboard' : `/api/resorts/${resortId}/dashboard`;
    const response = await fetchFn(path + (force ? '?refresh=1' : ''), { signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error('Dashboard refresh failed');
    const data = await response.json();
    if (data.resort?.id !== resortId) throw new Error('Dashboard resort does not match the selected resort');
    if (data.forecastTransport !== 'browser') return data;
    const result = await forecast(force);
    return { ...data, models: result.data?.models || [], forecastGrid: result.data?.grid || null,
      sources: data.sources.map(source => source.id !== 'forecast' ? source : {
        ...source, name: 'Open-Meteo · 5 models · this device', status: result.status,
        fetchedAt: result.fetchedAt, refreshAfterMs: TTL, error: result.error,
      }),
    };
  };
}

export const fetchDashboard = createDashboardClient();
