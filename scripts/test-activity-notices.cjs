const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHmac, randomUUID } = require('node:crypto');
const esbuild = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const samples = require('./fixtures/activity-notices.cjs');

const ADMIN = 'https://admin.whizzzest.com';
const SITE = 'https://whizzzest.com';
const SECRET = 'local-notices-test-secret';
const PATH = '/api/activity-notices';
const EXPIRY = Date.parse('2026-12-05T21:00:00+08:00');
let runtime, admin, site, justBeforeExpiry, atExpiry, db;

function script(entry) {
  return esbuild.buildSync({ entryPoints: [entry], bundle: true, write: false, format: 'esm',
    platform: 'browser', external: ['cloudflare:*'] }).outputFiles[0].text;
}

async function adminRequest(path, body, { authenticated = true, origin } = {}) {
  const headers = new Headers();
  if (authenticated) {
    const value = `0.${Date.now() + 3600000}`;
    headers.set('cookie', 'wa_session=' + value + '.' + createHmac('sha256', SECRET).update(value).digest('hex'));
  }
  if (origin) headers.set('origin', origin);
  if (body) headers.set('content-type', 'application/json');
  return admin.fetch(ADMIN + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
}

async function page(pathname = '/news/', worker = site) {
  const response = await worker.fetch(SITE + pathname);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.text();
}

const section = (html, name) => html.match(new RegExp(`<section class="notice-section" id="${name}">([\\s\\S]*?)</section>`))[1];

before(async () => {
  const shared = { modules: true, compatibilityDate: '2026-09-01', d1Databases: { DB: 'notices-test-d1' } };
  const assets = new Map(['/news/', '/en/news/'].map((url) => [url, readFileSync(`dist${url}index.html`, 'utf8')]));
  const siteScript = script('worker/index.js');
  const siteWorker = (name, clock) => ({ ...shared, name,
    script: clock === undefined ? siteScript : `Date.now = () => ${clock};\n${siteScript}`,
    serviceBindings: { ASSETS: (request) => new Response(assets.get(new URL(request.url).pathname)) },
  });
  const options = { workers: [
    { ...shared, name: 'notices-admin', script: script('admin/index.js'), bindings: { ADMIN_SESSION_SECRET: SECRET } },
    siteWorker('notices-site'),
    siteWorker('notices-before-expiry', EXPIRY - 1),
    siteWorker('notices-at-expiry', EXPIRY),
  ] };
  runtime = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  [admin, site, justBeforeExpiry, atExpiry, db] = await Promise.all([
    runtime.getWorker('notices-admin'), runtime.getWorker('notices-site'),
    runtime.getWorker('notices-before-expiry'), runtime.getWorker('notices-at-expiry'), runtime.getD1Database('DB', 'notices-admin'),
  ]);
  const sql = readFileSync('scripts/migrations/010-20261126-activity-notices.sql', 'utf8').replace(/^--.*$/gm, '');
  await db.batch(sql.split(';').map((part) => part.trim()).filter(Boolean).map((part) => db.prepare(part)));
});

after(async () => { if (runtime) await runtime.dispose(); });

test('admin entry protects writes and refuses malformed schedules and insecure article links', async () => {
  const draft = { ...samples[0], id: randomUUID() };
  assert.equal((await adminRequest(PATH, null, { authenticated: false })).status, 401);
  assert.equal((await adminRequest(PATH, draft, { authenticated: false })).status, 401);
  assert.equal((await adminRequest(PATH, draft, { origin: SITE })).status, 403);
  assert.equal((await adminRequest(PATH, { ...draft, source_url: 'javascript:void(0)' })).status, 400);
  assert.equal((await adminRequest(PATH, { ...draft, sessions: [{ start: '2026-02-31' }] })).status, 400);
  assert.equal((await adminRequest(PATH, { ...draft, sessions: [{ start: '2026-06-01', end: 0 }] })).status, 400);
  assert.equal((await adminRequest(PATH, { ...draft, sessions: [{ start: '2026-06-01' }, { start: '2026-06-01T14:00' }] })).status, 400);

  const id = randomUUID();
  assert.equal((await adminRequest(PATH, { id, title: '缺资料的草稿', state: 'scheduled', sessions: [] })).status, 201);
  const incomplete = await adminRequest(`${PATH}/${id}/publish`, { revision: 1 });
  assert.equal(incomplete.status, 400);
  assert.equal((await incomplete.json()).error, 'incomplete');
  assert.doesNotMatch(await page(), /缺资料的草稿/);
});

test('the seven editorial samples stay private until approved, then appear in history with their sources', async () => {
  const rows = samples.map((sample) => ({ ...sample, id: randomUUID() }));
  for (const row of rows) assert.equal((await adminRequest(PATH, row)).status, 201);
  assert.equal((await adminRequest(PATH, rows[0])).status, 200);
  const draftPage = await page();
  for (const { title } of rows) assert.ok(!draftPage.includes(title));
  const head = await site.fetch(`${SITE}/news/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  for (const { id } of rows) assert.equal((await adminRequest(`${PATH}/${id}/publish`, { revision: 1 })).status, 200);
  const published = await page();
  const historical = section(published, 'archive');
  for (const { title, source_url } of rows) {
    assert.ok(historical.includes(title), title);
    assert.ok(historical.includes(source_url), source_url);
  }
  assert.equal((historical.match(/class="feature-card notice-card"/g) || []).length, 7);
  assert.match(section(published, 'upcoming'), /暂无已核实的近期活动/);
  assert.match(section(published, 'changes'), /暂无待关注的场次变更/);
  assert.match(historical, /改期后时间[\s\S]*2023-08-05[\s\S]*原定时间[\s\S]*2023-07-29/);
  assert.match(historical, /2024-12-07T20:30:00\+08:00[\s\S]*2024-12-28T20:30:00\+08:00/);
  assert.match(await page('/en/news/'), /Past notices[\s\S]*lang="zh-CN">第六届万载花炮文化节/);
  const audit = await db.prepare("SELECT count(*) AS total FROM activity_notice_history WHERE action = 'publish' AND actor_uid = 0").first();
  assert.equal(audit.total, 7);
});

test('active multi-session notice hides elapsed slots and a reviewed reschedule keeps its original dates and audit trail', async () => {
  const day = (offset) => new Date(Date.now() + offset * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  const id = randomUUID();
  const item = PATH + '/' + id;
  const initial = { ...samples[0], id, title: '本地验证：两场演出 <试编>', sessions: [{ start: day(-2) }, { start: day(2) }] };
  assert.equal((await adminRequest(PATH, initial)).status, 201);
  assert.equal((await adminRequest(item + '/publish', { revision: 1 })).status, 200);
  const active = section(await page(), 'upcoming');
  assert.match(active, /本地验证：两场演出 &lt;试编&gt;/);
  assert.ok(active.includes(day(2)));
  assert.ok(!active.includes(day(-2)));

  const sessions = [{ start: day(4) }];
  assert.equal((await adminRequest(item, { ...initial, sessions, revision: 2 })).status, 400);
  const moved = { ...initial, sessions, revision: 2, state: 'rescheduled', change_note: '调整演出时间。' };
  assert.equal((await adminRequest(item, moved)).status, 200);
  assert.equal((await adminRequest(item + '/publish', { revision: 2 })).status, 409);
  assert.match(section(await page(), 'upcoming'), /本地验证：两场演出/);
  const racing = await Promise.all([1, 2].map(() => adminRequest(item + '/publish', { revision: 3 })));
  assert.deepEqual(racing.map((response) => response.status).sort(), [200, 409]);
  const revised = section(await page(), 'changes');
  assert.match(revised, /已改期/);
  assert.ok(revised.indexOf(day(4)) < revised.indexOf(day(2)));
  assert.doesNotMatch(section(await page(), 'upcoming'), /本地验证：两场演出/);

  assert.equal((await adminRequest(item + '/withdraw', { revision: 4 })).status, 200);
  assert.doesNotMatch(await page(), /本地验证：两场演出/);
  const { results } = await db.prepare('SELECT action, content FROM activity_notice_history WHERE notice_id = ? ORDER BY revision').bind(id).all();
  assert.deepEqual(results.map(({ action }) => action), ['publish', 'publish', 'withdraw']);
  assert.deepEqual(JSON.parse(results[1].content).previous_sessions, initial.sessions.map((s) => ({ ...s, end: '' })));
});

test('Beijing date-only sessions and precise end times have distinct expiry boundaries', async () => {
  const { sessionEnd } = await import('../shared/activity-notices.mjs');
  assert.equal(new Date(sessionEnd({ start: '2026-11-02T16:00' })).toISOString(), '2026-11-02T16:00:00.000Z');
  assert.equal(new Date(sessionEnd({ start: '2026-10-31', end: '2026-11-02' })).toISOString(), '2026-11-02T16:00:00.000Z');
  assert.equal(new Date(sessionEnd({ start: '2026-11-02T16:00', end: '2026-11-02T17:00' })).toISOString(), '2026-11-02T09:00:00.000Z');
});

test('a notice moves from upcoming to archive exactly at the published end time', async () => {
  const id = randomUUID();
  const title = '本地验证：结束时归档';
  const draft = { ...samples[0], id, title, sessions: [
    { start: '2026-12-05T20:00', end: '2026-12-05T21:00' },
  ] };
  assert.equal((await adminRequest(PATH, draft)).status, 201);
  assert.equal((await adminRequest(`${PATH}/${id}/publish`, { revision: 1 })).status, 200);
  const before = await page('/news/', justBeforeExpiry);
  const after = await page('/news/', atExpiry);
  assert.ok(section(before, 'upcoming').includes(title));
  assert.ok(!section(before, 'archive').includes(title));
  assert.ok(!section(after, 'upcoming').includes(title));
  assert.ok(section(after, 'archive').includes(title));
});
