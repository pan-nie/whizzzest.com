/**
 * 焰境·万载 — 文库作者门户 Worker（writer.whizzzest.com，docs/文库方案.md）
 *
 *  - GET  /register          作者注册（双方式：手机号+密码 ｜ 邮箱+验证码+密码）
 *  - GET  /login             登录（手机号+密码 或 邮箱+验证码，照抄商户门户交互）
 *  - GET  /dashboard         作品台：我的作品（状态/章节数/字数/驳回原因）+ 账号安全
 *  - GET  /book/new          新建作品（标题/分类/笔名/简介/封面）
 *  - GET  /book/<id>/edit    编辑作品元数据（内容改动 → 整本重新审核）
 *  - GET  /book/<id>/chapters        章节管理（列表：序号/状态/驳回原因）
 *  - GET  /book/<id>/chapter/new     新建章节（分段纯文本 + [图] 占位 + 插图上传）
 *  - GET  /book/<id>/chapter/<cid>   编辑章节
 *  - POST /api/register      手机号注册 → 自动登录
 *  - POST /api/register/email  邮箱注册（验证码验证邮箱 + 设密码）→ 自动登录
 *  - POST /api/login         手机号+密码 → HMAC 会话 Cookie（wr_session）
 *  - POST /api/email-code    发送 6 位邮箱验证码（无会话=login/register；带会话=bind）
 *  - POST /api/login/email   邮箱+验证码登录
 *  - POST /api/bind-email    绑定/更换登录邮箱
 *  - POST /api/logout
 *  - POST /api/book          创建作品（multipart）→ 进入章节编辑
 *  - POST /api/book/<id>     更新作品元数据（multipart；整本回 pending 重审）
 *  - POST /api/book/<id>/delete        删除作品（级联章节 + R2 图片）
 *  - POST /api/book/<id>/chapter       新建章节（该章 pending；已上线作品不受影响）
 *  - POST /api/chapter/<cid>           更新章节（回 pending 重审；重传插图则整体替换）
 *  - POST /api/chapter/<cid>/delete    删除章节（不触发作品审核，即时生效）
 *
 * 审核：作品级（新建/元数据改动 → pending）+ 章节级（新章/改章 → pending，审过才可读）；
 *       admin 直接创建的作品免审。驳回原因在作品台可见。
 * 媒体：R2 桶 whizzzest-media，封面 book/c-*.jpg、插图 book/b<bookId>/…；
 *       公开读取走主站 https://whizzzest.com/media/<key>（主 Worker 代理）。
 * 邮件：验证码经 notifications@whizzzest.com（worker/smtp.js），需 secret SMTP_USER / SMTP_PASS。
 */
import { sendMail } from '../worker/smtp.js';
import { requireHttps } from '../shared/https.mjs';
import { authPage, loginPanel, passkeyRowHtml, PASSKEY_DASH_JS, ICO } from '../shared/portal-ui.js';
import { createWebAuthn } from '../shared/webauthn.js';
import { normalizePhone, phoneCountryOptionsHtml, maskPhone } from '../shared/phone.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_S = SESSION_TTL_MS / 1000;
const COOKIE_NAME = 'wr_session';

const SITE = 'https://whizzzest.com';
const CONTACT_EMAIL = 'contact@whizzzest.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const CATEGORIES = { novel: '小说', story: '故事', essay: '随笔', other: '其他' };
const IMG_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_FIGURES = 9;             // 每章插图上限
const MAX_IMG_BYTES = 5 * 1024 * 1024;
const MAX_CHAPTERS = 500;          // 每部作品章节上限
const MAX_BODY = 30000;            // 单章正文字符上限

const FAVICON_LINK = '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBzdGFuZGFsb25lPSJubyI/PjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+PHN2ZyB0PSIxNzcwNjM5ODE2OTM3IiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9Ijg1MzgiIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCI+PHBhdGggZD0iTTUxMi44IDQyMC44Yy0xNTYuOCAyMzQuNC0xNDEuNiA1NzYuOC00OCA1NzguNCA5Ni44IDIuNC0xNC40LTM5NC40IDQ4LTU3OC40ek00ODAuOCAzOTUuMmMtMjI3LjIgNzQuNC0zOTIgMzExLjItMzI4LjggMzYxLjYgNjQuOCA1MiAxOTEuMi0yNzIgMzI4LjgtMzYxLjZ6TTQ4Ny4yIDM3NkMyOTAuNCAyODggMjQgMzMyIDMxLjIgMzk5LjJjNy4yIDY4LjggMzA3LjItNDkuNiA0NTYtMjMuMnpNNTEyLjggMzU0LjRjLTg5LjYtMTY5LjYtMzAwLTMwMC44LTMzMS4yLTI1Ni0zMiA0Ni40IDI0MS42IDE1MiAzMzEuMiAyNTZ6TTUzMS4yIDM1NC40QzYyNi40IDIyOCA2MzIgMzQuNCA1ODAuOCAyOS42Yy01Mi44LTQuOC03LjIgMjIzLjItNDkuNiAzMjQuOHpNNTQ4IDM2Ni40YzE0NC44IDMuMiAyOTUuMi05NC40IDI3Mi0xMzUuMi0yNC00MS42LTE3My42IDExMi0yNzIgMTM1LjJ6TTU2MS42IDM5OS4yYzE2MCAxMTkuMiA0MjAgMTYwLjggNDMxLjIgMTA5LjYgMTEuMi01Mi44LTI5OS4yLTQ4LjgtNDMxLjItMTA5LjZ6TTUzOS4yIDQyNi40YzI5LjYgMjE2IDIxMS4yIDQxNy42IDI2NC44IDM3NS4yIDU1LjItNDMuMi0yMDcuMi0yMzMuNi0yNjQuOC0zNzUuMnoiIGZpbGw9IiNFODM1MTgiIHAtaWQ9Ijg1MzkiPjwvcGF0aD48cGF0aCBkPSJNOTE5LjIgNjIyLjRsMTYgMzIuOCAzNiA0LjgtMjUuNiAyNS42IDUuNiAzNi0zMi0xNi44LTMyIDE2LjggNi40LTM2LTI2LjQtMjUuNiAzNi00Ljh6IiBmaWxsPSIjRjREMzFGIiBwLWlkPSI4NTQwIj48L3BhdGg+PHBhdGggZD0iTTUyMCAzMzkuMmwxNiAzMi44IDM2IDUuNi0yNS42IDI0LjggNS42IDM2LTMyLTE2LjgtMzIgMTYuOCA2LjQtMzYtMjYuNC0yNC44IDM2LTUuNnpNMjM5LjIgNzkyLjhsMTQuNCAzMC40IDM0LjQgNC44LTI0LjggMjQgNS42IDMzLjYtMjkuNi0xNi0zMC40IDE2IDUuNi0zMy42LTI0LjgtMjQgMzQuNC00Ljh6TTE1MS4yIDE4OGgtMzJ2LTMyYzAtMi40LTEuNi00LTQtNHMtNCAxLjYtNCA0djMyaC0zMmMtMi40IDAtNCAxLjYtNCA0czEuNiA0IDQgNGgzMnYzMmMwIDIuNCAxLjYgNCA0IDRzNC0xLjYgNC00di0zMmgzMmMyLjQgMCA0LTEuNiA0LTRzLTEuNi00LTQtNHoiIGZpbGw9IiNGNUUzMjgiIHAtaWQ9Ijg1NDEiPjwvcGF0aD48L3N2Zz4=">';
// 品牌图标 data URI（认证页共享壳 shared/portal-ui.js 复用：顶栏 logo / 侧栏 / favicon）
const LOGO_URI = (FAVICON_LINK.match(/href="([^"]+)"/) || [])[1] || '';

/* 认证页门户配置（writer / merchant 各一份，结构一致，文案各自维护） */
const PORTAL_UI = {
  brand: '焰境文库',
  area: '作者中心',
  home: SITE + '/library/',
  logoUri: LOGO_URI,
  slogan: '把你的万载故事，写给每一位读者',
  highlights: [
    '免费写作，作品与章节双审核',
    'Markdown 正文，章节化管理',
    '审核进度与驳回原因透明可见',
    '审过即上线 whizzzest.com/library/',
  ],
};

