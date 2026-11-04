/**
 * /merchants/* + /en/merchants/* 动态渲染（商户功能 M1，docs/商户功能方案.md；双语 docs/英文版方案.md Phase 3）
 *  - GET /merchants/                目录页（推荐位 + 分类筛选 + 卡片网格）
 *  - GET /merchants/<slug>/         详情页（LocalBusiness 结构化数据）
 *  - GET /merchants/sitemap.xml     已上线商户 sitemap 片段（zh-only，EN 动态页暂不入 sitemap）
 *
 * 内容以 D1 为权威：admin 审核通过即时生效，不依赖构建。
 * D1 内容（商户名/简介/地址）暂无双语字段 → EN 页界面英文、内容回退中文原文（admin 双语录入后替换）。
 * HTML 不做边缘缓存——页面浏览要逐次计访客（visits 采集在 index.js 统一处理），
 * 当前量级 D1 直查毫无压力；未来量级上来再切 Cache API + 事件失效。
 * 页头/页脚复用构建产物 dist/partials/<locale>/*.html（build.js 每次构建按 locale 同步）。
 */
import { UI, LOCALES } from './strings.js';
import { jsonForHtml } from '../shared/json-for-html.cjs';

const SITE_URL = 'https://whizzzest.com';
const APPLY_URL = 'https://merchant.whizzzest.com/apply';

// 商户图片：R2 对象键 → 主站代理地址；以斜杠开头视为站内静态资源路径，原样使用
const mimg = (v) => (v && !v.startsWith('/') ? '/assets-merchant/' + v : v);
// 站内静态图换 800px WebP 变体（build.js 对 src/assets/img 全量生成；R2 图不受影响，上传时已压）
const simg = (v) => (v && v.startsWith('/assets/img/') ? v.replace(/\.[a-z]+$/i, '-800.webp') : mimg(v));

export async function handleMerchants(request, env, url, loc = 'zh') {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET' } });
  }

  const P = LOCALES[loc].prefix;
  const path = url.pathname.replace(/\/+$/, '').slice(P.length) || '/';

  if (path === '/merchants/sitemap.xml') return merchantsSitemap(env);

  const cat = UI[loc].merchants.cats[url.searchParams.get('cat')] ? url.searchParams.get('cat') : '';
  if (path === '/merchants' || path === '/merchants/') return merchantsHome(env, url, cat, loc);

  const m = path.match(/^\/merchants\/([a-z0-9-]+)$/);
  if (m) return merchantDetail(env, url, m[1], loc);

  return notFound(env, url, loc);
}

/* ---------------- 数据 ---------------- */

// 上线商户排序：featured → verified → free，同级按权重/新在上
// 付费到期（paid_until）过期的商户自动对游客隐藏，续费后立即恢复
const APPROVED_WHERE =
  "status = 'approved' AND (paid_until IS NULL OR paid_until >= date('now'))";
const ORDER_BY =
  "ORDER BY CASE tier WHEN 'featured' THEN 0 WHEN 'verified' THEN 1 ELSE 2 END, sort_weight DESC, id DESC";

async function approvedMerchants(env, cat, q) {
  const conds = [APPROVED_WHERE];
  const vals = [];
  if (cat) {
    conds.push(`category = ?${vals.length + 1}`);
    vals.push(cat);
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    conds.push(
      `(name LIKE ?${vals.length + 1} ESCAPE '\\' OR intro LIKE ?${vals.length + 2} ESCAPE '\\' OR detail LIKE ?${vals.length + 3} ESCAPE '\\')`
    );
    vals.push(like, like, like);
  }
  const sql = `SELECT * FROM merchants WHERE ${conds.join(' AND ')} ${ORDER_BY}`;
  const { results } = await env.DB.prepare(sql).bind(...vals).all();
  return results || [];
}

async function approvedBySlug(env, slug) {
  return env.DB
    .prepare(`SELECT * FROM merchants WHERE ${APPROVED_WHERE} AND slug = ?1`)
    .bind(slug)
    .first();
}

/* ---------------- 目录页 ---------------- */

