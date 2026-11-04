/**
 * 焰境·万载 — 管理后台 Worker（admin.whizzzest.com，整域即后台）
 *
 * 安全层次：Cloudflare Access（第一道门，dashboard 开通）→ 本应用账号登录（第二道门）
 *  - GET  /login                 登录页（用户名选填：留空 = 主账号「站长」ADMIN_PASSWORD）
 *  - GET  /                      管理页（留言 / 访客 / 商户 / 视频 / 文库 / 音乐 / 景点 / 账号；视图记忆在 location.hash，刷新不丢）
 *  - POST /api/login             账号密码登录 → 签名会话 Cookie（HttpOnly/Secure/SameSite=Strict）
 *  - POST /api/webauthn/*        通行密钥（Passkey，shared/webauthn.js portal='admin'）：login-options /
 *                                login-verify 免密登录；reg-options/reg-verify 添加；delete 删除；GET list 面板用
 *  - POST /api/logout            退出登录
 *  - GET  /api/me                当前登录账号（导航右上角展示用）
 *  - GET  /api/accounts          运营账号列表（D1 admin_users，权限与站长相同）
 *  - POST /api/accounts          添加账号 {username, password}（PBKDF2 10 万次）
 *  - DELETE /api/accounts/:id    删除账号
 *  - GET  /api/messages          留言列表（?filter=unread|all&offset=0），含 total/unread 计数
 *  - POST /api/messages/:id/read 标记已读/未读 {read: true|false}
 *  - DELETE /api/messages/:id    删除留言
 *
 * 万载TV 视频管理（docs/万载TV方案.md）：
 *  - GET/POST /api/tv             视频列表 / 新建（JSON 元数据）
 *  - POST /api/tv/:id             部分更新（发布/隐藏、焦点位；换文件/封面时级联删旧 R2 对象）
 *  - DELETE /api/tv/:id           删除（级联清理 R2 视频/封面）
 *  - PUT /api/tv/upload?ext=mp4   视频流式上传（File 直作 body → request.body 转发 R2，≤95MB）
 *  - PUT /api/tv/cover            封面上传（≤5MB，魔数校验 JPG/PNG/WebP）
 *
 * 访客分析（数据来自主站 Worker 写入的 visits 表）：
 *  - GET  /api/stats?days=7|30|90   概览卡片 + 每日趋势 + 页面/来源/设备/浏览器/OS/语言/地区 + 最近浏览
 *  - GET  /api/visitors             访客列表（?offset=0），按匿名 Cookie ID / IP 分组
 *  - GET  /api/visitors/:gid        单个访客的会话与页面轨迹
 *
 * 万载音乐管理（2026-09-06）：
 *  - GET/POST /api/music           曲目列表（?status=&offset=）/ 新建（JSON 元数据）
 *  - POST /api/music/:id           部分更新（上下线、排序；换音频/封面时级联删旧 R2 对象）
 *  - DELETE /api/music/:id         删除（级联清理 R2 音频/封面）
 *  - PUT /api/music/upload         MP3 流式上传（File 直作 body，魔数校验 ID3/MPEG，≤50MB）
 *  - PUT /api/music/cover          封面上传（≤5MB，魔数校验 JPG/PNG/WebP，music/c-* 前缀）
 *
 * 旅游景点管理（2026-09-06）：
 *  - GET/POST /api/attractions     景点列表（?status=&offset=）/ 新建（slug 唯一）
 *  - POST /api/attractions/:id     部分更新（上下线、排序；换封面时级联删旧 R2 对象）
 *  - DELETE /api/attractions/:id   删除（级联清理 R2 封面）
 *  - PUT /api/attractions/cover    封面上传（≤5MB，attra/c-* 前缀）
 *
 * AI 助手「花傩」管理（docs/AI助手方案.md）：
 *  - GET/POST /api/ai/settings     运行设置（enabled/model/system_prompt/greeting/quick_questions）
 *  - GET/POST /api/ai/knowledge    知识库列表（?status=&offset=）/ 新建
 *  - POST/DELETE /api/ai/knowledge/:id  编辑 / 删除
 *  - GET /api/ai/stats             用量统计（今日/7天/30天/累计 + 最近 20 条问答）
 *  - DELETE /api/ai/log            清空问答日志
 *
 * 会话：无状态 HMAC 签名（uid + 过期时间戳 + 签名；uid=0 主账号，>0 为 admin_users.id），
 *       改 ADMIN_SESSION_SECRET 即全体下线。
 * 凭据：wrangler secret 配 ADMIN_PASSWORD / ADMIN_SESSION_SECRET，不进代码、不进仓库。
 */

import { PASSKEY_DASH_JS, WA_HELPERS } from '../shared/portal-ui.js';
import { createWebAuthn } from '../shared/webauthn.js';
import { requireHttps } from '../shared/https.mjs';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const SESSION_TTL_S = SESSION_TTL_MS / 1000;
const COOKIE_NAME = 'wa_session';

/* ---------------- 通行密钥（Passkey，shared/webauthn.js）----------------
 * portal='admin'：站长（uid=0，密码在 secret ADMIN_PASSWORD，无 D1 行）与运营账号（admin_users.id）
 * 共用 webauthn_credentials 表，凭据与其他子域互不可用。challenge 签名复用 ADMIN_SESSION_SECRET。 */
function waUser(env, uid) {
  if (uid === 0) return Promise.resolve({ uid: 0 });
  return env.DB.prepare('SELECT id, username FROM admin_users WHERE id = ?1').bind(uid)
    .first().then((row) => (row ? { uid: row.id, username: row.username } : null));
}

// webauthn 专用 IP 限流（登录验签用；结构与 loginLimited 同）
const waHits = new Map();
function waLimited(key, ms, max) {
  const now = Date.now();
  const arr = (waHits.get(key) || []).filter((t) => now - t < ms);
  arr.push(now);
  waHits.set(key, arr);
  return arr.length > max;
}

const wa = createWebAuthn({
  portal: 'admin',
  rpName: '焰境·万载 · 管理后台',
  secret: (env) => env.ADMIN_SESSION_SECRET || null,
  limited: waLimited,
  listCredentials: (env, uid) =>
    env.DB.prepare('SELECT id, credential_id, public_key, counter, transports FROM webauthn_credentials WHERE portal = ?1 AND user_id = ?2 ORDER BY id')
      .bind('admin', uid).all().then((r) => r.results || []),
  findCredential: (env, credId) =>
    env.DB.prepare('SELECT id, user_id, credential_id, public_key, counter FROM webauthn_credentials WHERE portal = ?1 AND credential_id = ?2')
      .bind('admin', credId).first(),
  insertCredential: (env, uid, c, device) =>
    env.DB.prepare('INSERT INTO webauthn_credentials (portal, user_id, credential_id, public_key, counter, transports, device) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind('admin', uid, c.id, c.publicKey, c.counter, JSON.stringify(c.transports || []), device).run(),
  deleteCredential: (env, uid, rowId) =>
    env.DB.prepare('DELETE FROM webauthn_credentials WHERE portal = ?1 AND user_id = ?2 AND id = ?3')
      .bind('admin', uid, rowId).run(),
  touchCounter: (env, rowId, counter) =>
    env.DB.prepare('UPDATE webauthn_credentials SET counter = ?2 WHERE id = ?1').bind(rowId, counter).run(),
  issueSession: (env, uid) => sessionJson(env, uid),
  userName: (user) => user.username || '站长',
});

const PAGE_SIZE = 50;
// 后台页内嵌 favicon（SVG data URI，与主站标签页同款）
const FAVICON_URI = 'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBzdGFuZGFsb25lPSJubyI/PjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+PHN2ZyB0PSIxNzcwNjM5ODE2OTM3IiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9Ijg1MzgiIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCI+PHBhdGggZD0iTTUxMi44IDQyMC44Yy0xNTYuOCAyMzQuNC0xNDEuNiA1NzYuOC00OCA1NzguNCA5Ni44IDIuNC0xNC40LTM5NC40IDQ4LTU3OC40ek00ODAuOCAzOTUuMmMtMjI3LjIgNzQuNC0zOTIgMzExLjItMzI4LjggMzYxLjYgNjQuOCA1MiAxOTEuMi0yNzIgMzI4LjgtMzYxLjZ6TTQ4Ny4yIDM3NkMyOTAuNCAyODggMjQgMzMyIDMxLjIgMzk5LjJjNy4yIDY4LjggMzA3LjItNDkuNiA0NTYtMjMuMnpNNTEyLjggMzU0LjRjLTg5LjYtMTY5LjYtMzAwLTMwMC44LTMzMS4yLTI1Ni0zMiA0Ni40IDI0MS42IDE1MiAzMzEuMiAyNTZ6TTUzMS4yIDM1NC40QzYyNi40IDIyOCA2MzIgMzQuNCA1ODAuOCAyOS42Yy01Mi44LTQuOC03LjIgMjIzLjItNDkuNiAzMjQuOHpNNTQ4IDM2Ni40YzE0NC44IDMuMiAyOTUuMi05NC40IDI3Mi0xMzUuMi0yNC00MS42LTE3My42IDExMi0yNzIgMTM1LjJ6TTU2MS42IDM5OS4yYzE2MCAxMTkuMiA0MjAgMTYwLjggNDMxLjIgMTA5LjYgMTEuMi01Mi44LTI5OS4yLTQ4LjgtNDMxLjItMTA5LjZ6TTUzOS4yIDQyNi40YzI5LjYgMjE2IDIxMS4yIDQxNy42IDI2NC44IDM3NS4yIDU1LjItNDMuMi0yMDcuMi0yMzMuNi0yNjQuOC0zNzUuMnoiIGZpbGw9IiNFODM1MTgiIHAtaWQ9Ijg1MzkiPjwvcGF0aD48cGF0aCBkPSJNOTE5LjIgNjIyLjRsMTYgMzIuOCAzNiA0LjgtMjUuNiAyNS42IDUuNiAzNi0zMi0xNi44LTMyIDE2LjggNi40LTM2LTI2LjQtMjUuNiAzNi00Ljh6IiBmaWxsPSIjRjREMzFGIiBwLWlkPSI4NTQwIj48L3BhdGg+PHBhdGggZD0iTTUyMCAzMzkuMmwxNiAzMi44IDM2IDUuNi0yNS42IDI0LjggNS42IDM2LTMyLTE2LjgtMzIgMTYuOCA2LjQtMzYtMjYuNC0yNC44IDM2LTUuNnpNMjM5LjIgNzkyLjhsMTQuNCAzMC40IDM0LjQgNC44LTI0LjggMjQgNS42IDMzLjYtMjkuNi0xNi0zMC40IDE2IDUuNi0zMy42LTI0LjgtMjQgMzQuNC00Ljh6TTE1MS4yIDE4OGgtMzJ2LTMyYzAtMi40LTEuNi00LTQtNHMtNCAxLjYtNCA0djMyaC0zMmMtMi40IDAtNCAxLjYtNCA0czEuNiA0IDQgNGgzMnYzMmMwIDIuNCAxLjYgNCA0IDRzNC0xLjYgNC00di0zMmgzMmMyLjQgMCA0LTEuNiA0LTRzLTEuNi00LTQtNHoiIGZpbGw9IiNGNUUzMjgiIHAtaWQ9Ijg1NDEiPjwvcGF0aD48L3N2Zz4=';
const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="${FAVICON_URI}">`;

export default {
  async fetch(request, env) {
    const insecure = requireHttps(request);
    if (insecure) return insecure;
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // 全站响应统一带安全头；后台为登录态面板，HTML/JSON 一律 no-store（防浏览器缓存陈旧页面：
    // 曾出现用户标签页停留在旧 HTML 上、事件未绑定、列表永远「加载中」的情况）
    const baseHeaders = {
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    };

    try {
      if (path.startsWith('/api/')) {
        const res = await handleApi(request, env, path);
        Object.entries(baseHeaders).forEach(([k, v]) => res.headers.set(k, v));
        return res;
      }

      const res = await handlePage(request, env, path);
      Object.entries(baseHeaders).forEach(([k, v]) => res.headers.set(k, v));
      res.headers.set('content-security-policy', [
        "default-src 'self'",
        "script-src 'unsafe-inline'", // MVP：内联脚本，无外部依赖
        "style-src 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data: blob: https://whizzzest.com", // 封面缩略图来自主站（/assets /assets-merchant /media 代理）；blob: = 表单里本地图的即时预览
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '));
      return res;
    } catch (err) {
      console.error('admin worker error:', err);
      return json({ ok: false, error: 'internal_error' }, 500);
    }
  },
};

/* ---------------- 路由 ---------------- */

async function handlePage(request, env, path) {
  if (path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (path === '/login') return html(LOGIN_HTML);

  if (path === '/') {
    if ((await sessionUid(request, env)) === null) return redirect('/login');
    return html(APP_HTML);
  }
  return redirect('/');
}

function redirect(path) {
  return new Response(null, { status: 302, headers: { location: path } });
}

async function handleApi(request, env, path) {
  const method = request.method;

  // 登录：限流 + 验密
  if (path === '/api/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/logout' && method === 'POST') {
    const res = json({ ok: true });
    res.headers.set('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return res;
  }
  // 通行密钥：login-options/login-verify 公开（本就在 Cloudflare Access 之后）；
  // list（看板面板用）/ reg-options / reg-verify / delete 需登录会话
  if (path === '/api/webauthn/list' && method === 'GET') {
    const uid = await sessionUid(request, env);
    if (uid === null) return json({ ok: false, error: 'unauthorized' }, 401);
    const { results } = await env.DB.prepare(
      'SELECT id, device, created_at FROM webauthn_credentials WHERE portal = ?1 AND user_id = ?2 ORDER BY id'
    ).bind('admin', uid).all();
    return json({ ok: true, keys: results || [] });
  }
  if (path.startsWith('/api/webauthn/')) {
    const uid = await sessionUid(request, env);
    const user = uid === null ? null : await waUser(env, uid);
    return wa.handle(request, env, path, user);
  }

  // 其余 API 一律先过会话
  const uid = await sessionUid(request, env);
  if (uid === null) return json({ ok: false, error: 'unauthorized' }, 401);

  // 变更请求校验来源（配合 SameSite=Strict 双保险）：Origin 的 host 必须与 Host 头一致
  // （生产同为 admin.whizzzest.com；本地 wrangler dev 时两者同为 127.0.0.1:<port>，自然放行）
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === request.headers.get('host');
      } catch { /* 非法 origin 一律拒绝 */ }
      if (!sameOrigin) {
        return json({ ok: false, error: 'bad_origin' }, 403);
      }
    }
  }

  let m;
  if (path === '/api/me' && method === 'GET') {
    return json({ ok: true, user: await resolveUser(env, uid) });
  }

  // 运营账号管理（admin_users，权限与主账号相同）
  if (path === '/api/accounts' && method === 'GET') return listAccounts(env);
  if (path === '/api/accounts' && method === 'POST') return createAccount(env, request);
  if ((m = path.match(/^\/api\/accounts\/(\d+)$/)) && method === 'DELETE') {
    return removeAccount(env, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/messages\/(\d+)\/read$/)) && method === 'POST') {
    return setRead(env, Number(m[1]), request);
  }
  if ((m = path.match(/^\/api\/messages\/(\d+)$/)) && method === 'DELETE') {
    return removeMessage(env, Number(m[1]));
  }
  if (path === '/api/messages' && method === 'GET') {
    return listMessages(env, request);
  }

  if (path === '/api/stats' && method === 'GET') return statsOverview(env, request);
  if (path === '/api/visitors' && method === 'GET') return listVisitors(env, request);
  if ((m = path.match(/^\/api\/visitors\/([A-Za-z0-9:%._-]+)$/)) && method === 'GET') {
    return visitorDetail(env, decodeURIComponent(m[1]));
  }
  // 访客采集总开关（site_settings.visit_tracking；主站 Worker 60s 缓存，切换后最迟 1 分钟全网生效）
  if (path === '/api/visitor-tracking' && method === 'GET') return getVisitTracking(env);
  if (path === '/api/visitor-tracking' && method === 'POST') return setVisitTracking(env, request);

  // 商户管理（M1，docs/商户功能方案.md）；DELETE 级联删除门户账号 + R2 图片
  if (path === '/api/merchants' && method === 'GET') return listMerchants(env, request);
  if (path === '/api/merchants' && method === 'POST') return createMerchant(env, request);
  if ((m = path.match(/^\/api\/merchants\/(\d+)$/)) && method === 'POST') {
    return editMerchant(env, Number(m[1]), request);
  }
  if ((m = path.match(/^\/api\/merchants\/(\d+)$/)) && method === 'DELETE') {
    return removeMerchant(env, Number(m[1]));
  }
  // 核销：确认收款 → 开通等级 + 一年到期，清除待核销申请（M3）
  if ((m = path.match(/^\/api\/merchants\/(\d+)\/redeem$/)) && method === 'POST') {
    return redeemMerchant(env, Number(m[1]), request);
  }
  // 封面图上传（≤5MB，魔数校验 JPG/PNG/WebP；与商户门户同桶同 m<id>/ 前缀，
  // 主站经 /assets-merchant/<key> 代理展示，删除商户按前缀级联清理）
  // ?m= 商户 id 必填——新建未入库没有归属前缀，前端先建档拿到 id 再传图
  if (path === '/api/merchants/cover' && method === 'PUT') {
    const mid = parseInt(new URL(request.url).searchParams.get('m') || '', 10);
    if (!mid) return json({ ok: false, error: 'merchant_required' }, 400);
    return uploadImageR2(env, request, `m${mid}/`, env.IMG);
  }

  // 文库封面上传（≤5MB，魔数校验 JPG/PNG/WebP；存 MEDIA 桶 book/b<id>/c- 前缀，
  // 与该作品章节插图同前缀——删除作品按前缀级联清理；主站经 /media/<key> 代理展示）
  // ?b= 作品 id 必填——带图新建时前端先建档拿到 id 再传图（同商户流程）
  if (path === '/api/books/cover' && method === 'PUT') {
    const bid = parseInt(new URL(request.url).searchParams.get('b') || '', 10);
    if (!bid) return json({ ok: false, error: 'book_required' }, 400);
    return uploadImageR2(env, request, `book/b${bid}/c-`, env.MEDIA);
  }

  // 万载TV 视频管理（docs/万载TV方案.md）；DELETE 级联删除 R2 视频/封面
  if (path === '/api/tv' && method === 'GET') return listVideos(env, request);
  if (path === '/api/tv' && method === 'POST') return saveVideo(env, request);
  if ((m = path.match(/^\/api\/tv\/(\d+)$/)) && method === 'POST') {
    return saveVideo(env, request, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/tv\/(\d+)$/)) && method === 'DELETE') {
    return removeVideo(env, Number(m[1]));
  }
  // 流式上传：视频 File 直作 PUT body（Worker 转发 request.body → R2，不整读内存）；封面 ≤5MB
  if (path === '/api/tv/upload' && method === 'PUT') return uploadVideoFile(env, request);
  if (path === '/api/tv/cover' && method === 'PUT') return uploadVideoCover(env, request);
  // 从B站拉取信息：标题/简介/时长 + 封面转存 R2（B站图床有 Referer 防盗链，服务端抓回转存绕开）
  if (path === '/api/tv/fetch-bili' && method === 'POST') return fetchBili(env, request);

  // 文库管理（docs/文库方案.md）：作品审核 + 章节审核；DELETE 级联章节与 R2 图片
  if (path === '/api/books' && method === 'GET') return listBooks(env, request);
  if (path === '/api/books' && method === 'POST') return createBook(env, request);
  if ((m = path.match(/^\/api\/books\/(\d+)$/)) && method === 'POST') {
    return updateBook(env, Number(m[1]), request);
  }
  if ((m = path.match(/^\/api\/books\/(\d+)$/)) && method === 'DELETE') {
    return removeBook(env, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/books\/(\d+)\/chapters$/)) && method === 'GET') {
    return listBookChapters(env, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/books\/(\d+)\/chapters\/(\d+)$/)) && method === 'POST') {
    return reviewChapter(env, Number(m[1]), Number(m[2]), request);
  }
  if ((m = path.match(/^\/api\/books\/(\d+)\/chapters\/(\d+)$/)) && method === 'DELETE') {
    return removeChapter(env, Number(m[1]), Number(m[2]));
  }
  // admin 直改章节（序号/标题/正文/删单张插图）：站长即审核人，不改变审核状态
  if ((m = path.match(/^\/api\/books\/(\d+)\/chapters\/(\d+)\/edit$/)) && method === 'POST') {
    return editChapter(env, Number(m[1]), Number(m[2]), request);
  }

  // 万载音乐管理（2026-09-06）：曲目 CRUD + MP3/封面上传；DELETE 级联清理 R2 音频/封面
  if (path === '/api/music' && method === 'GET') return listTracks(env, request);
  if (path === '/api/music' && method === 'POST') return saveTrack(env, request);
  if ((m = path.match(/^\/api\/music\/(\d+)$/)) && method === 'POST') {
    return saveTrack(env, request, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/music\/(\d+)$/)) && method === 'DELETE') {
    return removeTrack(env, Number(m[1]));
  }
  // 流式上传：MP3 File 直作 PUT body（request.body 探魔数后续流转发 R2，≤50MB）；封面 ≤5MB
  if (path === '/api/music/upload' && method === 'PUT') return uploadTrackFile(env, request);
  if (path === '/api/music/cover' && method === 'PUT') return uploadImageR2(env, request, 'music/c-');

  // 旅游景点管理（2026-09-06）：CRUD + 封面上传；DELETE 级联清理 R2 封面
  if (path === '/api/attractions' && method === 'GET') return listAttractions(env, request);
  if (path === '/api/attractions' && method === 'POST') return saveAttraction(env, request);
  if ((m = path.match(/^\/api\/attractions\/(\d+)$/)) && method === 'POST') {
    return saveAttraction(env, request, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/attractions\/(\d+)$/)) && method === 'DELETE') {
    return removeAttraction(env, Number(m[1]));
  }
  if (path === '/api/attractions/cover' && method === 'PUT') return uploadImageR2(env, request, 'attra/c-');

  // AI 助手「花傩」管理（docs/AI助手方案.md）：设置 / 知识库 / 用量
  if (path === '/api/ai/settings' && method === 'GET') return getAiSettings(env);
  if (path === '/api/ai/settings' && method === 'POST') return saveAiSettings(env, request);
  if (path === '/api/ai/knowledge' && method === 'GET') return listKnowledge(env, request);
  if (path === '/api/ai/knowledge' && method === 'POST') return saveKnowledge(env, request);
  if ((m = path.match(/^\/api\/ai\/knowledge\/(\d+)$/)) && method === 'POST') {
    return saveKnowledge(env, request, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/ai\/knowledge\/(\d+)$/)) && method === 'DELETE') {
    return removeKnowledge(env, Number(m[1]));
  }
  if (path === '/api/ai/stats' && method === 'GET') return aiStats(env);
  if (path === '/api/ai/log' && method === 'DELETE') return clearAiLog(env);

  return json({ ok: false, error: 'not_found' }, 404);
}

/* ---------------- 登录 / 会话 ---------------- */

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX = 5;

function loginLimited(ip) {
  const now = Date.now();
  const hits = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  hits.push(now);
  loginAttempts.set(ip, hits);
  if (loginAttempts.size > 5000) loginAttempts.clear();
  return hits.length > LOGIN_MAX;
}

async function handleLogin(request, env) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return json({ ok: false, error: 'config_missing' }, 500);
  }

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && loginLimited(ip)) return json({ ok: false, error: 'rate_limited' }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const username = String(body?.username ?? '').trim();
  const password = String(body?.password ?? '');

  // 用户名留空 = 主账号「站长」（ADMIN_PASSWORD 密钥）；填了用户名走 D1 运营账号
  let uid = 0;
  if (username) {
    const row = await env.DB
      .prepare('SELECT id, pass_hash, pass_salt FROM admin_users WHERE username = ?1')
      .bind(username)
      .first();
    if (!row) return json({ ok: false, error: 'invalid_credentials' }, 401);
    if (!timingSafeEqual(await pbkdf2Hex(password, row.pass_salt), row.pass_hash)) {
      return json({ ok: false, error: 'invalid_credentials' }, 401);
    }
    uid = row.id;
  } else {
    const given = await sha256Hex(password);
    const expected = await sha256Hex(env.ADMIN_PASSWORD);
    if (!timingSafeEqual(given, expected)) {
      return json({ ok: false, error: 'invalid_credentials' }, 401);
    }
  }

  return sessionJson(env, uid);
}

/** 会话签发（密码登录与 Passkey 登录共用）：200 JSON + 签名会话 Cookie */
async function sessionJson(env, uid) {
  const exp = String(Date.now() + SESSION_TTL_MS);
  const sig = await hmacHex(env.ADMIN_SESSION_SECRET, uid + '.' + exp);
  const res = json({ ok: true });
  res.headers.set(
    'Set-Cookie',
    `${COOKIE_NAME}=${uid}.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_S}`
  );
  return res;
}

/** 会话校验：返回 uid（0 = 主账号「站长」，>0 = admin_users.id）；无效返回 null */
async function sessionUid(request, env) {
  if (!env.ADMIN_SESSION_SECRET) return null;
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([0-9]+)\\.([0-9]+)\\.([a-f0-9]{64})`));
  if (!m) return null;
  const [, uid, exp, sig] = m;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return null;
  const expected = await hmacHex(env.ADMIN_SESSION_SECRET, uid + '.' + exp);
  if (!timingSafeEqual(sig, expected)) return null;
  return Number(uid);
}

/** uid → 展示名 */
async function resolveUser(env, uid) {
  if (!uid) return '站长';
  const row = await env.DB.prepare('SELECT username FROM admin_users WHERE id = ?1').bind(uid).first();
  return row?.username || '账号已删除';
}

/* ---------------- 运营账号管理（D1 admin_users） ---------------- */

const USER_RE = /^[A-Za-z0-9_-]{2,20}$/;
const MAX_ACCOUNTS = 10;

async function listAccounts(env) {
  const { results } = await env.DB
    .prepare('SELECT id, username, created_at FROM admin_users ORDER BY id')
    .all();
  return json({ ok: true, accounts: results || [] });
}

async function createAccount(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const username = String(body?.username ?? '').trim();
  const password = String(body?.password ?? '');
  if (!USER_RE.test(username)) return json({ ok: false, error: 'bad_username' }, 400);
  if (password.length < 8 || password.length > 64) return json({ ok: false, error: 'bad_password' }, 400);

  const { n } = await env.DB.prepare('SELECT COUNT(*) n FROM admin_users').first();
  if (n >= MAX_ACCOUNTS) return json({ ok: false, error: 'too_many' }, 400);

  const salt = crypto.randomUUID().replace(/-/g, '');
  try {
    await env.DB.prepare(
      'INSERT INTO admin_users (username, pass_hash, pass_salt) VALUES (?1, ?2, ?3)'
    ).bind(username, await pbkdf2Hex(password, salt), salt).run();
  } catch {
    return json({ ok: false, error: 'dup_username' }, 400);
  }
  return json({ ok: true });
}

async function removeAccount(env, id) {
  const { meta } = await env.DB.prepare('DELETE FROM admin_users WHERE id = ?1').bind(id).run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);
  return json({ ok: true });
}

/* ---------------- 留言管理（D1） ---------------- */

const MSG_FIELDS = 'id, name, email, message, ip, user_agent, created_at, read_at';

async function listMessages(env, request) {
  const url = new URL(request.url);
  const unreadOnly = url.searchParams.get('filter') === 'unread';
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

  const counts = await env.DB
    .prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread FROM messages')
    .first();

  const sql = unreadOnly
    ? `SELECT ${MSG_FIELDS} FROM messages WHERE read_at IS NULL ORDER BY id DESC LIMIT ?1 OFFSET ?2`
    : `SELECT ${MSG_FIELDS} FROM messages ORDER BY id DESC LIMIT ?1 OFFSET ?2`;
  const { results } = await env.DB.prepare(sql).bind(PAGE_SIZE, offset).all();

  return json({ ok: true, total: counts?.total || 0, unread: counts?.unread || 0, messages: results || [] });
}

async function setRead(env, id, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const read = body?.read !== false;
  const { meta } = await env.DB
    .prepare('UPDATE messages SET read_at = CASE WHEN ?2 = 1 THEN datetime(\'now\') ELSE NULL END WHERE id = ?1')
    .bind(id, read ? 1 : 0)
    .run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);
  return json({ ok: true });
}

async function removeMessage(env, id) {
  const { meta } = await env.DB.prepare('DELETE FROM messages WHERE id = ?1').bind(id).run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);
  return json({ ok: true });
}

/* ---------------- 访客分析（D1 visits） ---------------- */

// 北京时区「今日零点」的 UTC 表达（D1 created_at 存 UTC）
const bjToday = "datetime('now','+8 hours','start of day','-8 hours')";
// 访客分组：优先匿名 Cookie ID；无 Cookie 时按 IP 归组（gid 前缀 anon:）
const GID = "COALESCE(NULLIF(vid,''),'anon:'||COALESCE(ip,'x'))";
const KIND_LABEL = {
  direct: '直接访问', internal: '站内跳转', search: '搜索引擎',
  social: '社交媒体', referral: '外部链接', other: '其他',
};

/** 天数参数 → SQL since 表达式（含边界校验） */
/** 实例内 60s 缓存（对齐主站 handleStats 模式，docs/访客治理方案.md 阶段一第 3 项）：
 *  自动刷新与多人同开命中缓存不碰库；手动刷新带 &fresh=1 绕过缓存读、回写结果 */
const apiCache = new Map();
async function cached(key, fresh, fn) {
  if (!fresh) {
    const hit = apiCache.get(key);
    if (hit && Date.now() - hit.at < 60 * 1000) return hit.data;
  }
  const data = await fn();
  apiCache.set(key, { at: Date.now(), data });
  if (apiCache.size > 100) apiCache.clear(); // 防 Map 无限膨胀
  return data;
}

function sinceExpr(daysParam) {
  const days = [7, 30, 90, 180, 365].includes(daysParam) ? daysParam : 7;
  const back = days === 1 ? '' : `,'-${days - 1} days'`;
  return { days, sql: `datetime('now','+8 hours','start of day','-8 hours'${back})` };
}

/* ---------------- 访客采集总开关（site_settings.visit_tracking，docs/访客治理方案.md） ---------------- */

async function getVisitTracking(env) {
  const row = await env.DB
    .prepare(`SELECT value, updated_at FROM site_settings WHERE key = 'visit_tracking'`)
    .first();
  return json({ ok: true, on: !row || row.value !== '0', updated_at: row?.updated_at || null });
}

