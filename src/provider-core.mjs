import { MODELS, RESORT, STATION_PAGES, stationUrl, getResort, resortCacheKey } from './config.mjs';
import { HOUR } from './time.mjs';
import { finite } from './conditions.mjs';

const bounded = (value, min, max) => finite(value) && value >= min && value <= max ? value : null;
const fields = {
  air_temp: ['temperatureF', -80, 130], relative_humidity: ['humidityPct', 0, 100],
  precip_accum_one_hour: ['precipIn', 0, 8], snow_depth_24h: ['boardIn', 0, 60], snow_depth: ['depthIn', 0, 400],
  wind_speed: ['windMph', 0, 200], wind_gust: ['gustMph', 0, 250],
};

function plainText(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' })[entity]).replace(/\s+/g, ' ').trim();
}

function findTable(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 50) return null;
  if (Array.isArray(value.columns) && Array.isArray(value.rows)) return value;
  for (const child of Object.values(value)) { const found = findTable(child, depth + 1); if (found) return found; }
  return null;
}

export function parseNwac(html, pageOrId) {
  const page = typeof pageOrId === 'string' ? STATION_PAGES[pageOrId] : pageOrId;
  if (!page) throw new Error('Unknown NWAC station');
  const chunks = [];
  for (const match of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)) {
    try { const value = JSON.parse(match[1]); if (value[0] === 1 && typeof value[1] === 'string') chunks.push(value[1]); } catch { /* Non-data scripts are ignored and never executed. */ }
  }
  let table;
  for (const line of chunks.join('').split('\n')) {
    if (!line.includes('"columns"') || !line.includes('"rows"')) continue;
    try { table = findTable(JSON.parse(line.slice(line.indexOf(':') + 1))); } catch { /* Non-JSON Flight frames are not observation data. */ }
    if (table) break;
  }
  if (!table?.columns.length || !table.rows.length) throw new Error('NWAC observation table is missing or its format changed');
  const noteHtml = html.match(/<aside\b[^>]*aria-label="Station notes"[^>]*>([\s\S]*?)<\/aside>/)?.[1] || '';
  const noticeText = plainText(noteHtml).replace(/\+\s*\d+\s*notes?/i, '').trim();
  const notices = noticeText ? [noticeText] : [];
  const snowBlocked = /decommission|board.{0,60}removed|disregard.{0,30}values|snow.{0,40}(?:offline|out of service)/i.test(noticeText);
  return page.stations.map(station => {
    const columns = table.columns.filter(c => String(c.stid) === station.stid && c.source === 'nwac');
    if (!columns.some(c => c.variable === 'air_temp')) throw new Error(`NWAC ${station.name} temperature column is missing`);
    const rows = table.rows.filter(r => finite(r.timestamp) && r.values && typeof r.values === 'object').map(row => {
      const result = { time: row.timestamp };
      for (const column of columns) {
        const spec = fields[column.variable]; if (!spec) continue;
        let value = row.values[column.key];
        if (column.variable === 'air_temp') {
          if (column.unit === '°C' && finite(value)) value = value * 1.8 + 32;
          else if (column.unit !== '°F') value = null;
        } else if (['boardIn', 'depthIn', 'precipIn'].includes(spec[0])) {
          if (column.unit === 'cm' && finite(value)) value /= 2.54;
          else if (column.unit === 'mm' && finite(value)) value /= 25.4;
          else if (column.unit !== 'in') value = null;
        } else if (spec[0].endsWith('Mph') && column.unit !== 'mph') value = null;
        result[spec[0]] = bounded(value, spec[1], spec[2]);
      }
      return result;
    }).sort((a, b) => b.time - a.time);
    if (!rows.length) throw new Error('NWAC table has no dated observations');
    return { ...station, url: stationUrl(page), rows, notices, snowBlocked, hasSnowBoard: columns.some(c => c.variable === 'snow_depth_24h') };
  });
}

