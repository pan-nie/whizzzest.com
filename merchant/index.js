/**
 * 焰境·万载 — 商户门户 Worker（merchant.whizzzest.com，M2 自助入驻）
 *
 *  - GET  /apply             入驻申请表单（multipart：资料 + 最多 9 张图片）
 *  - POST /api/apply         提交申请 → merchants(pending) + merchant_users + R2 图片 → 自动登录
 *  - GET  /login             登录（账密 / 邮箱验证码 / 通行密钥，shared/portal-ui.js 统一壳）
 *  - POST /api/login         手机号+密码：PBKDF2 验证 → HMAC 会话 Cookie（mp_session）
 *  - POST /api/email-code    发送 6 位邮箱验证码（未登录=login 用途；已登录=bind 绑定用）
 *  - POST /api/login/email   邮箱+验证码登录（仅已绑定邮箱的账号）
 *  - POST /api/webauthn/*    通行密钥（Passkey，shared/webauthn.js）：login-options/login-verify
 *                            免密登录；reg-options/reg-verify 添加；delete 删除（表 webauthn_credentials，portal='merchant'）
 *  - POST /api/bind-email    看板「账号安全」绑定/更换登录邮箱
 *  - GET  /dashboard         状态看板（审核中/已上线/已驳回/已到期 + 近 30 天浏览统计）
 *  - GET  /dashboard/edit    编辑资料（图片可选替换；保存后重新进入审核）
 *  - POST /api/update        保存编辑（multipart）
 *  - POST /api/logout
 *
 * 安全：整域 noindex + robots 禁止；密码 PBKDF2-SHA256(10 万次) 哈希；
 *       登录/申请/发码按 IP 限流；验证码 10 分钟有效 ≤5 次尝试，登录发码防邮箱枚举；
 *       Honeypot；变更接口校验 Origin；会话改密钥即全体下线。
 * 邮件：验证码经企业邮 notifications@whizzzest.com 发送（worker/smtp.js，465 直连），
 *       需配 secret SMTP_USER / SMTP_PASS；客户联系邮箱 contact@whizzzest.com。
 * 图片：R2 桶 whizzzest-merchant，魔数校验（JPEG/PNG/WebP）、单张 ≤5MB、≤9 张；
 *       公开读取走主站 https://whizzzest.com/assets-merchant/<key>（主 Worker 代理）。
 */
import { sendMail } from '../worker/smtp.js';
import { requireHttps } from '../shared/https.mjs';
import { authPage, loginPanel, widePage, passkeyRowHtml, PASSKEY_DASH_JS } from '../shared/portal-ui.js';
import { createWebAuthn } from '../shared/webauthn.js';
import { normalizePhone, phoneCountryOptionsHtml, maskPhone } from '../shared/phone.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_S = SESSION_TTL_MS / 1000;
const COOKIE_NAME = 'mp_session';
const PAGE_SIZE = 50; // 预留

const SITE = 'https://whizzzest.com';
const CONTACT_EMAIL = 'contact@whizzzest.com'; // 客户联系邮箱（弃用 outlook）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const CATEGORIES = { food: '美食', stay: '住宿', specialty: '特产', fireworks: '花炮', other: '其他' };
const TIER_LABEL = { free: '基础', verified: '认证商户', featured: '置顶推荐' };
// 定价（¥/年，2026-09-06 定）：认证 10、置顶 15（含认证权益）
const TIER_PRICE = { verified: 10, featured: 15 };
const QR_IMGS = [
  ['微信收款码', SITE + '/pay/wechat-qr.png'],
  ['支付宝收款码', SITE + '/pay/alipay-qr.png'],
];
const IMG_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_IMG = 9;
const MAX_IMG_BYTES = 5 * 1024 * 1024;