async function setVisitTracking(env, request) {
  const body = await request.json().catch(() => ({}));
  const on = body.on === true || body.on === 1 || body.on === '1';
  await env.DB.prepare(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ('visit_tracking', ?1, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = ?1, updated_at = datetime('now')`
  ).bind(on ? '1' : '0').run();
  return json({ ok: true, on });
}

async function statsOverview(env, request) {
  const url = new URL(request.url);
  const fresh = url.searchParams.get('fresh') === '1';
  const key = 'stats:' + url.search.replace(/&?fresh=1/, ''); // 键剔除 fresh：手动刷新回写缓存供自动刷新命中
  return json(await cached(key, fresh, async () => {
  const { days, sql: SINCE } = sinceExpr(url.searchParams.get('days'));
  const bots = url.searchParams.get('bots') === '1';
  // R3（docs/访客治理方案.md 阶段一）：排除爬虫改为内联条件——配合迁移 003 的 (is_bot, created_at)
  // 复合索引走范围扫描；原 (SELECT * … WHERE is_bot = 0) 子查询每条查询都要物化全表（R3 放大器）
  const W = bots ? '1=1' : 'is_bot = 0';
  const db = env.DB;

  const sincePrev = `datetime('now','+8 hours','start of day','-8 hours','-${days} days')`;

  const [cards, bounce, avgTime, newUv, daily, pages, kinds, sources, devices, browsers, oses, langs, countries, recent, prevPv, live, firstSeen, entries, depth] =
    await Promise.all([
      db.prepare(
        `SELECT COUNT(*) pv, COUNT(DISTINCT ${GID}) uv, COUNT(DISTINCT sid) sessions
         FROM visits WHERE ${W} AND created_at >= ${SINCE}`
      ).first(),
      db.prepare(
        `SELECT COUNT(*) n FROM (
           SELECT sid FROM visits WHERE ${W} AND sid IS NOT NULL AND created_at >= ${SINCE}
           GROUP BY sid HAVING COUNT(*) = 1
         )`
      ).first(),
      db.prepare(
        `SELECT AVG(engage_ms) t FROM visits WHERE ${W} AND engage_ms > 0 AND created_at >= ${SINCE}`
      ).first(),
      db.prepare(
        `SELECT COUNT(*) n FROM (
           SELECT vid FROM visits WHERE ${W} AND vid IS NOT NULL AND created_at >= ${SINCE}
           GROUP BY vid HAVING MIN(created_at) >= ${SINCE}
         )`
      ).first(),
      db.prepare(
        `SELECT date(created_at, '+8 hours') d, COUNT(*) pv, COUNT(DISTINCT vid) uv, COUNT(DISTINCT sid) sessions
         FROM visits WHERE ${W} AND created_at >= ${SINCE} GROUP BY d ORDER BY d`
      ).all(),
      db.prepare(
        `SELECT path, COUNT(*) pv, COUNT(DISTINCT vid) uv, AVG(engage_ms) avg_ms
         FROM visits WHERE ${W} AND created_at >= ${SINCE} GROUP BY path ORDER BY pv DESC LIMIT 10`
      ).all(),
      db.prepare(
        `SELECT COALESCE(NULLIF(kind,''),'other') kind, COUNT(DISTINCT sid) sessions, COUNT(*) pv
         FROM visits WHERE ${W} AND created_at >= ${SINCE} GROUP BY kind ORDER BY pv DESC`
      ).all(),
      // 来源站归一化在 SQL 侧完成：自有域折叠为「站内」、外部域剥 www. —— 一个显示标签一个分组
      db.prepare(
        `SELECT src, COUNT(DISTINCT sid) sessions, COUNT(*) pv FROM (
           SELECT CASE
             WHEN ref_host IS NULL OR ref_host = '' THEN '直接访问'
             WHEN ref_host = 'whizzzest.com' OR ref_host LIKE '%.whizzzest.com' THEN '站内'
             WHEN ref_host LIKE 'www.%' THEN SUBSTR(ref_host, 5)
             ELSE ref_host END AS src, sid
           FROM visits WHERE ${W} AND created_at >= ${SINCE}
         ) GROUP BY src ORDER BY pv DESC LIMIT 30`
      ).all(),
      db.prepare(
        `SELECT COALESCE(NULLIF(device,''),'—') name, COUNT(DISTINCT ${GID}) uv, COUNT(*) pv
         FROM visits WHERE ${W} AND created_at >= ${SINCE} GROUP BY device ORDER BY pv DESC`
      ).all(),
      db.prepare(
        `SELECT COALESCE(NULLIF(NULLIF(browser,''),'Other'),'Other') name, COUNT(DISTINCT ${GID}) uv, COUNT(*) pv
         FROM visits WHERE ${W} AND created_at >= ${SINCE} GROUP BY browser ORDER BY pv DESC LIMIT 30`
      ).all(),
      db.prepare(
        `SELECT COALESCE(NULLIF(NULLIF(os,''),'Other'),'Other') name, COUNT(DISTINCT ${GID}) uv, COUNT(*) pv
         FROM visits WHERE ${W} AND created_at >= ${SINCE} GROUP BY os ORDER BY pv DESC LIMIT 30`
      ).all(),
      // 语言归一化在 SQL 侧完成：按前缀映射到显示标签再分组，杜绝 en 与 en-US 各成一行、双双显示「英语」
      db.prepare(
        `SELECT name, COUNT(DISTINCT ${GID}) uv, COUNT(*) pv FROM (
           SELECT CASE
             WHEN lang IS NULL OR lang = '' THEN '未知'
             WHEN lang LIKE 'zh-Hant%' OR lang LIKE 'zh-TW%' OR lang LIKE 'zh-HK%' OR lang LIKE 'zh-MO%' THEN '繁体中文'
             WHEN lang LIKE 'zh%' THEN '简体中文'
             WHEN lang LIKE 'en%' THEN '英语'
             WHEN lang LIKE 'ja%' THEN '日语'
             WHEN lang LIKE 'ko%' THEN '韩语'
             ELSE lang END AS name, vid, ip
           FROM visits WHERE ${W} AND created_at >= ${SINCE}
         ) GROUP BY name ORDER BY pv DESC LIMIT 30`
      ).all(),
      db.prepare(
        `SELECT COALESCE(NULLIF(country,''),'未知') name, COUNT(DISTINCT ${GID}) uv, COUNT(*) pv
         FROM visits WHERE ${W} AND created_at >= ${SINCE} GROUP BY country ORDER BY pv DESC LIMIT 30`
      ).all(),
      db.prepare(
        `SELECT created_at, path, COALESCE(NULLIF(kind,''),'other') kind, ref_host, country, device, engage_ms
         FROM visits WHERE ${W} AND created_at >= ${SINCE} ORDER BY created_at DESC LIMIT 30`
      ).all(),
      // 上一周期 PV（环比用）
      db.prepare(`SELECT COUNT(*) n FROM visits WHERE ${W} AND created_at >= ${sincePrev} AND created_at < ${SINCE}`).first(),
      // 实时：近 5 分钟浏览
      db.prepare(`SELECT COUNT(*) n FROM visits WHERE ${W} AND created_at >= datetime('now','-5 minutes')`).first(),
      // 每位访客的「首访日」分布（算每日新访客）
      // R2：补时间窗下限（原为全表 GROUP BY vid）。口径注：窗口内的首次到访日——
      // 跨窗回访客会在窗口内首现那天被计为「新」，精确口径待阶段三 visitors_first 表
      db.prepare(`SELECT date(MIN(created_at), '+8 hours') fd, COUNT(*) n FROM visits WHERE ${W} AND vid IS NOT NULL AND created_at >= ${SINCE} GROUP BY vid`).all(),
      // 入口页 TOP（每会话的第一个页面）
      db.prepare(
        `SELECT path, COUNT(*) n FROM (
           SELECT sid, path, ROW_NUMBER() OVER (PARTITION BY sid ORDER BY created_at) rn
           FROM visits WHERE ${W} AND sid IS NOT NULL AND created_at >= ${SINCE}
         ) WHERE rn = 1 GROUP BY path ORDER BY n DESC LIMIT 30`
      ).all(),
      // 会话深度分布（1 页 / 2-3 页 / 4 页以上）
      db.prepare(
        `SELECT SUM(CASE WHEN d = 1 THEN 1 ELSE 0 END) d1,
                SUM(CASE WHEN d BETWEEN 2 AND 3 THEN 1 ELSE 0 END) d23,
                SUM(CASE WHEN d >= 4 THEN 1 ELSE 0 END) d4p
         FROM (SELECT COUNT(*) d FROM visits WHERE ${W} AND sid IS NOT NULL AND created_at >= ${SINCE} GROUP BY sid)`
      ).first(),
    ]);

    // 每日新访客：按首访日聚合
    const newMap = {};
    (firstSeen.results || []).forEach((r) => { newMap[r.fd] = (newMap[r.fd] || 0) + r.n; });
    const dailyRows = (daily.results || []).map((r) => ({ ...r, new_uv: newMap[r.d] || 0 }));

  const sessions = cards?.sessions || 0;
  const pv = cards?.pv || 0;
  const prev = prevPv?.n || 0;
  return {
    ok: true,
    days,
    cards: {
      pv,
      uv: cards?.uv || 0,
      sessions,
      bounce: sessions ? Math.round(((bounce?.n || 0) / sessions) * 100) : 0,
      avg_time_s: Math.round((avgTime?.t || 0) / 1000),
      new_uv: newUv?.n || 0,
      pages_per_session: sessions ? Math.round((pv / sessions) * 10) / 10 : 0,
      delta_pv: prev ? Math.round(((pv - prev) / prev) * 100) : null,
      live5: live?.n || 0,
    },
    daily: dailyRows,
    entries: entries.results || [],
    depth: { d1: depth?.d1 || 0, d23: depth?.d23 || 0, d4p: depth?.d4p || 0 },
    top_pages: (pages.results || []).map((p) => ({ ...p, avg_s: Math.round((p.avg_ms || 0) / 1000) })),
    kinds: (kinds.results || []).map((k) => ({ ...k, label: KIND_LABEL[k.kind] || k.kind })),
    sources: sources.results || [],
    devices: devices.results || [],
    browsers: browsers.results || [],
    os: oses.results || [],
    langs: langs.results || [],
    countries: countries.results || [],
    recent: (recent.results || []).map((r) => ({ ...r, kind: r.kind || 'other' })),
  };
  }));
}

async function listVisitors(env, request) {
  const url = new URL(request.url);
  const fresh = url.searchParams.get('fresh') === '1';
  const key = 'visitors:' + url.search.replace(/&?fresh=1/, '');
  return json(await cached(key, fresh, async () => {
  const bots = url.searchParams.get('bots') === '1';
  const W = bots ? '1=1' : 'is_bot = 0'; // R3：内联排除爬虫，配合迁移 003 复合索引
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const { sql: SINCE } = sinceExpr(url.searchParams.get('days'));

  // R2：列表限定所选时间窗内活跃的访客（原为全时间全表分组排序）
  const { results } = await env.DB
    .prepare(
      `SELECT ${GID} gid, COUNT(*) views, COUNT(DISTINCT sid) sessions,
              MIN(created_at) first, MAX(created_at) last,
              MAX(country) country, MAX(device) device, MAX(browser) browser, MAX(os) os
       FROM visits WHERE ${W} AND created_at >= ${SINCE}
       GROUP BY gid ORDER BY last DESC LIMIT ?1 OFFSET ?2`
    )
    .bind(PAGE_SIZE, offset)
    .all();

  // R2：总数改近似口径——整页满则报「至少还有一页」（offset+PAGE_SIZE+1），否则为精确值；
  // 不再每次翻页对全表精确 COUNT(DISTINCT)。「加载更多」按 total > offset+PAGE_SIZE 判断，逻辑兼容
  const rows = results || [];
  const total = rows.length === PAGE_SIZE ? offset + PAGE_SIZE + 1 : offset + rows.length;

  return { ok: true, total, visitors: rows };
  }));
}

async function visitorDetail(env, gid) {
  const W = 'is_bot = 0'; // 内联排除爬虫（R3）
  const where = `${GID} = ?1`;
  const summary = await env.DB
    .prepare(`SELECT COUNT(*) n, MIN(created_at) first, MAX(created_at) last FROM visits WHERE ${W} AND ${where}`)
    .bind(gid)
    .first();
  const { results: sessions } = await env.DB
    .prepare(
      `SELECT sid, MIN(created_at) start, MAX(created_at) end, COUNT(*) views
       FROM visits WHERE ${W} AND ${where} AND sid IS NOT NULL GROUP BY sid ORDER BY start DESC LIMIT 50`
    )
    .bind(gid)
    .all();
  const { results: views } = await env.DB
    .prepare(
      `SELECT path, kind, ref_host, country, device, engage_ms, created_at
       FROM visits WHERE ${W} AND ${where} ORDER BY created_at DESC LIMIT 300`
    )
    .bind(gid)
    .all();
  return json({
    ok: true,
    gid,
    n: summary?.n || 0,
    first: summary?.first,
    last: summary?.last,
    sessions: (sessions || []).map((s) => ({ ...s, sid: s.sid ? `${s.sid.slice(0, 8)}…` : '' })),
    views: views || [],
  });
}

/* ---------------- 商户管理（D1 merchants，M1） ---------------- */

const M_CATEGORIES = ['food', 'stay', 'specialty', 'fireworks', 'other'];
const M_TIERS = ['free', 'verified', 'featured'];
const M_STATUSES = ['pending', 'approved', 'rejected', 'expired'];
// 可编辑字段白名单（k → 最大长度；null = 数字）
const M_FIELDS = {
  name: 60, category: 20, tier: 10, intro: 200, detail: 4000,
  cover: 300, address: 120, phone: 30, wechat: 60, hours: 60,
  contact_name: 40, contact_phone: 30, slug: 60, status: 10,
  reject_reason: 200, paid_until: 10, sort_weight: null,
};
// 空串按 NULL 存的字段
const M_NULLABLE = ['detail', 'cover', 'address', 'phone', 'wechat', 'hours',
  'contact_name', 'contact_phone', 'slug', 'reject_reason', 'paid_until'];

function pickFields(body) {
  const out = {};
  for (const [k, max] of Object.entries(M_FIELDS)) {
    if (!(k in body)) continue;
    if (k === 'sort_weight') { out[k] = Math.max(0, Math.min(999, Number(body[k]) || 0)); continue; }
    let v = String(body[k] ?? '').trim().slice(0, max || 200);
    if (k === 'slug') v = v.toLowerCase().replace(/[^a-z0-9-]/g, '');
    out[k] = M_NULLABLE.includes(k) && v === '' ? null : v;
  }
  return out;
}

async function listMerchants(env, request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

  const counts = await env.DB.prepare('SELECT status, COUNT(*) n FROM merchants GROUP BY status').all();
  const byStatus = {};
  let total = 0;
  (counts.results || []).forEach((r) => { byStatus[r.status] = r.n; total += r.n; });

  const sql = M_STATUSES.includes(status)
    ? `SELECT * FROM merchants WHERE status = ?1 ORDER BY id DESC LIMIT ?2 OFFSET ?3`
    : `SELECT * FROM merchants ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC LIMIT ?1 OFFSET ?2`;
  const { results } = M_STATUSES.includes(status)
    ? await env.DB.prepare(sql).bind(status, PAGE_SIZE, offset).all()
    : await env.DB.prepare(sql).bind(PAGE_SIZE, offset).all();

  return json({ ok: true, total, byStatus, merchants: results || [] });
}

async function createMerchant(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const f = pickFields(body);
  if (!f.name || !M_CATEGORIES.includes(f.category)) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ((f.tier && !M_TIERS.includes(f.tier)) || (f.status && !M_STATUSES.includes(f.status))) {
    return json({ ok: false, error: 'invalid_fields' }, 400);
  }
  const r = await env.DB.prepare(
    `INSERT INTO merchants (name, category, tier, intro, detail, cover, address, phone, wechat, hours,
      contact_name, contact_phone, slug, status, reject_reason, paid_until, sort_weight)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`
  )
    .bind(
      f.name, f.category, f.tier || 'free', f.intro ?? '', f.detail || null, f.cover || null,
      f.address || null, f.phone || null, f.wechat || null, f.hours || null,
      f.contact_name || null, f.contact_phone || null, f.slug || null,
      f.status || 'pending', f.reject_reason || null, f.paid_until || null, f.sort_weight || 0
    )
    .run();
  const newId = r.meta.last_row_id;
  // 直接以已上线状态新建且未给 slug：补 m<id>，保证有公开详情页
  if (f.status === 'approved' && !f.slug) {
    await env.DB.prepare("UPDATE merchants SET slug = ?1 WHERE id = ?2").bind('m' + newId, newId).run();
  }
  return json({ ok: true, id: newId });
}

async function editMerchant(env, id, request) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const f = pickFields(body);
  if ('category' in f && !M_CATEGORIES.includes(f.category)) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('tier' in f && !M_TIERS.includes(f.tier)) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('status' in f && !M_STATUSES.includes(f.status)) return json({ ok: false, error: 'invalid_fields' }, 400);
  if (f.status === 'rejected' && !f.reject_reason) return json({ ok: false, error: 'reject_reason_required' }, 400);

  // 审核通过且还没有 slug：自动生成 m<id>
  if (f.status === 'approved' && !f.slug) {
    const row = await env.DB.prepare('SELECT slug FROM merchants WHERE id = ?1').bind(id).first();
    if (!row) return json({ ok: false, error: 'not_found' }, 404);
    if (!row.slug) f.slug = 'm' + id;
  }

  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(f)) {
    sets.push(`${k} = ?${vals.length + 1}`);
    vals.push(v);
  }
  if (!sets.length) return json({ ok: false, error: 'no_fields' }, 400);
  sets.push(`updated_at = datetime('now')`);
  const { meta } = await env.DB
    .prepare(`UPDATE merchants SET ${sets.join(', ')} WHERE id = ?${vals.length + 1}`)
    .bind(...vals, id)
    .run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);
  return json({ ok: true });
}

async function redeemMerchant(env, id, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const tier = String(body?.tier || '');
  if (!M_TIERS.includes(tier) || tier === 'free') return json({ ok: false, error: 'invalid_tier' }, 400);
  const { meta } = await env.DB.prepare(
    `UPDATE merchants SET tier = ?1, paid_until = date('now', '+1 year'),
      tier_request = NULL, paid_requested_at = NULL, updated_at = datetime('now')
     WHERE id = ?2`
  ).bind(tier, id).run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);
  return json({ ok: true });
}

async function removeMerchant(env, id) {
  // 级联删除门户账号，避免孤儿账号残留
  const [, { meta }] = await env.DB.batch([
    env.DB.prepare('DELETE FROM merchant_users WHERE merchant_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM merchants WHERE id = ?1').bind(id),
  ]);
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);

  // 级联清理 R2 图片：按 m<id>/ 前缀全删（覆盖换图留下的历史对象与文档页封面键；
  // admin 表单里的站内路径封面如 /assets/img/… 不在该前缀下，不受影响）。尽力而为，失败不回滚 D1
  if (env.IMG) {
    try {
      let cursor;
      do {
        const list = await env.IMG.list({ prefix: `m${id}/`, cursor });
        await Promise.all(list.objects.map((o) => env.IMG.delete(o.key)));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    } catch (err) {
      console.error(`R2 image cleanup failed for merchant ${id}:`, err);
    }
  }
  return json({ ok: true });
}

/* ---------------- 万载TV 视频管理（D1 videos，docs/万载TV方案.md） ---------------- */

const V_CATEGORIES = ['drama', 'fireworks', 'heritage', 'food', 'tourism', 'other'];
const V_SOURCES = ['bilibili', 'upload'];
const V_STATUSES = ['published', 'hidden'];
const BVID_RE = /^BV[0-9A-Za-z]{8,12}$/;
const MAX_VIDEO_BYTES = 95 * 1024 * 1024; // Cloudflare 免费版请求体上限 100MB，留余量
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const VIDEO_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm' };

async function listVideos(env, request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

  const counts = await env.DB.prepare('SELECT status, COUNT(*) n FROM videos GROUP BY status').all();
  const byStatus = {};
  let total = 0;
  (counts.results || []).forEach((r) => { byStatus[r.status] = r.n; total += r.n; });

  const sql = V_STATUSES.includes(status)
    ? `SELECT * FROM videos WHERE status = ?1 ORDER BY id DESC LIMIT ?2 OFFSET ?3`
    : `SELECT * FROM videos ORDER BY id DESC LIMIT ?1 OFFSET ?2`;
  const { results } = V_STATUSES.includes(status)
    ? await env.DB.prepare(sql).bind(status, PAGE_SIZE, offset).all()
    : await env.DB.prepare(sql).bind(PAGE_SIZE, offset).all();

  return json({ ok: true, total, byStatus, storage: await mediaUsage(env), videos: results || [] });
}

// R2 已用容量（媒体桶全量求和：tv/ 视频 + book/ 文库插图封面共用一桶；5 分钟缓存）
let vStorageCache = { at: 0, bytes: 0 };
async function mediaUsage(env) {
  if (!env.MEDIA) return null;
  if (Date.now() - vStorageCache.at < 5 * 60 * 1000) return vStorageCache.bytes;
  let bytes = 0;
  let cursor;
  try {
    do {
      const list = await env.MEDIA.list({ cursor });
      list.objects.forEach((o) => { bytes += o.size; });
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  } catch (err) {
    console.error('media usage failed:', err);
    return vStorageCache.at ? vStorageCache.bytes : null;
  }
  vStorageCache = { at: Date.now(), bytes };
  return bytes;
}

/** 新建（id 为空）或部分更新；换文件/封面时级联删旧 R2 对象 */
async function saveVideo(env, request, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);

  // 剧集总封面（video_series 表，剧名非空时生效；不进 videos 字段集）
  const seriesCover = String(body.series_cover ?? '').trim().slice(0, 300) || null;

  // 文本字段白名单（空串按 NULL 存）；数字字段单独整理
  const f = {};
  for (const [k, max] of Object.entries({
    title: 80, category: 20, source: 10, bvid: 20, file_key: 300,
    cover: 300, series: 60, intro: 600, status: 10,
  })) {
    if (!(k in body)) continue;
    const v = String(body[k] ?? '').trim().slice(0, max);
    f[k] = ['bvid', 'file_key', 'cover', 'series', 'intro'].includes(k) && v === '' ? null : v;
  }
  for (const k of ['duration', 'episode', 'featured']) {
    if (!(k in body)) continue;
    f[k] = Math.max(0, Math.min(k === 'duration' ? 86400 : 9999, Math.round(Number(body[k]) || 0)));
  }
  if (f.featured) f.featured = 1;
  if (f.episode === 0) f.episode = null; // 0 视为未填

  if ('title' in f && !f.title) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('category' in f && !V_CATEGORIES.includes(f.category)) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('source' in f && !V_SOURCES.includes(f.source)) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('status' in f && !V_STATUSES.includes(f.status)) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('bvid' in f && f.bvid && !BVID_RE.test(f.bvid)) return json({ ok: false, error: 'bad_bvid' }, 400);

  // 新建：标题 + 来源数据齐备，B站 BV 号防重复
  if (!id) {
    if (!f.title || !V_SOURCES.includes(f.source)) return json({ ok: false, error: 'invalid_fields' }, 400);
    if (f.source === 'bilibili' && !f.bvid) return json({ ok: false, error: 'bvid_required' }, 400);
    if (f.source === 'upload' && !f.file_key) return json({ ok: false, error: 'file_required' }, 400);
    if (f.source === 'bilibili') {
      const dup = await env.DB.prepare('SELECT id FROM videos WHERE bvid = ?1').bind(f.bvid).first();
      if (dup) return json({ ok: false, error: 'dup_bvid' }, 409);
    }
    const r = await env.DB.prepare(
      `INSERT INTO videos (title, category, source, bvid, file_key, cover, duration, series, episode, intro, featured, status)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
    )
      .bind(
        f.title, f.category || 'other', f.source, f.bvid || null, f.file_key || null, f.cover || null,
        f.duration || 0, f.series || null, f.episode || null, f.intro || null, f.featured || 0, f.status || 'published'
      )
      .run();
    await upsertSeriesCover(env, f.series, seriesCover);
    return json({ ok: true, id: r.meta.last_row_id });
  }

  // 编辑：部分更新
  const old = await env.DB.prepare('SELECT * FROM videos WHERE id = ?1').bind(id).first();
  if (!old) return json({ ok: false, error: 'not_found' }, 404);
  if ('source' in f && f.source === 'bilibili' && !(f.bvid ?? old.bvid)) {
    return json({ ok: false, error: 'bvid_required' }, 400);
  }
  if ('source' in f && f.source === 'upload' && !(f.file_key ?? old.file_key)) {
    return json({ ok: false, error: 'file_required' }, 400);
  }
  if ('bvid' in f && (f.bvid ?? old.bvid)) {
    const dup = await env.DB.prepare('SELECT id FROM videos WHERE bvid = ?1 AND id != ?2')
      .bind(f.bvid ?? old.bvid, id).first();
    if (dup) return json({ ok: false, error: 'dup_bvid' }, 409);
  }

  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(f)) {
    sets.push(`${k} = ?${vals.length + 1}`);
    vals.push(v);
  }
  if (!sets.length) return json({ ok: false, error: 'no_fields' }, 400);
  sets.push(`updated_at = datetime('now')`);
  await env.DB.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?${vals.length + 1}`).bind(...vals, id).run();

  // R2 旧对象清理：仅在换 key 时删（/ 开头是站内路径，不归 R2 管）
  const r2Key = (k) => k && !k.startsWith('/');
  const newFile = 'file_key' in f ? f.file_key : old.file_key;
  if (r2Key(old.file_key) && old.file_key !== newFile) {
    try { await env.MEDIA.delete(old.file_key); } catch (err) { console.error('old video cleanup failed:', err); }
  }
  const newCover = 'cover' in f ? f.cover : old.cover;
  if (r2Key(old.cover) && old.cover !== newCover) {
    try { await env.MEDIA.delete(old.cover); } catch (err) { console.error('old cover cleanup failed:', err); }
  }
  if (seriesCover) await upsertSeriesCover(env, f.series ?? old.series, seriesCover);
  return json({ ok: true });
}

/** 剧集总封面 upsert（video_series.name 与 videos.series 对应） */
async function upsertSeriesCover(env, name, cover) {
  if (!name || !cover) return;
  await env.DB.prepare(
    `INSERT INTO video_series (name, cover) VALUES (?1, ?2)
     ON CONFLICT(name) DO UPDATE SET cover = ?2, updated_at = datetime('now')`
  ).bind(name, cover).run();
}

async function removeVideo(env, id) {
  const old = await env.DB.prepare('SELECT file_key, cover FROM videos WHERE id = ?1').bind(id).first();
  const { meta } = await env.DB.prepare('DELETE FROM videos WHERE id = ?1').bind(id).run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);
  // 级联清理 R2 视频/封面：尽力而为，失败不回滚 D1
  if (env.MEDIA && old) {
    for (const k of [old.file_key, old.cover]) {
      if (k && !k.startsWith('/')) {
        try { await env.MEDIA.delete(k); } catch (err) { console.error(`R2 cleanup failed for ${k}:`, err); }
      }
    }
  }
  return json({ ok: true });
}

/** 视频流式上传：File 直作 PUT body（content-length 已知）→ request.body 流式转发 R2，不整读进内存 */
async function uploadVideoFile(env, request) {
  if (!env.MEDIA) return json({ ok: false, error: 'storage_missing' }, 500);
  const ext = (new URL(request.url).searchParams.get('ext') || '').toLowerCase();
  if (!VIDEO_TYPES[ext]) return json({ ok: false, error: 'bad_ext' }, 400);
  const len = Number(request.headers.get('content-length') || 0);
  if (!len) return json({ ok: false, error: 'empty_file' }, 400);
  if (len > MAX_VIDEO_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  const key = `tv/v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  try {
    await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: VIDEO_TYPES[ext] } });
  } catch (err) {
    console.error('video upload failed:', err);
    return json({ ok: false, error: 'upload_failed' }, 500);
  }
  return json({ ok: true, key });
}

/** 从B站拉取视频信息：view API 取标题/简介/时长，封面转存 R2（键 tv/c-bili-<bvid>.<ext>，重抓覆盖幂等） */
const BILI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchBili(env, request) {
  const body = await request.json().catch(() => null);
  const bvid = String(body?.bvid || '').trim();
  if (!BVID_RE.test(bvid)) return json({ ok: false, error: 'bad_bvid' }, 400); // BV 号大小写敏感，不归一化
  let data = null;
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, {
      headers: { 'user-agent': BILI_UA, referer: 'https://www.bilibili.com/' },
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d && d.code === 0 && d.data) data = d.data;
  } catch { /* 网络/B站风控失败走下方统一报错 */ }
  if (!data) return json({ ok: false, error: 'bili_api_failed' }, 502);
  const { title, desc, duration, pic } = data;

  // 封面转存 R2（best-effort：失败不阻塞，返回项 cover 为 null 时前端提示手传）
  let cover = null;
  if (pic && env.MEDIA) {
    try {
      const img = await fetch(pic.replace(/^http:/, 'https:'), { headers: { 'user-agent': BILI_UA } });
      const buf = img.ok ? new Uint8Array(await img.arrayBuffer()) : null;
      if (buf && buf.length && buf.length <= 10 * 1024 * 1024) {
        const ct = (img.headers.get('content-type') || 'image/jpeg').split(';')[0];
        const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
        const key = `tv/c-bili-${bvid}.${ext}`;
        await env.MEDIA.put(key, buf, { httpMetadata: { contentType: ct } });
        cover = key;
      }
    } catch (err) {
      console.error('bili cover fetch failed:', err);
    }
  }
  return json({
    ok: true,
    title: String(title || '').slice(0, 80),
    intro: String(desc || '').slice(0, 600),
    duration: Math.max(0, Math.round(Number(duration) || 0)),
    cover,
  });
}

/** 封面上传：≤5MB，魔数校验 JPG/PNG/WebP（与商户门户 readImage 同款） */
async function uploadVideoCover(env, request) {
  if (!env.MEDIA) return json({ ok: false, error: 'storage_missing' }, 500);
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length || buf.length > MAX_COVER_BYTES) return json({ ok: false, error: 'bad_cover' }, 400);
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  const ext = isJpeg ? 'jpg' : isPng ? 'png' : isWebp ? 'webp' : null;
  if (!ext) return json({ ok: false, error: 'bad_cover' }, 400);
  const key = `tv/c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  try {
    await env.MEDIA.put(key, buf, { httpMetadata: { contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}` } });
  } catch (err) {
    console.error('cover upload failed:', err);
    return json({ ok: false, error: 'upload_failed' }, 500);
  }
  return json({ ok: true, key });
}

/* ---------------- 文库管理（D1 books/book_chapters，docs/文库方案.md） ---------------- */

const B_CATEGORIES = ['novel', 'story', 'essay', 'other'];
const B_STATUSES = ['pending', 'approved', 'rejected', 'hidden'];
const CH_STATUSES = ['pending', 'approved', 'rejected'];

async function listBooks(env, request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

  const counts = await env.DB.prepare('SELECT status, COUNT(*) n FROM books GROUP BY status').all();
  const byStatus = {};
  let total = 0;
  (counts.results || []).forEach((r) => { byStatus[r.status] = r.n; total += r.n; });

  const sql = B_STATUSES.includes(status)
    ? `SELECT b.*, (SELECT COUNT(*) FROM book_chapters c WHERE c.book_id = b.id AND c.status = 'pending') AS pending_ch
       FROM books b WHERE b.status = ?1 ORDER BY b.id DESC LIMIT ?2 OFFSET ?3`
    : `SELECT b.*, (SELECT COUNT(*) FROM book_chapters c WHERE c.book_id = b.id AND c.status = 'pending') AS pending_ch
       FROM books b ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END, b.id DESC LIMIT ?1 OFFSET ?2`;
  const { results } = B_STATUSES.includes(status)
    ? await env.DB.prepare(sql).bind(status, PAGE_SIZE, offset).all()
    : await env.DB.prepare(sql).bind(PAGE_SIZE, offset).all();

  return json({ ok: true, total, byStatus, storage: await mediaUsage(env), books: results || [] });
}

/** admin 直建作品：默认 approved 免审（slug 自动生成）；封面可用站内路径或 R2 键后补 */
async function createBook(env, request) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const f = {
    title: String(body.title ?? '').trim().slice(0, 80),
    category: String(body.category ?? '').trim().slice(0, 20),
    author_name: String(body.author_name ?? '').trim().slice(0, 40) || null,
    intro: String(body.intro ?? '').trim().slice(0, 500),
    cover: String(body.cover ?? '').trim().slice(0, 300) || null,
    status: String(body.status ?? 'approved').trim(),
  };
  if (!f.title || !f.intro || !B_CATEGORIES.includes(f.category) || !B_STATUSES.includes(f.status)) {
    return json({ ok: false, error: 'invalid_fields' }, 400);
  }
  const r = await env.DB.prepare(
    `INSERT INTO books (title, category, intro, author_name, cover, status)
     VALUES (?1,?2,?3,?4,?5,?6)`
  ).bind(f.title, f.category, f.intro, f.author_name, f.cover, f.status).run();
  const id = r.meta.last_row_id;
  if (f.status === 'approved') {
    await env.DB.prepare('UPDATE books SET slug = ?1 WHERE id = ?2').bind('b' + id, id).run();
  }
  return json({ ok: true, id });
}

