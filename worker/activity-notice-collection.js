import { localTime } from '../shared/activity-notices.mjs';

export const NOTICE_COLLECTION_CRON = '0 0 * * *';
const ORIGIN = 'https://www.wanzai.gov.cn';
const CHANNELS = [
  ['ggwh', '1996822039607484416'],
  ['tzgg', '1996821614086955008'],
  ['xwfbh1', '1996821890386731008'],
];
const MAX_ARTICLES = 18;
const LOOKBACK = 90 * 86400000;
const CHANGE = /改期|延期|取消|延后|暂停|闭馆|恢复开放|调整|变更/;
const EVENT = /焰火|烟花秀|花炮文化节|旅游节|旅游文化周|古城|演出|剧场|图书馆|文化馆|博物馆|戏曲|非遗展演|艺术节|固定开放月/;
const NOTICE = /公告|预告|通告|通知|排期|活动安排|节目单|将于|来啦|倒计时|开幕|启幕|报名|开放|抢票|改期|延期|取消|调整|变更/;
const SKIP = /成功举办|圆满落幕|有序开展|圆满结束|顺利举行|采购|招标|非法|举报|评选|征求意见/;

function text(value, limit) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function articleUrl(raw) {
  try {
    const url = new URL(raw, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password ||
      !/^\/wzxrmzf\/[a-z0-9]+\/pc\/content\/([0-9]{16,22})\/content_\1\.html$/.test(url.pathname)) return '';
    return ORIGIN + url.pathname;
  } catch { return ''; }
}

async function requestOfficial(url, init = {}, retry = true) {
  let networkError;
  const response = await fetch(url, {
    ...init, redirect: 'manual', signal: AbortSignal.timeout(6500),
    headers: { 'user-agent': 'Whizzzest-Notices/1.0 (+https://whizzzest.com/news/)', ...init.headers },
  }).catch((err) => { networkError = err; return null; });
  if (response?.ok) return response;
  await response?.body?.cancel();
  if (retry && (!response || response.status >= 500)) return requestOfficial(url, init, false);
  throw new Error(response ? `http_${response.status}` : networkError.message);
}

async function listChannel([channel, id], since) {
  const body = new URLSearchParams({ channelId: id, current: '1', pageSize: '40', notReturnContent: 'true' });
  const result = await requestOfficial(`${ORIGIN}/queryList`, {
    method: 'POST', body, headers: { accept: 'application/json', referer: `${ORIGIN}/wzxrmzf/${channel}/pc/list.html` },
  });
  let bytes = 0;
  const bounded = result.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > 512000) throw new Error('listing_size');
    controller.enqueue(chunk);
  } }));
  const items = (await new Response(bounded).json()).data?.results;
  if (!Array.isArray(items)) throw new Error('listing_format');
  const found = [];
  for (const { source } of items) {
    const title = text(source?.title, 160);
    const date = text(source?.pubDate, 20).slice(0, 10);
    if (!(localTime(date) >= since) || SKIP.test(title) ||
      !(EVENT.test(title) && NOTICE.test(title) || channel === 'ggwh' && CHANGE.test(title))) continue;
    let url;
    try { url = articleUrl(JSON.parse(source.urls).pc); } catch { continue; }
    if (url) found.push({ url, title, date, publisher: text(source.contentSource, 120) });
  }
  return found;
}

async function inspectArticle(item) {
  const response = await requestOfficial(item.url);
  const meta = {};
  const chunks = [];
  const assets = [];
  let found = false;
  let size = 0;
  const rewriter = new HTMLRewriter().on('meta[name]', { element(element) {
    const key = element.getAttribute('name').toLowerCase();
    if (['articletitle', 'pubdate', 'contentsource'].includes(key)) meta[key] = element.getAttribute('content');
  } }).on('#zoomcon', {
    element() { found = true; },
    text(chunk) {
      size += chunk.text.length;
      if (size <= 128000) chunks.push(chunk.text);
    },
  }).on('#zoomcon img[src], #zoomcon a[href]', { element(element) {
    if (assets.length < 100) assets.push(element.getAttribute('src') || element.getAttribute('href'));
  } });
  await rewriter.transform(response).body.pipeTo(new WritableStream());
  const title = text(meta.articletitle || item.title, 160);
  const date = text(meta.pubdate || item.date, 20).slice(0, 10);
  const publisher = text(meta.contentsource || item.publisher, 120) || '万载县人民政府门户';
  const content = text(chunks.join(' '), 128000);
  if (!found || !title || !Number.isFinite(localTime(date)) || size > 128000 || (!content && !assets.length)) {
    throw new Error('article_format');
  }
  const data = new TextEncoder().encode(JSON.stringify([title, date, publisher, content, assets]));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { ...item, title, date, publisher, fingerprint };
}

