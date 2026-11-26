import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const module = await import('../src/sqlite-cache.mjs').catch(() => ({}));
const M = 60_000, DAY = 24 * 60 * M;

async function setup(t, options = {}) {
  assert.equal(typeof module.createSqliteCache, 'function', 'SQLite cache must exist');
  const dir = await mkdtemp(join(tmpdir(), 'cloud10-sqlite-'));
  const path = join(dir, 'weather.sqlite');
  const stores = [];
  const open = () => { const db = module.createSqliteCache(path, { random: () => 0, ...options }); stores.push(db); return db; };
  t.after(async () => { stores.forEach(db => db.close()); await rm(dir, { recursive: true, force: true }); });
  return { open, db: open() };
}

test('SQLite reads survive reopening and never invoke a fetch', async t => {
  const { db, open } = await setup(t);
  await db.get('forecast', async () => ({ snow: 5 }), 30 * M, { now: 1000 });
  const restarted = open();
  assert.deepEqual(restarted.read('forecast', 30 * M, { now: 2000 }).data, { snow: 5 });
  assert.equal(restarted.read('forecast', 30 * M, { now: 2000 }).status, 'cached');
  assert.equal(restarted.read('missing', 30 * M, { now: 2000 }).status, 'unavailable');
  assert.equal(restarted.read('forecast', 30 * M, { now: 31 * M }).status, 'stale');
});

test('failure preserves the successful timestamp and Retry-After across restart', async t => {
  const { db, open } = await setup(t);
  await db.get('forecast', async () => ({ snow: 5 }), M, { now: 1000 });
  const error = Object.assign(new Error('Source responded HTTP 429'), { retryAfterMs: 2 * 60 * M });
  const result = await db.get('forecast', async () => { throw error; }, M, { now: 2 * M, provider: 'open-meteo', cost: 3 });
  assert.equal(result.status, 'stale');
  assert.equal(result.fetchedAt, 1000);
  assert.equal(result.nextAttemptAt, 122 * M);
  let calls = 0;
  await open().get('forecast', async () => { calls++; return { snow: 9 }; }, M, { now: 3 * M, force: true });
  assert.equal(calls, 0);
  const other = await open().get('other-resort', async () => { calls++; return {}; }, M, { now: 3 * M, provider: 'open-meteo', cost: 3 });
  assert.equal(calls, 0);
  assert.equal(other.status, 'unavailable');
});

test('first failure persists unavailable state and bounded retry timing', async t => {
  const { db, open } = await setup(t);
  let calls = 0;
  const bad = async () => { calls++; throw new Error('offline'); };
  assert.equal((await db.get('forecast', bad, 30 * M, { now: 0 })).status, 'unavailable');
  await open().get('forecast', bad, 30 * M, { now: M });
  assert.equal(calls, 1);
  await db.get('forecast', bad, 30 * M, { now: 5 * M });
  assert.equal(calls, 2);
  assert.equal(db.read('forecast', 30 * M, { now: 5 * M }).nextAttemptAt, 35 * M);
});

test('two SQLite connections reserve only one in-flight request', async t => {
  const { db, open } = await setup(t);
  let release, calls = 0;
  const pending = db.get('forecast', async () => { calls++; await new Promise(r => { release = r; }); return { snow: 5 }; }, M, { now: 1000 });
  await open().get('forecast', async () => { calls++; return { snow: 99 }; }, M, { now: 1000 });
  assert.equal(calls, 1);
  release(); await pending;
  assert.equal(db.read('forecast', M, { now: 1000 }).data.snow, 5);
});

test('expired collector cannot overwrite a newer committed snapshot', async t => {
  const { db, open } = await setup(t, { leaseMs: M });
  let release;
  const old = db.get('forecast', async () => { await new Promise(r => { release = r; }); return { snow: 1 }; }, M, { now: 0 });
  await open().get('forecast', async () => ({ snow: 8 }), M, { now: 2 * M });
  release(); await old;
  assert.equal(db.read('forecast', M, { now: 2 * M }).data.snow, 8);
});

test('unchanged payloads update check time without duplicating history', async t => {
  const { db } = await setup(t);
  const loader = async () => ({ snow: 5 });
  await db.get('forecast', loader, M, { now: 0 });
  await db.get('forecast', loader, M, { now: 2 * M });
  assert.equal(db.stats(2 * M).snapshots, 1);
  assert.equal(db.read('forecast', M, { now: 2 * M }).fetchedAt, 2 * M);
});

test('history retention preserves current snapshots and bounds old payload bytes', async t => {
  const { db } = await setup(t, { historyBytes: 30 });
  for (let i = 0; i < 5; i++) await db.get('forecast', async () => ({ value: 'abcdefgh' + i }), M, { now: i * DAY });
  db.prune(10 * DAY);
  assert.equal(db.stats(10 * DAY).snapshots, 1);
  assert.equal(db.read('forecast', M, { now: 10 * DAY }).data.value, 'abcdefgh4');
});

test('persisted Open-Meteo budget counts failed attempts and blocks excess calls', async t => {
  const { db, open } = await setup(t, { limits: [{ windowMs: DAY, units: 6 }] });
  let calls = 0;
  const loader = async () => { calls++; throw new Error('offline'); };
  for (const key of ['a', 'b', 'c']) await db.get(key, loader, M, { now: 1000, provider: 'open-meteo', cost: 3 });
  assert.equal(calls, 2);
  await open().get('d', loader, M, { now: 2000, provider: 'open-meteo', cost: 3 });
  assert.equal(calls, 2);
  assert.equal(db.stats(2000).openMeteoCountedUnits24h, 6);
});

test('a response completed after its lease expires is not published', async t => {
  let clock = 0;
  const { db } = await setup(t, { leaseMs: M, clock: () => clock });
  await db.get('forecast', async () => { clock = 2 * M; return { snow: 5 }; }, M, { now: 0 });
  assert.equal(db.read('forecast', M, { now: clock }).data, null);
});

test('successful retrieval and next due time use request completion time', async t => {
  let clock = 0;
  const { db } = await setup(t, { clock: () => clock });
  await db.get('forecast', async () => { clock = 1000; return { snow: 5 }; }, M, { now: 0 });
  const result = db.read('forecast', M, { now: clock });
  assert.equal(result.fetchedAt, 1000);
  assert.equal(result.nextAttemptAt, 61_000);
});
