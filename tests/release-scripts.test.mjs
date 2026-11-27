import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const modules = ['conditions', 'time', 'display', 'advice', 'forecast', 'dashboard-client', 'config', 'provider-core'];
const asset = 'public/nested/snow notes 雪.txt';
const planned = 'public/nested/planned.txt';
const stagedEmpty = 'public/staged-empty.txt';
const privateFiles = [planned, 'public/nested/.env', 'public/nested/local notes.txt', 'src/.dev.vars', 'tests/scratch.json'];

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
  await put(stagedEmpty, '');
  await put('tests/dashboard-client.test.mjs', "import '../src/dashboard-client.mjs';");
  await put('.gitignore', '.env\n.dev.vars\n/dist/\n/sites/\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', '--', '.gitignore', stagedEmpty, ...required);
  await put(asset, 'edited after staging');
  for (const path of privateFiles) await put(path, 'local test marker');
  git('add', '-N', '--', planned);
  const run = name => execFileSync(process.execPath, [join(root, 'scripts', name)], { cwd: tmpdir(), encoding: 'utf8', stdio: 'pipe' });
  async function addSiteAsset() {
    await put('sites/clould10/public/site-owned.svg', 'site asset');
    const cwd = join(root, 'sites/clould10');
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['add', '--', 'public/site-owned.svg'], { cwd });
  }
  return { root, git, put, run, addSiteAsset };
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
    assert.equal(await readFile(join(contents, stagedEmpty), 'utf8'), '');
    assert.equal(files.find(entry => entry.path === asset).sha256, createHash('sha256').update('edited after staging').digest('hex'));
    assert.equal(await readFile(join(contents, 'NAS-README.md'), 'utf8'), 'docs/deployment/nas.md');
  });

  it('syncs only tracked assets while preserving site-owned files and remapped sources', async t => {
    const { root, put, addSiteAsset, run } = await fixture(t);
    await addSiteAsset();
    await put('public/site-owned.svg', 'untracked source file with the same name');
    run('sync-site.mjs');
    run('sync-site.mjs');
    const site = join(root, 'sites/clould10');
    for (const path of privateFiles) assert.equal(existsSync(join(site, path)), false, path);
    for (const path of ['public/index.html', 'public/clone/favorites.html']) assert.equal(existsSync(join(site, path)), false);
    assert.equal(await readFile(join(site, asset), 'utf8'), 'edited after staging');
    assert.equal(await readFile(join(site, stagedEmpty), 'utf8'), '');
    assert.equal(await readFile(join(site, 'public/site-owned.svg'), 'utf8'), 'site asset');
    assert.equal(await readFile(join(site, 'content/favorites.html'), 'utf8'), 'public/clone/favorites.html');
    for (const path of ['public/lib/config.mjs', 'weather/shared/config.mjs']) {
      assert.equal(await readFile(join(site, path), 'utf8'), 'src/config.mjs');
    }
    assert.equal(await readFile(join(site, 'tests/dashboard-client.test.mjs'), 'utf8'), "import '../weather/shared/dashboard-client.mjs';");
  });

  it('removes a previously synced asset when Git stops tracking it', async t => {
    const { root, git, put, addSiteAsset, run } = await fixture(t);
    await addSiteAsset();
    run('sync-site.mjs');
    git('rm', '--cached', '-f', '--', asset);
    await put(asset, 'local revision');
    run('sync-site.mjs');
    assert.equal(existsSync(join(root, 'sites/clould10', asset)), false);
    assert.equal(await readFile(join(root, 'sites/clould10/public/site-owned.svg'), 'utf8'), 'site asset');
  });

  it('detects a destination-only legacy file on first sync or after ownership cache loss', async t => {
    const { root, put, addSiteAsset, run } = await fixture(t);
    await addSiteAsset();
    const orphan = 'sites/clould10/public/old-local.json';
    await put(orphan, 'local-only');
    assert.throws(() => run('sync-site.mjs'), /old-local\.json/);
    assert.equal(await readFile(join(root, orphan), 'utf8'), 'local-only');
    await rm(join(root, orphan));
    run('sync-site.mjs');
    await rm(join(root, '.cache'), { recursive: true });
    await put(orphan, 'another local-only file');
    assert.throws(() => run('sync-site.mjs'), /old-local\.json/);
  });

  it('protects edited site files and reports ambiguous leftovers from older syncs', async t => {
    const { root, git, put, run } = await fixture(t);
    const siteFile = 'sites/clould10/' + asset;
    await put('sites/clould10/public/nested/.env', 'existing file');
    assert.throws(() => run('sync-site.mjs'), /public\/nested\/\.env/);
    await rm(join(root, 'sites/clould10/public/nested/.env'));
    run('sync-site.mjs');
    git('rm', '--cached', '-f', '--', asset);
    await put(siteFile, 'site edit');
    assert.throws(() => run('sync-site.mjs'), /snow notes/);
    assert.equal(await readFile(join(root, siteFile), 'utf8'), 'site edit');
  });

  it('rejects redirected site directories before publishing into them', async t => {
    const { root, put, run } = await fixture(t);
    await put('independent/keep.txt', 'keep');
    await mkdir(join(root, 'sites/clould10/public'), { recursive: true });
    await symlink(join(root, 'independent'), join(root, 'sites/clould10/public/nested'), 'dir');
    assert.throws(() => run('sync-site.mjs'), /nested/);
    assert.deepEqual(await readdir(join(root, 'independent')), ['keep.txt']);
  });

  it('fails before packaging when a required application tree is missing from Git', async t => {
    const { root, git, run } = await fixture(t);
    git('rm', '--cached', '-r', '--quiet', '--', 'src');
    assert.throws(() => run('package-nas.mjs'), /src/);
    assert.equal(existsSync(join(root, 'dist')), false);
  });

  it('keeps application files and NAS directories readable under a restrictive build umask', async t => {
    const { root } = await fixture(t);
    await chmod(join(root, asset), 0o644);
    await chmod(dirname(join(root, asset)), 0o755);
    function restricted(script) {
      return execFileSync(process.execPath, ['--input-type=module', '-e', 'process.umask(0o077); await import(process.argv[1]);',
        pathToFileURL(join(root, 'scripts', script)).href], { encoding: 'utf8' });
    }
    const { directory } = JSON.parse(restricted('package-nas.mjs'));
    restricted('sync-site.mjs');
    for (const target of [directory, join(root, 'sites/clould10')]) assert.equal((await stat(join(target, asset))).mode & 0o777, 0o644);
    assert.equal((await stat(dirname(join(directory, asset)))).mode & 0o777, 0o755);
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
