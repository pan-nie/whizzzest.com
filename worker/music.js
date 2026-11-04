/**
 * /music/* + /en/music/* 万载音乐（2026-09-06；双语 docs/英文版方案.md Phase 3）
 *  - GET /music/                    播放器页（正在播放面板 + 曲目列表 + 底部固定播放条，焰棕深色影院风）
 *                                   行内下载（同源 download 属性直存歌名文件）/ 分享（系统分享→剪贴板，深链 ?t=<id> 直达单曲）
 *  - POST /api/music/play/<id>      播放计数（前端真正开始播放一首时回报一次，非阻塞 UPDATE）
 *
 * 内容以 D1 为权威（music_tracks，admin「音乐」Tab 直传 MP3）：后台发布即时生效，对标 /tv/*。
 * D1 内容暂无双语字段 → EN 页界面英文、曲目名/歌手回退中文原文（admin 双语录入后替换）。
 * 音频/封面存 R2 whizzzest-media（music/ 前缀），经主站 /media/* 代理公开读取——
 * 代理已支持 Range，<audio> 拖进度条 seek 直接可用。
 * 页面只出列表与数据（data-* 属性），播放器交互逻辑在 music-player.js（2026-09-10 结构精简 A3 自 main.js 拆出，单 <audio> 复用 + MediaSession）。
 */
import { UI, LOCALES } from './strings.js';
import { jsonForHtml } from '../shared/json-for-html.cjs';

const SITE_URL = 'https://whizzzest.com';

const PUB_WHERE = "status = 'published'";

export async function handleMusic(request, env, url, ctx, loc = 'zh') {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET' } });
  }
  const P = LOCALES[loc].prefix;
  if (url.pathname.replace(/\/+$/, '').slice(P.length) === '/music') return musicHome(env, url, ctx, loc);
  return notFound(env, url, loc);
}

/** 播放计数：POST /api/music/play/<id>（每首真正开始播放时回报一次） */
export async function handleMusicPlay(request, env, url) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  const m = url.pathname.match(/^\/api\/music\/play\/(\d+)$/);
  if (!m) return new Response(null, { status: 404 });
  try {
    await env.DB.prepare(`UPDATE music_tracks SET plays = plays + 1 WHERE id = ?1 AND ${PUB_WHERE}`)
      .bind(Number(m[1]))
      .run();
  } catch { /* 计数失败不影响播放 */ }
  return new Response(null, { status: 204 });
}

/* ---------------- 数据 ---------------- */

const mCover = (c) => (c ? (c.startsWith('/') ? c : '/media/' + c) : '');
const mAudio = (k) => '/media/' + k;

