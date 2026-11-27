import test from 'node:test';
import assert from 'node:assert/strict';
import * as app from '../server.mjs';

async function start(t, data = { sources: [], models: [], stations: [], snowLevels: [] }) {
  assert.equal(typeof app.createApp, 'function');
  const server = app.createApp({ load: async () => data, now: () => Date.parse('2026-01-04T20:00Z') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('dashboard exposes explicit limited advice when all live providers are unavailable', async t => {
  const base = await start(t);
  const response = await fetch(`${base}/api/dashboard`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.advice.now.status, 'limited');
  assert.equal(result.advice.tomorrow.status, 'limited');
  assert.deepEqual(result.models, []);
});

test('local server serves the actual interface and modules', async t => {
  const base = await start(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Stevens Pass/);
  assert.equal((await fetch(`${base}/app.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/lib/conditions.mjs`)).status, 200);
});

test('resort detail routes serve all comparison sections and the adopted layout stylesheet', async t => {
  const base = await start(t);
  for (const route of ['/location/stevenspass/snow-summary', '/user/favorites/locations/snow-summary?resort=stevenspass']) {
    const detail = await (await fetch(`${base}${route}`)).text();
    for (const section of ['live-daily', 'live-models', 'live-precip']) assert.match(detail, new RegExp(`id="${section}"`));
    assert.match(detail, /href="\/clone\/forecast-layout.css"/);
    assert.match(detail, /href="\/clone\/explore.css"/);
  }
  const styles = await fetch(`${base}/clone/forecast-layout.css`);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get('content-type'), /text\/css/);
});

test('Favorites opens the four-resort comparison and explicit resort links retain the detail screen', async t => {
  const base = await start(t);
  for (const route of ['/', '/user/favorites', '/user/favorites/locations/snow-summary?view=outlook']) {
    const html = await (await fetch(base + route)).text();
    assert.match(html, /data-page="resort-comparison"/);
    assert.match(html, /Compare resorts/);
    assert.match(html, /resort-comparison.mjs/);
    assert.doesNotMatch(html, /data-resort="stevenspass"/);
  }
  const detail = await (await fetch(base + '/location/crystalmountain/snow-summary')).text();
  assert.match(detail, /href="\/user\/favorites\/locations\/snow-summary"/);
  assert.match(detail, /data-resort="crystalmountain"/);
});

test('each resort detail exposes the morning and extended outlook views', async t => {
  const base = await start(t);
  for (const id of ['stevenspass', 'crystalmountain', 'summitcentral', 'mtbaker']) {
    const response = await fetch(`${base}/location/${id}/snow-summary`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`data-resort="${id}"`));
    assert.match(html, /data-live-slot="extended-outlook"/);
    assert.match(html, /data-live-slot="morning-conditions"/);
    const today = html.indexOf('id="live-summary"');
    const outlook = html.indexOf('id="live-extended"');
    const conditions = html.indexOf('id="live-conditions"');
    assert.ok(today >= 0 && today < outlook && outlook < conditions, 'Today is followed by the 15-day outlook and then conditions');
    assert.match(html, /href="#live-overnight">Today<\/a><a href="#live-extended">15 days<\/a><a href="#live-conditions">Conditions<\/a>/);
    assert.match(html, /href="\/clone\/mountain.css"/);
  }
  assert.equal((await fetch(`${base}/clone/assets/north-cascades-usfws.jpg`)).status, 200);
});

test('static requests cannot read source cache, package files, or traversal paths', async t => {
  const base = await start(t);
  for (const path of ['/package.json', '/.cache/forecast.json', '/%2e%2e%2fsrc/providers.mjs']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404);
  }
});

test('read-only API rejects mutation methods', async t => {
  const base = await start(t);
  assert.equal((await fetch(`${base}/api/dashboard`, { method: 'POST' })).status, 405);
});
