const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { jsonForHtml } = require('../shared/json-for-html.cjs');

test('script JSON preserves nested values, property names and native omission behavior', () => {
  const input = { '</script>': ['万载 < & > 😀', null, 42, true], omitted: undefined, literal: '\\u003c' };
  const serialized = jsonForHtml(input);
  assert.deepEqual(JSON.parse(serialized), JSON.parse(JSON.stringify(input)));
  assert.equal(serialized.includes('<'), false);
  assert.equal(jsonForHtml(undefined), undefined);
  assert.throws(() => jsonForHtml(1n), TypeError);
});

const sections = [
  ['merchants', 'handleMerchants', '/merchants/fixture/'],
  ['library', 'handleLibrary', '/library/fixture/'],
  ['tv', 'handleTv', '/tv/1/'],
  ['attractions', 'handleAttractions', '/attractions/fixture/'],
  ['music', 'handleMusic', '/music/'],
];
const bundles = Object.fromEntries(sections.map(([name]) => [name, esbuild.buildSync({
  entryPoints: [`worker/${name}.js`], bundle: true, write: false, format: 'cjs', platform: 'node',
}).outputFiles[0].text]));

function freshHandler(section, exported) {
  const module = { exports: {} };
  new Function('module', 'exports', bundles[section])(module, module.exports);
  return module.exports[exported];
}

async function render(section, exported, pathname, loc, value) {
  const row = {
    id: 1, slug: 'fixture', status: 'approved', tier: 'free', category: 'other',
    name: value, title: value, intro: value, summary: value, address: value,
    author_name: value, artist: value, album: value, phone: '', detail: '',
    images: '[]', cover: '', chapter_count: 0, word_count: 0, views: 0,
    created_at: '2026-11-04 00:00:00', updated_at: '2026-11-04 00:00:00',
    duration: 60, media_key: 'fixture.mp4', audio_key: 'fixture.mp3',
  };
  const env = {
    ASSETS: { async fetch(request) {
      return new Response(request.url.endsWith('/build-meta.json')
        ? JSON.stringify({ i18n: { zh: { fixture: value }, en: { fixture: value } } })
        : '<nav>fixture</nav>');
    } },
    DB: { prepare(sql) {
      return {
        bind() { return this; },
        async first() { return /COUNT\(/i.test(sql) ? { n: 0 } : row; },
        async all() { return { results: /book_chapters/.test(sql) ? [] : [row] }; },
        async run() { return { success: true }; },
      };
    } },
  };
  const url = new URL('https://whizzzest.com' + (loc === 'en' ? '/en' : '') + pathname);
  const tasks = [];
  const ctx = { waitUntil(p) { tasks.push(p); } };
  const handler = freshHandler(section, exported);
  // The merchant renderer has no ctx parameter; other sections share this signature.
  const res = section === 'merchants'
    ? await handler(new Request(url), env, url, loc)
    : await handler(new Request(url), env, url, ctx, loc);
  await Promise.all(tasks);
  assert.equal(res.status, 200);
  return res.text();
}

const malicious = [
  '</script><script>globalThis.__jsonLdXss=1</script>',
  '</ScRiPt><img src=x onerror=alert(1)>',
  '</script\t><script>globalThis.__jsonLdXss=2</script>',
  '<!--<script>raw-text tokenizer state</script>',
];
const legitimate = '万载 & friends < 3 > 2 · "双引号" \'单引号\' \\ \\u003c 😀\u2028\u2029';

for (const [section, exported, pathname] of sections) {
  for (const loc of ['zh', 'en']) {
    test(`${section}/${loc}: JSON scripts preserve content and cannot escape HTML`, async () => {
      for (const value of [...malicious, legitimate]) {
        const html = await render(section, exported, pathname, loc, value);
        const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script\s*>/i);
        assert.ok(ld, 'structured data is present');
        assert.equal(ld[1].includes('<'), false, 'no HTML tokenizer control characters in JSON-LD');
        const data = JSON.parse(ld[1]);
        assert.ok(JSON.stringify(data).includes(JSON.stringify(value).slice(1, -1)), 'original metadata is retained');
        assert.equal(html.includes('<script>globalThis.__jsonLdXss='), false);
        const i18n = html.match(/<script>window\.__I18N=([\s\S]*?)<\/script\s*>/);
        assert.ok(i18n, 'locale data is present');
        assert.equal(i18n[1].includes('<'), false, 'no HTML tokenizer control characters in executable JSON');
        const sandbox = { window: {} };
        vm.runInNewContext('window.__I18N=' + i18n[1], sandbox, { timeout: 100 });
        assert.equal(sandbox.window.__I18N.fixture, value);
        if (value.startsWith('</')) assert.ok(html.includes('&lt;/'), 'visible text stays escaped');
      }
    });
  }
}
