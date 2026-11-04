const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

let mf;
before(async () => {
  const config = JSON.parse(fs.readFileSync('game/wrangler.jsonc', 'utf8'));
  // Asset-first routing must not serve a previously uploaded game around the Worker.
  assert.equal(config.assets, undefined);
  assert.equal(config.r2_buckets, undefined);
  const script = esbuild.buildSync({ entryPoints: ['game/worker/index.js'], bundle: true,
    write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;
  const options = { modules: true, script, compatibilityDate: config.compatibility_date };
  mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
});
after(async () => { await mf?.dispose(); });

const request = (path, options) => mf.dispatchFetch('https://game.whizzzest.com' + path,
  { redirect: 'manual', ...options });

test('only bilingual reserved pages remain, without games, scripts or credentials', async () => {
  for (const [path, lang] of [['/', 'zh-CN'], ['/en', 'en'], ['/en/', 'en']]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    const html = await response.text();
    assert.ok(html.includes(`<html lang="${lang}">`));
    assert.doesNotMatch(html, /<script|<iframe|<form|\/g\/|\/play\//i);
    assert.match(html, /<main>/);
    assert.match(html, /<h1>/);
    assert.match(html, /https:\/\/whizzzest\.com\//);
    assert.equal((await request(path, { method: 'HEAD' })).status, 200);
    assert.equal(await (await request(path, { method: 'HEAD' })).text(), '');
  }
});

test('old players, packages, catalogs, static files and API proxies are gone', async () => {
  const paths = ['/index.html', '/en/index.html', '/play/hextris/', '/en/play/hextris/',
    '/play/huapao-2048/', '/g/hextris/index.html', '/g/doom/doom.wasm',
    '/g/dos/game.zip', '/g/flash/game.swf', '/g/api/weather', '/g/api/lunar',
    '/games.json', '/games.en.json', '/assets/js/game-save.js',
    '/assets/js/games/huapao2048.js', '/assets/css/game.css', '/sw.js',
    '/%67/hextris/index.html', '/en/../g/game.js', '/unknown'];
  for (const path of paths) {
    const response = await request(path + '?cache=old');
    assert.equal(response.status, 410, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(await response.text(), /collection has been retired/);
    const head = await request(path, { method: 'HEAD' });
    assert.equal(head.status, 410);
    assert.equal(await head.text(), '');
  }
});

test('mutations stay unavailable and robots do not advertise retired content', async () => {
  for (const path of ['/', '/g/api/weather', '/api/save']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await request(path, { method, body: 'not-a-game-save' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
  }
  assert.equal(await (await request('/robots.txt')).text(), 'User-agent: *\nDisallow: /\n');
  assert.equal(await (await request('/robots.txt', { method: 'HEAD' })).text(), '');
  const socket = await request('/ws', { headers: { upgrade: 'websocket' } });
  assert.equal(socket.status, 410);
});

test('retirement preserves the production transport guard and local preview', async () => {
  const page = await mf.dispatchFetch('http://game.whizzzest.com/en/?from=old', { redirect: 'manual' });
  assert.equal(page.status, 308);
  assert.equal(page.headers.get('location'), 'https://game.whizzzest.com/en/?from=old');
  assert.equal((await mf.dispatchFetch('http://game.whizzzest.com/api/save', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await mf.dispatchFetch('http://127.0.0.1:8787/')).status, 200);
});
