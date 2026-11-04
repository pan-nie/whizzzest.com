/**
 * 焰境·万载 — 门户通行密钥（WebAuthn/Passkey）共享模块
 * （docs/商户功能方案.md v1.7 / docs/文库方案.md v1.2）
 *
 * merchant / writer 两门户各持一份实例（createWebAuthn(cfg)），D1 读写由 cfg 注入，
 * 本模块只负责：WebAuthn options 生成 / 响应验签、challenge 一次性签发（HMAC 签名
 * Cookie，5 分钟一次性）、UA 设备名推断、路由分发。
 *
 * 路由（worker 在 fetch 中把 /api/webauthn/* 交给 handle）：
 *  - POST /api/webauthn/login-options  公开：生成认证 challenge（可发现凭据，免输用户名）
 *  - POST /api/webauthn/login-verify   公开：验签 → 复用 worker 会话签发（302 /dashboard）
 *  - POST /api/webauthn/reg-options    需登录：生成注册 challenge（排除已添密钥）
 *  - POST /api/webauthn/reg-verify     需登录：验签入库（credential_id 全局唯一）
 *  - POST /api/webauthn/delete         需登录：删除本人某把密钥（按行 id）
 *
 * 安全要点：challenge 仅存 HMAC 签名 Cookie（不落库、一次性、5 分钟过期）；
 * 登录验签按 IP 限流（复用 worker 的 limited）；RP ID = 当前主机名
 * （merchant.whizzzest.com / writer.whizzzest.com 各自独立，凭据互不可用，与账号隔离一致）；
 * counter 回退视为重放拒绝；公钥/凭据 ID 均以 base64url 字符串存 D1。
 * 依赖 @simplewebauthn/server v14（纯 JS，wrangler 打包，Workers 兼容）。
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const CHAL_TTL_MS = 5 * 60 * 1000;
const CHAL_COOKIE = 'wa_chal';

/* ---------------- 小工具（模块自持，不依赖 worker 内同名函数） ---------------- */

function json(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEq(a, b) {
  const A = new TextEncoder().encode(a), B = new TextEncoder().encode(b);
  if (A.length !== B.length) return false;
  let d = 0;
  for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i];
  return d === 0;
}

function bytesToB64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** 从 UA 推断简短设备名，作密钥展示名（用户不可改，避免输入面） */
function uaLabel(ua) {
  ua = ua || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : '浏览器';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux' : '设备';
  return `${browser} · ${os}`;
}

/* ---------------- challenge 签名 Cookie（一次性，不落库） ---------------- */

async function issueChalCookie(secret, purpose, challenge) {
  const exp = String(Date.now() + CHAL_TTL_MS);
  const sig = await hmacHex(secret, `wa.${purpose}.${exp}.${challenge}`);
  return `${CHAL_COOKIE}=${purpose}.${exp}.${challenge}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CHAL_TTL_MS / 1000}`;
}

async function readChalCookie(request, secret, purpose) {
  const m = (request.headers.get('cookie') || '')
    .match(new RegExp(`${CHAL_COOKIE}=([a-z]+)\\.([0-9]+)\\.([A-Za-z0-9_-]+)\\.([a-f0-9]{64})`));
  if (!m) return null;
  const [, p, exp, ch, sig] = m;
  if (p !== purpose || Number(exp) < Date.now()) return null;
  const expected = await hmacHex(secret, `wa.${purpose}.${exp}.${ch}`);
  return timingSafeEq(sig, expected) ? ch : null;
}

