import { createSqliteCache } from './sqlite-cache.mjs';
import { createDashboardLoader } from './provider-core.mjs';
import { RESORT, RESORTS, resortCacheKey } from './config.mjs';
import { COLLECTION_INTERVAL } from './time.mjs';
import { createMorningSources } from './morning-sources.mjs';

export function createRuntime({ databasePath, resorts = RESORTS, fetchFn = fetch, now = Date.now, tickMs = 60_000, nwacEnabled = false, morningEnabled = false, log = () => {} } = {}) {
  if (!databasePath) throw new Error('A persistent database path is required');
  if (!Number.isFinite(tickMs) || tickMs < 10) throw new Error('Invalid collector interval');
  const store = createSqliteCache(databasePath, { clock: now });
  const options = { nwacEnabled, fetchFn, validateForecast: true, collectionIntervalMs: COLLECTION_INTERVAL };
  const morningSources = morningEnabled ? createMorningSources(store, { fetchFn, now, resortIds: resorts.map(resort => resort.id) }) : null;
  const collectors = new Map(resorts.map(resort => [resort.id, createDashboardLoader(store, { ...options, resort })]));
  // Deliberately discard the loader and force flag at the HTTP boundary.
  const readers = new Map(resorts.map(resort => [resort.id, createDashboardLoader({ get: (key, _loader, ttl, settings) => store.read(key, ttl, settings) }, { ...options, resort })]));
  let timer, pending, stopped = false, lastCycleAt = null, lastError = null;
  const loadDashboard = async ({ resortId = RESORT.id } = {}) => {
    const read = readers.get(resortId);
    if (!read) throw new Error('Unknown resort');
    const timestamp = now();
    const data = await read({ now: timestamp });
    if (!morningSources) return data;
    const context = morningSources.read(resortId, timestamp);
    return { ...data, morning: context.morning, sources: [...data.sources, ...context.sources] };
  };
  function collectOnce() {
    if (stopped) return Promise.reject(new Error('Collector is stopped'));
    if (pending) return pending;
    const before = store.stats(now()).openMeteoRequests24h;
    pending = (async () => {
      const results = [];
      // Sequential resorts let a provider-wide Retry-After stop the next request.
      // Source failures are captured by the cache, so other providers still run.
      for (const collect of collectors.values()) {
        if (stopped) break;
        results.push(await collect({ now: now() }));
      }
      if (!stopped && morningSources) await morningSources.collect();
      return results;
    })().then(results => {
      lastCycleAt = now(); lastError = null;
      if (store.stats(now()).openMeteoRequests24h !== before) log(JSON.stringify({ event: 'collection', at: lastCycleAt, resorts: results.map(data => ({ id: data.resort.id, sources: data.sources.filter(s => s.status !== 'disabled').map(s => ({ id: s.id, status: s.status, fetchedAt: s.fetchedAt, error: s.error })) })) }));
      return results;
    }).catch(error => { lastError = error.message; log(`Collector error: ${error.message}`); throw error; }).finally(() => { pending = null; });
    return pending;
  }
  return {
    loadDashboard, collectOnce,
    start() {
      if (stopped) throw new Error('Collector is stopped');
      if (timer) return;
      timer = setInterval(() => { collectOnce().catch(() => {}); }, tickMs);
      collectOnce().catch(() => {});
    },
    async stop() {
      if (stopped) return;
      stopped = true; clearInterval(timer); timer = null;
      try { await pending; } catch { /* Failure state is already recorded. */ }
      store.close();
    },
    health() {
      const timestamp = now();
      const summarize = key => {
        const { status, fetchedAt, nextAttemptAt, snapshotId, error } = store.read(key, COLLECTION_INTERVAL, {
          now: timestamp, minAttemptIntervalMs: COLLECTION_INTERVAL,
        });
        return { status, fetchedAt, nextAttemptAt, snapshotId, error };
      };
      const sourcesFor = resort => ({
        forecast: summarize(resortCacheKey(resort, 'forecast')),
        nws: summarize(resortCacheKey(resort, 'nws')),
      });
      return {
        ok: !stopped && !lastError, application: 'Cloud10', version: '0.3.0', storage: 'sqlite', nwacEnabled,
        collector: { running: Boolean(timer), lastCycleAt, error: lastError, tickMs },
        sources: sourcesFor(RESORT),
        resorts: Object.fromEntries(resorts.map(resort => [resort.id, sourcesFor(resort)])),
        usage: store.stats(timestamp),
      };
    },
  };
}
