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
const COUNTY = 'https://www.wanzai.gov.cn';
const articlePath = (channel, id) => `/wzxrmzf/${channel}/pc/content/${id}/content_${id}.html`;
const sourcePath = articlePath('ggwh', '9999999999999999901');
const mirrorPath = articlePath('tzgg', '9999999999999999902');
const unrelatedPath = articlePath('tzgg', '9999999999999999903');
const collectedTitle = '万载古城十二月演出公告';
const collectedPublisher = '万载县文广旅局';
const collectedDate = '2026-12-01';
let remoteBody = '演出日期为 12 月 20 日。';
let collectionUnavailable = false;
let runtime, admin, site, justBeforeExpiry, atExpiry, collector, seedSite, db, seedDb;

function script(entry) {
  return esbuild.buildSync({ entryPoints: [entry], bundle: true, write: false, format: 'esm',
    platform: 'browser', external: ['cloudflare:*'] }).outputFiles[0].text;
}

async function officialSource(request) {
  const { origin, pathname } = new URL(request.url);
  assert.equal(origin, COUNTY);
  if (collectionUnavailable) return new Response(null, { status: 503 });
  const entry = (title, pc) => ({ source: { title, contentSource: collectedPublisher, pubDate: collectedDate, urls: JSON.stringify({ pc }) } });
  if (pathname === '/queryList') {
    assert.equal(request.method, 'POST');
    const channel = new URLSearchParams(await request.text()).get('channelId');
    const rows = channel === '1996822039607484416' ? [entry(collectedTitle, sourcePath)] : channel === '1996821614086955008'
      ? [entry(collectedTitle, mirrorPath), entry('万载烟花非法行为举报公告', unrelatedPath)] : [];
    return Response.json({ data: { results: rows } });
  }
  assert.ok([sourcePath, mirrorPath].includes(pathname), pathname);
  return new Response(`<meta name="ArticleTitle" content="${collectedTitle}"><meta name="PubDate" content="${collectedDate}">
    <meta name="ContentSource" content="${collectedPublisher}"><div id="zoomcon"><p>${remoteBody}</p></div>`,
  { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function migrate(database, file) {
  const sql = readFileSync(`scripts/migrations/${file}.sql`, 'utf8').replace(/^--.*$/gm, '');
  await database.batch(sql.split(';').map((part) => part.trim()).filter(Boolean).map((part) => database.prepare(part)));
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
  const collectorScript = esbuild.buildSync({ stdin: {
    contents: `import site from './worker/index.js'; export default { async fetch(request, env, ctx) {
      await site.scheduled({ cron: '0 0 * * *' }, env, ctx); return new Response(null, { status: 204 });
    } };`, resolveDir: process.cwd(),
  }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*'] }).outputFiles[0].text;
  const options = { workers: [
    { ...shared, name: 'notices-admin', script: script('admin/index.js'), bindings: { ADMIN_SESSION_SECRET: SECRET } },
    siteWorker('notices-site'),
    siteWorker('notices-before-expiry', EXPIRY - 1),
    siteWorker('notices-at-expiry', EXPIRY),
    { ...siteWorker('notices-seed', EXPIRY), d1Databases: { DB: 'notice-seed-d1' } },
    { ...shared, name: 'notices-collector', outboundService: officialSource,
      script: `Date.now = () => Date.parse('2026-12-01T08:00:00+08:00');\n${collectorScript}` },
  ] };
  runtime = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  [admin, site, justBeforeExpiry, atExpiry, db, collector, seedSite, seedDb] = await Promise.all([
    runtime.getWorker('notices-admin'), runtime.getWorker('notices-site'),
    runtime.getWorker('notices-before-expiry'), runtime.getWorker('notices-at-expiry'), runtime.getD1Database('DB', 'notices-admin'),
    runtime.getWorker('notices-collector'), runtime.getWorker('notices-seed'), runtime.getD1Database('DB', 'notices-seed'),
  ]);
  await migrate(db, '010-20261126-activity-notices');
  await migrate(db, '011-20261127-activity-notice-collection');
  await migrate(seedDb, '010-20261126-activity-notices');
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
  const draft = { ...samples[0], id, title, source_url: 'https://example.com/expiry-test', sessions: [
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

test('daily collection deduplicates sources and keeps changes pending until an editor publishes', async () => {
  const inbox = async () => (await (await adminRequest(PATH + '/inbox')).json());
  const collect = async () => assert.equal((await collector.fetch(SITE)).status, 204);
  assert.equal((await adminRequest(PATH + '/inbox', null, { authenticated: false })).status, 401);
  await collect();
  const first = await inbox();
  assert.equal(first.run.status, 'ok');
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].source_url, COUNTY + sourcePath);
  assert.doesNotMatch(await page(), new RegExp(collectedTitle));
  await collect();
  assert.equal((await inbox()).run.changed, 0);

  const id = randomUUID();
  const draft = { ...samples[0], id, title: collectedTitle, summary: '场次安排在 12 月 20 日。',
    source_url: COUNTY + sourcePath, source_date: collectedDate, verified_on: collectedDate,
    sessions: [{ start: '2026-12-20T20:00' }], candidate_fingerprint: first.rows[0].fingerprint };
  assert.equal((await adminRequest(PATH, draft)).status, 201);
  assert.equal((await adminRequest(PATH, { ...draft, id: randomUUID() })).status, 409);
  assert.equal((await inbox()).rows.length, 0);
  assert.doesNotMatch(await page(), new RegExp(collectedTitle));
  assert.equal((await adminRequest(`${PATH}/${id}/publish`, { revision: 1 })).status, 200);

  remoteBody = '演出日期改为 12 月 22 日。';
  await collect();
  let [changed] = (await inbox()).rows;
  assert.equal(changed.notice_id, id);
  assert.equal(changed.is_change, 1);
  assert.notEqual(changed.fingerprint, first.rows[0].fingerprint);
  const prior = section(await page('/news/', justBeforeExpiry), 'upcoming');
  assert.match(prior, /2026-12-20/);
  assert.doesNotMatch(prior, /2026-12-22/);
  assert.equal((await adminRequest(PATH + '/' + id, { ...draft, revision: 2 })).status, 409);

  collectionUnavailable = true;
  await collect();
  assert.equal((await inbox()).run.status, 'failed');
  assert.equal((await inbox()).rows[0].fingerprint, changed.fingerprint);
  const update = { ...draft, revision: 2, candidate_fingerprint: changed.fingerprint,
    state: 'rescheduled', summary: '演出延至 12 月 22 日。', change_note: '主办方改期。', sessions: [{ start: '2026-12-22T20:00' }] };
  assert.equal((await adminRequest(PATH + '/' + id, update)).status, 200);
  assert.equal((await inbox()).rows.length, 0);
  assert.doesNotMatch(section(await page('/news/', justBeforeExpiry), 'changes'), /2026-12-22/);
  assert.equal((await adminRequest(`${PATH}/${id}/publish`, { revision: 3 })).status, 200);
  assert.match(section(await page('/news/', justBeforeExpiry), 'changes'), /2026-12-22[\s\S]+2026-12-20/);
});

test('initial publication is idempotent and all six official notices are historical', async () => {
  const file = '012-20261127-activity-notice-first-publication';
  await migrate(seedDb, file);
  await migrate(seedDb, file);
  const html = await page('/news/', seedSite);
  assert.equal((section(html, 'archive').match(/class="feature-card notice-card"/g) || []).length, 6);
  assert.equal((section(html, 'archive').match(/href="https:\/\/www\.wanzai\.gov\.cn\/wzxrmzf\//g) || []).length, 6);
  assert.doesNotMatch(section(html, 'upcoming'), /notice-card/);
  const audit = await seedDb.prepare("SELECT count(*) AS total FROM activity_notice_history WHERE action = 'publish' AND actor_uid = -1").first();
  assert.equal(audit.total, 6);
});