/* 通行密钥（WebAuthn/Passkey）：验证逻辑在 shared/webauthn.js，D1 读写留在本 Worker */
const wa = createWebAuthn({
  portal: 'writer',
  rpName: '焰境文库 · 作者中心',
  secret: (env) => env.WRITER_SESSION_SECRET || null,
  limited,
  listCredentials: (env, uid) =>
    env.DB.prepare('SELECT id, credential_id, public_key, counter, transports FROM webauthn_credentials WHERE portal = ?1 AND user_id = ?2 ORDER BY id')
      .bind('writer', uid).all().then((r) => r.results || []),
  findCredential: (env, credId) =>
    env.DB.prepare('SELECT id, user_id, credential_id, public_key, counter FROM webauthn_credentials WHERE portal = ?1 AND credential_id = ?2')
      .bind('writer', credId).first(),
  insertCredential: (env, uid, c, device) =>
    env.DB.prepare('INSERT INTO webauthn_credentials (portal, user_id, credential_id, public_key, counter, transports, device) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind('writer', uid, c.id, c.publicKey, c.counter, JSON.stringify(c.transports || []), device).run(),
  deleteCredential: (env, uid, rowId) =>
    env.DB.prepare('DELETE FROM webauthn_credentials WHERE portal = ?1 AND user_id = ?2 AND id = ?3')
      .bind('writer', uid, rowId).run(),
  touchCounter: (env, rowId, counter) =>
    env.DB.prepare('UPDATE webauthn_credentials SET counter = ?2 WHERE id = ?1').bind(rowId, counter).run(),
  issueSession: (env, uid) => authedResponse(env.WRITER_SESSION_SECRET, uid),
  userName: (user) => user.login_email
    || (user.login_phone ? maskPhone(user.login_phone) : '作者 ' + user.uid),
});


export default {
  async fetch(request, env) {
    const insecure = requireHttps(request);
    if (insecure) return insecure;
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    const baseHeaders = {
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    };

    try {
      if (path.startsWith('/api/')) {
        const res = await handleApi(request, env, path, url);
        Object.entries(baseHeaders).forEach(([k, v]) => res.headers.set(k, v));
        return res;
      }

      const res = await handlePage(request, env, path, url);
      Object.entries(baseHeaders).forEach(([k, v]) => res.headers.set(k, v));
      res.headers.set('content-security-policy', [
        "default-src 'self'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data: https://whizzzest.com", // 封面/插图缩略走主站 /media/ 代理
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '));
      return res;
    } catch (err) {
      console.error('writer worker error:', err);
      return new Response('服务暂时不可用，请稍后再试。', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
};

/* ---------------- 路由 ---------------- */

async function handlePage(request, env, path, url) {
  if (path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const user = await currentUser(request, env);

  if (path === '/register') {
    if (user) return redirect('/dashboard');
    return html(registerHtml(url));
  }
  if (path === '/login') {
    if (user) return redirect('/dashboard');
    return html(loginHtml(url));
  }
  if (path === '/') return redirect(user ? '/dashboard' : '/login');

  // 以下全部需要登录
  if (!user) return redirect('/login');

  if (path === '/dashboard') return html(await dashboardHtml(env, user, url));

  let m;
  if (path === '/book/new') return html(bookFormHtml(null));
  if ((m = path.match(/^\/book\/(\d+)\/edit$/))) {
    const book = await ownedBook(env, user, Number(m[1]));
    if (!book) return redirect('/dashboard');
    return html(bookFormHtml(book));
  }
  if ((m = path.match(/^\/book\/(\d+)\/chapters$/))) {
    const book = await ownedBook(env, user, Number(m[1]));
    if (!book) return redirect('/dashboard');
    return html(await chaptersHtml(env, book, url));
  }
  if ((m = path.match(/^\/book\/(\d+)\/chapter\/new$/))) {
    const book = await ownedBook(env, user, Number(m[1]));
    if (!book) return redirect('/dashboard');
    const { results } = await env.DB.prepare(
      'SELECT idx FROM book_chapters WHERE book_id = ?1 ORDER BY idx'
    ).bind(book.id).all();
    const used = (results || []).map((r) => r.idx);
    const nextIdx = used.length ? Math.min(MAX_CHAPTERS, Math.max(...used) + 1) : 1;
    return html(chapterFormHtml(book, null, nextIdx, used));
  }
  if ((m = path.match(/^\/book\/(\d+)\/chapter\/(\d+)$/))) {
    const book = await ownedBook(env, user, Number(m[1]));
    if (!book) return redirect('/dashboard');
    const ch = await env.DB.prepare(
      'SELECT * FROM book_chapters WHERE id = ?1 AND book_id = ?2'
    ).bind(Number(m[2]), book.id).first();
    if (!ch) return redirect(`/book/${book.id}/chapters`);
    const { results } = await env.DB.prepare(
      'SELECT idx FROM book_chapters WHERE book_id = ?1 AND id != ?2 ORDER BY idx'
    ).bind(book.id, ch.id).all();
    return html(chapterFormHtml(book, ch, ch.idx, (results || []).map((r) => r.idx)));
  }

  return redirect('/dashboard');
}

async function handleApi(request, env, path, url) {
  const method = request.method;

  // 公开接口（自行限流）
  if (path === '/api/register' && method === 'POST') return handleRegister(request, env);
  if (path === '/api/register/email' && method === 'POST') return handleRegisterEmail(request, env);
  if (path === '/api/login' && method === 'POST') return handleLogin(request, env);
  if (path === '/api/email-code' && method === 'POST') {
    const u = await currentUser(request, env);
    return sendEmailCode(request, env, u);
  }
  if (path === '/api/login/email' && method === 'POST') return handleEmailLogin(request, env);
  // 通行密钥：login-* 公开（内部限流），reg-*/delete 需登录（shared/webauthn.js 内部判定）
  if (path.startsWith('/api/webauthn/')) {
    const u = await currentUser(request, env);
    return wa.handle(request, env, path, u);
  }
  if (path === '/api/logout' && method === 'POST') {
    const res = json({ ok: true });
    res.headers.set('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return res;
  }

  // 以下接口需登录 + 同源校验
  const user = await currentUser(request, env);
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);
  const origin = request.headers.get('origin');
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === request.headers.get('host');
    } catch { /* 非法 origin 一律拒绝 */ }
    if (!sameOrigin) return json({ ok: false, error: 'bad_origin' }, 403);
  }

  let m;
  if (path === '/api/book' && method === 'POST') return handleBookCreate(request, env, user);
  if ((m = path.match(/^\/api\/book\/(\d+)$/)) && method === 'POST') {
    return handleBookUpdate(request, env, user, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/book\/(\d+)\/delete$/)) && method === 'POST') {
    return handleBookDelete(env, user, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/book\/(\d+)\/chapter$/)) && method === 'POST') {
    return handleChapterSave(request, env, user, Number(m[1]), null);
  }
  if ((m = path.match(/^\/api\/chapter\/(\d+)$/)) && method === 'POST') {
    return handleChapterUpdate(request, env, user, Number(m[1]));
  }
  if ((m = path.match(/^\/api\/chapter\/(\d+)\/delete$/)) && method === 'POST') {
    return handleChapterDelete(env, user, Number(m[1]));
  }
  if (path === '/api/bind-email' && method === 'POST') return handleBindEmail(request, env, user);

  return json({ ok: false, error: 'not_found' }, 404);
}

/* ---------------- 限流 ---------------- */

const buckets = new Map();
function limited(key, windowMs, max) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) buckets.clear();
  return hits.length > max;
}

/* ---------------- 注册 / 登录 / 会话 ---------------- */

async function handleRegister(request, env) {
  if (!env.WRITER_SESSION_SECRET) return json({ ok: false, error: 'config' }, 500);
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && limited('wreg:' + ip, 60 * 60 * 1000, 3)) return json({ ok: false, error: 'rate' }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'format' }, 400);
  }
  // Honeypot：机器人填了隐藏字段 → 假装成功
  if (String(body?.website || '') !== '') return json({ ok: true });

  const phone = normalizePhone(String(body?.phone || ''), String(body?.country || ''));
  const password = String(body?.password || '');
  if (!phone.ok) return json({ ok: false, error: 'phone' }, 400);
  if (password.length < 8 || password.length > 64) return json({ ok: false, error: 'password' }, 400);

  const dup = await env.DB.prepare('SELECT id FROM writer_users WHERE phone = ?1').bind(phone.e164).first();
  if (dup) return json({ ok: false, error: 'dup' }, 409);

  const salt = crypto.randomUUID().replace(/-/g, '');
  const hash = await pbkdf2Hex(password, salt);
  const r = await env.DB.prepare(
    'INSERT INTO writer_users (phone, pass_hash, pass_salt) VALUES (?1,?2,?3)'
  ).bind(phone.e164, hash, salt).run();
  return authedResponse(env.WRITER_SESSION_SECRET, r.meta.last_row_id);
}

/** 邮箱注册：验证码验证邮箱归属 + 设密码 → 纯邮箱账号（phone 为 NULL），建号即登录 */
async function handleRegisterEmail(request, env) {
  if (!env.WRITER_SESSION_SECRET) return json({ ok: false, error: 'config' }, 500);
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && limited('wrege:' + ip, 60 * 60 * 1000, 3)) return json({ ok: false, error: 'rate' }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'format' }, 400);
  }
  if (String(body?.website || '') !== '') return json({ ok: true }); // Honeypot

  const email = String(body?.email || '').trim().toLowerCase();
  const code = String(body?.code || '').replace(/\s/g, '');
  const password = String(body?.password || '');
  if (!EMAIL_RE.test(email) || email.length > 100) return json({ ok: false, error: 'email' }, 400);
  if (password.length < 8 || password.length > 64) return json({ ok: false, error: 'password' }, 400);

  const dup = await env.DB.prepare('SELECT id FROM writer_users WHERE email = ?1').bind(email).first();
  if (dup) return json({ ok: false, error: 'taken' }, 409);

  const verr = await verifyEmailCode(env, email, 'register', code);
  if (verr) return json({ ok: false, error: verr }, 401);

  const salt = crypto.randomUUID().replace(/-/g, '');
  const hash = await pbkdf2Hex(password, salt);
  const r = await env.DB.prepare(
    'INSERT INTO writer_users (phone, email, pass_hash, pass_salt) VALUES (NULL, ?1, ?2, ?3)'
  ).bind(email, hash, salt).run();
  return authedResponse(env.WRITER_SESSION_SECRET, r.meta.last_row_id);
}

async function handleLogin(request, env) {
  if (!env.WRITER_SESSION_SECRET) return json({ ok: false, error: 'config' }, 500);
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && limited('wlogin:' + ip, 10 * 60 * 1000, 5)) return json({ ok: false, error: 'rate' }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'format' }, 400);
  }
  const phone = normalizePhone(String(body?.phone || ''), String(body?.country || ''));
  const password = String(body?.password || '');
  if (!phone.ok) return json({ ok: false, error: 'bad' }, 401);

  const row = await env.DB.prepare(
    'SELECT id, pass_hash, pass_salt FROM writer_users WHERE phone = ?1'
  ).bind(phone.e164).first();
  if (!row) return json({ ok: false, error: 'bad' }, 401);

  const hash = await pbkdf2Hex(password, row.pass_salt);
  if (!timingSafeEqual(hash, row.pass_hash)) return json({ ok: false, error: 'bad' }, 401);

  return authedResponse(env.WRITER_SESSION_SECRET, row.id);
}

function authedResponse(secret, uid) {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return hmacHex(secret, uid + '.' + exp).then((sig) => {
    const res = json({ ok: true });
    res.headers.set(
      'Set-Cookie',
      `${COOKIE_NAME}=${uid}.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_S}`
    );
    res.headers.set('Location', '/dashboard');
    return new Response(null, { status: 302, headers: res.headers });
  });
}

