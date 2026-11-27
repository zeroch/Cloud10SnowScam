import { dashboard, jobFor, sample } from '../cloudflare-pilot/worker.mjs';
import { RESORTS, MORNING_RESORTS, getResort, resortCacheKey, stationUrl } from 'cloud10-release/src/config.mjs';
import { parseNwac } from 'cloud10-release/src/provider-core.mjs';
import { parseRoadReports } from 'cloud10-release/src/morning-sources.mjs';
import { buildAdvice } from 'cloud10-release/src/advice.mjs';
import { COLLECTION_INTERVAL } from 'cloud10-release/src/time.mjs';

const minute = 60_000, halfHour = 30 * minute, hour = 2 * halfHour;
const favorites = new Set(['/', '/index.html', '/user/favorites', '/user/favorites/locations/snow-summary']);
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
const stationKey = station => 'morning-nwac-' + station.stid;
const trialStationsCron = '31-34 * 26,27 NOV *';

export async function runScheduled(event, db, upstream = fetch, clock = Date.now) {
  if (event.cron === trialStationsCron) {
    const window = await db.prepare('SELECT start_ms FROM pilot_window WHERE id=1').first();
    const now = clock(), scheduled = event.scheduledTime;
    const phase = Math.floor(scheduled / minute) % 60;
    if (!window || phase < 31 || phase > 34 || scheduled < window.start_ms ||
        now >= window.start_ms + 24 * hour || scheduled >= window.start_ms + 24 * hour) return;
  }
  return collectProduction(db, event.scheduledTime, upstream, clock);
}

function stationJob(resort) {
  const { station } = MORNING_RESORTS[resort.id];
  return {
    key: stationKey(station), provider: 'nwac', url: stationUrl(station), accept: 'text/html', text: true,
    parse(html, now) {
      const [observation] = parseNwac(html, { slug: station.slug, stations: [station] });
      const rows = observation.rows.filter(row => row.time <= now + 5 * minute);
      const latest = field => {
        const row = rows.find(item => Number.isFinite(item[field]));
        return row ? { value: row[field], observedAt: row.time } : null;
      };
      const depth = latest('depthIn'), temperature = latest('temperatureF');
      const snowfall24h = observation.hasSnowBoard && !observation.snowBlocked ? latest('boardIn') : null;
      if (!depth && !temperature && !snowfall24h) throw Error('NWAC station returned no usable measurements');
      return { depth, temperature, snowfall24h };
    },
  };
}

export async function collectProduction(db, scheduled, upstream = fetch, clock = Date.now) {
  const now = clock(), tick = Math.floor(scheduled / minute);
  if (now < scheduled || now - scheduled >= halfHour) return;
  const minuteOfHour = tick % 60, hourSlot = Math.floor(tick / 60);
  const collecting = hourSlot % (COLLECTION_INTERVAL / hour) === 0 && minuteOfHour >= 22 && minuteOfHour <= 34;
  if (minuteOfHour !== 0 && !collecting) return;
  await db.prepare('INSERT INTO production_clock (id,scheduled_ms) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET scheduled_ms=max(scheduled_ms,excluded.scheduled_ms)').bind(scheduled).run();
  if (!collecting) return;
  // Keep the existing slot numbers so new attempts can supersede saved data.
  if (minuteOfHour >= 31) {
    await sample(db, stationJob(RESORTS[minuteOfHour - 31]), hourSlot, upstream, clock, true);
    return;
  }
  const phase = minuteOfHour - 22;
  const window = await db.prepare('SELECT start_ms FROM pilot_window WHERE id=1').first();
  const start = window ? Math.floor(window.start_ms / minute) : 22;
  const slot = Math.floor((tick - phase - start) / 30);
  // The pilot owns exactly 48 forecast slots. Both clocks may fire in the same
  // minute at handoff. Ownership is based on the slot, not arrival seconds.
  if (window && slot < 48) return;
  const job = jobFor(phase);
  if (job) await sample(db, job, slot, upstream, clock, true);
  if (minuteOfHour === 30) {
    // Cooldowns remain effective even when their original sample is old.
    await db.prepare('DELETE FROM production_attempts WHERE slot < ? AND (request_ms IS NULL OR request_ms < ?) AND coalesce(retry_until,0) < ? AND provider != ?')
      .bind(slot - 336, now - 7 * 24 * hour, now, 'nwac').run();
    await db.prepare("DELETE FROM production_attempts WHERE provider='nwac' AND slot < ? AND coalesce(retry_until,0) < ?")
      .bind(hourSlot - 168, now).run();
  }
}

async function morning(db, resort, now) {
  const { station, road } = MORNING_RESORTS[resort.id];
  const sql = `SELECT source_key,fetched_ms,slot,payload,
    coalesce((SELECT outcome FROM production_attempts WHERE source_key=pilot_latest.source_key ORDER BY slot DESC LIMIT 1),
    (SELECT outcome FROM pilot_attempts WHERE source_key=pilot_latest.source_key ORDER BY slot DESC LIMIT 1),'ok') AS outcome
    FROM pilot_latest WHERE source_key IN (?, 'roads')`;
  const { results } = await db.prepare(sql).bind(stationKey(station)).all();
  const saved = new Map(results.map(row => [row.source_key, row]));
  const measurements = saved.get(stationKey(station)), reports = saved.get('roads');
  const raw = measurements && JSON.parse(measurements.payload);
  const report = reports && parseRoadReports({ features: JSON.parse(reports.payload).map(attributes => ({ attributes })) })[road.passName];
  const sources = [
    { id: 'nwac', name: 'NWAC · ' + station.name, url: stationUrl(station), row: measurements },
    { id: 'wsdot', name: 'WSDOT pass reports', url: 'https://wsdot.com/travel/real-time/mountainpasses', row: reports },
  ].map(({ row, ...info }) => ({ ...info, fetchedAt: row?.fetched_ms ?? null, refreshAfterMs: COLLECTION_INTERVAL,
    status: !row ? 'unavailable' : row.outcome === 'ok' && now - row.fetched_ms < COLLECTION_INTERVAL ? 'cached' : 'stale',
    snapshotId: row?.slot ?? null, error: null }));
  return { morning: { station: { ...station, snowfall24h: raw?.snowfall24h ?? null, depth: raw?.depth ?? null,
    temperature: raw?.temperature ?? null }, road: report ? { ...report, url: road.url } : null, roadLink: road.url }, sources };
}

