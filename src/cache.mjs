import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export function createCache(directory) {
  const memory = new Map(), pending = new Map();
  async function retrieve(key, loader, ttl, { force = false, now = Date.now() } = {}) {
    if (!/^[a-z0-9-]+$/i.test(key)) throw new Error('Invalid cache key');
    const file = join(directory, `${key}.json`);
    let previous = memory.get(key);
    if (!previous) {
      try { const saved = JSON.parse(await readFile(file, 'utf8')); if (saved.version === 1 && Number.isFinite(saved.fetchedAt) && saved.data != null) previous = saved; } catch { /* A cache miss is expected on first use. */ }
      if (previous) memory.set(key, previous);
    }
    const age = previous ? now - previous.fetchedAt : Infinity;
    if (previous && age >= 0 && ((!force && age < ttl) || (force && age < 60_000))) return { ...previous, status: 'cached', error: null };
    try {
      const data = await loader();
      if (data == null) throw new Error('Source returned no data');
      const entry = { version: 1, data, fetchedAt: now };
      memory.set(key, entry);
      try { await mkdir(directory, { recursive: true }); await writeFile(`${file}.tmp`, JSON.stringify(entry)); await rename(`${file}.tmp`, file); } catch (error) { console.warn(`Cache persistence failed for ${key}: ${error.code || 'write failed'}`); }
      return { ...entry, status: 'fresh', error: null };
    } catch (error) {
      return { data: previous?.data ?? null, fetchedAt: previous?.fetchedAt ?? null, status: previous ? 'stale' : 'unavailable', error: String(error.message || 'Source unavailable').slice(0, 180) };
    }
  }
  return {
    get(key, loader, ttl, options) {
      if (pending.has(key)) return pending.get(key);
      const task = retrieve(key, loader, ttl, options).finally(() => pending.delete(key));
      pending.set(key, task);
      return task;
    },
  };
}