// 后台页内嵌 favicon（SVG data URI，与主站标签页同款）
const FAVICON_LINK = '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBzdGFuZGFsb25lPSJubyI/PjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+PHN2ZyB0PSIxNzcwNjM5ODE2OTM3IiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9Ijg1MzgiIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCI+PHBhdGggZD0iTTUxMi44IDQyMC44Yy0xNTYuOCAyMzQuNC0xNDEuNiA1NzYuOC00OCA1NzguNCA5Ni44IDIuNC0xNC40LTM5NC40IDQ4LTU3OC40ek00ODAuOCAzOTUuMmMtMjI3LjIgNzQuNC0zOTIgMzExLjItMzI4LjggMzYxLjYgNjQuOCA1MiAxOTEuMi0yNzIgMzI4LjgtMzYxLjZ6TTQ4Ny4yIDM3NkMyOTAuNCAyODggMjQgMzMyIDMxLjIgMzk5LjJjNy4yIDY4LjggMzA3LjItNDkuNiA0NTYtMjMuMnpNNTEyLjggMzU0LjRjLTg5LjYtMTY5LjYtMzAwLTMwMC44LTMzMS4yLTI1Ni0zMiA0Ni40IDI0MS42IDE1MiAzMzEuMiAyNTZ6TTUzMS4yIDM1NC40QzYyNi40IDIyOCA2MzIgMzQuNCA1ODAuOCAyOS42Yy01Mi44LTQuOC03LjIgMjIzLjItNDkuNiAzMjQuOHpNNTQ4IDM2Ni40YzE0NC44IDMuMiAyOTUuMi05NC40IDI3Mi0xMzUuMi0yNC00MS42LTE3My42IDExMi0yNzIgMTM1LjJ6TTU2MS42IDM5OS4yYzE2MCAxMTkuMiA0MjAgMTYwLjggNDMxLjIgMTA5LjYgMTEuMi01Mi44LTI5OS4yLTQ4LjgtNDMxLjItMTA5LjZ6TTUzOS4yIDQyNi40YzI5LjYgMjE2IDIxMS4yIDQxNy42IDI2NC44IDM3NS4yIDU1LjItNDMuMi0yMDcuMi0yMzMuNi0yNjQuOC0zNzUuMnoiIGZpbGw9IiNFODM1MTgiIHAtaWQ9Ijg1MzkiPjwvcGF0aD48cGF0aCBkPSJNOTE5LjIgNjIyLjRsMTYgMzIuOCAzNiA0LjgtMjUuNiAyNS42IDUuNiAzNi0zMi0xNi44LTMyIDE2LjggNi40LTM2LTI2LjQtMjUuNiAzNi00Ljh6IiBmaWxsPSIjRjREMzFGIiBwLWlkPSI4NTQwIj48L3BhdGg+PHBhdGggZD0iTTUyMCAzMzkuMmwxNiAzMi44IDM2IDUuNi0yNS42IDI0LjggNS42IDM2LTMyLTE2LjgtMzIgMTYuOCA2LjQtMzYtMjYuNC0yNC44IDM2LTUuNnpNMjM5LjIgNzkyLjhsMTQuNCAzMC40IDM0LjQgNC44LTI0LjggMjQgNS42IDMzLjYtMjkuNi0xNi0zMC40IDE2IDUuNi0zMy42LTI0LjgtMjQgMzQuNC00Ljh6TTE1MS4yIDE4OGgtMzJ2LTMyYzAtMi40LTEuNi00LTQtNHMtNCAxLjYtNCA0djMyaC0zMmMtMi40IDAtNCAxLjYtNCA0czEuNiA0IDQgNGgzMnYzMmMwIDIuNCAxLjYgNCA0IDRzNC0xLjYgNC00di0zMmgzMmMyLjQgMCA0LTEuNiA0LTRzLTEuNi00LTQtNHoiIGZpbGw9IiNGNUUzMjgiIHAtaWQ9Ijg1NDEiPjwvcGF0aD48L3N2Zz4=">';

// 品牌图标 data URI（认证页共享壳 shared/portal-ui.js 复用：顶栏 logo / 侧栏 / favicon）
const LOGO_URI = (FAVICON_LINK.match(/href="([^"]+)"/) || [])[1] || '';

/* 认证页门户配置（writer / merchant 各一份，结构一致，文案各自维护） */
const PORTAL_UI = {
  brand: '焰境好店',
  area: '商户中心',
  home: 'https://whizzzest.com/merchants/',
  logoUri: LOGO_URI,
  slogan: '把你的店，展示给每一位来万载的游客',
  highlights: [
    '免费入驻，审核通过即上线',
    '认证商户独享详情页 + 认证徽标',
    '电话微信一键直达，数据看板随行',
    '申请后 24 小时内完成审核',
  ],
};

/* 通行密钥（WebAuthn/Passkey）：验证逻辑在 shared/webauthn.js，D1 读写留在本 Worker */
const wa = createWebAuthn({
  portal: 'merchant',
  rpName: '焰境好店 · 商户中心',
  secret: (env) => env.MERCHANT_SESSION_SECRET || null,
  limited,
  listCredentials: (env, uid) =>
    env.DB.prepare('SELECT id, credential_id, public_key, counter, transports FROM webauthn_credentials WHERE portal = ?1 AND user_id = ?2 ORDER BY id')
      .bind('merchant', uid).all().then((r) => r.results || []),
  findCredential: (env, credId) =>
    env.DB.prepare('SELECT id, user_id, credential_id, public_key, counter FROM webauthn_credentials WHERE portal = ?1 AND credential_id = ?2')
      .bind('merchant', credId).first(),
  insertCredential: (env, uid, c, device) =>
    env.DB.prepare('INSERT INTO webauthn_credentials (portal, user_id, credential_id, public_key, counter, transports, device) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind('merchant', uid, c.id, c.publicKey, c.counter, JSON.stringify(c.transports || []), device).run(),
  deleteCredential: (env, uid, rowId) =>
    env.DB.prepare('DELETE FROM webauthn_credentials WHERE portal = ?1 AND user_id = ?2 AND id = ?3')
      .bind('merchant', uid, rowId).run(),
  touchCounter: (env, rowId, counter) =>
    env.DB.prepare('UPDATE webauthn_credentials SET counter = ?2 WHERE id = ?1').bind(rowId, counter).run(),
  issueSession: (env, uid) => authedResponse(env.MERCHANT_SESSION_SECRET, uid),
  userName: (user) => user.login_email
    || (user.login_phone ? maskPhone(user.login_phone) : '商户 ' + user.uid),
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
        "img-src 'self' data: https://whizzzest.com", // 看板缩略图来自主站图片代理
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '));
      return res;
    } catch (err) {
      console.error('merchant worker error:', err);
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

  if (path === '/apply') {
    const authed = await currentUser(request, env);
    if (authed) return redirect('/dashboard');
    return html(applyHtml(url));
  }
  if (path === '/login') {
    const authed = await currentUser(request, env);
    if (authed) return redirect('/dashboard');
    return html(loginHtml(url));
  }
  if (path === '/dashboard/edit') {
    const user = await currentUser(request, env);
    if (!user) return redirect('/login');
    return html(editPageHtml(env, user, url));
  }
  if (path === '/dashboard') {
    const user = await currentUser(request, env);
    if (!user) return redirect('/login');
    return html(await dashboardHtml(env, user, url));
  }
  if (path === '/') return redirect('/dashboard');
  return redirect('/');
}

async function handleApi(request, env, path, url) {
  const method = request.method;

  if (path === '/api/apply' && method === 'POST') return handleApply(request, env);
  if (path === '/api/login' && method === 'POST') return handleLogin(request, env);
  // 邮箱验证码与邮箱验证码登录：公开接口（自行限流）。
  // email-code 按会话自动区分用途：无会话 → 登录发码；带会话 → 绑定/换绑发码
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

  // 其余接口需登录 + 同源校验（Origin 的 host 须与 Host 头一致；
  // 生产同为 merchant.whizzzest.com，本地 wrangler dev 同为 127.0.0.1:<port>，自然放行）
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

  if (path === '/api/update' && method === 'POST') return handleUpdate(request, env, user);
  // 绑定/更换登录邮箱（发码走上面公开分支的会话判定）
  if (path === '/api/bind-email' && method === 'POST') return handleBindEmail(request, env, user);

  // 升级/续费申请：登记目标等级，等站长核销（M3）
  if (path === '/api/pay-request' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'invalid_json' }, 400);
    }
    const tier = String(body?.tier || '');
    if (!TIER_PRICE[tier]) return json({ ok: false, error: 'invalid_tier' }, 400);
    await env.DB.prepare(
      "UPDATE merchants SET tier_request = ?1, paid_requested_at = datetime('now') WHERE id = ?2"
    ).bind(tier, user.id).run();
    return json({ ok: true });
  }

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