async function health(db, now, release) {
  const [{ results }, heartbeat, window] = await Promise.all([
    db.prepare('SELECT source_key,fetched_ms FROM pilot_latest').all(),
    db.prepare('SELECT scheduled_ms FROM production_clock WHERE id=1').first(),
    db.prepare('SELECT start_ms,(SELECT scheduled_ms FROM pilot_cycles ORDER BY slot DESC LIMIT 1) AS last_pilot_ms FROM pilot_window WHERE id=1').first(),
  ]);
  const timestamps = new Map(results.map(row => [row.source_key, row.fetched_ms]));
  const resorts = Object.fromEntries(RESORTS.map(resort => [resort.id, {
    forecast: timestamps.get(resortCacheKey(resort, 'forecast')) ?? null, nws: timestamps.get(resortCacheKey(resort, 'nws')) ?? null,
    station: timestamps.get(stationKey(MORNING_RESORTS[resort.id].station)) ?? null,
  }]));
  const pilotOwnsForecasts = window && now < Math.floor(window.start_ms / minute) * minute + 24 * hour;
  const maxForecastAge = pilotOwnsForecasts ? 2 * hour : COLLECTION_INTERVAL + hour;
  const currentForecasts = Object.values(resorts).filter(item => item.forecast && now - item.forecast < maxForecastAge).length;
  const productionLastScheduledAt = heartbeat?.scheduled_ms ?? null;
  const lastScheduledAt = pilotOwnsForecasts ? window.last_pilot_ms : productionLastScheduledAt;
  const running = lastScheduledAt != null && now - lastScheduledAt < 2 * hour;
  return { ok: currentForecasts === RESORTS.length && running, application: 'Cloud10', release,
    storage: 'Cloudflare D1', currentForecasts, collector: { running, lastScheduledAt, productionLastScheduledAt,
      forecastOwner: pilotOwnsForecasts ? '24-hour pilot' : 'production' }, resorts, roads: timestamps.get('roads') ?? null };
}

export async function handleProduction(request, env, now = Date.now()) {
  const url = new URL(request.url), path = url.pathname;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': csp };
  const reply = (body, type, status = 200) => new Response(request.method === 'HEAD' ? null : body, {
    status, headers: { ...headers, 'Content-Type': type, ...(status === 405 ? { Allow: 'GET, HEAD' } : {}) },
  });
  const json = (value, status) => reply(JSON.stringify(value), 'application/json; charset=utf-8', status);
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Read-only service' }, 405);
  try {
    if (path === '/api/health') {
      const state = await health(env.DB, now, env.RELEASE || 'morning-outlook');
      return json(state, state.ok ? 200 : 503);
    }
    if (path === '/api/resorts') return json({ resorts: RESORTS });
    const api = /^\/api\/resorts\/([^/]+)\/dashboard$/.exec(path);
    if (api || path === '/api/dashboard') {
      const resort = getResort(api?.[1] ?? url.searchParams.get('resort') ?? undefined);
      if (!resort) return json({ error: 'Unknown resort' }, 404);
      const context = await morning(env.DB, resort, now);
      return reply(await dashboard(env.DB, resort, now, { production: true, context, advice: buildAdvice }), 'application/json; charset=utf-8');
    }
    let asset, type;
    const detail = /^\/location\/([^/]+)\/snow-summary$/.exec(path);
    if (favorites.has(path) || detail) {
      const chosen = detail?.[1] ?? url.searchParams.get('resort');
      if (chosen !== null && !getResort(chosen)) return json({ error: 'Unknown resort' }, 404);
      asset = chosen === null ? '/' : '/pages/' + (detail ? 'detail-' : 'favorites-') + chosen + '.body';
      type = 'text/html; charset=utf-8';
    } else if (path === '/desk') {
      asset = '/pages/desk.body'; type = 'text/html; charset=utf-8';
    } else if (/^\/(clone|lib)\//.test(path) || ['/app.mjs','/charts.mjs','/styles.css','/favicon.svg'].includes(path)) {
      if (path.endsWith('.body')) return json({ error: 'Not found' }, 404);
      asset = /\.(mjs|html)$/.test(path) ? path + '.body' : path;
      if (path.endsWith('.mjs')) type = 'text/javascript; charset=utf-8';
      if (path.endsWith('.html')) type = 'text/html; charset=utf-8';
    } else return json({ error: 'Not found' }, 404);
    const file = await env.ASSETS.fetch(new Request(new URL(asset, url), { method: request.method }));
    if (!file.ok) return json({ error: 'Not found' }, file.status);
    return reply(file.body, type || file.headers.get('content-type') || 'application/octet-stream');
  } catch (error) {
    console.error('Forecast service error:', error.message);
    return json({ error: 'Forecast service temporarily unavailable' }, 503);
  }
}

export default {
  fetch(request, env) { return handleProduction(request, env); },
  scheduled(event, env) { return runScheduled(event, env.DB); },
};
