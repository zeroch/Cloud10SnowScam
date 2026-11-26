import { MODELS, RESORTS, getResort, resortCacheKey } from '../../src/config.mjs';
import { buildAdvice } from '../../src/advice.mjs';
import { nightWindow } from '../../src/time.mjs';
import {
  createDashboardLoader, forecastRequestUrl, parseForecast, parseSnowLevel,
  validateForecastCoverage, validateSnowLevelCoverage,
} from '../../src/provider-core.mjs';

const HALF_HOUR = 1_800_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const WINDOW = 48 * HALF_HOUR;
const GRID = {
  stevenspass: 'SEW/164,66', crystalmountain: 'SEW/145,31',
  summitcentral: 'PDT/63,196', mtbaker: 'SEW/157,123',
};
const PASSES = new Set(['Stevens Pass US 2', 'Crystal to Greenwater SR 410', 'Snoqualmie Pass I-90', 'Mt. Baker Hwy SR 542']);
const roadParams = new URLSearchParams({
  where: '1=1', outFields: 'PassName,RoadCondition,Weather,DisplayDate,TravelDirection1,PublicMessage1,TravelDirection2,PublicMessage2',
  returnGeometry: 'false', f: 'json',
});
const roads = {
  provider: 'wsdot', key: 'roads',
  url: 'https://data.wsdot.wa.gov/arcgis/rest/services/TravelInformation/TravelInfoMtPassReports/FeatureServer/0/query?' + roadParams,
  parse(body) {
    if (!Array.isArray(body.features)) throw new Error('Missing WSDOT pass reports');
    const reports = body.features.map(item => item.attributes).filter(row => PASSES.has(row?.PassName));
    if (!reports.length) throw new Error('No matching pass reports');
    return reports;
  },
};

function forecastSnapshot(body, now) {
  const forecast = validateForecastCoverage(parseForecast(body), now);
  const adviceDays = {};
  for (const { id, points } of forecast.models) {
    for (const p of points) {
      const day = Math.floor(p.time / DAY);
      const models = adviceDays[day] ??= {};
      const rows = models[id] ??= [];
      rows.push([p.time, p.snowIn, p.temperatureF, p.gustMph]);
    }
  }
  return { ...forecast, adviceDays, adviceModelIds: forecast.models.map(model => model.id) };
}

export function jobFor(phase, slot) {
  if (phase === 8) return roads;
  if (phase < 4) {
    const resort = RESORTS[phase];
    const url = new URL(forecastRequestUrl(resort));
    url.searchParams.set('forecast_days', '16');
    return {
      provider: 'open-meteo', key: resortCacheKey(resort, 'forecast'), url: url.href,
      parse: forecastSnapshot,
    };
  }
  if (slot % 2 !== 0) return null;
  const resort = RESORTS[phase - 4];
  const url = 'https://api.weather.gov/gridpoints/' + GRID[resort.id];
  return { provider: 'nws', key: resortCacheKey(resort, 'nws'), url,
    parse: (body, now) => ({ ...validateSnowLevelCoverage(parseSnowLevel(body), now), url }) };
}

function retryUntil(response, now) {
  const header = response.headers.get('Retry-After');
  let until = null;
  if (header) until = /^\d+$/.test(header) ? now + Number(header) * 1000 : Date.parse(header);
  if (Number.isSafeInteger(until) && until > now) return until;
  return response.status === 429 ? now + 2 * HALF_HOUR : null;
}

async function quotaDetails(response) {
  const headers = Object.fromEntries([...response.headers]
    .filter(([name]) => /^(?:x-)?ratelimit(?:-policy|-limit|-remaining|-reset)?$/.test(name))
    .map(([name, value]) => [name, value.slice(0, 256)]));
  let reason = null;
  try {
    let text = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body || []) {
      text += decoder.decode(chunk.subarray(0, 2048), { stream: true });
      if (text.length >= 2048) break;
    }
    const body = JSON.parse(text + decoder.decode());
    if (typeof body.reason === 'string') reason = body.reason.slice(0, 256);
  } catch { /* The status and Retry-After were already saved for non-JSON replies. */ }
  return JSON.stringify({ reason, headers });
}