/* ---------------- 入驻申请 ---------------- */

async function handleApply(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && limited('apply:' + ip, 60 * 60 * 1000, 3)) {
    return redirect('/apply?err=rate');
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return redirect('/apply?err=format');
  }

  // Honeypot：机器人填了隐藏字段 → 假装成功
  if (String(form.get('website') || '') !== '') {
    return redirect('/login?applied=1');
  }

  const f = readProfile(form);
  const phone = normalizePhone(String(form.get('mp_phone') || ''), String(form.get('mp_country') || ''));
  const password = String(form.get('mp_password') || '');

  if (!f.name || !f.intro || !CATEGORIES[f.category]) return redirect('/apply?err=fields');
  if (!phone.ok) return redirect('/apply?err=phone');
  if (password.length < 8 || password.length > 64) return redirect('/apply?err=password');

  const dup = await env.DB.prepare('SELECT id FROM merchant_users WHERE phone = ?1').bind(phone.e164).first();
  if (dup) return redirect('/apply?err=dup');

  const r = await env.DB.prepare(
    `INSERT INTO merchants (name, category, tier, intro, detail, address, phone, wechat, hours,
      contact_name, contact_phone, status)
     VALUES (?1,?2,'free',?3,?4,?5,?6,?7,?8,?9,?10,'pending')`
  )
    .bind(f.name, f.category, f.intro, f.detail || null, f.address || null, f.phone || null,
      f.wechat || null, f.hours || null, f.contact_name || null, f.contact_phone || null)
    .run();
  const merchantId = r.meta.last_row_id;

  try {
    const keys = await storeImages(env, merchantId, form);
    if (keys.length) {
      await env.DB.prepare('UPDATE merchants SET cover = ?1, images = ?2 WHERE id = ?3')
        .bind(keys[0], JSON.stringify(keys), merchantId)
        .run();
    }
  } catch (err) {
    console.error('image upload failed:', err); // 图片失败不阻断申请，商户可登录后重新上传
  }

  const salt = crypto.randomUUID().replace(/-/g, '');
  const hash = await pbkdf2Hex(password, salt);
  const ur = await env.DB.prepare(
    'INSERT INTO merchant_users (merchant_id, phone, pass_hash, pass_salt) VALUES (?1,?2,?3,?4)'
  ).bind(merchantId, phone.e164, hash, salt).run();

  // 会话承载 merchant_users.id（门户统一按用户 ID 解析身份）
  return authedResponse(env.MERCHANT_SESSION_SECRET, ur.meta.last_row_id);
}

/* ---------------- 登录 ---------------- */

