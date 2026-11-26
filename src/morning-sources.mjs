import { MORNING_RESORTS, stationUrl } from './config.mjs';
import { finite } from './conditions.mjs';
import { fetchText, parseNwac } from './provider-core.mjs';
import { HOUR } from './time.mjs';

const passNames = new Set(Object.values(MORNING_RESORTS).map(item => item.road.passName));
const text = value => typeof value === 'string' ? value.trim().slice(0, 2000) : '';

function readStation(html, station, now) {
  const [observation] = parseNwac(html, { slug: station.slug, stations: [station] });
  const rows = observation.rows.filter(row => row.time <= now + 5 * 60_000);
  const latest = field => {
    const row = rows.find(row => finite(row[field]));
    return row ? { value: row[field], observedAt: row.time } : null;
  };
  const depth = latest('depthIn'), temperature = latest('temperatureF');
  const snowfall24h = observation.hasSnowBoard && !observation.snowBlocked ? latest('boardIn') : null;
  if (!depth && !temperature && !snowfall24h) throw new Error('NWAC station returned no usable measurements');
  return { depth, temperature, snowfall24h };
}

export function parseRoadReports(payload) {
  if (!Array.isArray(payload?.features)) throw new Error('Road report response is invalid');
  const result = {};
  for (const feature of payload.features) {
    const row = feature?.attributes || {};
    if (!passNames.has(row.PassName)) continue;
    const directions = [1, 2].map(index => ({ direction: text(row[`TravelDirection${index}`]), message: text(row[`PublicMessage${index}`]) }))
      .filter(item => item.direction && item.message);
    result[row.PassName] = { passName: row.PassName, condition: text(row.RoadCondition), weather: text(row.Weather), directions,
      issuedAt: finite(row.DisplayDate) && row.DisplayDate > 0 ? row.DisplayDate : null };
  }
  return result;
}

const roadsUrl = () => {
  const params = new URLSearchParams({ where: '1=1', outFields: 'OBJECTID,PassName,RoadCondition,Weather,DisplayDate,TravelDirection1,PublicMessage1,TravelDirection2,PublicMessage2', returnGeometry: 'false', f: 'json' });
  return `https://data.wsdot.wa.gov/arcgis/rest/services/TravelInformation/TravelInfoMtPassReports/FeatureServer/0/query?${params}`;
};

export function createMorningSources(store, { fetchFn = fetch, now = Date.now, resortIds = Object.keys(MORNING_RESORTS) } = {}) {
  const stationJobs = new Map(resortIds.map(resortId => {
    const station = MORNING_RESORTS[resortId].station;
    const url = stationUrl(station);
    return [resortId, {
      id: 'nwac', key: `morning-nwac-${station.stid}`, name: `NWAC · ${station.name}`, url, ttl: HOUR,
      load: async timestamp => readStation(await fetchText(url, fetchFn, timestamp), station, timestamp),
    }];
  }));
  const roadJob = {
    id: 'wsdot', key: 'morning-wsdot', name: 'WSDOT pass reports', url: 'https://wsdot.com/travel/real-time/mountainpasses', ttl: HOUR / 2,
    load: async timestamp => parseRoadReports(JSON.parse(await fetchText(roadsUrl(), fetchFn, timestamp))),
  };
  const jobs = [...stationJobs.values(), roadJob];

  function read(resortId, timestamp = now()) {
    const stationJob = stationJobs.get(resortId);
    if (!stationJob) throw new Error('Unknown resort');
    const config = MORNING_RESORTS[resortId];
    const outcomes = [stationJob, roadJob].map(job => ({ job, result: store.read(job.key, job.ttl, { now: timestamp }) }));
    const [station, roads] = outcomes.map(({ result }) => result.data);
    const road = roads?.[config.road.passName];
    return {
      morning: {
        station: {
          ...config.station,
          snowfall24h: station?.snowfall24h ?? null,
          depth: station?.depth ?? null,
          temperature: station?.temperature ?? null,
        },
        road: road ? { ...road, url: config.road.url } : null,
        roadLink: config.road.url,
      },
      sources: outcomes.map(({ job, result }) => ({ id: job.id, name: job.name, url: job.url, status: result.status, fetchedAt: result.fetchedAt, refreshAfterMs: job.ttl, error: result.error, snapshotId: result.snapshotId ?? null })),
    };
  }

  async function collect() {
    const timestamp = now();
    return Promise.all(jobs.map(job => store.get(job.key, () => job.load(timestamp), job.ttl, { now: timestamp, provider: job.id })));
  }
  return { read, collect };
}
