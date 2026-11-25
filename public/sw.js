/**
 * sw.js — 焰境·万载 PWA Service Worker（docs/PWA应用方案.md §3.2）
 *
 * 本文件是模板：预缓存清单 JSON 与指纹脏戳两个占位符由 build.js
 * 在构建时注入后写入 dist/sw.js。指纹一变 SW 字节即变 → 浏览器自动重装换新缓存，
 * 与 build.js 的 ?v= 指纹机制同一套失效逻辑，杜绝访客滞留旧样式。
 * （注意：注释里不要出现占位符字面量，否则 replace 会命中注释。）
 *
 * 策略总览（仅处理同源 GET）：
 *   - 页面导航          network-first，断网回退缓存版（含 query 变体），再回退 /offline.html
 *   - /assets/* 指纹资产  cache-first（immutable）
 *   - /media/music/* 音频 cache-first 整文件（≤25MB），Range 从缓存切片回 206（离线可播可拖）
 *   - /media/* 封面图     cache-first；/media/tv/* 视频与带 Range 的非音频直通不缓存（流式 seek）
 *   - /assets-merchant/*  cache-first（响应 immutable）
 *   - /api/* 与非 GET     直通，永不缓存
 */
'use strict';

const VERSION = '__BUILD__';
const PRECACHE = __PRECACHE__;

const SHELL_CACHE = `whizzzest-shell-${VERSION}`;   // 预缓存（构建期清单）
const PAGE_CACHE = `whizzzest-pages-${VERSION}`;    // 运行时 HTML（导航兜底）
const ASSET_CACHE = `whizzzest-assets-${VERSION}`;  // 运行时图片/CSS/JS
const AUDIO_CACHE = `whizzzest-audio-${VERSION}`;   // 音乐 MP3（离线听）
const MEDIA_CACHE = `whizzzest-media-${VERSION}`;   // R2 封面等小图

const PAGE_MAX = 60;                     // 缓存页面数上限
const ASSET_MAX = 150;                   // 运行时资产条数上限
const AUDIO_MAX = 24;                    // 离线曲目数上限
const AUDIO_SIZE_MAX = 25 * 1024 * 1024; // 单曲 25MB 以上不缓存

const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ts)$/i;

/* ---------------- 生命周期 ---------------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // 逐条容错：单个 404 不拖垮整个 SW 安装（运行时缓存会补上）
    const cache = await caches.open(SHELL_CACHE);
    await Promise.allSettled(PRECACHE.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('whizzzest-') && !n.endsWith(VERSION))
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* ---------------- 工具 ---------------- */

/** 缓存满员按 keys 序淘汰最旧（Cache API keys 近似插入序） */
async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}

/** 归一化导航缓存键：去 search 的 URL（/xxx/?from=share 与 /xxx/ 视作同页） */
function pageKey(url) {
  return url.origin + url.pathname;
}

/** 从缓存的整文件响应切 Range → 206（音频离线拖进度条） */
function slice206(full, rangeHeader) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || '');
  if (!m) return Promise.resolve(full);
  const start = Number(m[1]);
  return full.arrayBuffer().then((buf) => {
    const end = m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
    if (start >= buf.byteLength) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${buf.byteLength}` },
      });
    }
    const body = buf.slice(start, end + 1);
    return new Response(body, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'content-type': full.headers.get('content-type') || 'audio/mpeg',
        'content-length': String(body.byteLength),
        'content-range': `bytes ${start}-${end}/${buf.byteLength}`,
        'accept-ranges': 'bytes',
      },
    });
  });
}

/* ---------------- 取材策略 ---------------- */

async function handleNavigate(request, url) {
  try {
    const res = await fetch(request);
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      const cache = await caches.open(PAGE_CACHE);
      // query 变体（如 /merchants/?cat=food）按原 URL 存，另存一份去 search 的键作兜底
      await cache.put(request, res.clone());
      if (url.search) await cache.put(new Request(pageKey(url)), res.clone());
      await trimCache(PAGE_CACHE, PAGE_MAX);
    }
    return res;
  } catch (err) {
    const pages = await caches.open(PAGE_CACHE);
    const shell = await caches.open(SHELL_CACHE);
    // 离线兜底双语（docs/英文版方案.md Phase 1）：/en/* 导航回退英文兜底页，其余回退中文
    const offlinePage = url.pathname === '/en' || url.pathname.startsWith('/en/') ? '/en/offline.html' : '/offline.html';
    const hit =
      (await pages.match(request)) ||
      (url.search && (await pages.match(pageKey(url)))) ||
      (await shell.match(pageKey(url))) ||
      (await shell.match(offlinePage));
    if (hit) return hit;
    throw err;
  }
}

/**
 * 音乐音频：整文件缓存（离线可播可拖）。
 * 浏览器首播通常带 Range: bytes=0-（preload=metadata），照原样转发则永远缓存不上，
 * 故去 Range 取整流 → 入缓存 → 按原 Range 切片回 206。
 */
async function handleAudio(request) {
  const range = request.headers.get('range');
  const cached = await caches.match(request.url);
  if (cached) return range ? slice206(cached, range) : cached;

  const full = await fetch(request.url); // 无 Range → 整流 200
  if (full.ok && full.status === 200) {
    const len = Number(full.headers.get('content-length') || 0);
    if (!len || len <= AUDIO_SIZE_MAX) {
      const cache = await caches.open(AUDIO_CACHE);
      await cache.put(request.url, full.clone());
      await trimCache(AUDIO_CACHE, AUDIO_MAX);
    }
    return range ? slice206(full, range) : full;
  }
  // 整流异常则按浏览器原请求兜底转发
  return fetch(request);
}

async function cacheFirst(request, cacheName, max) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok && res.status === 200) {
    const cache = await caches.open(cacheName);
    await cache.put(request, res.clone());
    await trimCache(cacheName, max);
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 跨域（B站封面等）直通
  if (url.pathname.startsWith('/api/')) return;    // API 永不缓存
  if (url.pathname === '/gallery/' || url.pathname === '/en/gallery/') return;
  if (url.pathname.startsWith('/gallery-media/')) return;

  // 页面导航：network-first + 缓存兜底 + offline.html
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request, url));
    return;
  }

  const path = url.pathname;

  // 带 Range 的非音频（TV 视频流）直通，避免破坏流式 seek
  if (request.headers.get('range') && !AUDIO_RE.test(path)) return;

  // 音乐音频：离线可播
  if (path.startsWith('/media/') && AUDIO_RE.test(path)) {
    event.respondWith(handleAudio(request));
    return;
  }

  // /media/* 视频本体（无 Range 的整流请求）也直通，不占缓存配额
  if (path.startsWith('/media/') && VIDEO_RE.test(path)) return;

  // R2 封面/商户图/站内指纹资产 → cache-first
  if (path.startsWith('/media/')) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE, ASSET_MAX));
  } else if (path.startsWith('/assets-merchant/')) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE, ASSET_MAX));
  } else if (path.startsWith('/assets/') || path === '/favicon.svg' || path.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE, ASSET_MAX));
  }
  // 其余路径（robots/sitemap 等杂项）直通
});