async function handleLogin(request, env) {
  if (!env.MERCHANT_SESSION_SECRET) return json({ ok: false, error: 'config' }, 500);
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && limited('mlogin:' + ip, 10 * 60 * 1000, 5)) return json({ ok: false, error: 'rate' }, 429);

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
    'SELECT u.id uid, u.merchant_id, u.pass_hash, u.pass_salt FROM merchant_users u WHERE u.phone = ?1'
  ).bind(phone.e164).first();
  if (!row) return json({ ok: false, error: 'bad' }, 401);

  const hash = await pbkdf2Hex(password, row.pass_salt);
  if (!timingSafeEqual(hash, row.pass_hash)) return json({ ok: false, error: 'bad' }, 401);

  return authedResponse(env.MERCHANT_SESSION_SECRET, row.uid);
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
  if (!env.MERCHANT_SESSION_SECRET) return null;
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([0-9]+)\\.([0-9]+)\\.([a-f0-9]{64})`));
  if (!m) return null;
  const [, uid, exp, sig] = m;
  if (Number(exp) < Date.now()) return null;
  const expected = await hmacHex(env.MERCHANT_SESSION_SECRET, uid + '.' + exp);
  if (!timingSafeEqual(sig, expected)) return null;
  // 会话承载 merchant_users.id；行内带出 uid / 登录手机号 / 登录邮箱（账号安全面板用）
  return env.DB.prepare(
    `SELECT m.*, u.id AS uid, u.phone AS login_phone, u.email AS login_email
     FROM merchants m JOIN merchant_users u ON u.merchant_id = m.id WHERE u.id = ?1`
  ).bind(Number(uid)).first();
}

/* ---------------- 邮箱验证码（登录补充 / 绑定邮箱） ---------------- */

/**
 * 发送 6 位验证码。user 为 null → 登录用途（仅向已绑定邮箱发码，恒返回成功防枚举）；
 * user 已登录 → 绑定用途（目标邮箱不得被其他账号占用，错误如实返回）。
 */
async function sendEmailCode(request, env, user) {
  if (!env.SMTP_USER || !env.SMTP_PASS) return json({ ok: false, error: 'config' }, 500);
  const purpose = user ? 'bind' : 'login';

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'format' }, 400);
  }
  const email = String(body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 100) return json({ ok: false, error: 'format' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && limited('ecode:' + ip, 10 * 60 * 1000, 6)) return json({ ok: false, error: 'rate' }, 429);

  if (user) {
    const dup = await env.DB.prepare(
      'SELECT id FROM merchant_users WHERE email = ?1 AND id != ?2'
    ).bind(email, user.uid).first();
    if (dup) return json({ ok: false, error: 'taken' }, 400);
  } else {
    // 登录用途：邮箱未绑定任何账号时不发码、不落库，仍返回成功（防枚举）
    const known = await env.DB.prepare('SELECT id FROM merchant_users WHERE email = ?1').bind(email).first();
    if (!known) return json({ ok: true });
  }

  // 同邮箱发码频控：60 秒内不重发（重发会覆盖旧码）
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

  if (user) {
    // 绑定用途：发送失败如实报错，便于商户重试
    try {
      await sendCodeEmail(env, email, code, purpose);
    } catch (err) {
      console.error('email code send failed:', err);
      return json({ ok: false, error: 'send_failed' }, 500);
    }
  } else {
    // 登录用途：失败不外泄（照常返回成功），仅记录日志
    try {
      await sendCodeEmail(env, email, code, purpose);
    } catch (err) {
      console.error('email code send failed (login):', err);
    }
  }
  return json({ ok: true });
}

async function sendCodeEmail(env, email, code, purpose) {
  const action = purpose === 'bind' ? '绑定商户中心邮箱' : '登录焰境好店商户中心';
  // 邮件端兼容：全内联样式 + table 布局 + 绝对地址图片/链接（站点 logo 为 public/logo.png）
  const FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif";
  await sendMail({
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    to: email,
    fromName: '焰境·万载商户中心',
    subject: '验证码（10 分钟内有效）',
    html: `<div style="margin:0;padding:32px 16px;background:#f5f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:20px;">
  <tr><td style="padding:30px 36px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding-right:10px;vertical-align:middle;"><img src="https://whizzzest.com/logo.png" width="30" height="30" alt="焰境·万载" style="display:block;border:0;"></td>
      <td style="vertical-align:middle;font-family:${FONT};font-size:17px;font-weight:600;color:#1d1d1f;">焰境·万载 · 焰境好店</td>
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
        <a href="https://merchant.whizzzest.com/dashboard" style="display:inline-block;padding:11px 34px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">前往商户中心</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:16px 36px 30px;">
    <div style="font-family:${FONT};font-size:12px;color:#86868b;line-height:1.8;">按钮无法点击？复制链接打开：<a href="https://merchant.whizzzest.com/dashboard" style="color:#d64524;text-decoration:none;">merchant.whizzzest.com/dashboard</a></div>
  </td></tr>
  <tr><td style="padding:16px 36px;background:#fafafc;border-top:1px solid rgba(0,0,0,.06);border-radius:0 0 20px 20px;">
    <div style="font-family:${FONT};font-size:12px;color:#86868b;line-height:1.9;">焰境·万载 · 焰境好店（<a href="https://whizzzest.com/" style="color:#86868b;text-decoration:none;">whizzzest.com</a>）｜ 联系：<a href="mailto:contact@whizzzest.com" style="color:#86868b;">contact@whizzzest.com</a><br>本邮件由系统自动发送，请勿直接回复。</div>
  </td></tr>