function clearChalCookie() {
  return `${CHAL_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/* ---------------- 路由处理 ---------------- */

/**
 * @param cfg {
 *   portal                       'merchant' | 'writer'
 *   rpName                       认证器弹窗展示名（如 '焰境好店 · 商户中心'）
 *   secret(env)                  会话 HMAC 密钥（复用；未配置返回 null → config 错误）
 *   limited(key, ms, n)          worker 内存 IP 限流
 *   listCredentials(env, uid)    → [{id, credential_id, public_key, counter, transports}]
 *   findCredential(env, credId)  → {id, user_id, credential_id, public_key, counter} | null
 *   insertCredential(env, uid, {id, publicKey, counter, transports}, device)
 *   deleteCredential(env, uid, rowId)
 *   touchCounter(env, rowId, counter)
 *   issueSession(env, uid)       → Response（worker 现有 authedResponse：302 /dashboard + 会话 Cookie）
 *   userName(user)               注册 options 的 userName（掩码手机号/邮箱）
 * }
 */
export function createWebAuthn(cfg) {
  return {
    async handle(request, env, path, user) {
      const url = new URL(request.url);
      const method = request.method;
      const rpID = url.hostname;
      const origin = url.origin;
      // SameSite cookies also accompany sibling subdomains. Guard every mutation
      // here because callers dispatch WebAuthn before their normal Origin checks.
      const suppliedOrigin = request.headers.get('origin');
      if (method !== 'GET' && method !== 'HEAD' && suppliedOrigin !== null && suppliedOrigin !== origin) {
        return json({ ok: false, error: 'bad_origin' }, {}, 403);
      }
      const secret = cfg.secret(env);
      if (!secret) return json({ ok: false, error: 'config' }, {}, 500);

      /* ---- 登录：可发现凭据（免用户名） ---- */
      if (path === '/api/webauthn/login-options' && method === 'POST') {
        const options = await generateAuthenticationOptions({
          rpID,
          userVerification: 'preferred',
          timeout: 60_000,
        });
        return json({ ok: true, options }, {
          'set-cookie': await issueChalCookie(secret, 'auth', options.challenge),
        });
      }

      if (path === '/api/webauthn/login-verify' && method === 'POST') {
        const ip = request.headers.get('cf-connecting-ip') || '';
        if (ip && cfg.limited('walogin:' + ip, 10 * 60 * 1000, 5)) return json({ ok: false, error: 'rate' }, {}, 429);

        const expectedChallenge = await readChalCookie(request, secret, 'auth');
        if (!expectedChallenge) return json({ ok: false, error: 'challenge' }, {}, 400);

        let body;
        try { body = await request.json(); } catch { return json({ ok: false, error: 'format' }, {}, 400); }

        const row = await cfg.findCredential(env, String(body?.id || ''));
        if (!row) return json({ ok: false, error: 'bad' }, {}, 401);

        let verification;
        try {
          verification = await verifyAuthenticationResponse({
            response: body,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            credential: {
              id: row.credential_id,
              publicKey: b64uToBytes(row.public_key),
              counter: row.counter || 0,
            },
            requireUserVerification: false, // options 已请求 preferred；安全钥匙等无 UV 场景仍可用
          });
        } catch (e) {
          console.error('webauthn login-verify failed:', e?.message || e);
          return json({ ok: false, error: 'bad' }, {}, 401);
        }
        if (!verification.verified) return json({ ok: false, error: 'bad' }, {}, 401);

        await cfg.touchCounter(env, row.id, verification.authenticationInfo.newCounter);
        const resp = await cfg.issueSession(env, row.user_id);
        resp.headers.append('set-cookie', clearChalCookie());
        return resp;
      }

      /* ---- 注册 / 管理：需已登录 ---- */
      if (!user) return json({ ok: false, error: 'auth' }, {}, 401);

      if (path === '/api/webauthn/reg-options' && method === 'POST') {
        const existing = await cfg.listCredentials(env, user.uid);
        const options = await generateRegistrationOptions({
          rpName: cfg.rpName,
          rpID,
          userName: cfg.userName(user),
          userID: new TextEncoder().encode(String(user.uid)),
          excludeCredentials: existing.map((r) => ({ id: r.credential_id })),
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
          timeout: 60_000,
        });
        return json({ ok: true, options }, {
          'set-cookie': await issueChalCookie(secret, 'reg', options.challenge),
        });
      }

      if (path === '/api/webauthn/reg-verify' && method === 'POST') {
        const expectedChallenge = await readChalCookie(request, secret, 'reg');
        if (!expectedChallenge) return json({ ok: false, error: 'challenge' }, {}, 400);

        let body;
        try { body = await request.json(); } catch { return json({ ok: false, error: 'format' }, {}, 400); }

        // 同一把密钥重复添加：如实报错（登录场景报错无碍，这里需用户感知）
        if (await cfg.findCredential(env, String(body?.id || ''))) {
          return json({ ok: false, error: 'exists' }, {}, 409);
        }

        let verification;
        try {
          verification = await verifyRegistrationResponse({
            response: body,
            expectedChallenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            requireUserVerification: false,
          });
        } catch (e) {
          console.error('webauthn reg-verify failed:', e?.message || e);
          return json({ ok: false, error: 'bad' }, {}, 401);
        }
        if (!verification.verified || !verification.registrationInfo) {
          return json({ ok: false, error: 'bad' }, {}, 401);
        }

        const { credential, credentialDeviceType } = verification.registrationInfo;
        const device = uaLabel(request.headers.get('user-agent'))
          + (credentialDeviceType === 'multiDevice' ? ' · 云同步' : '');
        await cfg.insertCredential(env, user.uid, {
          id: credential.id,
          publicKey: bytesToB64u(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports || [],
        }, device);
        return json({ ok: true }, { 'set-cookie': clearChalCookie() });
      }

      if (path === '/api/webauthn/delete' && method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ ok: false, error: 'format' }, {}, 400); }
        const rowId = Number(body?.id);
        if (!Number.isInteger(rowId) || rowId <= 0) return json({ ok: false, error: 'format' }, {}, 400);
        await cfg.deleteCredential(env, user.uid, rowId);
        return json({ ok: true });
      }

      return json({ ok: false, error: 'not_found' }, {}, 404);
    },
  };
}
