import { displayLanguage, t, convertWeather, weatherUnit } from '/lib/i18n.mjs';
import { HOUR, ZONE } from '/lib/time.mjs';
import { hourlyForecast, VISIBLE_HOURS } from '/lib/hourly-forecast.mjs';
import { escape } from './live-view.mjs';

const conditions = {
  snow: ['snow', 'Snow'], rain: ['rain', 'Rain'], precipitation: ['droplet', 'Precipitation type uncertain'],
  cloudy: ['cloud', 'Cloudy'], 'mostly-cloudy': ['clouds', 'Mostly cloudy'],
  'partly-cloudy-day': ['cloud-sun', 'Partly cloudy'], 'partly-cloudy-night': ['cloud-moon', 'Partly cloudy night'],
  sunny: ['sun', 'Sunny'], 'mostly-sunny': ['sun', 'Mostly sunny'],
  clear: ['moon', 'Clear night'], 'mostly-clear': ['moon', 'Mostly clear'], unknown: ['unknown', 'Unknown'],
};

function weatherIcon(condition, decorative = false) {
  const [name, description] = conditions[condition];
  const semantics = decorative ? 'aria-hidden="true"' : `role="img" aria-label="${t(description)}"`;
  return `<svg class="hourly-icon icon-${name}" ${semantics} focusable="false" viewBox="0 0 24 24"><use href="/clone/icons/hourly-weather.svg#${name}"></use></svg>`;
}