async function currentUser(request, env) {
  if (!env.WRITER_SESSION_SECRET) return null;
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([0-9]+)\\.([0-9]+)\\.([a-f0-9]{64})`));
  if (!m) return null;
  const [, uid, exp, sig] = m;
  if (Number(exp) < Date.now()) return null;
  const expected = await hmacHex(env.WRITER_SESSION_SECRET, uid + '.' + exp);
  if (!timingSafeEqual(sig, expected)) return null;
  return env.DB.prepare(
    'SELECT id AS uid, phone AS login_phone, email AS login_email FROM writer_users WHERE id = ?1'
  ).bind(Number(uid)).first();
}

/* ---------------- 邮箱验证码（登录补充 / 绑定邮箱，照抄商户门户逻辑） ---------------- */

async function sendEmailCode(request, env, user) {
  if (!env.SMTP_USER || !env.SMTP_PASS) return json({ ok: false, error: 'config' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'format' }, 400);
  }
  // 未登录时的用途：body.purpose='register' → 注册验证（邮箱被占用如实报错）；默认 login（防枚举）
  const purpose = user ? 'bind'
    : String(body?.purpose || '') === 'register' ? 'register' : 'login';
  const email = String(body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 100) return json({ ok: false, error: 'format' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && limited('wecode:' + ip, 10 * 60 * 1000, 6)) return json({ ok: false, error: 'rate' }, 429);

  if (user) {
    const dup = await env.DB.prepare(
      'SELECT id FROM writer_users WHERE email = ?1 AND id != ?2'
    ).bind(email, user.uid).first();
    if (dup) return json({ ok: false, error: 'taken' }, 400);
  } else if (purpose === 'register') {
    // 注册用途：邮箱已注册如实报错（引导去登录）
    const dup = await env.DB.prepare('SELECT id FROM writer_users WHERE email = ?1').bind(email).first();
    if (dup) return json({ ok: false, error: 'taken' }, 400);
  } else {
    // 登录用途：邮箱未绑定任何账号时不发码、不落库，仍返回成功（防枚举）
    const known = await env.DB.prepare('SELECT id FROM writer_users WHERE email = ?1').bind(email).first();
    if (!known) return json({ ok: true });
  }

  const last = await env.DB.prepare('SELECT created_at FROM email_login_codes WHERE email = ?1').bind(email).first();
  if (last) {
    const age = Date.now() - new Date(String(last.created_at).replace(' ', 'T') + 'Z').getTime();
    if (age < 60_000) return json({ ok: false, error: 'too_fast' }, 429);
  }

  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const code = String(100000 + (buf[0] % 900000));
  await env.DB.prepare(
    `INSERT INTO email_login_codes (email, code_hash, purpose, expires_at, attempts, created_at)
     VALUES (?1, ?2, ?3, datetime('now', '+10 minutes'), 0, datetime('now'))
     ON CONFLICT(email) DO UPDATE SET code_hash = ?2, purpose = ?3,
       expires_at = datetime('now', '+10 minutes'), attempts = 0, created_at = datetime('now')`
  ).bind(email, await sha256Hex(code), purpose).run();

  try {
    await sendCodeEmail(env, email, code, purpose);
  } catch (err) {
    console.error(`email code send failed (${purpose}):`, err);
    // bind / register 场景如实报错（用户需要知道没发出去）；login 保持防枚举静默
    if (user || purpose === 'register') return json({ ok: false, error: 'send_failed' }, 500);
  }
  return json({ ok: true });
}

async function sendCodeEmail(env, email, code, purpose) {
  const action = purpose === 'bind' ? '绑定焰境文库邮箱' : '登录焰境文库作者中心';
  const FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif";
  await sendMail({
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    to: email,
    fromName: '焰境·万载文库',
    subject: '验证码（10 分钟内有效）', // 主题不带码（原拼 code 前两位+时间戳，标题与实际验证码对不上；与 merchant/im 对齐）
    html: `<div style="margin:0;padding:32px 16px;background:#f5f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:20px;">
  <tr><td style="padding:30px 36px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding-right:10px;vertical-align:middle;"><img src="https://whizzzest.com/logo.png" width="30" height="30" alt="焰境·万载" style="display:block;border:0;"></td>
      <td style="vertical-align:middle;font-family:${FONT};font-size:17px;font-weight:600;color:#1d1d1f;">焰境·万载 · 焰境文库</td>
    </tr></table>
    <div style="margin-top:24px;font-family:${FONT};font-size:15px;color:#1d1d1f;line-height:1.7;">你正在进行<b>${action}</b>操作，验证码：</div>
  </td></tr>
  <tr><td align="center" style="padding:16px 36px 4px;">
    <div style="font-family:${FONT};font-size:42px;font-weight:700;letter-spacing:12px;color:#d64524;">${code}</div>
  </td></tr>
  <tr><td style="padding:8px 36px 0;">
    <div style="font-family:${FONT};font-size:13px;color:#6e6e73;line-height:1.8;">验证码 10 分钟内有效，请勿泄露给他人。<br>若非本人操作，请忽略本邮件。</div>
  </td></tr>
  <tr><td align="center" style="padding:26px 36px 6px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background:#d64524;border-radius:980px;">
        <a href="https://writer.whizzzest.com/dashboard" style="display:inline-block;padding:11px 34px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">前往作者中心</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:16px 36px 30px;">
    <div style="font-family:${FONT};font-size:12px;color:#86868b;line-height:1.8;">按钮无法点击？复制链接打开：<a href="https://writer.whizzzest.com/dashboard" style="color:#d64524;text-decoration:none;">writer.whizzzest.com/dashboard</a></div>
  </td></tr>
  <tr><td style="padding:16px 36px;background:#fafafc;border-top:1px solid rgba(0,0,0,.06);border-radius:0 0 20px 20px;">
    <div style="font-family:${FONT};font-size:12px;color:#86868b;line-height:1.9;">焰境·万载 · 焰境文库（<a href="https://whizzzest.com/" style="color:#86868b;text-decoration:none;">whizzzest.com</a>）｜ 联系：<a href="mailto:contact@whizzzest.com" style="color:#86868b;">contact@whizzzest.com</a><br>本邮件由系统自动发送，请勿直接回复。</div>
  </td></tr>
</table>
</td></tr></table>
</div>`,
  });
}

async function verifyEmailCode(env, email, purpose, code) {
  const row = await env.DB.prepare(
    'SELECT code_hash, purpose, expires_at, attempts FROM email_login_codes WHERE email = ?1'
  ).bind(email).first();
  if (!row || row.purpose !== purpose || row.attempts >= 5) return 'bad';
  if (new Date(String(row.expires_at).replace(' ', 'T') + 'Z').getTime() < Date.now()) return 'expired';
  const okCode = timingSafeEqual(await sha256Hex(code), row.code_hash);
  if (!okCode) {
    await env.DB.prepare('UPDATE email_login_codes SET attempts = attempts + 1 WHERE email = ?1').bind(email).run();
    return 'bad';
  }
  await env.DB.prepare('DELETE FROM email_login_codes WHERE email = ?1').bind(email).run();
  return null;
}

async function handleEmailLogin(request, env) {
  if (!env.WRITER_SESSION_SECRET) return json({ ok: false, error: 'config' }, 500);
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && limited('wlogine:' + ip, 10 * 60 * 1000, 10)) return json({ ok: false, error: 'rate' }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'format' }, 400);
  }
  const email = String(body?.email || '').trim().toLowerCase();
  const code = String(body?.code || '').replace(/\s/g, '');
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return json({ ok: false, error: 'bad' }, 401);

  const verr = await verifyEmailCode(env, email, 'login', code);
  if (verr) return json({ ok: false, error: verr }, 401);

  const row = await env.DB.prepare('SELECT id FROM writer_users WHERE email = ?1').bind(email).first();
  if (!row) return json({ ok: false, error: 'bad' }, 401);
  return authedResponse(env.WRITER_SESSION_SECRET, row.id);
}

async function handleBindEmail(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'format' }, 400);
  }
  const email = String(body?.email || '').trim().toLowerCase();
  const code = String(body?.code || '').replace(/\s/g, '');
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return json({ ok: false, error: 'format' }, 400);

  const dup = await env.DB.prepare(
    'SELECT id FROM writer_users WHERE email = ?1 AND id != ?2'
  ).bind(email, user.uid).first();
  if (dup) return json({ ok: false, error: 'taken' }, 400);

  const verr = await verifyEmailCode(env, email, 'bind', code);
  if (verr) return json({ ok: false, error: verr }, 401);

  try {
    await env.DB.prepare('UPDATE writer_users SET email = ?1 WHERE id = ?2').bind(email, user.uid).run();
  } catch {
    return json({ ok: false, error: 'taken' }, 400);
  }
  return json({ ok: true });
}

function maskEmail(email) {
  const i = email.indexOf('@');
  if (i <= 1) return email;
  return email.slice(0, Math.min(2, i - 1)) + '***' + email.slice(i);
}

/* ---------------- 作品 ---------------- */

/** 当前作者拥有的作品（admin 直建的 writer_id 为 NULL，作者端不可见） */
async function ownedBook(env, user, id) {
  return env.DB.prepare('SELECT * FROM books WHERE id = ?1 AND writer_id = ?2').bind(id, user.uid).first();
}

function readBookForm(form) {
  const clean = (k, max) => String(form.get(k) ?? '').trim().slice(0, max);
  return {
    title: clean('title', 80),
    category: clean('category', 20),
    author_name: clean('author_name', 40),
    intro: clean('intro', 500),
  };
}

async function handleBookCreate(request, env, user) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && limited('wbook:' + ip, 60 * 60 * 1000, 10)) return redirect('/book/new?err=rate');

  let form;
  try {
    form = await request.formData();
  } catch {
    return redirect('/book/new?err=format');
  }
  if (String(form.get('website') || '') !== '') return redirect('/dashboard');

  const f = readBookForm(form);
  if (!f.title || !f.intro || !CATEGORIES[f.category]) return redirect('/book/new?err=fields');

  const r = await env.DB.prepare(
    `INSERT INTO books (title, category, intro, author_name, writer_id, status)
     VALUES (?1,?2,?3,?4,?5,'pending')`
  ).bind(f.title, f.category, f.intro, f.author_name || null, user.uid).run();
  const bookId = r.meta.last_row_id;

  try {
    const cover = await storeCover(env, bookId, form);
    if (cover) {
      await env.DB.prepare('UPDATE books SET cover = ?1 WHERE id = ?2').bind(cover, bookId).run();
    }
  } catch (err) {
    console.error('cover upload failed:', err);
  }

  return redirect(`/book/${bookId}/chapters?created=1`);
}

async function handleBookUpdate(request, env, user, id) {
  const book = await ownedBook(env, user, id);
  if (!book) return json({ ok: false, error: 'not_found' }, 404);

  let form;
  try {
    form = await request.formData();
  } catch {
    return redirect(`/book/${id}/edit?err=format`);
  }
  const f = readBookForm(form);
  if (!f.title || !f.intro || !CATEGORIES[f.category]) return redirect(`/book/${id}/edit?err=fields`);

  // 元数据改动 → 整本回 pending 重审（slug 保留，重审期间书架不可见）
  await env.DB.prepare(
    `UPDATE books SET title = ?1, category = ?2, intro = ?3, author_name = ?4,
      status = 'pending', reject_reason = NULL, updated_at = datetime('now') WHERE id = ?5`
  ).bind(f.title, f.category, f.intro, f.author_name || null, id).run();

  try {
    const cover = await storeCover(env, id, form);
    if (cover) {
      const old = book.cover && !book.cover.startsWith('/') ? book.cover : null;
      await env.DB.prepare('UPDATE books SET cover = ?1 WHERE id = ?2').bind(cover, id).run();
      if (old && old !== cover) await env.MEDIA.delete(old).catch(() => {});
    }
  } catch (err) {
    console.error('cover upload failed:', err);
    return redirect(`/book/${id}/edit?err=img`);
  }

  return redirect('/dashboard?saved=1');
}

async function handleBookDelete(env, user, id) {
  const book = await ownedBook(env, user, id);
  if (!book) return json({ ok: false, error: 'not_found' }, 404);
  await deleteBookCascade(env, book);
  return json({ ok: true });
}

/** 级联删除作品：章节行 + 章节插图（book/b<id>/ 前缀）+ 封面；尽力而为不回滚 */
async function deleteBookCascade(env, book) {
  const { results } = await env.DB.prepare('SELECT images FROM book_chapters WHERE book_id = ?1').bind(book.id).all();
  await env.DB.prepare('DELETE FROM book_chapters WHERE book_id = ?1').bind(book.id).run();
  await env.DB.prepare('DELETE FROM books WHERE id = ?1').bind(book.id).run();

  const keys = [];
  for (const row of results || []) keys.push(...safeImages(row.images));
  if (book.cover && !book.cover.startsWith('/')) keys.push(book.cover);
  for (const k of keys) {
    try { await env.MEDIA.delete(k); } catch (err) { console.error(`R2 cleanup failed for ${k}:`, err); }
  }
  // 前缀兜底清扫（覆盖历史遗留对象）
  try {
    let cursor;
    do {
      const list = await env.MEDIA.list({ prefix: `book/b${book.id}/`, cursor });
      await Promise.all(list.objects.map((o) => env.MEDIA.delete(o.key)));
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  } catch (err) {
    console.error(`R2 prefix cleanup failed for book ${book.id}:`, err);
  }
}

/* ---------------- 章节 ---------------- */

const countWords = (body) => String(body || '').replace(/\[图\]/g, '').replace(/\s/g, '').length;

/** 章节变更后重算作品冗余计数；草稿不计入（读者端章节数/字数只反映可见内容）。
 *  touch=false（存草稿）不刷新 updated_at——书架「最近更新」排序不应被草稿自动保存搅动 */
async function refreshBookCounts(env, bookId, touch = true) {
  await env.DB.prepare(
    `UPDATE books SET
       chapter_count = (SELECT COUNT(*) FROM book_chapters WHERE book_id = ?1 AND status != 'draft'),
       word_count = (SELECT COALESCE(SUM(word_count), 0) FROM book_chapters WHERE book_id = ?1 AND status != 'draft')
       ${touch ? ", updated_at = datetime('now')" : ''}
     WHERE id = ?1`
  ).bind(bookId).run();
}

/** AJAX 保存（?via=ajax）回 JSON；原表单回 302（无 JS 兜底路径不变） */
const isAjaxSave = (request) => {
  try { return new URL(request.url).searchParams.get('via') === 'ajax'; } catch { return false; }
};

/**
 * 按提交计划合成章节插图：计划项 {"k":"book/b<id>/…"} 复用已上传旧图（改章加图不必整包重传），
 * {"n":i} 上传第 i 个新文件。无 image_plan 字段时退回旧行为（文件全量直传，无文件则保留 allowedOld）。
 * 返回最终 R2 键数组（≤MAX_FIGURES）；计划非法/键越权/文件不合规返回 null（调用方统一 err=img）。
 */
async function storeFigures(env, bookId, form, allowedOld = null) {
  const files = form.getAll('figures').filter((x) => x && typeof x === 'object' && x.size > 0);
  const prefix = `book/b${bookId}/`;
  if (form.get('image_plan') === null) {
    if (!files.length && allowedOld) return allowedOld.slice(); // 旧表单未传新文件 → 保留现有插图
    const keys = [];
    for (let i = 0; i < Math.min(files.length, MAX_FIGURES); i++) {
      const img = await readImage(files[i]);
      if (!img) continue;
      const key = `${prefix}${Date.now().toString(36)}-${i}.${img.ext}`;
      await env.MEDIA.put(key, img.bytes, { httpMetadata: { contentType: IMG_TYPES[img.ext] } });
      keys.push(key);
    }
    return keys;
  }
  let plan;
  try {
    plan = JSON.parse(String(form.get('image_plan')));
  } catch {
    return null;
  }
  if (!Array.isArray(plan) || plan.length > MAX_FIGURES) return null;
  const keys = [];
  for (const p of plan) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    if (typeof p.k === 'string') {
      // 旧图复用：键须属于本书、未重复，且（编辑场景）本就挂在本章节下——防引用同书他章图被级联误删
      if (!p.k.startsWith(prefix) || p.k.length > 120 || keys.includes(p.k)) return null;
      if (allowedOld && !allowedOld.includes(p.k)) return null;
      keys.push(p.k);
    } else if (Number.isInteger(p.n)) {
      const img = await readImage(files[p.n]);
      if (!img) return null;
      const key = `${prefix}${Date.now().toString(36)}-${keys.length}.${img.ext}`;
      await env.MEDIA.put(key, img.bytes, { httpMetadata: { contentType: IMG_TYPES[img.ext] } });
      keys.push(key);
    } else {
      return null;
    }
  }
  return keys;
}

/** 删除一组 R2 对象（尽力而为） */
async function deleteMedia(env, keys) {
  for (const k of keys) {
    if (!k) continue;
    try { await env.MEDIA.delete(k); } catch (err) { console.error(`R2 cleanup failed for ${k}:`, err); }
  }
}

function readChapterForm(form) {
  return {
    idx: Math.max(1, Math.min(MAX_CHAPTERS, parseInt(String(form.get('idx') || ''), 10) || 1)),
    title: String(form.get('title') ?? '').trim().slice(0, 100),
    body: String(form.get('body') ?? '').replace(/\r\n/g, '\n').slice(0, MAX_BODY),
    status: String(form.get('status') || '') === 'draft' ? 'draft' : 'pending', // 草稿不进审核队列
  };
}

async function handleChapterSave(request, env, user, bookId) {
  const book = await ownedBook(env, user, bookId);
  if (!book) return redirect('/dashboard');
  const ajax = isAjaxSave(request);
  const back = (err) => ajax
    ? json({ ok: false, error: err }, 400)
    : redirect(`/book/${bookId}/chapter/new?err=${err}`);

  let form;
  try {
    form = await request.formData();
  } catch {
    return back('format');
  }
  const f = readChapterForm(form);
  // 草稿允许正文留空（随写随存）；提交审核必须标题 + 正文齐备
  if (!f.title || (f.status !== 'draft' && !f.body.trim())) return back('fields');

  const dup = await env.DB.prepare(
    'SELECT id FROM book_chapters WHERE book_id = ?1 AND idx = ?2'
  ).bind(bookId, f.idx).first();
  if (dup) return back('dupidx');

  const images = await storeFigures(env, bookId, form, []).catch((err) => {
    console.error('figure upload failed:', err);
    return null;
  });
  if (images === null) return back('img');
  if (f.status !== 'draft' && !images.length && /\[图\]/.test(f.body)) return back('img');

  const r = await env.DB.prepare(
    `INSERT INTO book_chapters (book_id, idx, title, body, images, status, word_count)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`
  ).bind(bookId, f.idx, f.title, f.body, JSON.stringify(images), f.status, countWords(f.body)).run();
  await refreshBookCounts(env, bookId, f.status !== 'draft');

  return ajax
    ? json({ ok: true, id: r.meta.last_row_id, status: f.status })
    : redirect(`/book/${bookId}/chapters?saved=1`);
}

async function handleChapterUpdate(request, env, user, cid) {
  const ch = await env.DB.prepare('SELECT * FROM book_chapters WHERE id = ?1').bind(cid).first();
  if (!ch) return json({ ok: false, error: 'not_found' }, 404);
  const book = await ownedBook(env, user, ch.book_id);
  if (!book) return json({ ok: false, error: 'not_found' }, 404);
  const ajax = isAjaxSave(request);
  const back = (err) => ajax
    ? json({ ok: false, error: err }, 400)
    : redirect(`/book/${book.id}/chapter/${cid}?err=${err}`);

  let form;
  try {
    form = await request.formData();
  } catch {
    return back('format');
  }
  const f = readChapterForm(form);
  if (!f.title || (f.status !== 'draft' && !f.body.trim())) return back('fields');

  const dup = await env.DB.prepare(
    'SELECT id FROM book_chapters WHERE book_id = ?1 AND idx = ?2 AND id != ?3'
  ).bind(book.id, f.idx, cid).first();
  if (dup) return back('dupidx');

  const oldImages = safeImages(ch.images);
  const images = await storeFigures(env, book.id, form, oldImages).catch((err) => {
    console.error('figure upload failed:', err);
    return null;
  });
  if (images === null) return back('img');
  if (f.status !== 'draft' && !images.length && /\[图\]/.test(f.body)) return back('img');

  await env.DB.prepare(
    `UPDATE book_chapters SET idx = ?1, title = ?2, body = ?3, images = ?4,
      status = ?5, reject_reason = NULL, word_count = ?6, updated_at = datetime('now')
     WHERE id = ?7`
  ).bind(f.idx, f.title, f.body, JSON.stringify(images), f.status, countWords(f.body), cid).run();
  await refreshBookCounts(env, book.id, f.status !== 'draft');

  // 按计划合成后不再被引用的旧图清理（旧图复用键不受影响）
  await deleteMedia(env, oldImages.filter((k) => !images.includes(k)));

  return ajax
    ? json({ ok: true, id: cid, status: f.status })
    : redirect(`/book/${book.id}/chapters?saved=1`);
}

async function handleChapterDelete(env, user, cid) {
  const ch = await env.DB.prepare('SELECT * FROM book_chapters WHERE id = ?1').bind(cid).first();
  if (!ch) return json({ ok: false, error: 'not_found' }, 404);
  const book = await ownedBook(env, user, ch.book_id);
  if (!book) return json({ ok: false, error: 'not_found' }, 404);

  await env.DB.prepare('DELETE FROM book_chapters WHERE id = ?1').bind(cid).run();
  await refreshBookCounts(env, book.id);
  await deleteMedia(env, safeImages(ch.images));
  return json({ ok: true });
}

/* ---------------- 图片（R2） ---------------- */

/** 魔数校验 JPEG/PNG/WebP；返回 { bytes, ext } 或 null（与商户门户同款） */
async function readImage(file) {
  if (!file || typeof file === 'string' || !file.size || file.size > MAX_IMG_BYTES) return null;
  const buf = new Uint8Array(await file.arrayBuffer());
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  const ext = isJpeg ? 'jpg' : isPng ? 'png' : isWebp ? 'webp' : null;
  return ext ? { bytes: buf, ext } : null;
}

async function storeCover(env, bookId, form) {
  const files = form.getAll('cover').filter((x) => x && typeof x === 'object' && x.size > 0);
  if (!files.length) return null;
  const img = await readImage(files[0]);
  if (!img) return null;
  const key = `book/c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${img.ext}`;
  await env.MEDIA.put(key, img.bytes, { httpMetadata: { contentType: IMG_TYPES[img.ext] } });
  return key;
}

function safeImages(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/* ---------------- 页面骨架 ---------------- */

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100vh; background: #f5f5f7; color: #1d1d1f; padding: 0 20px 60px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: inherit; text-decoration: none; }
  header {
    max-width: 860px; margin: 0 auto; display: flex; align-items: center; gap: 12px; padding: 18px 4px;
  }
  h1 { font-size: 17px; font-weight: 600; margin-right: auto; }
  button, .btn {
    padding: 8px 16px; font-size: 13px; color: #1d1d1f; background: #fff; cursor: pointer;
    border: 1px solid rgba(0,0,0,.12); border-radius: 980px; transition: all .2s;
  }
  button:hover, .btn:hover { border-color: #d64524; color: #d64524; }
  button.primary, .btn.primary { background: #d64524; border-color: #d64524; color: #fff; }
  button.primary:hover, .btn.primary:hover { background: #b5371a; color: #fff; }
  .btn-text { color: #d64524; font-size: 13px; border: 0; background: none; padding: 0; }
  .btn-text:hover { text-decoration: underline; }
  .btn-danger { color: #d64524; }
  .wrap { max-width: 860px; margin: 0 auto; }
  .wrap.wrapwide { max-width: 1100px; }
  .btn.btn-sm { padding: 3px 10px; font-size: 12px; }
  .card {
    margin-top: 18px; padding: 22px 24px; background: #fff; border-radius: 18px;
    box-shadow: 0 2px 12px rgba(0,0,0,.04); display: flex; gap: 16px; align-items: flex-start;
  }
  .card .ico { font-size: 28px; line-height: 1.2; }
  .card h2 { font-size: 17px; font-weight: 600; }
  .card p { margin-top: 8px; color: #6e6e73; font-size: 14px; line-height: 1.7; }
  .card p.row { margin-top: 12px; }
  .card a { color: #d64524; }
  .state.pending h2 { color: #9a6b00; }
  .state.ok h2 { color: #1a7f37; }
  .state.bad h2 { color: #d64524; }
  .ok-line {
    margin-top: 18px; padding: 12px 16px; background: #e5f3e8; color: #1a7f37;
    border-radius: 12px; font-size: 13px;
  }
  .panel {
    margin-top: 14px; background: #fff; border-radius: 16px; padding: 20px 22px;
    box-shadow: 0 2px 12px rgba(0,0,0,.04);
  }
  .panel h3 { font-size: 13px; font-weight: 600; color: #6e6e73; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { color: #6e6e73; font-weight: 500; text-align: left; padding: 8px 0; width: 6em; vertical-align: top; }
  td { padding: 8px 0; word-break: break-word; }
  .tip { color: #6e6e73; font-size: 13px; line-height: 1.8; }
  .tip b { color: #1d1d1f; }
  .guide { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .gitem { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; background: #f5f5f7; border-radius: 12px; }
  .gitem .gico { flex: 0 0 auto; font-size: 20px; line-height: 1.3; }
  .gitem b { display: block; font-size: 13px; font-weight: 600; color: #1d1d1f; }
  .gitem p { margin-top: 4px; color: #6e6e73; font-size: 12.5px; line-height: 1.7; }
  .gitem p b { display: inline; font-weight: 600; }
  @media (max-width: 640px) { .guide { grid-template-columns: 1fr; } }
  .thumbs { display: flex; gap: 10px; flex-wrap: wrap; }
  .thumbs img { width: 72px; height: 96px; object-fit: cover; border-radius: 8px; background: #f5f5f7; }
  .thumbs img.land { width: 96px; height: 72px; }
  .bcard {
    margin-top: 14px; padding: 18px 20px; background: #fff; border-radius: 16px;
    box-shadow: 0 2px 12px rgba(0,0,0,.04); display: flex; gap: 16px;
  }
  .bcard .bcover {
    width: 84px; height: 112px; border-radius: 10px; background: #f0f0f2; object-fit: cover; flex: 0 0 auto;
  }
  .bcard .bcover.ph {
    display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: 600; color: #b9b9be;
  }
  .bcard .bmain { flex: 1; min-width: 0; }
  .brow1 { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .brow1 .name { font-weight: 600; font-size: 16px; }
  .bmeta { margin-top: 4px; color: #86868b; font-size: 12px; }
  .bintro { margin-top: 8px; color: #6e6e73; font-size: 13px; line-height: 1.6;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .ops { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .ops button { padding: 5px 12px; font-size: 12px; }
  .mst { padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; }
  .mst-pending { background: #fbf3dd; color: #9a6b00; }
  .mst-approved { background: #e5f3e8; color: #1a7f37; }
  .mst-rejected { background: #fdeee8; color: #d64524; }
  .mst-hidden { background: #f0f0f2; color: #6e6e73; }
  .chrow { display: flex; align-items: center; gap: 12px; padding: 11px 0; border-bottom: 1px solid rgba(0,0,0,.05); font-size: 14px; }
  .chrow:last-child { border-bottom: 0; }
  .chrow .idx { color: #86868b; width: 3.5em; flex: 0 0 auto; }
  .chrow .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chrow .w { color: #86868b; font-size: 12px; flex: 0 0 auto; }
  form.card { display: block; }
  .fgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; margin-top: 16px; }
  .fgrid label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #6e6e73; }
  .fgrid label.wide, .fgrid div.wide { grid-column: 1 / -1; }
  .fgrid input, .fgrid select, .fgrid textarea {
    padding: 11px 13px; font-size: 15px; color: #1d1d1f; background: #f5f5f7;
    border: 1px solid transparent; border-radius: 12px; outline: none; font-family: inherit;
    transition: border-color .2s, background .2s;
  }
  .fgrid input:focus, .fgrid select:focus, .fgrid textarea:focus { border-color: #d64524; background: #fff; }
  .fgrid input[type="file"] { padding: 9px; font-size: 13px; }
  .fgrid textarea { resize: vertical; line-height: 1.7; width: 100%; display: block; }
  .inl {
    padding: 11px 13px; font-size: 15px; color: #1d1d1f; background: #f5f5f7;
    border: 1px solid transparent; border-radius: 12px; outline: none; font-family: inherit;
    transition: border-color .2s, background .2s;
  }
  .inl:focus { border-color: #d64524; background: #fff; }
  .fcol { display: flex; flex-direction: column; gap: 12px; }
  .fcol > .inl { width: 100%; }
  .tabbtn.active { background: #d64524; border-color: #d64524; color: #fff; }
  .tabbtn.active:hover { background: #b5371a; }
  .hint { font-size: 11px; color: #86868b; }
  .err-line {
    margin-top: 18px; padding: 12px 16px; background: #fdeee8; color: #d64524;
    border-radius: 12px; font-size: 13px;
  }
  .mst-draft { background: #eef0f4; color: #515154; }
  .saveline-row { margin-top: 12px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .saveline { font-size: 13px; min-height: 18px; }
  .saveline.ok { color: #1a7f37; }
  .saveline.bad { color: #d64524; }
  .saveline.info { color: #6e6e73; }
  .ta-tools { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .ta-tools button { padding: 4px 12px; font-size: 12px; }
  .ta-tools button.active { background: #d64524; border-color: #d64524; color: #fff; }
  .ta-tools button.active:hover { background: #b5371a; color: #fff; }
  .ta-tools b { font-size: 13px; color: #1d1d1f; }
  .mdprev {
    min-height: 320px; padding: 14px 16px; background: #f5f5f7; border: 1px solid transparent;
    border-radius: 12px; font-size: 15px; line-height: 1.9; color: #1d1d1f; word-break: break-word;
  }
  .mdprev h2, .mdprev h3, .mdprev h4 { margin: 1.2em 0 0.5em; letter-spacing: -0.01em; }
  .mdprev h2 { font-size: 1.3em; }
  .mdprev h3 { font-size: 1.15em; }
  .mdprev h4 { font-size: 1.03em; }
  .mdprev blockquote {
    margin: 1em 0; padding: 0.5em 1em; border-left: 3px solid #d64524;
    background: rgba(214, 69, 36, 0.05); border-radius: 0 10px 10px 0; color: #555;
  }
  .mdprev blockquote p { margin: 0; }
  .mdprev ul, .mdprev ol { margin: 0 0 1em; padding-left: 1.6em; }
  .mdprev hr { border: 0; height: 1px; background: rgba(0,0,0,.12); margin: 1.6em auto; width: 62%; }
  .mdprev code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.86em;
    background: rgba(0,0,0,.055); padding: 0.15em 0.45em; border-radius: 6px;
  }
  .mdprev pre { margin: 1em 0; padding: 0.9em 1.1em; background: #ececf0; border-radius: 10px; overflow-x: auto; line-height: 1.6; }
  .mdprev pre code { background: none; padding: 0; }
  .mdprev a { color: #d64524; text-decoration: underline; text-underline-offset: 3px; }
  .mdprev .md-figph {
    text-align: center; color: #86868b; background: #ececf0;
    border-radius: 10px; padding: 14px; margin: 12px 0; font-size: 13px;
  }
  .recover {
    margin-top: 12px; padding: 12px 16px; background: #fbf3dd; color: #9a6b00;
    border-radius: 12px; font-size: 13px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  }
  .recover button { padding: 4px 12px; font-size: 12px; }
  @media (max-width: 640px) {
    .fgrid { grid-template-columns: 1fr; }
    .bcard { flex-direction: row; }
  }
`;

function shell(body, title = '焰境文库 · 作者中心') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${FAVICON_LINK}
<title>${esc(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
${body}
<script>
document.addEventListener('click', function (e) {
  if (e.target && e.target.id === 'out') {
    fetch('/api/logout', { method: 'POST' }).then(function () { location.href = '/login'; });
  }
});
</script>
</body>
</html>`;
}

const ERR_TEXT = {
  fields: '请填写带 * 的必填项',
  phone: '手机号格式不正确',
  password: '密码至少 8 位',
  dup: '该手机号已注册，请直接登录',
  dupidx: '该章节序号已存在，请换一个序号或修改原章节',
  rate: '提交过于频繁，请稍后再试',
  bad: '手机号或密码不正确',
  format: '提交内容格式有误',
  config: '服务端未配置完成，请联系站长',
  img: '插图上传失败（仅支持 JPG/PNG/WebP、单张 ≤5MB），本次未保存',
  internal: '服务器开小差了，请稍后再试',
};

function errLine(url) {
  const err = url.searchParams.get('err');
  return err ? `<div class="err-line">${esc(ERR_TEXT[err] || '提交失败，请重试')}</div>` : '';
}

/* ---------------- 注册 / 登录页（shared/portal-ui.js 统一壳，与商户门户同构） ---------------- */

function authNotice(url) {
  const err = url.searchParams.get('err');
  return err ? `<div class="aerr" style="display:block">${esc(ERR_TEXT[err] || '提交失败，请重试')}</div>` : '';
}

function registerHtml(url) {
  const panel = `
  <div class="auth-tabs" role="tablist">
    <button type="button" class="atab active" id="rt-phone">账密注册</button>
    <button type="button" class="atab" id="rt-email">邮箱注册</button>
  </div>
  <form class="afcol" id="fp">
    <label class="afield"><span class="aico">${ICO.phone}</span>
      <span class="acc-wrap">
        <span class="acc-label" id="cc-label">+86</span>
        <select id="cc" class="acc" aria-label="国家地区">${phoneCountryOptionsHtml()}</select>
      </span>
      <span class="adiv"></span>
      <input id="phone" maxlength="15" inputmode="tel" autocomplete="username" placeholder="手机号"></label>
    <label class="afield"><span class="aico">${ICO.lock}</span>
      <input id="pw" type="password" minlength="8" maxlength="64" autocomplete="new-password" placeholder="设置密码（至少 8 位）"></label>
    <p class="ahint">手机号仅作登录账号使用，不发送短信；建议注册后在「账号安全」绑定邮箱，便于验证码登录与找回密码。</p>
    <button class="aprimary" id="go" type="submit">注册并进入作品台</button>
    <p class="aerr" id="err" style="display:none"></p>
  </form>
  <form class="afcol" id="fe" hidden>
    <label class="afield"><span class="aico">${ICO.mail}</span>
      <input id="email" type="email" autocomplete="email" placeholder="邮箱"></label>
    <div class="acode">
      <label class="afield"><span class="aico">${ICO.lock}</span>
        <input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 位验证码"></label>
      <button class="abtn" id="send" type="button">发送验证码</button>
    </div>
    <label class="afield"><span class="aico">${ICO.lock}</span>
      <input id="pw2" type="password" minlength="8" maxlength="64" autocomplete="new-password" placeholder="设置密码（至少 8 位）"></label>
    <button class="aprimary" id="goe" type="submit">注册并进入作品台</button>
    <p class="aerr" id="erre" style="display:none"></p>
  </form>
  <p class="aentry">已有账号？<a class="alink" href="/login">直接登录</a></p>
  <p class="ahint" style="text-align:center">注册即表示同意站长对投稿内容进行审核；邮箱注册的账号可用「邮箱 + 验证码」登录，与商户中心账号相互独立。</p>
  <script>
  (function () {
    var ERR = { phone: '手机号格式不正确', email: '邮箱格式不正确', password: '密码至少 8 位',
      dup: '该手机号已注册，请直接登录', taken: '该邮箱已注册，请直接登录',
      bad: '验证码错误', expired: '验证码已过期，请重新发送', too_fast: '发送太频繁，请 1 分钟后再试',
      send_failed: '邮件发送失败，请稍后再试', rate: '尝试过于频繁，请 10 分钟后再试',
      format: '提交内容格式有误', config: '服务端未配置完成，请联系站长' };
    function showErr(id, t) { var e = document.getElementById(id); e.textContent = t; e.style.display = 'block'; }
    function post(path, data) {
      return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { s: r.status, d: d }; }); });
    }
    function switchMode(email) {
      document.getElementById('fp').hidden = email;
      document.getElementById('fe').hidden = !email;
      document.getElementById('rt-phone').classList.toggle('active', !email);
      document.getElementById('rt-email').classList.toggle('active', email);
    }
    document.getElementById('rt-phone').addEventListener('click', function () { switchMode(false); });
    document.getElementById('rt-email').addEventListener('click', function () { switchMode(true); });

    // 区号记忆（docs/手机号国际化方案.md §5 v1.1）：选择写 localStorage 下次免选；闭合态只显示区号短标签
    var cc = document.getElementById('cc'), ccLabel = document.getElementById('cc-label');
    function ccSync() { ccLabel.textContent = cc.options[cc.selectedIndex].getAttribute('data-dial'); }
    try { var savedCc = localStorage.getItem('wxz_phone_country'); if (savedCc) cc.value = savedCc; } catch (e) {}
    ccSync();
    cc.addEventListener('change', function () {
      ccSync();
      try { localStorage.setItem('wxz_phone_country', cc.value); } catch (e) {}
    });

    // 手机号注册
    document.getElementById('fp').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = document.getElementById('go');
      btn.disabled = true;
      fetch('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: document.getElementById('phone').value.trim(), country: cc.value,
          password: document.getElementById('pw').value, website: '' }) })
        .then(function (r) {
          if (r.ok) { location.href = '/dashboard'; return; }
          return r.json().catch(function () { return {}; }).then(function (d) {
            btn.disabled = false;
            showErr('err', (r.status === 429 ? ERR.rate : ERR[d.error]) || '注册失败，请重试');
          });
        })
        .catch(function () { btn.disabled = false; showErr('err', '网络错误，请重试'); });
    });

    // 发送注册验证码
    document.getElementById('send').addEventListener('click', function () {
      var btn = this;
      if (btn.disabled) return;
      post('/api/email-code', { email: document.getElementById('email').value.trim(), purpose: 'register' })
        .then(function (r) {
          if (r.s === 200 && r.d.ok) {
            var n = 60;
            btn.disabled = true; btn.textContent = n + 's 后重发';
            var t = setInterval(function () {
              n--;
              if (n <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = '发送验证码'; return; }
              btn.textContent = n + 's 后重发';
            }, 1000);
            showErr('erre', '✅ 验证码已发送，请查收邮箱（10 分钟内有效）');
            return;
          }
          showErr('erre', (r.s === 429 ? (r.d.error === 'too_fast' ? ERR.too_fast : ERR.rate) : ERR[r.d.error]) || '发送失败，请重试');
        })
        .catch(function () { showErr('erre', '网络错误，请重试'); });
    });

    // 邮箱注册
    document.getElementById('fe').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = document.getElementById('goe');
      btn.disabled = true;
      post('/api/register/email', { email: document.getElementById('email').value.trim(),
        code: document.getElementById('code').value.trim(),
        password: document.getElementById('pw2').value, website: '' })
        .then(function (r) {
          if (r.s === 200 && r.d.ok) { location.href = '/dashboard'; return; }
          btn.disabled = false;
          showErr('erre', (r.s === 429 ? ERR.rate : ERR[r.d.error]) || '注册失败，请重试');
        })
        .catch(function () { btn.disabled = false; showErr('erre', '网络错误，请重试'); });
    });
  })();
  </script>`;
  return authPage(PORTAL_UI, {
    titleTag: '作者注册',
    noticeHtml: authNotice(url),
    panelHtml: panel,
  });
}

function loginHtml(url) {
  return authPage(PORTAL_UI, {
    titleTag: '作者登录',
    noticeHtml: authNotice(url),
    panelHtml: loginPanel({ pwPlaceholder: '密码', entryHref: '/register', entryLabel: '注册作者' }),
  });
}

/* ---------------- 作品台 ---------------- */

const STATUS_LABEL = { pending: '审核中', approved: '已上线', rejected: '已驳回', hidden: '已下线' };

async function dashboardHtml(env, user, url) {
  const { results: books } = await env.DB.prepare(
    `SELECT b.*,
       (SELECT COUNT(*) FROM book_chapters c WHERE c.book_id = b.id AND c.status = 'pending') pending_ch
     FROM books b WHERE b.writer_id = ?1 ORDER BY b.id DESC`
  ).bind(user.uid).all();

  const saved = url.searchParams.get('saved');
  const list = (books || []).map((b) => {
    const cover = b.cover
      ? `<img class="bcover" loading="lazy" alt="" src="${SITE}/media/${esc(b.cover)}">`
      : '<div class="bcover ph" aria-hidden="true">书</div>';
    const meta = [
      CATEGORIES[b.category] || b.category,
      b.author_name || null,
      `${b.chapter_count || 0} 章 · ${(b.word_count || 0).toLocaleString('zh-CN')} 字`,
    ].filter(Boolean).join(' · ');
    const pendBadge = b.status === 'approved' && b.pending_ch > 0
      ? `<span class="mst mst-pending">${b.pending_ch} 章审核中</span>` : '';
    const reject = b.status === 'rejected'
      ? `<div class="bmeta" style="color:#d64524">驳回原因：${esc(b.reject_reason || '资料待完善')}</div>` : '';
    return `<div class="bcard">
      ${cover}
      <div class="bmain">
        <div class="brow1"><span class="name">${esc(b.title)}</span>
          <span class="mst mst-${esc(b.status)}">${STATUS_LABEL[b.status] || b.status}</span>${pendBadge}
          ${b.status === 'approved' && b.slug ? `<a class="btn-text" href="${SITE}/library/${esc(b.slug)}/" target="_blank" rel="noopener">查看页面 ↗</a>` : ''}
        </div>
        <div class="bmeta">${esc(meta)}</div>
        ${b.intro ? `<div class="bintro">${esc(b.intro)}</div>` : ''}
        ${reject}
        <div class="ops">
          <a class="btn" href="/book/${b.id}/chapters">章节管理</a>
          <a class="btn" href="/book/${b.id}/edit">编辑信息</a>
          <button type="button" class="btn-danger" data-del="${b.id}" data-title="${esc(b.title)}">删除</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const { results: pkeys } = await env.DB.prepare(
    'SELECT id, device, created_at FROM webauthn_credentials WHERE portal = ?1 AND user_id = ?2 ORDER BY id'
  ).bind('writer', user.uid).all();

  const bindEmailPanel = `
    <div class="panel">
      <h3>账号安全</h3>
      <table>
        <tr><th>登录手机号</th><td>${esc(user.login_phone || '—')}</td></tr>
        <tr><th>登录邮箱</th><td>${user.login_email ? esc(maskEmail(user.login_email)) + ' ' : ''}<button type="button" class="btn-text" id="bind-toggle">${user.login_email ? '更换' : '绑定邮箱'}</button></td></tr>
        ${passkeyRowHtml((pkeys || []).map((k) => ({ ...k, device: esc(k.device || '') })))}
      </table>
      <p class="tip" style="margin-top:8px">绑定邮箱后，可用「邮箱 + 验证码」登录作者中心。验证码由 notifications@whizzzest.com 发送。通行密钥（指纹/面容）添加后可免密登录本站。${user.login_email ? '' : '<b>当前账号未绑定邮箱：忘记密码将无法自助找回，建议尽快绑定。</b>'}</p>
      <div id="bindbox" style="display:none;margin-top:14px">
        <div class="ops" style="flex-wrap:wrap;align-items:center">
          <input class="inl" id="bind-email" type="email" placeholder="邮箱" style="flex:1;min-width:200px">
          <button class="btn" id="bind-send" type="button">发送验证码</button>
        </div>
        <div class="ops" style="flex-wrap:wrap;align-items:center;margin-top:10px">
          <input class="inl" id="bind-code" inputmode="numeric" maxlength="6" placeholder="6 位验证码" style="width:10em">
          <button class="primary" id="bind-ok" type="button">确认绑定</button>
        </div>
        <p class="err-line" id="bind-err" style="display:none;margin-top:10px"></p>
      </div>
    </div>`;

  return shell(`
    <header><h1>焰境文库 · 作者中心</h1>
      <a class="btn primary" href="/book/new">+ 新建作品</a>
      <button id="out" type="button">退出</button>
    </header>
    <div class="wrap">
      ${saved ? '<div class="ok-line">✅ 已保存。作品信息更新会重新审核，通过后自动上线（已上线作品的新章节会单独审核，不影响作品展示）。</div>' : ''}
      ${url.searchParams.get('deleted') ? '<div class="ok-line">作品已删除。</div>' : ''}
      ${(books || []).length
        ? list
        : `<div class="card state pending"><span class="ico">📝</span>
            <div><h2>还没有作品</h2><p>点右上角「新建作品」，填好标题、简介和封面，然后开始写第一章。</p>
            <p class="row"><a class="btn" href="/book/new">新建作品</a></p></div>
          </div>`}
      ${bindEmailPanel}
      <div class="panel">
        <h3>创作与审核说明</h3>
        <div class="guide">
          <div class="gitem"><span class="gico">🔄</span><div><b>审核范围</b><p>作品信息（标题/分类/简介/封面）改动后，整本重新审核。</p></div></div>
          <div class="gitem"><span class="gico">✅</span><div><b>已上线不受影响</b><p>新写/修改的章节单独审核，通过后读者即可阅读。</p></div></div>
          <div class="gitem"><span class="gico">🖋️</span><div><b>正文用 Markdown</b><p>空行分段，支持 <b># 标题</b>、<b>**粗体**</b>、<b>&gt; 引用</b>、<b>- 列表</b>、<b>[文字](链接)</b> 等，编辑器内可实时预览。</p></div></div>
          <div class="gitem"><span class="gico">⏱️</span><div><b>24 小时内审核</b><p>驳回原因会显示在作品卡片上。有疑问联系 <b>${CONTACT_EMAIL}</b>。</p></div></div>
        </div>
      </div>
    </div>
  <script>
  (function () {
    document.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('确定删除「' + btn.getAttribute('data-title') + '」？所有章节与图片将一并删除，不可恢复。')) return;
        if (!confirm('再次确认：删除后无法找回。')) return;
        fetch('/api/book/' + btn.getAttribute('data-del') + '/delete', { method: 'POST' })
          .then(function (r) { if (r.ok) { location.href = '/dashboard?deleted=1'; return; } alert('删除失败，请重试'); })
          .catch(function () { alert('网络错误，请重试'); });
      });
    });

    var toggle = document.getElementById('bind-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', function () {
      var box = document.getElementById('bindbox');
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });
    var ERR = {
      format: '请输入正确的邮箱', taken: '该邮箱已被其他作者账号绑定',
      too_fast: '发送太频繁，请 1 分钟后再试', rate: '尝试过于频繁，请 10 分钟后再试',
      send_failed: '邮件发送失败，请稍后再试', config: '邮件服务未配置，请联系站长'
    };
    function showErr(color, text) {
      var e = document.getElementById('bind-err');
      e.style.color = color; e.textContent = text; e.style.display = 'block';
    }
    function countdown(btn) {
      var n = 60;
      btn.disabled = true; btn.textContent = n + 's 后重发';
      var t = setInterval(function () {
        n--;
        if (n <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = '发送验证码'; return; }
        btn.textContent = n + 's 后重发';
      }, 1000);
    }
    document.getElementById('bind-send').addEventListener('click', function () {
      var btn = this;
      fetch('/api/email-code', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('bind-email').value.trim() }) })
        .then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
        .then(function (r) {
          if (r.s === 200 && r.d.ok) { countdown(btn); showErr('#1a7f37', '✅ 验证码已发送，请查收邮箱（10 分钟内有效）'); return; }
          showErr('#d64524', ERR[r.d.error] || '发送失败，请重试');
        })
        .catch(function () { showErr('#d64524', '网络错误，请重试'); });
    });
    document.getElementById('bind-ok').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      fetch('/api/bind-email', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('bind-email').value.trim(),
          code: document.getElementById('bind-code').value.trim() }) })
        .then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
        .then(function (r) {
          if (r.s === 200 && r.d.ok) { location.reload(); return; }
          btn.disabled = false;
          showErr('#d64524', ({ format: '请输入邮箱和 6 位验证码', taken: '该邮箱已被其他作者账号绑定',
            bad: '验证码错误', expired: '验证码已过期，请重新发送' })[r.d.error] || '绑定失败，请重试');
        })
        .catch(function () { btn.disabled = false; showErr('#d64524', '网络错误，请重试'); });
    });
    // 通行密钥添加/删除（shared/portal-ui.js）
    ${PASSKEY_DASH_JS}
  })();
  </script>
  `);
}

