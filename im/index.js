/**
 * 焰境密语 — IM Worker 薄入口（im.whizzzest.com，docs/IM聊天方案.md）
 *
 * 本文件只做三件事：路由分发、安全响应头、DO 类导出。业务一律在 src/ 各模块：
 *   src/config.js          常量与门户文案
 *   src/util.js            通用工具（响应/编码/哈希/限流桶）
 *   src/session.js         会话 Cookie（HMAC）
 *   src/mail.js            邮箱验证码（im_email_codes 独立表）
 *   src/api/auth.js        双方式注册/登录、资料、E2EE 密钥材料（M1）
 *   src/api/social.js      好友：搜索/申请/处理/删除/拉黑（M2）
 *   src/api/convs.js       会话：dm 幂等/列表/信封/历史/已读（M2）+ 群组建/拉/踢/退/散/名/重钥（M3）
 *   src/api/reports.js     举报：成员校验 + 理由约束 + 限流，落 im_reports（M4）
 *   src/api/presence.js    在线查询：好友/同会话可见的在线名单（P1）
 *   src/ws.js              /ws 升级（无 conv → 用户存在性 DO；有 conv → 验会话+成员资格 → 房间 DO）
 *   src/do/room.js         DO IMRoom（每会话一实例，Hibernation）
 *   src/do/presence.js     DO IMPresence（每用户一实例：登录即在线常驻心跳，P1）
 *   src/do/rate-limiter.js DO RateLimiter（每 IP，照 workers-chat-demo）
 *   src/pages/auth.js      认证页面板 + /app 壳
 *
 * E2EE（方案 §3）：服务器是「账号公钥目录 + 密文邮局」，永远不持有可解密钥。
 * 路由一览见 handlePage/handleApi 内注释（M1=账号/密钥目录；M2=好友/会话/实时）。
 */
import { html, json, redirect } from './src/util.js';
import { currentUser } from './src/session.js';
import { sendEmailCode } from './src/mail.js';
import * as authApi from './src/api/auth.js';
import * as socialApi from './src/api/social.js';
import * as convsApi from './src/api/convs.js';
import * as reportsApi from './src/api/reports.js';
import * as presenceApi from './src/api/presence.js';
import { handleWs } from './src/ws.js';
import { loginPanelHtml, registerPanelHtml, LOGIN_PAGE_JS, REGISTER_PAGE_JS, appShellHtml } from './src/pages/auth.js';
import { PORTAL_UI } from './src/config.js';
import { authPage } from '../shared/portal-ui.js';
import { requireHttps } from '../shared/https.mjs';

