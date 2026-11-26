// Local visual QA only. No collection, database, or production route imports it.
// Set /tmp/cloud10-comparison-qa.json to exercise failure, stale, remaining,
// mixed-weather, uncertain-snow, or largeText states, then reload the preview.
import { existsSync, readFileSync } from 'node:fs';
import { createApp } from '../server.mjs';
import { resortComparisonFixture, resortComparisonUncertainFixture, COMPARISON_NOW } from './fixtures/resort-comparison.mjs';

function options() {
  try { return JSON.parse(readFileSync('/tmp/cloud10-comparison-qa.json', 'utf8')); }
  catch { return {}; }
}
const clock = () => COMPARISON_NOW + (options().scenario === 'remaining' ? 9.5 * 3_600_000 : 0);
function snapshot(resortId) {
  const { scenario } = options();
  if (scenario === 'failure' && resortId === 'summitcentral') throw new Error('Intentional comparison QA failure');
  const data = (scenario === 'uncertain-snow' ? resortComparisonUncertainFixture : resortComparisonFixture)(clock())[resortId].data;
  if (scenario === 'stale' && resortId === 'crystalmountain') data.sources[0].fetchedAt -= 3_600_000;
  if (scenario === 'mixed-weather') {
    const total = { stevenspass: 0, crystalmountain: .25, summitcentral: .0004 }[resortId];
    if (total != null) data.models.forEach(m => m.points.forEach(p => { p.snowIn = total / 12; p.precipIn = .02; p.temperatureF = 38; }));
    if (resortId === 'mtbaker') { data.models = []; data.sources[0].status = 'unavailable'; }
  }
  return data;
}
const app = createApp({ load: async ({ resortId }) => snapshot(resortId), now: clock });
const [handler] = app.listeners('request');
app.removeAllListeners('request');
const qaFiles = new Set(['source.png', 'comparison.html', 'phone-sample.jpg', 'phone-live.jpg', 'comparison-pair.jpg']);
app.on('request', (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path.startsWith('/qa/') && qaFiles.has(path.slice(4))) {
    const file = new URL('../docs/ux/2026-10-18-resort-comparison/' + path.slice(4), import.meta.url);
    if (!existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader('Content-Type', path.endsWith('.png') ? 'image/png' : path.endsWith('.jpg') ? 'image/jpeg' : 'text/html');
    response.end(readFileSync(file));
    return;
  }
  const end = response.end.bind(response);
  response.end = (body, ...args) => {
    if (body && response.getHeader('Content-Type')?.startsWith('text/html')) {
      body = body.toString().replace('<button id="compare-menu"', '<span style="margin-left:auto;margin-right:14px;font-size:12px;color:#526f86;background:#e6f4fc;border-radius:14px;padding:5px 10px">Sample data</span><button id="compare-menu"');
    }
    if (path === '/clone/resort-comparison.mjs') body = body.toString().replace('Date.now()', String(clock()));
    if (path === '/clone/resort-comparison.css' && options().largeText) body = body.toString().replace(/font-size:\s*([.\d]+)px/g, (_, n) => `font-size:${Number(n) * 2}px`);
    return end(body, ...args);
  };
  handler(request, response);
});
app.listen(4176, '127.0.0.1', () => console.log('Comparison visual QA: http://127.0.0.1:4176 (synthetic data; no collection)'));
