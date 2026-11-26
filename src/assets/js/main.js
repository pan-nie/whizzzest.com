/**
 * main.js — 全站交互（导航 / 滚动浮现 / 年份 / 二维码灯箱 / 关于页数字条 / 联系表单 / PWA 注册）
 * 原生 ES Module，无依赖。
 * 页面专属逻辑已拆分（2026-09-10 结构精简 A3，各页只加载自己的）：
 *   首页轮播+媒体条 → home-hero.js（仅首页加载）；焰境仙曲播放器 → music-player.js（仅 /music/ 加载）。
 */
'use strict';

/* JS 可用标记：滚动浮现等增强样式仅在 .js 下生效（无 JS 时内容直接可见） */
document.documentElement.classList.add('js');

/* 多语言（docs/英文版方案.md Phase 1）：build.js 按 locale 注入 window.__I18N（静态页）；
   Worker 动态页无注入 → 全部走代码内 zh 兜底。t('a.b', '兜底') 取串。 */
const I18N = window.__I18N || {};
const t = (path, fallback) => {
  const v = path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), I18N);
  return v == null ? fallback : v;
};

/* 静态页使用构建生成的路径，动态页按目标语言前缀补齐路径；404 保留首页链接。 */
for (const a of document.querySelectorAll('a[data-locale-switch="page"], a[data-locale-switch="dynamic"]')) {
  const target = new URL(a.href);
  if (a.dataset.localeSwitch === 'dynamic') {
    const path = location.pathname.replace(/^\/en(?=\/|$)/, '');
    target.pathname = target.pathname.replace(/\/$/, '') + (path || '/');
  }
  target.search = location.search;
  a.href = target.href;
}

/* 导航：汉堡菜单开合（抽屉在 header 外层，见 header.html 注释） */
const burger = document.querySelector('.nav-burger');
const drawer = document.getElementById('nav-drawer');

if (burger && drawer) {
  const isMenuOpen = () => burger.getAttribute('aria-expanded') === 'true';

  function setMenu(open) {
    if (open === isMenuOpen()) return;
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? t('a11y.closeMenu', '关闭菜单') : t('a11y.openMenu', '打开菜单'));
    if (!open && drawer.contains(document.activeElement)) burger.focus({ preventScroll: true });
    drawer.inert = !open;
    drawer.classList.toggle('open', open);
  }

  burger.addEventListener('click', () => setMenu(!isMenuOpen()));
  drawer.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('a')) setMenu(false);
  });
  document.addEventListener('focusin', (e) => {
    if (e.target !== burger && !drawer.contains(e.target)) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setMenu(false);
  });
  matchMedia('(max-width: 833px)').addEventListener('change', (e) => {
    if (!e.matches) setMenu(false);
  });
}

/* 当前页导航高亮（导航改版 v2.6：子页归属主题；带查询串的快捷链接不参与归属） */
const here = location.pathname.replace(/\/index\.html$/, '/');
const navThemeItems = [...document.querySelectorAll('.nav-item.has-menu')];

function hereMatches(href, strictPath) {
  try {
    const u = new URL(href || '', location.origin);
    if (u.origin !== location.origin) return false; // 外链（如 game.whizzzest.com）不参与当前页归属——其 pathname 可能恰为 /
    if (strictPath && u.search) return false;
    return u.pathname.replace(/\/index\.html$/, '/') === here;
  } catch {
    return false;
  }
}

for (const link of document.querySelectorAll('.nav-link')) {
  if (hereMatches(link.getAttribute('href'), false)) {
    link.setAttribute('aria-current', 'page');
  }
}
for (const item of navThemeItems) {
  const main = item.querySelector(':scope > .nav-link');
  if (!main || main.getAttribute('aria-current') === 'page') continue;
  const subs = [...item.querySelectorAll('.nav-panel-link')];
  if (subs.some((s) => hereMatches(s.getAttribute('href'), true))) {
    main.setAttribute('aria-current', 'page');
  }
}

/* 桌面下拉（Apple 式全宽面板）：hover 意图 + 键盘可达；触屏首击展开 */
const navHeader = document.querySelector('.nav');
const canHover = matchMedia('(hover: hover) and (pointer: fine)').matches;
let navCloseTimer = null;

function closeAllMenus() {
  clearTimeout(navCloseTimer);
  for (const item of navThemeItems) {
    item.classList.remove('open');
    item.querySelector(':scope > .nav-link')?.setAttribute('aria-expanded', 'false');
  }
}

function openNavItem(item) {
  if (item.classList.contains('open')) return;
  closeAllMenus();
  item.classList.add('open');
  item.querySelector(':scope > .nav-link')?.setAttribute('aria-expanded', 'true');
}