/* ---------------- 入口：安全头统一包裹 ---------------- */

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
      let res;
      if (path.startsWith('/api/') || path === '/ws') {
        res = path === '/ws' ? await handleWs(request, env, url) : await handleApi(request, env, path, url);
      } else {
        res = await handlePage(request, env, path);
      }
      // DO 转发响应（101 WS 握手等）头不可变：统一加头仅对普通响应生效
      try {
        Object.entries(baseHeaders).forEach(([k, v]) => res.headers.set(k, v));
        res.headers.set('content-security-policy', [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'", // 认证页内嵌脚本 + /assets 模块文件
          "style-src 'self' 'unsafe-inline'",
          "connect-src 'self'",
          "img-src 'self' data: https://whizzzest.com",
          "object-src 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ].join('; '));
      } catch (e) {
        if (res.status !== 101) console.error('im headers skip:', res.status, e.message);
      }
      return res;
    } catch (err) {
      console.error('im worker error:', err);
      return new Response('服务暂时不可用，请稍后再试。', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
};

/* ---------------- 页面路由 ---------------- */

async function handlePage(request, env, path) {
  if (path !== '/' && path !== '/register' && path !== '/app') return new Response('Not found', { status: 404 });
  const user = await currentUser(request, env);
  if (path === '/app') {
    if (!user) return redirect('/');
    return html(appShellHtml());
  }
  // 仅 / 登录页对已登录态跳 /app；/register 恒出注册表单（业主反馈：已登录点「注册焰境密语」不该像自动登录）
  if (user && path === '/') return redirect('/app');
  if (path === '/register') {
    return html(authPage(PORTAL_UI, {
      titleTag: '注册',
      panelHtml: registerPanelHtml(),
      script: REGISTER_PAGE_JS,
    }));
  }
  return html(authPage(PORTAL_UI, {
    titleTag: '登录',
    panelHtml: loginPanelHtml(),
    script: LOGIN_PAGE_JS,
  }));
}

/* ---------------- API 路由（M1：账号/资料；M2 追加好友/会话/实时） ---------------- */

async function handleApi(request, env, path, url) {
  const method = request.method;

  if (path === '/api/email-code' && method === 'POST') return sendEmailCode(request, env);
  if (path === '/api/register/phone' && method === 'POST') return authApi.registerPhone(request, env);
  if (path === '/api/register/email' && method === 'POST') return authApi.registerEmail(request, env);
  if (path === '/api/login/phone' && method === 'POST') return authApi.loginPhone(request, env);
  if (path === '/api/login/email' && method === 'POST') return authApi.loginEmail(request, env);
  if (path === '/api/logout' && method === 'POST') return authApi.logout();

  const user = await currentUser(request, env);
  if (!user) return json({ ok: false, error: 'auth' }, 401);
  if (user.status === 'disabled') return json({ ok: false, error: 'disabled' }, 403);

  if (path === '/api/me' && method === 'GET') return authApi.meGet(env, user);
  if (path === '/api/me' && method === 'PATCH') return authApi.mePatch(request, env, user);
  if (path === '/api/me/email' && method === 'POST') return authApi.meEmail(request, env, user);

  /* ---- 好友（M2，方案 §6/§8） ---- */
  if (path === '/api/users/search' && method === 'GET') return socialApi.userSearch(request, env, user, url);
  if (path === '/api/friends' && method === 'GET') return socialApi.friendsList(env, user);
  if (path === '/api/friends/requests' && method === 'GET') return socialApi.requestsList(env, user, url);
  if (path === '/api/friends/requests' && method === 'POST') return socialApi.requestCreate(request, env, user);
  let m = path.match(/^\/api\/friends\/requests\/(\d+)\/(accept|reject)$/);
  if (m && method === 'POST') return socialApi.requestHandle(request, env, user, Number(m[1]), m[2]);
  m = path.match(/^\/api\/friends\/requests\/(\d+)$/);
  if (m && method === 'DELETE') return socialApi.requestCancel(env, user, Number(m[1]));
  m = path.match(/^\/api\/friends\/(\d+)$/);
  if (m && method === 'DELETE') return socialApi.friendDelete(env, user, Number(m[1]));
  if (path === '/api/blocks' && method === 'GET') return socialApi.blocksList(env, user);
  m = path.match(/^\/api\/blocks\/(\d+)$/);
  if (m && method === 'PUT') return socialApi.blockPut(env, user, Number(m[1]));
  if (m && method === 'DELETE') return socialApi.blockDelete(env, user, Number(m[1]));

  /* ---- 会话（M2 dm / M3 群组，方案 §3.2/§6） ---- */
  if (path === '/api/convs' && method === 'GET') return convsApi.convsList(env, user);
  if (path === '/api/convs/dm' && method === 'POST') return convsApi.dmCreate(request, env, user);
  if (path === '/api/convs/group' && method === 'POST') return convsApi.groupCreate(request, env, user);
  m = path.match(/^\/api\/convs\/(\d+)\/keys$/);
  if (m && method === 'GET') return convsApi.convKeys(env, user, Number(m[1]), url);
  m = path.match(/^\/api\/convs\/(\d+)\/messages$/);
  if (m && method === 'GET') return convsApi.convMessages(env, user, Number(m[1]), url);
  m = path.match(/^\/api\/convs\/(\d+)\/read$/);
  if (m && method === 'POST') return convsApi.convRead(request, env, user, Number(m[1]));
  m = path.match(/^\/api\/convs\/(\d+)\/state$/);
  if (m && method === 'POST') return convsApi.convState(request, env, user, Number(m[1]));
  m = path.match(/^\/api\/convs\/(\d+)\/members$/);
  if (m && method === 'GET') return convsApi.membersList(env, user, Number(m[1]));
  if (m && method === 'POST') return convsApi.membersAdd(request, env, user, Number(m[1]));
  m = path.match(/^\/api\/convs\/(\d+)\/members\/(\d+)$/);
  if (m && method === 'DELETE') return convsApi.memberKick(request, env, user, Number(m[1]), Number(m[2]));
  m = path.match(/^\/api\/convs\/(\d+)\/rekey$/);
  if (m && method === 'POST') return convsApi.convRekey(request, env, user, Number(m[1]));
  m = path.match(/^\/api\/convs\/(\d+)$/);
  if (m && method === 'PATCH') return convsApi.convRename(request, env, user, Number(m[1]));
  if (m && method === 'DELETE') return convsApi.convLeave(env, user, Number(m[1]));

  /* ---- 举报（M4，方案 §6/§8：E2EE 下举报人自愿附说明，站长经 D1 处置） ---- */
  if (path === '/api/reports' && method === 'POST') return reportsApi.createReport(request, env, user);

  /* ---- 在线（P1，docs/IM在线与实时同步方案.md：仅好友/同会话可见） ---- */
  if (path === '/api/presence' && method === 'GET') return presenceApi.presenceGet(env, user, url);

  return json({ ok: false, error: 'not_found' }, 404);
}

/* ---------------- DO 导出 ---------------- */

export { IMRoom } from './src/do/room.js';
export { IMPresence } from './src/do/presence.js';
export { RateLimiter } from './src/do/rate-limiter.js';