</table>
</td></tr></table>
</div>`,
  });
}

/** 校验验证码：成功删除并返回 null；失败返回 'bad' | 'expired'（≤5 次尝试，错一次计一次） */
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

/** 邮箱 + 验证码登录（手机号密码之外的补充方式） */
async function handleEmailLogin(request, env) {
  if (!env.MERCHANT_SESSION_SECRET) return json({ ok: false, error: 'config' }, 500);
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip && limited('mlogine:' + ip, 10 * 60 * 1000, 10)) return json({ ok: false, error: 'rate' }, 429);

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

  const row = await env.DB.prepare('SELECT id FROM merchant_users WHERE email = ?1').bind(email).first();
  if (!row) return json({ ok: false, error: 'bad' }, 401);
  return authedResponse(env.MERCHANT_SESSION_SECRET, row.id);
}

/** 看板「账号安全」：绑定 / 更换登录邮箱 */
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
    'SELECT id FROM merchant_users WHERE email = ?1 AND id != ?2'
  ).bind(email, user.uid).first();
  if (dup) return json({ ok: false, error: 'taken' }, 400);

  const verr = await verifyEmailCode(env, email, 'bind', code);
  if (verr) return json({ ok: false, error: verr }, 401);

  try {
    await env.DB.prepare('UPDATE merchant_users SET email = ?1 WHERE id = ?2').bind(email, user.uid).run();
  } catch {
    return json({ ok: false, error: 'taken' }, 400); // UNIQUE 冲突兜底
  }
  return json({ ok: true });
}

function maskEmail(email) {
  const i = email.indexOf('@');
  if (i <= 1) return email;
  return email.slice(0, Math.min(2, i - 1)) + '***' + email.slice(i);
}

/* ---------------- 编辑资料 ---------------- */

async function handleUpdate(request, env, merchant) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return redirect('/dashboard/edit?err=format');
  }
  const f = readProfile(form);

  if (!f.name || !f.intro || !CATEGORIES[f.category]) return redirect('/dashboard/edit?err=fields');

  const sets = [
    'name = ?1', 'category = ?2', 'intro = ?3', 'detail = ?4', 'address = ?5',
    'phone = ?6', 'wechat = ?7', 'hours = ?8',
    // 内容改动一律重新审核
    "status = 'pending'", 'reject_reason = NULL', "updated_at = datetime('now')",
  ];
  const vals = [f.name, f.category, f.intro, f.detail || null, f.address || null,
    f.phone || null, f.wechat || null, f.hours || null];

  try {
    const files = form.getAll('images').filter((x) => x && typeof x === 'object' && x.size > 0);
    if (files.length) {
      const keys = await storeImages(env, merchant.id, form);
      if (keys.length) {
        sets.push('cover = ?', 'images = ?');
        vals.push(keys[0], JSON.stringify(keys));
      }
    }
  } catch (err) {
    console.error('image upload failed:', err);
    return redirect('/dashboard/edit?err=img');
  }

  vals.push(merchant.id);
  await env.DB.prepare(`UPDATE merchants SET ${sets.join(', ')} WHERE id = ?${vals.length}`)
    .bind(...vals).run();

  return redirect('/dashboard?saved=1');
}

function readProfile(form) {
  const clean = (k, max) => String(form.get(k) ?? '').trim().slice(0, max);
  return {
    name: clean('name', 60),
    category: clean('category', 20),
    intro: clean('intro', 200),
    detail: clean('detail', 4000),
    address: clean('address', 120),
    phone: clean('phone', 30),
    wechat: clean('wechat', 60),
    hours: clean('hours', 60),
    contact_name: clean('contact_name', 40),
    contact_phone: clean('contact_phone', 30),
  };
}

/* ---------------- 图片（R2） ---------------- */

/** 魔数校验 JPEG/PNG/WebP；返回 { bytes, ext } 或 null */
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

async function storeImages(env, merchantId, form) {
  const files = form.getAll('images').filter((x) => x && typeof x === 'object' && x.size > 0);
  const keys = [];
  for (let i = 0; i < Math.min(files.length, MAX_IMG); i++) {
    const img = await readImage(files[i]);
    if (!img) continue;
    const key = `m${merchantId}/${Date.now().toString(36)}-${i}.${img.ext}`;
    await env.IMG.put(key, img.bytes, { httpMetadata: { contentType: IMG_TYPES[img.ext] } });
    keys.push(key);
  }
  return keys;
}

/* ---------------- 看板 ---------------- */

async function dashboardHtml(env, merchant, url) {
  const st = merchant.status;
  const saved = url.searchParams.get('saved');

  let stateBlock = '';
  if (st === 'pending') {
    stateBlock = `
      <div class="card state pending"><span class="ico">⏳</span>
        <div><h2>审核中</h2><p>我们通常在 24 小时内完成审核，结果会显示在这里。审核通过后即可在 whizzzest.com/merchants/ 被游客看到。</p></div>
      </div>`;
  } else if (st === 'approved') {
    const paidUntil = merchant.paid_until;
    const daysLeft = paidUntil ? Math.ceil((new Date(paidUntil + 'T23:59:59Z') - Date.now()) / 86400000) : null;
    const expired = daysLeft !== null && daysLeft < 0;
    let renewHint = '';
    if (expired) {
      renewHint = `<div class="warn">展示已到期（${esc(paidUntil)}）——页面已对游客隐藏，续费后立即恢复。可在下方「升级 / 续费」自助续费。</div>`;
    } else if (daysLeft !== null && daysLeft <= 30) {
      renewHint = `<div class="warn">到期日 <b>${esc(paidUntil)}</b>（剩 ${daysLeft} 天），可在下方「升级 / 续费」自助续费。</div>`;
    }
    const stats = await env.DB.prepare(
      `SELECT COUNT(*) pv, COUNT(DISTINCT COALESCE(NULLIF(vid,''),'anon:'||COALESCE(ip,'x'))) uv
       FROM visits WHERE path = ?1 AND created_at >= datetime('now','-30 days')`
    ).bind(`/merchants/${merchant.slug}/`).first();
    stateBlock = `
      <div class="card state ${expired ? 'bad' : 'ok'}"><span class="ico">${expired ? '⏸' : '✅'}</span>
        <div><h2>${expired ? '已到期 · 暂停展示' : '已上线'}</h2><p>${expired ? '续费后立即恢复展示。' : '你的商户页面已在焰境好店展示。'}</p>
        <p class="row"><a href="${SITE}/merchants/${esc(merchant.slug)}/" target="_blank" rel="noopener">查看我的页面 ↗</a></p></div>
      </div>${renewHint}
      <div class="cards">
        <div class="card2"><b>${stats?.pv || 0}</b><span>近 30 天浏览</span></div>
        <div class="card2"><b>${stats?.uv || 0}</b><span>近 30 天访客</span></div>
        <div class="card2"><b>${esc(TIER_LABEL[merchant.tier] || merchant.tier)}</b><span>当前等级</span></div>
        <div class="card2"><b>${paidUntil ? esc(paidUntil) : '—'}</b><span>展示到期日</span></div>
      </div>
      ${payPanelHtml(merchant)}`;
  } else if (st === 'rejected') {
    stateBlock = `
      <div class="card state bad"><span class="ico">❌</span>
        <div><h2>已驳回</h2><p>原因：${esc(merchant.reject_reason || '资料待完善')}</p>
        <p class="row"><a class="btn" href="/dashboard/edit">修改资料重新提交</a></p></div>
      </div>`;
  } else {
    stateBlock = `
      <div class="card state bad"><span class="ico">⏸</span>
        <div><h2>展示已到期</h2><p>续费或升级等级请联系 ${CONTACT_EMAIL}，或提交新的申请。</p>
        <p class="row"><a class="btn" href="/dashboard/edit">更新资料</a></p></div>
      </div>`;
  }

  const thumbs = (merchant.cover ? [merchant.cover] : [])
    .concat(safeImages(merchant.images).filter((k) => k !== merchant.cover));

  const { results: pkeys } = await env.DB.prepare(
    'SELECT id, device, created_at FROM webauthn_credentials WHERE portal = ?1 AND user_id = ?2 ORDER BY id'
  ).bind('merchant', merchant.uid).all();

  const htmlText = shell(`
    <header><h1>焰境好店 · 商户中心</h1>
      <a class="btn-text" href="/dashboard/edit">编辑资料</a>
      <button id="out" type="button">退出</button>
    </header>
    <div class="wrap">
      ${saved ? '<div class="ok-line">✅ 已保存。内容更新会重新审核，通过后自动上线。</div>' : ''}
      ${stateBlock}
      ${thumbs.length ? `<div class="panel"><h3>我的图片</h3><div class="thumbs">${thumbs.map((k) => `<img src="${SITE}/assets-merchant/${esc(k)}" alt="" loading="lazy">`).join('')}</div></div>` : ''}
      <div class="panel">
        <h3>商户信息</h3>
        <table>
          <tr><th>名称</th><td>${esc(merchant.name)}</td></tr>
          <tr><th>分类</th><td>${esc(CATEGORIES[merchant.category] || merchant.category)}</td></tr>
          <tr><th>简介</th><td>${esc(merchant.intro)}</td></tr>
          ${merchant.address ? `<tr><th>地址</th><td>${esc(merchant.address)}</td></tr>` : ''}
          ${merchant.phone ? `<tr><th>电话</th><td>${esc(merchant.phone)}</td></tr>` : ''}
          ${merchant.wechat ? `<tr><th>微信</th><td>${esc(merchant.wechat)}</td></tr>` : ''}
          ${merchant.hours ? `<tr><th>营业时间</th><td>${esc(merchant.hours)}</td></tr>` : ''}
        </table>
      </div>
      <div class="panel">
        <h3>账号安全</h3>
        <table>
          <tr><th>登录手机号</th><td>${esc(merchant.login_phone || '—')}</td></tr>
          <tr><th>登录邮箱</th><td>${merchant.login_email ? esc(maskEmail(merchant.login_email)) + ' ' : ''}<button type="button" class="btn-text" id="bind-toggle">${merchant.login_email ? '更换' : '绑定邮箱'}</button></td></tr>
          ${passkeyRowHtml((pkeys || []).map((k) => ({ ...k, device: esc(k.device || '') })))}
        </table>
        <p class="tip" style="margin-top:8px">绑定邮箱后，可用「邮箱 + 验证码」登录商户中心，无需输入密码。验证码由 notifications@whizzzest.com 发送。通行密钥（指纹/面容）添加后可免密登录本站。${merchant.login_email ? '' : '<b>当前账号未绑定邮箱：忘记密码将无法自助找回，建议尽快绑定。</b>'}</p>
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
      </div>
      <div class="panel">
        <h3>展示权益</h3>
        <p class="tip">认证商户享独立详情页、电话微信直达与数据看板；置顶推荐在目录页顶部大位展示。续费/升级请联系 <b>${CONTACT_EMAIL}</b>。</p>
      </div>
    </div>
  <script>
  (function () {
    // 通行密钥添加/删除（shared/portal-ui.js；置于 bind-toggle 早退之前，保证始终绑定）
    ${PASSKEY_DASH_JS}
    var toggle = document.getElementById('bind-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', function () {
      var box = document.getElementById('bindbox');
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });
    var ERR = {
      format: '请输入正确的邮箱', taken: '该邮箱已被其他账号绑定',
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
        body: JSON.stringify({ email: document.getElementById('bind-email').value.trim(), purpose: 'bind' }) })
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
          showErr('#d64524', ({ format: '请输入邮箱和 6 位验证码', taken: '该邮箱已被其他账号绑定',
            bad: '验证码错误', expired: '验证码已过期，请重新发送' })[r.d.error] || '绑定失败，请重试');
        })
        .catch(function () { btn.disabled = false; showErr('#d64524', '网络错误，请重试'); });
    });
  })();
  </script>
  `);
  return htmlText;
}

/** 升级 / 续费面板（M3 变现闭环）：选等级 → 扫收款码 → 我已付款 → 站长核销 */
function payPanelHtml(merchant) {
  if (merchant.tier_request) {
    const t = merchant.tier_request;
    return `<div class="panel"><h3>升级 / 续费</h3>
      <p class="tip">已申请 <b>${esc(TIER_LABEL[t] || t)}（¥${TIER_PRICE[t] || '?'}/年）</b>（${esc(String(merchant.paid_requested_at || '').replace(' ', ' '))} 提交），站长核销后自动生效，无需重复付款。</p></div>`;
  }
  const btn = (t) => {
    const renew = merchant.tier === t;
    return `<button type="button" class="tier-btn" data-tier="${t}" data-amt="${TIER_PRICE[t]}">${renew ? '续费' : '开通'}${TIER_LABEL[t]} ¥${TIER_PRICE[t]}/年</button>`;
  };
  return `<div class="panel"><h3>升级 / 续费</h3>
    <p class="tip">当前等级：<b>${esc(TIER_LABEL[merchant.tier] || merchant.tier)}</b>。认证商户享独立详情页、认证徽标、电话微信直达与数据看板；置顶推荐另享目录页顶部大位。</p>
    <div class="ops" style="margin-top:12px">${btn('verified')}${btn('featured')}</div>
    <div id="paybox" style="display:none;margin-top:16px">
      <div class="qrs">
        ${QR_IMGS.map(([label, src]) => `
        <figure class="qr"><img src="${src}" alt="${label}" loading="lazy"
          onerror="this.style.display='none';this.parentElement.querySelector('.qr-miss').style.display='block'">
        <figcaption>${label}</figcaption>
        <div class="qr-miss" style="display:none">收款码待上传</div></figure>`).join('')}
      </div>
      <p class="tip" style="margin-top:12px">① 微信/支付宝扫码付款 <b>¥<span id="pay-amt">10</span></b>/年，备注商户名「${esc(merchant.name)}」；② 付款后点下方按钮，站长核销后自动开通。</p>
      <div class="ops" style="margin-top:10px"><button class="primary" id="paidbtn" type="button">我已付款，等待核销</button></div>
    </div>
  </div>
  <script>
  (function () {
    var tier = '';
    document.querySelectorAll('.tier-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        tier = b.getAttribute('data-tier');
        document.getElementById('pay-amt').textContent = b.getAttribute('data-amt');
        document.getElementById('paybox').style.display = 'block';
      });
    });
    var p = document.getElementById('paidbtn');
    if (p) p.addEventListener('click', function () {
      if (!tier) return;
      p.disabled = true;
      fetch('/api/pay-request', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tier: tier }) }).then(function (r) {
        if (r.ok) { location.reload(); return; }
        p.disabled = false; alert('提交失败，请重试');
      }).catch(function () { p.disabled = false; alert('网络错误，请重试'); });
    });
  })();
  </script>`;
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
  .wrap { max-width: 860px; margin: 0 auto; }
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
  .warn {
    margin-top: 14px; padding: 12px 16px; background: #fbf3dd; color: #9a6b00;
    border-radius: 12px; font-size: 13px; line-height: 1.6;
  }
  .ok-line {
    margin-top: 18px; padding: 12px 16px; background: #e5f3e8; color: #1a7f37;
    border-radius: 12px; font-size: 13px;
  }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 14px; }
  .card2 { background: #fff; border-radius: 16px; padding: 16px 14px; box-shadow: 0 2px 12px rgba(0,0,0,.04); }
  .card2 b { display: block; font-size: 22px; font-weight: 600; }
  .card2 span { display: block; margin-top: 4px; color: #6e6e73; font-size: 12px; }
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
  .thumbs { display: flex; gap: 10px; flex-wrap: wrap; }
  .thumbs img { width: 96px; height: 72px; object-fit: cover; border-radius: 10px; background: #f5f5f7; }
  /* 升级/续费 */
  .tier-btn { padding: 8px 16px; }
  .qrs { display: flex; gap: 20px; flex-wrap: wrap; }
  .qr { text-align: center; }
  .qr img { width: 170px; height: 170px; object-fit: contain; background: #fff; border: 1px solid rgba(0,0,0,.08); border-radius: 12px; padding: 6px; }
  .qr figcaption { margin-top: 6px; font-size: 12px; color: #6e6e73; }
  .qr-miss { width: 170px; height: 170px; display: flex; align-items: center; justify-content: center; background: #f5f5f7; border-radius: 12px; font-size: 12px; color: #86868b; }
  form.card { display: block; }
  .fgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; margin-top: 16px; }
  .fgrid label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #6e6e73; }
  .fgrid label.wide { grid-column: 1 / -1; }
  .fgrid input, .fgrid select, .fgrid textarea {
    padding: 11px 13px; font-size: 15px; color: #1d1d1f; background: #f5f5f7;
    border: 1px solid transparent; border-radius: 12px; outline: none; font-family: inherit;
    transition: border-color .2s, background .2s;
  }
  .fgrid input:focus, .fgrid select:focus, .fgrid textarea:focus { border-color: #d64524; background: #fff; }
  .fgrid input[type="file"] { padding: 9px; font-size: 13px; }
  /* 登录双方式 / 绑定邮箱的内联控件 */
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
  @media (max-width: 640px) {
    .cards { grid-template-columns: repeat(2, 1fr); }
    .fgrid { grid-template-columns: 1fr; }
  }
`;

