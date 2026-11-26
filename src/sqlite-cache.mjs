import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MINUTE = 60_000, DAY = 86_400_000;
const LIMITS = [
  { windowMs: MINUTE, units: 60 }, { windowMs: 60 * MINUTE, units: 300 },
  { windowMs: DAY, units: 2000 }, { windowMs: 32 * DAY, units: 60_000 },
];

// Only the collector receives get(). Request handlers receive the read adapter.
export function createSqliteCache(path, { leaseMs = 120_000, historyBytes = 200_000_000, random = Math.random, limits = LIMITS, clock = null } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { db.close(); throw new Error('Weather database schema is newer than this application'); }
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY, cache_key TEXT NOT NULL, hash TEXT NOT NULL,
      payload TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS snapshots_age ON snapshots(created_at);
    CREATE TABLE IF NOT EXISTS entries (
      cache_key TEXT PRIMARY KEY, snapshot_id INTEGER, fetched_at INTEGER,
      attempt_at INTEGER, next_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, error TEXT,
      lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS attempts (provider TEXT NOT NULL, at INTEGER NOT NULL, cost INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS attempts_provider_time ON attempts(provider, at);
    CREATE TABLE IF NOT EXISTS cooldowns (provider TEXT PRIMARY KEY, until_at INTEGER NOT NULL);
    PRAGMA user_version=1;
  `);
  let closed = false;
  const entry = key => db.prepare('SELECT e.*, s.payload, s.hash FROM entries e LEFT JOIN snapshots s ON s.id=e.snapshot_id WHERE e.cache_key=?').get(key);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };

  function read(key, ttl, { now = Date.now() } = {}) {
    const row = entry(key), data = row?.payload ? JSON.parse(row.payload) : null;
    const age = row?.fetched_at == null ? Infinity : now - row.fetched_at;
    return {
      data, fetchedAt: row?.fetched_at ?? null, snapshotId: row?.snapshot_id ?? null,
      status: data == null ? 'unavailable' : !row.error && age >= 0 && age < ttl ? 'cached' : 'stale',
      error: row?.error ?? (data == null ? 'Waiting for scheduled collection' : null),
      lastAttemptAt: row?.attempt_at ?? null, nextAttemptAt: row?.next_at ?? null,
    };
  }

  async function get(key, loader, ttl, { now = Date.now(), provider = null, cost = 1 } = {}) {
    if (!/^[a-z0-9-]+$/i.test(key) || !Number.isFinite(ttl) || ttl <= 0) throw new Error('Invalid collection job');
    const token = randomUUID();
    const claimed = transaction(() => {
      db.prepare('INSERT OR IGNORE INTO entries(cache_key) VALUES (?)').run(key);
      const row = entry(key);
      if (row.next_at > now || row.lease_until > now) return false;
      const cooldown = provider && db.prepare('SELECT until_at FROM cooldowns WHERE provider=?').get(provider)?.until_at;
      if (cooldown > now) {
        db.prepare('UPDATE entries SET next_at=?, error=? WHERE cache_key=?').run(cooldown, 'Provider cooldown; using last saved data', key);
        return false;
      }
      if (provider === 'open-meteo') {
        const exceeded = limits.filter(limit => {
          const used = db.prepare('SELECT COALESCE(SUM(cost),0) AS units FROM attempts WHERE provider=? AND at>?').get(provider, now - limit.windowMs).units;
          return used + cost > limit.units;
        });
        if (exceeded.length) {
          const next = now + Math.max(...exceeded.map(limit => limit.windowMs));
          db.prepare('UPDATE entries SET next_at=?, error=? WHERE cache_key=?').run(next, 'Local provider budget reached; collection paused', key);
          return false;
        }
      }
      db.prepare('UPDATE entries SET lease_token=?, lease_until=?, attempt_at=? WHERE cache_key=?').run(token, now + leaseMs, now, key);
      if (provider) db.prepare('INSERT INTO attempts(provider, at, cost) VALUES (?,?,?)').run(provider, now, cost);
      return true;
    });
    if (!claimed) return read(key, ttl, { now });

    let data, failure;
    try {
      data = await loader();
      if (data == null) throw new Error('Source returned no data');
      if (Buffer.byteLength(JSON.stringify(data)) > 2_000_000) throw new Error('Source payload exceeds storage limit');
    } catch (error) { failure = error; }
    const finishedAt = clock ? clock() : now;
    const published = transaction(() => {
      const row = entry(key);
      // A collector whose lease was replaced must not publish or change cooldowns.
      if (row.lease_token !== token || row.lease_until <= finishedAt) return false;
      if (failure) {
        const failures = row.failures + 1;
        const backoff = Math.min(6 * 60 * MINUTE, 5 * MINUTE * 6 ** Math.min(failures - 1, 4));
        const retryAfter = Number.isFinite(failure.retryAfterMs) ? Math.max(0, failure.retryAfterMs) : 0;
        const next = finishedAt + Math.max(retryAfter, Math.round(backoff * (1 + random() * 0.1)));
        db.prepare('UPDATE entries SET failures=?, error=?, next_at=?, lease_token=NULL, lease_until=0 WHERE cache_key=?')
          .run(failures, String(failure.message || 'Source unavailable').slice(0, 180), next, key);
        if (provider && retryAfter > 0) db.prepare('INSERT INTO cooldowns(provider, until_at) VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET until_at=MAX(until_at,excluded.until_at)').run(provider, next);
        return false;
      }
      const payload = JSON.stringify(data), hash = createHash('sha256').update(payload).digest('hex');
      let id = row.snapshot_id;
      if (row.hash !== hash) id = Number(db.prepare('INSERT INTO snapshots(cache_key,hash,payload,bytes,created_at) VALUES (?,?,?,?,?)').run(key, hash, payload, Buffer.byteLength(payload), finishedAt).lastInsertRowid);
      db.prepare('UPDATE entries SET snapshot_id=?, fetched_at=?, next_at=?, failures=0, error=NULL, lease_token=NULL, lease_until=0 WHERE cache_key=?').run(id, finishedAt, finishedAt + ttl, key);
      return true;
    });
    if (published) prune(finishedAt);
    const result = read(key, ttl, { now: finishedAt });
    return published ? { ...result, status: 'fresh' } : result;
  }

  function prune(now = Date.now()) {
    transaction(() => {
      db.prepare('DELETE FROM snapshots WHERE created_at<? AND id NOT IN (SELECT snapshot_id FROM entries WHERE snapshot_id IS NOT NULL)').run(now - 7 * DAY);
      let bytes = db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM snapshots').get().bytes;
      const old = db.prepare('SELECT id,bytes FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM entries WHERE snapshot_id IS NOT NULL) ORDER BY created_at').all();
      for (const row of old) {
        if (bytes <= historyBytes) break;
        db.prepare('DELETE FROM snapshots WHERE id=?').run(row.id); bytes -= row.bytes;
      }
      db.prepare('DELETE FROM attempts WHERE at<?').run(now - 32 * DAY);
    });
  }

  return {
    get, read, prune,
    stats(now = Date.now()) {
      const size = db.prepare('SELECT COUNT(*) AS snapshots, COALESCE(SUM(bytes),0) AS payloadBytes FROM snapshots').get();
      const usage = db.prepare("SELECT COUNT(*) AS requests, COALESCE(SUM(cost),0) AS units FROM attempts WHERE provider='open-meteo' AND at>?").get(now - DAY);
      return { ...size, openMeteoRequests24h: usage.requests, openMeteoCountedUnits24h: usage.units };
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
