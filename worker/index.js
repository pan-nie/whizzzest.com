/**
 * 单入口 Worker：
 *  - www → 裸域 301（方案 §8.2）
 *  - POST /api/contact  联系表单：Honeypot → D1（权威记录）→ 企业邮通知（尽力而为，§7）
 *  - POST /api/pv-dwell 页面停留时长回报（页面关闭时 navigator.sendBeacon）
 *  - POST /api/ai/chat  AI 助手「花傩」问答（Workers AI + RAG，docs/AI助手方案.md）
 *  - GET  /api/ai/config AI 助手前端配置（招呼语/快捷问题）
 *  - /tv/*              万载TV 视频频道动态渲染（D1 权威，docs/万载TV方案.md）
 *  - /media/*           TV 视频/封面 R2 代理（admin Worker 上传）
 *  - 文档导航请求 → 访客监控：匿名 Cookie（vid 1 年 / sid 会话 30min）+ 环境解析
 *    （浏览器/OS/语言/流量类型）→ D1 visits；HTML 注入回报脚本，ctx.waitUntil 不阻塞响应
 *  - 其余请求交给静态资产（dist/）
 */
import { sendMail } from './smtp.js';
import { handleMerchants } from './merchants.js';
import { handleTv, handleMedia, handleTvLatest } from './tv.js';
import { handleLibrary } from './library.js';
import { handleMusic, handleMusicPlay, handleMusicLatest } from './music.js';
import { handleAttractions, handleAttractionsLatest } from './attractions.js';
import { handleAiChat, handleAiConfig } from './ai.js';
import { requireHttps } from '../shared/https.mjs';

const BOT_RE = /bot|crawl|spider|slurp|preview|headless|monitor/i;
const VID_COOKIE = 'vid';
const SID_COOKIE = 'sid';
const VID_MAX_AGE = 365 * 24 * 60 * 60;
const SID_MAX_AGE = 30 * 60; // 30 分钟滑动会话

