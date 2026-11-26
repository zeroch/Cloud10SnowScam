import { t } from '/lib/i18n.mjs';
import { METRICS, snowRange } from '/lib/forecast.mjs';
import { localParts, formatTime } from '/lib/time.mjs';
import { finite } from '/lib/conditions.mjs';
import { escape, amount, linePattern } from './live-view.mjs';

export function metricValue(value, metric) {
  if (!finite(value)) return t('Unavailable');
  if (metric === 'snow') return escape(snowRange({min:value,max:value}));
  const unit = METRICS[metric].unit;
  return `${metric === 'level' ? Math.round(value / 100) * 100 : amount(value, unit === 'in' ? 2 : 0)} ${t(unit)}`;
}

export function drawComparison(container, chart, metric, index, inspect) {
  const spec = METRICS[metric];
  const width = Math.max(260, Math.min(1400, container.clientWidth)), small = width < 600;
  const height = small ? 260 : 300, left = 10, right = 55, top = 25, bottom = 45;
  const plotW = width - left - right, plotH = height - top - bottom;
  const values = chart.lines.flatMap(line => line.values).filter(finite);
  const rawMin = metric === 'temperature' ? Math.floor(Math.min(...values, 30) / 10) * 10 : 0;
  const rawMax = metric === 'cloud' ? 100 : metric === 'level' ? Math.max(...values, 6000) : metric === 'temperature' ? Math.max(...values, 40) : Math.max(...values, metric === 'snow' ? 1 : spec.unit === 'in' ? 0.1 : 20);
  const roughStep = (rawMax - rawMin) / 4, magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const niceStep = [1, 2, 2.5, 5, 10].find(factor => factor * magnitude >= roughStep) * magnitude;
  const step = metric === 'snow' ? Math.ceil(niceStep) : niceStep;
  const min = Math.floor(rawMin / step) * step, max = Math.ceil(rawMax / step) * step;
  const ticks = Math.round((max - min) / step);
  const x = i => left + i / (chart.times.length - 1) * plotW;
  const y = value => top + (1 - (value - min) / (max - min || 1)) * plotH;
  let markup = '';
  for (let i = 0; i < chart.times.length - 1; i++) {
    const h = localParts(chart.times[i]).hour;
    if (h >= 18 || h < 6) markup += `<rect x="${x(i)}" y="${top}" width="${plotW / (chart.times.length - 1) + 0.1}" height="${plotH}" fill="#f3f5f7"/>`;
  }
  for (let i = 0; i <= ticks; i++) {
    const value = min + step * i;
    markup += `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" stroke="#b6c0ca" stroke-dasharray="3 4"/><text x="${width - right + 8}" y="${y(value) + 4}" fill="#677480" font-size="12">${metric === 'level' ? amount(value / 1000, 1) + 'k' : value.toLocaleString('en-US', { maximumFractionDigits: 4 })}</text>`;
  }
  for (let i = 0; i <= (small ? 2 : 4); i++) {
    const step = Math.round(i * (chart.times.length - 1) / (small ? 2 : 4));
    markup += `<text x="${x(step)}" y="${height - 14}" text-anchor="${i === 0 ? 'start' : i === (small ? 2 : 4) ? 'end' : 'middle'}" fill="#677480" font-size="12">${formatTime(chart.times[step], { weekday: 'short', minute: undefined })}</text>`;
  }
  if (metric === 'level') for (const [i, feet] of (chart.references || []).entries()) markup += `<line x1="${left}" x2="${width - right}" y1="${y(feet)}" y2="${y(feet)}" stroke="${i === 0 ? '#127b83' : '#b5763e'}" stroke-dasharray="8 5"/><text x="${left + 6}" y="${y(feet) - 6}" font-size="11" fill="#677480">${t('{0} ft', feet.toLocaleString())}</text>`;
  for (const line of chart.lines) {
    let path = '', connected = false;
    line.values.forEach((value, i) => {
      if (!finite(value)) { connected = false; return; }
      path += `${connected ? 'L' : 'M'}${x(i)},${y(value)} `; connected = true;
    });
    markup += `<path data-model-line="${line.id}" d="${path}" fill="none" stroke="${line.color}" stroke-width="2.5" stroke-dasharray="${linePattern(line.id)}" stroke-linecap="round"/>`;
  }
  if (!values.length) markup += `<text x="${left + plotW / 2}" y="${top + plotH / 2}" text-anchor="middle" fill="#677480">${chart.lines.length ? t('No data for this window') : t('Select a model to compare')}</text>`;
  else if (spec.mode === 'cumulative' && chart.lines.every(line => line.values.length === chart.times.length && line.values.every(finite)) && Math.max(...values) === 0) markup += `<text x="${left + plotW / 2}" y="${top + plotH / 2}" text-anchor="middle" fill="#677480">${t('No measurable {0} forecast', metric === 'snow' ? t('snow') : t('precipitation'))}</text>`;
  const title = metric === 'level' ? t('NWS snow-level forecast, independent of selected models') : t('{0} model comparison', t(spec.label));
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(title)}"><title>${escape(title)}</title>${markup}<text x="${width - right + 8}" y="14" fill="#677480" font-size="12">${t(spec.unit)}</text><line class="live-crosshair" x1="${x(index)}" x2="${x(index)}" y1="${top}" y2="${top + plotH}" stroke="#2b3e50" stroke-dasharray="4 4" opacity=".5"/></svg>`;
  const svg = container.querySelector('svg');
  const move = event => {
    const box = svg.getBoundingClientRect();
    inspect(Math.round(Math.max(0, Math.min(1, ((event.clientX - box.left) * width / box.width - left) / plotW)) * (chart.times.length - 1)), event.type === 'click');
  };
  svg.addEventListener('pointermove', move); svg.addEventListener('click', move);
  return value => { const line = svg.querySelector('.live-crosshair'); line.setAttribute('x1', x(value)); line.setAttribute('x2', x(value)); };
}