function shell(body, extraHead = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${FAVICON_LINK}
<title>商户中心 — 焰境好店 · 焰境·万载</title>
<style>${BASE_CSS}</style>
${extraHead}
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
  rate: '提交过于频繁，请稍后再试',
  bad: '手机号或密码不正确',
  format: '提交内容格式有误',
  config: '服务端未配置完成，请联系站长',
  img: '图片上传失败（仅支持 JPG/PNG/WebP、单张 ≤5MB），其余资料未保存',
  internal: '服务器开小差了，请稍后再试',
};

function errLine(url) {
  const err = url.searchParams.get('err');
  return err ? `<div class="err-line">${esc(ERR_TEXT[err] || '提交失败，请重试')}</div>` : '';
}

function applyHtml(url) {
  return widePage(PORTAL_UI, {
    titleTag: '商户入驻',
    entry: { href: '/login', label: '已有账号，登录' },
    title: '焰境好店 · 商户入驻',
    sub: '提交后我们将在 24 小时内审核。通过即上线 whizzzest.com/merchants/，基础展示免费，可随时升级。',
    extraCss: BASE_CSS,
    noticeHtml: errLine(url),
    content: `
    <div class="panel" style="margin-top:0">
      <h3>展示权益与定价</h3>
      <table>
        <tr><th>基础展示</th><td><b>免费</b> —— 审核后上线，目录页名称 + 简介卡片</td></tr>
        <tr><th>认证商户</th><td><b>¥10</b>/年 —— 独立详情页 + 认证徽标 + 电话微信一键直达 + 数据看板</td></tr>
        <tr><th>置顶推荐</th><td><b>¥15</b>/年 —— 含认证商户全部权益 + 目录页顶部「推荐好店」大位</td></tr>
      </table>
      <p class="tip" style="margin-top:10px">入驻后可在「商户中心」随时升级 / 续费（扫码付款，站长核销后自动开通）。</p>
    </div>
    <form class="card" method="post" action="/api/apply" enctype="multipart/form-data">
      <input type="hidden" name="website" value="" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div class="fgrid">
        <label>商户名称 *<input name="name" maxlength="60" required></label>
        <label>分类 *
          <select name="category">
            <option value="food">美食</option><option value="stay">住宿</option>
            <option value="specialty">特产</option><option value="fireworks">花炮</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label class="wide">一句话简介 *（列表卡片展示）<input name="intro" maxlength="200" required placeholder="如：正宗万载六大碗，老城三十年老店"></label>
        <label class="wide">详细介绍（选填，空行分段）<textarea name="detail" rows="4" maxlength="4000"></textarea></label>
        <label>地址<input name="address" maxlength="120"></label>
        <label>电话（公开）<input name="phone" maxlength="30"></label>
        <label>微信号（公开）<input name="wechat" maxlength="60"></label>
        <label>营业时间<input name="hours" maxlength="60" placeholder="10:00-21:00"></label>
        <label>门店图片（最多 9 张，JPG/PNG/WebP，单张 ≤5MB）<input type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple></label>
        <label>联系人（不公开）<input name="contact_name" maxlength="40"></label>
        <label>联系电话（不公开）<input name="contact_phone" maxlength="30"></label>
        <label>国家地区 *
          <select name="mp_country">${phoneCountryOptionsHtml()}</select>
        </label>
        <label>手机号 *<input name="mp_phone" maxlength="15" inputmode="tel" placeholder="用于登录商户中心"></label>
        <label>设置密码 *（至少 8 位）<input name="mp_password" type="password" minlength="8" maxlength="64" autocomplete="new-password"></label>
      </div>
      <p class="tip" style="margin-top:12px">登录手机号仅用于登录商户中心，不公开、不发送短信；建议入驻后在「账号安全」绑定邮箱，便于验证码登录与找回密码。</p>
      <div class="ops" style="margin-top:18px">
        <button class="primary" type="submit">提交申请</button>
        <a class="btn" href="${SITE}/">返回官网</a>
      </div>
    </form>`,
  });
}

