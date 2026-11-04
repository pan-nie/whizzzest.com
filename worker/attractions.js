/**
 * /attractions/* + /en/attractions/* 旅游景点（2026-09-06；双语 docs/英文版方案.md Phase 3）
 *  - GET /attractions/               瀑布流推荐栏（封面原比例卡片，CSS columns；标签 + 一句话简介）
 *  - GET /attractions/<slug>/        详情页（大封面 + 信息行 + 分段正文 + 周边线路/相关视频轻关联）
 *  - GET /attractions/sitemap.xml    已上线景点 sitemap 片段（zh-only，EN 动态页暂不入 sitemap）
 *
 * 内容以 D1 为权威（attractions，admin「景点」Tab 维护）：后台发布即时生效，对标 /tv/* /library/*。
 * D1 内容（景点名/简介/正文）暂无双语字段 → EN 页界面英文、内容回退中文原文（admin 双语录入后替换）。
 * 正文为空行分段纯文本，渲染时 esc 包 <p>——白名单结构，天然免疫 XSS（同文库）。
 * 封面：R2 whizzzest-media（attra/ 前缀）经 /media/* 代理，或站内路径 /assets/img/…。
 */
import { UI, LOCALES } from './strings.js';
import { jsonForHtml } from '../shared/json-for-html.cjs';

const SITE_URL = 'https://whizzzest.com';

const PUB_WHERE = "status = 'published'";

export async function handleAttractions(request, env, url, ctx, loc = 'zh') {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET' } });
  }

  const P = LOCALES[loc].prefix;
  const path = url.pathname.replace(/\/+$/, '').slice(P.length) || '/';

  if (path === '/attractions/sitemap.xml') return attraSitemap(env);

  if (path === '/attractions') return attraHome(env, url, ctx, loc);

  const m = path.match(/^\/attractions\/([a-z0-9-]+)$/);
  if (m) return attraDetail(env, url, ctx, m[1], loc);

  return notFound(env, url, loc);
}

/* ---------------- 数据 ---------------- */

const aCover = (c) => (c ? (c.startsWith('/') ? c : '/media/' + c) : '');
const fmtDate = (d) => String(d || '').slice(0, 10);

const parseTags = (t) =>
  String(t || '')
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);

/** 正文渲染：空行分段纯文本 → esc 包 <p>（白名单结构防 XSS） */
function bodyHtml(body) {
  return String(body || '')
    .split(/\n{2,}/)
    .map((seg) => {
      const t = seg.trim();
      return t ? `<p>${esc(t)}</p>` : '';
    })
    .join('');
}

/* ---------------- 瀑布流列表页 ---------------- */

async function attraHome(env, url, ctx, loc) {
  const t = UI[loc].attractions;
  const P = LOCALES[loc].prefix;
  const chrome = await getChrome(env, loc);
  const { results } = await env.DB
    .prepare(`SELECT slug, name, summary, tags, cover FROM attractions WHERE ${PUB_WHERE} ORDER BY sort, id DESC LIMIT 120`)
    .all();
  const list = results || [];

  const cards = list
    .map((a) => {
      const cover = aCover(a.cover);
      const tags = parseTags(a.tags)
        .map((tag) => `<span>${esc(tag)}</span>`)
        .join('');
      return `<a class="at-card" href="${P}/attractions/${esc(a.slug)}/">
        <div class="at-media">${cover ? `<img src="${esc(cover)}" alt="${esc(a.name)}" loading="lazy" decoding="async">` : '<span class="at-ph" aria-hidden="true">游</span>'}</div>
        <div class="at-body">
          <h2>${esc(a.name)}</h2>
          <p>${esc(a.summary)}</p>
          ${tags ? `<p class="at-tags">${tags}</p>` : ''}
        </div>
      </a>`;
    })
    .join('');

  const body = `
    <div class="at-page">
    <section class="at-hero">
      <div class="container-wide">
        <p class="at-kicker">${t.kicker}</p>
        <h1>${t.heroTitle}</h1>
        <p class="at-sub">${list.length ? t.heroSub.replace('{n}', list.length) : t.heroEmpty}</p>
      </div>
    </section>
    <section class="at-main"><div class="container-wide">
      ${list.length ? `<div class="masonry at-grid">${cards}</div>` : `<div class="at-empty"><p>${t.empty}</p><p class="sub">${t.emptySub}</p></div>`}
    </div></section>
    </div>`;

  return htmlResponse(
    pageShell(chrome, loc, {
      title: t.homeTitle,
      description: t.homeDesc,
      url: `${SITE_URL}${P}/attractions/`,
      body,
    })
  );
}

/* ---------------- 详情页 ---------------- */