/* ---------------- 作品表单 / 章节管理 ---------------- */

function bookFormHtml(book) {
  const isEdit = !!book;
  const coverThumb = book && book.cover
    ? `<div class="wide thumbs" style="grid-column:1/-1"><img src="${SITE}/media/${esc(book.cover)}" alt=""></div>`
    : '';
  return shell(`
    <header><h1>${isEdit ? '编辑作品 — ' + esc(book.title) : '新建作品'}</h1><a class="btn-text" href="/dashboard">返回作品台</a></header>
    <div class="wrap">
      <div class="ok-line">${isEdit ? '提示：保存后作品信息会重新进入审核，通过后自动上线。' : '填好作品信息后进入章节编辑；全部内容经站长审核后上线 whizzzest.com/library/。'}</div>
      <form class="card" method="post" action="${isEdit ? `/api/book/${book.id}` : '/api/book'}" enctype="multipart/form-data">
        <input type="hidden" name="website" value="" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div class="fgrid">
          <label>书名 *<input name="title" maxlength="80" required value="${isEdit ? esc(book.title) : ''}"></label>
          <label>分类 *
            <select name="category">
              ${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}"${isEdit && k === book.category ? ' selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>
          <label>笔名（展示在作品页，可空）<input name="author_name" maxlength="40" value="${isEdit ? esc(book.author_name || '') : ''}"></label>
          <label class="wide">简介 *（书架与详情页展示）<textarea name="intro" rows="3" maxlength="500" required>${isEdit ? esc(book.intro) : ''}</textarea></label>
          <label class="wide">封面（选填，竖版 2:3 最佳；JPG/PNG/WebP，≤5MB${isEdit ? '；不选则保留现有' : ''}）<input type="file" name="cover" accept="image/jpeg,image/png,image/webp"></label>
          ${coverThumb}
        </div>
        <div class="ops" style="margin-top:18px">
          <button class="primary" type="submit">${isEdit ? '保存并重新提交审核' : '创建作品，去写章节'}</button>
          <a class="btn" href="${isEdit ? '/dashboard' : '/dashboard'}">取消</a>
        </div>
      </form>
    </div>
  `);
}

