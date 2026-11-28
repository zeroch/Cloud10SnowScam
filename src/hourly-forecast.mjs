import { HOUR } from './time.mjs';
import { finite } from './conditions.mjs';
import { intervalTotal } from './forecast.mjs';

export const HOURLY_COUNT = 36;
export const VISIBLE_HOURS = 6;

const nonnegative = value => finite(value) && value >= 0 ? value : null;

// NOAA solar equations, evaluated at the forecast point and instant in UTC.
// https://gml.noaa.gov/grad/solcalc/solareqns.PDF
function isDaylight(time, { latitude, longitude }) {
  const date = new Date(time);
  const year = date.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const yearLength = Date.UTC(year + 1, 0, 1) - yearStart;
  const angle = 2 * Math.PI * (time - yearStart - 12 * HOUR) / yearLength;
  const { sin, cos, PI } = Math;
  const radians = PI / 180;
  const equation = 229.18 * (0.000075 + 0.001868 * cos(angle) - 0.032077 * sin(angle)
    - 0.014615 * cos(2 * angle) - 0.040849 * sin(2 * angle));
  const declination = 0.006918 - 0.399912 * cos(angle) + 0.070257 * sin(angle)
    - 0.006758 * cos(2 * angle) + 0.000907 * sin(2 * angle)
    - 0.002697 * cos(3 * angle) + 0.00148 * sin(3 * angle);
  const hourAngle = (date.getUTCHours() * 15 + longitude + equation / 4 - 180) * radians;
  const zenithCosine = sin(latitude * radians) * sin(declination) + cos(latitude * radians) * cos(declination) * cos(hourAngle);
  return zenithCosine > cos(90.833 * radians);
}

function hourlyWeather(snow, precip, cloud, temperature, time, resort) {
  if (snow > 0) return 'snow';
  if (precip > 0) return snow === 0 && finite(temperature) && temperature > 32 ? 'rain' : 'precipitation';
  if (precip === null || snow === null || cloud === null) return 'unknown';
  if (cloud >= 88) return 'cloudy';
  if (cloud >= 61) return 'mostly-cloudy';
  const day = isDaylight(time, resort);
  if (cloud >= 26) return day ? 'partly-cloudy-day' : 'partly-cloudy-night';
  if (cloud > 5) return day ? 'mostly-sunny' : 'mostly-clear';
  return day ? 'sunny' : 'clear';
}

function levelBand(feet, bands) {
  if (feet === null) return 'missing';
  const wholeFeet = Math.round(feet);
  if (wholeFeet <= bands.blueMax) return 'blue';
  if (wholeFeet < bands.purpleMin) return 'neutral';
  return wholeFeet <= bands.purpleMax ? 'purple' : 'green';
}

export function hourlyForecast(data, now) {
  const start = Math.ceil(now / HOUR) * HOUR;
  const points = data.models.find(model => model.id === 'ecmwf_ifs025')?.points ?? [];
  const byTime = new Map(points.map(point => [point.time, point]));
  const end = start + HOURLY_COUNT * HOUR;
  const intervals = (data.snowLevels ?? []).filter(interval => interval.start < end && interval.end > start);
  const elevation = Math.round(data.resort.elevationFt);
  const bands = { blueMax: elevation - 2000, purpleMin: elevation - 300, purpleMax: elevation + 300 };
  const hours = Array.from({ length: HOURLY_COUNT }, (_, index) => {
    const time = start + index * HOUR;
    // ECMWF accumulations belong to the preceding hour. Temperature, wind and sky are instantaneous.
    const ending = byTime.get(time + HOUR);
    const instant = byTime.get(time);
    const snowIn = nonnegative(ending?.snowIn);
    const temperatureF = finite(instant?.temperatureF) ? instant.temperatureF : null;
    const cloudPct = instant?.cloudPct <= 100 ? nonnegative(instant.cloudPct) : null;
    const level = intervals.find(period => period.start <= time && period.end >= time + HOUR);
    const feet = nonnegative(level?.feet);
    // Drop meter-to-foot conversion noise before rounding a 50-ft midpoint.
    const snowLevelFt = feet === null ? null : Math.round(Number(feet.toPrecision(15)) / 100) * 100;
    return {
      time, temperatureF, snowIn, cloudPct, snowLevelFt, levelBand: levelBand(feet, bands),
      windMph: nonnegative(instant?.windMph),
      weather: hourlyWeather(snowIn, nonnegative(ending?.precipIn), cloudPct, temperatureF, time, data.resort),
    };
  });
  const totalSnowIn = intervalTotal(points, start, end, 'snowIn').total;
  const durations = new Set(intervals.map(interval => (interval.end - interval.start) / HOUR));
  const intervalHours = durations.size === 1 ? [...durations][0] : null;
  return { hours, bands, totalSnowIn, intervalHours };
}
