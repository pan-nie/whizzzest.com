/**
 * 焰境游戏 — game.whizzzest.com Worker（docs/游戏方案.md §1，docs/游戏整合方案.md §1.7）
 *
 * 静态资产优先：命中资产的请求由 Workers Static Assets 直接服务（不过 Worker，省调用，
 * 安全头由 public/_headers 统一补）；未命中的进到这里做显式路由
 * （wrangler.jsonc 已关 html_handling：默认 auto-trailing-slash 会对 *.html 直接取用回 307，
 *   ASSETS.fetch 不跟随，故 / 与 /play/* 必须在这里重写）：
 *   - /            → /index.html（游戏库列表页）
 *   - /play/<id>/  → /play/app.html（统一运行页壳；游戏 id 由前端 JS 校验并渲染「未找到」态）
 *   - /en、/en/    → /en/index.html（英文列表页——构建期烘出的英文静态件，源码级统一主站，§8.7）
 *   - /en/play/<id>/ → /en/play/app.html（英文运行页，同上）
 *   - 其余 /en/*   → 交还资产层：真静态件直接命中；miss 时改送 /en/404.html（英文 404，
 *                    保留原生 404 状态码，docs/游戏英文版方案.md §8.7）
 *   - /g/*         → R2 桶 whizzzest-game 反代（第三方游戏包托管，docs/游戏整合方案.md §1.1/§1.7）
 *   - /g/api/*     → win12 外部 API 白名单反代（§7.6：上游无 CORS 头/非法 CORS 头的两接口，
 *                    路径固定非开放代理；补 ACAO:* 使同源/跨域均可用）
 *   - 其余         → 交还资产层（无匹配时按 not_found_handling 返回 /404.html）
 * 阶段二绑定：R2（第三方游戏包，后续模拟器内核/ROM 同桶）；D1（云存档）仍按方案 §6 后置。
 */
import { requireHttps } from '../../shared/https.mjs';

const PLAY_RE = /^\/play\/(?:[\w.-]+)?\/?$/; // 允许 id 含点（minecraft-1.8）；仍不含斜杠，防路径穿越
const PLAY_RE_EN = /^\/en\/play\/(?:[\w.-]+)?\/?$/; // 英文运行页同规则（前端 boot 的 id 提取正则允许 /en 前缀）

/* /g/* Content-Type 兜底表（正常情况上传时已带 metadata，这里只兜漏网之鱼） */
const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml',
};

/* 第三方游戏包反代（R2 直读，对标主站 /assets-merchant/ 实现）：
 * 键 = pathname 去掉 /g/ 前缀（上传脚本 game/scripts/upload-games.mjs 与此约定一致）。
 * 缓存策略（收录迭代期以「更新即时可见」优先）：文本/代码 no-cache（ETag 条件请求，命中 304），
 * 媒体类日缓存；游戏包文件名不带 hash，不能用长强缓存——曾因 js 24h 强缓存让用户端
 * 在修复后继续吃到坏文件一天。nosniff 对齐 _headers 规范。
 * 注意：游戏包会被自家 iframe 引用，绝不能在这里补 X-Frame-Options。 */
const TEXT_EXT = new Set(['html', 'json', 'webmanifest', 'js', 'mjs', 'css', 'txt', 'xml']);

async function handleGameAsset(request, url, env) {
  let key;
  try {
    key = decodeURIComponent(url.pathname.slice('/g/'.length));
  } catch {
    return new Response(null, { status: 404 });
  }
  if (!key || key.endsWith('/') || key.includes('..') || key.includes('\\')) {
    return new Response(null, { status: 404 });
  }
  const obj = await env.GAMEDATA.get(key);
  if (!obj) return new Response(null, { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  const ext = (key.split('.').pop() || '').toLowerCase();
  if (!headers.has('content-type')) headers.set('content-type', MIME[ext] || 'application/octet-stream');
  headers.set('etag', obj.httpEtag);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cache-control', TEXT_EXT.has(ext) ? 'no-cache' : 'public, max-age=86400');
  if (request.headers.get('if-none-match') === obj.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(obj.body, { headers });
}

/* win12 外部 API 白名单反代（§7.6）：
 * 上游两个接口在浏览器端必挂——api.xcboke.cn 无 CORS 头、api.msn.cn 返回非法通配 `ACAO: *.msn.cn`，
 * 原站同样坏；这里固定路径反代（无任意 URL 参数，非开放代理），补 `ACAO: *`。
 * apikey 为上游项目公开于其源码的赞助接口密钥，随路径内联（本 worker 源码同为公开仓库）。 */
const GAME_API = {
  'lunar': {
    upstream: 'https://api.xcboke.cn/api/calendar',
    cache: 'public, max-age=3600',
  },
  'weather': {
    upstream: 'https://api.msn.cn/weather/overview?apikey=j5i4gDqHL6nGYwx5wi5kRhXjtf2c5qgFX9fzfk0TOo&locale=zh-cn&ocid=msftweather',
    cache: 'public, max-age=1800',
  },
};

async function handleGameApi(request, url) {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const conf = GAME_API[url.pathname.slice('/g/api/'.length)];
  if (!conf) return new Response(null, { status: 404 });
  try {
    const up = await fetch(conf.upstream, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    const headers = new Headers();
    headers.set('content-type', up.headers.get('content-type') || 'application/json; charset=utf-8');
    headers.set('access-control-allow-origin', '*');
    headers.set('cache-control', conf.cache);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(up.body, { status: up.status, headers });
  } catch {
    return new Response(null, { status: 502 });
  }
}

export default {
  async fetch(request, env) {
    const insecure = requireHttps(request);
    if (insecure) return insecure;
    const url = new URL(request.url);
    if (url.pathname.startsWith('/g/api/')) {
      return handleGameApi(request, url);
    }
    if (url.pathname.startsWith('/g/')) {
      return handleGameAsset(request, url, env);
    }
    let asset = request;
    if (url.pathname === '/' || url.pathname === '') {
      asset = new Request(new URL('/index.html', url.origin), request);
    } else if (PLAY_RE.test(url.pathname)) {
      asset = new Request(new URL('/play/app.html', url.origin), request);
    } else if (url.pathname === '/en' || url.pathname === '/en/') {
      // 英文列表页：构建期产物静态件（templates + strings → public/en/，docs/游戏英文版方案.md §8.7）
      asset = new Request(new URL('/en/index.html', url.origin), request);
    } else if (PLAY_RE_EN.test(url.pathname)) {
      asset = new Request(new URL('/en/play/app.html', url.origin), request);
    }
    const res = await env.ASSETS.fetch(asset);
    // /en/* miss → 英文 404 静态件，保留原生 404 状态码（资产层把 body 解码后重包，剥编码头防错位）
    if (res.status === 404 && (url.pathname === '/en' || url.pathname.startsWith('/en/'))) {
      const nf = await env.ASSETS.fetch(new Request(new URL('/en/404.html', url.origin), request));
      const headers = new Headers(nf.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Response(nf.body, { status: 404, headers });
    }
    return res;
  },
};