async function chaptersHtml(env, book, url) {
  const { results: chapters } = await env.DB.prepare(
    'SELECT id, idx, title, status, reject_reason, word_count FROM book_chapters WHERE book_id = ?1 ORDER BY idx'
  ).bind(book.id).all();

  const rows = (chapters || []).map((c) => {
    const st = c.status === 'approved' ? 'mst-approved' : c.status === 'rejected' ? 'mst-rejected' : c.status === 'draft' ? 'mst-draft' : 'mst-pending';
    const stText = c.status === 'approved' ? '已上线' : c.status === 'rejected' ? '已驳回' : c.status === 'draft' ? '草稿' : '审核中';
    const reason = c.status === 'rejected' && c.reject_reason
      ? `<div class="bmeta" style="color:#d64524;margin-top:2px">驳回原因：${esc(c.reject_reason)}</div>` : '';
    return `<div class="chrow" style="flex-wrap:wrap">
      <span class="idx">第${c.idx}章</span>
      <span class="t"><a href="/book/${book.id}/chapter/${c.id}">${esc(c.title)}</a>${reason}</span>
      <span class="w">${(c.word_count || 0).toLocaleString('zh-CN')} 字</span>
      <span class="mst ${st}" style="flex:0 0 auto">${stText}</span>
      <a class="btn btn-sm" href="/book/${book.id}/chapter/${c.id}">编辑</a>
      <button type="button" data-del="${c.id}" class="btn-danger">删除</button>
    </div>`;
  }).join('');

  const pubLine = book.status === 'approved'
    ? '作品已上线——新写/修改的章节单独审核，通过后读者即可阅读。'
    : '作品尚未上线（' + (STATUS_LABEL[book.status] || book.status) + '），章节审核通过后随作品一起上线。';

  return shell(`
    <header><h1>章节管理 — ${esc(book.title)}</h1>
      <a class="btn-text" href="/dashboard">返回作品台</a>
      <a class="btn-text" href="/book/${book.id}/edit">编辑信息</a>
      <a class="btn primary" href="/book/${book.id}/chapter/new">+ 新建章节</a>
    </header>
    <div class="wrap">
      ${url.searchParams.get('saved') ? '<div class="ok-line">✅ 章节已保存，进入审核。</div>' : ''}
      ${url.searchParams.get('created') ? '<div class="ok-line">✅ 作品已创建，写完第一章后即可提交审核（章节随写随存）。</div>' : ''}
      ${errLine(url)}
      <div class="panel" style="margin-top:18px"><p class="tip">${esc(pubLine)} 共 ${(chapters || []).length} 章。</p></div>
      <div class="panel">
        <h3>章节列表</h3>
        ${(chapters || []).length ? rows : '<p class="tip">还没有章节，点右上角「新建章节」开始写作。</p>'}
      </div>
    </div>
  <script>
  (function () {
    document.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('确定删除该章节？删除后不可恢复（不影响作品其余章节的上线状态）。')) return;
        fetch('/api/chapter/' + btn.getAttribute('data-del') + '/delete', { method: 'POST' })
          .then(function (r) { if (r.ok) { location.reload(); return; } alert('删除失败，请重试'); })
          .catch(function () { alert('网络错误，请重试'); });
      });
    });
  })();
  </script>
  `);
}

