/**
 * home-hero.js — 首页轮播、实时公告与内容条
 * 2026-09-10 结构精简 A3 自 main.js 拆出：仅首页（src/pages/index）加载，其余页面不再下载这部分。
 * 原生 ES Module，无依赖。
 */
"use strict";

/* reduced-motion：与 main.js 滚动浮现同款判定（拆分后各自持有） */
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* 减少动态效果时仅提供手动切换。首张图片随 HTML 显示。 */
const carousel = document.getElementById('hero-carousel');
if (carousel) {
  const slides = [...carousel.querySelectorAll('.hero-slide')];
  const dots = [...document.querySelectorAll('.hero-dot')];
  let current = 0;
  let timer = null;

  // 非首屏轮播图按需加载：切到某张才赋 src（含 WebP srcset/sizes），首帧只拉第一张
  const activate = (i) => {
    const img = slides[((i % slides.length) + slides.length) % slides.length]?.querySelector('img');
    if (!img || !img.dataset.src) return;
    img.src = img.dataset.src;
    if (img.dataset.srcset) img.srcset = img.dataset.srcset;
    if (img.dataset.sizes) img.sizes = img.dataset.sizes;
    delete img.dataset.src;
  };

  const show = (i) => {
    current = (i + slides.length) % slides.length;
    activate(current);
    // 稍候预取下一张，不与当前张抢带宽
    if (!reduceMotion) setTimeout(() => activate(current + 1), 1500);
    slides.forEach((s, k) => s.classList.toggle('active', k === current));
    dots.forEach((d, k) => d.classList.toggle('active', k === current));
  };

  const play = () => {
    if (reduceMotion || slides.length < 2) return;
    stop();
    timer = setInterval(() => show(current + 1), 5000);
  };
  const stop = () => timer && (clearInterval(timer), (timer = null));

  document.querySelector('.hero-arrow-prev')?.addEventListener('click', () => (show(current - 1), play()));
  document.querySelector('.hero-arrow-next')?.addEventListener('click', () => (show(current + 1), play()));
  dots.forEach((d, k) => d.addEventListener('click', () => (show(k), play())));
  const hero = carousel.closest('.hero');
  hero?.addEventListener('mouseenter', stop);
  hero?.addEventListener('mouseleave', play);
  hero?.classList.toggle('has-carousel', slides.length > 1);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : play()));

  show(0);
  play();
}

const notices = document.getElementById('home-notices-content');
if (notices) {
  const locale = document.documentElement.lang === 'en' ? 'en' : 'zh';
  const loadNotices = async () => {
    try {
      const response = await fetch(`/api/activity-notices/latest?lang=${locale}`, {
        signal: AbortSignal.timeout?.(5000),
      });
      if (!response.ok) throw new Error('Activity notices unavailable');
      notices.innerHTML = await response.text();
    } catch {
      const message = document.createElement('p');
      message.className = 'home-notice-message';
      message.textContent = notices.dataset.unavailable;
      notices.replaceChildren(message);
    }
  };
  loadNotices();
  window.addEventListener('pageshow', (event) => { if (event.persisted) loadNotices(); });
}

/* 首页媒体条（焰境影像 / 景点精选 / 焰境仙曲）共用工具与拉取：
   失败或空数据回调 null，整块保持 hidden 不占位 */
const escT = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const stripDur = (sec) => {
  sec = Number(sec) || 0;
  if (sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
};
const stripFetch = (url) =>
  fetch(url)
    .then((r) => r.json())
    .then((d) => (d && d.ok && d.items && d.items.length ? d.items : null))
    .catch(() => null);

/* 首页「焰境影像」条：拉 /api/tv/latest 渲染最新视频 */
const tvStrip = document.getElementById('tv-strip');
if (tvStrip) {
  stripFetch('/api/tv/latest').then((items) => {
    if (!items) return;
    document.getElementById('tv-strip-row').innerHTML = items
      .map(
        (v) => `
        <a class="tv-card" href="/tv/${Number(v.id)}/">
          <div class="tv-media">${
            v.cover
              ? `<img src="${escT(v.cover)}" alt="${escT(v.title)}" loading="lazy" decoding="async">`
              : '<span class="tv-ph" aria-hidden="true">焰</span>'
          }${v.dur ? `<span class="tv-dur">${stripDur(v.dur)}</span>` : ''}</div>
          <h3>${escT(v.title)}</h3>
          <p class="tv-meta">${escT(v.cat)}</p>
        </a>`
      )
      .join('');
    tvStrip.hidden = false;
  });
}

/* 首页「景点精选」条：拉 /api/attractions/latest（编辑 sort 排序前 6） */
const attractStrip = document.getElementById('attract-strip');
if (attractStrip) {
  stripFetch('/api/attractions/latest').then((items) => {
    if (!items) return;
    document.getElementById('attract-strip-row').innerHTML = items
      .map(
        (a) => `
        <a class="home-at-card" href="/attractions/${escT(a.slug)}/">
          <div class="home-at-media">${
            a.cover
              ? `<img src="${escT(a.cover)}" alt="${escT(a.name)}" loading="lazy" decoding="async">`
              : '<span class="tv-ph" aria-hidden="true">游</span>'
          }</div>
          <div class="home-at-body"><h3>${escT(a.name)}</h3><p>${escT(a.tag)}</p></div>
        </a>`
      )
      .join('');
    attractStrip.hidden = false;
  });
}

/* 首页「焰境仙曲」条：拉 /api/music/latest（编辑 sort 排序前 6），点击深链 /music/?t= 直达播放 */
const musicStrip = document.getElementById('music-strip');
if (musicStrip) {
  stripFetch('/api/music/latest').then((items) => {
    if (!items) return;
    document.getElementById('music-strip-row').innerHTML = items
      .map(
        (t) => `
        <a class="home-mu-card" href="/music/?t=${Number(t.id)}">
          <div class="home-mu-media">${
            t.cover
              ? `<img src="${escT(t.cover)}" alt="${escT(t.title)}" loading="lazy" decoding="async">`
              : '<span class="tv-ph" aria-hidden="true">焰</span>'
          }${t.dur ? `<span class="tv-dur">${stripDur(t.dur)}</span>` : ''}</div>
          <div class="home-mu-body"><h3>${escT(t.title)}</h3><p>${escT(t.artist)}</p></div>
        </a>`
      )
      .join('');
    musicStrip.hidden = false;
  });
}
