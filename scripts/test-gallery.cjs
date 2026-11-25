const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHmac, randomUUID } = require('node:crypto');
const esbuild = require('esbuild');
const sharp = require('sharp');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

const ADMIN = 'https://admin.whizzzest.com';
const SITE = 'https://whizzzest.com';
const SECRET = 'local-gallery-test-secret';
let runtime, admin, site, db, bucket, full, thumbnail;

function script(entry) {
  return esbuild.buildSync({ entryPoints: [entry], bundle: true, write: false, format: 'esm',
    platform: 'browser', external: ['cloudflare:*'] }).outputFiles[0].text;
}

function signedCookie() {
  const value = `0.${Date.now() + 3600000}`;
  return 'wa_session=' + value + '.' + createHmac('sha256', SECRET).update(value).digest('hex');
}

async function adminRequest(path, { method = 'GET', body, authenticated = true, origin } = {}) {
  const headers = new Headers();
  if (authenticated) headers.set('cookie', signedCookie());
  if (origin) headers.set('origin', origin);
  const request = new Request(ADMIN + path, { method, headers, body });
  return admin.fetch(request.url, { method, headers: request.headers,
    body: request.body ? await request.arrayBuffer() : undefined });
}

function form(fields = {}) {
  const data = new FormData();
  for (const [name, value] of Object.entries({
    photographer: '测试署名', title_zh: '测试 <图库>', location_zh: '测试地点', alt_zh: '测试替代文本',
    license_zh: '测试授权', taken_on: '2026-11', sort: '0', status: 'draft', ...fields,
  })) data.set(name, value);
  return data;
}

function upload(id, image = full) {
  const data = form({ id });
  data.set('full', new Blob([image], { type: 'image/jpeg' }), 'full.jpg');
  data.set('thumb', new Blob([thumbnail], { type: 'image/jpeg' }), 'thumb.jpg');
  return data;
}

before(async () => {
  const shared = { modules: true, compatibilityDate: '2026-09-01',
    d1Databases: { DB: 'gallery-test-d1' }, r2Buckets: { MEDIA: 'gallery-test-r2' } };
  const templates = {
    '/gallery/': readFileSync('dist/gallery/index.html', 'utf8'),
    '/en/gallery/': readFileSync('dist/en/gallery/index.html', 'utf8'),
  };
  const options = { workers: [
    { ...shared, name: 'gallery-admin', script: script('admin/index.js'), bindings: { ADMIN_SESSION_SECRET: SECRET } },
    { ...shared, name: 'gallery-site', script: script('worker/index.js'), serviceBindings: {
      ASSETS: (request) => new Response(request.method === 'HEAD' ? null : templates[new URL(request.url).pathname],
        { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    } },
  ] };
  runtime = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  [admin, site, db, bucket] = await Promise.all([
    runtime.getWorker('gallery-admin'), runtime.getWorker('gallery-site'),
    runtime.getD1Database('DB', 'gallery-admin'), runtime.getR2Bucket('MEDIA', 'gallery-admin'),
  ]);
  const sql = readFileSync('scripts/migrations/009-20261125-gallery.sql', 'utf8').replace(/^--.*$/gm, '');
  await db.batch(sql.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => db.prepare(statement)));
  const color = '#6f624c';
  [full, thumbnail] = await Promise.all([1200, 480].map((width) => sharp({
    create: { width, height: width / 2, channels: 3, background: color },
  }).jpeg().toBuffer()));
});

after(async () => { if (runtime) await runtime.dispose(); });

test('admin login is required and photos carrying embedded EXIF are refused', async () => {
  assert.equal((await adminRequest('/api/gallery', { authenticated: false })).status, 401);
  assert.equal((await adminRequest('/api/gallery', { method: 'POST', authenticated: false, body: upload(randomUUID()) })).status, 401);
  assert.equal((await adminRequest('/api/gallery', { method: 'POST', origin: 'https://whizzzest.com', body: upload(randomUUID()) })).status, 403);
  const exif = await sharp(full).withExif({ IFD0: { Artist: 'synthetic private marker' } }).jpeg().toBuffer();
  const invalid = await adminRequest('/api/gallery', { method: 'POST', body: upload(randomUUID(), exif) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'bad_photo');
  assert.deepEqual((await bucket.list()).objects, []);
});

test('upload, retry, authenticated preview, bilingual publish, unpublish and cleanup', async () => {
  const id = randomUUID();
  const item = `/api/gallery/${id}`;
  const media = `/gallery-media/${id}/full.jpg`;
  const page = (pathname) => site.fetch(SITE + pathname);

  const withProfile = await sharp(full).withIccProfile('srgb').jpeg().toBuffer();
  assert.ok((await sharp(withProfile).metadata()).icc);
  assert.equal((await adminRequest('/api/gallery', { method: 'POST', body: upload(id, withProfile) })).status, 201);
  assert.equal((await adminRequest('/api/gallery', { method: 'POST', body: upload(id) })).status, 200);
  const record = await db.prepare('SELECT image_token FROM gallery_photos WHERE id = ?').bind(id).first();
  assert.equal((await bucket.list()).objects.length, 2);
  assert.equal((await adminRequest(item + '/thumb', { authenticated: false })).status, 401);
  assert.equal((await adminRequest(item + '/thumb')).headers.get('content-type'), 'image/jpeg');
  assert.equal((await page(media)).status, 404);
  assert.equal((await page(`/media/gallery%2f${id}/${record.image_token}/full.jpg`)).status, 404);
  assert.doesNotMatch(await (await page('/gallery/')).text(), /测试 &lt;图库&gt;/);
  assert.match(await (await page('/gallery/')).text(), /首批照片正在整理/);

  const edit = (fields) => adminRequest(item, { method: 'POST', body: form(fields) });
  assert.equal((await edit({ revision: 1, status: 'published', title_en: 'Gallery fixture' })).status, 200);
  assert.equal((await edit({ revision: 1, status: 'hidden' })).status, 409);
  assert.match(await (await page('/gallery/')).text(), /测试 &lt;图库&gt;/);
  const english = await (await page('/en/gallery/?page=1')).text();
  assert.match(english, /Gallery fixture/);
  assert.match(english, /lang="zh-CN">测试地点/);
  const image = await page(media);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('cache-control'), 'no-store');
  const imageBytes = Buffer.from(await image.arrayBuffer());
  const stored = await sharp(imageBytes).metadata();
  assert.equal(stored.icc, undefined);
  assert.equal(stored.exif, undefined);
  assert.equal(stored.width, 1200);
  assert.ok(imageBytes.length < withProfile.length);

  assert.equal((await edit({ revision: 2, status: 'hidden' })).status, 200);
  assert.equal((await page(media)).status, 404);
  assert.doesNotMatch(await (await page('/gallery/')).text(), /photo-gallery-card/);
  assert.equal((await adminRequest(item + '?revision=3', { method: 'DELETE' })).status, 200);
  assert.deepEqual((await bucket.list()).objects, []);
  const list = await adminRequest('/api/gallery');
  assert.deepEqual((await list.json()).photos, []);
});