function loginHtml(url) {
  return authPage(PORTAL_UI, {
    titleTag: '商户登录',
    noticeHtml: errLine(url) + loginNotice(url),
    panelHtml: loginPanel({ pwPlaceholder: '密码（申请入驻时设置）', entryHref: '/apply', entryLabel: '申请入驻' }),
  });
}

function loginNotice(url) {
  if (!url.searchParams.get('applied')) return '';
  return '<div class="aok" style="margin-bottom:6px">✅ 申请已提交，审核通过前你可以先登录完善资料。</div>';
}

function editPageHtml(env, merchant, url) {
  const imgs = safeImages(merchant.images);
  return shell(`
    <header><h1>编辑资料 — ${esc(merchant.name)}</h1><a class="btn-text" href="/dashboard">返回看板</a></header>
    <div class="wrap">
      ${errLine(url)}
      <div class="ok-line">提示：保存后内容会重新进入审核，通过后自动上线。</div>
      <form class="card" method="post" action="/api/update" enctype="multipart/form-data">
        <input type="hidden" name="website" value="" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div class="fgrid">
          <label>商户名称 *<input name="name" maxlength="60" required value="${esc(merchant.name)}"></label>
          <label>分类 *
            <select name="category">
              ${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}"${k === merchant.category ? ' selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>
          <label class="wide">一句话简介 *<input name="intro" maxlength="200" required value="${esc(merchant.intro)}"></label>
          <label class="wide">详细介绍（空行分段）<textarea name="detail" rows="5" maxlength="4000">${esc(merchant.detail || '')}</textarea></label>
          <label>地址<input name="address" maxlength="120" value="${esc(merchant.address || '')}"></label>
          <label>电话（公开）<input name="phone" maxlength="30" value="${esc(merchant.phone || '')}"></label>
          <label>微信号（公开）<input name="wechat" maxlength="60" value="${esc(merchant.wechat || '')}"></label>
          <label>营业时间<input name="hours" maxlength="60" value="${esc(merchant.hours || '')}"></label>
          <label class="wide">替换图片（选填，不选则保留现有${imgs.length ? ' ' + imgs.length + ' 张' : ''}；JPG/PNG/WebP，单张 ≤5MB）
            <input type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple></label>
          ${imgs.length ? `<div class="wide thumbs" style="grid-column:1/-1">${imgs.map((k) => `<img src="${SITE}/assets-merchant/${esc(k)}" alt="" loading="lazy">`).join('')}</div>` : ''}
          <label>联系人（不公开）<input name="contact_name" maxlength="40" value="${esc(merchant.contact_name || '')}"></label>
          <label>联系电话（不公开）<input name="contact_phone" maxlength="30" value="${esc(merchant.contact_phone || '')}"></label>
        </div>
        <div class="ops" style="margin-top:18px">
          <button class="primary" type="submit">保存并重新提交审核</button>
          <a class="btn" href="/dashboard">取消</a>
        </div>
      </form>
    </div>
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
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
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
