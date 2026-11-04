import { requireHttps } from '../../shared/https.mjs';

// Reserved for future original games. No asset or storage bindings.
const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
};

function page(en) {
  return `<!doctype html>
<html lang="${en ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${en ? 'Original games · Whizzzest' : '原创游戏 · 焰境'}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background: #f6f3ed; color: #252c29; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100svh; display: flex; flex-direction: column; }
    a { color: inherit; text-underline-offset: .25em; }
    a:focus-visible { outline: 3px solid #886019; outline-offset: 6px; border-radius: 2px; }
    header, footer { display: flex; justify-content: space-between; gap: 1.5rem; padding: 1.6rem clamp(1.5rem,6vw,6rem); font-size: .9rem; }
    header a { display: inline-flex; align-items: center; min-height: 44px; }
    .brand { font-weight: 650; letter-spacing: .08em; text-decoration: none; }
    main { flex: 1; display: grid; place-content: center; width: min(100%, 64rem); margin: auto; padding: 4rem clamp(1.5rem,6vw,5rem); }
    .seed { width: 3rem; height: 3rem; border-radius: 50% 50% 50% 0; background: #b7863f; transform: rotate(-45deg); margin: 0 0 2.8rem .6rem; }
    .eyebrow { color: #655641; font-size: .8rem; letter-spacing: .14em; text-transform: uppercase; }
    h1 { font-size: clamp(2.2rem,6vw,4.8rem); letter-spacing: -.04em; line-height: 1.15; max-width: 14ch; margin: 1rem 0 1.5rem; text-wrap: balance; }
    p { max-width: 38rem; line-height: 1.85; color: #515b55; }
    .back { display: inline-flex; align-items: center; gap: .5rem; min-height: 44px; margin-top: 1.5rem; font-weight: 600; }
    footer { color: #515b55; border-top: 1px solid #d9d9ce; flex-wrap: wrap; }
    @media (prefers-color-scheme: dark) {
      :root { background: #17201c; color: #f5f3eb; }
      p,footer { color: #c0cabe; } .eyebrow { color: #d7bb8d; }
      footer { border-color: #39453d; } a:focus-visible { outline-color: #e8c18b; }
    }
  </style>
</head>
<body>
  <header><a class="brand" href="https://whizzzest.com/${en ? 'en/' : ''}">${en ? 'WHIZZZEST' : '焰境 · 万载'}</a><nav aria-label="${en ? 'Language' : '语言'}"><a href="${en ? '/' : '/en/'}" lang="${en ? 'zh-CN' : 'en'}" hreflang="${en ? 'zh-CN' : 'en'}">${en ? '中文' : 'English'}</a></nav></header>
  <main>
    <div class="seed" aria-hidden="true"></div>
    <span class="eyebrow">${en ? 'A space for original games' : '留一片空白，给新的想象'}</span>
    <h1>${en ? 'Something of our own.' : '下一场冒险，<br>由我们创造。'}</h1>
    <p>${en ? 'This space is reserved for games we create ourselves. The previous collection has been retired. There are no games available here at the moment.' : '这里将留给我们自己开发的游戏。过去的游戏合集已下线，目前暂无可玩的作品。'}</p>
    <div><a class="back" href="https://whizzzest.com/${en ? 'en/' : ''}">${en ? 'Explore Wanzai' : '回万载看看'} <span aria-hidden="true">↗</span></a></div>
  </main>
  <footer><span>game.whizzzest.com</span><span>${en ? 'An idea begins with room to grow.' : '好作品，从一颗想法的种子开始。'}</span></footer>
</body>
</html>`;
}

export default {
  async fetch(request) {
    const insecure = requireHttps(request);
    if (insecure) return insecure;
    const headers = { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' };
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed.', { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
    }
    const path = new URL(request.url).pathname;
    if (path === '/robots.txt') {
      return new Response(request.method === 'HEAD' ? null : 'User-agent: *\nDisallow: /\n', { headers });
    }
    if (['/', '/en', '/en/'].includes(path)) {
      return new Response(request.method === 'HEAD' ? null : page(path !== '/'), {
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response(request.method === 'HEAD' ? null : 'The previous game collection has been retired.\n原游戏合集已下线。\n', { status: 410, headers });
  },
};