export default {
  async fetch(request, env, ctx) {
    const insecure = requireHttps(request);
    if (insecure) return insecure;
    const url = new URL(request.url);

    if (url.hostname === 'www.whizzzest.com') {
      url.hostname = 'whizzzest.com';
      return Response.redirect(url, 301);
    }

    if (url.pathname === '/api/contact' && request.method === 'POST') {
      return handleContact(request, env);
    }

    if (url.pathname === '/api/pv-dwell' && request.method === 'POST') {
      return handleDwell(request, env, ctx);
    }

    // 万载TV 最新视频（首页「焰境影像」条数据源，公开 JSON，docs/万载TV方案.md）
    if (url.pathname === '/api/tv/latest' && request.method === 'GET') {
      return handleTvLatest(env);
    }

    // 景点精选 / 万载音乐（首页板块数据源，公开 JSON，同 handleTvLatest 模式）
    if (url.pathname === '/api/attractions/latest' && request.method === 'GET') {
      return handleAttractionsLatest(env);
    }
    if (url.pathname === '/api/music/latest' && request.method === 'GET') {
      return handleMusicLatest(env);
    }

    // 平台内容计数（关于页「平台一览」数字条数据源，公开 JSON）
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      return handleStats(env);
    }

    // 万载音乐播放计数（前端开始播放一首时回报一次，2026-09-06）
    if (url.pathname.startsWith('/api/music/play/') && request.method === 'POST') {
      return handleMusicPlay(request, env, url);
    }

    // AI 助手「花傩」问答（docs/AI助手方案.md）
    if (url.pathname === '/api/ai/chat' && request.method === 'POST') {
      return handleAiChat(request, env, ctx);
    }
    if (url.pathname === '/api/ai/config' && request.method === 'GET') {
      return handleAiConfig(env, url);
    }

    // 商户图片代理（R2 对象，merchant Worker 上传，M2）——不可浏览文档，直接返回不进访客采集
    if (url.pathname.startsWith('/assets-merchant/')) {
      const key = decodeURIComponent(url.pathname.slice('/assets-merchant/'.length));
      if (!key || key.includes('..') || !/^[\w][\w/.-]*$/.test(key)) {
        return new Response(null, { status: 404 });
      }
      const obj = await env.IMG.get(key);
      if (!obj) return new Response(null, { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      headers.set('cache-control', 'public, max-age=31536000, immutable');
      return new Response(obj.body, { headers });
    }

    // 万载TV 媒体代理（R2 对象，admin Worker 上传，docs/万载TV方案.md）——不可浏览文档，直接返回不进访客采集
    if (url.pathname === '/media' || url.pathname.startsWith('/media/')) {
      return handleMedia(request, env, url);
    }

    // 动态板块：/tv /library /music /attractions /merchants + EN 子树 /en/<section>
    // （docs/英文版方案.md Phase 3：UI 文案双语，D1 内容暂回退中文）
    const mDyn = url.pathname.match(/^\/(en\/)?(tv|library|music|attractions|merchants)(\/|$)/);
    let res;
    if (mDyn) {
      const loc = mDyn[1] ? 'en' : 'zh';
      const section = mDyn[2];
      res = section === 'tv' ? await handleTv(request, env, url, ctx, loc)
        : section === 'library' ? await handleLibrary(request, env, url, ctx, loc)
        : section === 'music' ? await handleMusic(request, env, url, ctx, loc)
        : section === 'attractions' ? await handleAttractions(request, env, url, ctx, loc)
        : await handleMerchants(request, env, url, loc);
    } else {
      // 静态资产请求
      res = await env.ASSETS.fetch(request);
      // EN 子树 404 本地化（docs/英文版方案.md Phase 1）：not_found_handling 是全局的，
      // /en/* miss 会返回中文 404 → 改送 /en/404.html（保留 404 状态码，供访客采集扫描标记）
      if (res.status === 404 && (url.pathname === '/en' || url.pathname.startsWith('/en/'))) {
        const en404 = await env.ASSETS.fetch(new URL('/en/404.html', url));
        if (en404.ok) res = new Response(en404.body, { status: 404, headers: en404.headers });
      }
    }

    // 访客采集：仅针对「文档导航」，跳过资源请求与爬虫
    if (request.method === 'GET' && url.pathname !== '/api/contact') {
      const dest = request.headers.get('sec-fetch-dest') || '';
      const accept = request.headers.get('accept') || '';
      const ua = request.headers.get('user-agent') || '';
      const isDoc = dest === 'document' || (!dest && accept.includes('text/html'));
      if (isDoc && !BOT_RE.test(ua)) {
        return trackVisit(request, env, ctx, url, ua, res);
      }
    }

    return res;
  },

  // 每日定时清理（docs/访客治理方案.md 阶段二 W3）：明细保留 90 天
  // cron 20:17 UTC = 北京 04:17 低峰；删除量 ≈ 每日写入量（数千行），计入 rows written 配额
  async scheduled(event, env, ctx) {
    try {
      const cutoff = new Date(Date.now() + 8 * 60 * 60 * 1000 - 90 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const [v, s] = await env.DB.batch([
        env.DB.prepare(`DELETE FROM visits WHERE created_at < datetime('now', '-90 days')`),
        env.DB.prepare('DELETE FROM scan_stats WHERE date < ?1').bind(cutoff),
      ]);
      console.log(`visits retention: visits -${v.meta?.changes ?? '?'} rows, scan_stats -${s.meta?.changes ?? '?'} rows`);
    } catch (err) {
      console.error('visits retention failed:', err);
    }
  },
};

/* ---------------- 访客采集 ---------------- */

function parseUA(ua) {
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /Linux/.test(ua) ? 'Linux' : 'Other';
  return { browser, os };
}

function classifyRef(host) {
  if (!host) return 'direct';
  if (/(^|\.)whizzzest\.com$/.test(host)) return 'internal';
  if (/google|bing|baidu|duckduckgo|yahoo|sogou|yandex|so\.com|sm\.cn/.test(host)) return 'search';
  if (/weibo|douyin|xiaohongshu|twitter|x\.com|facebook|tiktok|instagram|reddit|bilibili|zhihu|youtube|kuaishou/.test(host)) return 'social';
  return 'referral';
}

function readCookie(cookieHeader, name) {
  return (cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9-]{8,64})`)) || [])[1] || '';
}

/* ---------------- 访客治理辅助（docs/访客治理方案.md 阶段二） ---------------- */

/** IP 截断脱敏：IPv4 保前三段（/24）、IPv6 保前 4 组（/48）——粗粒度归组够用，不存原文 */
function truncIp(ip) {
  if (!ip) return '';
  const p4 = ip.split('.');
  if (p4.length === 4) return `${p4[0]}.${p4[1]}.${p4[2]}.0/24`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::/48`;
  return ip.slice(0, 20);
}

/** 北京时区日期（scan_stats 按天分桶，与后台展示口径一致） */
function bjDate() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 访客写入熔断：同 IP 每分钟文档请求超过 30 次 → 停止写库（隔离实例内计数，best-effort） */
const visitHits = new Map();
function visitFlooded(ip) {
  const now = Date.now();
  const hits = (visitHits.get(ip) || []).filter((t) => now - t < 60 * 1000);
  hits.push(now);
  visitHits.set(ip, hits);
  if (visitHits.size > 5000) visitHits.clear(); // 防 Map 无限膨胀
  return hits.length > 30;
}

/* ---------------- 访客采集总开关（site_settings.visit_tracking，后台「访客」页切换） ---------------- */

// 实例内 60s 缓存：每 isolate 每分钟至多 1 次配置读取；无表/无行/查询失败一律默认开
// （fail-open：配置读失败不应影响采集，写库失败本身已有 catch；关闭是省额度手段，不是安全开关）
let trackingCache = { at: 0, on: true };

async function visitTrackingOn(env) {
  if (Date.now() - trackingCache.at > 60 * 1000) {
    try {
      const row = await env.DB.prepare(`SELECT value FROM site_settings WHERE key = 'visit_tracking'`).first();
      trackingCache = { at: Date.now(), on: !row || row.value !== '0' };
    } catch {
      trackingCache = { at: Date.now(), on: true };
    }
  }
  return trackingCache.on;
}

/**
 * 记一次页面访问：读/发匿名 Cookie（vid 1 年、sid 30 分钟滑动），解析环境维度，
 * D1 插入走 ctx.waitUntil；HTML 响应注入回报脚本（页面关闭时上报停留时长）。
 */
async function trackVisit(request, env, ctx, url, ua, assetRes) {
  const cookie = request.headers.get('cookie') || '';
  let vid = readCookie(cookie, VID_COOKIE);
  let vidNew = false;
  if (!vid) { vid = crypto.randomUUID(); vidNew = true; }

  const prevSid = readCookie(cookie, SID_COOKIE);
  const sid = prevSid || crypto.randomUUID();
  const sidCookie = `${SID_COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SID_MAX_AGE}`;
  const vidCookie = vidNew ? `${VID_COOKIE}=${vid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${VID_MAX_AGE}` : '';

  const device = /Mobile|Android|iPhone/i.test(ua) ? 'mobile'
    : /iPad|Tablet/i.test(ua) ? 'tablet' : 'desktop';
  const { browser, os } = parseUA(ua);
  const lang = (request.headers.get('accept-language') || '').split(',')[0].split(';')[0].trim().slice(0, 20);
  const ref = request.headers.get('referer') || '';
  let refHost = '';
  if (ref) { try { refHost = new URL(ref).hostname; } catch { /* ignore */ } }
  const kind = classifyRef(refHost);
  const pvId = crypto.randomUUID();

  // 机器人/扫描标记：落点 404（探测不存在路径）或路径命中扫描特征
  const SCAN_PATH_RE = /wp-admin|wp-login|phpmyadmin|\.env|\.git|\/open\/|cgi-bin|\.(php|asp|aspx|jsp|sql|bak)$/i;
  const isBot = assetRes.status >= 400 || SCAN_PATH_RE.test(url.pathname) ? 1 : 0;

  // 访客治理（docs/访客治理方案.md 阶段二）：
  //  - IP 脱敏：截断入库（IPv4 /24、IPv6 /48），无 Cookie 访客按截断 IP 粗粒度归组，不存原文
  //  - 扫描器不入明细：扫描/探测请求累加到 scan_stats 日计数表（迁移 003），保留宏观可见性
  //  - 频率熔断：同 IP 文档请求超阈值即停止写库（实例内 best-effort，防恶意刷量）
  // 访客采集总开关：关闭时不写明细/计数、不注入回报脚本、不下发匿名 Cookie（60s 内全网生效）
  const tracking = await visitTrackingOn(env);
  if (!tracking) return new Response(assetRes.body, assetRes);

  const rawIp = request.headers.get('cf-connecting-ip') || '';
  const ip = truncIp(rawIp);
  if (!rawIp || !visitFlooded(rawIp)) {
    ctx.waitUntil(
      isBot
        ? env.DB.prepare(
            `INSERT INTO scan_stats (date, category, count, last_path, last_ua, last_at)
             VALUES (?1, ?2, 1, ?3, ?4, ?5)
             ON CONFLICT (date, category) DO UPDATE SET
               count = count + 1, last_path = ?3, last_ua = ?4, last_at = ?5`
          )
            .bind(bjDate(), SCAN_PATH_RE.test(url.pathname) ? 'scan-path' : '404',
              url.pathname.slice(0, 200), ua.slice(0, 200), new Date().toISOString())
            .run()
            .catch((err) => console.error('scan_stats log failed:', err))
        : env.DB.prepare(
            `INSERT INTO visits (vid, sid, pv_id, path, referrer, ref_host, kind, country, device, browser, os, lang, ua, ip, is_bot)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
          )
            .bind(vid, sid, pvId, url.pathname, ref.slice(0, 300), refHost, kind,
              request.cf?.country || '', device, browser, os, lang.slice(0, 20), ua.slice(0, 250), ip, 0)
            .run()
            .catch((err) => console.error('visit log failed:', err))
    );
  }

  // HTML 才注入回报脚本；图片等非 HTML 文档直接透传
  const ct = assetRes.headers.get('content-type') || '';
  if (!ct.includes('text/html')) {
    const passthrough = new Response(assetRes.body, assetRes);
    if (vidCookie) passthrough.headers.append('set-cookie', vidCookie);
    passthrough.headers.append('set-cookie', sidCookie);
    return passthrough;
  }

  let text = await assetRes.text();
  const inject = `<script>window.__pv={id:${JSON.stringify(pvId)},sid:${JSON.stringify(sid)}};` +
    `addEventListener("pagehide",function(){try{navigator.sendBeacon("/api/pv-dwell",` +
    `JSON.stringify({id:window.__pv.id,ms:Math.round(performance.now())}))}catch(e){}});</script>`;
  text = text.includes('</head>') ? text.replace('</head>', inject + '</head>') : text + inject;

  const out = new Response(text, { status: assetRes.status, headers: assetRes.headers });
  out.headers.set('content-length', new TextEncoder().encode(text).length.toString());
  if (vidCookie) out.headers.append('set-cookie', vidCookie);
  out.headers.append('set-cookie', sidCookie);
  return out;
}

/* ---------------- 停留时长回报 ---------------- */

async function handleDwell(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (body && /^[a-f0-9-]{8,64}$/.test(String(body.id || ''))) {
    const ms = Math.min(3600000, Math.max(0, Number(body.ms) || 0));
    ctx.waitUntil(
      env.DB.prepare('UPDATE visits SET engage_ms = ?1 WHERE pv_id = ?2 AND engage_ms = 0')
        .bind(ms, body.id)
        .run()
        .catch(() => {})
    );
  }
  return new Response(null, { status: 204 });
}

/* ---------------- 平台内容计数（关于页数字条） ---------------- */

/** 实例内 60s 缓存（同 handleTvLatest 模式）；单项查询失败返回 null，前端跳过该项 */
let statsCache = { at: 0, data: null };

async function handleStats(env) {
  if (Date.now() - statsCache.at > 60 * 1000) {
    const count = async (sql) => {
      try {
        return Number(await env.DB.prepare(sql).first('n')) || 0;
      } catch {
        return null;
      }
    };
    const [videos, tracks, attractions, books, merchants] = await Promise.all([
      count(`SELECT COUNT(*) n FROM videos WHERE status = 'published'`),
      count(`SELECT COUNT(*) n FROM music_tracks WHERE status = 'published'`),
      count(`SELECT COUNT(*) n FROM attractions WHERE status = 'published'`),
      count(`SELECT COUNT(*) n FROM books WHERE status = 'approved'`),
      count(`SELECT COUNT(*) n FROM merchants WHERE status = 'approved'`),
    ]);
    statsCache = { at: Date.now(), data: { videos, tracks, attractions, books, merchants } };
  }
  return new Response(JSON.stringify({ ok: true, stats: statsCache.data }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  });
}

/* ---------------- 联系表单 ---------------- */

/** 同 IP 简易限流：每隔离实例内 10 分钟最多 5 条 */
const recent = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;

function rateLimited(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 5000) recent.clear(); // 防 Map 无限膨胀
  return hits.length > RATE_MAX;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

async function handleContact(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // Honeypot：机器人填了隐藏字段 → 假装成功（不写库）
  if (clean(body.website, 100) !== '') return json({ ok: true });

  const name = clean(body.name, 50);
  const email = clean(body.email, 100);
  const message = clean(body.message, 2000);
  if (!name || !message || (email && !EMAIL_RE.test(email))) {
    return json({ ok: false, error: 'invalid_fields' }, 400);
  }

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && rateLimited(ip)) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  // 1) D1 权威记录（失败则明确报错）
  try {
    await env.DB.prepare(
      'INSERT INTO messages (name, email, message, ip, user_agent) VALUES (?1, ?2, ?3, ?4, ?5)'
    )
      .bind(name, email || null, message, ip, clean(request.headers.get('user-agent'), 300))
      .run();
  } catch (err) {
    console.error('D1 insert failed:', err);
    return json({ ok: false, error: 'storage_failed' }, 500);
  }

  // 2) 企业邮通知：尽力而为，失败不影响结果（凭据未配置时静默跳过）
  if (env.SMTP_USER && env.SMTP_PASS && env.NOTIFY_TO) {
    try {
      const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      await sendMail({
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        to: env.NOTIFY_TO,
        subject: `焰境·万载官网新留言 — ${name}`,
        html: [
          `<p><b>${esc(name)}</b>（${esc(email || '未留邮箱')}）通过官网联系表单留言：</p>`,
          `<blockquote style="border-left:3px solid #d64524;padding-left:12px;color:#333">${esc(message).replace(/\n/g, '<br>')}</blockquote>`,
          `<p style="color:#888;font-size:12px">${time} · IP ${esc(ip)}</p>`,
        ].join(''),
      });
    } catch (err) {
      console.error('SMTP notify failed (message kept in D1):', err);
    }
  }

  return json({ ok: true });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