/** 部分更新：审核（status/reject_reason）与元数据（title/category/author_name/intro/sort_weight）共用 */
async function updateBook(env, id, request) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);

  const f = {};
  for (const k of ['title', 'category', 'author_name', 'intro', 'status', 'reject_reason']) {
    if (!(k in body)) continue;
    f[k] = String(body[k] ?? '').trim().slice(0, k === 'intro' ? 500 : 200) || null;
  }
  // 封面：站内路径（/…）或 R2 键（book/…），空串即清除（此前漏在白名单外导致后台无法改封面）
  if ('cover' in body) f.cover = String(body.cover ?? '').trim().slice(0, 300) || null;
  if ('sort_weight' in body) f.sort_weight = Math.max(0, Math.min(999, Math.round(Number(body.sort_weight) || 0)));
  if ('title' in f && !f.title) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('category' in f && f.category && !B_CATEGORIES.includes(f.category)) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('status' in f && f.status && !B_STATUSES.includes(f.status)) return json({ ok: false, error: 'invalid_fields' }, 400);
  if (f.status === 'rejected' && !f.reject_reason) return json({ ok: false, error: 'reject_reason_required' }, 400);
  if (f.reject_reason === null) delete f.reject_reason; // 只传空串不清原因

  const old = await env.DB.prepare('SELECT id, slug, cover FROM books WHERE id = ?1').bind(id).first();
  if (!old) return json({ ok: false, error: 'not_found' }, 404);

  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(f)) {
    sets.push(`${k} = ?${vals.length + 1}`);
    vals.push(v);
  }
  if (!sets.length) return json({ ok: false, error: 'no_fields' }, 400);
  sets.push(`updated_at = datetime('now')`);
  await env.DB.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?${vals.length + 1}`).bind(...vals, id).run();

  // 上线且无 slug：补 b<id>（元数据重审通过后 slug 保留）
  if ((f.status === 'approved' || !('status' in f)) && !old.slug) {
    await env.DB.prepare('UPDATE books SET slug = ?1 WHERE id = ?2').bind('b' + id, id).run();
  }
  // 换了封面且旧封面是 R2 键：旧对象清理（站内路径 /… 非本桶对象，跳过）
  if ('cover' in f && f.cover !== old.cover && old.cover && !old.cover.startsWith('/') && env.MEDIA) {
    try { await env.MEDIA.delete(old.cover); } catch (err) { console.error(`old cover cleanup failed for ${old.cover}:`, err); }
  }
  return json({ ok: true });
}

/** 删除作品：章节行 + 章节插图 + 封面级联；R2 清理尽力而为 */
async function removeBook(env, id) {
  const book = await env.DB.prepare('SELECT id, cover FROM books WHERE id = ?1').bind(id).first();
  const { meta } = await env.DB.prepare('DELETE FROM books WHERE id = ?1').bind(id).run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);
  await env.DB.prepare('DELETE FROM book_chapters WHERE book_id = ?1').bind(id).run();

  if (env.MEDIA) {
    const keys = [];
    try {
      const rows = await env.DB.prepare('SELECT images FROM book_chapters WHERE book_id = ?1').bind(id).all();
      // 上面的 DELETE 已执行；此处查询仅为兼容旧数据兜底（正常返回空）
      for (const row of rows.results || []) keys.push(...safeImages2(row.images));
    } catch { /* 表已清空时忽略 */ }
    if (book?.cover && !book.cover.startsWith('/')) keys.push(book.cover);
    for (const k of keys) {
      try { await env.MEDIA.delete(k); } catch (err) { console.error(`R2 cleanup failed for ${k}:`, err); }
    }
    try {
      let cursor;
      do {
        const list = await env.MEDIA.list({ prefix: `book/b${id}/`, cursor });
        await Promise.all(list.objects.map((o) => env.MEDIA.delete(o.key)));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
    } catch (err) {
      console.error(`R2 prefix cleanup failed for book ${id}:`, err);
    }
  }
  return json({ ok: true });
}

function safeImages2(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 章节列表（含正文，供后台「先读后审」） */
async function listBookChapters(env, bookId) {
  const { results } = await env.DB.prepare(
    'SELECT id, idx, title, body, images, status, reject_reason, word_count, updated_at FROM book_chapters WHERE book_id = ?1 ORDER BY idx'
  ).bind(bookId).all();
  return json({ ok: true, chapters: results || [] });
}

/** 章节审核：通过（读者可见）或驳回（原因回传作者作品台） */
async function reviewChapter(env, bookId, cid, request) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const status = String(body.status ?? '');
  if (!CH_STATUSES.includes(status)) return json({ ok: false, error: 'invalid_fields' }, 400);
  const reason = status === 'rejected'
    ? (String(body.reject_reason ?? '').trim().slice(0, 200) || null)
    : null;
  if (status === 'rejected' && !reason) return json({ ok: false, error: 'reject_reason_required' }, 400);

  const { meta } = await env.DB.prepare(
    `UPDATE book_chapters SET status = ?1, reject_reason = ?2, updated_at = datetime('now')
     WHERE id = ?3 AND book_id = ?4`
  ).bind(status, reason, cid, bookId).run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);
  await env.DB.prepare(`UPDATE books SET updated_at = datetime('now') WHERE id = ?1`).bind(bookId).run();
  return json({ ok: true });
}

/** 重算作品冗余计数（草稿章不计入——与作者端口径一致，读者可见内容才算数） */
async function recountBook(env, bookId, touch = true) {
  await env.DB.prepare(
    `UPDATE books SET
       chapter_count = (SELECT COUNT(*) FROM book_chapters WHERE book_id = ?1 AND status != 'draft'),
       word_count = (SELECT COALESCE(SUM(word_count), 0) FROM book_chapters WHERE book_id = ?1 AND status != 'draft')
       ${touch ? ", updated_at = datetime('now')" : ''}
     WHERE id = ?1`
  ).bind(bookId).run();
}

/** admin 直改章节（部分更新：idx/title/body/remove_image）；不改变审核状态，已上线章即时生效 */
async function editChapter(env, bookId, cid, request) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const ch = await env.DB.prepare('SELECT * FROM book_chapters WHERE id = ?1 AND book_id = ?2')
    .bind(cid, bookId).first();
  if (!ch) return json({ ok: false, error: 'not_found' }, 404);

  const f = {};
  if ('title' in body) {
    f.title = String(body.title ?? '').trim().slice(0, 100);
    if (!f.title) return json({ ok: false, error: 'invalid_fields' }, 400);
  }
  if ('body' in body) {
    f.body = String(body.body ?? '').replace(/\r\n/g, '\n').slice(0, 30000);
    f.word_count = f.body.replace(/\[图\]/g, '').replace(/\s/g, '').length;
  }
  if ('idx' in body) {
    f.idx = Math.max(1, Math.min(500, Math.round(Number(body.idx) || 0)));
    const dup = await env.DB.prepare(
      'SELECT id FROM book_chapters WHERE book_id = ?1 AND idx = ?2 AND id != ?3'
    ).bind(bookId, f.idx, cid).first();
    if (dup) return json({ ok: false, error: 'dupidx' }, 400);
  }

  let images = null;
  let removedKey = null;
  if ('remove_image' in body) {
    removedKey = String(body.remove_image ?? '');
    images = safeImages2(ch.images);
    const at = images.indexOf(removedKey);
    if (at < 0) return json({ ok: false, error: 'invalid_fields' }, 400);
    images.splice(at, 1);
  }

  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(f)) {
    sets.push(`${k} = ?${vals.length + 1}`);
    vals.push(v);
  }
  if (images) {
    sets.push(`images = ?${vals.length + 1}`);
    vals.push(JSON.stringify(images));
  }
  if (!sets.length) return json({ ok: false, error: 'no_fields' }, 400);
  sets.push(`updated_at = datetime('now')`);
  await env.DB.prepare(`UPDATE book_chapters SET ${sets.join(', ')} WHERE id = ?${vals.length + 1}`).bind(...vals, cid).run();
  await recountBook(env, bookId);

  if (removedKey && env.MEDIA) {
    try { await env.MEDIA.delete(removedKey); } catch (err) { console.error(`R2 cleanup failed for ${removedKey}:`, err); }
  }
  return json({ ok: true });
}

/** 删除章节（admin）：级联插图 + 重算作品计数 */
async function removeChapter(env, bookId, cid) {
  const ch = await env.DB.prepare('SELECT id, images FROM book_chapters WHERE id = ?1 AND book_id = ?2')
    .bind(cid, bookId).first();
  const { meta } = await env.DB.prepare('DELETE FROM book_chapters WHERE id = ?1 AND book_id = ?2')
    .bind(cid, bookId).run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);

  if (env.MEDIA) {
    for (const k of safeImages2(ch?.images)) {
      try { await env.MEDIA.delete(k); } catch (err) { console.error(`R2 cleanup failed for ${k}:`, err); }
    }
  }
  await recountBook(env, bookId);
  return json({ ok: true });
}

/* ---------------- 万载音乐管理（D1 music_tracks，2026-09-06） ---------------- */

const MU_STATUSES = ['published', 'hidden'];
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

async function listTracks(env, request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

  const counts = await env.DB.prepare('SELECT status, COUNT(*) n FROM music_tracks GROUP BY status').all();
  const byStatus = {};
  let total = 0;
  (counts.results || []).forEach((r) => { byStatus[r.status] = r.n; total += r.n; });

  const sql = MU_STATUSES.includes(status)
    ? `SELECT * FROM music_tracks WHERE status = ?1 ORDER BY sort, id LIMIT ?2 OFFSET ?3`
    : `SELECT * FROM music_tracks ORDER BY sort, id LIMIT ?1 OFFSET ?2`;
  const { results } = MU_STATUSES.includes(status)
    ? await env.DB.prepare(sql).bind(status, PAGE_SIZE, offset).all()
    : await env.DB.prepare(sql).bind(PAGE_SIZE, offset).all();

  return json({ ok: true, total, byStatus, storage: await mediaUsage(env), tracks: results || [] });
}

/** 新建（id 为空）或部分更新；换音频/封面时级联删旧 R2 对象 */
async function saveTrack(env, request, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);

  const f = {};
  for (const [k, max] of Object.entries({
    title: 80, artist: 40, cover: 300, file_key: 300, status: 10,
  })) {
    if (!(k in body)) continue;
    const v = String(body[k] ?? '').trim().slice(0, max);
    f[k] = ['artist', 'cover', 'file_key'].includes(k) && v === '' ? null : v;
  }
  for (const k of ['duration', 'sort']) {
    if (!(k in body)) continue;
    f[k] = Math.max(0, Math.min(k === 'duration' ? 86400 : 999, Math.round(Number(body[k]) || 0)));
  }
  if ('title' in f && !f.title) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('status' in f && !MU_STATUSES.includes(f.status)) return json({ ok: false, error: 'invalid_fields' }, 400);

  // 新建：曲名 + 音频文件齐备
  if (!id) {
    if (!f.title || !f.file_key) return json({ ok: false, error: 'file_required' }, 400);
    const r = await env.DB.prepare(
      `INSERT INTO music_tracks (title, artist, cover, file_key, duration, sort, status)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`
    )
      .bind(f.title, f.artist || null, f.cover || null, f.file_key, f.duration || 0, f.sort || 0, f.status || 'published')
      .run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  // 编辑：部分更新
  const old = await env.DB.prepare('SELECT * FROM music_tracks WHERE id = ?1').bind(id).first();
  if (!old) return json({ ok: false, error: 'not_found' }, 404);
  if ('file_key' in f && !f.file_key) return json({ ok: false, error: 'file_required' }, 400);

  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(f)) {
    sets.push(`${k} = ?${vals.length + 1}`);
    vals.push(v);
  }
  if (!sets.length) return json({ ok: false, error: 'no_fields' }, 400);
  sets.push(`updated_at = datetime('now')`);
  await env.DB.prepare(`UPDATE music_tracks SET ${sets.join(', ')} WHERE id = ?${vals.length + 1}`).bind(...vals, id).run();

  // R2 旧对象清理：仅在换 key 时删（/ 开头是站内路径，不归 R2 管）
  const r2Key = (k) => k && !k.startsWith('/');
  const newFile = 'file_key' in f ? f.file_key : old.file_key;
  if (r2Key(old.file_key) && old.file_key !== newFile) {
    try { await env.MEDIA.delete(old.file_key); } catch (err) { console.error('old audio cleanup failed:', err); }
  }
  const newCover = 'cover' in f ? f.cover : old.cover;
  if (r2Key(old.cover) && old.cover !== newCover) {
    try { await env.MEDIA.delete(old.cover); } catch (err) { console.error('old cover cleanup failed:', err); }
  }
  return json({ ok: true });
}

async function removeTrack(env, id) {
  const old = await env.DB.prepare('SELECT file_key, cover FROM music_tracks WHERE id = ?1').bind(id).first();
  const { meta } = await env.DB.prepare('DELETE FROM music_tracks WHERE id = ?1').bind(id).run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);
  if (env.MEDIA && old) {
    for (const k of [old.file_key, old.cover]) {
      if (k && !k.startsWith('/')) {
        try { await env.MEDIA.delete(k); } catch (err) { console.error(`R2 cleanup failed for ${k}:`, err); }
      }
    }
  }
  return json({ ok: true });
}

/** MP3 流式上传：File 直作 PUT body → request.body 转发 R2（≤50MB，魔数校验 ID3/MPEG 帧头） */
async function uploadTrackFile(env, request) {
  if (!env.MEDIA) return json({ ok: false, error: 'storage_missing' }, 500);
  const len = Number(request.headers.get('content-length') || 0);
  if (!len) return json({ ok: false, error: 'empty_file' }, 400);
  if (len > MAX_AUDIO_BYTES) return json({ ok: false, error: 'too_large' }, 413);
  if (!request.body) return json({ ok: false, error: 'empty_file' }, 400);

  // 魔数校验只读首个 chunk，随后把已读部分接回流式转发（不整读内存）
  const reader = request.body.getReader();
  const first = await reader.read().catch(() => ({}));
  const head = first.value;
  const isId3 = head && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
  const isMpeg = head && head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
  if (!isId3 && !isMpeg) {
    try { await reader.cancel(); } catch { /* 已结束则忽略 */ }
    return json({ ok: false, error: 'bad_audio' }, 400);
  }
  const body = new FixedLengthStream(len);
  const writer = body.writable.getWriter();
  (async () => {
    try {
      await writer.write(head);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
    }
  })();

  const key = `music/a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.mp3`;
  try {
    await env.MEDIA.put(key, body.readable, { httpMetadata: { contentType: 'audio/mpeg' } });
  } catch (err) {
    console.error('audio upload failed:', err);
    return json({ ok: false, error: 'upload_failed' }, 500);
  }
  return json({ ok: true, key });
}

/** 图片上传（共用）：≤5MB，魔数校验 JPG/PNG/WebP，存入指定前缀
 *  （music/c-* / attra/c-* 走 MEDIA 媒体桶；商户 m<id>/ 走 IMG 商户图桶，与门户同桶） */
async function uploadImageR2(env, request, prefix, bucket) {
  const store = bucket || env.MEDIA;
  if (!store) return json({ ok: false, error: 'storage_missing' }, 500);
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length || buf.length > MAX_COVER_BYTES) return json({ ok: false, error: 'bad_cover' }, 400);
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  const ext = isJpeg ? 'jpg' : isPng ? 'png' : isWebp ? 'webp' : null;
  if (!ext) return json({ ok: false, error: 'bad_cover' }, 400);
  const key = `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  try {
    await store.put(key, buf, { httpMetadata: { contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}` } });
  } catch (err) {
    console.error('image upload failed:', err);
    return json({ ok: false, error: 'upload_failed' }, 500);
  }
  return json({ ok: true, key });
}

/* ---------------- 旅游景点管理（D1 attractions，2026-09-06） ---------------- */

const A_STATUSES = ['published', 'hidden'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

async function listAttractions(env, request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

  const counts = await env.DB.prepare('SELECT status, COUNT(*) n FROM attractions GROUP BY status').all();
  const byStatus = {};
  let total = 0;
  (counts.results || []).forEach((r) => { byStatus[r.status] = r.n; total += r.n; });

  const sql = A_STATUSES.includes(status)
    ? `SELECT * FROM attractions WHERE status = ?1 ORDER BY sort, id DESC LIMIT ?2 OFFSET ?3`
    : `SELECT * FROM attractions ORDER BY sort, id DESC LIMIT ?1 OFFSET ?2`;
  const { results } = A_STATUSES.includes(status)
    ? await env.DB.prepare(sql).bind(status, PAGE_SIZE, offset).all()
    : await env.DB.prepare(sql).bind(PAGE_SIZE, offset).all();

  return json({ ok: true, total, byStatus, storage: await mediaUsage(env), attractions: results || [] });
}

/** 新建（id 为空）或部分更新；slug 唯一；换封面时级联删旧 R2 对象 */
async function saveAttraction(env, request, id) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);

  const f = {};
  for (const [k, max] of Object.entries({
    name: 60, slug: 60, summary: 200, tags: 60, cover: 300,
    body: 8000, address: 100, hours: 60, tickets: 60, transport: 100, status: 10,
  })) {
    if (!(k in body)) continue;
    const v = String(body[k] ?? '').trim().slice(0, max);
    f[k] = ['tags', 'cover', 'body', 'address', 'hours', 'tickets', 'transport'].includes(k) && v === '' ? null : v;
  }
  if ('sort' in body) f.sort = Math.max(0, Math.min(999, Math.round(Number(body.sort) || 0)));
  if ('name' in f && !f.name) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('summary' in f && !f.summary) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('status' in f && !A_STATUSES.includes(f.status)) return json({ ok: false, error: 'invalid_fields' }, 400);
  if ('slug' in f && f.slug && !SLUG_RE.test(f.slug)) return json({ ok: false, error: 'bad_slug' }, 400);

  if (!id) {
    if (!f.name || !f.summary) return json({ ok: false, error: 'invalid_fields' }, 400);
    if (!f.slug) return json({ ok: false, error: 'slug_required' }, 400);
    const dup = await env.DB.prepare('SELECT id FROM attractions WHERE slug = ?1').bind(f.slug).first();
    if (dup) return json({ ok: false, error: 'dup_slug' }, 409);
    const r = await env.DB.prepare(
      `INSERT INTO attractions (slug, name, summary, tags, cover, body, address, hours, tickets, transport, sort, status)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
    )
      .bind(
        f.slug, f.name, f.summary, f.tags || null, f.cover || null, f.body || null,
        f.address || null, f.hours || null, f.tickets || null, f.transport || null,
        f.sort || 0, f.status || 'published'
      )
      .run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  const old = await env.DB.prepare('SELECT * FROM attractions WHERE id = ?1').bind(id).first();
  if (!old) return json({ ok: false, error: 'not_found' }, 404);
  if ('slug' in f) {
    const slug = f.slug ?? old.slug;
    if (!slug || !SLUG_RE.test(slug)) return json({ ok: false, error: 'bad_slug' }, 400);
    const dup = await env.DB.prepare('SELECT id FROM attractions WHERE slug = ?1 AND id != ?2')
      .bind(slug, id).first();
    if (dup) return json({ ok: false, error: 'dup_slug' }, 409);
  }

  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(f)) {
    sets.push(`${k} = ?${vals.length + 1}`);
    vals.push(v);
  }
  if (!sets.length) return json({ ok: false, error: 'no_fields' }, 400);
  sets.push(`updated_at = datetime('now')`);
  await env.DB.prepare(`UPDATE attractions SET ${sets.join(', ')} WHERE id = ?${vals.length + 1}`).bind(...vals, id).run();

  const newCover = 'cover' in f ? f.cover : old.cover;
  if (old.cover && !old.cover.startsWith('/') && old.cover !== newCover) {
    try { await env.MEDIA.delete(old.cover); } catch (err) { console.error('old cover cleanup failed:', err); }
  }
  return json({ ok: true });
}

async function removeAttraction(env, id) {
  const old = await env.DB.prepare('SELECT cover FROM attractions WHERE id = ?1').bind(id).first();
  const { meta } = await env.DB.prepare('DELETE FROM attractions WHERE id = ?1').bind(id).run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);
  if (env.MEDIA && old?.cover && !old.cover.startsWith('/')) {
    try { await env.MEDIA.delete(old.cover); } catch (err) { console.error(`R2 cleanup failed for ${old.cover}:`, err); }
  }
  return json({ ok: true });
}

/* ---------------- AI 助手「花傩」管理（docs/AI助手方案.md） ---------------- */

// 与主站 worker/ai.js MODEL_ALLOW 对应的白名单（改这里需同步主站）
// 2026-09 实测淘汰两个：DeepSeek-V4-Flash Free 套餐 403、GLM-4.7-Flash 单答 15~30s 会撞 30s 超时
const AI_MODEL_OPTIONS = [
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', label: 'Qwen3-30B-A3B（默认 · 快/省）' },
  { id: '@cf/qwen/qwen3.8-27b', label: 'Qwen3.8-27B（旗舰）' },
];

async function getAiSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM ai_settings').all();
  const map = {};
  for (const r of results || []) map[r.key] = r.value;
  return json({ ok: true, settings: map, models: AI_MODEL_OPTIONS });
}

