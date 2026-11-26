import zh from '../src/data/news.json';
import en from '../src/data/en/news.json';
import { sessionEnd } from '../shared/activity-notices.mjs';

const PAGE_SIZE = 12;
const GROUPS = [
  { key: 'upcoming', where: "public_until > ? AND public_state = 'scheduled'", order: 'public_start' },
  { key: 'changes', where: "public_until > ? AND public_state <> 'scheduled'", order: 'public_until' },
  { key: 'archive', where: 'public_until <= ?', order: 'public_until DESC' },
];

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderTime(value) {
  const datetime = value.length === 10 ? value : `${value}:00+08:00`;
  return `<time datetime="${esc(datetime)}">${esc(value.replace('T', ' '))}</time>`;
}

function renderSchedule(sessions, label) {
  if (!sessions.length) return '';
  const items = sessions.map(({ start, end }) => `<li>${renderTime(start)}${end ? ` – ${renderTime(end)}` : ''}</li>`);
  return `${label ? `<p><strong>${label}</strong></p>` : ''}<ul class="notice-times">${items.join('')}</ul>`;
}

function renderCard(row, archive, now, copy, lang) {
  const notice = JSON.parse(row.published);
  const rescheduled = notice.state === 'rescheduled';
  const suspended = notice.state === 'postponed' || notice.state === 'cancelled';
  const sessions = archive || suspended ? notice.sessions : notice.sessions.filter((item) => sessionEnd(item) > now);
  return `<article class="feature-card notice-card" id="notice-${row.id}">
    <p class="notice-state">${copy[notice.state]}</p>
    <h3${lang}>${esc(notice.title)}</h3>
    ${renderSchedule(sessions, suspended ? copy.previousDates : rescheduled ? copy.currentDates : '')}
    ${rescheduled ? renderSchedule(notice.previous_sessions, copy.previousDates) : ''}
    <p${lang}>${esc(notice.location)}</p>
    <p${lang}>${esc(notice.summary)}</p>
    ${notice.state !== 'scheduled' ? `<p${lang}>${esc(notice.change_note)}</p>` : ''}
    <p><span${lang}>${esc(notice.source_name)}</span> · ${renderTime(notice.source_date)}</p>
    <p><a href="${esc(notice.source_url)}">${copy.source}${notice.source_title ? ` <span${lang}>${esc(notice.source_title)}</span>` : ''}</a>
      · ${copy.verified} ${renderTime(notice.verified_on)}</p>
  </article>`;
}

function pageNumber(raw) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 10000 ? value : 1;
}

async function renderBoard(db, url, copy, locale) {
  const now = Date.now();
  const pages = GROUPS.map(({ key }) => pageNumber(url.searchParams.get(key)));
  const results = await db.batch(GROUPS.map(({ where, order }, index) => db.prepare(`SELECT id, published
    FROM activity_notices WHERE published IS NOT NULL AND ${where} ORDER BY ${order}, id LIMIT ? OFFSET ?`)
    .bind(now, PAGE_SIZE + 1, (pages[index] - 1) * PAGE_SIZE)));
  const lang = locale === 'en' ? ' lang="zh-CN"' : '';
  return GROUPS.map(({ key }, index) => {
    const rows = results[index].results;
    const page = pages[index];
    function navLink(value, label) {
      const query = new URLSearchParams();
      GROUPS.forEach((group, i) => {
        const number = i === index ? value : pages[i];
        if (number > 1) query.set(group.key, number);
      });
      return `<a href="${query.size ? `?${esc(query)}` : url.pathname}#${key}">${label}</a>`;
    }
    const prev = page > 1 ? navLink(page - 1, copy.previous) : '';
    const next = rows.length > PAGE_SIZE ? navLink(page + 1, copy.next) : '';
    const cards = rows.slice(0, PAGE_SIZE).map((row) => renderCard(row, key === 'archive', now, copy, lang)).join('');
    return `<section class="notice-section" id="${key}">
      <h2>${copy[key]}</h2>
      ${cards || `<p>${copy[`${key}Empty`]}</p>`}
      ${prev || next ? `<nav class="notice-pagination" aria-label="${copy[key]}">${prev}${next}</nav>` : ''}
    </section>`;
  }).join('');
}

export async function handleActivityNotices(request, env, url, locale) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const home = locale === 'en' ? '/en/news/' : '/news/';
  if (url.pathname === home.slice(0, -1)) {
    return Response.redirect(new URL(home + url.search, url), 308);
  }
  if (url.pathname !== home) {
    const missing = await env.ASSETS.fetch(new URL(locale === 'en' ? '/en/404.html' : '/404.html', url));
    return new Response(request.method === 'HEAD' ? null : missing.body, { status: 404, headers: missing.headers });
  }
  const template = await env.ASSETS.fetch(new URL(home, url));
  if (!template.ok) return template;
  const headers = new Headers(template.headers);
  headers.set('cache-control', 'no-store');
  for (const name of ['etag', 'content-length', 'last-modified']) headers.delete(name);
  const copy = locale === 'en' ? en : zh;
  let content;
  let status = 200;
  try {
    content = await renderBoard(env.DB, url, copy, locale);
  } catch (err) {
    console.error('activity notices read failed', { error: String(err) });
    content = `<p>${copy.unavailable}</p>`;
    status = 503;
  }
  if (request.method === 'HEAD') return new Response(null, { headers, status });
  return new HTMLRewriter().on('#notice-content', {
    element(element) { element.setInnerContent(content, { html: true }); },
  }).transform(new Response(template.body, { headers, status }));
}