export function parseForecast(json) {
  if (!Array.isArray(json.hourly?.time) || json.hourly_units?.time !== 'unixtime') throw new Error('Forecast time format is unavailable');
  const models = MODELS.filter(model => Array.isArray(json.hourly[`snowfall_${model.id}`])).map(model => {
    for (const [key, unit] of [['snowfall', 'inch'], ['temperature_2m', '°F'], ['precipitation', 'inch'], ['wind_speed_10m', 'mp/h'], ['wind_gusts_10m', 'mp/h']]) {
      if (json.hourly_units[`${key}_${model.id}`] !== unit) throw new Error(`Unexpected forecast unit for ${key}`);
    }
    const field = name => json.hourly[`${name}_${model.id}`];
    const snow = field('snowfall'), temperature = field('temperature_2m'), precip = field('precipitation');
    const wind = field('wind_speed_10m'), gust = field('wind_gusts_10m');
    const cloud = json.hourly_units[`cloud_cover_${model.id}`] === '%' ? field('cloud_cover') : null;
    const levelUnit = json.hourly_units[`freezing_level_height_${model.id}`];
    const unitsPerFoot = levelUnit === 'ft' ? 1 : levelUnit === 'm' ? 0.3048 : null;
    const freezing = unitsPerFoot === null ? null : field('freezing_level_height');
    const points = json.hourly.time.map((time, i) => ({
      time: finite(time) ? time * 1000 : null, snowIn: bounded(snow[i], 0, 20),
      temperatureF: bounded(temperature?.[i], -80, 130), precipIn: bounded(precip?.[i], 0, 8),
      freezingLevelFt: finite(freezing?.[i]) ? bounded(freezing[i] / unitsPerFoot, 0, 30000) : null,
      windMph: bounded(wind?.[i], 0, 200), gustMph: bounded(gust?.[i], 0, 250), cloudPct: bounded(cloud?.[i], 0, 100),
    })).filter(p => finite(p.time));
    return { ...model, points };
  });
  if (!models.length) throw new Error('No named model forecasts were returned');
  return { models, grid: { latitude: json.latitude, longitude: json.longitude, elevationM: json.elevation }, modelRunAt: null };
}

function durationMs(value) {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return NaN;
  return ((Number(match[1] || 0) * 24 + Number(match[2] || 0)) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0)) * 1000;
}

export function parseSnowLevel(json) {
  const field = json.properties?.snowLevel;
  if (!Array.isArray(field?.values) || !['wmoUnit:m', 'wmoUnit:ft'].includes(field.uom)) throw new Error('NWS snow level is unavailable');
  const intervals = field.values.map(row => {
    const [iso, period] = String(row.validTime).split('/');
    const start = Date.parse(iso), end = period?.startsWith('P') ? start + durationMs(period) : Date.parse(period);
    const feet = finite(row.value) ? row.value * (field.uom === 'wmoUnit:m' ? 1 / 0.3048 : 1) : null;
    return { start, end, feet: bounded(feet, 0, 30000) };
  }).filter(row => finite(row.start) && finite(row.end) && row.end > row.start);
  if (!intervals.length) throw new Error('NWS snow-level time intervals are invalid');
  return { intervals, updatedAt: Date.parse(json.properties.updateTime), elevation: json.properties.elevation };
}

