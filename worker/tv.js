/**
 * /tv/* + /en/tv/* 万载TV 视频频道 + /media/* R2 媒体代理（docs/万载TV方案.md，双语 docs/英文版方案.md Phase 3）
 *  - GET /tv/                 频道页（焦点位 + 短剧货架 + 分类 Tab + 视频网格，深色影院模式）
 *  - GET /tv/<id>/            详情页（大播放器 + 本剧选集/相关视频，VideoObject 结构化数据）
 *  - GET /tv/sitemap.xml      已上线视频 sitemap 片段（zh-only，EN 动态页暂不入 sitemap）
 *  - GET /media/<key>         R2 对象代理（admin Worker 上传，支持 Range 视频拖动）
 *
 * 内容以 D1 为权威：admin 发布即时生效，不依赖构建（对标 /merchants/*，2026-09-06）。
 * D1 内容暂无双语字段 → EN 页界面英文、内容回退中文原文（admin 双语录入后替换）。
 * 页头/页脚复用构建产物 dist/partials/<locale>/*.html（build.js 每次构建按 locale 同步）。
 * B站播放器重（iframe 数 MB），一律「lite facade」：先渲染封面，点击才插入 iframe（autoplay=1）。
 */
import { UI, LOCALES } from './strings.js';
import { jsonForHtml } from '../shared/json-for-html.cjs';

const SITE_URL = 'https://whizzzest.com';

const PUB_WHERE = "status = 'published'";

export async function handleTv(request, env, url, ctx, loc = 'zh') {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET' } });
  }

  const P = LOCALES[loc].prefix;
  const path = url.pathname.replace(/\/+$/, '').slice(P.length) || '/';

  if (path === '/tv/sitemap.xml') return tvSitemap(env);

  if (path === '/tv') return tvHome(env, url, ctx, loc);

  const m = path.match(/^\/tv\/(\d+)$/);
  if (m) return tvDetail(env, url, ctx, Number(m[1]), loc);

  return notFound(env, url, loc);
}

/* ---------------- /media/ R2 代理（视频拖动需 Range 支持） ---------------- */

export async function handleMedia(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET' } });
  }
  const key = decodeURIComponent(url.pathname.slice('/media/'.length));
  if (!key || key.includes('..') || !/^[\w][\w/.-]*$/.test(key)) {
    return new Response(null, { status: 404 });
  }

  // 解析 Range（bytes=a- / bytes=a-b / bytes=-n）；R2 对象键带 immutable 元数据由上传方写入
  const opt = {};
  const m = (request.headers.get('range') || '').match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') opt.range = { suffix: Number(m[2]) };
    else if (m[2] === '') opt.range = { offset: Number(m[1]) };
    else opt.range = { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 };
  }

  let obj;
  try {
    obj = await env.MEDIA.get(key, opt);
  } catch {
    return new Response(null, { status: 416 }); // Range 越界等
  }
  if (!obj) return new Response(null, { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=31536000, immutable');

  let status = 200;
  if (opt.range && obj.range) {
    status = 206;
    const off = obj.range.offset ?? 0;
    const len = obj.range.length ?? obj.size - off;
    headers.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
  }
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  return new Response(obj.body, { status, headers });
}

/* ---------------- 数据 ---------------- */

const vCover = (v) => (v.cover ? (v.cover.startsWith('/') ? v.cover : '/media/' + v.cover) : '');
const vMedia = (v) => (v.file_key ? '/media/' + v.file_key : '');
const biliEmbed = (v, autoplay) =>
  `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(v.bvid || '')}&page=1${autoplay ? '&autoplay=1' : ''}`;

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

/** 秒 → ISO8601（JSON-LD 用） */
function isoDur(sec) {
  sec = Number(sec) || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  const s = sec % 60;
  return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '') + (s ? s + 'S' : sec ? '' : 'S');
}

/* ---------------- 频道页 ---------------- */