if (navHeader && navThemeItems.length) {
  const desktopMenu = () => canHover && window.innerWidth > 833;
  for (const item of navThemeItems) {
    item.addEventListener('mouseenter', () => {
      if (!desktopMenu()) return;
      clearTimeout(navCloseTimer);
      openNavItem(item);
    });
    item.addEventListener('mouseleave', () => {
      if (!desktopMenu() || item.contains(document.activeElement)) return;
      clearTimeout(navCloseTimer);
      navCloseTimer = setTimeout(closeAllMenus, 140);
    });
    item.addEventListener('focusin', () => {
      clearTimeout(navCloseTimer);
      openNavItem(item);
    });
    item.addEventListener('focusout', (e) => {
      if (e.relatedTarget instanceof Node && item.contains(e.relatedTarget)) return;
      navCloseTimer = setTimeout(closeAllMenus, 10);
    });
    // 触屏宽屏（无 hover）：首击展开面板，再击进主题主页；窄屏走抽屉链接正常跳转
    item.querySelector(':scope > .nav-link')?.addEventListener('click', (e) => {
      if (desktopMenu() && !item.classList.contains('open')) {
        e.preventDefault();
        openNavItem(item);
      }
    });
  }
  document.addEventListener('click', (e) => {
    if (e.target instanceof Element && !navHeader.contains(e.target)) closeAllMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const activePanel = document.activeElement?.closest('.nav-panel');
    activePanel?.parentElement?.querySelector(':scope > .nav-link')?.focus({ preventScroll: true });
    closeAllMenus();
  });
}

/* 移动抽屉手风琴（主题项点击展开子项） */
for (const btn of document.querySelectorAll('.nav-drawer-toggle')) {
  btn.addEventListener('click', () => {
    const li = btn.closest('.nav-drawer-item');
    if (!li) return;
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    li.classList.toggle('open', !open);
  });
}

/* 滚动浮现（尊重 prefers-reduced-motion） */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const targets = document.querySelectorAll('.reveal');
if (reduceMotion || !('IntersectionObserver' in window)) {
  targets.forEach((el) => el.classList.add('in'));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
  );
  targets.forEach((el) => io.observe(el));
}

/* 页脚年份 */
for (const el of document.querySelectorAll('.js-year')) {
  el.textContent = String(new Date().getFullYear());
}

/* 二维码灯箱：页内 [data-qr] 单码直开；[data-qr-list] 分享二维码组，固定顺序轮播（首开第 1 张，换一张 1→2→3→4 循环；docs/分享二维码方案.md） */
const lightbox = document.getElementById('lightbox');
if (lightbox) {
  const lbImg = lightbox.querySelector('img');
  const lbCap = lightbox.querySelector('.lightbox-cap');
  const lbShare = lightbox.querySelector('.lightbox-share');
  const lbShareDl = lightbox.querySelector('#lb-share-dl');
  const lbShareShuffle = lightbox.querySelector('#lb-share-shuffle');
  const lbClose = lightbox.querySelector('.lightbox-close');
  let lastFocus = null;
  let shareList = null; // 非 null = 分享模式（操作区可见）
  let shareIdx = -1;
  let shareCap = '';

  // 优先取 WebP 变体（build.js 生成 <name>-800.webp）；没有该档（源图 <800px）时回退原图
  const setLbImg = (src, caption) => {
    const m = src.match(/^(\/assets\/img\/.+?)\.(jpe?g|png)$/i);
    if (m) {
      lbImg.onerror = () => {
        lbImg.onerror = null;
        lbImg.src = src;
      };
      lbImg.src = `${m[1]}-800.webp`;
    } else {
      lbImg.src = src;
    }
    lbImg.alt = caption || t('qr.defaultAlt', '二维码');
  };

  const showLb = (trigger) => {
    lastFocus = trigger;
    lightbox.showModal();
  };

  const openLb = (src, caption, trigger) => {
    shareList = null;
    if (lbShare) lbShare.hidden = true;
    setLbImg(src, caption);
    lbCap.textContent = caption || '';
    showLb(trigger);
  };

  // 顺序轮播（docs/分享二维码方案.md v1.1）：首开固定第 1 张，「换一张」按 1→2→3→4 循环——顺序可预期，随机盲盒易困惑
  const applyShare = (idx) => {
    shareIdx = idx;
    const item = shareList[idx];
    setLbImg(item.src, shareCap);
    // 下载恒指 JPG 原图（非 WebP 变体，通用格式）；文件名重命名在模板 download 属性
    lbShareDl.href = item.src;
  };

  const openShare = (list, caption, trigger) => {
    if (!lbShare || !lbShareDl || !Array.isArray(list) || list.length === 0) return;
    shareList = list;
    shareCap = caption;
    lbShare.hidden = false;
    applyShare(0);
    lbCap.textContent = caption || '';
    showLb(trigger);
  };

  lightbox.addEventListener('close', () => {
    shareList = null;
    shareIdx = -1;
    if (lbShare) lbShare.hidden = true;
    if (lbShareDl) lbShareDl.removeAttribute('href');
    lastFocus?.focus({ preventScroll: true });
    lastFocus = null;
  });

  document.addEventListener('click', (e) => {
    const trigger = e.target instanceof Element ? e.target.closest('[data-qr],[data-qr-list]') : null;
    if (!trigger) return;
    if (trigger.dataset.qrList) {
      try {
        openShare(JSON.parse(trigger.dataset.qrList), trigger.dataset.cap || '', trigger);
      } catch {
        /* qrList 数据异常不弹窗（构建期已校验非空，此处运行时兜底） */
      }
    } else if (trigger.dataset.qr) {
      openLb(trigger.dataset.qr, trigger.dataset.cap || '', trigger);
    }
  });
  lbShareShuffle?.addEventListener('click', () => {
    if (shareList) applyShare((shareIdx + 1) % shareList.length);
  });
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) lightbox.close();
  });
  lbClose.addEventListener('click', () => lightbox.close());
  lightbox.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const lastControl = shareList ? lbShareShuffle : lbClose;
    if (document.activeElement !== (e.shiftKey ? lbClose : lastControl)) return;
    e.preventDefault();
    (e.shiftKey ? lastControl : lbClose).focus();
  });
}