async function saveAiSettings(env, request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'invalid_json' }, 400);
  const patch = {
    enabled: body.enabled === '0' || body.enabled === false ? '0' : '1',
    model: AI_MODEL_OPTIONS.some((x) => x.id === body.model) ? body.model : AI_MODEL_OPTIONS[0].id,
    system_prompt: String(body.system_prompt ?? '').slice(0, 4000),
    greeting: String(body.greeting ?? '').trim().slice(0, 100),
    quick_questions: JSON.stringify(
      (Array.isArray(body.quick) ? body.quick : [])
        .map((q) => String(q).trim().slice(0, 60)).filter(Boolean).slice(0, 6)
    ),
  };
  for (const [key, value] of Object.entries(patch)) {
    await env.DB.prepare(
      `INSERT INTO ai_settings (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(key, value).run();
  }
  return json({ ok: true });
}

async function listKnowledge(env, request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || '';
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const where = status ? `WHERE status='${status === 'hidden' ? 'hidden' : 'published'}'` : '';
  const { results } = await env.DB.prepare(
    `SELECT id, category, content, keywords, sort, status, updated_at FROM ai_knowledge ${where}
     ORDER BY category, sort, id LIMIT ${PAGE_SIZE} OFFSET ${offset}`
  ).all();
  const { total } = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ai_knowledge ${where}`).first();
  const byStatus = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM ai_knowledge GROUP BY status`
  ).all();
  const counts = {};
  for (const r of byStatus.results || []) counts[r.status] = r.n;
  return json({ ok: true, total, knowledge: results || [], byStatus: counts });
}

async function saveKnowledge(env, request, id = null) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);

  // 部分更新语义：上下线切换只带 status，表单保存带全量
  const patch = {};
  if (body.category !== undefined) {
    patch.category = String(body.category).trim().slice(0, 30);
    if (!patch.category) return json({ ok: false, error: 'invalid_fields' }, 400);
  }
  if (body.content !== undefined) {
    patch.content = String(body.content).trim().slice(0, 2000);
    if (!patch.content) return json({ ok: false, error: 'invalid_fields' }, 400);
  }
  if (body.keywords !== undefined) patch.keywords = String(body.keywords).trim().slice(0, 200);
  if (body.sort !== undefined) patch.sort = Math.max(0, Math.min(9999, Number(body.sort) || 0));
  if (body.status !== undefined) patch.status = body.status === 'hidden' ? 'hidden' : 'published';

  if (id === null) {
    if (!patch.category || !patch.content) return json({ ok: false, error: 'invalid_fields' }, 400);
    const { meta } = await env.DB.prepare(
      'INSERT INTO ai_knowledge (category, content, keywords, sort, status) VALUES (?1, ?2, ?3, ?4, ?5)'
    ).bind(patch.category, patch.content, patch.keywords || '', patch.sort || 0, patch.status || 'published').run();
    await maintainKnowledgeVector(env, meta.last_row_id);
  } else {
    const keys = Object.keys(patch);
    if (!keys.length) return json({ ok: false, error: 'invalid_fields' }, 400);
    const sets = keys.map((k, i) => `${k} = ?${i + 1}`).join(', ');
    await env.DB.prepare(
      `UPDATE ai_knowledge SET ${sets}, updated_at = datetime('now') WHERE id = ?${keys.length + 1}`
    ).bind(...keys.map((k) => patch[k]), id).run();
    await maintainKnowledgeVector(env, id);
  }
  return json({ ok: true });
}

/**
 * 知识向量即时维护（检索 v2）：published 重嵌入上架 / 非 published 下架；
 * 失败置 ai_settings.vec_dirty 脏标记，主站问答时懒同步兜底全量重建。
 * 本地 dev 的 AI binding 出站挂起 → 8s 超时后落脏标记，保存不受影响。
 */
const K_EMBED_MODEL = '@cf/qwen/qwen3-embedding-0.6b';

async function maintainKnowledgeVector(env, rowId) {
  try {
    if (!env.VEC || !env.AI) return;
    const row = await env.DB.prepare(
      'SELECT id, category, content, status FROM ai_knowledge WHERE id = ?1'
    ).bind(rowId).first();
    const vid = 'k' + rowId;
    if (!row || row.status !== 'published') {
      await env.VEC.deleteByIds([vid]);
      return;
    }
    const text = `${row.category}\n${row.content}`.slice(0, 400);
    const emb = await Promise.race([
      env.AI.run(K_EMBED_MODEL, { text: [text] }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    const values = emb?.data?.[0];
    if (!values) throw new Error('embedding shape unexpected');
    await env.VEC.upsert([{ id: vid, values, metadata: { status: 'published', kid: row.id } }]);
  } catch (err) {
    console.error('knowledge vector maintain failed:', err);
    try {
      await env.DB.prepare(
        `INSERT INTO ai_settings (key, value) VALUES ('vec_dirty','1')
         ON CONFLICT(key) DO UPDATE SET value='1', updated_at=datetime('now')`
      ).run();
    } catch { /* 连标记都失败则靠计数漂移触发全量同步 */ }
  }
}

async function removeKnowledge(env, id) {
  const { meta } = await env.DB.prepare('DELETE FROM ai_knowledge WHERE id = ?1').bind(id).run();
  if (!meta.changes) return json({ ok: false, error: 'not_found' }, 404);
  // 向量下架（删行后主站计数漂移也会触发全量同步，这里先即时清，防幽灵向量被检索）
  try {
    if (env.VEC) await env.VEC.deleteByIds(['k' + id]);
  } catch (err) {
    console.error('knowledge vector delete failed:', err);
    try {
      await env.DB.prepare(
        `INSERT INTO ai_settings (key, value) VALUES ('vec_dirty','1')
         ON CONFLICT(key) DO UPDATE SET value='1', updated_at=datetime('now')`
      ).run();
    } catch { /* ignore */ }
  }
  return json({ ok: true });
}

async function aiStats(env) {
  const { today } = await env.DB.prepare(
    `SELECT COUNT(*) AS today FROM ai_chats WHERE created_at >= datetime('now', 'start of day')`
  ).first();
  const { d7 } = await env.DB.prepare(
    `SELECT COUNT(*) AS d7 FROM ai_chats WHERE created_at >= datetime('now', '-7 days')`
  ).first();
  const { d30 } = await env.DB.prepare(
    `SELECT COUNT(*) AS d30 FROM ai_chats WHERE created_at >= datetime('now', '-30 days')`
  ).first();
  const { total } = await env.DB.prepare('SELECT COUNT(*) AS total FROM ai_chats').first();
  const { results } = await env.DB.prepare(
    `SELECT question, action, sources, duration_ms, created_at FROM ai_chats ORDER BY id DESC LIMIT 20`
  ).all();
  // 知识缺口：7 天内有回答但既无知识来源也无 action 的问答（capped 降级/失败不记缺口）
  const { n7, miss7 } = await env.DB.prepare(
    `SELECT COUNT(*) AS n7,
            SUM(CASE WHEN sources IS NULL AND action IS NULL AND answer_len > 0 THEN 1 ELSE 0 END) AS miss7
     FROM ai_chats WHERE created_at >= datetime('now', '-7 days')`
  ).first();
  const { results: misses } = await env.DB.prepare(
    `SELECT question, created_at FROM ai_chats
     WHERE created_at >= datetime('now', '-7 days')
       AND sources IS NULL AND action IS NULL AND answer_len > 0
     ORDER BY id DESC LIMIT 20`
  ).all();
  return json({ ok: true, today, d7, d30, total, recent: results || [], n7, miss7, misses: misses || [] });
}

async function clearAiLog(env) {
  await env.DB.prepare('DELETE FROM ai_chats').run();
  return json({ ok: true });
}

/* ---------------- 工具 ---------------- */

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return toHex(sig);
}

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return toHex(digest);
}

// 与商户门户同款：PBKDF2-SHA256(10 万次)，运营账号密码不明文存储
async function pbkdf2Hex(password, saltHex) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt }, key, 256
  );
  return toHex(bits);
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/* ---------------- 页面 ---------------- */

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body {
    background: #f5f5f7; color: #1d1d1f; padding: 0 20px 60px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* 顶栏：对齐官网 .nav 的毛玻璃导航（logo 左 + 板块链接 + 官网入口/账号在右） */
  header.anav {
    position: sticky; top: 0; z-index: 100;
    background: rgba(251,251,253,.8);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    backdrop-filter: saturate(180%) blur(20px);
    border-bottom: 1px solid rgba(0,0,0,.08);
  }
  .anav-inner {
    max-width: 1060px; margin: 0 auto; padding: 0 22px; height: 48px;
    display: flex; align-items: center; gap: 24px;
  }
  .anav-logo {
    display: inline-flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 600;
    letter-spacing: .01em; white-space: nowrap; color: #1d1d1f; text-decoration: none;
  }
  .anav-logo img { width: 22px; height: 22px; display: block; }
  .anav-menu { display: flex; align-items: center; gap: 30px; margin-right: auto; }
  .anav-link {
    font-size: 12px; letter-spacing: .01em; color: rgba(29,29,31,.8);
    text-decoration: none; transition: color .2s;
  }
  .anav-link:hover { color: #1d1d1f; }
  .anav-link.active { color: #1d1d1f; font-weight: 600; }
  .anav-right { display: flex; align-items: center; gap: 12px; }
  /* 右上角账号菜单 */
  .acct { position: relative; }
  .acct-drop {
    position: absolute; right: 0; top: calc(100% + 10px); min-width: 180px; z-index: 120;
    background: #fff; border: 1px solid rgba(0,0,0,.06); border-radius: 14px;
    box-shadow: 0 8px 30px rgba(0,0,0,.12); padding: 8px;
  }
  .acct-drop button {
    display: block; width: 100%; text-align: left; padding: 9px 12px; font-size: 13px;
    background: none; border: 0; border-radius: 8px; color: #1d1d1f; cursor: pointer;
  }
  .acct-drop button:hover { background: #f5f5f7; color: #1d1d1f; }
  .acct-cur { padding: 8px 12px 6px; font-size: 12px; color: #6e6e73; white-space: nowrap; }
  .acct-cur b { color: #1d1d1f; }
  .acct-sep { height: 1px; background: rgba(0,0,0,.06); margin: 6px 4px; }
  /* 移动端汉堡 + 抽屉（与官网同款：抽屉放 header 外，避免毛玻璃的包含块问题） */
  .anav-burger {
    display: none; width: 40px; height: 40px; position: relative;
    background: none; border: 0; padding: 0; cursor: pointer;
  }
  .anav-burger-line {
    position: absolute; left: 10px; right: 10px; height: 1.5px; background: #1d1d1f;
    transition: transform .3s, top .3s;
  }
  .anav-burger-line:nth-child(1) { top: 16px; }
  .anav-burger-line:nth-child(2) { top: 23px; }
  .anav-burger[aria-expanded="true"] .anav-burger-line:nth-child(1) { top: 19.5px; transform: rotate(45deg); }
  .anav-burger[aria-expanded="true"] .anav-burger-line:nth-child(2) { top: 19.5px; transform: rotate(-45deg); }
  .anav-drawer { display: none; }
  @media (max-width: 900px) {
    .anav-menu { display: none; }
    .anav-burger { display: block; }
    .anav-drawer {
      display: block; position: fixed; inset: 48px 0 0 0; z-index: 90;
      background: rgba(251,251,253,.96);
      -webkit-backdrop-filter: saturate(180%) blur(20px);
      backdrop-filter: saturate(180%) blur(20px);
      opacity: 0; visibility: hidden; transform: translateY(-8px);
      transition: opacity .3s, transform .3s, visibility .3s;
    }
    .anav-drawer.open { opacity: 1; visibility: visible; transform: none; }
    .anav-drawer-list { padding: 24px 40px; list-style: none; }
    .anav-drawer-item { padding: 13px 0; border-bottom: 1px solid rgba(0,0,0,.08); }
    .anav-drawer-item .anav-link { font-size: 15px; }
  }
  button {
    padding: 7px 14px; font-size: 13px; color: #1d1d1f; background: #fff;
    border: 1px solid rgba(0,0,0,.12); border-radius: 980px; cursor: pointer;
    transition: all .2s cubic-bezier(.25,.1,.25,1);
  }
  button:hover { border-color: #d64524; color: #d64524; }
  button.primary { background: #d64524; border-color: #d64524; color: #fff; }
  button.primary:hover { background: #b5371a; color: #fff; }
  .tab { color: #6e6e73; background: transparent; border-color: transparent; }
  .tab.active { color: #1d1d1f; background: #fff; border-color: rgba(0,0,0,.12); font-weight: 600; }
  .panel {
    max-width: 1060px; margin: 18px auto 0; background: #fff; border-radius: 18px;
    padding: 22px 24px; box-shadow: 0 2px 12px rgba(0,0,0,.04);
  }
  .panel h3 { font-size: 13px; font-weight: 600; color: #6e6e73; margin-bottom: 14px; }
  .empty { color: #86868b; text-align: center; padding: 60px 0; font-size: 14px; }
  .more { display: block; margin: 20px auto 0; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; }
  td, th { overflow-wrap: anywhere; }
  .panel.collapsible > h3 { cursor: pointer; user-select: none; }
  .panel.collapsible > h3::after { content: ' ▾'; color: #86868b; font-size: 11px; }
  .panel.collapsed > h3::after { content: ' ▸'; }
  .panel.collapsed > *:not(h3) { display: none; }
  th { color: #6e6e73; font-weight: 600; text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(0,0,0,.08); white-space: nowrap; }
  td { padding: 9px 10px; border-bottom: 1px solid rgba(0,0,0,.05); color: #1d1d1f; word-break: break-word; }
  tr:last-child td { border-bottom: 0; }
`;

// 夜空烟花登录页（仅 Cloudflare Access 放行者可见，视觉可放心华丽）
const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${FAVICON_LINK}
<title>登录 — 焰境·万载 后台</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { min-height: 100%; }
  body {
    min-height: 100vh; overflow: hidden; /* 单屏页：杜绝任何意外溢出/横向滚动把居中带偏 */
    color: #eef2f8;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
    background:
      radial-gradient(1200px 700px at 75% -10%, rgba(96,64,168,.38), transparent 60%),
      radial-gradient(900px 600px at 10% 112%, rgba(214,69,36,.24), transparent 55%),
      linear-gradient(165deg, #0b0e1a 0%, #101528 55%, #1a1030 100%);
  }
  #fx { position: fixed; inset: 0; z-index: 0; display: block; }
  .card {
    /* 固定定位 + 四向归零 + auto 外边距：绝对居中，不受溢出/滚动/兄弟元素影响 */
    position: fixed; inset: 0; margin: auto; z-index: 1;
    width: min(404px, calc(100vw - 44px)); height: fit-content; padding: 36px 34px 30px;
    background: rgba(255,255,255,.055);
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 22px;
    box-shadow: 0 30px 80px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.12);
    backdrop-filter: blur(20px) saturate(150%);
    -webkit-backdrop-filter: blur(20px) saturate(150%);
  }
  .mark { display: flex; align-items: center; gap: 11px; }
  .mark img { width: 30px; height: 30px; filter: drop-shadow(0 0 12px rgba(255,157,60,.55)); }
  h1 { font-size: 20px; font-weight: 700; letter-spacing: .01em; }
  p.sub { color: rgba(238,242,248,.58); font-size: 13px; margin: 7px 0 20px; }
  .tabs { display: flex; gap: 22px; border-bottom: 1px solid rgba(255,255,255,.12); margin-bottom: 20px; }
  .tab { appearance: none; background: none; border: 0; padding: 0 2px 10px; font-size: 14.5px;
    color: rgba(238,242,248,.55); cursor: pointer; position: relative; font-family: inherit; }
  .tab:hover { color: rgba(238,242,248,.85); }
  .tab.active { color: #ffd08a; font-weight: 600; }
  .tab.active::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2.5px;
    border-radius: 2px; background: linear-gradient(90deg,#ff7a45,#ffd166); box-shadow: 0 0 12px rgba(255,157,60,.8); }
  label { display: block; font-size: 12.5px; color: rgba(238,242,248,.55); margin: 0 0 8px; }
  .field { margin-bottom: 14px; }
  input {
    width: 100%; padding: 12px 14px; font-size: 15px; color: #f4f7fc;
    background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.16); border-radius: 12px; outline: none;
    transition: border-color .2s, box-shadow .2s, background .2s; font-family: inherit;
  }
  input::placeholder { color: rgba(238,242,248,.35); }
  input:focus { border-color: rgba(255,157,60,.75); box-shadow: 0 0 0 3px rgba(255,157,60,.15); background: rgba(255,255,255,.09); }
  .btn-primary {
    width: 100%; margin-top: 8px; padding: 13px; font-size: 15px; font-weight: 600; font-family: inherit;
    color: #fff; background: linear-gradient(135deg, #e0512e, #c93a1b 58%, #ff9d3c 150%);
    border: 0; border-radius: 12px; cursor: pointer;
    box-shadow: 0 8px 26px rgba(224,81,46,.38);
    transition: filter .2s, transform .05s;
  }
  .btn-primary:hover { filter: brightness(1.12); }
  .btn-primary:active { transform: translateY(1px); }
  .btn-primary[disabled] { opacity: .55; cursor: default; }
  .err {
    display: none; margin-top: 14px; padding: 10px 13px; border-radius: 10px;
    background: rgba(255,92,61,.14); border: 1px solid rgba(255,92,61,.32);
    color: #ffb3a3; font-size: 13px; line-height: 1.6;
  }
  .hint { margin-top: 14px; font-size: 12px; color: rgba(238,242,248,.42); line-height: 1.75; }
  .foot { position: fixed; z-index: 1; bottom: 13px; left: 0; right: 0; text-align: center;
    font-size: 11.5px; color: rgba(238,242,248,.28); pointer-events: none; }
  [hidden] { display: none !important; }
  @media (max-width: 480px) { .card { padding: 28px 22px 24px; } }
</style>
</head>
<body>
<canvas id="fx" aria-hidden="true"></canvas>
<div class="card">
  <div class="mark"><img src="${FAVICON_URI}" alt=""><h1>焰境·万载 · 管理后台</h1></div>
  <p class="sub">whizzzest.com 站点数据管理</p>
  <div class="tabs" role="tablist">
    <button type="button" class="tab active" id="t-pw">账密登录</button>
    <button type="button" class="tab" id="t-pk">通行密钥</button>
  </div>
  <form id="f">
    <div class="field">
      <label for="user">用户名（选填，运营账号）</label>
      <input id="user" autocomplete="username" placeholder="主账号「站长」留空即可">
    </div>
    <div class="field">
      <label for="pw">密码</label>
      <input id="pw" type="password" autocomplete="current-password" required>
    </div>
    <button class="btn-primary" id="btn" type="submit">登 录</button>
    <div class="err" id="err"></div>
  </form>
  <div id="pane-pk" hidden>
    <p class="hint" style="margin:2px 0 16px">使用已绑定本后台的通行密钥，通过指纹 / 面容 / 设备密码一键登录，无需输入账号密码。</p>
    <button class="btn-primary" id="pk-go" type="button">使用通行密钥登录</button>
    <div class="err" id="errp"></div>
    <p class="hint">还没有通行密钥？先用账密登录，在「账号 → 我的通行密钥」中添加。</p>
  </div>
</div>
<p class="foot">焰境·万载 · 内部系统 · 仅限授权访问</p>
<script>
(function () {
  var TABS = [['t-pw', 'f'], ['t-pk', 'pane-pk']];
  function switchTab(i) {
    TABS.forEach(function (pair, j) {
      document.getElementById(pair[0]).classList.toggle('active', j === i);
      document.getElementById(pair[1]).hidden = j !== i;
    });
  }
  document.getElementById('t-pw').addEventListener('click', function () { switchTab(0); });
  document.getElementById('t-pk').addEventListener('click', function () { switchTab(1); });

  var ERR_TEXT = { invalid_credentials: '用户名或密码不正确', rate_limited: '尝试过于频繁，请 10 分钟后再试', config_missing: '服务端未配置完成', invalid_json: '提交格式有误' };
  function showErr(id, t) { var e = document.getElementById(id); e.textContent = t; e.style.display = t ? 'block' : 'none'; }

  document.getElementById('user').value = new URLSearchParams(location.search).get('u') || '';
  var f = document.getElementById('f');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = document.getElementById('btn');
    btn.disabled = true; showErr('err', '');
    fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('user').value, password: document.getElementById('pw').value })
    }).then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
      .then(function (r) {
        if (r.s === 200 && r.d.ok) { location.href = '/'; return; }
        btn.disabled = false;
        showErr('err', ERR_TEXT[r.d.error] || '登录失败，请重试');
      })
      .catch(function () { btn.disabled = false; showErr('err', '网络错误，请重试'); });
  });

  // 通行密钥登录（编解码与门户登录页同源：shared/portal-ui.js WA_HELPERS）
  ${WA_HELPERS}
  document.getElementById('pk-go').addEventListener('click', function () {
    var btn = this;
    if (btn.disabled) return;
    if (!window.PublicKeyCredential || !navigator.credentials) { showErr('errp', '当前浏览器不支持通行密钥'); return; }
    btn.disabled = true; showErr('errp', '');
    fetch('/api/webauthn/login-options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error('options');
        var o = d.options;
        o.challenge = b64uToBuf(o.challenge);
        if (o.allowCredentials) o.allowCredentials = o.allowCredentials.map(function (c) { c.id = b64uToBuf(c.id); return c; });
        return navigator.credentials.get({ publicKey: o });
      })
      .then(function (cred) {
        var res = cred.response;
        return fetch('/api/webauthn/login-verify', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
            response: {
              clientDataJSON: bufToB64u(res.clientDataJSON),
              authenticatorData: bufToB64u(res.authenticatorData),
              signature: bufToB64u(res.signature),
              userHandle: res.userHandle ? bufToB64u(res.userHandle) : null,
            },
          }) });
      })
      .then(function (r) {
        if (r.ok) { location.href = '/'; return; }
        return r.json().catch(function () { return {}; }).then(function (d) {
          btn.disabled = false;
          showErr('errp', d && d.error === 'rate' ? '尝试过于频繁，请 10 分钟后再试' : '通行密钥验证未通过，请重试');
        });
      })
      .catch(function () {
        btn.disabled = false;
        showErr('errp', '已取消，或本机没有已绑定的通行密钥');
      });
  });

  /* ---- 夜空烟花：星空低频自动绽放；prefers-reduced-motion 时退化为静态星空 ---- */
  var cv = document.getElementById('fx'), cx = cv.getContext('2d');
  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var W = 0, H = 0, stars = [], parts = [], rockets = [], lastLaunch = 0;
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var PALETTE = ['255,209,102', '255,122,69', '74,215,255', '196,146,255', '94,231,183'];
  function fit() {
    W = cv.width = Math.floor(innerWidth * DPR);
    H = cv.height = Math.floor(innerHeight * DPR);
    cv.style.width = innerWidth + 'px';
    cv.style.height = innerHeight + 'px';
    stars = [];
    var n = Math.floor((innerWidth * innerHeight) / 9000);
    for (var i = 0; i < n; i++) {
      stars.push({ x: Math.random() * W, y: Math.random() * H * 0.92, r: (Math.random() * 1.1 + 0.3) * DPR, p: Math.random() * 6.283, s: Math.random() * 1.4 + 0.5 });
    }
  }
  fit();
  addEventListener('resize', fit);
  function launch() {
    rockets.push({ x: (0.15 + Math.random() * 0.7) * W, y: H, vy: -(7.5 + Math.random() * 2.5) * DPR,
      hue: PALETTE[Math.floor(Math.random() * PALETTE.length)], ty: (0.16 + Math.random() * 0.3) * H });
  }
  function explode(x, y, hue) {
    var n = 42 + Math.floor(Math.random() * 26);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * 6.283, sp = (Math.random() * 3.4 + 0.6) * DPR;
      parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, dec: Math.random() * 0.012 + 0.008, hue: hue });
    }
  }
  function frame(ts) {
    cx.clearRect(0, 0, W, H);
    for (var i = 0; i < stars.length; i++) {
      var st = stars[i];
      cx.globalAlpha = 0.22 + 0.34 * (0.5 + 0.5 * Math.sin(st.p + (ts / 1000) * st.s));
      cx.fillStyle = '#cdd8ee';
      cx.beginPath(); cx.arc(st.x, st.y, st.r, 0, 6.283); cx.fill();
    }
    cx.globalAlpha = 1;
    if (!REDUCED) {
      if (ts - lastLaunch > 1100 && rockets.length < 3) { lastLaunch = ts; launch(); }
      cx.globalCompositeOperation = 'lighter';
      for (var r = rockets.length - 1; r >= 0; r--) {
        var rk = rockets[r];
        rk.y += rk.vy;
        rk.vy *= 0.985;
        cx.fillStyle = 'rgba(255,220,160,.85)';
        cx.beginPath(); cx.arc(rk.x, rk.y, 1.6 * DPR, 0, 6.283); cx.fill();
        if (rk.vy > -1.2 * DPR || rk.y <= rk.ty) { explode(rk.x, rk.y, rk.hue); rockets.splice(r, 1); }
      }
      for (var j = parts.length - 1; j >= 0; j--) {
        var p = parts[j];
        p.x += p.vx; p.y += p.vy;
        p.vy += 0.045 * DPR;
        p.vx *= 0.985; p.vy *= 0.985;
        p.life -= p.dec;
        if (p.life <= 0) { parts.splice(j, 1); continue; }
        cx.fillStyle = 'rgba(' + p.hue + ',' + (p.life * 0.9).toFixed(3) + ')';
        cx.beginPath(); cx.arc(p.x, p.y, (p.life * 1.8 + 0.4) * DPR, 0, 6.283); cx.fill();
      }
      cx.globalCompositeOperation = 'source-over';
      requestAnimationFrame(frame);
    }
  }
  if (REDUCED) frame(0);
  else requestAnimationFrame(frame);
})();
</script>
</body>
</html>`;

const APP_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${FAVICON_LINK}
<title>管理后台 — 焰境·万载</title>
<style>
${BASE_CSS}
  .wrap { max-width: 1060px; margin: 0 auto; }
  /* 访客分析 */
  .range { display: flex; align-items: center; gap: 10px; margin: 18px auto 0; max-width: 1060px; }
  .range .updated { margin-left: auto; color: #86868b; font-size: 12px; }
  .cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin: 12px 0 0; }
  .card2 { background: #fff; border-radius: 16px; padding: 16px 14px; box-shadow: 0 2px 12px rgba(0,0,0,.04); }
  .card2 b { display: block; font-size: 24px; font-weight: 600; letter-spacing: -.02em; }
  .card2 span { display: block; margin-top: 4px; color: #6e6e73; font-size: 12px; }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 14px 0 0; }
  .kpi { background: #fff; border-radius: 18px; padding: 18px 20px 14px; box-shadow: 0 2px 12px rgba(0,0,0,.04); }
  .kpi-head { display: flex; align-items: center; justify-content: space-between; color: #6e6e73; font-size: 13px; }
  .kpi-head .delta { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .kpi-val { display: block; margin-top: 4px; font-size: 34px; font-weight: 600; letter-spacing: -.02em; }
  .spark { width: 100%; height: 36px; margin-top: 8px; display: block; }
  .livedot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #1a7f37; margin-right: 5px; }
  @media (prefers-reduced-motion: no-preference) {
    .livedot { animation: lpulse 2s ease-in-out infinite; }
  }
  @keyframes lpulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .panel { position: relative; }
  .mini { padding: 2px 10px !important; font-size: 11px !important; float: right; margin-left: 8px; }
  /* 维度条形：单色细条、数据端 4px 圆角、基线方角；「其他/未知」与长尾行灰色去强调 */
  .bar-row { display: grid; grid-template-columns: minmax(56px, 8.5em) 1fr auto; align-items: center; gap: 10px; padding: 7px 0; font-size: 13px; }
  .bar-row .label { color: #1d1d1f; overflow-wrap: anywhere; line-height: 1.3; }
  .bar-track { height: 8px; background: #f0f0f2; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; background: #d64524; border-radius: 0 4px 4px 0; }
  .bar-row.dimrow .label { color: #86868b; }
  .bar-row.dimrow .bar-fill { background: #c9c9ce; }
  .bar-row.tailrow { cursor: pointer; }
  .bar-row.tailrow:hover .label { color: #d64524; }
  .bar-val { text-align: right; line-height: 1.3; white-space: nowrap; }
  .bar-val b { color: #1d1d1f; font-weight: 600; font-variant-numeric: tabular-nums; }
  .bar-val .u { color: #86868b; }
  .bar-val small { display: block; color: #86868b; font-size: 11px; font-variant-numeric: tabular-nums; }
  .new-badge { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 4px; background: #fdeee8; color: #d64524; font-size: 10px; font-weight: 600; vertical-align: 1px; }
  svg.chart { width: 100%; height: 260px; outline: none; }
  svg.chart text { font-size: 12px; fill: #86868b; font-family: inherit; }
  .viz-tip { position: absolute; display: none; pointer-events: none; background: #fff; border-radius: 10px; padding: 8px 12px; box-shadow: 0 4px 18px rgba(0,0,0,.14); font-size: 12px; color: #6e6e73; z-index: 6; min-width: 132px; }
  .viz-tip .tt-date { font-weight: 600; color: #1d1d1f; margin-bottom: 4px; white-space: nowrap; }
  .viz-tip .tt-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; white-space: nowrap; }
  .viz-tip .tt-key { width: 10px; height: 3px; border-radius: 2px; flex: 0 0 auto; }
  .viz-tip .tt-row b { margin-left: auto; padding-left: 14px; color: #1d1d1f; font-variant-numeric: tabular-nums; }
  .legend { display: flex; gap: 16px; font-size: 12px; color: #6e6e73; margin-bottom: 8px; }
  .legend i { display: inline-block; width: 16px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 5px; }
  .k-badge { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #f5f5f7; font-size: 12px; color: #6e6e73; }
  .list .msg {
    margin-top: 14px; padding: 18px 20px; background: #fff;
    border: 1px solid rgba(0,0,0,.06); border-left: 3px solid #d64524; border-radius: 14px;
  }
  .list .msg.read { border-left-color: rgba(0,0,0,.15); }
  .row1 { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .name { font-weight: 600; font-size: 15px; }
  .email a { color: #6e6e73; font-size: 13px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #d64524; margin-left: auto; }
  .msg.read .dot { background: rgba(0,0,0,.15); }
  .time { color: #86868b; font-size: 12px; margin-top: 2px; }
  .body { margin: 12px 0; font-size: 14px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
  .meta { color: #86868b; font-size: 12px; word-break: break-all; }
  .ops { display: flex; gap: 8px; margin-top: 14px; }
  .ops button { padding: 5px 12px; font-size: 12px; }
  .ops button.danger { background: #d64524; border-color: #d64524; color: #fff; }
  .ops button.danger:hover { background: #b5371a; color: #fff; }
  .stat-line { color: #6e6e73; font-size: 13px; margin: 12px 0 0; }
  .vwrap { margin-top: 12px; background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.04); }
  .vrow td { cursor: pointer; }
  .vrow:hover td { background: #fafafc; }
  .flag { margin-right: 4px; }
  .detail td { color: #6e6e73; font-size: 12px; }
  /* 商户管理 */
  .mgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px 14px; }
  .mgrid label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #6e6e73; }
  .mgrid label.wide { grid-column: 1 / -1; }
  .mgrid input, .mgrid select, .mgrid textarea {
    padding: 9px 12px; font-size: 14px; color: #1d1d1f; background: #f5f5f7;
    border: 1px solid transparent; border-radius: 10px; outline: none; font-family: inherit;
    transition: border-color .2s, background .2s;
  }
  .mgrid input:focus, .mgrid select:focus, .mgrid textarea:focus { border-color: #d64524; background: #fff; }
  .mgrid textarea { resize: vertical; line-height: 1.7; }
  .mst { padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; }
  .mst-pending { background: #fdeee8; color: #d64524; }
  .mst-approved { background: #e5f3e8; color: #1a7f37; }
  .mst-rejected { background: #f0f0f2; color: #6e6e73; }
  .mst-draft { background: #eef0f4; color: #515154; }
  .mst-expired { background: #fbf3dd; color: #9a6b00; }
  /* 万载TV 视频管理 */
  .vrow1 { display: flex; align-items: flex-start; gap: 12px; }
  .vthumb { width: 120px; aspect-ratio: 16/9; object-fit: cover; border-radius: 8px; background: #f0f0f2; flex: 0 0 auto; }
  /* 文库管理 */
  .bkthumb { width: 58px; height: 82px; object-fit: cover; border-radius: 6px; background: #f0f0f2; flex: 0 0 auto; }
  .chdetail { margin: -6px 0 14px; padding: 14px 16px; background: #fafafc; border-radius: 12px; border: 1px solid rgba(0,0,0,.05); }
  .chitem { border-top: 1px solid rgba(0,0,0,.06); padding: 12px 0; }
  .chitem:first-child { border-top: 0; padding-top: 4px; }
  .chbody { margin-top: 8px; padding: 10px 12px; background: #fff; border: 1px solid rgba(0,0,0,.05); border-radius: 10px; font-size: 13px; white-space: pre-wrap; word-break: break-word; color: #333; max-height: 280px; overflow-y: auto; line-height: 1.7; }
  .figwrap { position: relative; display: inline-block; }
  .figwrap img { display: block; }
  .figwrap .figdel { position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; padding: 0; border-radius: 999px; font-size: 11px; line-height: 1; background: #fff; border: 1px solid rgba(0,0,0,.15); color: #d64524; cursor: pointer; }
  .chedit { margin: 10px 0 4px; padding: 12px 14px; background: #fff; border: 1px solid rgba(0,0,0,.08); border-radius: 12px; display: flex; flex-direction: column; gap: 10px; }
  .chedit-grid { display: grid; grid-template-columns: 110px 1fr; gap: 10px; }
  .chedit label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #6e6e73; }
  .chedit input, .chedit textarea { padding: 9px 11px; font-size: 14px; color: #1d1d1f; background: #fafafc; border: 1px solid rgba(0,0,0,.1); border-radius: 10px; outline: none; font-family: inherit; }
  .chedit input:focus, .chedit textarea:focus { border-color: #d64524; background: #fff; }
  .chedit textarea { resize: vertical; line-height: 1.7; white-space: pre-wrap; }
  .vprog { height: 6px; background: #f0f0f2; border-radius: 999px; margin-top: 14px; overflow: hidden; }
  .vprog div { height: 100%; width: 0; background: linear-gradient(90deg, #d64524, #f2a03d); transition: width .2s; }
  .vhint { color: #86868b; font-size: 12px; }
  .vfile { font-size: 13px; color: #6e6e73; margin-top: 6px; }
  .mrow-pay { margin-top: 10px; padding: 8px 12px; background: #fbf3dd; color: #9a6b00; border-radius: 10px; font-size: 13px; }
  .mslug { font-size: 12px; color: #6e6e73; }
  .mslug:hover { color: #d64524; }
  @media (max-width: 900px) {
    .cards { grid-template-columns: repeat(3, 1fr); }
    .kpis { grid-template-columns: 1fr; }
    .grid3, .grid2 { grid-template-columns: 1fr; }
    .mgrid { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 560px) {
    .cards { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<header class="anav">
  <div class="anav-inner">
    <a class="anav-logo" href="/" aria-label="焰境·万载 管理后台">
      <img src="${FAVICON_URI}" alt="" width="22" height="22" aria-hidden="true">焰境·万载
    </a>
    <nav class="anav-menu" aria-label="后台板块">
      <a class="anav-link active" id="vtab-msg" href="#/msg">留言</a>
      <a class="anav-link" id="vtab-visit" href="#/visit">访客</a>
      <a class="anav-link" id="vtab-merch" href="#/merch">商户</a>
      <a class="anav-link" id="vtab-tv" href="#/tv">视频</a>
      <a class="anav-link" id="vtab-books" href="#/books">文库</a>
      <a class="anav-link" id="vtab-music" href="#/music">音乐</a>
      <a class="anav-link" id="vtab-attra" href="#/attra">景点</a>
      <a class="anav-link" id="vtab-ai" href="#/ai">AI 助手</a>
      <a class="anav-link" id="vtab-acct" href="#/acct">账号</a>
    </nav>
    <div class="anav-right">
      <a class="anav-link" href="https://whizzzest.com/" target="_blank" rel="noopener">前往官网 ↗</a>
      <button id="refresh" type="button">刷新</button>
      <div class="acct" id="acct-box">
        <button id="acct-chip" type="button" title="账号菜单"><span id="acct-name">…</span> ▾</button>
        <div class="acct-drop" id="acct-drop" hidden></div>
      </div>
      <button class="anav-burger" id="burger" type="button" aria-label="打开菜单" aria-expanded="false" aria-controls="anav-drawer">
        <span class="anav-burger-line" aria-hidden="true"></span>
        <span class="anav-burger-line" aria-hidden="true"></span>
      </button>
    </div>
  </div>
</header>
<div class="anav-drawer" id="anav-drawer">
  <ul class="anav-drawer-list" aria-label="后台板块">
    <li class="anav-drawer-item"><a class="anav-link" href="#/msg">留言</a></li>
    <li class="anav-drawer-item"><a class="anav-link" href="#/visit">访客</a></li>
    <li class="anav-drawer-item"><a class="anav-link" href="#/merch">商户</a></li>
    <li class="anav-drawer-item"><a class="anav-link" href="#/tv">视频</a></li>
    <li class="anav-drawer-item"><a class="anav-link" href="#/books">文库</a></li>
    <li class="anav-drawer-item"><a class="anav-link" href="#/music">音乐</a></li>
    <li class="anav-drawer-item"><a class="anav-link" href="#/attra">景点</a></li>
    <li class="anav-drawer-item"><a class="anav-link" href="#/acct">账号</a></li>
    <li class="anav-drawer-item"><a class="anav-link" href="https://whizzzest.com/" target="_blank" rel="noopener">前往官网 ↗</a></li>
    <li class="anav-drawer-item"><a class="anav-link" id="logout-m" href="#">退出登录</a></li>
  </ul>
</div>

<div id="view-msg" class="wrap">
  <div class="tabs" style="display:flex;gap:8px;margin:18px 0 4px;">
    <button class="tab active" id="tab-unread" type="button">未读</button>
    <button class="tab" id="tab-all" type="button">全部</button>
  </div>
  <p class="stat-line" id="stats"></p>
  <div class="list" id="list"><p class="empty">加载中…</p></div>
  <button class="more" id="more" type="button" style="display:none">加载更多</button>
</div>

<div id="view-visit" class="wrap" style="display:none">
  <div class="range">
    <button class="tab" data-days="7" type="button">7 天</button>
    <button class="tab active" data-days="30" type="button">30 天</button>
    <button class="tab" data-days="90" type="button">90 天</button>
    <button class="tab" data-days="180" type="button">180 天</button>
    <button class="tab" data-days="365" type="button">365 天</button>
    <span class="dimm" style="display:flex;align-items:center;gap:2px;font-size:13px;color:#6e6e73">维度条长按
      <button class="tab active" data-metric="pv" type="button">浏览</button>
      <button class="tab" data-metric="uv" type="button">访客</button>
    </span>
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#6e6e73">
      <input id="include-bots" type="checkbox">包含扫描/机器人
    </label>
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#6e6e73">
      <input id="auto-refresh" type="checkbox">2 分钟自动刷新
    </label>
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#6e6e73" title="关闭后主站停止记录访问明细（约 1 分钟内生效），历史数据仍可查询">
      <input id="visit-tracking" type="checkbox" checked>访客采集
    </label>
    <span class="updated" id="updated"></span>
    <button id="vrefresh" type="button">刷新</button>
  </div>
  <div id="tracking-note" style="display:none;margin:10px 0 0;padding:8px 12px;border:1px solid #d64524;border-radius:8px;color:#d64524;font-size:13px">访客采集已关闭——主站已停止记录访问明细（约 1 分钟内全网生效）；历史数据仍可查询，90 天保留清理照常。</div>
  <div class="kpis">
    <div class="kpi">
      <div class="kpi-head"><span>浏览量</span><span class="delta" id="c-delta">–</span></div>
      <b class="kpi-val" id="c-pv">–</b>
      <svg class="spark" id="sp-pv" aria-hidden="true"></svg>
    </div>
    <div class="kpi">
      <div class="kpi-head"><span>访客数</span></div>
      <b class="kpi-val" id="c-uv">–</b>
      <svg class="spark" id="sp-uv" aria-hidden="true"></svg>
    </div>
    <div class="kpi">
      <div class="kpi-head"><span>会话数</span></div>
      <b class="kpi-val" id="c-sessions">–</b>
      <svg class="spark" id="sp-sess" aria-hidden="true"></svg>
    </div>
  </div>
  <div class="cards">
    <div class="card2"><b id="c-bounce">–</b><span>跳出率</span></div>
    <div class="card2"><b id="c-avg">–</b><span>平均停留</span></div>
    <div class="card2"><b id="c-pps">–</b><span>页 / 会话</span></div>
    <div class="card2"><b id="c-new">–</b><span>新访客占比</span></div>
    <div class="card2"><b id="c-live">–</b><span><i class="livedot"></i>5 分钟内活跃</span></div>
  </div>
  <div class="panel">
    <h3>每日浏览与访客<button class="mini" id="chart-table-toggle" type="button">数据表</button></h3>
    <div class="legend" id="chart-legend"><span><i style="background:#d64524"></i>浏览量</span><span><i style="background:#2a78d6"></i>访客数</span><span><i style="background:#129b74"></i>新访客</span><span id="chart-empty" style="margin-left:auto"></span></div>
    <svg class="chart" id="chart" tabindex="0" role="img" aria-label="每日浏览量、访客数与新访客趋势折线图，可用左右方向键逐日查看数值"></svg>
    <div class="viz-tip" id="chart-tip"></div>
    <div id="chart-table" style="display:none;max-height:300px;overflow-y:auto"><table><thead><tr><th style="width:25%">日期</th><th style="width:25%">浏览量</th><th style="width:25%">访客数</th><th style="width:25%">新访客</th></tr></thead><tbody id="chart-table-body"></tbody></table></div>
  </div>
  <div class="panel">
    <h3>热门页面</h3>
    <table><colgroup><col style="width:52%"><col style="width:15%"><col style="width:15%"><col style="width:18%"></colgroup><thead><tr><th>路径</th><th>浏览</th><th>访客</th><th>平均停留</th></tr></thead><tbody id="top-pages"></tbody></table>
  </div>
  <div class="grid3" style="margin-top:14px">
    <div class="panel" style="margin:0"><h3>流量类型</h3><div id="kinds"></div></div>
    <div class="panel" style="margin:0"><h3>来源网站</h3><div id="sources"></div></div>
    <div class="panel" style="margin:0"><h3>设备</h3><div id="devices"></div></div>
  </div>
  <div class="grid3" style="margin-top:14px">
    <div class="panel" style="margin:0"><h3>浏览器</h3><div id="browsers"></div></div>
    <div class="panel" style="margin:0"><h3>操作系统</h3><div id="os"></div></div>
    <div class="panel" style="margin:0"><h3>语言</h3><div id="langs"></div></div>
  </div>
  <div class="grid2" style="margin-top:14px">
    <div class="panel" style="margin:0"><h3>国家 / 地区</h3><div id="countries"></div></div>
    <div class="panel" style="margin:0"><h3>最近页面浏览</h3><table><tbody id="recent"></tbody></table></div>
  </div>
  <div class="grid2" style="margin-top:14px">
    <div class="panel" style="margin:0"><h3>入口页 TOP（每会话首站）</h3><div id="entries"></div></div>
    <div class="panel" style="margin:0"><h3>会话浏览深度</h3><div id="depth"></div></div>
  </div>
  <div class="panel">
    <h3>访客列表（最近活跃在前，点击展开会话与轨迹）</h3>
    <div class="vwrap"><table>
      <thead><tr><th>最近活跃</th><th>地区</th><th>设备</th><th>浏览器 · 系统</th><th>浏览</th><th>会话</th><th>首次访问</th></tr></thead>
      <tbody id="vlist"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
    </table></div>
    <button class="more" id="vmore" type="button" style="display:none">加载更多</button>
  </div>
</div>

<div id="view-merch" class="wrap" style="display:none">
  <div class="range">
    <button class="tab active" data-mst="" type="button">全部</button>
    <button class="tab" data-mst="pending" type="button">待审核</button>
    <button class="tab" data-mst="approved" type="button">已上线</button>
    <button class="tab" data-mst="rejected" type="button">已驳回</button>
    <button class="tab" data-mst="expired" type="button">已过期</button>
    <span class="updated" id="mstats"></span>
    <button id="madd" type="button" class="primary">新增商户</button>
  </div>
  <div class="panel" id="mform" style="display:none">
    <h3 id="mform-title">新增商户</h3>
    <div class="mgrid">
      <label>名称 *<input id="f-name"></label>
      <label>分类
        <select id="f-cat">
          <option value="food">美食</option><option value="stay">住宿</option>
          <option value="specialty">特产</option><option value="fireworks">花炮</option>
          <option value="other">其他</option>
        </select>
      </label>
      <label>等级
        <select id="f-tier">
          <option value="free">基础（免费）</option>
          <option value="verified">认证商户</option>
          <option value="featured">置顶推荐</option>
        </select>
      </label>
      <label>状态
        <select id="f-status">
          <option value="pending">待审核</option>
          <option value="approved">已上线</option>
          <option value="rejected">已驳回</option>
          <option value="expired">已过期</option>
        </select>
      </label>
      <label>Slug（上线地址，留空自动 m<id）<input id="f-slug" placeholder="liuda-wan"></label>
      <label>付费到期（YYYY-MM-DD，空 = 免费期）<input id="f-paid" placeholder="2027-09-06"></label>
      <label>置顶权重（大者靠前）<input id="f-weight" type="number" value="0"></label>
      <label class="wide">封面图（可上传本地图 JPG/PNG/WebP ≤5MB，或直接填站内地址 /assets/img/…）
        <input id="f-cover" placeholder="/assets/img/wanzaizha1rou.jpeg（选了上传文件时以文件为准）">
        <input id="f-coverfile" type="file" accept="image/jpeg,image/png,image/webp">
        <span class="vfile" id="f-coverinfo"></span>
        <img id="f-coverprev" alt="" style="display:none;width:132px;height:88px;object-fit:cover;border-radius:8px;background:#f5f5f7">
      </label>
      <label class="wide">一句话简介（卡片展示）<input id="f-intro"></label>
      <label class="wide">详情（空行自动分段）<textarea id="f-detail" rows="4"></textarea></label>
      <label>地址<input id="f-address"></label>
      <label>电话<input id="f-phone"></label>
      <label>微信号<input id="f-wechat"></label>
      <label>营业时间<input id="f-hours"></label>
      <label>联系人（不公开）<input id="f-cname"></label>
      <label>联系电话（不公开）<input id="f-cphone"></label>
    </div>
    <div class="ops"><button class="primary" id="fsave" type="button">保存</button><button id="fcancel" type="button">取消</button></div>
  </div>
  <div class="list" id="mlist"><p class="empty">加载中…</p></div>
  <button class="more" id="mmore" type="button" style="display:none">加载更多</button>
</div>

<div id="view-tv" class="wrap" style="display:none">
  <div class="range">
    <button class="tab active" data-vst="" type="button">全部</button>
    <button class="tab" data-vst="published" type="button">已发布</button>
    <button class="tab" data-vst="hidden" type="button">已隐藏</button>
    <span class="updated" id="tstats"></span>
    <button id="tadd" type="button" class="primary">新增视频</button>
  </div>
  <div class="panel" id="tform" style="display:none">
    <h3 id="tform-title">新增视频</h3>
    <div class="mgrid">
      <label>标题 *<input id="t-title" maxlength="80"></label>
      <label>分类
        <select id="t-cat">
          <option value="drama">短剧</option><option value="fireworks">烟花</option>
          <option value="heritage">非遗</option><option value="food">美食</option>
          <option value="tourism">文旅</option><option value="other">其他</option>
        </select>
      </label>
      <label>状态
        <select id="t-status">
          <option value="published">发布</option>
          <option value="hidden">隐藏</option>
        </select>
      </label>
      <label>来源
        <select id="t-src">
          <option value="bilibili">B站嵌入</option>
          <option value="upload">直接上传（MP4/WebM，≤95MB）</option>
        </select>
      </label>
      <label id="row-bvid">B站 BV 号 *<input id="t-bvid" placeholder="BV1xx411c7mD">
        <button type="button" id="t-fetch" style="align-self:flex-start">从B站获取信息</button>
        <span class="vhint">自动填标题 / 简介 / 时长，封面转存到站点（绕开B站防盗链）</span>
      </label>
      <label id="row-file" style="display:none">视频文件（选文件自动读时长）<input id="t-file" type="file" accept="video/mp4,video/webm,.mp4,.m4v,.webm"><span class="vfile" id="t-fileinfo"></span></label>
      <label>剧名 / 合集（短剧用，可空）<input id="t-series" maxlength="60" placeholder="一朝相逢便是万载"></label>
      <label id="row-scover" style="display:none">剧集总封面（货架竖版海报，≤5MB）<input id="t-scover" type="file" accept="image/jpeg,image/png,image/webp"><span class="vfile" id="t-scoverinfo"></span></label>
      <label>集数（可空）<input id="t-ep" type="number" min="1" max="9999"></label>
      <label>焦点位（频道页大位）
        <select id="t-feat">
          <option value="0">否</option>
          <option value="1">是</option>
        </select>
      </label>
      <label>时长（秒）<input id="t-dur" type="number" min="0" max="86400"></label>
      <label class="wide">简介<input id="t-intro" maxlength="600"></label>
      <label class="wide">封面图（可选，≤5MB；B站封面有防盗链，建议传一张）<input id="t-cover" type="file" accept="image/jpeg,image/png,image/webp"><span class="vfile" id="t-coverinfo"></span></label>
    </div>
    <div class="vprog" id="t-prog" style="display:none"><div id="t-progbar"></div></div>
    <p class="vhint" id="t-hint" style="margin-top:8px;display:none"></p>
    <div class="ops" style="margin-top:12px"><button class="primary" id="tsave" type="button">保存</button><button id="tcancel" type="button">取消</button></div>
  </div>
  <div class="list" id="tlist"><p class="empty">加载中…</p></div>
  <button class="more" id="tmore" type="button" style="display:none">加载更多</button>
</div>

<div id="view-books" class="wrap" style="display:none">
  <div class="range">
    <button class="tab active" data-bst="" type="button">全部</button>
    <button class="tab" data-bst="pending" type="button">待审</button>
    <button class="tab" data-bst="approved" type="button">已上线</button>
    <button class="tab" data-bst="rejected" type="button">已驳回</button>
    <button class="tab" data-bst="hidden" type="button">已下线</button>
    <span class="updated" id="bstats"></span>
    <button id="badd" type="button" class="primary">新增作品</button>
  </div>
  <div class="panel" id="bform" style="display:none">
    <h3 id="bform-title">新增作品（免审直发）</h3>
    <div class="mgrid">
      <label>书名 *<input id="b-title" maxlength="80"></label>
      <label>分类
        <select id="b-cat">
          <option value="novel">小说</option><option value="story">故事</option>
          <option value="essay">随笔</option><option value="other">其他</option>
        </select>
      </label>
      <label>笔名<input id="b-author" maxlength="40"></label>
      <label>状态
        <select id="b-status">
          <option value="approved">已上线</option>
          <option value="pending">待审核</option>
          <option value="hidden">已下线</option>
        </select>
      </label>
      <label>置顶权重（大者靠前）<input id="b-weight" type="number" value="0"></label>
      <label class="wide">封面（竖版 2:3 最佳，JPG/PNG/WebP ≤5MB；也可手填 R2 键 book/… 或站内路径 /…，都可空）<input id="b-cover" placeholder="留空 = 保持现有；上传图片后自动填入新地址"></label>
      <div class="ops" style="margin:-4px 0 0;align-items:center">
        <button type="button" id="b-coverpick">上传封面图</button>
        <input id="b-coverfile" type="file" accept="image/jpeg,image/png,image/webp" hidden>
        <img id="b-coverprev" class="bkthumb" alt="" style="display:none">
        <span class="vhint" id="b-coverinfo"></span>
      </div>
      <label class="wide">简介 *<textarea id="b-intro" rows="3"></textarea></label>
    </div>
    <div class="ops"><button class="primary" id="bsave" type="button">保存</button><button id="bcancel" type="button">取消</button></div>
    <p class="vhint" style="margin-top:10px">章节在作者门户（writer.whizzzest.com）写作；此处创建/编辑作品信息，章节审核点作品卡的「章节审核」。</p>
  </div>
  <div class="list" id="blist"><p class="empty">加载中…</p></div>
  <button class="more" id="bmore" type="button" style="display:none">加载更多</button>
</div>

<div id="view-music" class="wrap" style="display:none">
  <div class="range">
    <button class="tab active" data-must="" type="button">全部</button>
    <button class="tab" data-must="published" type="button">已上线</button>
    <button class="tab" data-must="hidden" type="button">已隐藏</button>
    <span class="updated" id="mustats"></span>
    <button id="muadd" type="button" class="primary">新增曲目</button>
  </div>
  <div class="panel" id="muform" style="display:none">
    <h3 id="muform-title">新增曲目</h3>
    <div class="mgrid">
      <label>曲名 *<input id="mu-title" maxlength="80"></label>
      <label>演唱 / 演奏<input id="mu-artist" maxlength="40" placeholder="佚名"></label>
      <label>状态
        <select id="mu-status">
          <option value="published">上线</option>
          <option value="hidden">隐藏</option>
        </select>
      </label>
      <label>曲序（小者靠前）<input id="mu-sort" type="number" value="0"></label>
      <label>时长（秒）<input id="mu-dur" type="number" min="0" max="86400"></label>
      <label class="wide">音频文件 MP3 *（≤50MB，选文件自动读时长）<input id="mu-file" type="file" accept="audio/mpeg,.mp3"><span class="vfile" id="mu-fileinfo"></span></label>
      <label class="wide">封面（可选 ≤5MB，方形最佳；不传前台用「焰」字占位）<input id="mu-cover" type="file" accept="image/jpeg,image/png,image/webp"><span class="vfile" id="mu-coverinfo"></span></label>
    </div>
    <div class="vprog" id="mu-prog" style="display:none"><div id="mu-progbar"></div></div>
    <p class="vhint" id="mu-hint" style="margin-top:8px;display:none"></p>
    <div class="ops" style="margin-top:12px"><button class="primary" id="musave" type="button">保存</button><button id="mucancel" type="button">取消</button></div>
  </div>
  <div class="list" id="mulist"><p class="empty">加载中…</p></div>
  <button class="more" id="mumore" type="button" style="display:none">加载更多</button>
</div>

<div id="view-attra" class="wrap" style="display:none">
  <div class="range">
    <button class="tab active" data-ast="" type="button">全部</button>
    <button class="tab" data-ast="published" type="button">已上线</button>
    <button class="tab" data-ast="hidden" type="button">已下线</button>
    <span class="updated" id="astats"></span>
    <button id="atadd" type="button" class="primary">新增景点</button>
  </div>
  <div class="panel" id="atform" style="display:none">
    <h3 id="atform-title">新增景点</h3>
    <div class="mgrid">
      <label>名称 *<input id="at-name" maxlength="60"></label>
      <label>Slug *（详情地址 /attractions/slug/，小写字母数字连字符）<input id="at-slug" placeholder="wanzai-gucheng"></label>
      <label>状态
        <select id="at-status">
          <option value="published">上线</option>
          <option value="hidden">下线</option>
        </select>
      </label>
      <label>排序（小者靠前）<input id="at-sort" type="number" value="0"></label>
      <label>标签（逗号分隔，最多 4 个）<input id="at-tags" maxlength="60" placeholder="古城,夜景"></label>
      <label class="wide">一句话简介 *（瀑布流卡片展示）<input id="at-summary" maxlength="200"></label>
      <label class="wide">正文（空行自动分段）<textarea id="at-body" rows="6"></textarea></label>
      <label>地址<input id="at-address" maxlength="100"></label>
      <label>开放时间<input id="at-hours" maxlength="60"></label>
      <label>门票<input id="at-tickets" maxlength="60"></label>
      <label>交通<input id="at-transport" maxlength="100"></label>
      <label class="wide">封面（可选 ≤5MB，竖图/横图均可，瀑布流原比例展示）<input id="at-cover" type="file" accept="image/jpeg,image/png,image/webp"><span class="vfile" id="at-coverinfo"></span></label>
    </div>
    <p class="vhint" id="at-hint" style="margin-top:8px;display:none"></p>
    <div class="ops" style="margin-top:12px"><button class="primary" id="atsave" type="button">保存</button><button id="atcancel" type="button">取消</button></div>
  </div>
  <div class="list" id="atlist"><p class="empty">加载中…</p></div>
  <button class="more" id="atmore" type="button" style="display:none">加载更多</button>
</div>

<div id="view-ai" class="wrap" style="display:none">
  <div class="range">
    <span class="updated" id="ai-stats-line">加载中…</span>
    <button id="ai-log-clear" type="button">清空问答日志</button>
    <button id="k-add" type="button" class="primary">新增知识</button>
  </div>
  <div class="panel">
    <h3>运行设置 <span style="font-weight:400;font-size:12px;color:#86868b">（保存后主站最迟 1 分钟生效）</span></h3>
    <div class="mgrid" style="grid-template-columns:1fr 2fr;max-width:720px">
      <label>助手开关
        <select id="ai-enabled">
          <option value="1">启用</option>
          <option value="0">停用（前台入口隐藏）</option>
        </select>
      </label>
      <label>模型<select id="ai-model"></select></label>
      <label class="wide">系统提示词（花傩人设、职责、回复格式；详见 docs/AI助手方案.md）<textarea id="ai-prompt" rows="9"></textarea></label>
      <label class="wide">欢迎页快捷问题（每行一条，最多 6 条，留空用内置默认）<textarea id="ai-quick" rows="4"></textarea></label>
    </div>
    <p class="vhint" id="ai-hint" style="margin-top:8px;display:none"></p>
    <div class="ops" style="margin-top:12px"><button class="primary" id="ai-savesettings" type="button">保存设置</button></div>
  </div>
  <div class="panel" id="kform" style="display:none">
    <h3 id="kform-title">新增知识</h3>
    <div class="mgrid" style="grid-template-columns:1fr 1fr;max-width:760px">
      <label>分类 *（如：烟花文化）<input id="k-category" maxlength="30"></label>
      <label>排序（小者靠前）<input id="k-sort" type="number" value="0"></label>
      <label>关键词 *（逗号分隔，用户问题含任一词即命中）<input id="k-keywords" maxlength="200" placeholder="烟花,花炮,历史"></label>
      <label>状态
        <select id="k-status">
          <option value="published">参与检索</option>
          <option value="hidden">停用</option>
        </select>
      </label>
      <label class="wide">内容 *<textarea id="k-content" rows="5"></textarea></label>
    </div>
    <p class="vhint" id="k-hint" style="margin-top:8px;display:none"></p>
    <div class="ops" style="margin-top:12px"><button class="primary" id="ksave" type="button">保存</button><button id="kcancel" type="button">取消</button></div>
  </div>
  <div class="list" id="klist"><p class="empty">加载中…</p></div>
  <button class="more" id="kmore" type="button" style="display:none">加载更多</button>
  <div class="panel" style="margin-top:18px">
    <h3>最近问答（20 条）<span class="updated" id="ai-usage" style="margin-left:10px"></span></h3>
    <div class="list" id="ai-log"><p class="empty">加载中…</p></div>
    <h3 style="margin-top:18px">知识缺口（7 天 <span id="ai-miss-n">-</span>）<span style="font-weight:400;font-size:12px;color:#86868b">有回答但未命中任何知识的问题，按时间倒序</span></h3>
    <div class="list" id="ai-miss"><p class="empty">加载中…</p></div>
  </div>
</div>

<div id="view-acct" class="wrap" style="display:none">
  <div class="panel">
    <h3>当前登录</h3>
    <p id="acct-now" style="font-size:15px;font-weight:600"></p>
    <p class="tip" style="margin-top:6px">主账号「站长」的密码由服务器密钥 ADMIN_PASSWORD 配置，此处不可修改；下方添加的运营账号与其权限相同。切换账号：右上角账号菜单，或列表中的「切换到此账号」。</p>
  </div>
  <div class="panel">
    <h3>我的通行密钥</h3>
    <div class="vwrap"><table>
      <thead><tr><th>设备</th><th>添加时间</th><th style="width:8em">操作</th></tr></thead>
      <tbody id="pk-list"><tr><td colspan="3" class="empty">加载中…</td></tr></tbody>
    </table></div>
    <div class="ops" style="margin-top:12px"><button class="primary" id="pk-add" type="button">添加通行密钥</button><span id="pk-line" style="margin-left:10px;font-size:13px"></span></div>
    <p class="tip" style="margin-top:6px">通行密钥绑定当前账号（站长 / 运营账号各自独立），添加后在登录页「通行密钥」Tab 免密登录。注意：本门户在 Cloudflare Access 之后，通行密钥是第二道门内的免密方式，不能替代 Access。</p>
  </div>
  <div class="panel">
    <h3>添加账号</h3>
    <div class="mgrid" style="grid-template-columns:1fr 1fr;max-width:520px">
      <label>用户名（2-20 位字母/数字/_/-）<input id="a-user" maxlength="20" autocomplete="off"></label>
      <label>密码（至少 8 位）<input id="a-pass" type="password" maxlength="64" autocomplete="new-password"></label>
    </div>
    <div class="ops" style="margin-top:12px"><button class="primary" id="a-add" type="button">添加账号</button></div>
  </div>
  <div class="panel">
    <h3>运营账号</h3>
    <div class="vwrap"><table>
      <thead><tr><th>用户名</th><th>创建时间</th><th style="width:15em">操作</th></tr></thead>
      <tbody id="alist"><tr><td colspan="3" class="empty">加载中…</td></tr></tbody>
    </table></div>
  </div>
</div>

<script>
var state = { filter: 'unread', offset: 0, total: 0, unread: 0 };
var currentView = 'msg';
var visitDays = 30;
var vOffset = 0;
var KIND_LABEL = { direct: '直接访问', internal: '站内跳转', search: '搜索引擎', social: '社交媒体', referral: '外部链接', other: '其他' };
// 设备维度存的是采集端原始值（desktop…），展示前转中文；未收录的原样显示。
// 语言/来源站的归一化已在服务端 SQL 完成（按显示标签分组），前端拿到即最终标签，不会再出现多行同名
var DEVICE_LABEL = { desktop: '桌面端', mobile: '移动端', tablet: '平板', '—': '未知' };
function dimName(map, name) { return map[name] || name || '—'; }
// 图表配色（经色觉区分度与白底对比度校验）；「其他/未知」与长尾行用灰去强调
var C_PV = '#d64524', C_UV = '#2a78d6', C_NEW = '#129b74', C_GRAY = '#c9c9ce';
function fmtNum(n) { return (n || 0).toLocaleString('zh-CN'); }
// SQLite datetime（UTC）转「多久前」；超过两天退回月-日
function fmtAgo(utc) {
  var d = new Date(utc.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return utc;
  var s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 172800) return '昨天';
  return d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' });
}
// 该访客是否在所选时段内首访（与服务端 SINCE 同口径：北京时区零点起算）
function isRangeNew(first) {
  var d = new Date(first.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return false;
  var bj = new Date(Date.now() + 8 * 3600 * 1000);
  bj.setUTCHours(0, 0, 0, 0);
  return d.getTime() >= bj.getTime() - (visitDays - 1) * 86400000;
}

function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtTime(utc) {
  if (!utc) return '';
  var d = new Date(utc.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return utc;
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
function flag(code) {
  if (!code || code.length !== 2) return '';
  var cc = code.toUpperCase();
  if (cc === 'TW') cc = 'CN';
  return String.fromCodePoint(127397 + cc.charCodeAt(0), 127397 + cc.charCodeAt(1));
}
function fmtDur(sec) { return sec >= 60 ? Math.floor(sec / 60) + 'm' + Math.round(sec % 60) + 's' : sec + 's'; }

function api(path, opts) {
  return fetch(path, opts).then(function (r) {
    if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
    return r.json().then(function (d) {
      if (!r.ok || d.ok === false) throw new Error(d.error || r.status);
      return d;
    });
  });
}

/* ---------- 视图切换（当前板块记在 location.hash：刷新/前进后退不丢） ---------- */
var VIEWS = ['msg', 'visit', 'merch', 'tv', 'books', 'music', 'attra', 'ai', 'acct'];
var suppressHash = false;
function showView(v, skipHash) {
  if (VIEWS.indexOf(v) === -1) v = 'msg';
  currentView = v;
  el('view-msg').style.display = v === 'msg' ? '' : 'none';
  el('view-visit').style.display = v === 'visit' ? '' : 'none';
  el('view-merch').style.display = v === 'merch' ? '' : 'none';
  el('view-tv').style.display = v === 'tv' ? '' : 'none';
  el('view-books').style.display = v === 'books' ? '' : 'none';
  el('view-music').style.display = v === 'music' ? '' : 'none';
  el('view-attra').style.display = v === 'attra' ? '' : 'none';
  el('view-ai').style.display = v === 'ai' ? '' : 'none';
  el('view-acct').style.display = v === 'acct' ? '' : 'none';
  el('vtab-msg').classList.toggle('active', v === 'msg');
  el('vtab-visit').classList.toggle('active', v === 'visit');
  el('vtab-merch').classList.toggle('active', v === 'merch');
  el('vtab-tv').classList.toggle('active', v === 'tv');
  el('vtab-books').classList.toggle('active', v === 'books');
  el('vtab-music').classList.toggle('active', v === 'music');
  el('vtab-attra').classList.toggle('active', v === 'attra');
  el('vtab-ai').classList.toggle('active', v === 'ai');
  el('vtab-acct').classList.toggle('active', v === 'acct');
  if (v === 'msg') load(true);
  if (v === 'visit') { loadStats(); loadVisitors(true); loadTrackingState(); }
  if (v === 'merch') loadMerchants(true);
  if (v === 'tv') loadTv(true);
  if (v === 'books') loadBooks(true);
  if (v === 'music') loadMusic(true);
  if (v === 'attra') loadAttra(true);
  if (v === 'ai') loadAi();
  if (v === 'acct') loadAccounts();
  if (!skipHash && '#/' + v !== location.hash) {
    suppressHash = true;
    location.hash = '/' + v;
  }
}
window.addEventListener('hashchange', function () {
  if (suppressHash) { suppressHash = false; return; }
  showView(hashView(), true);
});
// 注意：APP_HTML 是模板字符串，内嵌脚本里写不了 /\/?/ 正则（\ 会被外层吃掉），用字符串替换解析 hash
function hashView() {
  return (location.hash || '').replace('#/', '').replace('#', '');
}
document.querySelectorAll('#view-visit .range [data-days]').forEach(function (b) {
  b.addEventListener('click', function () {
    visitDays = Number(b.getAttribute('data-days'));
    document.querySelectorAll('#view-visit .range [data-days]').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    loadStats(); loadVisitors(true);
  });
});

/* ---------- 留言管理 ---------- */
function load(reset) {
  if (reset) { state.offset = 0; el('list').innerHTML = '<p class="empty">加载中…</p>'; }
  var q = '?filter=' + state.filter + '&offset=' + state.offset;
  api('/api/messages' + q).then(function (d) {
    state.total = d.total; state.unread = d.unread;
    el('stats').textContent = '共 ' + d.total + ' 条留言，未读 ' + d.unread + ' 条';
    var list = d.messages || [];
    var box = el('list');
    if (reset) box.innerHTML = '';
    if (reset && list.length === 0) {
      box.innerHTML = '<p class="empty">' + (state.filter === 'unread' ? '没有未读留言 🎉' : '还没有留言') + '</p>';
    } else {
      list.forEach(function (m) { box.appendChild(render(m)); });
    }
    el('more').style.display = (state.offset + ${PAGE_SIZE} < d.total && list.length > 0) ? 'block' : 'none';
  }).catch(function (e) {
    if (e.message !== 'unauthorized') el('list').innerHTML = '<p class="empty">加载失败：' + esc(e.message) + '</p>';
  });
}

function render(m) {
  var div = document.createElement('div');
  div.className = 'msg' + (m.read_at ? ' read' : '');
  var emailHtml = m.email
    ? '<div class="email"><a href="mailto:' + esc(m.email) + '">' + esc(m.email) + '</a></div>' : '';
  div.innerHTML =
    '<div class="row1"><span class="name">' + esc(m.name) + '</span>' + emailHtml + '<span class="dot"></span></div>' +
    '<div class="time">' + esc(fmtTime(m.created_at)) + (m.read_at ? ' · 已读' : ' · 未读') + '</div>' +
    '<div class="body">' + esc(m.message) + '</div>' +
    '<div class="meta">IP ' + esc(m.ip || '—') + ' · ' + esc(m.user_agent || '') + '</div>' +
    '<div class="ops"><button type="button" data-act="read">' + (m.read_at ? '标为未读' : '标为已读') + '</button>' +
    '<button type="button" data-act="del">删除</button></div>';
  var ops = div.querySelector('.ops');
  ops.addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act');
    if (act === 'read') {
      api('/api/messages/' + m.id + '/read', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ read: !m.read_at })
      }).then(function () { load(true); });
    } else if (act === 'del') {
      if (!confirm('确定删除 ' + m.name + ' 的这条留言？不可恢复。')) return;
      api('/api/messages/' + m.id, { method: 'DELETE' }).then(function () { load(true); });
    }
  });
  return div;
}

el('tab-unread').addEventListener('click', function () {
  state.filter = 'unread';
  el('tab-unread').classList.add('active'); el('tab-all').classList.remove('active');
  load(true);
});
el('tab-all').addEventListener('click', function () {
  state.filter = 'all';
  el('tab-all').classList.add('active'); el('tab-unread').classList.remove('active');
  load(true);
});

/* ---------- 访客分析 ---------- */
var includeBots = false;
var autoRefresh = false; // 默认关：30s×全表扫描烧 D1 读额度（docs/访客治理方案.md R1，阶段一将改造间隔口径）

var lastStats = null;
var dimMetric = 'pv';
var barDataStore = {};
var barOpen = {};
var barSingle = {};
var BAR_IDS = ['kinds', 'sources', 'devices', 'browsers', 'os', 'langs', 'countries', 'entries', 'depth'];

function loadStats(fresh) {
  el('updated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  api('/api/stats?days=' + visitDays + (includeBots ? '&bots=1' : '') + (fresh ? '&fresh=1' : '')).then(function (d) {
    lastStats = d;
    renderCards(d);
    renderSparks(d);
    registerBars(d);
    renderBarsAll();
    renderChart();
    fillTable('top-pages', d.top_pages, function (p) {
      return '<tr><td>' + esc(p.path) + '</td><td>' + fmtNum(p.pv) + '</td><td>' + fmtNum(p.uv) + '</td><td>' + fmtDur(p.avg_s) + '</td></tr>';
    });
    el('recent').innerHTML = (d.recent || []).map(function (r) {
      return '<tr><td>' + esc(fmtTime(r.created_at)) + '</td><td>' + esc(r.path) + '</td><td>' +
        '<span class="k-badge">' + esc(KIND_LABEL[r.kind] || r.kind) + '</span></td><td>' +
        (flag(r.country) || '') + ' ' + esc(dimName(DEVICE_LABEL, r.device)) + '</td><td>' + fmtDur(Math.round((r.engage_ms || 0) / 1000)) + '</td></tr>';
    }).join('') || '<tr><td class="empty">暂无数据</td></tr>';
  }).catch(function (e) {
    if (e.message !== 'unauthorized') el('chart-empty').textContent = '加载失败：' + esc(e.message);
  });
}

function renderCards(d) {
  el('c-pv').textContent = fmtNum(d.cards.pv);
  el('c-uv').textContent = fmtNum(d.cards.uv);
  el('c-sessions').textContent = fmtNum(d.cards.sessions);
  el('c-bounce').textContent = d.cards.bounce + '%';
  el('c-avg').textContent = fmtDur(d.cards.avg_time_s);
  el('c-new').textContent = d.cards.uv ? Math.round((d.cards.new_uv / d.cards.uv) * 100) + '%' : '0%';
  el('c-pps').textContent = d.cards.pages_per_session;
  var dl = d.cards.delta_pv;
  el('c-delta').textContent = dl === null ? '—' : (dl >= 0 ? '▲ ' : '▼ ') + Math.abs(dl) + '%';
  el('c-delta').style.color = dl === null ? '#86868b' : (dl >= 0 ? '#1a7f37' : '#d64524');
  el('c-live').textContent = fmtNum(d.live5);
}

function renderSparks(d) {
  var daily = d.daily || [];
  drawSpark('sp-pv', daily.map(function (x) { return x.pv; }), C_PV);
  drawSpark('sp-uv', daily.map(function (x) { return x.uv; }), C_UV);
  drawSpark('sp-sess', daily.map(function (x) { return x.sessions || 0; }), C_GRAY);
}

/* ---------- 维度条形（Top 6 + 长尾折叠） ---------- */
// 登记一个维度的数据并渲染；single = 单指标卡（入口页/浏览深度，数值本身就是会话数）
function barData(id, rows, single) {
  barDataStore[id] = rows;
  barSingle[id] = !!single;
  renderBars(id);
}

function registerBars(d) {
  barData('kinds', (d.kinds || []).map(function (k) {
    var label = k.label || k.kind;
    return { label: label, pv: k.pv, uv: k.sessions, uvLabel: '会话', dim: label === '其他' };
  }));
  barData('sources', (d.sources || []).map(function (s) {
    return { label: s.src, pv: s.pv, uv: s.sessions, uvLabel: '会话' };
  }));
  barData('devices', (d.devices || []).map(function (x) {
    var n = dimName(DEVICE_LABEL, x.name);
    return { label: n, pv: x.pv, uv: x.uv, dim: n === '未知' };
  }));
  barData('browsers', (d.browsers || []).map(function (x) {
    var n = x.name === 'Other' ? '其他' : (x.name || '—');
    return { label: n, pv: x.pv, uv: x.uv, dim: n === '其他' || n === '—' };
  }));
  barData('os', (d.os || []).map(function (x) {
    var n = x.name === 'Other' ? '其他' : (x.name || '—');
    return { label: n, pv: x.pv, uv: x.uv, dim: n === '其他' || n === '—' };
  }));
  barData('langs', (d.langs || []).map(function (x) {
    return { label: x.name || '未知', pv: x.pv, uv: x.uv, dim: !x.name || x.name === '未知' };
  }));
  barData('countries', (d.countries || []).map(function (c) {
    return { label: (flag(c.name) || '') + ' ' + (c.name || '未知'), pv: c.pv, uv: c.uv, dim: !c.name || c.name === '未知' };
  }));
  barData('entries', (d.entries || []).map(function (x) {
    return { label: x.path, pv: x.n, uv: x.n, pvLabel: '会话', uvLabel: '会话', one: true };
  }), true);
  var dp = d.depth || {};
  barData('depth', [
    { label: '只看 1 页', pv: dp.d1, uv: dp.d1, pvLabel: '会话', uvLabel: '会话', one: true },
    { label: '2-3 页', pv: dp.d23, uv: dp.d23, pvLabel: '会话', uvLabel: '会话', one: true },
    { label: '4 页以上', pv: dp.d4p, uv: dp.d4p, pvLabel: '会话', uvLabel: '会话', one: true },
  ], true);
}

function renderBarsAll() { BAR_IDS.forEach(renderBars); }

function renderBars(id) {
  var rows = barDataStore[id] || [];
  var box = el(id);
  if (!rows.length) { box.innerHTML = '<div class="bar-row"><span class="label" style="color:#86868b">暂无数据</span></div>'; return; }
  var m = dimMetric === 'uv' ? 'uv' : 'pv';
  var max = 0, sum = 0;
  rows.forEach(function (r) { var v = r[m] || 0; if (v > max) max = v; sum += v; });
  var TOPN = 6, tail = null, show = rows;
  if (!barOpen[id] && rows.length > TOPN) {
    // 折叠长尾：默认只展示 Top 6，其余聚合成一行灰色的「其余 N 项」
    show = rows.slice(0, TOPN);
    tail = { label: '其余 ' + (rows.length - TOPN) + ' 项', pv: 0, uv: 0, dim: true, tail: true, uvLabel: rows[0].uvLabel, pvLabel: rows[0].pvLabel };
    rows.slice(TOPN).forEach(function (r) { tail.pv += r.pv || 0; tail.uv += r.uv || 0; });
  } else if (barOpen[id] && rows.length > TOPN) {
    tail = { label: '收起', tail: true, open: true };
  }
  var html = show.map(function (r) { return barRow(r, m, max, sum); }).join('');
  if (tail) html += barRow(tail, m, max, sum);
  box.innerHTML = html;
}

function barRow(r, m, max, sum) {
  if (r.tail && r.open) {
    return '<div class="bar-row tailrow"><span class="label">收起 ▴</span><div class="bar-track"></div><div class="bar-val"></div></div>';
  }
  var v = r[m] || 0;
  var w = max ? Math.round((v / max) * 100) : 0;
  var pct = sum ? Math.round((v / sum) * 100) : 0;
  var u1 = m === 'pv' ? (r.pvLabel || '浏览') : (r.uvLabel || '访客');
  var val = '<b>' + fmtNum(v) + '</b><span class="u"> ' + u1 + ' · ' + pct + '%</span>';
  if (!r.one) {
    var other = m === 'pv' ? { v: r.uv || 0, u: r.uvLabel || '访客' } : { v: r.pv || 0, u: r.pvLabel || '浏览' };
    val += '<small>' + fmtNum(other.v) + ' ' + other.u + '</small>';
  }
  return '<div class="bar-row' + (r.dim ? ' dimrow' : '') + (r.tail ? ' tailrow' : '') + '">' +
    '<span class="label" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
    '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%"></div></div>' +
    '<div class="bar-val">' + val + '</div></div>';
}

function fillTable(id, rows, fn) {
  // 行回调须返回 <tr>…</tr>；漏写时兜底补上 —— 否则全部单元格并入一行，
  // fixed 布局下多出的列宽为 0，路径文字会 1 字/行竖排（热门页面表格曾踩此坑）
  el(id).innerHTML = (rows && rows.length)
    ? rows.map(function (x) { var r = fn(x); return /^<tr[\\s>]/.test(r) ? r : '<tr>' + r + '</tr>'; }).join('')
    : '<tr><td class="empty">暂无数据</td></tr>';
}

function fillBars(id, rows, single) {
  var max = 0;
  (rows || []).forEach(function (r) { if (r.pv > max) max = r.pv; });
  el(id).innerHTML = (rows && rows.length)
    ? rows.map(function (r) {
        var w = max ? Math.round((r.pv / max) * 100) : 0;
        return '<div class="bar-row"><span class="label" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%"></div></div>' +
          '<b>' + (single ? r.pv : r.uv + ' 访客 · ' + r.pv + ' 浏览') + '</b></div>';
      }).join('')
    : '<div class="bar-row"><span class="label dim">暂无数据</span></div>';
}

/* ---------- 趋势图（等比 SVG + 十字线悬浮读数 + 数据表视图） ---------- */
function drawSpark(id, vals, color) {
  var svg = el(id);
  vals = vals || [];
  if (!vals.length) { svg.innerHTML = ''; return; }
  var W = svg.clientWidth || 160, H = 36;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  var max = 1;
  vals.forEach(function (v) { if (v > max) max = v; });
  var step = vals.length > 1 ? (W - 6) / (vals.length - 1) : 0;
  var pts = vals.map(function (v, i) {
    return (3 + i * step).toFixed(1) + ',' + (H - 5 - (v / max) * (H - 12)).toFixed(1);
  }).join(' ');
  var lx = 3 + (vals.length - 1) * step;
  var ly = H - 5 - (vals[vals.length - 1] / max) * (H - 12);
  svg.innerHTML = '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity=".4"/>' +
    '<circle cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="2.5" fill="' + color + '"/>';
}

// 纵轴上限取 2/4/8 × 10 的幂，保证四等分刻度都是整洁数
function niceCeil(v) {
  var k = Math.pow(10, Math.floor(Math.log10(Math.max(1, v))));
  var c = [2 * k, 4 * k, 8 * k];
  for (var i = 0; i < c.length; i++) { if (c[i] >= v) return c[i]; }
  return 20 * k;
}
function fmtTick(v) {
  var r = Math.round(v * 10) / 10;
  return r >= 1000 ? (r / 1000).toFixed(r % 1000 ? 1 : 0) + 'k' : String(r);
}

var chartTableMode = false;

function renderChart() {
  var svg = el('chart');
  var daily = (lastStats && lastStats.daily) || [];
  el('chart-empty').textContent = daily.length ? '' : '暂无数据';
  el('chart').style.display = chartTableMode ? 'none' : '';
  el('chart-legend').style.display = chartTableMode ? 'none' : '';
  el('chart-table').style.display = chartTableMode ? '' : 'none';
  buildChartTable(daily);
  if (chartTableMode || !daily.length) { svg.innerHTML = ''; return; }
  // viewBox 按渲染时的实际像素宽生成（1:1 绘制），线条与圆点不会因拉伸变形；resize 时重绘
  var W = svg.clientWidth || 900, H = 260;
  var P = { t: 12, r: 66, b: 26, l: 46 };
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  var maxV = 1;
  daily.forEach(function (d) { if (d.pv > maxV) maxV = d.pv; if (d.uv > maxV) maxV = d.uv; });
  var yMax = niceCeil(maxV);
  var n = daily.length;
  var step = n > 1 ? (W - P.l - P.r) / (n - 1) : 0;
  function X(i) { return P.l + i * step; }
  function Y(v) { return P.t + (1 - (v || 0) / yMax) * (H - P.t - P.b); }
  var grid = '';
  for (var g = 0; g <= 4; g++) {
    var gy = Y(yMax * (4 - g) / 4);
    grid += '<line x1="' + P.l + '" y1="' + gy.toFixed(1) + '" x2="' + (W - P.r) + '" y2="' + gy.toFixed(1) + '" stroke="#eef0f2" stroke-width="1"/>' +
      '<text x="' + (P.l - 8) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end">' + fmtTick(yMax * (4 - g) / 4) + '</text>';
  }
  var tickEvery = Math.max(1, Math.ceil(n / 6));
  var xlab = '';
  for (var i = 0; i < n; i += tickEvery) {
    xlab += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + daily[i].d.slice(5) + '</text>';
  }
  if ((n - 1) % tickEvery !== 0) {
    xlab += '<text x="' + X(n - 1).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + daily[n - 1].d.slice(5) + '</text>';
  }
  function line(key, color) {
    var pts = daily.map(function (d, i) { return X(i).toFixed(1) + ',' + Y(d[key]).toFixed(1); }).join(' ');
    return '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  }
  // 31 天内逐日画点（白描边防重叠糊住）；更长时段靠十字线读数
  var dots = n <= 31 ? daily.map(function (d, i) {
    return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(d.pv).toFixed(1) + '" r="3" fill="' + C_PV + '" stroke="#fff" stroke-width="2"/>' +
      '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(d.uv).toFixed(1) + '" r="3" fill="' + C_UV + '" stroke="#fff" stroke-width="2"/>' +
      '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(d.new_uv).toFixed(1) + '" r="3" fill="' + C_NEW + '" stroke="#fff" stroke-width="2"/>';
  }).join('') : '';
  // 线端直标数值（重叠时向下错开 14px）
  var ends = [
    { v: daily[n - 1].pv, color: C_PV },
    { v: daily[n - 1].uv, color: C_UV },
    { v: daily[n - 1].new_uv, color: C_NEW },
  ];
  ends.forEach(function (e) { e.y = Y(e.v); });
  ends.sort(function (a, b) { return a.y - b.y; });
  for (var j = 1; j < ends.length; j++) { if (ends[j].y - ends[j - 1].y < 14) ends[j].y = ends[j - 1].y + 14; }
  var elab = '';
  ends.forEach(function (e) {
    elab += '<rect x="' + (W - P.r + 6) + '" y="' + (e.y - 1.5).toFixed(1) + '" width="8" height="3" rx="1.5" fill="' + e.color + '"/>' +
      '<text x="' + (W - P.r + 18) + '" y="' + (e.y + 4).toFixed(1) + '">' + fmtNum(e.v) + '</text>';
  });
  svg.innerHTML = grid + line('pv', C_PV) + line('uv', C_UV) + line('new_uv', C_NEW) + dots + elab + xlab +
    '<line id="xhair" x1="0" x2="0" y1="' + P.t + '" y2="' + (H - P.b) + '" stroke="#c7c7cc" stroke-width="1" style="display:none"/>' +
    '<g id="xdots" style="display:none"></g>' +
    '<rect id="chart-hit" x="' + P.l + '" y="0" width="' + (W - P.l - P.r) + '" height="' + H + '" fill="transparent"/>';
  bindChartInteraction(svg, daily, X, Y, P, step, n);
}

function bindChartInteraction(svg, daily, X, Y, P, step, n) {
  var tip = el('chart-tip');
  function showIdx(i) {
    i = Math.max(0, Math.min(n - 1, i));
    svg._cur = i;
    var x = X(i).toFixed(1);
    var ln = document.getElementById('xhair');
    var gd = document.getElementById('xdots');
    if (!ln || !gd) return;
    ln.setAttribute('x1', x); ln.setAttribute('x2', x); ln.style.display = '';
    gd.innerHTML = '<circle cx="' + x + '" cy="' + Y(daily[i].pv).toFixed(1) + '" r="4" fill="' + C_PV + '" stroke="#fff" stroke-width="2"/>' +
      '<circle cx="' + x + '" cy="' + Y(daily[i].uv).toFixed(1) + '" r="4" fill="' + C_UV + '" stroke="#fff" stroke-width="2"/>' +
      '<circle cx="' + x + '" cy="' + Y(daily[i].new_uv).toFixed(1) + '" r="4" fill="' + C_NEW + '" stroke="#fff" stroke-width="2"/>';
    gd.style.display = '';
    // tooltip 内容用 textContent 构建（来源数据不可拼进 innerHTML）
    tip.innerHTML = '';
    var h = document.createElement('div');
    h.className = 'tt-date';
    h.textContent = daily[i].d;
    tip.appendChild(h);
    [['浏览量', daily[i].pv, C_PV], ['访客数', daily[i].uv, C_UV], ['新访客', daily[i].new_uv, C_NEW]].forEach(function (row) {
      var r = document.createElement('div');
      r.className = 'tt-row';
      var k = document.createElement('i');
      k.className = 'tt-key';
      k.style.background = row[2];
      var s = document.createElement('span');
      s.textContent = row[0];
      var b = document.createElement('b');
      b.textContent = fmtNum(row[1]);
      r.appendChild(k); r.appendChild(s); r.appendChild(b);
      tip.appendChild(r);
    });
    tip.style.display = 'block';
    // 定位：SVG 无 offsetLeft/Top，用相对面板的 rect 差值换算（tooltip 绝对定位于面板）
    var pr = svg.parentElement.getBoundingClientRect();
    var sr = svg.getBoundingClientRect();
    var sx = sr.left - pr.left, sy = sr.top - pr.top;
    var px = sx + X(i) + 14;
    if (px + tip.offsetWidth + 8 > sx + svg.clientWidth) px = sx + X(i) - tip.offsetWidth - 14;
    tip.style.left = Math.max(sx, px) + 'px';
    tip.style.top = (sy + P.t + 6) + 'px';
  }
  function hideTip() {
    var ln = document.getElementById('xhair');
    var gd = document.getElementById('xdots');
    if (ln) ln.style.display = 'none';
    if (gd) gd.style.display = 'none';
    tip.style.display = 'none';
    svg._cur = null;
  }
  var hit = document.getElementById('chart-hit');
  hit.addEventListener('pointermove', function (e) {
    var rect = svg.getBoundingClientRect();
    showIdx(Math.round((e.clientX - rect.left - P.l) / (step || 1)));
  });
  hit.addEventListener('pointerleave', hideTip);
  // 键盘可达：聚焦后左右方向键逐日读数，与悬浮同一份信息
  svg._show = showIdx; svg._hide = hideTip; svg._n = n;
  if (!svg.dataset.kbd) {
    svg.dataset.kbd = '1';
    svg.addEventListener('focus', function () { if (svg._show && svg._n) svg._show(svg._n - 1); });
    svg.addEventListener('blur', function () { if (svg._hide) svg._hide(); });
    svg.addEventListener('keydown', function (e) {
      if (!svg._n || !svg._show) return;
      var cur = svg._cur == null ? svg._n - 1 : svg._cur;
      if (e.key === 'ArrowLeft') cur = Math.max(0, cur - 1);
      else if (e.key === 'ArrowRight') cur = Math.min(svg._n - 1, cur + 1);
      else return;
      e.preventDefault();
      svg._show(cur);
    });
  }
}

function buildChartTable(daily) {
  el('chart-table-body').innerHTML = (daily || []).slice().reverse().map(function (d) {
    return '<tr><td>' + esc(d.d) + '</td><td>' + fmtNum(d.pv) + '</td><td>' + fmtNum(d.uv) + '</td><td>' + fmtNum(d.new_uv) + '</td></tr>';
  }).join('') || '<tr><td colspan="4" class="empty">暂无数据</td></tr>';
}

var vOffset = 0;
function loadVisitors(reset, fresh) {
  if (reset) { vOffset = 0; el('vlist').innerHTML = '<tr><td colspan="7" class="empty">加载中…</td></tr>'; }
  api('/api/visitors?offset=' + vOffset + (includeBots ? '&bots=1' : '') + '&days=' + visitDays + (fresh ? '&fresh=1' : '')).then(function (d) {
    var box = el('vlist');
    if (reset) box.innerHTML = '';
    if (reset && (!d.visitors || d.visitors.length === 0)) {
      box.innerHTML = '<tr><td colspan="7" class="empty">还没有访问记录</td></tr>';
      el('vmore').style.display = 'none';
      return;
    }
    d.visitors.forEach(function (v) { box.appendChild(renderVisitor(v)); });
    el('vmore').style.display = (vOffset + ${PAGE_SIZE} < d.total && d.visitors.length > 0) ? 'block' : 'none';
  }).catch(function (e) {
    if (e.message !== 'unauthorized') el('vlist').innerHTML = '<tr><td colspan="7" class="empty">加载失败：' + esc(e.message) + '</td></tr>';
  });
}

function renderVisitor(v) {
  var tr = document.createElement('tr');
  tr.className = 'vrow';
  tr.innerHTML =
    '<td title="最近 ' + esc(fmtTime(v.last)) + ' · 首次 ' + esc(fmtTime(v.first)) + '">' + esc(fmtAgo(v.last)) +
      (isRangeNew(v.first) ? '<span class="new-badge">新</span>' : '') + '</td>' +
    '<td><span class="flag">' + flag(v.country) + '</span>' + esc(v.country || '—') + '</td>' +
    '<td>' + esc(dimName(DEVICE_LABEL, v.device)) + '</td>' +
    '<td>' + esc(v.browser || '—') + ' · ' + esc(v.os || '—') + '</td>' +
    '<td>' + fmtNum(v.views) + '</td><td>' + fmtNum(v.sessions) + '</td>' +
    '<td>' + esc(fmtTime(v.first)) + '</td>';
  tr.addEventListener('click', function () {
    var open = tr.dataset.open === '1';
    var existing = tr.nextElementSibling;
    if (open && existing && existing.className === 'detail') { existing.remove(); tr.dataset.open = ''; return; }
    if (existing && existing.className === 'detail') existing.remove();
    tr.dataset.open = '1';
    var det = document.createElement('tr');
    det.className = 'detail';
    det.innerHTML = '<td colspan="7">加载中…</td>';
    tr.after(det);
    api('/api/visitors/' + encodeURIComponent(v.gid) + (includeBots ? '&bots=1' : '')).then(function (d) {
      det.innerHTML = '<td colspan="7">' +
        '<div style="margin-bottom:8px">共 ' + d.n + ' 次浏览 · 首次 ' + esc(fmtTime(d.first)) + ' · 最近 ' + esc(fmtTime(d.last)) + '</div>' +
        '<table><tr><th>时间</th><th>页面</th><th>来源</th><th>地区</th><th>设备</th><th>停留</th></tr>' +
        (d.views || []).map(function (w) {
          return '<tr><td>' + esc(fmtTime(w.created_at)) + '</td><td>' + esc(w.path) + '</td><td>' +
            esc(KIND_LABEL[w.kind] || w.kind || '—') + (w.ref_host ? '（' + esc(w.ref_host) + '）' : '') + '</td><td>' +
            (flag(w.country) || '') + ' ' + esc(w.country || '—') + '</td><td>' + esc(dimName(DEVICE_LABEL, w.device)) + '</td><td>' +
            fmtDur(Math.round((w.engage_ms || 0) / 1000)) + '</td></tr>';
        }).join('') + '</table></td>';
    }).catch(function (e) {
      det.innerHTML = '<td colspan="7">加载失败：' + esc(e.message) + '</td>';
    });
  });
  return tr;
}

el('vrefresh').addEventListener('click', function () { loadStats(true); loadVisitors(true, true); });
el('include-bots').addEventListener('change', function (e) { includeBots = e.target.checked; loadStats(); loadVisitors(true); });

/* ---------- 访客采集总开关（site_settings.visit_tracking，docs/访客治理方案.md） ---------- */
var trackingOn = true;
function setTrackingUi(on) {
  trackingOn = on;
  el('visit-tracking').checked = on;
  el('tracking-note').style.display = on ? 'none' : 'block';
}
function loadTrackingState() {
  api('/api/visitor-tracking').then(function (d) { setTrackingUi(d.on); }).catch(function () {});
}
el('visit-tracking').addEventListener('change', function (e) {
  var on = e.target.checked;
  api('/api/visitor-tracking', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: on }) })
    .then(function (d) { setTrackingUi(d.on); })
    .catch(function () { e.target.checked = trackingOn; }); // 失败回滚开关显示
});
el('auto-refresh').addEventListener('change', function (e) { autoRefresh = e.target.checked; });
// 维度条长指标切换（浏览/访客）——数据已缓存，切换只重绘不发请求
document.querySelectorAll('#view-visit .dimm [data-metric]').forEach(function (b) {
  b.addEventListener('click', function () {
    var m = b.getAttribute('data-metric');
    if (dimMetric === m) return;
    dimMetric = m;
    document.querySelectorAll('#view-visit .dimm [data-metric]').forEach(function (x) { x.classList.toggle('active', x === b); });
    renderBarsAll();
  });
});
// 长尾折叠行点击展开/收起（事件委托：行内容会被整体重绘）
BAR_IDS.forEach(function (id) {
  el(id).addEventListener('click', function (e) {
    if (!e.target.closest('.tailrow')) return;
    barOpen[id] = !barOpen[id];
    renderBars(id);
  });
});
// 趋势图与数据表互切；stopPropagation 防止触发面板折叠
el('chart-table-toggle').addEventListener('click', function (e) {
  e.stopPropagation();
  chartTableMode = !chartTableMode;
  this.textContent = chartTableMode ? '趋势图' : '数据表';
  renderChart();
});
// viewBox 按渲染时实际像素宽生成，窗口尺寸变化后重绘一次
var rszT = 0;
window.addEventListener('resize', function () {
  if (currentView !== 'visit' || !lastStats) return;
  clearTimeout(rszT);
  rszT = setTimeout(function () { renderSparks(lastStats); renderChart(); }, 150);
});
setInterval(function () {
  if (currentView === 'visit' && autoRefresh && document.visibilityState === 'visible') { loadStats(); loadVisitors(false); }
}, 120000); // 2 分钟（docs/访客治理方案.md R1：默认关 + 拉长间隔；命中服务端 60s 缓存则不碰库）
document.querySelectorAll('#view-visit .panel').forEach(function (p) {
  p.classList.add('collapsible');
  p.querySelector('h3').addEventListener('click', function () { p.classList.toggle('collapsed'); });
});
el('refresh').addEventListener('click', function () {
  if (currentView === 'visit') { loadStats(); loadVisitors(true); }
  else if (currentView === 'merch') { loadMerchants(true); }
  else if (currentView === 'tv') { loadTv(true); }
  else if (currentView === 'books') { loadBooks(true); }
  else if (currentView === 'music') { loadMusic(true); }
  else if (currentView === 'attra') { loadAttra(true); }
  else if (currentView === 'acct') { loadAccounts(); }
  else { load(true); }
});
el('more').addEventListener('click', function () { state.offset += ${PAGE_SIZE}; load(false); });
el('vmore').addEventListener('click', function () { vOffset += ${PAGE_SIZE}; loadVisitors(false); });

/* ---------- 商户管理 ---------- */
var mState = { status: '', offset: 0 };
var editingId = null;
var M_CAT = { food: '美食', stay: '住宿', specialty: '特产', fireworks: '花炮', other: '其他' };
var M_STATUS = { pending: '待审核', approved: '已上线', rejected: '已驳回', expired: '已过期' };
var M_TIER = { free: '基础', verified: '认证', featured: '置顶' };

document.querySelectorAll('#view-merch .range [data-mst]').forEach(function (b) {
  b.addEventListener('click', function () {
    mState.status = b.getAttribute('data-mst');
    document.querySelectorAll('#view-merch .range [data-mst]').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    loadMerchants(true);
  });
});

function loadMerchants(reset) {
  if (reset) mState.offset = 0;
  var q = '?offset=' + mState.offset + (mState.status ? '&status=' + mState.status : '');
  api('/api/merchants' + q).then(function (d) {
    var list = d.merchants || [];
    var counts = d.byStatus || {};
    el('mstats').textContent = '共 ' + d.total + ' 家 · 待审核 ' + (counts.pending || 0) + ' · 已上线 ' + (counts.approved || 0);
    var box = el('mlist');
    if (reset) box.innerHTML = '';
    if (reset && list.length === 0) {
      box.innerHTML = '<p class="empty">还没有商户，点右上「新增商户」录入第一家。</p>';
    } else {
      list.forEach(function (x) { box.appendChild(renderMerchant(x)); });
    }
    el('mmore').style.display = (mState.offset + ${PAGE_SIZE} < d.total && list.length > 0) ? 'block' : 'none';
  }).catch(function (e) {
    if (e.message !== 'unauthorized') el('mlist').innerHTML = '<p class="empty">加载失败：' + esc(e.message) + '</p>';
  });
}

function renderMerchant(x) {
  var div = document.createElement('div');
  div.className = 'msg' + (x.status !== 'pending' ? ' read' : '');
  var meta = [];
  if (x.address) meta.push(x.address);
  if (x.phone) meta.push('☎ ' + x.phone);
  if (x.contact_name) meta.push('联系人 ' + x.contact_name + (x.contact_phone ? ' ' + x.contact_phone : ''));
  if (x.paid_until) {
    var overdue = x.paid_until < new Date().toISOString().slice(0, 10);
    meta.push((overdue ? '⚠️已到期 ' : '付费到期 ') + x.paid_until);
  }
  var redeemBadge = x.tier_request
    ? '<div class="mrow-pay">💰 待核销：申请「' + esc(M_TIER[x.tier_request] || x.tier_request) + '」' +
      (x.paid_requested_at ? '（' + esc(x.paid_requested_at) + ' 提交）' : '') + '</div>'
    : '';
  var thumb = merchantImg(x.cover)
    ? '<img class="vthumb" loading="lazy" alt="" src="' + esc(merchantImg(x.cover)) + '">'
    : '<div class="vthumb"></div>';
  div.innerHTML =
    '<div class="vrow1">' + thumb +
    '<div style="min-width:0;flex:1">' +
    '<div class="row1"><span class="name">' + esc(x.name) + '</span>' +
    '<span class="k-badge">' + esc(M_CAT[x.category] || x.category) + '</span>' +
    '<span class="k-badge">' + esc(M_TIER[x.tier] || x.tier) + '</span>' +
    '<span class="mst mst-' + esc(x.status) + '">' + esc(M_STATUS[x.status] || x.status) + '</span>' +
    (x.slug && x.status === 'approved'
      ? '<a class="mslug" href="https://whizzzest.com/merchants/' + esc(x.slug) + '/" target="_blank" rel="noopener">查看页面 ↗</a>'
      : '') +
    '</div>' +
    (x.intro ? '<div class="time">' + esc(x.intro) + '</div>' : '') +
    (x.reject_reason ? '<div class="meta">驳回原因：' + esc(x.reject_reason) + '</div>' : '') +
    redeemBadge +
    (meta.length ? '<div class="meta">' + esc(meta.join(' · ')) + '</div>' : '') +
    '</div></div>' +
    '<div class="ops">' +
    (x.status === 'pending'
      ? '<button type="button" data-act="ok" class="primary">通过上线</button><button type="button" data-act="rej">驳回</button>' : '') +
    (x.tier_request
      ? '<button type="button" data-act="redeem" class="primary">确认收款 · 开通' + esc(M_TIER[x.tier_request] || x.tier_request) + '</button>' : '') +
    (x.status === 'approved' && !x.tier_request ? '<button type="button" data-act="off">下线</button>' : '') +
    '<button type="button" data-act="edit">编辑</button>' +
    '<button type="button" data-act="del">删除</button></div>';
  div.querySelector('.ops').addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act');
    if (act === 'ok') {
      api('/api/merchants/' + x.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      }).then(function () { loadMerchants(true); });
    } else if (act === 'rej') {
      var reason = prompt('驳回原因（会展示给商户）：');
      if (reason === null) return;
      api('/api/merchants/' + x.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'rejected', reject_reason: reason || '资料待完善' })
      }).then(function () { loadMerchants(true); });
    } else if (act === 'off') {
      api('/api/merchants/' + x.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'expired' })
      }).then(function () { loadMerchants(true); });
    } else if (act === 'redeem') {
      if (!confirm('确认已收到「' + x.name + '」的' + (M_TIER[x.tier_request] || x.tier_request) + '年费？将开通一年并清除待核销。')) return;
      api('/api/merchants/' + x.id + '/redeem', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: x.tier_request })
      }).then(function () { loadMerchants(true); });
    } else if (act === 'edit') {
      openForm(x);
    } else if (act === 'del') {
      // 二次点击确认：首击变红待确认，4 秒未点自动复原；第二击才真正删除（含图片，不可恢复）
      var btn = e.target;
      if (btn.getAttribute('data-armed') !== '1') {
        btn.setAttribute('data-armed', '1');
        btn.className = 'danger';
        btn.textContent = '确认删除（含图片）';
        setTimeout(function () {
          if (!btn.isConnected) return;
          btn.removeAttribute('data-armed');
          btn.className = '';
          btn.textContent = '删除';
        }, 4000);
        return;
      }
      api('/api/merchants/' + x.id, { method: 'DELETE' }).then(function () { loadMerchants(true); });
    }
  });
  return div;
}

function val(id) { return el(id).value.trim(); }

function openForm(x) {
  editingId = x ? x.id : null;
  el('mform-title').textContent = x ? '编辑商户 #' + x.id : '新增商户';
  el('f-name').value = x ? x.name || '' : '';
  el('f-cat').value = x ? x.category || 'food' : 'food';
  el('f-tier').value = x ? x.tier || 'free' : 'free';
  el('f-status').value = x ? x.status || 'pending' : 'pending';
  el('f-slug').value = x ? x.slug || '' : '';
  el('f-paid').value = x ? x.paid_until || '' : '';
  el('f-weight').value = x ? x.sort_weight || 0 : 0;
  el('f-cover').value = x ? x.cover || '' : '';
  el('f-coverfile').value = '';
  el('f-coverinfo').textContent = x && x.cover ? '当前封面：' + x.cover : '';
  setCoverPrev(x && x.cover ? merchantImg(x.cover) : '');
  el('f-intro').value = x ? x.intro || '' : '';
  el('f-detail').value = x ? x.detail || '' : '';
  el('f-address').value = x ? x.address || '' : '';
  el('f-phone').value = x ? x.phone || '' : '';
  el('f-wechat').value = x ? x.wechat || '' : '';
  el('f-hours').value = x ? x.hours || '' : '';
  el('f-cname').value = x ? x.contact_name || '' : '';
  el('f-cphone').value = x ? x.contact_phone || '' : '';
  el('mform').style.display = '';
  el('mform').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeForm() { el('mform').style.display = 'none'; editingId = null; }

el('madd').addEventListener('click', function () { openForm(null); });
el('fcancel').addEventListener('click', closeForm);
el('fsave').addEventListener('click', function () {
  var payload = {
    name: val('f-name'), category: val('f-cat'), tier: val('f-tier'), status: val('f-status'),
    slug: val('f-slug'), paid_until: val('f-paid'), sort_weight: Number(val('f-weight') || 0),
    cover: val('f-cover'), intro: val('f-intro'), detail: val('f-detail'),
    address: val('f-address'), phone: val('f-phone'), wechat: val('f-wechat'), hours: val('f-hours'),
    contact_name: val('f-cname'), contact_phone: val('f-cphone')
  };
  if (!payload.name) { alert('请填写商户名称'); return; }
  var coverfile = el('f-coverfile').files && el('f-coverfile').files[0];
  if (coverfile && coverfile.size > 5 * 1048576) { alert('封面图超过 5MB。'); return; }

  var btn = el('fsave');
  btn.disabled = true;
  // 带图新建：先建档拿 id（图片必须归 m<id>/ 前缀，删商户才能级联清理），再传图、补封面
  var createdId = null;
  var seq = Promise.resolve();
  if (coverfile && !editingId) {
    seq = seq.then(function () {
      return api('/api/merchants', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }).then(function (d) {
      createdId = d.id; editingId = d.id;
      el('mform-title').textContent = '编辑商户 #' + d.id;
    });
  }
  if (coverfile) {
    seq = seq.then(function () {
      return putFile('/api/merchants/cover?m=' + editingId, coverfile);
    }).then(function (d) { payload.cover = d.key; });
  }
  seq.then(function () {
    if (createdId) {
      // 建档已成功，此处只补封面字段
      return api('/api/merchants/' + createdId, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cover: payload.cover })
      });
    }
    return api(editingId ? '/api/merchants/' + editingId : '/api/merchants', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }).then(function () { closeForm(); loadMerchants(true); })
    .catch(function (e) { if (e.message !== 'unauthorized') alert('保存失败：' + e.message); })
    .then(function () { btn.disabled = false; });
});
el('mmore').addEventListener('click', function () { mState.offset += ${PAGE_SIZE}; loadMerchants(false); });

// 商户图展示地址：/ 开头 = 主站静态图；否则为商户图桶 R2 键，走主站 /assets-merchant/ 代理
function merchantImg(v) {
  if (!v) return '';
  return SITE_HOME + (v.indexOf('/') === 0 ? v : '/assets-merchant/' + v);
}
function setCoverPrev(src) {
  var prev = el('f-coverprev');
  if (src) { prev.src = src; prev.style.display = ''; }
  else { prev.removeAttribute('src'); prev.style.display = 'none'; }
}
el('f-coverfile').addEventListener('change', function () {
  var f = this.files && this.files[0];
  setCoverPrev(f ? URL.createObjectURL(f) : '');
  if (f) el('f-coverinfo').textContent = '已选择：' + f.name + '（保存后生效，覆盖上方地址）';
  else el('f-coverinfo').textContent = editingId && el('f-cover').value ? '当前封面：' + el('f-cover').value : '';
});

/* ---------- 万载TV 视频管理（docs/万载TV方案.md） ---------- */
var tState = { status: '', offset: 0 };
var editingTvId = null;
var tFetchedCover = null; // 「从B站获取信息」抓到的封面键（用户本地上传封面时优先本地）
var V_CAT = { drama: '短剧', fireworks: '烟花', heritage: '非遗', food: '美食', tourism: '文旅', other: '其他' };
var SITE_HOME = 'https://whizzzest.com';

document.querySelectorAll('#view-tv .range [data-vst]').forEach(function (b) {
  b.addEventListener('click', function () {
    tState.status = b.getAttribute('data-vst');
    document.querySelectorAll('#view-tv .range [data-vst]').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    loadTv(true);
  });
});

// 封面展示地址：/ 开头 = 主站静态图，否则为 R2 键走 /media/ 代理
function coverUrl(c) {
  if (!c) return '';
  return SITE_HOME + (c.indexOf('/') === 0 ? c : '/media/' + c);
}

function vDur(sec) {
  sec = Number(sec) || 0;
  if (sec <= 0) return '';
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
}

function loadTv(reset) {
  if (reset) tState.offset = 0;
  var q = '?offset=' + tState.offset + (tState.status ? '&status=' + tState.status : '');
  api('/api/tv' + q).then(function (d) {
    var list = d.videos || [];
    var counts = d.byStatus || {};
    var line = '共 ' + d.total + ' 条 · 已发布 ' + (counts.published || 0) + ' · 已隐藏 ' + (counts.hidden || 0);
    if (d.storage != null) line += ' · 已用存储 ' + (d.storage / 1048576).toFixed(1) + ' MB';
    el('tstats').textContent = line;
    var box = el('tlist');
    if (reset) box.innerHTML = '';
    if (reset && list.length === 0) {
      box.innerHTML = '<p class="empty">还没有视频，点右上「新增视频」录入第一条（B站 BV 号或直接上传）。</p>';
    } else {
      list.forEach(function (x) { box.appendChild(renderVideo(x)); });
    }
    el('tmore').style.display = (tState.offset + ${PAGE_SIZE} < d.total && list.length > 0) ? 'block' : 'none';
  }).catch(function (e) {
    if (e.message !== 'unauthorized') el('tlist').innerHTML = '<p class="empty">加载失败：' + esc(e.message) + '</p>';
  });
}

function renderVideo(x) {
  var div = document.createElement('div');
  div.className = 'msg' + (x.status === 'published' ? '' : ' read');
  var thumb = coverUrl(x.cover)
    ? '<img class="vthumb" loading="lazy" alt="" src="' + esc(coverUrl(x.cover)) + '">'
    : '<div class="vthumb"></div>';
  var badges =
    '<span class="k-badge">' + esc(V_CAT[x.category] || x.category) + '</span>' +
    '<span class="k-badge">' + (x.source === 'bilibili' ? 'B站嵌入' : '上传') + '</span>' +
    (x.series ? '<span class="k-badge">' + esc(x.series) + (x.episode ? ' 第' + x.episode + '集' : '') + '</span>' : '') +
    (x.featured ? '<span class="k-badge">焦点位</span>' : '') +
    '<span class="mst ' + (x.status === 'published' ? 'mst-approved' : 'mst-rejected') + '">' + (x.status === 'published' ? '已发布' : '已隐藏') + '</span>';
  div.innerHTML =
    '<div class="vrow1">' + thumb +
    '<div style="min-width:0;flex:1">' +
      '<div class="row1"><span class="name">' + esc(x.title) + '</span>' + badges +
      (x.status === 'published' ? '<a class="mslug" href="' + SITE_HOME + '/tv/' + x.id + '/" target="_blank" rel="noopener">查看页面 ↗</a>' : '') +
      '</div>' +
      (x.intro ? '<div class="time">' + esc(x.intro) + '</div>' : '') +
      '<div class="meta">' + (vDur(x.duration) ? '时长 ' + vDur(x.duration) + ' · ' : '') + '播放 ' + (x.views || 0) + ' 次 · ' + esc(fmtTime(x.created_at)) + '</div>' +
    '</div></div>' +
    '<div class="ops">' +
    '<button type="button" data-act="toggle">' + (x.status === 'published' ? '隐藏' : '发布') + '</button>' +
    (x.featured ? '' : '<button type="button" data-act="feat">设为焦点位</button>') +
    '<button type="button" data-act="edit">编辑</button>' +
    '<button type="button" data-act="del">删除</button></div>';
  div.querySelector('.ops').addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act');
    if (act === 'toggle') {
      api('/api/tv/' + x.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: x.status === 'published' ? 'hidden' : 'published' })
      }).then(function () { loadTv(true); });
    } else if (act === 'feat') {
      api('/api/tv/' + x.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ featured: 1 })
      }).then(function () { loadTv(true); });
    } else if (act === 'edit') {
      openTvForm(x);
    } else if (act === 'del') {
      // 二次点击确认（同商户删除）：首击变红待确认，4 秒未点自动复原；第二击才真正删除（含视频/封面，不可恢复）
      var btn = e.target;
      if (btn.getAttribute('data-armed') !== '1') {
        btn.setAttribute('data-armed', '1');
        btn.className = 'danger';
        btn.textContent = '确认删除（含视频）';
        setTimeout(function () {
          if (!btn.isConnected) return;
          btn.removeAttribute('data-armed');
          btn.className = '';
          btn.textContent = '删除';
        }, 4000);
        return;
      }
      api('/api/tv/' + x.id, { method: 'DELETE' }).then(function () { loadTv(true); });
    }
  });
  return div;
}

function openTvForm(x) {
  editingTvId = x ? x.id : null;
  tFetchedCover = null;
  el('tform-title').textContent = x ? '编辑视频 #' + x.id : '新增视频';
  el('t-title').value = x ? x.title || '' : '';
  el('t-cat').value = x ? x.category || 'drama' : 'drama';
  el('t-status').value = x ? x.status || 'published' : 'published';
  el('t-src').value = x ? x.source || 'bilibili' : 'bilibili';
  el('t-bvid').value = x ? x.bvid || '' : '';
  el('t-file').value = '';
  el('t-fileinfo').textContent = '';
  el('t-series').value = x ? x.series || '' : '';
  el('t-scover').value = '';
  el('t-scoverinfo').textContent = '';
  el('t-ep').value = x && x.episode ? x.episode : '';
  el('t-feat').value = x && x.featured ? '1' : '0';
  el('t-dur').value = x && x.duration ? x.duration : '';
  el('t-intro').value = x ? x.intro || '' : '';
  el('t-cover').value = '';
  el('t-coverinfo').textContent = x && x.cover ? '当前封面：' + x.cover : '';
  syncSrcRows();
  syncSeriesRow();
  hint(null);
  el('tform').style.display = '';
  el('tform').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeTvForm() { el('tform').style.display = 'none'; editingTvId = null; progress(null); }

function syncSrcRows() {
  var up = el('t-src').value === 'upload';
  el('row-bvid').style.display = up ? 'none' : '';
  el('row-file').style.display = up ? '' : 'none';
}
el('t-src').addEventListener('change', syncSrcRows);

// 剧集总封面位：填了剧名才出现
function syncSeriesRow() {
  el('row-scover').style.display = val('t-series') ? '' : 'none';
}
el('t-series').addEventListener('input', syncSeriesRow);

// 从B站拉取信息：标题/简介/时长自动填 + 封面转存 R2（保存时随表单提交）
el('t-fetch').addEventListener('click', function () {
  var bvid = val('t-bvid');
  // 注意 BV 号大小写敏感（base58），不可做大小写归一化
  if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) { alert('请先填写正确的 BV 号'); return; }
  var btn = el('t-fetch');
  btn.disabled = true;
  btn.textContent = '获取中…';
  api('/api/tv/fetch-bili', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bvid: bvid })
  }).then(function (d) {
    if (d.title) el('t-title').value = d.title;
    if (d.intro) el('t-intro').value = d.intro;
    if (d.duration) el('t-dur').value = d.duration;
    if (d.cover) {
      tFetchedCover = d.cover;
      el('t-coverinfo').textContent = '封面已从B站获取（保存后生效）';
    } else {
      el('t-coverinfo').textContent = 'B站封面获取失败，可手动上传';
    }
  }).catch(function (e) {
    if (e.message !== 'unauthorized') alert('获取失败：' + e.message);
  }).then(function () {
    btn.disabled = false;
    btn.textContent = '从B站获取信息';
  });
});

// 选文件即读元数据：时长自动带出 + 大小提示（95MB 上限，免费版请求体 100MB 留余量）
el('t-file').addEventListener('change', function () {
  var f = this.files && this.files[0];
  var info = el('t-fileinfo');
  if (!f) { info.textContent = ''; return; }
  info.textContent = f.name + ' · ' + (f.size / 1048576).toFixed(1) + ' MB' + (f.size > 95 * 1048576 ? '（超 95MB，请先压缩）' : '');
  var v = document.createElement('video');
  v.preload = 'metadata';
  v.onloadedmetadata = function () {
    if (v.duration && isFinite(v.duration)) el('t-dur').value = Math.round(v.duration);
    URL.revokeObjectURL(v.src);
  };
  v.src = URL.createObjectURL(f);
});

function progress(p) {
  var bar = el('t-prog');
  if (p == null) { bar.style.display = 'none'; el('t-progbar').style.width = '0'; return; }
  bar.style.display = '';
  el('t-progbar').style.width = Math.round(p * 100) + '%';
}
function hint(msg) {
  var h = el('t-hint');
  h.textContent = msg || '';
  h.style.display = msg ? '' : 'none';
}

/** File 直作 PUT body 上传（XHR 才有 upload 进度事件）；返回 {ok, key} */
function putFile(url, file, onP) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (onP) {
      xhr.upload.addEventListener('progress', function (e) {
        if (e.lengthComputable) onP(e.loaded / e.total);
      });
    }
    xhr.onload = function () {
      var d = null;
      try { d = JSON.parse(xhr.responseText); } catch (err) { /* 非 JSON 视为失败 */ }
      if (xhr.status === 200 && d && d.ok) return resolve(d);
      reject(new Error((d && d.error) || ('HTTP ' + xhr.status)));
    };
    xhr.onerror = function () { reject(new Error('网络错误')); };
    xhr.send(file);
  });
}

el('tadd').addEventListener('click', function () { openTvForm(null); });
el('tcancel').addEventListener('click', closeTvForm);
el('tsave').addEventListener('click', function () {
  var payload = {
    title: val('t-title'), category: val('t-cat'), status: val('t-status'),
    source: val('t-src'), bvid: val('t-bvid'),
    series: val('t-series'), episode: el('t-ep').value ? Number(el('t-ep').value) : 0,
    featured: Number(val('t-feat') || 0),
    duration: el('t-dur').value ? Number(el('t-dur').value) : 0,
    intro: val('t-intro')
  };
  if (!payload.title) { alert('请填写标题'); return; }
  if (payload.source === 'bilibili' && !/^BV[0-9A-Za-z]{8,12}$/.test(payload.bvid)) {
    alert('BV 号格式不正确（形如 BV1xx411c7mD）'); return;
  }
  var file = el('t-file').files && el('t-file').files[0];
  var cover = el('t-cover').files && el('t-cover').files[0];
  var scover = el('row-scover').style.display !== 'none' ? (el('t-scover').files && el('t-scover').files[0]) : null;
  if (payload.source === 'upload' && !editingTvId && !file) { alert('请选择要上传的视频文件'); return; }
  if (file && file.size > 95 * 1048576) { alert('视频超过 95MB：请先压缩，或改用「B站嵌入」来源。'); return; }
  var ext = file ? (file.name.split('.').pop() || '').toLowerCase() : '';
  if (file && ['mp4', 'm4v', 'webm'].indexOf(ext) === -1) { alert('仅支持 MP4 / WebM 格式。'); return; }
  if (cover && cover.size > 5 * 1048576) { alert('封面图超过 5MB。'); return; }
  if (scover && scover.size > 5 * 1048576) { alert('剧集封面超过 5MB。'); return; }

  var btn = el('tsave');
  btn.disabled = true;
  var seq = Promise.resolve();
  if (file) {
    progress(0);
    hint('视频上传中，请勿关闭页面…');
    seq = seq.then(function () {
      return putFile('/api/tv/upload?ext=' + ext, file, function (p) { progress(p); });
    }).then(function (d) { payload.file_key = d.key; });
  }
  if (cover) {
    seq = seq.then(function () {
      hint('封面上传中…');
      return putFile('/api/tv/cover', cover);
    }).then(function (d) { payload.cover = d.key; });
  } else if (tFetchedCover) {
    // 没传本地图但用「从B站获取信息」抓到了封面 → 随保存提交
    payload.cover = tFetchedCover;
  }
  if (scover) {
    seq = seq.then(function () {
      hint('剧集封面上传中…');
      return putFile('/api/tv/cover', scover);
    }).then(function (d) { payload.series_cover = d.key; });
  }
  seq.then(function () {
    hint('保存中…');
    return api(editingTvId ? '/api/tv/' + editingTvId : '/api/tv', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }).then(function () {
    closeTvForm();
    loadTv(true);
  }).catch(function (e) {
    if (e.message !== 'unauthorized') alert('保存失败：' + e.message);
  }).then(function () {
    btn.disabled = false;
    progress(null);
    hint(null);
  });
});
el('tmore').addEventListener('click', function () { tState.offset += ${PAGE_SIZE}; loadTv(false); });

/* ---------- 文库管理（docs/文库方案.md） ---------- */
var bState = { status: '', offset: 0 };
var editingBookId = null;
var B_CAT = { novel: '小说', story: '故事', essay: '随笔', other: '其他' };
var B_ST = { pending: '待审核', approved: '已上线', rejected: '已驳回', hidden: '已下线' };

document.querySelectorAll('#view-books .range [data-bst]').forEach(function (b) {
  b.addEventListener('click', function () {
    bState.status = b.getAttribute('data-bst');
    document.querySelectorAll('#view-books .range [data-bst]').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    loadBooks(true);
  });
});

function loadBooks(reset) {
  if (reset) bState.offset = 0;
  var q = '?offset=' + bState.offset + (bState.status ? '&status=' + bState.status : '');
  api('/api/books' + q).then(function (d) {
    var list = d.books || [];
    var counts = d.byStatus || {};
    var line = '共 ' + d.total + ' 部 · 待审 ' + (counts.pending || 0) + ' · 已上线 ' + (counts.approved || 0);
    if (d.storage != null) line += ' · 媒体桶已用 ' + (d.storage / 1048576).toFixed(1) + ' MB';
    el('bstats').textContent = line;
    var box = el('blist');
    if (reset) box.innerHTML = '';
    if (reset && list.length === 0) {
      box.innerHTML = '<p class="empty">还没有作品。作者投稿会出现在这里，也可点右上「新增作品」直发。</p>';
    } else {
      list.forEach(function (x) { box.appendChild(renderBook(x)); });
    }
    el('bmore').style.display = (bState.offset + ${PAGE_SIZE} < d.total && list.length > 0) ? 'block' : 'none';
  }).catch(function (e) {
    if (e.message !== 'unauthorized') el('blist').innerHTML = '<p class="empty">加载失败：' + esc(e.message) + '</p>';
  });
}

function renderBook(x) {
  var div = document.createElement('div');
  div.className = 'msg' + (x.status === 'pending' ? '' : ' read');
  var thumb = x.cover
    ? '<img class="bkthumb" loading="lazy" alt="" src="' + SITE_HOME + (x.cover.indexOf('/') === 0 ? '' : '/media/') + esc(x.cover) + '">'
    : '<div class="bkthumb"></div>';
  var pend = x.pending_ch > 0 ? '<span class="mst mst-pending">' + x.pending_ch + ' 章待审</span>' : '';
  div.innerHTML =
    '<div class="vrow1">' + thumb +
    '<div style="min-width:0;flex:1">' +
      '<div class="row1"><span class="name">' + esc(x.title) + '</span>' +
      '<span class="k-badge">' + esc(B_CAT[x.category] || x.category) + '</span>' +
      (x.author_name ? '<span class="k-badge">' + esc(x.author_name) + '</span>' : '') +
      '<span class="mst mst-' + esc(x.status) + '">' + esc(B_ST[x.status] || x.status) + '</span>' + pend +
      (x.slug && x.status === 'approved'
        ? '<a class="mslug" href="' + SITE_HOME + '/library/' + esc(x.slug) + '/" target="_blank" rel="noopener">查看页面 ↗</a>' : '') +
      '</div>' +
      '<div class="meta">' + (x.writer_id ? '作者投稿 · ' : '站长直发 · ') + (x.chapter_count || 0) + ' 章 · ' +
      ((x.word_count || 0).toLocaleString()) + ' 字 · 浏览 ' + (x.views || 0) + ' · ' + esc(fmtTime(x.updated_at)) + '</div>' +
      (x.status === 'rejected' && x.reject_reason ? '<div class="meta" style="color:#d64524">驳回原因：' + esc(x.reject_reason) + '</div>' : '') +
      (x.intro ? '<div class="time">' + esc(x.intro) + '</div>' : '') +
      '<div class="ops">' +
      (x.status === 'pending' ? '<button type="button" data-act="ok" class="primary">通过上线</button><button type="button" data-act="rej">驳回</button>' : '') +
      (x.status === 'approved' ? '<button type="button" data-act="off">下线</button>' : '') +
      (x.status === 'hidden' ? '<button type="button" data-act="ok2" class="primary">恢复上线</button>' : '') +
      '<button type="button" data-act="edit">编辑信息</button>' +
      '<button type="button" data-act="ch">章节审核</button>' +
      '<button type="button" data-act="del">删除</button></div>' +
    '</div></div>';
  div.querySelector('.ops').addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act');
    if (act === 'ok' || act === 'ok2') {
      api('/api/books/' + x.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      }).then(function () { loadBooks(true); });
    } else if (act === 'rej') {
      var reason = prompt('驳回原因（会展示给作者）：');
      if (reason === null) return;
      api('/api/books/' + x.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'rejected', reject_reason: reason || '内容待完善' })
      }).then(function () { loadBooks(true); });
    } else if (act === 'off') {
      api('/api/books/' + x.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'hidden' })
      }).then(function () { loadBooks(true); });
    } else if (act === 'edit') {
      openBookForm(x);
    } else if (act === 'ch') {
      toggleChapters(x, div);
    } else if (act === 'del') {
      // 二次点击确认（同商户/视频）：首击变红待确认，4 秒未点自动复原；第二击才真正删除（含章节与图片，不可恢复）
      var btn = e.target;
      if (btn.getAttribute('data-armed') !== '1') {
        btn.setAttribute('data-armed', '1');
        btn.className = 'danger';
        btn.textContent = '确认删除（含章节）';
        setTimeout(function () {
          if (!btn.isConnected) return;
          btn.removeAttribute('data-armed');
          btn.className = '';
          btn.textContent = '删除';
        }, 4000);
        return;
      }
      api('/api/books/' + x.id, { method: 'DELETE' }).then(function () { loadBooks(true); });
    }
  });
  return div;
}

/** 展开/收起某作品的章节审核面板（先读后审：正文全量展示；支持直改章节与删单张插图） */
function toggleChapters(book, card) {
  var existing = card.nextElementSibling;
  if (existing && existing.className === 'chdetail') { existing.remove(); return; }
  var det = document.createElement('div');
  det.className = 'chdetail';
  det.innerHTML = '<p class="empty">章节加载中…</p>';
  card.after(det);
  api('/api/books/' + book.id + '/chapters').then(function (d) {
    var chapters = d.chapters || [];
    var rows = chapters.map(function (c) {
      var imgs = [];
      try { imgs = JSON.parse(c.images || '[]') || []; } catch (err) { imgs = []; }
      var imgHtml = imgs.length
        ? '<div class="thumbs" style="margin-top:8px">' + imgs.map(function (k) {
            return '<span class="figwrap"><img class="land" loading="lazy" alt="" src="' + SITE_HOME + (k.indexOf('/') === 0 ? '' : '/media/') + esc(k) + '">' +
              '<button type="button" class="figdel" data-imgdel="' + c.id + '|' + esc(k) + '" title="删除此图">✕</button></span>';
          }).join('') + '</div>'
        : '';
      var stCls = c.status === 'approved' ? 'mst-approved' : c.status === 'rejected' ? 'mst-rejected' : c.status === 'draft' ? 'mst-draft' : 'mst-pending';
      var stTxt = c.status === 'approved' ? '已上线' : c.status === 'rejected' ? '已驳回' : c.status === 'draft' ? '草稿' : '待审';
      return '<div class="chitem" data-chitem="' + c.id + '">' +
        '<div class="row1"><span class="name" style="font-size:14px">第' + c.idx + '章 · ' + esc(c.title) + '</span>' +
        '<span class="mst ' + stCls + '">' + stTxt + '</span>' +
        '<span class="vhint">' + (c.word_count || 0) + ' 字</span></div>' +
        (c.status === 'rejected' && c.reject_reason ? '<div class="vhint">驳回原因：' + esc(c.reject_reason) + '</div>' : '') +
        '<div class="chbody">' + esc(c.body) + '</div>' + imgHtml +
        '<div class="ops">' +
        (c.status !== 'approved' ? '<button type="button" data-chok="' + c.id + '">通过上线</button>' : '') +
        (c.status !== 'rejected' ? '<button type="button" data-chrej="' + c.id + '">驳回</button>' : '') +
        '<button type="button" data-chedit="' + c.id + '">编辑</button>' +
        '<button type="button" data-chdel="' + c.id + '" class="danger">删除</button></div>' +
        '</div>';
    }).join('');
    det.innerHTML = rows || '<p class="empty">该作品还没有章节（作者尚未写作）。</p>';
    det.addEventListener('click', function (e) {
      var ok = e.target.getAttribute('data-chok');
      var rej = e.target.getAttribute('data-chrej');
      var del = e.target.getAttribute('data-chdel');
      var editId = e.target.getAttribute('data-chedit');
      var imgdel = e.target.getAttribute('data-imgdel');
      if (ok) {
        api('/api/books/' + book.id + '/chapters/' + ok, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'approved' })
        }).then(function () { toggleChapters(book, card); loadBooks(false); });
      } else if (rej) {
        var reason = prompt('驳回原因（会展示给作者）：');
        if (reason === null) return;
        api('/api/books/' + book.id + '/chapters/' + rej, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'rejected', reject_reason: reason || '内容待完善' })
        }).then(function () { toggleChapters(book, card); loadBooks(false); });
      } else if (del) {
        if (!confirm('确定删除该章节？章节图片将一并删除，不可恢复。')) return;
        api('/api/books/' + book.id + '/chapters/' + del, { method: 'DELETE' })
          .then(function () { toggleChapters(book, card); loadBooks(false); });
      } else if (imgdel) {
        // data-imgdel = "<章节id>|<R2键>"（键内无 |，split 后 join 兜底）
        var parts = imgdel.split('|');
        var imgCid = parts.shift();
        var imgKey = parts.join('|');
        if (!confirm('删除这张插图？正文中对应的 [图] 占位将不再显示图片。')) return;
        api('/api/books/' + book.id + '/chapters/' + imgCid + '/edit', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ remove_image: imgKey })
        }).then(function () { toggleChapters(book, card); loadBooks(false); })
          .catch(function (err) { if (err.message !== 'unauthorized') alert('删除失败：' + err.message); });
      } else if (editId) {
        var item = det.querySelector('[data-chitem="' + editId + '"]');
        var opened = item && item.nextElementSibling;
        if (opened && opened.className === 'chedit') { opened.remove(); return; }
        det.querySelectorAll('.chedit').forEach(function (x) { x.remove(); });
        var c = null;
        for (var i = 0; i < chapters.length; i++) if (String(chapters[i].id) === String(editId)) c = chapters[i];
        if (!c || !item) return;
        item.after(chapterEditForm(c));
      } else if (e.target.getAttribute('data-saveedit')) {
        var box = e.target.closest('.chedit');
        if (!box) return;
        var saveId = e.target.getAttribute('data-saveedit');
        var payload = {};
        box.querySelectorAll('[data-f]').forEach(function (inp) {
          payload[inp.getAttribute('data-f')] = inp.value;
        });
        e.target.disabled = true;
        api('/api/books/' + book.id + '/chapters/' + saveId + '/edit', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function () { toggleChapters(book, card); loadBooks(false); })
          .catch(function (err) {
            e.target.disabled = false;
            if (err.message !== 'unauthorized') alert(err.message === 'dupidx' ? '序号与已有章节重复' : '保存失败：' + err.message);
          });
      } else if (e.target.getAttribute('data-canceledit')) {
        var frm = e.target.closest('.chedit');
        if (frm) frm.remove();
      }
    });
  }).catch(function (e) {
    det.innerHTML = '<p class="empty">加载失败：' + esc(e.message) + '</p>';
  });
}

/** 章节直改表单（admin）：序号/标题/正文；保存即时生效且不改变审核状态 */
function chapterEditForm(c) {
  var wrap = document.createElement('div');
  wrap.className = 'chedit';
  wrap.innerHTML =
    '<div class="chedit-grid">' +
      '<label>序号<input type="number" min="1" max="500" value="' + c.idx + '" data-f="idx"></label>' +
      '<label>标题<input value="' + esc(c.title) + '" maxlength="100" data-f="title"></label>' +
    '</div>' +
    '<label>正文（支持 Markdown：# 标题、**粗体**、*斜体*、> 引用、列表、[文字](链接)；[图] 为旧图文占位）<textarea rows="10" data-f="body">' + esc(c.body) + '</textarea></label>' +
    '<div class="ops"><button type="button" class="primary" data-saveedit="' + c.id + '">保存修改</button>' +
    '<button type="button" data-canceledit="1">取消</button></div>' +
    '<p class="vhint">保存即时生效：已上线章节直接对读者可见，审核状态不变。</p>';
  return wrap;
}

function openBookForm(x) {
  editingBookId = x ? x.id : null;
  el('bform-title').textContent = x ? '编辑作品 #' + x.id + '（' + esc(B_ST[x.status] || x.status) + '）' : '新增作品（免审直发）';
  el('b-title').value = x ? x.title || '' : '';
  el('b-cat').value = x ? x.category || 'novel' : 'novel';
  el('b-author').value = x ? x.author_name || '' : '';
  el('b-status').value = x ? x.status || 'approved' : 'approved';
  el('b-weight').value = x ? x.sort_weight || 0 : 0;
  el('b-cover').value = x ? x.cover || '' : '';
  el('b-intro').value = x ? x.intro || '' : '';
  el('b-coverfile').value = '';
  setBookCoverPrev(x && x.cover ? SITE_HOME + (x.cover.indexOf('/') === 0 ? '' : '/media/') + x.cover : '');
  el('b-coverinfo').textContent = '';
  el('bform').style.display = '';
  el('bform').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeBookForm() { el('bform').style.display = 'none'; editingBookId = null; }

// 封面预览：/ 开头 = 主站静态图；否则为媒体桶 R2 键，走主站 /media/ 代理
function setBookCoverPrev(src) {
  var prev = el('b-coverprev');
  if (src) { prev.src = src; prev.style.display = ''; }
  else { prev.removeAttribute('src'); prev.style.display = 'none'; }
}
el('b-coverpick').addEventListener('click', function () { el('b-coverfile').click(); });
el('b-coverfile').addEventListener('change', function () {
  var f = this.files && this.files[0];
  setBookCoverPrev(f ? URL.createObjectURL(f) : '');
  el('b-coverinfo').textContent = f ? '已选择：' + f.name + '（保存后生效，覆盖上方地址）' : '';
});

el('badd').addEventListener('click', function () { openBookForm(null); });
el('bcancel').addEventListener('click', closeBookForm);
el('bsave').addEventListener('click', function () {
  var payload = {
    title: val('b-title'), category: val('b-cat'), author_name: val('b-author'),
    status: val('b-status'), sort_weight: Number(val('b-weight') || 0),
    cover: val('b-cover'), intro: val('b-intro')
  };
  if (!payload.title || !payload.intro) { alert('请填写书名和简介'); return; }
  var coverfile = el('b-coverfile').files && el('b-coverfile').files[0];
  if (coverfile && coverfile.size > 5 * 1048576) { alert('封面图超过 5MB。'); return; }

  var btn = el('bsave');
  btn.disabled = true;
  // 带图新建：先建档拿 id（封面归 book/b<id>/ 前缀，删作品才能级联清理），再传图、补封面（同商户流程）
  var createdId = null;
  var seq = Promise.resolve();
  if (coverfile && !editingBookId) {
    seq = seq.then(function () {
      return api('/api/books', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }).then(function (d) {
      createdId = d.id; editingBookId = d.id;
      el('bform-title').textContent = '编辑作品 #' + d.id;
    });
  }
  if (coverfile) {
    seq = seq.then(function () {
      return putFile('/api/books/cover?b=' + editingBookId, coverfile);
    }).then(function (d) { payload.cover = d.key; });
  }
  seq.then(function () {
    if (createdId) {
      // 建档已成功，此处只补封面字段
      return api('/api/books/' + createdId, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cover: payload.cover })
      });
    }
    return api(editingBookId ? '/api/books/' + editingBookId : '/api/books', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }).then(function () { closeBookForm(); loadBooks(true); })
    .catch(function (e) { if (e.message !== 'unauthorized') alert('保存失败：' + e.message); })
    .then(function () { btn.disabled = false; });
});
el('bmore').addEventListener('click', function () { bState.offset += ${PAGE_SIZE}; loadBooks(false); });

/* ---------- 万载音乐管理（2026-09-06） ---------- */
var muState = { status: '', offset: 0 };
var editingTrackId = null;
var M_ST = { published: '已上线', hidden: '已隐藏' };

document.querySelectorAll('#view-music .range [data-must]').forEach(function (b) {
  b.addEventListener('click', function () {
    muState.status = b.getAttribute('data-must');
    document.querySelectorAll('#view-music .range [data-must]').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    loadMusic(true);
  });
});

function loadMusic(reset) {
  if (reset) muState.offset = 0;
  var q = '?offset=' + muState.offset + (muState.status ? '&status=' + muState.status : '');
  api('/api/music' + q).then(function (d) {
    var list = d.tracks || [];
    var counts = d.byStatus || {};
    var line = '共 ' + d.total + ' 首 · 已上线 ' + (counts.published || 0) + ' · 已隐藏 ' + (counts.hidden || 0);
    if (d.storage != null) line += ' · 已用存储 ' + (d.storage / 1048576).toFixed(1) + ' MB';
    el('mustats').textContent = line;
    var box = el('mulist');
    if (reset) box.innerHTML = '';
    if (reset && list.length === 0) {
      box.innerHTML = '<p class="empty">还没有曲目，点右上「新增曲目」上传第一首 MP3。</p>';
    } else {
      list.forEach(function (x) { box.appendChild(renderTrack(x)); });
    }
    el('mumore').style.display = (muState.offset + ${PAGE_SIZE} < d.total && list.length > 0) ? 'block' : 'none';
  }).catch(function (e) {
    if (e.message !== 'unauthorized') el('mulist').innerHTML = '<p class="empty">加载失败：' + esc(e.message) + '</p>';
  });
}

function renderTrack(x) {
  var div = document.createElement('div');
  div.className = 'msg' + (x.status === 'published' ? '' : ' read');
  var thumb = coverUrl(x.cover)
    ? '<img class="vthumb" loading="lazy" alt="" src="' + esc(coverUrl(x.cover)) + '">'
    : '<div class="vthumb"></div>';
  var badges =
    '<span class="k-badge">曲序 ' + (x.sort || 0) + '</span>' +
    '<span class="mst ' + (x.status === 'published' ? 'mst-approved' : 'mst-rejected') + '">' + (M_ST[x.status] || x.status) + '</span>';
  div.innerHTML =
    '<div class="vrow1">' + thumb +
    '<div style="min-width:0;flex:1">' +
      '<div class="row1"><span class="name">' + esc(x.title) + '</span>' + badges +
      (x.status === 'published' ? '<a class="mslug" href="' + SITE_HOME + '/music/" target="_blank" rel="noopener">前台收听 ↗</a>' : '') +
      '</div>' +
      '<div class="meta">' + (x.artist ? esc(x.artist) + ' · ' : '') + (vDur(x.duration) ? '时长 ' + vDur(x.duration) + ' · ' : '') + '播放 ' + (x.plays || 0) + ' 次 · ' + esc(fmtTime(x.created_at)) + '</div>' +
    '</div></div>' +
    '<div class="ops">' +
    '<button type="button" data-act="toggle">' + (x.status === 'published' ? '隐藏' : '上线') + '</button>' +
    '<button type="button" data-act="edit">编辑</button>' +
    '<button type="button" data-act="del">删除</button></div>';
  div.querySelector('.ops').addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act');
    if (act === 'toggle') {
      api('/api/music/' + x.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: x.status === 'published' ? 'hidden' : 'published' })
      }).then(function () { loadMusic(true); });
    } else if (act === 'edit') {
      openTrackForm(x);
    } else if (act === 'del') {
      // 二次点击确认（同视频删除）：首击变红待确认，4 秒未点自动复原；第二击删除（音频/封面一并清理，不可恢复）
      var btn = e.target;
      if (btn.getAttribute('data-armed') !== '1') {
        btn.setAttribute('data-armed', '1');
        btn.className = 'danger';
        btn.textContent = '确认删除（含音频）';
        setTimeout(function () {
          if (!btn.isConnected) return;
          btn.removeAttribute('data-armed');
          btn.className = '';
          btn.textContent = '删除';
        }, 4000);
        return;
      }
      api('/api/music/' + x.id, { method: 'DELETE' }).then(function () { loadMusic(true); });
    }
  });
  return div;
}

function openTrackForm(x) {
  editingTrackId = x ? x.id : null;
  el('muform-title').textContent = x ? '编辑曲目 #' + x.id : '新增曲目';
  el('mu-title').value = x ? x.title || '' : '';
  el('mu-artist').value = x ? x.artist || '' : '';
  el('mu-status').value = x ? x.status || 'published' : 'published';
  el('mu-sort').value = x ? x.sort || 0 : 0;
  el('mu-dur').value = x && x.duration ? x.duration : '';
  el('mu-file').value = '';
  el('mu-fileinfo').textContent = x && x.file_key ? '当前音频：' + x.file_key + '（不换文件则留空）' : '';
  el('mu-cover').value = '';
  el('mu-coverinfo').textContent = x && x.cover ? '当前封面：' + x.cover : '';
  muProgress(null); muHint(null);
  el('muform').style.display = '';
  el('muform').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeTrackForm() { el('muform').style.display = 'none'; editingTrackId = null; muProgress(null); }

function muProgress(p) {
  var bar = el('mu-prog');
  if (p == null) { bar.style.display = 'none'; el('mu-progbar').style.width = '0'; return; }
  bar.style.display = '';
  el('mu-progbar').style.width = Math.round(p * 100) + '%';
}
function muHint(msg) {
  var h = el('mu-hint');
  h.textContent = msg || '';
  h.style.display = msg ? '' : 'none';
}

// 选文件即预读时长（Audio 元数据）+ 大小提示（50MB 上限）
el('mu-file').addEventListener('change', function () {
  var f = this.files && this.files[0];
  var info = el('mu-fileinfo');
  if (!f) { info.textContent = ''; return; }
  info.textContent = f.name + ' · ' + (f.size / 1048576).toFixed(1) + ' MB' + (f.size > 50 * 1048576 ? '（超 50MB，请先压缩）' : '');
  var a = document.createElement('audio');
  a.preload = 'metadata';
  a.onloadedmetadata = function () {
    if (a.duration && isFinite(a.duration)) el('mu-dur').value = Math.round(a.duration);
    URL.revokeObjectURL(a.src);
  };
  a.src = URL.createObjectURL(f);
});

el('muadd').addEventListener('click', function () { openTrackForm(null); });
el('mucancel').addEventListener('click', closeTrackForm);
el('musave').addEventListener('click', function () {
  var payload = {
    title: val('mu-title'), artist: val('mu-artist'), status: val('mu-status'),
    sort: Number(val('mu-sort') || 0),
    duration: el('mu-dur').value ? Number(el('mu-dur').value) : 0
  };
  if (!payload.title) { alert('请填写曲名'); return; }
  var file = el('mu-file').files && el('mu-file').files[0];
  var cover = el('mu-cover').files && el('mu-cover').files[0];
  if (!editingTrackId && !file) { alert('请选择要上传的 MP3 文件'); return; }
  if (file) {
    if (file.size > 50 * 1048576) { alert('音频超过 50MB，请先压缩。'); return; }
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext !== 'mp3') { alert('仅支持 MP3 格式。'); return; }
  }
  if (cover && cover.size > 5 * 1048576) { alert('封面图超过 5MB。'); return; }

  var btn = el('musave');
  btn.disabled = true;
  var seq = Promise.resolve();
  if (file) {
    muProgress(0);
    muHint('音频上传中，请勿关闭页面…');
    seq = seq.then(function () {
      return putFile('/api/music/upload', file, function (p) { muProgress(p); });
    }).then(function (d) { payload.file_key = d.key; });
  }
  if (cover) {
    seq = seq.then(function () {
      muHint('封面上传中…');
      return putFile('/api/music/cover', cover);
    }).then(function (d) { payload.cover = d.key; });
  }
  seq.then(function () {
    muHint('保存中…');
    return api(editingTrackId ? '/api/music/' + editingTrackId : '/api/music', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }).then(function () {
    closeTrackForm();
    loadMusic(true);
  }).catch(function (e) {
    if (e.message !== 'unauthorized') alert('保存失败：' + e.message);
  }).then(function () {
    btn.disabled = false;
    muProgress(null);
    muHint(null);
  });
});
el('mumore').addEventListener('click', function () { muState.offset += ${PAGE_SIZE}; loadMusic(false); });

/* ---------- 旅游景点管理（2026-09-06） ---------- */
var aState = { status: '', offset: 0 };
var editingAttraId = null;
var A_ST = { published: '已上线', hidden: '已下线' };
var SLUG_RE_JS = /^[a-z0-9][a-z0-9-]{0,59}$/;

document.querySelectorAll('#view-attra .range [data-ast]').forEach(function (b) {
  b.addEventListener('click', function () {
    aState.status = b.getAttribute('data-ast');
    document.querySelectorAll('#view-attra .range [data-ast]').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    loadAttra(true);
  });
});

function loadAttra(reset) {
  if (reset) aState.offset = 0;
  var q = '?offset=' + aState.offset + (aState.status ? '&status=' + aState.status : '');
  api('/api/attractions' + q).then(function (d) {
    var list = d.attractions || [];
    var counts = d.byStatus || {};
    var line = '共 ' + d.total + ' 处 · 已上线 ' + (counts.published || 0) + ' · 已下线 ' + (counts.hidden || 0);
    if (d.storage != null) line += ' · 已用存储 ' + (d.storage / 1048576).toFixed(1) + ' MB';
    el('astats').textContent = line;
    var box = el('atlist');
    if (reset) box.innerHTML = '';
    if (reset && list.length === 0) {
      box.innerHTML = '<p class="empty">还没有景点，点右上「新增景点」创建第一处（上线后前台 /attractions/ 瀑布流展示）。</p>';
    } else {
      list.forEach(function (x) { box.appendChild(renderAttra(x)); });
    }
    el('atmore').style.display = (aState.offset + ${PAGE_SIZE} < d.total && list.length > 0) ? 'block' : 'none';
  }).catch(function (e) {
    if (e.message !== 'unauthorized') el('atlist').innerHTML = '<p class="empty">加载失败：' + esc(e.message) + '</p>';
  });
}

function renderAttra(x) {
  var div = document.createElement('div');
  div.className = 'msg' + (x.status === 'published' ? '' : ' read');
  var thumb = coverUrl(x.cover)
    ? '<img class="vthumb" loading="lazy" alt="" src="' + esc(coverUrl(x.cover)) + '">'
    : '<div class="vthumb"></div>';
  var badges =
    '<span class="k-badge">' + esc(x.slug) + '</span>' +
    (x.tags ? '<span class="k-badge">' + esc(x.tags) + '</span>' : '') +
    '<span class="k-badge">排序 ' + (x.sort || 0) + '</span>' +
    '<span class="mst ' + (x.status === 'published' ? 'mst-approved' : 'mst-rejected') + '">' + (A_ST[x.status] || x.status) + '</span>';
  div.innerHTML =
    '<div class="vrow1">' + thumb +
    '<div style="min-width:0;flex:1">' +
      '<div class="row1"><span class="name">' + esc(x.name) + '</span>' + badges +
      (x.status === 'published' ? '<a class="mslug" href="' + SITE_HOME + '/attractions/' + esc(x.slug) + '/" target="_blank" rel="noopener">查看页面 ↗</a>' : '') +
      '</div>' +
      '<div class="time">' + esc(x.summary) + '</div>' +
      '<div class="meta">' + esc(fmtTime(x.updated_at)) + '</div>' +
    '</div></div>' +
    '<div class="ops">' +
    '<button type="button" data-act="toggle">' + (x.status === 'published' ? '下线' : '上线') + '</button>' +
    '<button type="button" data-act="edit">编辑</button>' +
    '<button type="button" data-act="del">删除</button></div>';
  div.querySelector('.ops').addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act');
    if (act === 'toggle') {
      api('/api/attractions/' + x.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: x.status === 'published' ? 'hidden' : 'published' })
      }).then(function () { loadAttra(true); });
    } else if (act === 'edit') {
      openAttraForm(x);
    } else if (act === 'del') {
      // 二次点击确认（同视频删除）：首击变红待确认，4 秒未点自动复原；第二击删除（封面一并清理，不可恢复）
      var btn = e.target;
      if (btn.getAttribute('data-armed') !== '1') {
        btn.setAttribute('data-armed', '1');
        btn.className = 'danger';
        btn.textContent = '确认删除';
        setTimeout(function () {
          if (!btn.isConnected) return;
          btn.removeAttribute('data-armed');
          btn.className = '';
          btn.textContent = '删除';
        }, 4000);
        return;
      }
      api('/api/attractions/' + x.id, { method: 'DELETE' }).then(function () { loadAttra(true); });
    }
  });
  return div;
}

function openAttraForm(x) {
  editingAttraId = x ? x.id : null;
  el('atform-title').textContent = x ? '编辑景点 #' + x.id : '新增景点';
  el('at-name').value = x ? x.name || '' : '';
  el('at-slug').value = x ? x.slug || '' : '';
  el('at-status').value = x ? x.status || 'published' : 'published';
  el('at-sort').value = x ? x.sort || 0 : 0;
  el('at-tags').value = x ? x.tags || '' : '';
  el('at-summary').value = x ? x.summary || '' : '';
  el('at-body').value = x ? x.body || '' : '';
  el('at-address').value = x ? x.address || '' : '';
  el('at-hours').value = x ? x.hours || '' : '';
  el('at-tickets').value = x ? x.tickets || '' : '';
  el('at-transport').value = x ? x.transport || '' : '';
  el('at-cover').value = '';
  el('at-coverinfo').textContent = x && x.cover ? '当前封面：' + x.cover : '';
  atHint(null);
  el('atform').style.display = '';
  el('atform').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeAttraForm() { el('atform').style.display = 'none'; editingAttraId = null; }

function atHint(msg) {
  var h = el('at-hint');
  h.textContent = msg || '';
  h.style.display = msg ? '' : 'none';
}

el('atadd').addEventListener('click', function () { openAttraForm(null); });
el('atcancel').addEventListener('click', closeAttraForm);
el('atsave').addEventListener('click', function () {
  var payload = {
    name: val('at-name'), slug: val('at-slug'), status: val('at-status'),
    sort: Number(val('at-sort') || 0), tags: val('at-tags'),
    summary: val('at-summary'), body: val('at-body'),
    address: val('at-address'), hours: val('at-hours'),
    tickets: val('at-tickets'), transport: val('at-transport')
  };
  if (!payload.name || !payload.summary) { alert('请填写名称和一句话简介'); return; }
  if (!editingAttraId && !payload.slug) { alert('请填写 Slug'); return; }
  if (payload.slug && !SLUG_RE_JS.test(payload.slug)) { alert('Slug 仅限小写字母、数字和连字符，且以字母或数字开头。'); return; }
  var cover = el('at-cover').files && el('at-cover').files[0];
  if (cover && cover.size > 5 * 1048576) { alert('封面图超过 5MB。'); return; }

  var btn = el('atsave');
  btn.disabled = true;
  var seq = Promise.resolve();
  if (cover) {
    seq = seq.then(function () {
      atHint('封面上传中…');
      return putFile('/api/attractions/cover', cover);
    }).then(function (d) { payload.cover = d.key; });
  }
  seq.then(function () {
    atHint('保存中…');
    return api(editingAttraId ? '/api/attractions/' + editingAttraId : '/api/attractions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }).then(function () {
    closeAttraForm();
    loadAttra(true);
  }).catch(function (e) {
    if (e.message !== 'unauthorized') alert('保存失败：' + e.message);
  }).then(function () {
    btn.disabled = false;
    atHint(null);
  });
});
el('atmore').addEventListener('click', function () { aState.offset += ${PAGE_SIZE}; loadAttra(false); });

/* ---------- 账号管理（运营账号，权限与主账号相同） ---------- */
var me = '';
function setAccountUI(name) {
  me = name || '';
  el('acct-name').textContent = me || '…';
  el('acct-now').textContent = me ? '当前账号：' + me : '';
}
api('/api/me').then(function (d) { setAccountUI(d.user); }).catch(function () {});

function loadAccounts() {
  api('/api/accounts').then(function (d) {
    var rows = (d.accounts || []).map(function (a) {
      return '<tr><td>' + esc(a.username) + '</td><td>' + esc(fmtTime(a.created_at)) + '</td>' +
        '<td><div class="ops" style="margin-top:0"><button type="button" data-switch="' + esc(a.username) + '">切换到此账号</button>' +
        '<button type="button" data-del="' + a.id + '">删除</button></div></td></tr>';
    }).join('');
    el('alist').innerHTML = rows || '<tr><td colspan="3" class="empty">还没有运营账号，用上方表单添加。</td></tr>';
  }).catch(function (e) {
    if (e.message !== 'unauthorized') el('alist').innerHTML = '<tr><td colspan="3" class="empty">加载失败：' + esc(e.message) + '</td></tr>';
  });
}
el('a-add').addEventListener('click', function () {
  var u = el('a-user').value.trim(), p = el('a-pass').value;
  if (!/^[A-Za-z0-9_-]{2,20}$/.test(u)) { alert('用户名需 2-20 位字母/数字/下划线/连字符'); return; }
  if (p.length < 8) { alert('密码至少 8 位'); return; }
  api('/api/accounts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: p })
  }).then(function () { el('a-user').value = ''; el('a-pass').value = ''; loadAccounts(); })
    .catch(function (e) {
      if (e.message === 'unauthorized') return;
      alert(({
        bad_username: '用户名格式不正确', bad_password: '密码至少 8 位',
        dup_username: '用户名已存在', too_many: '账号数量已达上限（10 个）'
      })[e.message] || '添加失败：' + e.message);
    });
});
el('alist').addEventListener('click', function (e) {
  var sw = e.target.getAttribute('data-switch');
  var del = e.target.getAttribute('data-del');
  if (sw !== null) {
    api('/api/logout', { method: 'POST' }).then(function () { location.href = '/login?u=' + encodeURIComponent(sw); });
  } else if (del) {
    if (!confirm('确定删除该账号？其登录将立即失效。')) return;
    api('/api/accounts/' + del, { method: 'DELETE' }).then(loadAccounts);
  }
});

/* ---------- 我的通行密钥（Passkey；添加流程见下方 PASSKEY_DASH_JS） ---------- */
function loadPasskeys() {
  api('/api/webauthn/list').then(function (d) {
    var rows = (d.keys || []).map(function (k) {
      return '<tr><td>' + esc(k.device || '通行密钥') + '</td><td>' + esc(fmtTime(k.created_at)) + '</td>' +
        '<td><div class="ops" style="margin-top:0"><button type="button" class="pk-del" data-id="' + k.id + '">删除</button></div></td></tr>';
    }).join('');
    el('pk-list').innerHTML = rows || '<tr><td colspan="3" class="empty">还没有通行密钥，点下方「添加通行密钥」。</td></tr>';
  }).catch(function (e) {
    if (e.message !== 'unauthorized') el('pk-list').innerHTML = '<tr><td colspan="3" class="empty">加载失败：' + esc(e.message) + '</td></tr>';
  });
}
loadPasskeys();
el('pk-list').addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('.pk-del') : null;
  if (!btn) return;
  if (!confirm('确定删除该通行密钥？删除后将无法用它登录。')) return;
  api('/api/webauthn/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: Number(btn.getAttribute('data-id')) })
  }).then(loadPasskeys).catch(function (m) { alert('删除失败：' + m.message); });
});
${PASSKEY_DASH_JS}

/* ---------- 右上角账号菜单：切换 / 添加 / 退出 ---------- */
var drop = el('acct-drop');
el('acct-chip').addEventListener('click', function () {
  if (drop.hidden) { renderDrop(); drop.hidden = false; }
  else drop.hidden = true;
});
document.addEventListener('click', function (e) {
  if (!el('acct-box').contains(e.target)) drop.hidden = true;
});
function renderDrop() {
  api('/api/accounts').then(function (d) {
    var html = '<div class="acct-cur">当前账号：<b>' + esc(me || '站长') + '</b></div><div class="acct-sep"></div>';
    if (me && me !== '站长') html += '<button type="button" data-switch="">切换到 站长</button>';
    (d.accounts || []).forEach(function (a) {
      if (a.username !== me) html += '<button type="button" data-switch="' + esc(a.username) + '">切换到 ' + esc(a.username) + '</button>';
    });
    html += '<div class="acct-sep"></div>' +
      '<button type="button" data-act="add">添加账号…</button>' +
      '<button type="button" data-act="logout">退出登录</button>';
    drop.innerHTML = html;
  }).catch(function () { drop.innerHTML = '<button type="button" data-act="logout">退出登录</button>'; });
}
drop.addEventListener('click', function (e) {
  var act = e.target.getAttribute('data-act');
  var sw = e.target.getAttribute('data-switch');
  if (sw !== null) {
    api('/api/logout', { method: 'POST' }).then(function () { location.href = sw ? '/login?u=' + encodeURIComponent(sw) : '/login'; });
  } else if (act === 'add') {
    drop.hidden = true;
    showView('acct');
  } else if (act === 'logout') {
    api('/api/logout', { method: 'POST' }).then(function () { location.href = '/login'; });
  }
});

/* ---------- AI 助手「花傩」（docs/AI助手方案.md） ---------- */
// 注意：APP_HTML 是模板字符串——内嵌脚本原则上不写反斜杠（正则里的转义须双写，单写会被外层吃掉），换行统一用 AI_NL
var AI_NL = String.fromCharCode(10);
var editingKId = null;
var kState = { offset: 0, status: '' };
var K_ST = { published: '参与检索', hidden: '已停用' };

function aiHint(msg) {
  var h = el('ai-hint');
  h.textContent = msg || '';
  h.style.display = msg ? '' : 'none';
}

function loadAi() { loadAiSettings(); loadKnowledge(true); loadAiStats(); }

function loadAiSettings() {
  api('/api/ai/settings').then(function (d) {
    var s = d.settings || {};
    el('ai-enabled').value = s.enabled === '0' ? '0' : '1';
    el('ai-prompt').value = s.system_prompt || '';
    var quick = [];
    try { quick = JSON.parse(s.quick_questions || '[]'); } catch (e) { /* 后台配坏则留空 */ }
    el('ai-quick').value = (quick || []).join(AI_NL);
    var sel = el('ai-model');
    sel.innerHTML = '';
    (d.models || []).forEach(function (mo) {
      var o = document.createElement('option');
      o.value = mo.id;
      o.textContent = mo.label;
      sel.appendChild(o);
    });
    sel.value = s.model || '';
    if (!sel.value) sel.selectedIndex = 0;
  }).catch(function (e) {
    if (e.message !== 'unauthorized') aiHint('设置加载失败：' + e.message);
  });
}

el('ai-savesettings').addEventListener('click', function () {
  var quick = el('ai-quick').value.split(AI_NL).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 6);
  aiHint('保存中…');
  api('/api/ai/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: el('ai-enabled').value, model: el('ai-model').value,
      system_prompt: el('ai-prompt').value, quick: quick
    })
  }).then(function () {
    aiHint('已保存，主站最迟 1 分钟生效');
    loadAiSettings();
  }).catch(function (e) { aiHint('保存失败：' + e.message); });
});

/* 知识库 */
function loadKnowledge(reset) {
  if (reset) kState.offset = 0;
  var q = '?offset=' + kState.offset + (kState.status ? '&status=' + kState.status : '');
  api('/api/ai/knowledge' + q).then(function (d) {
    var list = d.knowledge || [];
    var counts = d.byStatus || {};
    el('ai-stats-line').textContent = '知识 ' + d.total + ' 条 · 参与检索 ' + (counts.published || 0) + ' · 停用 ' + (counts.hidden || 0);
    var box = el('klist');
    if (reset) box.innerHTML = '';
    if (reset && list.length === 0) {
      box.innerHTML = '<p class="empty">知识库为空：可执行 scripts/archive/ai-seed.sql 导入旧站 68 条种子，或点右上「新增知识」。</p>';
    } else {
      list.forEach(function (x) { box.appendChild(renderKnowledge(x)); });
    }
    el('kmore').style.display = (kState.offset + ${PAGE_SIZE} < d.total && list.length > 0) ? 'block' : 'none';
  }).catch(function (e) {
    if (e.message !== 'unauthorized') el('klist').innerHTML = '<p class="empty">加载失败：' + esc(e.message) + '</p>';
  });
}

function renderKnowledge(x) {
  var div = document.createElement('div');
  div.className = 'msg' + (x.status === 'published' ? '' : ' read');
  var badges =
    '<span class="k-badge">#' + x.id + '</span>' +
    '<span class="k-badge">排序 ' + (x.sort || 0) + '</span>' +
    '<span class="mst ' + (x.status === 'published' ? 'mst-approved' : 'mst-rejected') + '">' + (K_ST[x.status] || x.status) + '</span>';
  div.innerHTML =
    '<div class="row1"><span class="name">' + esc(x.category) + '</span>' + badges + '</div>' +
    '<div class="body">' + esc(x.content.length > 140 ? x.content.slice(0, 140) + '…' : x.content) + '</div>' +
    '<div class="time">关键词：' + esc(x.keywords) + '</div>' +
    '<div class="meta">' + esc(fmtTime(x.updated_at)) + '</div>' +
    '<div class="ops">' +
    '<button type="button" data-act="toggle">' + (x.status === 'published' ? '停用' : '启用') + '</button>' +
    '<button type="button" data-act="edit">编辑</button>' +
    '<button type="button" data-act="del">删除</button></div>';
  div.querySelector('.ops').addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act');
    if (act === 'toggle') {
      api('/api/ai/knowledge/' + x.id, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: x.status === 'published' ? 'hidden' : 'published' })
      }).then(function () { loadKnowledge(false); });
    } else if (act === 'edit') {
      openKnowledgeForm(x);
    } else if (act === 'del') {
      // 二次点击确认（同景点删除）：首击变红待确认，4 秒未点自动复原
      var btn = e.target;
      if (btn.getAttribute('data-armed') !== '1') {
        btn.setAttribute('data-armed', '1');
        btn.className = 'danger';
        btn.textContent = '确认删除';
        setTimeout(function () {
          if (!btn.isConnected) return;
          btn.removeAttribute('data-armed');
          btn.className = '';
          btn.textContent = '删除';
        }, 4000);
        return;
      }
      api('/api/ai/knowledge/' + x.id, { method: 'DELETE' }).then(function () { loadKnowledge(false); });
    }
  });
  return div;
}

function openKnowledgeForm(x) {
  editingKId = x ? x.id : null;
  el('kform-title').textContent = x ? '编辑知识 #' + x.id : '新增知识';
  el('k-category').value = x ? x.category || '' : '';
  el('k-content').value = x ? x.content || '' : '';
  el('k-keywords').value = x ? x.keywords || '' : '';
  el('k-sort').value = x ? x.sort || 0 : 0;
  el('k-status').value = x ? x.status || 'published' : 'published';
  kHint(null);
  el('kform').style.display = '';
  el('kform').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function kHint(msg) {
  var h = el('k-hint');
  h.textContent = msg || '';
  h.style.display = msg ? '' : 'none';
}

el('k-add').addEventListener('click', function () { openKnowledgeForm(null); });
el('kcancel').addEventListener('click', function () { el('kform').style.display = 'none'; editingKId = null; });
el('ksave').addEventListener('click', function () {
  var payload = {
    category: val('k-category'), content: val('k-content'), keywords: val('k-keywords'),
    sort: Number(val('k-sort') || 0), status: val('k-status')
  };
  if (!payload.category || !payload.content) { alert('请填写分类和内容'); return; }
  kHint('保存中…');
  api(editingKId ? '/api/ai/knowledge/' + editingKId : '/api/ai/knowledge', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function () {
    el('kform').style.display = 'none';
    editingKId = null;
    loadKnowledge(true);
  }).catch(function (e) { kHint('保存失败：' + e.message); });
});
el('kmore').addEventListener('click', function () { kState.offset += ${PAGE_SIZE}; loadKnowledge(false); });

/* 用量统计 */
function loadAiStats() {
  api('/api/ai/stats').then(function (d) {
    el('ai-usage').textContent = '今日 ' + d.today + ' 问 · 7 天 ' + d.d7 + ' · 30 天 ' + d.d30 + ' · 累计 ' + d.total;
    var box = el('ai-log');
    var recent = d.recent || [];
    if (!recent.length) { box.innerHTML = '<p class="empty">暂无问答记录。</p>'; return; }
    box.innerHTML = '';
    recent.forEach(function (r) {
      var div = document.createElement('div');
      div.className = 'msg read';
      var src = '';
      if (r.sources) { try { src = JSON.parse(r.sources).join('、'); } catch (e) { src = r.sources; } }
      div.innerHTML =
        '<div class="row1"><span class="name">' + esc(r.question) + '</span>' +
        (r.action ? '<span class="k-badge">' + esc(r.action) + '</span>' : '') +
        (src ? '<span class="k-badge">来源 ' + esc(src) + '</span>' : '') +
        '<span class="k-badge">' + (r.duration_ms || 0) + 'ms</span></div>' +
        '<div class="time">' + esc(fmtTime(r.created_at)) + '</div>';
      box.appendChild(div);
    });

    var mbox = el('ai-miss');
    el('ai-miss-n').textContent = (d.miss7 || 0) + '/' + (d.n7 || 0);
    var misses = d.misses || [];
    if (!misses.length) {
      mbox.innerHTML = '<p class="empty">7 天内没有未命中知识库的问题，覆盖良好。</p>';
    } else {
      mbox.innerHTML = '';
      misses.forEach(function (r) {
        var div = document.createElement('div');
        div.className = 'msg read';
        div.innerHTML =
          '<div class="row1"><span class="name">' + esc(r.question) + '</span></div>' +
          '<div class="time">' + esc(fmtTime(r.created_at)) + '</div>';
        mbox.appendChild(div);
      });
    }
  }).catch(function () {
    el('ai-log').innerHTML = '<p class="empty">加载失败</p>';
    el('ai-miss').innerHTML = '<p class="empty">加载失败</p>';
  });
}

(function () {
  var btn = el('ai-log-clear');
  btn.addEventListener('click', function () {
    if (btn.getAttribute('data-armed') !== '1') {
      btn.setAttribute('data-armed', '1');
      btn.className = 'danger';
      btn.textContent = '确认清空';
      setTimeout(function () {
        if (!btn.isConnected) return;
        btn.removeAttribute('data-armed');
        btn.className = '';
        btn.textContent = '清空问答日志';
      }, 4000);
      return;
    }
    api('/api/ai/log', { method: 'DELETE' }).then(function () { loadAiStats(); });
  });
})();

/* ---------- 移动端抽屉 ---------- */
var burger = el('burger'), drawer = el('anav-drawer');
burger.addEventListener('click', function () {
  var open = drawer.classList.toggle('open');
  burger.setAttribute('aria-expanded', open ? 'true' : 'false');
});
drawer.addEventListener('click', function (e) {
  if (e.target.closest('a')) {
    drawer.classList.remove('open');
    burger.setAttribute('aria-expanded', 'false');
  }
});
el('logout-m').addEventListener('click', function (e) {
  e.preventDefault();
  api('/api/logout', { method: 'POST' }).then(function () { location.href = '/login'; });
});

/* 初始视图：从 location.hash 恢复（如 #/visit），无 hash 回留言 */
showView(hashView() || 'msg', true);
</script>
</body>
</html>`;
