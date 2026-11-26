import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as module from '../src/cache.mjs';

test('last successful source survives an upstream failure and a process restart', async t => {
  assert.equal(typeof module.createCache, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'stevens-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = module.createCache(dir);
  const result = await first.get('weather', async () => ({ temperature: 25 }), 1000, { now: 100_000 });
  assert.equal(result.status, 'fresh');
  const restarted = module.createCache(dir);
  const failed = await restarted.get('weather', async () => { throw new Error('provider offline'); }, 1000, { now: 110_000 });
  assert.equal(failed.status, 'stale');
  assert.equal(failed.data.temperature, 25);
  assert.equal(failed.fetchedAt, 100_000);
});

test('first-use source failure is unavailable rather than an empty success', async t => {
  assert.equal(typeof module.createCache, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'stevens-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await module.createCache(dir).get('weather', async () => { throw new Error('offline'); }, 1000);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.data, null);
});

test('concurrent source reads share a fetch and fresh cached values avoid new calls', async t => {
  assert.equal(typeof module.createCache, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'stevens-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cache = module.createCache(dir);
  let calls = 0;
  const loader = async () => { calls++; await new Promise(r => setTimeout(r, 15)); return { count: calls }; };
  const results = await Promise.all([cache.get('weather', loader, 1000), cache.get('weather', loader, 1000)]);
  assert.equal(results[0].data.count, 1);
  assert.equal(results[1].data.count, 1);
  assert.equal((await cache.get('weather', loader, 1000)).status, 'cached');
  assert.equal(calls, 1);
});
