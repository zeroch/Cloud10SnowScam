import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const modules = ['conditions', 'time', 'display', 'advice', 'forecast', 'dashboard-client', 'config', 'provider-core'];
const asset = 'public/nested/snow notes 雪.txt';
const privateFiles = ['public/nested/.env', 'public/nested/local notes.txt', 'src/.dev.vars', 'tests/scratch.json'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cloud10-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(checkout, 'scripts'), join(root, 'scripts'), {
    recursive: true, filter: path => basename(path) === 'scripts' || path.endsWith('.mjs'),
  });
  async function put(path, text) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const required = ['Dockerfile', 'compose.yaml', '.dockerignore', 'LICENSE', 'package.json', 'server.mjs',
    'docs/deployment/nas.md', 'deploy/cloudflare-pilot/worker.mjs', 'deploy/cloudflare-pilot/schema.sql',
    'public/index.html', 'public/clone/favorites.html', 'public/clone/stevens.html', asset,
    ...modules.map(name => 'src/' + name + '.mjs'), 'tests/fixtures/forecast.json', 'tests/dashboard-client.test.mjs'];
  for (const path of required) await put(path, path);
  await put('tests/dashboard-client.test.mjs', "import '../src/dashboard-client.mjs';");
  await put('.gitignore', '.env\n.dev.vars\n/dist/\n/sites/\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', '--', '.gitignore', ...required);
  await put(asset, 'edited after staging');
  for (const path of privateFiles) await put(path, 'local test marker');
  const run = name => execFileSync(process.execPath, [join(root, 'scripts', name)], { cwd: tmpdir(), encoding: 'utf8' });
  return { root, git, put, run };
}

// The NAS runtime image ships the application tests without Git or the release scripts.
const runtimeOnly = !existsSync(join(checkout, '.git')) && !existsSync(join(checkout, 'scripts'));
describe('release scripts', { skip: runtimeOnly }, () => {
  it('packages only tracked inputs in both the ZIP and its checksum manifest', async t => {
    const { root, run } = await fixture(t);
    const { archive, directory } = JSON.parse(run('package-nas.mjs'));
    const extracted = join(root, 'extracted');
    execFileSync('unzip', ['-q', archive, '-d', extracted]);
    const contents = join(extracted, basename(directory));
    const { files } = JSON.parse(await readFile(join(contents, 'manifest.json')));
    for (const path of privateFiles) {
      assert.equal(existsSync(join(contents, path)), false, path);
      assert.ok(!files.some(entry => entry.path === path), path);
    }
    assert.equal(await readFile(join(contents, asset), 'utf8'), 'edited after staging');
    assert.equal(files.find(entry => entry.path === asset).sha256, createHash('sha256').update('edited after staging').digest('hex'));
    assert.equal(await readFile(join(contents, 'NAS-README.md'), 'utf8'), 'docs/deployment/nas.md');
  });

  it('syncs only tracked assets while preserving site-owned files and remapped sources', async t => {
    const { root, put, run } = await fixture(t);
    await put('sites/clould10/public/site-owned.svg', 'site asset');
    run('sync-site.mjs');
    const site = join(root, 'sites/clould10');
    for (const path of privateFiles) assert.equal(existsSync(join(site, path)), false, path);
    for (const path of ['public/index.html', 'public/clone/favorites.html']) assert.equal(existsSync(join(site, path)), false);
    assert.equal(await readFile(join(site, asset), 'utf8'), 'edited after staging');
    assert.equal(await readFile(join(site, 'public/site-owned.svg'), 'utf8'), 'site asset');
    assert.equal(await readFile(join(site, 'content/favorites.html'), 'utf8'), 'public/clone/favorites.html');
    for (const path of ['public/lib/config.mjs', 'weather/shared/config.mjs']) {
      assert.equal(await readFile(join(site, path), 'utf8'), 'src/config.mjs');
    }
    assert.equal(await readFile(join(site, 'tests/dashboard-client.test.mjs'), 'utf8'), "import '../weather/shared/dashboard-client.mjs';");
  });

  for (const [script, required, output] of [
    ['package-nas.mjs', 'docs/deployment/nas.md', 'dist'], ['sync-site.mjs', 'tests/dashboard-client.test.mjs', 'sites'],
  ]) {
    it(script + ' rejects a required input removed from the index before writing output', async t => {
      const { root, git } = await fixture(t);
      git('rm', '--cached', '--quiet', '--', required);
      const result = spawnSync(process.execPath, [join(root, 'scripts', script)], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(required));
      assert.equal((await readdir(root)).includes(output), false);
    });

    it(script + ' rejects a tracked asset replaced with a symlink', async t => {
      const { root } = await fixture(t);
      await rm(join(root, asset));
      await symlink('local notes.txt', join(root, asset));
      const result = spawnSync(process.execPath, [join(root, 'scripts', script)], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(join(root, output)), false);
    });
  }
});
