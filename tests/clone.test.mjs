import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

async function start(t) {
  const server = createApp({ load: async () => ({ sources: [], models: [], stations: [], snowLevels: [] }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('comparison and resort routes render locally and preserve the live Snow Desk', async t => {
  const base = await start(t);
  for (const [path, title] of [
    ['/user/favorites/locations/snow-summary', 'Compare resorts'],
    ['/?resort=mtbaker', 'Mt. Baker'],
    ['/location/stevenspass/snow-summary', 'Daily Forecast'],
    ['/desk', 'Stevens Pass'],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, new RegExp(title));
    assert.match(html, /aria-label="Cloud10 home"/);
    assert.match(html, /src="\/clone\/brand\/cloud10-logo\.jpg"/);
    assert.match(html, /href="\/clone\/club\.css"/);
  }
});

test('the clone serves local visual assets without production scripts or remote image requests', async t => {
  const base = await start(t);
  const html = await (await fetch(base + '/location/stevenspass/snow-summary')).text();
  assert.match(html, /\/clone\/controller.mjs/);
  assert.doesNotMatch(html, /<(?:script|img|iframe)[^>]+src=["']https?:/i);
  assert.doesNotMatch(html, /__NUXT_DATA__|data-nuxt-data|on(?:load|click)=/i);
  const sources = [...html.matchAll(/(?:src|href)=["'](\/clone\/[^"']+)["']/g)].map(x => x[1]);
  assert.ok(sources.length > 10);
  const responses = await Promise.all([...new Set(sources)].map(path => fetch(base + path)));
  assert.ok(responses.every(response => response.status === 200));
});

test('clone asset routing does not expose research captures or escape its public directory', async t => {
  const base = await start(t);
  for (const path of ['/docs/research/2026-10-14-clone/favorites-desktop.json', '/clone/%2e%2e%2fserver.mjs', '/clone/assets/%2e%2e%2f%2e%2e%2fpackage.json']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
});

test('resort detail pages load live forecast slots without captured forecast values or locked charts', async t => {
  const base = await start(t);
  for (const path of ['/user/favorites/locations/snow-summary?resort=stevenspass', '/location/stevenspass/snow-summary']) {
    const html = await (await fetch(base + path)).text();
    assert.match(html, /data-live-slot="summary"/);
    assert.doesNotMatch(html, /clone-range-preview|Captured daily snowfall|All Models \(last 3 runs\)/);
    if (path.startsWith('/location/')) {
      assert.match(html, /id="live-extended"[\s\S]*data-live-slot="hourly-forecast"[\s\S]*id="live-conditions"/);
      assert.match(html, /href="#live-hourly"/);
    } else {
      assert.doesNotMatch(html, /data-live-slot="hourly-forecast"/);
    }
    assert.doesNotMatch(html, /Updated <strong>49 minutes ago|OpenSnow Forecast System using/);
    assert.match(html, /id="live-models"/);
    assert.doesNotMatch(html, /id="live-night-timing"|data-live-slot="night-timing"|href="#live-night-timing"/);
  }
  for (const path of ['/clone/live.mjs', '/clone/live-view.mjs', '/clone/live-chart.mjs', '/clone/live.css', '/lib/forecast.mjs']) {
    assert.equal((await fetch(base + path)).status, 200, path);
  }
});