function saveCandidate(db, item, now) {
  // An existing manual announcement establishes a baseline. Later edits to the same source become pending.
  return db.prepare(`WITH linked AS (
    SELECT id FROM activity_notices
    WHERE json_extract(published, '$.source_url') = ?1 OR json_extract(draft, '$.source_url') = ?1
    ORDER BY published_revision DESC, updated_at DESC LIMIT 1
  ) INSERT INTO activity_notice_inbox(source_url, source_title, source_name, source_date, fingerprint,
    handled_fingerprint, notice_id, is_change, detected_at)
  SELECT ?1, ?2, ?3, ?4, ?5, CASE WHEN EXISTS(SELECT 1 FROM linked) THEN ?5 END,
    (SELECT id FROM linked), ?6, ?7
  WHERE NOT EXISTS (SELECT 1 FROM activity_notice_inbox WHERE source_url <> ?1 AND fingerprint = ?5)
  ON CONFLICT(source_url) DO UPDATE SET source_title = excluded.source_title, source_name = excluded.source_name,
    source_date = excluded.source_date, fingerprint = excluded.fingerprint, is_change = 1, detected_at = excluded.detected_at
  WHERE activity_notice_inbox.fingerprint <> excluded.fingerprint
    AND activity_notice_inbox.detected_at <= excluded.detected_at`)
    .bind(item.url, item.title, item.publisher, item.date, item.fingerprint, Number(CHANGE.test(item.title)), now);
}

export async function collectActivityNotices(env, now = Date.now()) {
  const db = env.DB;
  const [active, ...listed] = await Promise.all([
    db.prepare(`SELECT DISTINCT json_extract(published, '$.source_url') AS source_url FROM activity_notices
      WHERE published IS NOT NULL AND public_until > ? ORDER BY public_start LIMIT ?`).bind(now, MAX_ARTICLES).all(),
    ...CHANNELS.map((channel) => listChannel(channel, now - LOOKBACK)
      .catch((err) => { console.warn('activity notice channel failed', { channel: channel[0], error: err.message }); return null; })),
  ]);
  const links = new Map();
  for (const { source_url } of active.results) {
    const url = articleUrl(source_url);
    if (url) links.set(url, { url });
  }
  for (const item of listed.flatMap((items) => items || [])) links.set(item.url, item);
  const articles = [];
  let failed = listed.filter((items) => items === null).length;
  const queue = [...links.values()].slice(0, MAX_ARTICLES);
  for (let offset = 0; offset < queue.length; offset += 3) {
    const group = await Promise.allSettled(queue.slice(offset, offset + 3).map(inspectArticle));
    for (const [index, result] of group.entries()) {
      if (result.status === 'fulfilled') articles.push(result.value);
      else {
        failed++;
        console.warn('activity notice article failed', { url: queue[offset + index].url, error: result.reason.message });
      }
    }
  }
  const written = articles.length ? await db.batch(articles.map((item) => saveCandidate(db, item, now))) : [];
  const changed = written.reduce((count, row) => count + row.meta.changes, 0);
  const status = failed === CHANNELS.length + queue.length ? 'failed' : failed ? 'partial' : 'ok';
  await db.prepare(`INSERT INTO activity_notice_collection(id, checked_at, status, changed, failed) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET checked_at = excluded.checked_at, status = excluded.status,
    changed = excluded.changed, failed = excluded.failed WHERE excluded.checked_at >= activity_notice_collection.checked_at`)
    .bind(now, status, changed, failed).run();
  console.log('activity notices collected', { status, changed, failed });
  return { status, changed, failed };
}