async function merchantsHome(env, url, cat, loc) {
  const t = UI[loc].merchants;
  const P = LOCALES[loc].prefix;
  const chrome = await getChrome(env, loc);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 30);
  const list = await approvedMerchants(env, cat, q);
  const featured = list.filter((x) => x.tier === 'featured');
  const rest = list.filter((x) => x.tier !== 'featured');

  const keepQ = q ? `?q=${encodeURIComponent(q)}` : '';
  const catTabs = [
    `<a class="mc-tab${cat === '' ? ' on' : ''}" href="${P}/merchants/${keepQ}">${t.all}</a>`,
    ...Object.entries(t.cats).map(
      ([key, label]) =>
        `<a class="mc-tab${key === cat ? ' on' : ''}" href="${P}/merchants/?cat=${key}${q ? `&q=${encodeURIComponent(q)}` : ''}">${label}</a>`
    ),
  ].join('');

  const searchBox = `
      <form class="mc-search" action="${P}/merchants/" method="get" role="search">
        ${cat ? `<input type="hidden" name="cat" value="${esc(cat)}">` : ''}
        <input type="search" name="q" value="${esc(q)}" maxlength="30" placeholder="${t.searchPlaceholder}" aria-label="${t.searchAria}">
        <button type="submit">${UI[loc].search}</button>
      </form>`;
  const foundLine = q
    ? `<p class="mc-found">${t.found.replace('{n}', `<b>${list.length}</b>`).replace('{q}', esc(q))} <a href="${P}/merchants/${cat ? `?cat=${cat}` : ''}">${t.clearSearch}</a></p>`
    : '';

  const card = (x) => {
    const cover = x.cover
      ? `<img src="${esc(simg(x.cover))}" alt="${esc(x.name)}" loading="lazy" decoding="async">`
      : `<span class="mc-ph" aria-hidden="true">${esc(x.name.slice(0, 1))}</span>`;
    const badge =
      x.tier === 'featured'
        ? `<span class="mc-badge feat">${t.badgeFeatured}</span>`
        : x.tier === 'verified'
          ? `<span class="mc-badge">${t.badgeVerified}</span>`
          : '';
    const addr = x.address ? `<p class="mc-addr">${esc(x.address)}</p>` : '';
    return `<a class="mc-card" href="${P}/merchants/${esc(x.slug)}/">
      <div class="mc-media">${cover}${badge}</div>
      <div class="mc-body">
        <h3>${esc(x.name)}</h3>
        <p class="mc-intro">${esc(x.intro)}</p>
        ${addr}
        <span class="mc-cat">${esc(t.cats[x.category] || t.cats.other)}</span>
      </div>
    </a>`;
  };

  const featuredStrip = featured.length
    ? `<div class="mc-feat"><h2 class="mc-feat-title">✦ ${t.kicker}</h2><div class="mc-grid">${featured.map(card).join('')}</div></div>`
    : '';

  const grid = rest.length
    ? `<div class="mc-grid">${rest.map(card).join('')}</div>`
    : featured.length
      ? ''
      : `<div class="mc-empty"><p>${q ? t.emptyQ.replace('{q}', esc(q)) : t.empty}</p><p class="sub">${q ? '' : t.emptySub}</p></div>`;

  const html = pageShell(chrome, loc, {
    title: t.homeTitle,
    description: t.homeDesc,
    url: `${SITE_URL}${P}/merchants/`,
    body: `
    <section class="mc-hero">
      <div class="container-wide">
        <p class="mc-kicker">${t.kicker}</p>
        <h1>${t.heroTitle}</h1>
        <p class="mc-sub">${t.heroSub}</p>
      </div>
    </section>
    <section class="mc-main">
      <div class="container-wide">
        ${searchBox}
        <nav class="mc-tabs" aria-label="${t.tabsAria}">${catTabs}</nav>
        ${foundLine}
        ${featuredStrip}
        ${grid}
        <div class="mc-cta">
          <h2>${t.ctaTitle}</h2>
          <p>${t.ctaDesc}</p>
          <a class="btn" href="${APPLY_URL}" target="_blank" rel="noopener">${t.apply}</a>
        </div>
      </div>
    </section>`,
  });
  return htmlResponse(html);
}

/* ---------------- 详情页 ---------------- */

