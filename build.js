#!/usr/bin/env node
/**
 * build.js — 焰境·万载 零依赖构建脚本
 *
 * 职责：
 *  1. 拼接公共片段（partials）+ 渲染模板变量 / #each 循环
 *  2. 每个页面按 locale 循环构建（docs/英文版方案.md §1.2）：
 *     默认语言（zh）产物在根路径；其他 locale 产物在 dist/<urlPrefix>/…
 *     正文数据 src/data/<code>/<路径>.json 不存在 → 该页不产出该语言（不做中文兜底，防孤儿页）
 *  3. 生成 sitemap.xml（hreflang 互指）/ robots.txt；per-locale manifest.webmanifest；
 *     /<code>/offline.html 离线兜底双语
 *  4. 构建期校验：非默认语言页面站内链接巡检 + 翻译覆盖率报告（断链默认失败，--loose 放行）
 *  5. 复制 public/ 与 src/assets/ → dist/
 *
 * 运行：node build.js [--loose]   （无任何 npm 依赖，仅 Node 内置模块）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { jsonForHtml } = require('./shared/json-for-html.cjs');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const PAGES_DIR = path.join(SRC, 'pages');
const PARTIALS_DIR = path.join(SRC, 'partials');
const DATA_DIR = path.join(SRC, 'data');
const DIST = path.join(ROOT, 'dist');

const SITE_URL = 'https://whizzzest.com';

/* ---------------- 多语言（docs/英文版方案.md §1.2 / §1.5） ----------------
 * Locale 注册表 = 唯一事实源：路由前缀、html lang、hreflang、og:locale、
 * 语言切换器、per-locale manifest、sitemap alternate、覆盖率报告全部由本表驱动。
 * 新增语言 = 这里注册一行 + src/data/<code>/ 补 site/strings/页面数据，不碰其他代码。
 * 除本表与数据文件外，任何地方不得硬编码 locale 判断。 */
const LOCALES = [
  { code: 'zh', urlPrefix: '', htmlLang: 'zh-CN', hreflang: 'zh-CN', ogLocale: 'zh_CN', label: '中文' },
  { code: 'en', urlPrefix: 'en', htmlLang: 'en', hreflang: 'en', ogLocale: 'en_US', label: 'English' },
];
const DEFAULT_LOCALE = LOCALES[0];
// Worker 双语动态板块注册表（唯一事实源，2026-09-10 结构精简 A4 收敛）：EN_DYNAMIC_PREFIXES /
// DYNAMIC_ZH_ROUTES / sitemap.xml 动态条目 / robots.txt 的 Sitemap 列表全部由本表驱动。
// 新增板块 = 这里加一行 + worker/<route>.js 模块 + wrangler run_worker_first + strings/admin 入口（docs/加功能检查单.md）。
// sitemap: false = Worker 未提供 /<route>/sitemap.xml 端点（如 music），robots.txt 不得列出。
const DYNAMIC_SECTIONS = [
  { route: 'merchants', sitemap: true },
  { route: 'tv', sitemap: true },
  { route: 'library', sitemap: true },
  { route: 'music', sitemap: false },
  { route: 'attractions', sitemap: true },
];
const EN_DYNAMIC_PREFIXES = DYNAMIC_SECTIONS.map((s) => `/en/${s.route}`);
// 其余 zh-only 动态路由（/pay /api）从 EN 页抵达视为降级，计入报告不拦截
const DYNAMIC_ZH_ROUTES = [...DYNAMIC_SECTIONS.map((s) => `/${s.route}`), '/pay', '/api'];
const LOOSE = process.argv.includes('--loose');

// 资产/杂项路径前缀：链接巡检时跳过
const ASSET_PREFIXES = ['/assets/', '/icons/', '/favicon.svg', '/favicon.ico', '/manifest', '/sw.js', '/offline'];

// 页脚社交图标库（SVG innerHTML）：数据驱动页脚（site.footer.socials[].icon → 此表）。
// 数据在 src/data/social-icons.json（2026-09-10 结构精简 A4 移出构建脚本，11.5KB SVG 不再混在逻辑里）；
// 新平台 = JSON 加一项 + 数据文件里引用 icon 名。
const SOCIAL_ICONS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "social-icons.json"), "utf8"));

// 社媒聚合页渠道表（docs/社媒聚合页方案.md §4）：只写双语文案 + 分组，href/qr/qrList 由
// resolveSocialChannels 按 icon 从两个 locale 的 site.footer.socials 并集解析（链接单一事实源）。
// SOCIALS_BY_ICON[locale] 在 main() 里随 site 数据填充（本语言条目优先，缺的用另一语言兜底）。
const SOCIAL_CHANNELS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "social-channels.json"), "utf8"));
let SOCIALS_BY_ICON = {};
// 企业微信在线咨询（页脚 site.footer.onlineSupport，仅 zh 站配置）：社交聚合页两侧都要有这张卡，
// 故 href 跨 locale 取其一，见 resolveSocialChannels。
let ONLINE_SUPPORT = null;

