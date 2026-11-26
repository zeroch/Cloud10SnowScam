// Local visual QA only. Not registered by server.mjs or copied into the runtime image.
// Edit /tmp/cloud10-qa-scenario.json, then reload to exercise a state without upstream calls.
import { readFileSync } from 'node:fs';
import { createApp } from '../server.mjs';
import { overnightFixture, EXAMPLE_NOW } from './fixtures/overnight.mjs';
import { horizonFixture, HORIZON_NOW } from './fixtures/horizon.mjs';

const H = 3_600_000;
function options() {
  try { return JSON.parse(readFileSync('/tmp/cloud10-qa-scenario.json', 'utf8')); }
  catch { return { scenario: 'split' }; }
}
function clock() {
  const phase = options().scenario;
  if (phase?.startsWith('horizon')) return phase === 'horizon-remaining' ? Date.parse('2026-10-17T09:30Z') : HORIZON_NOW;
  return phase === 'morning' ? Date.parse('2026-10-16T13:00Z')
    : phase === 'remaining' ? Date.parse('2026-10-16T11:30Z')
    : phase === 'ending' ? Date.parse('2026-10-16T12:30Z')
    : phase === 'approved' ? EXAMPLE_NOW + 24 * H : EXAMPLE_NOW;
}
function snapshot() {
  const { scenario = 'split' } = options();
  if (scenario.startsWith('horizon')) {
    const data = horizonFixture(clock());
    if (scenario === 'horizon-stale') data.sources[0].status = 'stale';
    if (scenario === 'horizon-mixed') {
      data.models[3].points.filter(p => p.time > Date.parse('2026-10-18T01:00Z') && p.time <= Date.parse('2026-10-18T13:00Z')).forEach(p => { p.snowIn = 1.8 / 12; });
      data.models.slice(2).forEach(m => m.points = m.points.filter(p => p.time !== Date.parse('2026-10-19T05:00Z')));
      data.snowLevels = data.snowLevels.filter(p => p.feet !== 4300);
    }
    if (scenario === 'horizon-empty') { data.models = []; data.sources[0].status = 'unavailable'; data.sources[0].fetchedAt = null; }
    if (scenario === 'horizon-trace') data.models.forEach(m => m.points.forEach(p => { if (p.snowIn !== null) p.snowIn = .0004 / 12; }));
    if (scenario === 'horizon-heavy') data.models.forEach(m => m.points.forEach(p => { if (p.snowIn !== null) p.snowIn = 24.2 / 12; }));
    if (['horizon-quality', 'horizon-reference'].includes(scenario)) {
      data.models.forEach(m => m.points.forEach(p => {
        if (p.snowIn !== null && p.time > Date.parse('2026-10-18T01:00Z') && p.time <= Date.parse('2026-10-18T13:00Z')) { p.snowIn = .5 / 12; p.precipIn = .5 / 12 / 7; }
        if (p.snowIn === 0 && p.time > Date.parse('2026-10-20T01:00Z') && p.time <= Date.parse('2026-10-20T13:00Z')) { p.precipIn = .12 / 12; p.temperatureF = 38; }
      }));
      data.snowLevels.filter(p => p.start >= Date.parse('2026-10-19T01:00Z') && p.end <= Date.parse('2026-10-19T13:00Z')).forEach(p => { p.feet = 1800; });
    }
    if (scenario === 'horizon-reference') {
      // Complete synthetic daytime coverage for visual comparison. The original
      // horizon fixtures keep their intentional gaps for missing-data checks.
      data.models.forEach((model, index) => {
        if (index === 4) return; // HRRR keeps its shorter available horizon.
        for (let day = 0; day < 5; day++) {
          const start = Date.parse('2026-10-17T13:00Z') + day * 24 * H;
          const snow = [0, 1, 0, 0, .5][day] * (1 + index * .08);
          for (let hour = 1; hour <= 12; hour++) model.points.push({
            time: start + hour * H, snowIn: snow / 12,
            precipIn: day === 3 ? .03 : snow / 12 / 7,
            temperatureF: [30, 29, 32, 38, 32][day] + index,
            windMph: 5 + day * 2, gustMph: 12 + day * 3,
            cloudPct: [45, 90, 25, 100, 80][day],
          });
        }
        model.points.sort((a, b) => a.time - b.time);
      });
      for (let day = 0; day < 5; day++) {
        const start = Date.parse('2026-10-17T13:00Z') + day * 24 * H;
        data.snowLevels.push({ start, end: start + 12 * H, feet: [2400, 1800, 3000, 4800, 4300][day] });
      }
      data.snowLevels.sort((a, b) => a.start - b.start);
    }
    return data;
  }
  if (scenario === 'error') throw new Error('Intentional QA source failure');
  const total = { zero: 0, trace: .0004, border: 3.9996, light: .12, heavy: 24.2 }[scenario];
  const alternatives = { 'one-high': [0,0,0,0,8], 'four-high': [0,6,6,6,8], near: [5.01,5.02,5.03,5.04,5.05], strong: [7,8,9,10,11] };
  const data = overnightFixture({ now: clock(), totals: alternatives[scenario] || (total == null ? null : Array(5).fill(total)) });
  if (scenario === 'approved') {
    data.models.forEach(model => model.points.forEach(point => { point.time += 24 * H; }));
    data.snowLevels.forEach(point => { point.start += 24 * H; point.end += 24 * H; });
  }
  if (alternatives[scenario]) data.snowLevels.forEach(p => { p.feet = 2000; });
  if (scenario === 'stale') { data.sources[0].status = 'stale'; data.sources[0].fetchedAt -= 6 * H; }
  if (scenario === 'single') data.models = data.models.slice(0, 1);
  if (scenario === 'missing') data.models[4].points[5].snowIn = null;
  if (scenario === 'nws-gap' || scenario === 'nws-stale-gap') data.snowLevels.splice(1, 1);
  if (scenario === 'nws-stale-gap') { data.sources[1].status = 'stale'; data.sources[1].fetchedAt -= 2 * H; }
  if (scenario === 'unavailable') { data.models = []; data.sources[0].status = 'unavailable'; data.sources[0].fetchedAt = null; }
  return data;
}
const app = createApp({ load: async () => {
  const delay = options().delayMs;
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  return snapshot();
}, now: clock });
const [handler] = app.listeners('request');
app.removeAllListeners('request');
app.on('request', (request, response) => {
  const end = response.end.bind(response);
  response.end = (body, ...args) => {
    if (body && response.getHeader('Content-Type')?.startsWith('text/html')) {
      body = body.toString()
        .replace('<body ', '<body data-design-sample="true" ')
        .replace('<span class="clould-nav-caption">', '<span class="tomorrow-sample">Sample</span><span class="clould-nav-caption">');
    }
    if (['/clone/overnight.css','/clone/explore.css','/clone/tomorrow.css','/clone/horizon.css','/clone/forecast-layout.css'].includes(request.url) && options().largeText) body = body.toString().replace(/font-size:\s*([.\d]+)px/g, (_, size) => `font-size:${Number(size) * 2}px`);
    if (request.url === '/clone/live.mjs') {
      body = body.toString().replace('state.now = Date.now()', `state.now = ${clock()}`);
    }
    return end(body, ...args);
  };
  handler(request, response);
});
app.listen(4174, '127.0.0.1', () => console.log('Cloud10 isolated design examples: http://127.0.0.1:4174 (NWAC off, no collection)'));