async function tvHome(env, url, ctx, loc) {
  const t = UI[loc].tv;
  const P = LOCALES[loc].prefix;
  const chrome = await getChrome(env, loc);
  const cat = t.cats[url.searchParams.get('cat')] ? url.searchParams.get('cat') : '';

  const [featured, list, scovers] = await Promise.all([
    env.DB.prepare(`SELECT * FROM videos WHERE ${PUB_WHERE} AND featured = 1 ORDER BY id DESC LIMIT 1`).first(),
    env.DB
      .prepare(
        `SELECT * FROM videos WHERE ${PUB_WHERE} ${cat ? 'AND category = ?1 ' : ''}ORDER BY id DESC LIMIT 120`
      )
      .bind(...(cat ? [cat] : []))
      .all(),
    env.DB.prepare('SELECT name, cover FROM video_series').all(),
  ]);
  const items = list.results || [];
  // 剧集总封面（video_series 表，后台表单上传；缺省回退最新一集的封面）
  const scMap = new Map((scovers.results || []).filter((r) => r.cover).map((r) => [r.name, r.cover]));

  // 短剧货架：series 聚合（卡片取集数最大的一集为入口，角标「更新至 N 集」）
  const seriesMap = new Map();
  for (const v of items) {
    if (!v.series) continue;
    const cur = seriesMap.get(v.series);
    if (!cur || (v.episode || 0) > (cur.episode || 0) || v.id > cur.id) seriesMap.set(v.series, v);
  }
  const seriesCards = [...seriesMap.entries()]
    .sort((a, b) => b[1].id - a[1].id)
    .map(([name, latest]) => {
      const eps = items.filter((x) => x.series === name).length;
      const sc = scMap.get(name);
      const media = sc
        ? `<img src="${esc(sc.startsWith('/') ? sc : '/media/' + sc)}" alt="${esc(name)}" loading="eager" decoding="async">`
        : cardMedia(latest, true);
      return `<a class="tv-dcard" href="${P}/tv/${latest.id}/">
        <div class="tv-dmedia">${media}<span class="tv-dbadge">${t.epBadge.replace('{n}', latest.episode || eps)}</span></div>
        <h3>${esc(name)}</h3><p>${esc(t.cats[latest.category] || t.video)} · ${t.epsTotal.replace('{n}', eps)}</p>
      </a>`;
    })
    .join('');

  const tabs = [
    `<a class="tv-tab${cat === '' ? ' on' : ''}" href="${P}/tv/">${t.all}</a>`,
    ...Object.entries(t.cats)
      .filter(([k]) => k !== 'other' || cat === 'other')
      .map(([k, label]) => `<a class="tv-tab${k === cat ? ' on' : ''}" href="${P}/tv/?cat=${k}">${label}</a>`),
  ].join('');

  const grid = items.length
    ? `<div class="tv-grid">${items.map((v) => card(v, loc)).join('')}</div>`
    : `<div class="tv-empty"><p>${t.empty}</p><p class="sub">${t.emptySub}</p></div>`;

  const body = `
    <div class="tv-page">
    <section class="tv-hero">
      <div class="container-wide">
        <p class="tv-kicker">${t.kicker}</p>
        <h1>${t.heroTitle}</h1>
        ${featured ? featureBlock(featured, loc) : ''}
      </div>
    </section>
    ${seriesCards ? `<section class="tv-shelf"><div class="container-wide">
      <div class="tv-shelf-head"><h2>${t.shelfTitle}</h2><a class="tv-more" href="${P}/tv/?cat=drama">${t.allDrama}</a></div>
      <div class="tv-shelf-row">${seriesCards}</div>
    </div></section>` : ''}
    <section class="tv-main"><div class="container-wide">
      <nav class="tv-tabs" aria-label="${t.tabsAria}">${tabs}</nav>
      ${grid}
    </div></section>
    </div>`;

  return htmlResponse(
    pageShell(chrome, loc, {
      title: t.homeTitle,
      description: t.homeDesc,
      url: `${SITE_URL}${P}/tv/${cat ? `?cat=${cat}` : ''}`,
      body,
      needPlayerScript: true,
    })
  );
}