/** 秒 → "3:24" / "1:02:33"；无时长返回空串 */
function fmtDur(sec) {
  sec = Number(sec) || 0;
  if (sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/** 秒 → ISO8601（MusicPlaylist JSON-LD 用） */
function isoDur(sec) {
  sec = Number(sec) || 0;
  if (sec <= 0) return undefined;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return 'PT' + (m ? m + 'M' : '') + s + 'S';
}

/* ---------------- 播放器页 ---------------- */

async function musicHome(env, url, ctx, loc) {
  const t = UI[loc].music;
  const P = LOCALES[loc].prefix;
  const chrome = await getChrome(env, loc);
  const { results } = await env.DB
    .prepare(`SELECT * FROM music_tracks WHERE ${PUB_WHERE} ORDER BY sort, id`)
    .all();
  const tracks = results || [];

  const totalDur = tracks.reduce((acc, t) => acc + (Number(t.duration) || 0), 0);
  const totalPlays = tracks.reduce((acc, t) => acc + (Number(t.plays) || 0), 0);

  const items = tracks
    .map((track, i) => {
      const cover = mCover(track.cover);
      const dur = fmtDur(track.duration);
      return `<li class="music-item" data-id="${track.id}" data-src="${esc(mAudio(track.file_key))}" data-title="${esc(track.title)}" data-artist="${esc(track.artist || '')}" data-cover="${esc(cover)}">
        <button class="music-no" type="button" aria-label="${esc(t.playAria.replace('{title}', track.title))}"><span class="music-idx">${String(i + 1).padStart(2, '0')}</span><span class="music-eq" aria-hidden="true"><i></i><i></i><i></i></span></button>
        <span class="music-thumb">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async">` : '<span class="tv-ph" aria-hidden="true">焰</span>'}</span>
        <span class="music-item-body"><b>${esc(track.title)}</b><i>${esc(track.artist || t.unknown)}</i></span>
        <span class="music-item-side"><span class="music-item-dur">${dur || '--:--'}</span><span class="music-item-acts"><a class="music-act" href="${esc(mAudio(track.file_key))}" download="${esc(track.title)}.mp3" aria-label="${esc(t.downloadAria.replace('{title}', track.title))}" title="${t.download}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16l-5-5 1.4-1.4L11 12.2V4h2v8.2l2.6-2.6L17 11l-5 5zm-7 2h14v2H5v-2z"/></svg></a><button class="music-act music-share" type="button" aria-label="${esc(t.shareAria.replace('{title}', track.title))}" title="${t.share}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/></svg></button></span></span>
      </li>`;
    })
    .join('');

  const listHtml = tracks.length
    ? `<ol class="music-list" id="music-list">${items}</ol>`
    : `<div class="music-empty"><p>${t.empty}</p><p class="sub">${t.emptySub}</p></div>`;

  const first = tracks[0];
  const nowCover = first ? mCover(first.cover) : '';
  // 统计行：曲目数必带，时长/播放次数量级不足则省略对应段
  const plays = totalPlays ? totalPlays.toLocaleString('en-US') : 0;
  const sub = !tracks.length
    ? t.subEmpty
    : t[
        totalDur && totalPlays ? 'sub' : totalDur ? 'subNoPlays' : totalPlays ? 'subNoDur' : 'subTracks'
      ]
        .replace('{n}', tracks.length)
        .replace('{m}', Math.max(1, Math.round(totalDur / 60)))
        .replace('{p}', plays);
  const body = `
    <div class="music-page">
    <section class="music-hero">
      <div class="container-wide">
        <p class="music-kicker">${t.kicker}</p>
        <h1>${t.heroTitle}</h1>
        <p class="music-sub">${sub}</p>
      </div>
    </section>
    <section class="music-main"><div class="container-wide">
      <div class="music-layout">
        <aside class="music-now">
          <div class="music-cover" id="music-cover">${nowCover ? `<img src="${esc(nowCover)}" alt="" loading="eager" fetchpriority="high">` : '<span class="tv-ph" aria-hidden="true">焰</span>'}</div>
          <div class="music-now-info">
            <h2 id="music-now-title">${esc(first ? first.title : t.title)}</h2>
            <p id="music-now-artist">${esc(first ? first.artist || t.unknown : t.waiting)}</p>
            <p class="music-now-meta" id="music-now-meta">${t.clickToPlay}</p>
          </div>
        </aside>
        <div class="music-list-wrap">${listHtml}</div>
      </div>
    </div></section>
    <div class="music-bar" id="music-bar" ${tracks.length ? '' : 'hidden'}>
      <div class="music-bar-inner">
        <audio id="music-audio" preload="metadata"></audio>
        <span class="music-bar-cover" id="music-bar-cover" aria-hidden="true">${nowCover ? `<img src="${esc(nowCover)}" alt="">` : '<span class="tv-ph">焰</span>'}</span>
        <button class="music-ctl" id="music-prev" type="button" aria-label="${t.prevAria}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6h2v12H7zM18 6v12l-8.5-6z"/></svg></button>
        <button class="music-ctl music-toggle" id="music-toggle" type="button" aria-label="${t.play}"><svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg></button>
        <button class="music-ctl" id="music-next" type="button" aria-label="${t.nextAria}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6h2v12h-2zM6 6l8.5 6L6 18z"/></svg></button>
        <span class="music-time" id="music-tcur">0:00</span>
        <input class="music-seek" id="music-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="${t.seekAria}">
        <span class="music-time" id="music-tend">${first ? fmtDur(first.duration) || '0:00' : '0:00'}</span>
        <button class="music-ctl music-loop on" id="music-loop" type="button" aria-label="${t.loopAria}" aria-pressed="true"><svg class="i-all" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg><svg class="i-one" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></svg></button>
        <input class="music-vol" id="music-vol" type="range" min="0" max="100" value="100" aria-label="${t.volAria}">
      </div>
    </div>
    </div>`;

  const jsonLd = tracks.length
    ? {
        '@context': 'https://schema.org',
        '@type': 'MusicPlaylist',
        name: t.title,
        url: `${SITE_URL}${P}/music/`,
        numTracks: tracks.length,
        track: tracks.slice(0, 30).map((track) => ({
          '@type': 'MusicRecording',
          name: track.title,
          ...(track.artist ? { byArtist: { '@type': 'Person', name: track.artist } } : {}),
          ...(Number(track.duration) > 0 ? { duration: isoDur(track.duration) } : {}),
        })),
      }
    : null;

  return htmlResponse(
    pageShell(chrome, loc, {
      title: t.homeTitle,
      description: t.homeDesc,
      url: `${SITE_URL}${P}/music/`,
      jsonLd,
      body,
    })
  );
}

/* ---------------- 页面骨架（对标 tv.js；body 加 music-body 类给固定播放条留白） ---------------- */

async function getChrome(env, loc) {
  getChrome.c = getChrome.c || {};
  if (getChrome.c[loc]) return getChrome.c[loc];
  const asset = (p) => env.ASSETS.fetch(new Request('https://assets.whizzzest.local' + p));
  const [header, footer, meta] = await Promise.all([
    asset(`/partials/${loc}/header.html`).then((r) => r.text()),
    asset(`/partials/${loc}/footer.html`).then((r) => r.text()),
    asset('/build-meta.json').then((r) => r.json()),
  ]);
  getChrome.c[loc] = { header, footer, meta };
  return getChrome.c[loc];
}

function pageShell(chrome, loc, { title, description, url, body, jsonLd }) {
  const L = LOCALES[loc];
  const cssV = chrome.meta['/assets/css/style.css'] || '';
  const jsV = chrome.meta['/assets/js/main.js'] || '';
  const mpV = chrome.meta['/assets/js/music-player.js'] || '';
  const ogImage = '/assets/img/longhu_yanhuowanhui.jpeg';
  const ld = jsonLd
    ? `  <script type="application/ld+json">${jsonForHtml(jsonLd)}</script>\n`
    : '';
  // main.js 的 UI 文案表：构建产物 build-meta.json 携带 per-locale js 串（与静态页 head 注入同源）
  const i18nJs = `  <script>window.__I18N=${jsonForHtml(chrome.meta.i18n?.[loc] || {})}</script>\n`;
  return `<!DOCTYPE html>
<html lang="${L.htmlLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(url)}">
  <meta name="theme-color" content="#2b1208">
  <meta property="og:site_name" content="${L.siteName}">
  <meta property="og:type" content="music.playlist">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${SITE_URL}${ogImage}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="manifest" href="${L.manifest}">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <link rel="stylesheet" href="/assets/css/style.css?v=${esc(cssV)}">
${ld}</head>
<body class="music-body">
  ${chrome.header}
  <main id="main">
${body}
  </main>
  ${chrome.footer}
${i18nJs}  <script type="module" src="/assets/js/main.js?v=${esc(jsV)}"></script>
  <script type="module" src="/assets/js/music-player.js?v=${esc(mpV)}"></script>
</body>
</html>`;
}

async function notFound(env, url, loc = 'zh') {
  const r = await env.ASSETS.fetch(new Request(new URL(`${LOCALES[loc].prefix}/404.html`, url.origin)));
  return new Response(r.body, { status: 404, headers: r.headers });
}

/** HTML 响应；逐次计访客（index.js 统一处理），不做边缘缓存（后台发布即时生效） */
function htmlResponse(html) {
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- /api/music/latest（首页「万载音乐」条数据源，公开 JSON；zh-only 条） ---------------- */

// 60s 实例内缓存（同 handleTvLatest 模式）；排序同播放页（编辑 sort 优先），取前 6 首
let musicLatestCache = { at: 0, items: [] };

export async function handleMusicLatest(env) {
  if (Date.now() - musicLatestCache.at > 60 * 1000) {
    const { results } = await env.DB
      .prepare(`SELECT id, title, artist, cover, duration FROM music_tracks WHERE ${PUB_WHERE} ORDER BY sort, id LIMIT 6`)
      .all();
    musicLatestCache = {
      at: Date.now(),
      items: (results || []).map((track) => ({
        id: track.id,
        title: track.title,
        artist: track.artist || UI.zh.music.unknown,
        cover: mCover(track.cover),
        dur: Number(track.duration) || 0,
      })),
    };
  }
  return new Response(JSON.stringify({ ok: true, items: musicLatestCache.items }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  });
}