async function merchantDetail(env, url, slug, loc) {
  const t = UI[loc].merchants;
  const P = LOCALES[loc].prefix;
  const item = await approvedBySlug(env, slug);
  if (!item) return notFound(env, url, loc);

  const chrome = await getChrome(env, loc);
  const detailHtml = (item.detail || '')
    .split(/\n+/)
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');

  const infoRows = [
    [t.infoAddress, item.address],
    [t.infoPhone, item.phone],
    [t.infoWechat, item.wechat],
    [t.infoHours, item.hours],
  ].filter(([, v]) => v);

  const infoList = infoRows.length
    ? `<ul class="md-info">${infoRows
        .map(
          ([k, v]) =>
            `<li><span class="k">${k}</span><span class="v">${esc(v)}</span><button class="copy" type="button" data-copy="${esc(v)}">${t.copy}</button></li>`
        )
        .join('')}</ul>`
    : '';

  const related = (await approvedMerchants(env, item.category))
    .filter((x) => x.id !== item.id)
    .slice(0, 3);
  const relatedHtml = related.length
    ? `<section class="md-related"><div class="container">
        <h2>${t.related}</h2>
        <div class="mc-grid">${related.map((x) => relatedCard(x, loc)).join('')}</div>
      </div></section>`
    : '';

  let gallery = [];
  try { gallery = JSON.parse(item.images || '[]'); } catch { /* 忽略坏数据 */ }
  const coverHtml = item.cover
    ? `<div class="md-cover"><img src="${esc(simg(item.cover))}" alt="${esc(item.name)}" loading="eager" decoding="async"></div>`
    : '';
  // 图集去重：第一张已在封面展示
  const galleryExtra = gallery.filter((k) => k !== item.cover);
  const galleryHtml = galleryExtra.length
    ? `<div class="md-gallery">${galleryExtra.map((k, i) => `<img src="${esc(simg(k))}" alt="${esc(item.name)} ${i + 2}" loading="lazy" decoding="async">`).join('')}</div>`
    : '';

  // @graph = 主实体 + 面包屑（与页面可见 .md-crumb 一一对应，搜索结果出路径）
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'LocalBusiness',
        name: item.name,
        description: item.intro,
        ...(item.address ? { address: item.address } : {}),
        ...(item.phone ? { telephone: item.phone } : {}),
        url: `${SITE_URL}${P}/merchants/${item.slug}/`,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: UI[loc].home, item: `${SITE_URL}${P}/` },
          { '@type': 'ListItem', position: 2, name: t.crumbMerchants, item: `${SITE_URL}${P}/merchants/` },
          { '@type': 'ListItem', position: 3, name: item.name, item: `${SITE_URL}${P}/merchants/${item.slug}/` },
        ],
      },
    ],
  };

  const html = pageShell(chrome, loc, {
    title: t.detailTitle.replace('{name}', item.name),
    description: item.intro,
    url: `${SITE_URL}${P}/merchants/${item.slug}/`,
    jsonLd,
    body: `
    <section class="md-hero">
      <div class="container">
        <nav class="md-crumb" aria-label="${UI[loc].crumbAria}"><a href="${P}/">${UI[loc].home}</a><span>/</span><a href="${P}/merchants/">${t.crumbMerchants}</a><span>/</span><b>${esc(item.name)}</b></nav>
        ${coverHtml}
      </div>
    </section>
    <section class="md-main">
      <div class="container">
        <div class="md-card">
          <div class="md-head">
            <h1>${esc(item.name)}</h1>
            ${item.tier === 'featured' ? `<span class="mc-badge feat">${t.badgeFeatured}</span>` : item.tier === 'verified' ? `<span class="mc-badge">${t.badgeVerified}</span>` : ''}
            <span class="mc-cat">${esc(t.cats[item.category] || t.cats.other)}</span>
          </div>
          <p class="md-intro">${esc(item.intro)}</p>
          ${detailHtml ? `<div class="md-detail">${detailHtml}</div>` : ''}
          ${infoList}
          ${galleryHtml}
        </div>
      </div>
    </section>
    ${relatedHtml}`,
  });
  return htmlResponse(html);
}

function relatedCard(x, loc) {
  const P = LOCALES[loc].prefix;
  const cover = x.cover
    ? `<img src="${esc(simg(x.cover))}" alt="${esc(x.name)}" loading="lazy" decoding="async">`
    : `<span class="mc-ph" aria-hidden="true">${esc(x.name.slice(0, 1))}</span>`;
  return `<a class="mc-card" href="${P}/merchants/${esc(x.slug)}/">
    <div class="mc-media">${cover}</div>
    <div class="mc-body"><h3>${esc(x.name)}</h3><p class="mc-intro">${esc(x.intro)}</p></div>
  </a>`;
}

/* ---------------- sitemap 片段（zh-only：EN 动态页暂不入 sitemap） ---------------- */

async function merchantsSitemap(env) {
  const { results } = await env.DB
    .prepare(`SELECT slug, updated_at FROM merchants WHERE ${APPROVED_WHERE} ORDER BY id DESC`)
    .all();
  const urls = (results || [])
    .map(
      (x) => `  <url>
    <loc>${SITE_URL}/merchants/${x.slug}/</loc>
    <lastmod>${String(x.updated_at || '').slice(0, 10)}</lastmod>
    <changefreq>weekly</changefreq>
  </url>`
    )
    .join('\n');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } }
  );
}

/* ---------------- 页面骨架 ---------------- */

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
  const t = UI[loc].merchants;
  const cssV = chrome.meta['/assets/css/style.css'] || '';
  const jsV = chrome.meta['/assets/js/main.js'] || '';
  const ogImage = '/assets/img/longhu_yanhuowanhui.jpeg';
  const ld = jsonLd
    ? `  <script type="application/ld+json">${jsonForHtml(jsonLd)}</script>\n`
    : '';
  // main.js 的 UI 文案表：构建产物 build-meta.json 携带 per-locale js 串（与静态页 head 注入同源）
  const i18nJs = `<script>window.__I18N=${jsonForHtml(chrome.meta.i18n?.[loc] || {})}</script>\n`;
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
  <meta property="og:type" content="website">
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
  <script>
(function () {
  var LABELS = { copy: ${JSON.stringify(t.copy)}, copied: ${JSON.stringify(t.copied)} };
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.copy') : null;
    if (!btn) return;
    var text = btn.getAttribute('data-copy') || '';
    function done() { btn.textContent = LABELS.copied; setTimeout(function () { btn.textContent = LABELS.copy; }, 1500); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (err) {}
      document.body.removeChild(ta);
    }
  });
})();
  </script>
</body>
</html>`;
}

async function notFound(env, url, loc = 'zh') {
  const r = await env.ASSETS.fetch(new Request(new URL(`${LOCALES[loc].prefix}/404.html`, url.origin)));
  return new Response(r.body, { status: 404, headers: r.headers });
}

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