/** 焦点位：左播放器右信息（播放器点击才加载，首图 eager 保 LCP） */
function featureBlock(v, loc) {
  const t = UI[loc].tv;
  const P = LOCALES[loc].prefix;
  return `<div class="tv-feature">
    <div class="tv-feature-media">${playerHtml(v, true, loc)}</div>
    <div class="tv-feature-info">
      <span class="tv-badge">${t.featured}</span>
      <h2><a href="${P}/tv/${v.id}/">${esc(v.title)}</a></h2>
      ${v.intro ? `<p>${esc(v.intro)}</p>` : ''}
      <p class="tv-meta">${esc(t.cats[v.category] || t.video)}${v.duration ? ' · ' + fmtDur(v.duration) : ''} · ${fmtDate(v.created_at)}</p>
      <a class="tv-more" href="${P}/tv/${v.id}/">${t.watchPage}</a>
    </div>
  </div>`;
}

/** 卡片媒体：封面图 / 焰字占位；eager 用于货架首屏 */
function cardMedia(v, eager) {
  const cover = vCover(v);
  const img = cover
    ? `<img src="${esc(cover)}" alt="${esc(v.title)}" loading="${eager ? 'eager' : 'lazy'}" decoding="async">`
    : `<span class="tv-ph" aria-hidden="true">焰</span>`;
  const dur = v.duration ? `<span class="tv-dur">${fmtDur(v.duration)}</span>` : '';
  return `${img}${dur}`;
}

function card(v, loc) {
  const t = UI[loc].tv;
  const P = LOCALES[loc].prefix;
  const ep = v.series ? ' · ' + esc(v.series) + (v.episode ? ' ' + t.ep.replace('{n}', v.episode) : '') : '';
  return `<a class="tv-card" href="${P}/tv/${v.id}/">
    <div class="tv-media">${cardMedia(v, false)}</div>
    <h3>${esc(v.title)}</h3>
    <p class="tv-meta">${esc(t.cats[v.category] || t.video)}${ep} · ${fmtDate(v.created_at)} · ${t.plays.replace('{n}', v.views || 0)}</p>
  </a>`;
}

/* ---------------- 详情页 ---------------- */

