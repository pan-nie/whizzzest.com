/**
 * /library/* + /en/library/* 焰境文库（docs/文库方案.md，2026-09-06；双语 docs/英文版方案.md Phase 3）
 *  - GET /library/                  书架页（封面网格 + 分类 Tab + 搜索，最近更新排序）
 *  - GET /library/<slug>/           作品详情页（封面/信息/简介/章节目录，JSON-LD）
 *  - GET /library/<slug>/<n>/       章节阅读页（限宽排版 + 章内插图 + 上一章/目录/下一章）
 *  - GET /library/sitemap.xml       已上线作品 sitemap 片段（zh-only，EN 动态页暂不入 sitemap）
 *
 * 内容以 D1 为权威：作者投稿经 admin 审核通过即时上线（对标 /merchants/* 与 /tv/*）。
 * D1 内容（书名/简介/章节正文）暂无双语字段 → EN 页界面英文、内容回退中文原文（admin 双语录入后替换）。
 * 章节正文为分段纯文本（[图] 占位行），渲染时按 images 顺序替换 <figure>——白名单结构，天然免疫 XSS。
 * 封面/插图：R2 桶 whizzzest-media（book/ 前缀），经 /media/<key> 代理公开读取。
 */
import { UI, LOCALES } from './strings.js';
import { jsonForHtml } from '../shared/json-for-html.cjs';

const SITE_URL = 'https://whizzzest.com';

const PUB_WHERE = "status = 'approved'";

export async function handleLibrary(request, env, url, ctx, loc = 'zh') {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET' } });
  }

  const P = LOCALES[loc].prefix;
  const path = url.pathname.replace(/\/+$/, '').slice(P.length) || '/';

  if (path === '/library/sitemap.xml') return librarySitemap(env);

  if (path === '/library') return shelfPage(env, url, ctx, loc);

  let m = path.match(/^\/library\/([a-z0-9-]+)$/);
  if (m) return bookDetail(env, url, ctx, m[1], loc);

  m = path.match(/^\/library\/([a-z0-9-]+)\/(\d{1,4})$/);
  if (m) return chapterPage(env, url, ctx, m[1], Number(m[2]), loc);

  return notFound(env, url, loc);
}

/* ---------------- 数据 ---------------- */

const bCover = (b) => (b.cover ? (b.cover.startsWith('/') ? b.cover : '/media/' + b.cover) : '');
const fmtCount = (n) => (Number(n) || 0).toLocaleString('en-US');
const fmtDate = (d) => String(d || '').slice(0, 10);

function safeImages(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/* ---------------- Markdown 白名单渲染（esc-first，天然免疫 XSS） ----------------
 * 先整段 HTML 转义、再按白名单语法生成标签；链接只放行 http(s):// 与站内相对路径。
 * 支持语法：# 标题、**粗**、*斜*、`行内码`、```代码块```、> 引用、- / 1. 列表、--- 分隔线、[文字](链接)。
 * 注意：本函数与 writer 门户编辑器的客户端预览渲染（writer/index.js「mdInline/mdBlocks」）为同一套规则的双份实现，
 * 修改语法必须两处同步（零依赖项目不做共享模块）。
 * [图] 独立成段的旧图文格式分支保留：存量有图章节照常渲染（新章节编辑器已不再提供插图）。
 */

/** 行内格式（输入须已 esc）：代码 span 先出栈占位防嵌套改写，链接白名单协议，粗体/斜体最后。
 *  占位哨兵用 \u0000（正文先经 esc 不会产生控制字符，恢复前不会与可见文本碰撞） */
function mdInline(s) {
  const stash = [];
  s = s.replace(/`([^`\n]+)`/g, (m, c) => {
    stash.push(`<code>${c}</code>`);
    return '\u0000' + (stash.length - 1) + '\u0000';
  });
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/gi, (m, text, url) => {
    const external = /^https?:\/\//i.test(url);
    return `<a href="${url}"${external ? ' target="_blank" rel="noopener nofollow"' : ''}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[Number(i)]);
  return s;
}