export async function fetchText(url, fetchFn = fetch, now = Date.now()) {
  const response = await fetchFn(url, { headers: { 'User-Agent': 'Cloud10/0.3 (noncommercial ski weather dashboard)', Accept: 'application/geo+json, application/json, text/html;q=0.9' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const header = response.headers.get('Retry-After');
    const retryAfterMs = header && /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
    throw Object.assign(new Error(`Source responded HTTP ${response.status}`), { retryAfterMs: finite(retryAfterMs) ? Math.max(0, retryAfterMs) : null });
  }
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error('Source response exceeded the expected size');
  return body;
}

export function forecastRequestUrl(resort = RESORT) {
  // UTC calendar dates provide enough future hours for 15 Pacific dates,
  // including the hour-ending value at the last local midnight.
  const params = new URLSearchParams({ latitude: resort.latitude, longitude: resort.longitude, elevation: resort.elevationM, hourly: 'snowfall,temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,cloud_cover,freezing_level_height', models: MODELS.map(m => m.id).join(','), forecast_days: '16', timeformat: 'unixtime', timezone: 'UTC', temperature_unit: 'fahrenheit', precipitation_unit: 'inch', wind_speed_unit: 'mph' });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}
export function validateForecastCoverage(data, now) {
  const start = Math.ceil(now / HOUR) * HOUR;
  const usable = data.models.some(model => {
    const points = model.points;
    if (points.some((p, i) => p.time % HOUR !== 0 || (i && p.time <= points[i - 1].time))) return false;
    const future = new Map(points.map(p => [p.time, p]));
    return Array.from({ length: 120 }, (_, i) => future.get(start + (i + 1) * HOUR))
      .every(p => p && finite(p.snowIn) && finite(p.precipIn) && finite(p.temperatureF));
  });
  if (!usable) throw new Error('Forecast coverage is expired or lacks a complete five-day model');
  return data;
}

export function validateSnowLevelCoverage(data, now) {
  if (!finite(data.updatedAt) || now - data.updatedAt > 24 * HOUR || data.updatedAt > now + HOUR)
    throw new Error('NWS snow-level issue time is missing or expired');
  if (!data.intervals.some(p => finite(p.feet) && p.end > now && p.start < now + 120 * HOUR))
    throw new Error('NWS snow level has no usable future coverage');
  return data;
}

export function createDashboardLoader(cache, { resort = RESORT, forecastTransport = 'server', nwacEnabled = true, fetchFn = fetch, validateForecast = false } = {}) {
if (!getResort(resort.id)) throw new Error('Unknown resort');
const stationPages = resort.id === RESORT.id ? STATION_PAGES : {};
const observationsEnabled = nwacEnabled && Object.keys(stationPages).length > 0;
return async function loadDashboard({ force = false, now = Date.now() } = {}) {
  const forecastUrl = forecastRequestUrl(resort);
  const jobs = [
    // Six units conservatively reserve the longer-than-two-week request and
    // all five models within the existing local provider budget.
    { id: 'forecast', cacheKey: resortCacheKey(resort, 'forecast'), provider: 'open-meteo', cost: 6, name: 'Open-Meteo · 5 models', url: 'https://open-meteo.com/en/docs', ttl: HOUR / 2, loader: async () => {
      const data = parseForecast(JSON.parse(await fetchText(forecastUrl, fetchFn, now)));
      return validateForecast ? validateForecastCoverage(data, now) : data;
    } },
    ...Object.entries(stationPages).map(([id, page]) => ({ id, disabled: !observationsEnabled, provider: 'nwac', name: page.name, url: stationUrl(page), ttl: HOUR / 4, loader: async () => ({ stations: parseNwac(await fetchText(stationUrl(page), fetchFn, now), id) }) })),
    { id: 'nws', cacheKey: resortCacheKey(resort, 'nws'), provider: 'nws', name: 'NWS · snow level', url: 'https://www.weather.gov/sew/', ttl: HOUR, loader: async () => {
      const location = await cache.get(resortCacheKey(resort, 'nws-point'), async () => {
        const json = JSON.parse(await fetchText(`https://api.weather.gov/points/${resort.latitude},${resort.longitude}`, fetchFn, now));
        const gridUrl = json.properties?.forecastGridData;
        if (typeof gridUrl !== 'string' || !gridUrl.startsWith('https://api.weather.gov/gridpoints/')) throw new Error('NWS point did not return a forecast grid');
        return { gridUrl };
      }, 7 * 24 * HOUR, { now, provider: 'nws' });
      if (validateForecast && !['fresh', 'cached'].includes(location.status)) {
        throw Object.assign(new Error('NWS location lookup is unavailable; grid collection deferred'), { retryAfterMs: Math.max(0, (location.nextAttemptAt || now) - now) });
      }
      if (!location.data) throw new Error('NWS forecast location is unavailable');
      const data = parseSnowLevel(JSON.parse(await fetchText(location.data.gridUrl, fetchFn, now)));
      return { ...(validateForecast ? validateSnowLevelCoverage(data, now) : data), url: location.data.gridUrl };
    } },
  ];
  const outcomes = await Promise.all(jobs.map(async job => ({ job, result: job.disabled
    ? { data: null, fetchedAt: null, status: 'disabled', error: 'NWAC collection is disabled for this deployment.' }
    : job.id === 'forecast' && forecastTransport === 'browser'
    ? { data: null, fetchedAt: null, status: 'unavailable', error: null }
    : await cache.get(job.cacheKey || job.id, job.loader, job.ttl, { force, now, provider: job.provider, cost: job.cost || 1 }) })));
  const sources = outcomes.map(({ job, result }) => ({ id: job.id, name: job.name, url: result.data?.url || job.url, status: job.id === 'nws' && finite(result.data?.updatedAt) && now - result.data.updatedAt > 24 * HOUR ? 'stale' : result.status, fetchedAt: result.fetchedAt, issuedAt: result.data?.updatedAt || null, refreshAfterMs: job.ttl, error: result.error, snapshotId: result.snapshotId ?? null, nextAttemptAt: result.nextAttemptAt ?? null }));
  const get = id => outcomes.find(item => item.job.id === id)?.result;
  const stations = Object.keys(stationPages).flatMap(id => (get(id)?.data?.stations || stationPages[id].stations.map(s => ({ ...s, url: stationUrl(stationPages[id]), rows: [], notices: [] }))).map(station => ({ ...station, sourceState: get(id)?.status || 'unavailable', fetchedAt: get(id)?.fetchedAt || null })));
  return { generatedAt: now, resort, forecastTransport, observationsEnabled, sources, stations, models: get('forecast')?.data?.models || [], forecastGrid: get('forecast')?.data?.grid || null, snowLevels: get('nws')?.data?.intervals || [] };
};
}