export async function sample(db, job, slot, fetchFn, clock, production = false) {
  const now = clock();
  const attempts = production ? 'production_attempts' : 'pilot_attempts';
  const carriedCooldown = production ? ' OR EXISTS (SELECT 1 FROM pilot_attempts WHERE provider=? AND retry_until>?)' : '';
  // Claim the individual source and check for a shared cooldown atomically.
  // Events delivered concurrently cannot spend the same provider request twice.
  const claim = await db.prepare(`INSERT OR IGNORE INTO ${attempts} (slot,provider,source_key,request_ms,outcome)
    SELECT ?,?,?,CASE WHEN state='attempting' THEN ? END,state FROM (SELECT CASE
      WHEN EXISTS (SELECT 1 FROM ${attempts} WHERE provider=? AND retry_until>?)${carriedCooldown} THEN 'cooldown'
      WHEN EXISTS (SELECT 1 FROM ${attempts} WHERE provider=? AND outcome='attempting' AND request_ms>?) THEN 'inflight'
      ELSE 'attempting' END AS state) RETURNING outcome`)
    .bind(slot, job.provider, job.key, now, job.provider, now, ...(production ? [job.provider, now] : []), job.provider, now - 20_000).first();
  if (claim?.outcome !== 'attempting') return;
  const result = (outcome, detail = null) => db.prepare(`UPDATE ${attempts} SET outcome=?,detail=? WHERE slot=? AND source_key=?`)
    .bind(outcome, detail, slot, job.key);
  let response;
  try {
    response = await fetchFn(job.url, {
      headers: { 'User-Agent': production ? 'Cloud10/1.0 (+https://forecast.cloud10snow.com/)' : 'Cloud10ForecastPilot/1.0 (+https://github.com/zeroch/Cloud10SnowScam)', Accept: job.accept || 'application/geo+json, application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    await result('network', String(error.message).slice(0, 200)).run();
    return;
  }
  const received = clock();
  const until = response.ok ? null : retryUntil(response, received);
  // Save the response before parsing the model grids. A CPU termination should
  // leave the HTTP status and any provider cooldown available to the next cron.
  await db.prepare(`UPDATE ${attempts} SET status=?,outcome=?,retry_after=?,retry_until=? WHERE slot=? AND source_key=?`)
    .bind(response.status, response.ok ? 'received' : 'http', response.headers.get('Retry-After'), until, slot, job.key).run();
  if (!response.ok) {
    if (job.provider === 'open-meteo' && response.status === 429) {
      await result('http', await quotaDetails(response)).run();
    } else if (response.body) await response.body.cancel();
    return;
  }
  let payload;
  try {
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error('Upstream body exceeds expected size');
    payload = JSON.stringify(job.parse(job.text ? body : JSON.parse(body), received));
  } catch (error) {
    await result('invalid', String(error.message).slice(0, 200)).run();
    return;
  }
  await db.batch([
    db.prepare(`INSERT INTO pilot_latest (source_key,slot,fetched_ms,payload) VALUES (?,?,?,?)
      ON CONFLICT(source_key) DO UPDATE SET slot=excluded.slot,fetched_ms=excluded.fetched_ms,payload=excluded.payload
      WHERE excluded.slot > pilot_latest.slot`).bind(job.key, slot, received, payload),
    result('ok'),
  ]);
}

export async function collect(db, scheduledMs, fetchFn = fetch, clock = Date.now) {
  const now = clock();
  const minute = Math.floor(scheduledMs / MINUTE);
  const phase = (minute + 30 - 22) % 30;
  if (phase > 8 || now < scheduledMs || now - scheduledMs >= HALF_HOUR) return;
  if (phase === 0) {
    await db.prepare('INSERT OR IGNORE INTO pilot_window (id,start_ms) VALUES (1,?)').bind(scheduledMs).run();
  }
  const window = await db.prepare('SELECT start_ms FROM pilot_window WHERE id=1').first();
  if (!window || now >= window.start_ms + WINDOW) return;
  const roundMinute = minute - phase;
  const slot = Math.floor((roundMinute - Math.floor(window.start_ms / MINUTE)) / 30);
  if (slot < 0 || slot >= 48) return;
  const job = jobFor(phase, slot);
  if (!job) return;
  await db.prepare('INSERT OR IGNORE INTO pilot_cycles (slot,scheduled_ms) VALUES (?,?)').bind(slot, roundMinute * MINUTE).run();
  await sample(db, job, slot, fetchFn, clock);
  await db.prepare(`UPDATE pilot_cycles SET finished_ms=? WHERE slot=? AND finished_ms IS NULL
    AND (SELECT COUNT(*) FROM pilot_attempts WHERE slot=? AND outcome NOT IN ('attempting','received'))=?`)
    .bind(clock(), slot, slot, slot % 2 === 0 ? 9 : 5).run();
}

async function pilotReport(db) {
  const [window, cycles, weather, feeds] = await Promise.all([
    db.prepare('SELECT start_ms FROM pilot_window WHERE id=1').first(),
    db.prepare('SELECT COUNT(*) AS started,COUNT(finished_ms) AS completed FROM pilot_cycles').first(),
    db.prepare(`SELECT COUNT(request_ms) AS requests,COUNT(status) AS responses,
      COUNT(CASE WHEN status=429 THEN 1 END) AS responses429,COUNT(CASE WHEN outcome='cooldown' THEN 1 END) AS cooldownSkips,
      COUNT(CASE WHEN outcome='invalid' THEN 1 END) AS invalid, MAX(retry_until) AS cooldownUntil
      FROM pilot_attempts WHERE provider='open-meteo'`).first(),
    db.prepare('SELECT provider,outcome,status,COUNT(*) AS count FROM pilot_attempts GROUP BY provider,outcome,status ORDER BY provider,outcome,status').all(),
  ]);
  return { startMs: window?.start_ms ?? null, endMs: window ? window.start_ms + WINDOW : null,
    cyclesPlanned: 48, cyclesStarted: cycles.started, cyclesCompleted: cycles.completed, openMeteo: weather, feeds: feeds.results };
}

export async function dashboard(db, resort, now, { production = false, context, advice = buildAdvice } = {}) {
  const forecastKey = resortCacheKey(resort, 'forecast');
  // Evening through 6 AM at each Washington resort falls on one UTC date.
  const nightDay = Math.floor(nightWindow(now).end / DAY);
  const last = table => `(SELECT outcome FROM ${table} WHERE source_key=pilot_latest.source_key ORDER BY slot DESC LIMIT 1)`;
  const outcome = (production ? `coalesce(${last('production_attempts')},${last('pilot_attempts')})` : last('pilot_attempts')) + ' AS outcome';
  let modelsJson = '[]';
  const cache = { async get(key, _loader, ttl) {
    const saved = key === forecastKey
      ? await db.prepare(`SELECT slot,fetched_ms,${outcome},payload->'$.models' AS models,payload->'$.grid' AS grid,
          payload->'$.adviceModelIds' AS ids,json_extract(payload,?) AS night FROM pilot_latest WHERE source_key=?`)
        .bind('$.adviceDays."' + nightDay + '"', key).first()
      : await db.prepare(`SELECT slot,fetched_ms,${outcome},payload FROM pilot_latest WHERE source_key=?`).bind(key).first();
    if (!saved) return { data: null, status: 'unavailable', fetchedAt: null, error: 'Waiting for a validated forecast source' };
    const status = saved.outcome === 'ok' && now - saved.fetched_ms < ttl ? 'cached' : 'stale';
    const state = { status, fetchedAt: saved.fetched_ms, snapshotId: saved.slot, error: null };
    if (key !== forecastKey) return { ...state, data: JSON.parse(saved.payload) };
    modelsJson = saved.models;
    const night = JSON.parse(saved.night || '{}');
    const inputs = saved.ids ? JSON.parse(saved.ids).map(id => ({
      id, label: MODELS.find(model => model.id === id).label,
      points: (night[id] || []).map(([time,snowIn,temperatureF,gustMph]) => ({ time, snowIn, temperatureF, gustMph })),
    })) : JSON.parse(modelsJson);
    return { ...state, data: { grid: JSON.parse(saved.grid), models: inputs } };
  } };
  const data = await createDashboardLoader(cache, { resort, nwacEnabled: false })({ now });
  const { models, ...metadata } = data;
  if (context) {
    metadata.morning = context.morning;
    metadata.sources = [...data.sources, ...context.sources];
  }
  const header = JSON.stringify({ ...metadata, advice: advice(data, now),
    attribution: 'Weather data by Open-Meteo (CC BY 4.0) and the US National Weather Service.' });
  // modelsJson is validated JSON from D1. Avoid decoding and re-encoding the
  // entire 16-day grid for every visitor while retaining live source freshness.
  return header.slice(0, -1) + ',"models":' + modelsJson + '}';
}

export async function serve(request, db, now = Date.now()) {
  const { pathname, searchParams } = new URL(request.url);
  const reply = (body, status = 200) => new Response(request.method === 'HEAD' ? null : body, {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
  const json = (data, status) => reply(JSON.stringify(data), status);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  if (pathname === '/pilot/status') return json(await pilotReport(db));
  if (pathname === '/api/resorts') return json({ resorts: RESORTS });
  const match = /^\/api\/resorts\/([^/]+)\/dashboard$/.exec(pathname);
  if (pathname === '/api/dashboard' || match) {
    const resort = getResort(match?.[1] ?? searchParams.get('resort') ?? undefined);
    if (resort) return reply(await dashboard(db, resort, now));
  }
  if (pathname === '/') return json({ service: 'Cloud10 24-hour forecast pilot', status: '/pilot/status',
    dashboards: RESORTS.map(resort => '/api/resorts/' + resort.id + '/dashboard'),
    weatherData: 'https://open-meteo.com/', license: 'https://creativecommons.org/licenses/by/4.0/' });
  return json({ error: 'Unknown route or resort' }, 404);
}

export default {
  scheduled(event, env) { return collect(env.DB, event.scheduledTime); },
  fetch(request, env) { return serve(request, env.DB); },
};