async function tvDetail(env, url, ctx, id, loc) {
  const t = UI[loc].tv;
  const P = LOCALES[loc].prefix;
  const v = await env.DB.prepare(`SELECT * FROM videos WHERE id = ?1 AND ${PUB_WHERE}`).bind(id).first();
  if (!v) return notFound(env, url, loc);

  const chrome = await getChrome(env, loc);

  // 侧栏：短剧 → 本剧选集；单集 → 同分类相关视频
  let sideHtml = '';
  if (v.series) {
    const { results: eps } = await env.DB
      .prepare(`SELECT id, title, episode, episode IS NULL AS no_ep, duration, cover, category FROM videos
                WHERE ${PUB_WHERE} AND series = ?1 ORDER BY episode IS NULL, episode, id`)
      .bind(v.series)
      .all();
    sideHtml = `<h2>${t.seriesEps.replace('{name}', esc(v.series))}</h2><div class="tv-side-list">${(eps || [])
      .map((x) => {
        const on = x.id === v.id;
        const inner = `<span class="tv-side-media">${cardMedia(x, false)}</span>
          <span class="tv-side-body"><b>${esc(x.episode ? t.ep.replace('{n}', x.episode) : x.title)}</b><i>${esc(x.title)}</i></span>`;
        return on
          ? `<span class="tv-side-item on">${inner}</span>`
          : `<a class="tv-side-item" href="${P}/tv/${x.id}/">${inner}</a>`;
      })
      .join('')}</div>`;
  } else {
    const { results: rel } = await env.DB
      .prepare(`SELECT * FROM videos WHERE ${PUB_WHERE} AND category = ?1 AND id != ?2 ORDER BY id DESC LIMIT 8`)
      .bind(v.category, v.id)
      .all();
    sideHtml = rel && rel.length
      ? `<h2>${t.related}</h2><div class="tv-side-list">${rel
          .map(
            (x) => `<a class="tv-side-item" href="${P}/tv/${x.id}/">
              <span class="tv-side-media">${cardMedia(x, false)}</span>
              <span class="tv-side-body"><b>${esc(x.title)}</b><i>${esc(t.cats[x.category] || t.video)} · ${fmtDur(x.duration) || fmtDate(x.created_at)}</i></span>
            </a>`
          )
          .join('')}</div>`
      : '';
  }

  // @graph = 主实体 + 面包屑（与页面可见 .tv-crumb 一一对应，搜索结果出路径）
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'VideoObject',
        name: v.title,
        description: v.intro || t.ldDesc.replace('{title}', v.title),
        thumbnailUrl: [`${SITE_URL}${vCover(v) || '/assets/img/longhu_yanhuowanhui.jpeg'}`],
        uploadDate: v.created_at ? `${v.created_at.replace(' ', 'T')}Z` : undefined,
        ...(v.duration ? { duration: isoDur(v.duration) } : {}),
        ...(v.source === 'bilibili'
          ? { embedUrl: biliEmbed(v, false) }
          : { contentUrl: `${SITE_URL}${vMedia(v)}` }),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: UI[loc].home, item: `${SITE_URL}${P}/` },
          { '@type': 'ListItem', position: 2, name: t.crumbTv, item: `${SITE_URL}${P}/tv/` },
          { '@type': 'ListItem', position: 3, name: v.title, item: `${SITE_URL}${P}/tv/${v.id}/` },
        ],
      },
    ],
  };

  const ep = v.series ? ' · ' + esc(v.series) + (v.episode ? ' ' + t.ep.replace('{n}', v.episode) : '') : '';
  const body = `
    <div class="tv-page">
    <section class="tv-detail"><div class="container-wide">
      <nav class="tv-crumb" aria-label="${UI[loc].crumbAria}"><a href="${P}/">${UI[loc].home}</a><span>/</span><a href="${P}/tv/">${t.crumbTv}</a><span>/</span><b>${esc(v.title)}</b></nav>
      <div class="tv-detail-grid">
        <div class="tv-col-main">
          <div class="tv-player-wrap">${playerHtml(v, false, loc)}</div>
          <h1>${esc(v.title)}</h1>
          <p class="tv-meta">${esc(t.cats[v.category] || t.video)}${ep} · ${fmtDate(v.created_at)} · ${t.plays.replace('{n}', v.views || 0)}${v.source === 'bilibili' ? ' · <a class="tv-src" href="https://www.bilibili.com/video/' + esc(v.bvid) + '" target="_blank" rel="noopener">' + t.bilibili + '</a>' : ''}</p>
          ${v.intro ? `<p class="tv-intro">${esc(v.intro)}</p>` : ''}
        </div>
        <aside class="tv-col-side">${sideHtml}</aside>
      </div>
    </div></section>
    </div>`;

  // 播放计数：详情页加载即 +1（不阻塞响应）
  if (ctx) {
    ctx.waitUntil(
      env.DB.prepare('UPDATE videos SET views = views + 1 WHERE id = ?1').bind(id).run().catch(() => {})
    );
  }

  return htmlResponse(
    pageShell(chrome, loc, {
      title: t.detailTitle.replace('{title}', v.title),
      description: v.intro || t.detailDesc.replace('{title}', v.title),
      url: `${SITE_URL}${P}/tv/${v.id}/`,
      jsonLd,
      body,
      needPlayerScript: true,
    })
  );
}

/** 播放器：B站走 facade（点击插 iframe，autoplay=1 免二次点击）；上传视频原生 <video> */
function playerHtml(v, eager, loc) {
  if (v.source === 'bilibili') {
    const cover = vCover(v);
    const inner = cover
      ? `<img src="${esc(cover)}" alt="" loading="${eager ? 'eager' : 'lazy'}" ${eager ? 'fetchpriority="high"' : 'decoding="async"'}>`
      : `<span class="tv-ph" aria-hidden="true">焰</span>`;
    return `<div class="tv-facade" data-embed="${esc(biliEmbed(v, true))}" role="button" tabindex="0" aria-label="${esc(UI[loc].tv.playAria.replace('{title}', v.title))}">
      ${inner}<span class="tv-play" aria-hidden="true">▶</span>
    </div>`;
  }
  return `<video class="tv-video" controls playsinline preload="metadata" ${
    v.cover ? `poster="${esc(vCover(v))}"` : ''
  } src="${esc(vMedia(v))}"></video>`;
}