/* ---------------- 小工具 ---------------- */

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 递归复制目录（跳过 .DS_Store） */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** deep-merge：src 覆盖 base（对象递归合并，其余 src 有值即覆盖）；strings 回退链用 */
function deepMerge(base, src) {
  const out = { ...base };
  for (const [k, v] of Object.entries(src || {})) {
    out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** locale 数据/配置文件路径：默认语言在 src/data/ 根，其他在 src/data/<code>/ */
function localeDataPath(loc, relPath) {
  return loc.code === DEFAULT_LOCALE.code
    ? path.join(DATA_DIR, relPath)
    : path.join(DATA_DIR, loc.code, relPath);
}

/** locale 的 URL 前缀：zh → '/'，en → '/en/' */
const localePrefix = (loc) => (loc.urlPrefix ? `/${loc.urlPrefix}/` : '/');

/** 页面在该 locale 下的 slug：zh /about/ → en /en/about/ */
const pageSlug = (loc, dirName) => {
  const base = dirName === 'index' ? '' : `${dirName}/`;
  return `${localePrefix(loc)}${base}`;
};

/** BreadcrumbList：由该 locale 的 site.nav 推导（首页 → 祖先栏目 → 当前页）。
 *  祖先标签取顶层导航或其菜单子项，当前页取 meta 标题去掉站名后缀；
 *  任一祖先在 nav 中找不到 → 整体不输出（宁缺毋滥）。 */
function breadcrumbList(loc, dirName, site, selfTitle) {
  const home = localePrefix(loc);
  const nav = site.nav || [];
  const items = [{ name: site.name, href: `${SITE_URL}${home}` }];
  const parts = dirName.split('/');
  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    acc += `${parts[i]}/`;
    let label;
    if (i === parts.length - 1) {
      label = selfTitle.split(' — ')[0].trim();
    } else {
      const href = `${home}${acc}`;
      const hit =
        nav.find((n) => n.href === href) ||
        nav.flatMap((n) => n.menu || []).find((m) => m.href === href);
      if (!hit) return null;
      label = hit.label;
    }
    items.push({ name: label, href: `${SITE_URL}${home}${acc}` });
  }
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.href,
    })),
  };
}

/** 按 a.b.c 路径取值；失败返回 undefined */
function resolvePath(ctx, expr) {
  return expr
    .split('.')
    .reduce((node, key) => (node == null ? undefined : node[key]), ctx);
}

/** HTML 转义 */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- 模板引擎 ---------------- */

/**
 * 语法：
 *   {{> name}}              → 嵌入 src/partials/name.html（先展开，再渲染）
 *   {{#each expr [as name]}}…{{/each}}   循环（可嵌套，as name 命名循环变量，默认 item）
 *   {{@index}}              → 循环序号（从 1 起）
 *   {{{ expr }}}            → 原样输出（不转义）
 *   {{ expr }}              → HTML 转义输出
 * 所有取值均为点路径，从整页上下文解析；循环变量在每层框架中可遮蔽外层。
 */
