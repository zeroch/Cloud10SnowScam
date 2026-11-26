import { t } from '/lib/i18n.mjs';
import { localParts, formatTime } from '/lib/time.mjs';
import { finite } from '/lib/conditions.mjs';
import { snowRange } from '/lib/forecast.mjs';
import { chartMessage } from '/lib/display.mjs';

export const METRICS = { snow: { label: 'Snowfall', unit: 'in', note: 'Cumulative forecast snow from the chart start' }, temperature: { label: 'Temperature', unit: '°F', note: 'Temperature at the requested 4,800 ft elevation' }, level: { label: 'Snow level', unit: 'ft', note: 'NWS rain/snow transition · separate from freezing level' }, wind: { label: 'Wind gusts', unit: 'mph', note: 'Forecast gusts · exposure differs from lift-top sensors' } };
const n = value => Math.round(value * 100) / 100;

export function drawChart(container, chart, metric, selectedIndex, onInspect) {
  const W = Math.max(260, Math.min(1200, container.clientWidth)), compact = W < 540;
  const H = compact ? 235 : 276, L = compact ? 5 : 18, R = compact ? 40 : 61, T = 27, B = 41, width = W - L - R, height = H - T - B;
  chart.geometry = { left: L, width };
  const values = chart.lines.flatMap(l => l.values).filter(finite);
  let min = metric === 'temperature' ? Math.floor(Math.min(...values, 30) / 10) * 10 : 0;
  let max = metric === 'temperature' ? Math.ceil(Math.max(...values, 40) / 10) * 10 : metric === 'level' ? Math.ceil(Math.max(...values, 6000) / 2000) * 2000 : metric === 'wind' ? Math.ceil(Math.max(...values, 20) / 10) * 10 : Math.ceil(Math.max(...values, 1));
  if (max === min) max = min + 1;
  const gridStep = metric === 'snow' ? Math.ceil(max / 4) : (max - min) / 4;
  if (metric === 'snow') max = Math.ceil(max / gridStep) * gridStep;
  const gridTicks = Math.round((max - min) / gridStep);
  const x = i => L + i / (chart.times.length - 1) * width;
  const y = value => T + (1 - (value - min) / (max - min)) * height;
  let shades = '';
  for (let i = 0; i < chart.times.length - 1; i++) {
    const hour = localParts(chart.times[i]).hour;
    if (hour >= 18 || hour < 6) shades += `<rect x="${n(x(i))}" y="${T}" width="${n(width / (chart.times.length - 1) + 0.2)}" height="${height}" fill="#eaf0f1"/>`;
  }
  let grid = '';
  for (let i = 0; i <= gridTicks; i++) {
    const value = min + i * gridStep;
    grid += `<line x1="${L}" y1="${n(y(value))}" x2="${W - R}" y2="${n(y(value))}" stroke="#dce5e7" stroke-dasharray="3 5"/><text x="${W - R + 13}" y="${n(y(value) + 4)}" fill="#60737b" font-size="12">${metric === 'level' ? `${n(value / 1000)}k` : n(value)}</text>`;
  }
  const ticks = compact ? 2 : 4;
  for (let i = 0; i <= ticks; i++) {
    const index = Math.round(i * (chart.times.length - 1) / ticks);
    grid += `<text x="${n(x(index))}" y="${H - 12}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}" fill="#60737b" font-size="12">${formatTime(chart.times[index], { weekday: 'short', minute: undefined })}</text>`;
  }
  let references = '';
  if (metric === 'level') for (const [value, label] of [[2000, t('2,000 ft · favorable')], [4000, t('4,000 ft · borderline')]]) references += `<line x1="${L}" y1="${y(value)}" x2="${W - R}" y2="${y(value)}" stroke="${value === 4000 ? '#b5763e' : '#127b83'}" stroke-dasharray="7 5" opacity=".65"/><text x="${L + 8}" y="${y(value) - 7}" fill="#526a6c" font-size="11">${label}</text>`;
  const paths = chart.lines.map(line => {
    let d = '', connected = false;
    line.values.forEach((value, i) => { if (!finite(value)) { connected = false; return; } d += `${connected ? 'L' : 'M'}${n(x(i))},${n(y(value))} `; connected = true; });
    return `<path d="${d}" fill="none" stroke="${line.color}" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  const message = chartMessage(chart, metric);
  const emptyText = compact && message === t('No measurable snow in this forecast window') ? t('No measurable snow forecast') : message;
  container.innerHTML = `<svg class="forecast-svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chart-title chart-description"><title id="chart-title">${t('{0} forecast comparison', t(METRICS[metric].label))}</title><desc id="chart-description">${t('{0}. Shaded hours are 6 pm to 6 am Pacific. Use the time slider or data table to inspect values.', t(METRICS[metric].note))}</desc>${shades}${grid}${references}${paths}<text x="${W - R + 12}" y="13" fill="#60737b" font-size="11">${t(METRICS[metric].unit)}</text>${emptyText ? `<text x="${L + width / 2}" y="${T + height / 2}" text-anchor="middle" fill="#60737b" font-size="14">${emptyText}</text>` : ''}<line id="chart-crosshair" x1="${x(selectedIndex)}" x2="${x(selectedIndex)}" y1="${T}" y2="${H - B}" stroke="#163d46" stroke-width="1" opacity=".3" stroke-dasharray="3 4"/></svg>`;
  const svg = container.querySelector('svg');
  const inspect = event => {
    const box = svg.getBoundingClientRect();
    const screenX = (event.clientX - box.left) / box.width * W;
    const i = Math.round(Math.max(0, Math.min(1, (screenX - L) / width)) * (chart.times.length - 1));
    const line = container.querySelector('#chart-crosshair'); line.setAttribute('x1', x(i)); line.setAttribute('x2', x(i)); onInspect(i);
  };
  svg.addEventListener('pointermove', inspect); svg.addEventListener('click', inspect);
}

export function valueLabel(value, metric) {
  if (!finite(value)) return t('Unavailable');
  if (metric === 'snow') return snowRange({ min: value, max: value });
  return metric === 'level' ? t('{0} ft', Math.round(value / 100) * 100) : `${Math.round(value)}${metric === 'temperature' ? '°F' : t(' mph')}`;
}