function hourLabels(hours, zone) {
  const format = options => new Intl.DateTimeFormat(displayLanguage, { timeZone: zone, ...options });
  const date = format({ weekday: 'short', month: 'short', day: 'numeric' });
  const weekday = format({ weekday: 'short' });
  const dayOfMonth = format({ day: 'numeric' });
  const hour = format({ hour: 'numeric' });
  const full = format({ weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', timeZoneName: 'short' });
  const interval = format({ month: 'short', day: 'numeric', hour: 'numeric', timeZoneName: 'short' });
  const zoneName = format({ timeZoneName: 'shortGeneric' }).formatToParts(hours[0].time).find(p => p.type === 'timeZoneName').value;
  const days = [], headers = [];
  for (const { time } of hours) {
    const label = date.format(time);
    const beginsDay = days.at(-1)?.label !== label;
    if (beginsDay) {
      const day = dayOfMonth.format(time);
      days.push({ label, compact: `${weekday.format(time)} ${day}`, narrow: day, count: 0 });
    }
    days.at(-1).count++;
    const text = hour.format(time);
    headers.push({ time, text, full: full.format(time), beginsDay });
  }
  return { days, headers, zoneName, range: interval.formatRange(hours[0].time, hours.at(-1).time + HOUR) };
}

const positionLabel = (index, count) => t('Hours {0}–{1} of {2}', index + 1, index + VISIBLE_HOURS, count);

export function renderHourlyForecast(data, state) {
  const { hours, totalSnowIn, bands, intervalHours } = hourlyForecast(data, state.now);
  const { days, headers, zoneName, range } = hourLabels(hours, data.resort.timezone ?? ZONE);
  const point = escape(t(data.resort.pointLabel));
  const decimal = new Intl.NumberFormat(displayLanguage, { maximumFractionDigits: 2 });
  const number = (value, digits = 0) => {
    if (value === null) return '—';
    if (value > 0 && value < 10 ** -digits) return '&lt;' + decimal.format(10 ** -digits);
    return decimal.format(Number(value.toFixed(digits)));
  };
  const depthUnit = weatherUnit('in');
  const snow = amount => number(convertWeather(amount, 'in'), 2);
  const row = (name, unit, cell) => `<tr><th scope="row">${t(name)}${unit ? `<small>${unit}</small>` : ''}</th>${hours.map((h, i) => {
    const { value, attrs = '' } = cell(h);
    return `<td${headers[i].beginsDay && i ? ' class="hourly-midnight"' : ''}${attrs}>${value}</td>`;
  }).join('')}</tr>`;
  const levelCell = h => {
    const delta = h.snowLevelFt - Math.round(data.resort.elevationFt);
    let relative = t('At {0} elevation', point);
    if (delta < 0) relative = t('{0} ft below {1}', number(-delta), point);
    if (delta > 0) relative = t('{0} ft above {1}', number(delta), point);
    const label = h.snowLevelFt === null ? t('Snow level unavailable') : t('{0} ft, {1}', number(h.snowLevelFt), relative);
    return { value: number(h.snowLevelFt), attrs: ` data-level-band="${h.levelBand}" aria-label="${label}" title="${label}"` };
  };
  const keyConditions = ['snow', 'rain', 'cloudy', 'partly-cloudy-day', 'sunny', 'clear'];
  const keyIcons = new Set(keyConditions.map(condition => conditions[condition][0]));
  for (const { weather } of hours) {
    const [icon] = conditions[weather];
    if (!keyIcons.has(icon)) {
      keyConditions.push(weather);
      keyIcons.add(icon);
    }
  }
  const weatherKey = keyConditions.map(condition =>
    `<span>${weatherIcon(condition, true)}${t(conditions[condition][1])}</span>`).join('');
  const levelKey = [
    ['blue', t('Blue ≤{0}', number(bands.blueMax))],
    ['neutral', t('Neutral between {0} and {1}', number(bands.blueMax), number(bands.purpleMin))],
    ['purple', t('Purple {0}–{1}', number(bands.purpleMin), number(bands.purpleMax))],
    ['green', t('Green >{0}', number(bands.purpleMax))],
  ].map(([band, label]) => `<span data-level-band="${band}"><i aria-hidden="true"></i>${label}</span>`).join('');
  const sourceLabel = (id, name) => {
    const status = data.sources?.find(source => source.id === id)?.status;
    return status === 'stale' || status === 'unavailable' ? `${name} (${t(status)})` : name;
  };
  const staleModel = data.sources?.some(s => s.id === 'forecast' && s.status === 'stale');
  const totalCaption = staleModel ? t('36-hour snowfall · stale forecast') : t('36-hour snowfall');
  return `<details id="hourly-card" class="hourly-card" open>
    <summary id="hourly-toggle"><h2>${t('Hourly forecast')}</h2><span class="hourly-range">${range}</span>
      <span class="hourly-total"><strong>${snow(totalSnowIn)}${totalSnowIn === null ? '' : ' ' + depthUnit}</strong><small>${totalCaption}</small></span>
      <i class="hourly-chevron" aria-hidden="true"></i></summary>
    <div id="hourly-grid" class="hourly-scroll" role="region" tabindex="0" aria-label="${t('Scroll through 36 forecast hours')}" aria-describedby="hourly-source">
      <table aria-label="${t('Hourly forecast for {0}', point)}"><colgroup><col class="hourly-metric-col"></colgroup>
        ${days.map(d => `<colgroup span="${d.count}"></colgroup>`).join('')}
        <thead><tr><th rowspan="2" scope="col">${t('Hour')}<small>${zoneName}</small></th>
          ${days.map(d => `<th scope="colgroup" colspan="${d.count}" class="hourly-day" aria-label="${d.label}" data-compact="${d.compact}" data-narrow="${d.narrow}"><span aria-hidden="true">${d.label}</span></th>`).join('')}
        </tr><tr>${headers.map(h => `<th scope="col" class="hourly-hour${h.beginsDay ? ' hourly-midnight' : ''}" aria-label="${h.full}"><time datetime="${new Date(h.time).toISOString()}" title="${h.full}">${h.text}</time></th>`).join('')}</tr></thead>
        <tbody>
          ${row('Weather', '', h => ({ value: weatherIcon(h.weather) }))}
          ${row('Temperature', weatherUnit('°F'), h => ({
            value: h.temperatureF === null ? '—' : Math.round(convertWeather(h.temperatureF, '°F')),
          }))}
          ${row('Snowfall', depthUnit, h => ({ value: snow(h.snowIn) }))}
          ${row('Snow level', t('ft'), levelCell)}
          ${row('Wind', t('mph'), h => ({ value: number(h.windMph, 1) }))}
          ${row('Cloud cover', '%', h => ({ value: number(h.cloudPct) + (h.cloudPct === null ? '' : `<meter min="0" max="100" value="${h.cloudPct}" aria-hidden="true"></meter>`) }))}
        </tbody>
      </table>
    </div>
    <div class="hourly-footer">
      <div class="hourly-browse"><div class="hourly-controls">
        <button type="button" id="hourly-earlier" aria-controls="hourly-grid" aria-label="${t('Previous six hours')}" disabled>←</button>
        <span role="status" class="hourly-position">${positionLabel(0, hours.length)}</span>
        <button type="button" id="hourly-later" aria-controls="hourly-grid" aria-label="${t('Next six hours')}">→</button>
      </div><small id="hourly-source">${sourceLabel('forecast', 'ECMWF')} · ${t('Snow level from {0}, rounded to 100 ft', sourceLabel('nws', 'NWS'))}${intervalHours ? ' · ' + t('{0}-hour intervals', intervalHours) : ''}</small></div>
      <div class="hourly-key"><strong>${t('Bands before rounding')} (${t('ft')}) · ${point} ${number(data.resort.elevationFt)}</strong>${levelKey}</div>
      <div class="hourly-key"><strong>${t('Icon key')}</strong>${weatherKey}</div>
    </div>
  </details>`;
}

// Store the first visible instant so unit, language and clock updates keep the skier's place.
export function bindHourlyForecast(card, position) {
  const viewport = card.querySelector('.hourly-scroll');
  const earlier = card.querySelector('#hourly-earlier'), later = card.querySelector('#hourly-later');
  const status = card.querySelector('.hourly-position');
  const days = card.querySelectorAll('.hourly-day');
  const columns = viewport.querySelectorAll('time');
  const firstTime = Date.parse(columns[0].dateTime);
  const last = columns.length - VISIBLE_HOURS;
  let first;
  function fitDates() {
    if (!card.open) return;
    const columnWidth = columns[0].parentElement.getBoundingClientRect().width;
    let dayStart = 0;
    for (const day of days) {
      const dayEnd = dayStart + day.colSpan;
      const visible = Math.min(dayEnd, first + VISIBLE_HOURS) - Math.max(dayStart, first);
      dayStart = dayEnd;
      if (visible <= 0) continue;
      day.toggleAttribute('data-single', visible === 1);
      const stamp = day.firstElementChild;
      for (const label of [day.getAttribute('aria-label'), day.dataset.compact, day.dataset.narrow]) {
        if (stamp.textContent !== label) stamp.textContent = label;
        if (stamp.getBoundingClientRect().width <= visible * columnWidth) break;
      }
    }
  }
  function setPosition(index) {
    first = Math.max(0, Math.min(last, index));
    position.time = first ? firstTime + first * HOUR : null;
    const label = positionLabel(first, columns.length);
    if (status.textContent !== label) status.textContent = label;
    earlier.disabled = first === 0;
    later.disabled = first === last;
    fitDates();
  }
  function go(index) {
    setPosition(index);
    if (card.open) viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) * first / last;
  }
  card.open = position.open;
  go(position.time === null ? 0 : Math.round((position.time - firstTime) / HOUR));
  card.addEventListener('toggle', () => {
    if (!card.isConnected) return;
    position.open = card.open;
    if (card.open) go(first);
  });
  earlier.addEventListener('click', () => go(first - VISIBLE_HOURS));
  later.addEventListener('click', () => go(first + VISIBLE_HOURS));
  viewport.addEventListener('scroll', () => {
    const distance = viewport.scrollWidth - viewport.clientWidth;
    const index = Math.round(viewport.scrollLeft / distance * last);
    if (card.open && distance > 0 && first !== index) setPosition(index);
  }, { passive: true });
  card.addEventListener('keydown', event => {
    if (!card.open || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const keys = { ArrowLeft: first - 1, ArrowRight: first + 1, PageUp: first - VISIBLE_HOURS, PageDown: first + VISIBLE_HOURS, Home: 0, End: last };
    if (!Object.hasOwn(keys, event.key)) return;
    event.preventDefault();
    go(keys[event.key]);
  });
}
