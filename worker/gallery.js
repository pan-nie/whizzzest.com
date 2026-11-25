import zh from '../src/data/gallery.json';
import en from '../src/data/en/gallery.json';
import { GALLERY_ID, galleryImage } from '../shared/gallery.mjs';

const SIZE = 24;
const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function photoCard(photo, index, locale, copy) {
  const href = `/gallery-media/${photo.id}`;
  const imageCaption = locale === 'en' ? photo.alt_en : photo.alt_zh;
  const text = (field, tag) => {
    const translated = locale === 'en' && photo[`${field}_en`];
    const lang = locale === 'en' && !translated ? ' lang="zh-CN"' : '';
    return `<${tag}${lang}>${esc(translated || photo[`${field}_zh`])}</${tag}>`;
  };
  const date = photo.taken_on ? ` · <time datetime="${esc(photo.taken_on)}">${esc(photo.taken_on)}</time>` : '';
  return `<figure class="photo-gallery-card" id="photo-${photo.id}">
    <a href="${href}/full.jpg" data-photo-link aria-haspopup="dialog">
      <img src="${href}/thumb.jpg" width="${photo.width}" height="${photo.height}" alt="${esc(imageCaption || photo.alt_zh)}"
        ${locale === 'en' && !imageCaption ? 'lang="zh-CN"' : ''} ${index ? 'loading="lazy"' : ''} decoding="async">
    </a>
    <figcaption>
      ${text('title', 'h2')}
      <p>${text('location', 'span')}${date}</p>
      <p>${copy.photographer} · ${esc(photo.photographer)}</p>
      <p>${copy.license} · ${text('license', 'span')}</p>
    </figcaption>
  </figure>`;
}

export async function handleGallery(request, env, url, locale) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const home = locale === 'en' ? '/en/gallery/' : '/gallery/';
  if (url.pathname !== home && url.pathname !== home.slice(0, -1)) {
    const notFound = await env.ASSETS.fetch(new URL(locale === 'en' ? '/en/404.html' : '/404.html', url));
    return new Response(request.method === 'HEAD' ? null : notFound.body, { status: 404, headers: notFound.headers });
  }

  // A stable asset URL lets query-parameter pagination use the same built page shell.
  const template = await env.ASSETS.fetch(new Request(new URL(home, url), { method: request.method }));
  if (!template.ok) return template;
  const headers = new Headers(template.headers);
  headers.set('cache-control', 'no-store');
  headers.delete('etag');
  headers.delete('content-length');
  headers.delete('last-modified');
  const page = new Response(template.body, { status: template.status, headers });
  if (request.method === 'HEAD') return page;

  const pageParam = Number(url.searchParams.get('page'));
  const number = Number.isInteger(pageParam) && pageParam > 0 && pageParam <= 10000 ? pageParam : 1;
  const { results } = await env.DB.prepare(`SELECT id, width, height, photographer, taken_on,
      title_zh, location_zh, alt_zh, license_zh, title_en, location_en, alt_en, license_en
    FROM gallery_photos WHERE status = 'published'
    ORDER BY sort, created_at DESC, id LIMIT ? OFFSET ?`).bind(SIZE + 1, (number - 1) * SIZE).all();
  if (!results.length) return number > 1 ? Response.redirect(new URL(home, url), 302) : page;

  const copy = locale === 'en' ? en : zh;
  const cards = results.slice(0, SIZE).map((photo, i) => photoCard(photo, i, locale, copy)).join('');
  const prev = number > 1 ? `<a href="${home}${number === 2 ? '' : `?page=${number - 1}`}">${copy.previous}</a>` : '';
  const next = results.length > SIZE ? `<a href="${home}?page=${number + 1}">${copy.next}</a>` : '';
  const nav = prev || next ? `<nav class="photo-gallery-pagination" aria-label="${copy.pagination}">${prev}${next}</nav>` : '';
  return new HTMLRewriter().on('#gallery-content', {
    element(element) {
      element.setInnerContent(`<div class="container-wide photo-gallery-grid" data-photo-gallery>${cards}</div>${nav}`, { html: true });
    },
  }).transform(page);
}

export async function handleGalleryImage(request, env, url) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const match = /^\/gallery-media\/([^/]+)\/(thumb|full)\.jpg$/.exec(url.pathname);
  if (!match || !GALLERY_ID.test(match[1])) return galleryImage(request, env.MEDIA, null);
  const photo = await env.DB.prepare("SELECT id, image_token FROM gallery_photos WHERE id = ? AND status = 'published'")
    .bind(match[1]).first();
  return galleryImage(request, env.MEDIA, photo, match[2]);
}