/* 关于页「平台一览」数字条：静态项（非遗）保持构建期值；动态项拉 /api/stats 填充，
   进视口后计数动画（接口失败保持占位符「–」，无 JS 时不显示误导性的 0） */
const statsRow = document.querySelector('.stats-row');
if (statsRow) {
  const statEls = [...statsRow.querySelectorAll('.stat-v[data-stat]')];
  const pending = new Map();
  const setNum = (el, to) => {
    if (reduceMotion) {
      el.textContent = String(to);
      return;
    }
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / 700);
      el.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const statIo = 'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            statIo.unobserve(entry.target);
            const to = pending.get(entry.target);
            if (to != null) {
              pending.delete(entry.target);
              setNum(entry.target, to);
            }
          }
        },
        { threshold: 0.4 }
      )
    : null;

  fetch('/api/stats')
    .then((r) => r.json())
    .then((d) => {
      const stats = d && d.ok ? d.stats : null;
      if (!stats) return;
      for (const el of statEls) {
        const to = stats[el.dataset.stat];
        if (to == null) continue; // 静态项（如非遗）或接口缺项 → 保持原值
        if (!statIo) {
          setNum(el, Number(to));
          continue;
        }
        pending.set(el, Number(to));
        statIo.observe(el);
      }
    })
    .catch(() => {});
}

/* 联系表单：fetch 提交 /api/contact，Honeypot 字段一并带上 */
const form = document.getElementById('contact-form');
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = form.querySelector('.form-status');
  const btn = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form).entries());

  if (!data.name?.trim() || !data.message?.trim()) {
    status.textContent = t('form.needName', '请填写姓名和留言内容。');
    status.className = 'form-status err';
    return;
  }

  btn.disabled = true;
  status.textContent = t('form.sending', '发送中……');
  status.className = 'form-status';
  try {
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.ok) {
      status.textContent = t('form.sent', '已收到，谢谢您的留言！');
      status.className = 'form-status ok';
      form.reset();
    } else if (out.error === 'rate_limited') {
      status.textContent = t('form.rateLimited', '发送太频繁，请稍后再试。');
      status.className = 'form-status err';
    } else {
      status.textContent = t('form.failed', '发送失败，请稍后重试或直接邮件联系。');
      status.className = 'form-status err';
    }
  } catch {
    status.textContent = t('form.network', '网络异常，请稍后重试。');
    status.className = 'form-status err';
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- PWA（docs/PWA应用方案.md §3.4-3.5）：SW 注册 ----------------
 * 全站统一脚本：静态页与 Worker 渲染页（/music /attractions /tv /library /merchants）都加载本文件。 */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

/* 安装提示一律不弹（2026-09-07 用户反馈：主动弹窗讨嫌）；离线提示胶囊同样不做（同日反馈）。
 * 仅静默 preventDefault，压掉 Chrome Android 的自动安装横幅；安装走浏览器原生入口：
 * 桌面 Chrome/Edge 地址栏安装图标、Android 三点菜单「安装应用」、iOS Safari 分享 → 添加到主屏幕。 */
window.addEventListener('beforeinstallprompt', (e) => e.preventDefault());