/** 块级解析（逐行状态机）：空行分段；``` 围栏代码块内部保留空行与原样（已 esc）；
 *  [图] 独立成段走旧图文分支；--- / *** 分隔线；# 标题；> 引用；- / 1. 列表；其余为段落（行间 <br>） */
function mdBlocks(body, imgs) {
  const out = [];
  let imgIdx = 0;
  let para = [];
  let fence = null; // 非 null = 正在收集代码块行（已 esc）
  const flushPara = () => {
    const t = para.join('\n').trim();
    para = [];
    if (!t) return;
    if (t === '[图]') {
      const key = imgs[imgIdx++];
      if (key) out.push(`<figure class="bk-fig"><img src="/media/${esc(key)}" alt="" loading="lazy" decoding="async"></figure>`);
      return;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      out.push('<hr>');
      return;
    }
    if (!t.includes('\n') && /^#{1,6} /.test(t)) {
      const level = Math.min(t.match(/^#+/)[0].length + 1, 4); // # → h2（页面 h1 是章题），###### 封顶 h4
      out.push(`<h${level}>${mdInline(t.replace(/^#+ /, ''))}</h${level}>`);
      return;
    }
    const ls = t.split('\n');
    if (ls.every((l) => l.startsWith('&gt; '))) {
      out.push(`<blockquote><p>${ls.map((l) => mdInline(l.slice(5))).join('<br>')}</p></blockquote>`);
      return;
    }
    if (ls.every((l) => /^[-*] /.test(l))) {
      out.push(`<ul>${ls.map((l) => `<li>${mdInline(l.slice(2))}</li>`).join('')}</ul>`);
      return;
    }
    if (ls.every((l) => /^\d+[.] /.test(l))) {
      out.push(`<ol>${ls.map((l) => `<li>${mdInline(l.replace(/^\d+[.] /, ''))}</li>`).join('')}</ol>`);
      return;
    }
    out.push(`<p>${ls.map(mdInline).join('<br>')}</p>`);
  };
  for (const rawLine of String(body || '').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (fence !== null) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
        fence = null;
      } else {
        fence.push(esc(line));
      }
      continue;
    }
    if (/^```/.test(line.trim())) {
      flushPara();
      fence = [];
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    para.push(esc(line));
  }
  if (fence !== null && fence.length) out.push(`<pre><code>${fence.join('\n')}</code></pre>`); // 未闭合兜底
  flushPara();
  return out.join('');
}

/** 章节正文渲染：Markdown 白名单 + [图] 占位按 images 顺序替换 <figure>（旧图文格式兼容） */
function chapterBodyHtml(ch) {
  return mdBlocks(ch.body, safeImages(ch.images));
}

/* ---------------- 书架页 ---------------- */

async function shelfPage(env, url, ctx, loc) {
  const t = UI[loc].library;
  const P = LOCALES[loc].prefix;
  const chrome = await getChrome(env, loc);
  const cat = t.cats[url.searchParams.get('cat')] ? url.searchParams.get('cat') : '';
  const q = (url.searchParams.get('q') || '').trim().slice(0, 30);

  const conds = [PUB_WHERE];
  const vals = [];
  if (cat) {
    conds.push(`category = ?${vals.length + 1}`);
    vals.push(cat);
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    conds.push(`(title LIKE ?${vals.length + 1} ESCAPE '\\' OR intro LIKE ?${vals.length + 2} ESCAPE '\\' OR author_name LIKE ?${vals.length + 3} ESCAPE '\\')`);
    vals.push(like, like, like);
  }
  const { results: books } = await env.DB
    .prepare(`SELECT * FROM books WHERE ${conds.join(' AND ')} ORDER BY sort_weight DESC, updated_at DESC, id DESC LIMIT 120`)
    .bind(...vals)
    .all();

  const keepQ = (q ? `q=${encodeURIComponent(q)}` : '');
  const tabs = [
    `<a class="bk-tab${cat === '' ? ' on' : ''}" href="${P}/library/${keepQ ? '?' + keepQ : ''}">${t.all}</a>`,
    ...Object.entries(t.cats).map(
      ([k, label]) =>
        `<a class="bk-tab${k === cat ? ' on' : ''}" href="${P}/library/?cat=${k}${q ? `&q=${encodeURIComponent(q)}` : ''}">${label}</a>`
    ),
  ].join('');

  const searchBox = `
      <form class="bk-search" action="${P}/library/" method="get" role="search">
        ${cat ? `<input type="hidden" name="cat" value="${esc(cat)}">` : ''}
        <input type="search" name="q" value="${esc(q)}" maxlength="30" placeholder="${t.searchPlaceholder}" aria-label="${t.searchAria}">
        <button type="submit">${UI[loc].search}</button>
      </form>`;

  const cards = (books || [])
    .map((b) => {
      const cover = bCover(b);
      const media = cover
        ? `<img src="${esc(cover)}" alt="${esc(b.title)}" loading="lazy" decoding="async">`
        : `<span class="bk-ph" aria-hidden="true">${esc(b.title.slice(0, 1))}</span>`;
      return `<a class="bk-card" href="${P}/library/${esc(b.slug)}/">
        <div class="bk-media">${media}<span class="bk-cat">${esc(t.cats[b.category] || t.cats.other)}</span></div>
        <h3>${esc(b.title)}</h3>
        <p class="bk-meta">${esc(b.author_name || t.unknown)} · ${t.chapters.replace('{n}', b.chapter_count || 0)} · ${t.words.replace('{n}', fmtCount(b.word_count))}</p>
        <p class="bk-intro">${esc(b.intro)}</p>
      </a>`;
    })
    .join('');

  const grid = (books || []).length
    ? `<div class="bk-grid">${cards}</div>`
    : `<div class="bk-empty"><p>${q ? t.emptyQ.replace('{q}', esc(q)) : t.empty}</p>
       <p class="sub">${q ? '' : t.emptySub}</p></div>`;

  const body = `
    <section class="bk-hero">
      <div class="container-wide">
        <p class="bk-kicker">${t.kicker}</p>
        <h1>${t.heroTitle}</h1>
        <p class="bk-sub">${t.heroSub}</p>
      </div>
    </section>
    <section class="bk-main"><div class="container-wide">
      ${searchBox}
      <nav class="bk-tabs" aria-label="${t.tabsAria}">${tabs}</nav>
      ${grid}
      <div class="bk-cta">
        <h2>${t.ctaTitle}</h2>
        <p>${t.ctaDesc}</p>
        <a class="btn" href="https://writer.whizzzest.com/register" target="_blank" rel="noopener">${t.becomeAuthor}</a>
      </div>
    </div></section>`;

  return htmlResponse(
    pageShell(chrome, loc, {
      title: t.homeTitle,
      description: t.homeDesc,
      url: `${SITE_URL}${P}/library/${cat || q ? `?${cat ? 'cat=' + cat : ''}${cat && q ? '&' : ''}${keepQ}` : ''}`,
      body,
    })
  );
}

/* ---------------- 详情页 ---------------- */

async function bookDetail(env, url, ctx, slug, loc) {
  const t = UI[loc].library;
  const P = LOCALES[loc].prefix;
  const b = await env.DB
    .prepare(`SELECT * FROM books WHERE slug = ?1 AND ${PUB_WHERE}`)
    .bind(slug)
    .first();
  if (!b) return notFound(env, url, loc);

  const chrome = await getChrome(env, loc);

  const [{ results: chapters }, pend] = await Promise.all([
    env.DB.prepare(
      `SELECT id, idx, title, word_count FROM book_chapters WHERE book_id = ?1 AND status = 'approved' ORDER BY idx`
    ).bind(b.id).all(),
    env.DB.prepare(
      `SELECT COUNT(*) n FROM book_chapters WHERE book_id = ?1 AND status = 'pending'`
    ).bind(b.id).first(),
  ]);

  const cover = bCover(b);
  const coverHtml = cover
    ? `<img class="bk-cover" src="${esc(cover)}" alt="${esc(b.title)}" loading="eager" decoding="async">`
    : `<div class="bk-cover bk-ph" aria-hidden="true">${esc(b.title.slice(0, 1))}</div>`;

  const toc = (chapters || []).length
    ? (chapters || [])
        .map(
          (c) => `<a class="bk-toc-item" href="${P}/library/${esc(b.slug)}/${c.idx}/">
            <span class="idx">${t.chapter.replace('{n}', c.idx)}</span><span class="t">${esc(c.title)}</span>
            <span class="w">${t.words.replace('{n}', fmtCount(c.word_count))}</span>
          </a>`
        )
        .join('')
    : `<p class="bk-toc-empty">${t.tocEmpty}</p>`;

  const pendingNote = pend && pend.n > 0
    ? `<p class="bk-pending">${t.pending.replace('{n}', pend.n)}</p>`
    : '';

  // @graph = 主实体 + 面包屑（与页面可见 .bk-crumb 一一对应，搜索结果出路径）
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Book',
        name: b.title,
        author: { '@type': 'Person', name: b.author_name || t.authorFallback },
        inLanguage: 'zh-CN',
        numberOfPages: b.chapter_count || undefined,
        abstract: b.intro || undefined,
        url: `${SITE_URL}${P}/library/${b.slug}/`,
        dateModified: b.updated_at ? `${b.updated_at.replace(' ', 'T')}Z` : undefined,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: UI[loc].home, item: `${SITE_URL}${P}/` },
          { '@type': 'ListItem', position: 2, name: t.crumbLibrary, item: `${SITE_URL}${P}/library/` },
          { '@type': 'ListItem', position: 3, name: b.title, item: `${SITE_URL}${P}/library/${b.slug}/` },
        ],
      },
    ],
  };

  const body = `
    <section class="bk-detail"><div class="container-wide">
      <nav class="bk-crumb" aria-label="${UI[loc].crumbAria}"><a href="${P}/">${UI[loc].home}</a><span>/</span><a href="${P}/library/">${t.crumbLibrary}</a><span>/</span><b>${esc(b.title)}</b></nav>
      <div class="bk-head">
        ${coverHtml}
        <div class="bk-head-info">
          <h1>${esc(b.title)}</h1>
          <p class="bk-meta">${esc(b.author_name || t.unknown)} · ${esc(t.cats[b.category] || t.cats.other)} · ${t.chapters.replace('{n}', b.chapter_count || 0)} · ${t.words.replace('{n}', fmtCount(b.word_count))} · ${t.updated.replace('{date}', fmtDate(b.updated_at))} · ${t.reads.replace('{n}', fmtCount(b.views))}</p>
          ${b.intro ? `<p class="bk-intro-full">${esc(b.intro)}</p>` : ''}
          ${(chapters || []).length ? `<a class="btn bk-readbtn" href="${P}/library/${esc(b.slug)}/${(chapters || [])[0].idx}/">${t.startReading}</a>` : ''}
        </div>
      </div>
      ${pendingNote}
      <div class="bk-toc"><h2>${t.tocTitle.replace('{n}', (chapters || []).length)}</h2>${toc}</div>
    </div></section>`;

  if (ctx) {
    ctx.waitUntil(
      env.DB.prepare('UPDATE books SET views = views + 1 WHERE id = ?1').bind(b.id).run().catch(() => {})
    );
  }

  return htmlResponse(
    pageShell(chrome, loc, {
      title: t.detailTitle.replace('{title}', b.title),
      description: b.intro || t.detailDesc.replace('{title}', b.title),
      url: `${SITE_URL}${P}/library/${b.slug}/`,
      jsonLd,
      body,
    })
  );
}

/* ---------------- 阅读页 ---------------- */

async function chapterPage(env, url, ctx, slug, idx, loc) {
  const t = UI[loc].library;
  const P = LOCALES[loc].prefix;
  const b = await env.DB
    .prepare(`SELECT * FROM books WHERE slug = ?1 AND ${PUB_WHERE}`)
    .bind(slug)
    .first();
  if (!b) return notFound(env, url, loc);

  const ch = await env.DB
    .prepare(`SELECT * FROM book_chapters WHERE book_id = ?1 AND idx = ?2 AND status = 'approved'`)
    .bind(b.id, idx)
    .first();
  if (!ch) return notFound(env, url, loc);

  const chrome = await getChrome(env, loc);

  const [{ results: prev }, { results: next }] = await Promise.all([
    env.DB.prepare(
      `SELECT idx, title FROM book_chapters WHERE book_id = ?1 AND idx < ?2 AND status = 'approved' ORDER BY idx DESC LIMIT 1`
    ).bind(b.id, idx).all(),
    env.DB.prepare(
      `SELECT idx, title FROM book_chapters WHERE book_id = ?1 AND idx > ?2 AND status = 'approved' ORDER BY idx LIMIT 1`
    ).bind(b.id, idx).all(),
  ]);

  const nav = (items, cls, label, off) =>
    items && items.length
      ? `<a class="${cls}" href="${P}/library/${esc(b.slug)}/${items[0].idx}/">${label}${esc(items[0].title)}</a>`
      : `<span class="${cls} off">${label}${off}</span>`;

  const body = `
    <section class="bk-read"><div class="bk-reader">
      <nav class="bk-crumb" aria-label="${UI[loc].crumbAria}"><a href="${P}/">${UI[loc].home}</a><span>/</span><a href="${P}/library/">${t.crumbLibrary}</a><span>/</span><a href="${P}/library/${esc(b.slug)}/">${esc(b.title)}</a><span>/</span><b>${t.chapter.replace('{n}', ch.idx)}</b></nav>
      <article class="bk-chapter">
        <p class="bk-ch-meta">${esc(b.title)} · ${esc(b.author_name || t.unknown)}</p>
        <h1>${t.chapter.replace('{n}', ch.idx)} · ${esc(ch.title)}</h1>
        <div class="bk-body">${chapterBodyHtml(ch)}</div>
      </article>
      <nav class="bk-ch-nav" aria-label="${t.navAria}">
        ${nav(prev, 'bk-ch-prev', t.prevChapter, t.noPrev)}
        <a class="bk-ch-toc" href="${P}/library/${esc(b.slug)}/">${t.toc}</a>
        ${nav(next, 'bk-ch-next', t.nextChapter, t.noNext)}
      </nav>
    </div></section>`;

  if (ctx) {
    ctx.waitUntil(
      env.DB.prepare('UPDATE books SET views = views + 1 WHERE id = ?1').bind(b.id).run().catch(() => {})
    );
  }

  return htmlResponse(
    pageShell(chrome, loc, {
      title: t.chTitle.replace('{n}', ch.idx).replace('{title}', ch.title).replace('{book}', b.title),
      description: t.chDesc.replace('{book}', b.title).replace('{n}', ch.idx).replace('{title}', ch.title),
      url: `${SITE_URL}${P}/library/${b.slug}/${idx}/`,
      body,
    })
  );
}

/* ---------------- sitemap 片段（zh-only：EN 动态页暂不入 sitemap） ---------------- */

async function librarySitemap(env) {
  const { results } = await env.DB
    .prepare(`SELECT slug, updated_at FROM books WHERE ${PUB_WHERE} ORDER BY id DESC`)
    .all();
  const urls = (results || [])
    .map(
      (x) => `  <url>
    <loc>${SITE_URL}/library/${x.slug}/</loc>
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