function render(tpl, ctx) {
  // 1. 展开 {{> partial}}（仅一层，partials 内不再嵌套 include）
  tpl = tpl.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => {
    const p = path.join(PARTIALS_DIR, `${name}.html`);
    if (!exists(p)) throw new Error(`partial not found: ${name}`);
    return read(p);
  });

  // 2. 展开 {{#each expr [as name]}} … {{/each}}（深度计数找配对，支持嵌套）
  const openRe = /\{\{#each\s+([\w@][\w.@]*)(?:\s+as\s+(\w+))?\s*\}\}/;
  let m;
  while ((m = openRe.exec(tpl))) {
    const [open, expr, alias] = m;
    // 从 open 结尾开始扫描，找配对的 {{/each}}
    let depth = 1;
    const pairRe = /\{\{#each\s|(?<!\{)\{\{\/each\}\}/g;
    pairRe.lastIndex = m.index + open.length;
    let closeMatch;
    while ((closeMatch = pairRe.exec(tpl))) {
      depth += closeMatch[0].startsWith('{{#each') ? 1 : -1;
      if (depth === 0) break;
    }
    if (!closeMatch || depth !== 0) throw new Error(`{{#each}} 未闭合: ${expr}`);
    const body = tpl.slice(m.index + open.length, closeMatch.index);
    const full = tpl.slice(m.index, closeMatch.index + closeMatch[0].length);

    const v = resolvePath(ctx, expr);
    const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.entries(v).map(([key, val]) => ({ key, ...val })) : [];
    const name = alias || 'item';
    const out = list
      .map((item, i) => render(body, { ...ctx, [name]: item, item, '@index': i + 1 }))
      .join('');
    tpl = tpl.slice(0, m.index) + out + tpl.slice(closeMatch.index + closeMatch[0].length);
  }

  // 3. 条件块（放在 each 之后：each 体内经递归 render 时框架已带 @index）
  //    {{#if expr}} 真值渲染 ｜ {{#unless expr}} 假值渲染 ｜ {{#if_first}} @index===1 ｜ {{#if_odd}} 奇数
  tpl = tpl.replace(/\{\{#if\s+([\w@][\w.@]*)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, expr, b) => (resolvePath(ctx, expr) ? b : ''));
  tpl = tpl.replace(/\{\{#unless\s+([\w@][\w.@]*)\}\}([\s\S]*?)\{\{\/unless\}\}/g, (_, expr, b) => (resolvePath(ctx, expr) ? '' : b));
  tpl = tpl.replace(/\{\{#if_first\}\}([\s\S]*?)\{\{\/if_first\}\}/g, (_, b) => (ctx['@index'] === 1 ? b : ''));
  tpl = tpl.replace(/\{\{#if_not_first\}\}([\s\S]*?)\{\{\/if_not_first\}\}/g, (_, b) => (ctx['@index'] !== 1 ? b : ''));
  tpl = tpl.replace(/\{\{#if_odd\}\}([\s\S]*?)\{\{\/if_odd\}\}/g, (_, b) => ((ctx['@index'] ?? 0) % 2 === 1 ? b : ''));

  // 4. 渲染剩余 {{var}} / {{{var}}}
  return renderFragment(tpl, ctx);
}

function renderFragment(tpl, ctx) {
  return tpl
    .replace(/\{\{\{\s*([\w@][\w.@]*)\s*\}\}\}/g, (_, expr) => String(resolvePath(ctx, expr) ?? ''))
    .replace(/\{\{\s*([\w@][\w.@]*)\s*\}\}/g, (_, expr) => esc(resolvePath(ctx, expr)));
}

/* ---------------- 图片优化（WebP 多宽度；未安装 sharp 时优雅降级为原图直出） ---------------- */

const IMG_WIDTHS = [480, 800, 1200, 1600];
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  /* devDependency 未安装（如临时环境）→ 跳过 WebP，站点仍可用原 JPEG 打开 */
}

/** 扫描 src/assets/img，产出 { '/assets/img/x.jpeg': { file, width, png } }；无 sharp 返回 {} */
async function scanImages() {
  if (!sharp) return {};
  const dir = path.join(SRC, 'assets', 'img');
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() || !/\.(jpe?g|png)$/i.test(entry.name)) continue;
    const meta = await sharp(path.join(dir, entry.name)).metadata();
    out[`/assets/img/${entry.name}`] = {
      file: entry.name,
      width: meta.width || 0,
      png: /\.png$/i.test(entry.name),
    };
  }
  return out;
}

/** 源图可用的变体宽度（不超过源宽；源图偏小则单给原生宽度一档） */
function variantWidths(info) {
  const ws = IMG_WIDTHS.filter((w) => w <= info.width);
  return ws.length ? ws : info.width ? [info.width] : [];
}

/** 生成 <name>-<w>.webp 到 dist/assets/img/（照片 q80，PNG/二维码类 q90 保清晰） */
async function generateWebp(images) {
  const dir = path.join(SRC, 'assets', 'img');
  const destDir = path.join(DIST, 'assets', 'img');
  let count = 0;
  for (const info of Object.values(images)) {
    for (const w of variantWidths(info)) {
      await sharp(path.join(dir, info.file))
        .resize({ width: w })
        .webp({ quality: info.png ? 90 : 80, effort: 6 })
        .toFile(path.join(destDir, info.file.replace(/\.[a-z]+$/i, `-${w}.webp`)));
      count++;
    }
  }
  return count;
}

/**
 * <img> 增强：/assets/img 源图包 <picture> 加 WebP srcset（原 JPEG 作回退）；
 * data-src 懒加载图（轮播）改补 data-srcset / data-sizes，由 main.js 激活时赋值。
 * sizes 取值：fetchpriority="high"（首屏 hero）→ 100vw；模板可写 data-sizes 覆盖；其余走卡片默认。
 */
function enhanceImages(html, images) {
  const preloads = [];
  html = html.replace(/<img\b[^>]*>/g, (tag) => {
    const m = tag.match(/\s(?:data-)?src="(\/assets\/img\/([^"]+))"/);
    const info = m && images[m[1]];
    if (!m || !info) return tag;
    const widths = variantWidths(info);
    if (!widths.length) return tag;
    const base = m[1].replace(/\.[a-z]+$/i, '');
    const srcset = widths.map((w) => `${base}-${w}.webp ${w}w`).join(', ');
    const isHero = /fetchpriority="high"/.test(tag);
    const sizes = isHero ? '100vw' : (tag.match(/data-sizes="([^"]*)"/) || [])[1] || '(max-width: 833px) 100vw, 340px';
    const clean = tag.replace(/\sdata-sizes="[^"]*"/g, '');
    if (/data-src="/.test(tag)) {
      return clean.replace(/data-src="/, `data-srcset="${srcset}" data-sizes="${sizes}" data-src="`);
    }
    if (isHero) preloads.push({ srcset, sizes });
    return `<picture><source type="image/webp" srcset="${srcset}" sizes="${sizes}">${clean}</picture>`;
  });
  return { html, preloads };
}

/* ---------------- 产物压缩（只压 dist，源文件保持可读） ---------------- */

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>~])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

/** 折叠空白与注释；script/style/pre/textarea 内容原样保留（压空白可能破坏行注释等） */
function minifyHtml(html) {
  const parts = html.split(
    /(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<pre\b[\s\S]*?<\/pre>|<textarea\b[\s\S]*?<\/textarea>)/g
  );
  return parts
    .map((seg, i) =>
      i % 2
        ? seg
        : seg
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\s+/g, ' ')
            .replace(/> </g, '><')
            .trim()
    )
    .join('');
}

/* ---------------- 页面处理 ---------------- */

/**
 * 社媒聚合页渠道解析（docs/社媒聚合页方案.md §4）：页面数据声明 "socialChannels": true 时调用。
 *  - 图标取 SOCIAL_ICONS；链接解析：渠道条目自带 url 时以 url 为准（用于只上聚合页、不进页脚
 *    那一行的渠道），否则按 icon 从「本语言优先、缺则另一语言兜底」的 site.footer.socials 索引
 *    取 href / qr / qrList → 页脚已列的渠道链接只在 site.footer.socials 维护一处；
 *  - 名称/说明/二维码题注取渠道表当前语言文案（缺该语言回退 zh）；
 *  - 模板条件只支持单路径真值 → 分组数组在构建期算好；
 *  - 页面声明 "contactSupport": true 时解析 data.supportHref：企业微信在线咨询的 href 只在
 *    zh 站页脚配置（site.footer.onlineSupport），英文站页脚没有，但英文聚合页要与中文页对称
 *    → href 跨 locale 取其一带上，label/desc 由页面数据按语言给。
 * 校验口径同 site.footer.socials：未知 icon、既无自带 url 又查不到页脚条目 → 构建失败。
 */
function resolveSocialChannels(data, locCode) {
  const byIcon = SOCIALS_BY_ICON[locCode] || new Map();
  const text = (entry, key) => (entry[locCode] || entry[DEFAULT_LOCALE.code] || {})[key] || '';
  const items = (SOCIAL_CHANNELS.channels || []).map((c) => {
    if (!SOCIAL_ICONS[c.icon]) throw new Error(`social-channels.json 未知图标: ${c.icon}`);
    const src = byIcon.get(c.icon);
    const href = c.url || src?.href;
    const qr = href ? undefined : c.qr || src?.qr;
    const qrList = href || qr ? undefined : c.qrList || src?.qrList;
    const isShare = Array.isArray(qrList) && qrList.length > 0;
    if (!href && !qr && !isShare) {
      throw new Error(`social-channels.json 渠道 ${c.icon} 既没有自带 url，也未在两个 locale 的 site.footer.socials 找到（需 href / qr / qrList 之一）`);
    }
    return {
      icon: c.icon,
      group: c.group,
      name: text(c, 'name') || src?.label || c.icon,
      desc: text(c, 'desc'),
      cap: text(c, 'cap') || src?.cap || '',
      svg: SOCIAL_ICONS[c.icon],
      href,
      qr,
      qrListJson: isShare ? JSON.stringify(qrList.map((q) => (typeof q === 'string' ? { src: q } : { ...q }))) : undefined,
      isLink: Boolean(href),
      isQr: !href && Boolean(qr),
    };
  });
  const groups = (SOCIAL_CHANNELS.groups || []).filter((g) => items.some((i) => i.group === g.key));
  const order = (SOCIAL_CHANNELS.channelOrder || {})[locCode] || groups.map((g) => g.key);
  data.socialGroups = groups
    .slice()
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    .map((g) => ({
      key: g.key,
      label: g[locCode] || g[DEFAULT_LOCALE.code] || g.key,
      items: items.filter((i) => i.group === g.key),
    }));
  data.share = byIcon.get('share-site') || null;
  if (data.contactSupport) {
    if (!ONLINE_SUPPORT) {
      throw new Error('页面声明 contactSupport，但没有任何 locale 的 site.footer.onlineSupport.href 可用');
    }
    data.supportHref = ONLINE_SUPPORT.href;
  }
  return data;
}

/** 页面首部 JSON 元信息注释：<!-- {"title":"…","description":"…"} --> */
function parseMeta(html) {
  const m = html.match(/^\s*<!--\s*(\{[\s\S]*?\})\s*-->/);
  if (!m) throw new Error('页面缺少 meta JSON 注释');
  return JSON.parse(m[1]);
}

/**
 * 构建单页 × 单 locale。
 * 非默认 locale：数据文件 src/data/<code>/<dir>.json 不存在 → 返回 null（该页不产出该语言）；
 * 页面 meta（title/description）必须取自该数据文件的 meta 字段，缺失即构建失败。
 */
function buildPage(loc, dirName, site, strings, images, alternates, ogAlternates, localesForSwitcher) {
  const pagePath = path.join(PAGES_DIR, dirName, 'index.html');
  let html = read(pagePath);
  const zhMeta = parseMeta(html);
  html = html.replace(/^\s*<!--\s*\{[\s\S]*?\}\s*-->/, '');

  const isDefault = loc.code === DEFAULT_LOCALE.code;
  const locDataFile = localeDataPath(loc, `${dirName}.json`);
  if (!isDefault && !exists(locDataFile)) return null;
  const data = exists(locDataFile) ? JSON.parse(read(locDataFile)) : {};
  if (data.socialChannels) resolveSocialChannels(data, loc.code);

  let meta = zhMeta;
  if (!isDefault) {
    const m = data.meta || {};
    if (!m.title || !m.description) {
      throw new Error(`[${loc.code}] ${dirName} 数据文件缺 meta.title / meta.description（src/data/${loc.code}/${dirName}.json）`);
    }
    meta = { ...zhMeta, ...m };
  }

  const slug = pageSlug(loc, dirName);
  const ctx = {
    site,
    data,
    t: strings,
    page: {
      locale: loc.code,
      htmlLang: loc.htmlLang,
      urlPrefix: localePrefix(loc),
      ogLocale: loc.ogLocale,
      manifestHref: `${localePrefix(loc)}manifest.webmanifest`,
      isDefaultLocale: isDefault,
      slug,
      url: `${SITE_URL}${slug}`,
      title: meta.title,
      description: meta.description,
      ogType: dirName === 'index' ? 'website' : 'article',
      ogImage: meta.ogImage || '/assets/img/longhu_yanhuowanhui.jpeg',
      themeColor: meta.themeColor || '#fbfbfd',
      css: meta.css || '',
      alternates,
      ogAlternates,
      locales: localesForSwitcher,
      // JS 文案（main.js / ai-chat.js / fireworks 经 window.__I18N 取串）
      i18n: jsonForHtml({ locale: loc.code, ...strings.js }),
    },
  };

  html = render(html, ctx);

  // JSON-LD 结构化数据（@graph）：WebPage / AboutPage / 首页 Organization+WebSite（弊病 4 收尾项）/
  // BreadcrumbList（由 nav 推导）/ FAQPage（data.faq，须与页面可见 FAQ 一致）/ Event（data.event，
  // 如「焰火之吻」每周六烟花秀）——搜索富结果
  const webpage = {
    '@type': 'WebPage',
    name: meta.title,
    description: meta.description,
    url: ctx.page.url,
    inLanguage: loc.htmlLang,
    isPartOf: { '@id': `${SITE_URL}/#website` },
  };
  const graph = [webpage];
  if (dirName === 'about') {
    // 关于页：AboutPage + 挂载团队实体（与首页 Organization 同 @id 关联）
    webpage['@type'] = 'AboutPage';
    webpage.mainEntity = {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: site.name,
      url: `${SITE_URL}${localePrefix(loc)}`,
      email: site.email,
    };
  } else if (dirName === 'index') {
    graph.push(
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: site.name,
        url: `${SITE_URL}${localePrefix(loc)}`,
        email: site.email,
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        name: site.name,
        url: `${SITE_URL}${localePrefix(loc)}`,
        inLanguage: loc.htmlLang,
        publisher: { '@id': `${SITE_URL}/#organization` },
      }
    );
  } else if (dirName !== '404') {
    const crumbs = breadcrumbList(loc, dirName, site, meta.title);
    if (crumbs) graph.push(crumbs);
  }
  if (Array.isArray(data.faq) && data.faq.length) {
    graph.push({
      '@type': 'FAQPage',
      '@id': `${ctx.page.url}#faq`,
      mainEntity: data.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
  }
  if (data.event) {
    const ev = data.event;
    graph.push({
      '@type': 'Event',
      name: ev.name,
      description: ev.description,
      url: ctx.page.url,
      image: `${SITE_URL}${ctx.page.ogImage}`,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      isAccessibleForFree: true,
      location: {
        '@type': 'Place',
        name: ev.locationName,
        address: {
          '@type': 'PostalAddress',
          streetAddress: ev.locationName,
          addressLocality: ev.addressLocality,
          addressRegion: ev.addressRegion,
          addressCountry: 'CN',
        },
      },
      organizer: { '@type': 'Organization', name: site.name, url: `${SITE_URL}${localePrefix(loc)}` },
      eventSchedule: {
        '@type': 'Schedule',
        repeatFrequency: 'P1W',
        byDay: 'https://schema.org/Saturday',
        startTime: ev.startTime,
      },
      duration: ev.duration,
    });
  }
  html = html.replace(
    '</head>',
    `  <script type="application/ld+json">${jsonForHtml({ '@context': 'https://schema.org', '@graph': graph })}</script>\n</head>`
  );

  // 图片增强（WebP srcset / picture 回退）+ 首屏 hero preload；无 sharp 时 images 为空原样输出
  const enhanced = enhanceImages(html, images);
  html = enhanced.html;
  if (enhanced.preloads.length) {
    const links = enhanced.preloads
      .map((p) => `<link rel="preload" as="image" imagesrcset="${p.srcset}" imagesizes="${p.sizes}" fetchpriority="high">`)
      .join('');
    html = html.replace('<link rel="stylesheet"', `${links}<link rel="stylesheet"`);
  }
  html = minifyHtml(html);

  const is404 = dirName === '404';
  // 404 页输出为 dist/[<prefix>/]404.html（zh 由 Workers not_found_handling 约定；en 由 Worker 改送，见 worker/index.js）；
  // 其余为 [<prefix>/]<name>/index.html
  const outDir = path.join(DIST, loc.urlPrefix, is404 || dirName === 'index' ? '' : dirName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, is404 ? '404.html' : 'index.html'), html);
  return { dir: dirName, locale: loc.code, slug, meta, html };
}

/* ---------------- 构建期校验（docs/英文版方案.md Phase 1，防烂尾） ---------------- */

/**
 * 非默认语言页面站内链接巡检 + 翻译覆盖率报告。
 * 断链（zh 也没有的目标）→ 构建失败（--loose 降级为警告）；
 * 目标存在但无对应语言产物 → 降级中文，计入覆盖率报告。
 */
function validateBuilt(built, producedDirs) {
  const zhSlugs = new Set(built.filter((b) => b.locale === DEFAULT_LOCALE.code).map((b) => b.slug.replace(/\/$/, '') || '/'));
  const total = built.filter((b) => b.locale === DEFAULT_LOCALE.code).length;
  const problems = [];
  const coverage = [];

  for (const loc of LOCALES) {
    if (loc.code === DEFAULT_LOCALE.code) continue;
    const pages = built.filter((b) => b.locale === loc.code);
    const producedSet = new Set(pages.map((b) => b.slug.replace(/\/$/, '') || '/'));
    let degraded = 0;
    coverage.push(
      `${loc.code} ${pages.length}/${total} 页（${pages.map((p) => p.dir).join(', ') || '暂无'}）`
    );

    for (const b of pages) {
      // 当前页的 zh 对应页 = 语言切换器的目标（有意行为），不计为降级链接
      const zhSelf = b.slug.replace(`/${loc.urlPrefix}`, '').replace(/\/$/, '') || '/';
      const hrefs = [...b.html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
      for (const raw of hrefs) {
        const target = raw.split('#')[0].split('?')[0].replace(/\/+$/, '') || '/';
        if (ASSET_PREFIXES.some((p) => target.startsWith(p) || target === p)) continue;
        if (target === zhSelf) continue;
        if (loc.urlPrefix && (target === `/${loc.urlPrefix}` || target.startsWith(`/${loc.urlPrefix}/`))) {
          // 本语言内部链接：剥离 locale 前缀后按资产/页面判断
          const inner = target === `/${loc.urlPrefix}` ? '/' : target.slice(`/${loc.urlPrefix}`.length);
          if (ASSET_PREFIXES.some((p) => inner.startsWith(p) || inner === p)) continue;
          // Worker 渲染的动态板块（/en/tv 等）运行时必然存在，视为有效
          if (EN_DYNAMIC_PREFIXES.some((p) => target === p || target.startsWith(`${p}/`))) continue;
          if (!producedSet.has(target)) {
            problems.push(`[${loc.code}] ${b.slug} → ${raw}（${loc.code} 未产出）`);
          }
          continue;
        }
        if (DYNAMIC_ZH_ROUTES.some((r) => target === r || target.startsWith(`${r}/`))) continue;
        // zh 目标必须存在（真断链），存在但无对应语言产物 → 降级中文（计入报告）
        if (!zhSlugs.has(target)) {
          problems.push(`[${loc.code}] ${b.slug} → ${raw}（zh 也不存在，断链）`);
        } else {
          degraded++;
        }
      }
    }
    if (degraded) coverage[coverage.length - 1] += `，站内链接降级中文 ${degraded} 个（翻译推进后归零）`;
  }
  return { problems, coverage };
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const t0 = Date.now();
  fs.rmSync(DIST, { recursive: true, force: true });

  // 每语言 site / strings：strings 按回退链 deep-merge（en 缺 key 回退 zh，UI 永远完整）
  const sites = {};
  const stringsByLocale = {};
  for (const loc of LOCALES) {
    const siteFile = localeDataPath(loc, 'site.json');
    if (!exists(siteFile)) throw new Error(`locale ${loc.code} 已注册但缺 ${path.relative(ROOT, siteFile)}`);
    const site = JSON.parse(read(siteFile));
    // 页脚社交数据驱动：icon 名 → SVG（docs/英文版方案.md Phase 1 页脚改造）。
    // 条目三态：href 外链 ｜ qr 单二维码（灯箱直开）｜ qrList 分享二维码组（运行时加权随机，docs/分享二维码方案.md）
    for (const s of site.footer?.socials || []) {
      if (!SOCIAL_ICONS[s.icon]) throw new Error(`site.footer.socials 未知图标: ${s.icon}（${loc.code}）`);
      if (!s.href && !s.qr && !(Array.isArray(s.qrList) && s.qrList.length > 0)) {
        throw new Error(`site.footer.socials 缺少 href / qr / qrList 之一: ${s.icon}（${loc.code}）`);
      }
      s.svg = SOCIAL_ICONS[s.icon];
      // 模板引擎条件只支持单路径真值 → 预计算三态布尔；qrList 序列化进 data-qr-list 属性（esc 转义引号）
      s.isLink = Boolean(s.href);
      s.isQr = !s.href && Boolean(s.qr);
      s.isShare = !s.href && !s.qr && Array.isArray(s.qrList) && s.qrList.length > 0;
      if (s.isShare) {
        s.qrListJson = JSON.stringify(s.qrList.map((q) => (typeof q === 'string' ? { src: q } : { ...q })));
      }
    }
    sites[loc.code] = site;

    const zhStrings = JSON.parse(read(localeDataPath(DEFAULT_LOCALE, 'strings.json')));
    stringsByLocale[loc.code] =
      loc.code === DEFAULT_LOCALE.code ? zhStrings : deepMerge(zhStrings, JSON.parse(read(localeDataPath(loc, 'strings.json'))));
  }

  // 社媒渠道 icon → 条目索引：本语言条目优先，缺失的用另一语言兜底（/social/ 与 /en/social/
  // 都要列全平台——双语页面共用一份渠道表，故需跨 locale 解析）。键=icon，值=已预计算 svg/三态的 socials 条目。
  SOCIALS_BY_ICON = {};
  for (const loc of LOCALES) {
    const map = new Map();
    for (const other of LOCALES) {
      if (other.code === loc.code) continue;
      for (const s of sites[other.code].footer?.socials || []) map.set(s.icon, s);
    }
    for (const s of sites[loc.code].footer?.socials || []) map.set(s.icon, s);
    SOCIALS_BY_ICON[loc.code] = map;
  }
  ONLINE_SUPPORT = LOCALES.map((l) => sites[l.code].footer?.onlineSupport).find((s) => s && s.href) || null;

  const images = await scanImages();

  /** 递归收集页面目录（相对 PAGES_DIR 路径；含 index.html 的目录才算一页，如 heritage、heritage/fireworks） */
  const listPageDirs = (dir, prefix = '') => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (exists(path.join(dir, entry.name, 'index.html'))) out.push(rel);
      out.push(...listPageDirs(path.join(dir, entry.name), rel));
    }
    return out;
  };
  const pageDirs = listPageDirs(PAGES_DIR).sort((a, b) =>
    a === 'index' ? -1 : b === 'index' ? 1 : a.localeCompare(b)
  );

  // Pass 1：确定每个页面各语言的产出集合（非默认语言有数据文件才产出 → 未翻译页不产出）
  const producedDirs = new Map(); // dir -> locale codes[]
  for (const dir of pageDirs) {
    const codes = [];
    for (const loc of LOCALES) {
      if (loc.code === DEFAULT_LOCALE.code || exists(localeDataPath(loc, `${dir}.json`))) codes.push(loc.code);
    }
    producedDirs.set(dir, codes);
  }

  /** hreflang alternate（含 x-default → 默认语言）；单语言页返回 []（head 不输出） */
  const alternatesFor = (dir) => {
    const codes = producedDirs.get(dir) || [];
    if (codes.length < 2) return [];
    return [
      ...codes.map((code) => {
        const loc = LOCALES.find((l) => l.code === code);
        return { hreflang: loc.hreflang, href: `${SITE_URL}${pageSlug(loc, dir)}` };
      }),
      { hreflang: 'x-default', href: `${SITE_URL}${pageSlug(DEFAULT_LOCALE, dir)}` },
    ];
  };

  // Pass 2：逐页 × 逐 locale 构建
  const built = [];
  for (const dir of pageDirs) {
    for (const loc of LOCALES) {
      if (!(producedDirs.get(dir) || []).includes(loc.code)) continue;
      const otherLocs = (producedDirs.get(dir) || [])
        .filter((code) => code !== loc.code)
        .map((code) => LOCALES.find((l) => l.code === code));
      const page = buildPage(
        loc,
        dir,
        sites[loc.code],
        stringsByLocale[loc.code],
        images,
        alternatesFor(dir),
        otherLocs.map((l) => l.ogLocale),
        otherLocs.map((l) => ({ label: l.label, hreflang: l.hreflang, href: pageSlug(l, dir) }))
      );
      if (page) built.push(page);
    }
  }

  // sitemap.xml（404 不收录；/merchants/ 由 Worker 动态渲染，商户明细另见 /merchants/sitemap.xml；
  // 多语言页附 xhtml:link alternate，hreflang 成对互指——由产出集合天然保证）
  const zhPages = built.filter((b) => b.locale === DEFAULT_LOCALE.code && b.dir !== '404');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${zhPages
  .map((p) => {
    const alts = alternatesFor(p.dir)
      .map((a) => `\n    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}"/>`)
      .join('');
    return `  <url>
    <loc>${SITE_URL}${p.slug}</loc>${alts}
    <changefreq>monthly</changefreq>
  </url>`;
  })
  .join('\n')}
${DYNAMIC_SECTIONS.map(
    (s) => `  <url>
    <loc>${SITE_URL}/${s.route}/</loc>
    <changefreq>weekly</changefreq>
  </url>`
  )
  .join('\n')}
</urlset>
`;
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), sitemap);

  fs.writeFileSync(
    path.join(DIST, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n${DYNAMIC_SECTIONS.filter((s) => s.sitemap)
      .map((s) => `Sitemap: ${SITE_URL}/${s.route}/sitemap.xml`)
      .join('\n')}\n`
  );

  // 静态资源
  copyDir(path.join(ROOT, 'public'), DIST);
  copyDir(path.join(SRC, 'assets'), path.join(DIST, 'assets'));

  // 离线兜底页双语：public/offline.html 是模板（{{t.offline.*}}），按 locale 渲染到
  // dist/offline.html 与 dist/<prefix>/offline.html；sw.js 按导航路径前缀选兜底页
  const offlineTpl = read(path.join(DIST, 'offline.html'));
  for (const loc of LOCALES) {
    const outDir = path.join(DIST, loc.urlPrefix);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'offline.html'),
      render(offlineTpl, { t: stringsByLocale[loc.code], page: { htmlLang: loc.htmlLang } })
    );
  }

  // per-locale manifest：public/manifest.webmanifest 为默认语言模板；其他 locale 用
  // site.manifest 覆盖文案字段，id/start_url/scope 挂到 /<prefix>/
  const manifestBase = JSON.parse(read(path.join(DIST, 'manifest.webmanifest')));
  for (const loc of LOCALES) {
    const m = { ...manifestBase, ...(sites[loc.code].manifest || {}) };
    if (loc.urlPrefix) {
      m.id = `/${loc.urlPrefix}/`;
      m.start_url = `/${loc.urlPrefix}/`;
      m.scope = `/${loc.urlPrefix}/`;
    }
    m.lang = loc.htmlLang;
    fs.writeFileSync(path.join(DIST, loc.urlPrefix, 'manifest.webmanifest'), JSON.stringify(m, null, 2));
  }

  // WebP 变体生成（有 sharp 才有 images 清单）
  if (Object.keys(images).length) {
    const n = await generateWebp(images);
    console.log(`  WebP 变体 ${n} 个已生成`);
  } else if (!sharp) {
    console.warn('  ⚠ 未安装 sharp（npm install），跳过 WebP 图片优化');
  }

  // CSS 压缩（须在指纹计算前：?v= 哈希基于压缩产物）
  const cssPath = path.join(DIST, 'assets', 'css', 'style.css');
  fs.writeFileSync(cssPath, minifyCss(read(cssPath)));
  const aiCssPath = path.join(DIST, 'assets', 'css', 'ai-chat.css');
  fs.writeFileSync(aiCssPath, minifyCss(read(aiCssPath)));

  // 烟花模拟器（/digital-fireworks/）：14 个零依赖 JS 依依赖顺序拼接为单文件
  // （globals 协作，顺序即加载顺序；mid-file 的 "use strict" 字面量无副作用），CSS 一并压缩
  const FIREWORKS_JS_ORDER = [
    'fscreen', 'stage', 'my-math',                                      // lib
    'config', 'store', 'background-library', 'background-manager', 'ui', // app
    'runtime', 'shells', 'interaction', 'simulation', 'audio', 'engine', // fireworks
  ];
  const fwDir = path.join(SRC, 'assets', 'js', 'fireworks');
  fs.writeFileSync(
    path.join(DIST, 'assets', 'js', 'fireworks.js'),
    FIREWORKS_JS_ORDER.map((n) => read(path.join(fwDir, `${n}.js`))).join('\n')
  );
  const fwCssPath = path.join(DIST, 'assets', 'css', 'fireworks.css');
  fs.writeFileSync(fwCssPath, minifyCss(read(fwCssPath)));

  // 资源指纹：CSS/JS 内容变化 → 引用加 ?v=hash。/assets/* 缓存一年 immutable（_headers），
  // 无版本号的话访客会拿到旧样式（浏览器不会重新验证），有版本号则内容一变 URL 即变。
  const hashFile = (p) => createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 8);
  const versions = {
    '/assets/css/style.css': hashFile(path.join(DIST, 'assets/css/style.css')),
    '/assets/js/main.js': hashFile(path.join(DIST, 'assets/js/main.js')),
    '/assets/js/home-hero.js': hashFile(path.join(DIST, 'assets/js/home-hero.js')),
    '/assets/js/music-player.js': hashFile(path.join(DIST, 'assets/js/music-player.js')),
    '/assets/css/fireworks.css': hashFile(path.join(DIST, 'assets/css/fireworks.css')),
    '/assets/js/fireworks.js': hashFile(path.join(DIST, 'assets/js/fireworks.js')),
    '/assets/css/ai-chat.css': hashFile(path.join(DIST, 'assets/css/ai-chat.css')),
    '/assets/js/ai-chat.js': hashFile(path.join(DIST, 'assets/js/ai-chat.js')),
  };
  // 供主 Worker 渲染动态板块（/tv /library /music /attractions /merchants 及其 /en 子树）
  // 复用的页头/页脚：按 locale 各编译一份到 dist/partials/<code>/（须在指纹回写前生成，
  // 页脚里的 ai-chat 引用才能拿到 ?v=）。切换器 page.locales 给「对应语言首页」的兜底 href——
  // 动态页无构建期当前页上下文，main.js 按 data-locale-switch 在运行时重写为前缀+当前路径。
  for (const loc of LOCALES) {
    const other = LOCALES.find((l) => l.code !== loc.code);
    const workerCtx = {
      site: sites[loc.code],
      t: stringsByLocale[loc.code],
      page: { locales: [{ label: other.label, hreflang: other.hreflang, href: localePrefix(other) }] },
    };
    fs.mkdirSync(path.join(DIST, 'partials', loc.code), { recursive: true });
    for (const name of ['header', 'footer']) {
      const compiled = render(read(path.join(PARTIALS_DIR, `${name}.html`)), workerCtx);
      fs.writeFileSync(path.join(DIST, 'partials', loc.code, `${name}.html`), compiled);
    }
  }

  const bumpAssetUrls = (file) => {
    let html = read(file);
    for (const [asset, v] of Object.entries(versions)) {
      html = html.replaceAll(asset, `${asset}?v=${v}`);
    }
    fs.writeFileSync(file, html);
  };
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.html')) bumpAssetUrls(p);
    }
  })(DIST);

  // Worker 页面引用带指纹的 CSS/JS 用；i18n 为动态页注入 main.js 的 per-locale JS 文案表
  fs.writeFileSync(
    path.join(DIST, 'build-meta.json'),
    JSON.stringify({ ...versions, i18n: { zh: stringsByLocale.zh.js, en: stringsByLocale.en.js } })
  );

  // PWA Service Worker（docs/PWA应用方案.md §3.2）：public/sw.js 是模板，预缓存清单与脏戳
  // 由构建注入 → dist/sw.js。清单带 ?v= 指纹、脏戳取指纹哈希——任一资产内容变化 SW 字节即变，
  // 浏览器自动重装换新缓存，与页面 ?v= 同一套失效逻辑。多语言：全部 locale 页面 + 双语 offline
  // + 双语 manifest 一并入预缓存。
  const swStamp = createHash('md5').update(JSON.stringify(versions)).digest('hex').slice(0, 8);
  const precache = [
    ...built.filter((b) => b.dir !== '404').map((b) => b.slug),
    ...LOCALES.map((l) => `${localePrefix(l)}offline.html`),
    ...LOCALES.map((l) => `${localePrefix(l)}manifest.webmanifest`),
    '/favicon.svg',
    '/favicon.ico',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/maskable-192.png',
    '/icons/maskable-512.png',
    '/icons/apple-touch-icon.png',
    ...Object.keys(versions).map((a) => `${a}?v=${versions[a]}`),
  ];
  fs.writeFileSync(
    path.join(DIST, 'sw.js'),
    read(path.join(ROOT, 'public', 'sw.js'))
      .replace("'__BUILD__'", JSON.stringify(`v-${swStamp}`))
      .replace('__PRECACHE__', JSON.stringify(precache))
  );

  // 构建期校验：EN 页链接巡检（断链失败，--loose 放行）+ 翻译覆盖率报告
  const { problems, coverage } = validateBuilt(built, producedDirs);
  const hasProblems = problems.length > 0;
  for (const p of problems) console.error(`  ✗ ${p}`);
  for (const c of coverage) console.log(`  覆盖率: ${c}`);

  const kb = (p) => (fs.statSync(p).size / 1024).toFixed(1);
  console.log(`✔ ${built.length} 页构建完成（${LOCALES.map((l) => `${l.code}×${built.filter((b) => b.locale === l.code).length}`).join(' + ')}）→ dist/（${Date.now() - t0}ms）`);
  for (const b of built) console.log(`  ${b.slug.padEnd(14)} ${b.meta.title}`);
  console.log(`  sitemap.xml + robots.txt 已生成；首页 HTML ${kb(path.join(DIST, 'index.html'))}KB`);

  if (hasProblems && !LOOSE) {
    console.error(`✗ 构建校验失败：${problems.length} 处断链（--loose 仅限灰度期显式放行）`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