/** facade 激活脚本（频道页/详情页共用，随 pageShell 注入） */
const PLAYER_SCRIPT = `(function () {
  function arm(box) {
    function go() {
      if (box.dataset.on) return;
      box.dataset.on = '1';
      var f = document.createElement('iframe');
      f.className = 'tv-iframe';
      f.src = box.getAttribute('data-embed');
      f.setAttribute('scrolling', 'no');
      f.setAttribute('frameborder', 'no');
      f.setAttribute('allowfullscreen', 'true');
      f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
      f.title = box.getAttribute('aria-label') || 'video player';
      box.classList.add('playing');
      box.innerHTML = '';
      box.appendChild(f);
    }
    box.addEventListener('click', go);
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  }
  document.querySelectorAll('.tv-facade').forEach(arm);
})();`;

/* ---------------- sitemap 片段（zh-only：EN 动态页暂不入 sitemap） ---------------- */

async function tvSitemap(env) {
  const { results } = await env.DB
    .prepare(`SELECT id, updated_at FROM videos WHERE ${PUB_WHERE} ORDER BY id DESC`)
    .all();
  const urls = (results || [])
    .map(
      (x) => `  <url>
    <loc>${SITE_URL}/tv/${x.id}/</loc>
    <lastmod>${String(x.updated_at || '').slice(0, 10)}</lastmod>
    <changefreq>monthly</changefreq>
  </url>`
    )
    .join('\n');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } }
  );
}

/* ---------------- /api/tv/latest（首页「焰境影像」条数据源，公开 JSON；zh-only 条，文案保持中文） ---------------- */

// 60s 实例内缓存：首页每次浏览都会带一次该请求，量级小但没必要每次查 D1
let tvLatestCache = { at: 0, items: [] };

export async function handleTvLatest(env) {
  if (Date.now() - tvLatestCache.at > 60 * 1000) {
    const { results } = await env.DB
      .prepare(`SELECT id, title, category, duration, cover FROM videos WHERE ${PUB_WHERE} ORDER BY id DESC LIMIT 6`)
      .all();
    tvLatestCache = {
      at: Date.now(),
      items: (results || []).map((v) => ({
        id: v.id,
        title: v.title,
        cat: UI.zh.tv.cats[v.category] || UI.zh.tv.video,
        dur: Number(v.duration) || 0,
        cover: v.cover ? (v.cover.startsWith('/') ? v.cover : '/media/' + v.cover) : '',
      })),
    };
  }
  return new Response(JSON.stringify({ ok: true, items: tvLatestCache.items }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  });
}

/* ---------------- 工具 ---------------- */

function fmtDate(d) {
  return String(d || '').slice(0, 10);
}

/** 页头/页脚/指纹表：按 locale 取构建产物 dist/partials/<locale>/*.html（实例内缓存） */
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

function pageShell(chrome, loc, { title, description, url, body, jsonLd, needPlayerScript }) {
  const L = LOCALES[loc];
  const cssV = chrome.meta['/assets/css/style.css'] || '';
  const jsV = chrome.meta['/assets/js/main.js'] || '';
  const ogImage = '/assets/img/longhu_yanhuowanhui.jpeg';
  const ld = jsonLd
    ? `  <script type="application/ld+json">${jsonForHtml(jsonLd)}</script>\n`
    : '';
  // main.js 的 UI 文案表：构建产物 build-meta.json 携带 per-locale js 串（与静态页 head 注入同源）
  const i18nJs = `  <script>window.__I18N=${jsonForHtml(chrome.meta.i18n?.[loc] || {})}</script>\n`;
  const playerJs = needPlayerScript
    ? `  <script>${PLAYER_SCRIPT}</script>\n`
    : '';
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
  <meta property="og:type" content="video.other">
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
<body>
  ${chrome.header}
  <main id="main">
${body}
  </main>
  ${chrome.footer}
${i18nJs}  <script type="module" src="/assets/js/main.js?v=${esc(jsV)}"></script>
${playerJs}</body>
</html>`;
}

async function notFound(env, url, loc = 'zh') {
  const r = await env.ASSETS.fetch(new Request(new URL(`${LOCALES[loc].prefix}/404.html`, url.origin)));
  return new Response(r.body, { status: 404, headers: r.headers });
}

/** HTML 响应；TV 页逐次计访客（index.js 统一处理），不做边缘缓存 */
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
