import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unstable_dev } from 'wrangler';

const output = 'dist/cloudflare-production';
const worker = await unstable_dev(output + '/production.mjs', {
  config: 'deploy/cloudflare-production/wrangler.example.jsonc',
  local: true, bundle: false, port: 0, persistTo: process.argv[2],
  experimental: { disableExperimentalWarning: true },
});
try {
  const manifest = JSON.parse(await readFile(output + '/manifest.json', 'utf8'));
  for (const { route, sha256 } of manifest) {
    const response = await worker.fetch(route);
    assert.equal(response.status, 200, route);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(body).digest('hex'), sha256, route);
  }
  const health = await worker.fetch('/api/health');
  assert.equal(health.status, 503);
  assert.equal((await health.json()).storage, 'Cloudflare D1');
  assert.equal((await worker.fetch('/pages/detail-mtbaker.body')).status, 404);
  assert.equal((await worker.fetch('/styles.css', { method: 'POST' })).status, 405);
  console.log('Verified ' + manifest.length + ' exported responses, D1 and routing in the local Worker.');
} finally {
  await worker.stop();
}