async function attraDetail(env, url, ctx, slug, loc) {
  const t = UI[loc].attractions;
  const P = LOCALES[loc].prefix;
  const a = await env.DB.prepare(`SELECT * FROM attractions WHERE ${PUB_WHERE} AND slug = ?1`)
    .bind(slug)
    .first();
  if (!a) return notFound(env, url, loc);

  const chrome = await getChrome(env, loc);

  // 上一篇/下一篇：全量取已上线 (slug, name) 按展示序排，量级小（数十）一次查完
  const { results: order } = await env.DB
    .prepare(`SELECT slug, name FROM attractions WHERE ${PUB_WHERE} ORDER BY sort, id DESC`)
    .all();
  const idx = (order || []).findIndex((x) => x.slug === slug);
  const prev = idx > 0 ? order[idx - 1] : null;
  const next = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  const pager = (x, cls, label) =>
    x
      ? `<a class="${cls}" href="${P}/attractions/${esc(x.slug)}/"><i>${label}</i><b>${esc(x.name)}</b></a>`
      : `<span class="${cls} off"><i>${label}</i><b>—</b></span>`;

  const tags = parseTags(a.tags)
    .map((tag) => `<span>${esc(tag)}</span>`)
    .join('');

  const infoRows = [
    [t.infoAddress, a.address],
    [t.infoHours, a.hours],
    [t.infoTickets, a.tickets],
    [t.infoTransport, a.transport],
  ].filter(([, v]) => v);
  const infoHtml = infoRows.length
    ? `<div class="at-info">${infoRows
        .map(([k, v]) => `<div class="at-info-row"><b>${k}</b><span>${esc(v)}</span></div>`)
        .join('')}</div>`
    : '';

  const cover = aCover(a.cover);
  // @graph = 主实体 + 面包屑（与页面可见 .at-crumb 一一对应，搜索结果出路径）
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TouristAttraction',
        name: a.name,
        description: a.summary,
        url: `${SITE_URL}${P}/attractions/${a.slug}/`,
        ...(cover ? { image: `${SITE_URL}${cover}` } : {}),
        ...(a.address ? { address: { '@type': 'PostalAddress', streetAddress: a.address, addressRegion: '江西', addressCountry: 'CN' } } : {}),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: UI[loc].home, item: `${SITE_URL}${P}/` },
          { '@type': 'ListItem', position: 2, name: t.crumbAttra, item: `${SITE_URL}${P}/attractions/` },
          { '@type': 'ListItem', position: 3, name: a.name, item: `${SITE_URL}${P}/attractions/${a.slug}/` },
        ],
      },
    ],
  };

  const body = `
    <div class="at-page">
    <section class="at-detail"><div class="container">
      <nav class="at-crumb" aria-label="${UI[loc].crumbAria}"><a href="${P}/">${UI[loc].home}</a><span>/</span><a href="${P}/attractions/">${t.crumbAttra}</a><span>/</span><b>${esc(a.name)}</b></nav>
      <figure class="at-heroimg">${cover ? `<img src="${esc(cover)}" alt="${esc(a.name)}" loading="eager" fetchpriority="high">` : '<span class="at-ph" aria-hidden="true">游</span>'}</figure>
      <div class="at-head">
        <h1>${esc(a.name)}</h1>
        ${tags ? `<p class="at-tags">${tags}</p>` : ''}
        <p class="at-summary">${esc(a.summary)}</p>
      </div>
      ${infoHtml}
      ${a.body ? `<div class="at-article">${bodyHtml(a.body)}</div>` : ''}
      <div class="at-links">
        <a class="at-link" href="${P}/tourism/">${t.nearbyRoutes}</a>
        <a class="at-link" href="${P}/tv/?cat=tourism">${t.relatedVideos}</a>
      </div>
      <nav class="at-pager" aria-label="${t.pagerAria}">
        ${pager(prev, 'at-pager-item at-prev', t.prevItem)}
        <a class="at-all" href="${P}/attractions/">${t.allItems}</a>
        ${pager(next, 'at-pager-item at-next', t.nextItem)}
      </nav>
    </div></section>
    </div>`;

  return htmlResponse(
    pageShell(chrome, loc, {
      title: t.detailTitle.replace('{name}', a.name),
      description: t.detailDesc.replace('{summary}', a.summary).replace('{name}', a.name),
      url: `${SITE_URL}${P}/attractions/${a.slug}/`,
      jsonLd,
      body,
    })
  );
}

/* ---------------- sitemap 片段（zh-only：EN 动态页暂不入 sitemap） ---------------- */

async function attraSitemap(env) {
  const { results } = await env.DB
    .prepare(`SELECT slug, updated_at FROM attractions WHERE ${PUB_WHERE} ORDER BY id DESC`)
    .all();
  const urls = (results || [])
    .map(
      (x) => `  <url>
    <loc>${SITE_URL}/attractions/${x.slug}/</loc>
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

/* ---------------- 页面骨架（对标 tv.js） ---------------- */

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
  <meta name="theme-color" content="#fbfbfd">
  <meta property="og:site_name" content="${L.siteName}">
  <meta property="og:type" content="article">
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

/* ---------------- /api/attractions/latest（首页「景点精选」条数据源，公开 JSON；zh-only 条） ---------------- */

// 60s 实例内缓存（同 handleTvLatest 模式）；排序同列表页（编辑 sort 优先），取前 6 条
let attraLatestCache = { at: 0, items: [] };

export async function handleAttractionsLatest(env) {
  if (Date.now() - attraLatestCache.at > 60 * 1000) {
    const { results } = await env.DB
      .prepare(`SELECT slug, name, tags, cover FROM attractions WHERE ${PUB_WHERE} ORDER BY sort, id DESC LIMIT 6`)
      .all();
    attraLatestCache = {
      at: Date.now(),
      items: (results || []).map((a) => ({
        slug: a.slug,
        name: a.name,
        tag: parseTags(a.tags)[0] || '景点',
        cover: aCover(a.cover),
      })),
    };
  }
  return new Response(JSON.stringify({ ok: true, items: attraLatestCache.items }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  });
}