function chapterFormHtml(book, ch, idx, usedIdx = []) {
  const isEdit = !!ch;
  const status = isEdit ? ch.status : 'new';
  // 已上线/审核中的章「保存草稿」= 暂时下线/撤回，需明示
  const draftWarn = status === 'approved'
    ? '<p class="hint" style="color:#d64524">该章已上线：「保存草稿」会将其暂时下线，重新提交审核通过后恢复。</p>'
    : status === 'pending'
      ? '<p class="hint" style="color:#d64524">该章审核中：「保存草稿」会先撤回审核，改完再重新提交。</p>'
      : '';
  return shell(`
    <header style="max-width:1100px"><h1 id="h1title">${isEdit ? '编辑章节 — ' + esc(ch.title) : '新建章节'} — ${esc(book.title)}</h1><a class="btn-text" href="/book/${book.id}/chapters">返回章节列表</a></header>
    <div class="wrap wrapwide">
      <div class="ok-line">正文支持 <b>Markdown</b>：# 标题　**粗体**　*斜体*　\`行内码\`　&gt; 引用　- 列表　1. 有序列表　--- 分隔线　[文字](链接)；空行分段。「保存草稿」随写随存不进审核（草稿仅自己可见，可自动保存）；「提交审核」通过后读者才可阅读。</div>
      <div class="saveline-row">
        <span style="font-size:12px;color:#6e6e73">状态 <span id="st-badge" class="mst mst-hidden">未保存</span></span>
        <span id="saveline" class="saveline"></span>
      </div>
      <div id="recover" class="recover" style="display:none">
        <span>检测到本地未保存的内容（<span id="recover-ts"></span>），可能是上次未完成的编辑。</span>
        <button type="button" id="recover-yes">恢复</button>
        <button type="button" id="recover-no">丢弃</button>
      </div>
      <form id="chform" class="card" method="post" action="${isEdit ? `/api/chapter/${ch.id}` : `/api/book/${book.id}/chapter`}" enctype="multipart/form-data">
        <input type="hidden" name="website" value="" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div class="fgrid">
          <label>章节序号 *（阅读页按序号排列）<input id="idx" name="idx" type="number" min="1" max="${MAX_CHAPTERS}" value="${idx}" required></label>
          <label>章节标题 *<input id="title" name="title" maxlength="100" required value="${isEdit ? esc(ch.title) : ''}"></label>
          <div class="wide">
            <div class="ta-tools">
              <button type="button" id="tab-edit" class="active">✍ 写正文</button>
              <button type="button" id="tab-preview">👁 预览</button>
              <span class="hint" style="margin-left:auto">字数：<b id="wc">${isEdit ? (ch.word_count || 0).toLocaleString('zh-CN') : 0}</b></span>
            </div>
            <textarea id="body" name="body" rows="22" maxlength="${MAX_BODY}" aria-label="章节正文" placeholder="第一段……&#10;&#10;## 小节标题&#10;&#10;正文支持 Markdown，空行分段……">${isEdit ? esc(ch.body) : ''}</textarea>
            <div id="preview" class="mdprev" style="display:none"></div>
          </div>
          ${draftWarn ? `<div class="wide">${draftWarn}</div>` : ''}
        </div>
        <div class="ops" style="margin-top:14px">
          <button class="primary" type="submit" id="btn-review">提交审核</button>
          <button type="button" id="btn-draft">保存草稿</button>
          <a class="btn" href="/book/${book.id}/chapters">取消</a>
        </div>
      </form>
    </div>
  <script>
  (function () {
    var bookId = ${book.id};
    var chId = ${isEdit ? ch.id : 0};
    var chStatus = ${JSON.stringify(status)};
    var usedIdx = ${JSON.stringify(usedIdx)};

    var form = document.getElementById('chform');
    var ta = document.getElementById('body');
    var wc = document.getElementById('wc');
    var saveline = document.getElementById('saveline');
    var stBadge = document.getElementById('st-badge');
    var preview = document.getElementById('preview');
    var dirty = false, saving = false, autoOn = false, autoTimer = null;
    var LSKEY = 'wrch:' + bookId + ':' + (chId || 'new');
    var ERRS = { fields: '标题或正文不完整', dupidx: '章节序号与已有章节重复',
      img: '正文里有单独成行的 [图]（旧版插图占位），但本章没有插图——请删除该行后再提交',
      format: '提交数据异常，请刷新页面重试' };
    var ST = { new: '未保存', draft: '草稿', pending: '审核中', approved: '已上线', rejected: '已驳回' };
    var STC = { draft: 'mst-draft', pending: 'mst-pending', approved: 'mst-approved', rejected: 'mst-rejected' };

    function fmtTime(ts) { try { return new Date(ts).toLocaleString('zh-CN'); } catch (e) { return ''; } }

    /* ---------- Markdown 白名单预览渲染 ----------
     * 与主站 worker/library.js 的 mdInline/mdBlocks 是同一套规则的双份实现（零依赖项目不共享模块），改语法必须两处同步。
     * 唯一差异：[图] 独立段此处渲染提示框，主站渲染真实插图（旧图文章节兼容）。 ---------- */
    function escHtml(s) {
      return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function mdInline(s) {
      var stash = [];
      s = s.replace(/\`([^\`\\n]+)\`/g, function (m, c) {
        stash.push('<code>' + c + '</code>');
        return '\\u0000' + (stash.length - 1) + '\\u0000';
      });
      s = s.replace(/\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^)\\s]+|\\/[^)\\s]*)\\)/gi, function (m, text, url) {
        var external = /^https?:\\/\\//i.test(url);
        return '<a href="' + url + '"' + (external ? ' target="_blank" rel="noopener nofollow"' : '') + '>' + text + '</a>';
      });
      s = s.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>');
      s = s.replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>');
      s = s.replace(/\\u0000(\\d+)\\u0000/g, function (m, i) { return stash[Number(i)]; });
      return s;
    }
    function mdBlocks(body) {
      var out = [];
      var para = [];
      var fence = null;
      function flushPara() {
        var t = para.join('\\n').trim();
        para = [];
        if (!t) return;
        if (t === '[图]') { out.push('<div class="md-figph">〔插图占位〕</div>'); return; }
        if (/^(-{3,}|\\*{3,})$/.test(t)) { out.push('<hr>'); return; }
        if (t.indexOf('\\n') < 0 && /^#{1,6} /.test(t)) {
          var level = Math.min(t.match(/^#+/)[0].length + 1, 4);
          out.push('<h' + level + '>' + mdInline(t.replace(/^#+ /, '')) + '</h' + level + '>');
          return;
        }
        var ls = t.split('\\n'), i, ok;
        ok = true;
        for (i = 0; i < ls.length; i++) if (ls[i].indexOf('&gt; ') !== 0) { ok = false; break; }
        if (ok) {
          var q = [];
          for (i = 0; i < ls.length; i++) q.push(mdInline(ls[i].slice(5)));
          out.push('<blockquote><p>' + q.join('<br>') + '</p></blockquote>');
          return;
        }
        ok = true;
        for (i = 0; i < ls.length; i++) if (!/^[-*] /.test(ls[i])) { ok = false; break; }
        if (ok) {
          var ul = [];
          for (i = 0; i < ls.length; i++) ul.push('<li>' + mdInline(ls[i].slice(2)) + '</li>');
          out.push('<ul>' + ul.join('') + '</ul>');
          return;
        }
        ok = true;
        for (i = 0; i < ls.length; i++) if (!/^\\d+[.] /.test(ls[i])) { ok = false; break; }
        if (ok) {
          var ol = [];
          for (i = 0; i < ls.length; i++) ol.push('<li>' + mdInline(ls[i].replace(/^\\d+[.] /, '')) + '</li>');
          out.push('<ol>' + ol.join('') + '</ol>');
          return;
        }
        out.push('<p>' + ls.map(mdInline).join('<br>') + '</p>');
      }
      var lines = String(body || '').split('\\n');
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j].replace(/\\s+$/, '');
        if (fence !== null) {
          if (/^\`\`\`/.test(line)) { out.push('<pre><code>' + fence.join('\\n') + '</code></pre>'); fence = null; }
          else fence.push(escHtml(line));
          continue;
        }
        if (/^\`\`\`/.test(line.trim())) { flushPara(); fence = []; continue; }
        if (!line.trim()) { flushPara(); continue; }
        para.push(escHtml(line));
      }
      if (fence !== null && fence.length) out.push('<pre><code>' + fence.join('\\n') + '</code></pre>');
      flushPara();
      return out.join('');
    }

    /* ---------- 编辑 / 预览切换 ---------- */
    function refreshWc() {
      wc.textContent = ta.value.replace(/\\[图\\]/g, '').replace(/\\s/g, '').length.toLocaleString('zh-CN');
    }
    function showPreview() {
      preview.innerHTML = mdBlocks(ta.value) || '<p class="hint">（正文为空）</p>';
      preview.style.display = '';
      ta.style.display = 'none';
      document.getElementById('tab-edit').className = '';
      document.getElementById('tab-preview').className = 'active';
    }
    function showEdit() {
      preview.style.display = 'none';
      ta.style.display = '';
      document.getElementById('tab-edit').className = 'active';
      document.getElementById('tab-preview').className = '';
      try { ta.focus(); } catch (e) {}
    }
    document.getElementById('tab-edit').addEventListener('click', showEdit);
    document.getElementById('tab-preview').addEventListener('click', showPreview);

    /* ---------- 本地备份（防崩溃/误关，提交成功后清除） ---------- */
    function backup() {
      try {
        localStorage.setItem(LSKEY, JSON.stringify({ t: Date.now(),
          idx: document.getElementById('idx').value,
          title: document.getElementById('title').value, body: ta.value }));
      } catch (e) {}
    }
    function clearBackup() { try { localStorage.removeItem(LSKEY); } catch (e) {} }

    /* ---------- 修改标记 + 自动保存（仅草稿章，停顿 4 秒落库） ---------- */
    function changed() {
      dirty = true;
      refreshWc();
      backup();
      if (autoOn) {
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = setTimeout(function () { if (dirty && !saving) save('draft'); }, 4000);
      }
    }
    function setupAuto() { autoOn = !!chId && chStatus === 'draft'; }

    /* ---------- 保存（AJAX，不跳页；无 image_plan/figures——旧图文管线休眠，服务端保留原插图） ---------- */
    function buildForm(status) {
      var fd = new FormData();
      fd.append('website', '');
      fd.append('status', status);
      fd.append('idx', document.getElementById('idx').value);
      fd.append('title', document.getElementById('title').value);
      fd.append('body', ta.value);
      return fd;
    }
    function setBtns(on) {
      document.getElementById('btn-review').disabled = on;
      document.getElementById('btn-draft').disabled = on;
    }
    function save(status) {
      if (saving) return;
      showEdit();
      var titleEl = document.getElementById('title');
      if (!titleEl.value.trim()) { showLine('bad', '请先填写章节标题'); titleEl.focus(); return; }
      if (status !== 'draft' && !ta.value.trim()) { showLine('bad', '提交审核前请填写正文'); ta.focus(); return; }
      var idxVal = parseInt(document.getElementById('idx').value, 10);
      if (usedIdx.indexOf(idxVal) >= 0) { showLine('bad', '第' + idxVal + '章已存在，请换一个章节序号'); return; }
      saving = true; setBtns(true);
      showLine('info', status === 'draft' ? '正在保存草稿…' : '正在提交…');
      fetch(form.getAttribute('action') + '?via=ajax', { method: 'POST', body: buildForm(status) })
        .then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
        .then(function (r) {
          saving = false; setBtns(false);
          if (r.s === 200 && r.d && r.d.ok) return saved(r.d, status);
          showLine('bad', (r.d && ERRS[r.d.error]) || '保存失败，请重试');
        })
        .catch(function () { saving = false; setBtns(false); showLine('bad', '网络错误，请重试'); });
    }
    function saved(d, status) {
      dirty = false;
      clearBackup();
      chStatus = d.status || status;
      updateBadge();
      showLine('ok', (status === 'draft' ? '草稿已保存 ✓ ' : '已提交审核，等待站长审核 ✓ ') + fmtTime(Date.now()));
      if (!chId && d.id) {
        chId = d.id;
        LSKEY = 'wrch:' + bookId + ':' + chId;
        form.setAttribute('action', '/api/chapter/' + chId);
        try { history.replaceState(null, '', '/book/' + bookId + '/chapter/' + chId); } catch (err) {}
        document.getElementById('h1title').textContent = '编辑章节 — ' + document.getElementById('title').value.trim();
      }
      setupAuto();
    }
    function showLine(cls, msg) { saveline.className = 'saveline ' + cls; saveline.textContent = msg; }
    function updateBadge() {
      stBadge.className = 'mst ' + (STC[chStatus] || 'mst-hidden');
      stBadge.textContent = ST[chStatus] || chStatus;
    }
    document.getElementById('btn-draft').addEventListener('click', function () {
      if ((chStatus === 'approved' || chStatus === 'pending') &&
          !confirm(chStatus === 'approved'
            ? '该章已上线：保存草稿会将其暂时下线（读者暂时看不到），重新提交审核通过后恢复。继续？'
            : '该章审核中：保存草稿会撤回审核，改完再重新提交。继续？')) return;
      save('draft');
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (chStatus === 'approved' && !confirm('重新提交会替换线上版本并进入审核，审核期间读者暂时读不到此章。继续？')) return;
      save('pending');
    });

    /* ---------- 输入绑定 + 离页提醒 ---------- */
    ta.addEventListener('input', changed);
    document.getElementById('title').addEventListener('input', changed);
    document.getElementById('idx').addEventListener('input', changed);
    window.addEventListener('beforeunload', function (e) {
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    /* ---------- 本地草稿恢复 ---------- */
    var bak = null;
    try { bak = JSON.parse(localStorage.getItem(LSKEY) || 'null'); } catch (err) { bak = null; }
    if (bak && typeof bak.body === 'string' &&
        (bak.body !== ta.value || (bak.title || '') !== document.getElementById('title').value)) {
      document.getElementById('recover').style.display = '';
      document.getElementById('recover-ts').textContent = fmtTime(bak.t);
      document.getElementById('recover-yes').addEventListener('click', function () {
        if (typeof bak.idx === 'string' && bak.idx) document.getElementById('idx').value = bak.idx;
        document.getElementById('title').value = bak.title || '';
        ta.value = bak.body;
        document.getElementById('recover').style.display = 'none';
        changed();
      });
      document.getElementById('recover-no').addEventListener('click', function () {
        clearBackup();
        document.getElementById('recover').style.display = 'none';
      });
    }

    updateBadge();
    setupAuto();
    refreshWc();
  })();
  </script>
  `);
}

/* ---------------- 工具 ---------------- */

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

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return toHex(digest);
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return toHex(sig);
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

function redirect(path) {
  return new Response(null, { status: 302, headers: { location: path } });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
