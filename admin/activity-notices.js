import { localTime, NOTICE_ID, NOTICE_STATES, noticeWindow, sessionEnd } from '../shared/activity-notices.mjs';

const PAGE_SIZE = 24;
const BODY_LIMIT = 16 * 1024;
const TEXT_FIELDS = { title: 120, summary: 600, location: 160, source_name: 120, source_title: 160, change_note: 300 };
const reply = (data, status = 200) => Response.json(data, { status });
const error = (code, status = 400) => reply({ ok: false, error: code }, status);
const FINGERPRINT = /^[0-9a-f]{64}$/;
const PENDING_SOURCE = `EXISTS (SELECT 1 FROM activity_notice_inbox
  WHERE source_url = ? AND fingerprint = ? AND handled_fingerprint IS NOT fingerprint
    AND (notice_id IS NULL OR notice_id = ?))`;

async function readJson(request) {
  if (!request.body || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let body = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode());
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function parseSessions(input) {
  if (!Array.isArray(input) || input.length > 20) return null;
  const sessions = [];
  for (const item of input) {
    const { start, end = '' } = item || {};
    if (typeof start !== 'string' || typeof end !== 'string') return null;
    const from = localTime(start);
    const until = sessionEnd({ start, end });
    if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) return null;
    sessions.push({ start, end });
  }
  sessions.sort((left, right) => localTime(left.start) - localTime(right.start));
  if (sessions.some((session, i) => i > 0 && localTime(session.start) < sessionEnd(sessions[i - 1]))) return null;
  return sessions;
}

function parseDraft(input) {
  if (!input || !NOTICE_STATES.includes(input.state)) return null;
  const draft = { state: input.state };
  for (const [name, limit] of Object.entries(TEXT_FIELDS)) {
    const raw = input[name] ?? '';
    if (typeof raw !== 'string' || raw.trim().length > limit) return null;
    draft[name] = raw.trim();
  }
  if (!draft.title) return null;
  for (const name of ['source_date', 'verified_on', 'visible_through']) {
    const value = input[name] ?? '';
    if (value !== '' && (value.length !== 10 || !Number.isFinite(localTime(value)))) return null;
    draft[name] = value;
  }
  if (draft.source_date && draft.verified_on && draft.verified_on < draft.source_date) return null;
  if (!['postponed', 'cancelled'].includes(draft.state)) draft.visible_through = '';
  const source = input.source_url ?? '';
  if (typeof source !== 'string' || source.length > 2000) return null;
  draft.source_url = '';
  if (source.trim()) {
    try {
      const url = new URL(source.trim());
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      draft.source_url = url.href;
    } catch {
      return null;
    }
  }
  draft.sessions = parseSessions(input.sessions);
  draft.previous_sessions = parseSessions(input.previous_sessions ?? []);
  if (!draft.sessions || !draft.previous_sessions) return null;
  return draft;
}

async function listNotices(db, request) {
  const raw = Number(new URL(request.url).searchParams.get('page'));
  const page = Number.isInteger(raw) && raw > 0 && raw <= 10000 ? raw : 1;
  const { results } = await db.prepare(`SELECT id, draft, revision, published_revision, public_until, updated_at
    FROM activity_notices ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(PAGE_SIZE + 1, (page - 1) * PAGE_SIZE).all();
  const rows = results.slice(0, PAGE_SIZE).map(({ draft, ...row }) => ({ ...row, draft: JSON.parse(draft) }));
  return reply({ ok: true, rows, page, more: results.length > PAGE_SIZE });
}

async function listInbox(db) {
  const [inbox, run] = await db.batch([
    db.prepare(`SELECT source_url, source_title, source_name, source_date, fingerprint, notice_id, is_change, detected_at
      FROM activity_notice_inbox WHERE handled_fingerprint IS NOT fingerprint
      ORDER BY detected_at DESC, source_url LIMIT 24`),
    db.prepare('SELECT checked_at, status, changed, failed FROM activity_notice_collection WHERE id = 1'),
  ]);
  return reply({ ok: true, rows: inbox.results, run: run.results[0] || null });
}

async function dismissCandidate(db, input) {
  if (typeof input?.source_url !== 'string' || input.source_url.length > 2000 ||
    typeof input.fingerprint !== 'string' || !FINGERPRINT.test(input.fingerprint)) return error('bad_fields');
  const { meta } = await db.prepare(`UPDATE activity_notice_inbox SET handled_fingerprint = fingerprint
    WHERE source_url = ? AND fingerprint = ? AND handled_fingerprint IS NOT fingerprint`)
    .bind(input.source_url, input.fingerprint).run();
  return meta.changes ? reply({ ok: true }) : error('candidate_changed', 409);
}

async function saveWithCandidate(db, write, draft, fingerprint, id, revision) {
  const [saved] = await db.batch([write, db.prepare(`UPDATE activity_notice_inbox SET handled_fingerprint = fingerprint, notice_id = ?
    WHERE source_url = ? AND fingerprint = ? AND handled_fingerprint IS NOT fingerprint
      AND EXISTS (SELECT 1 FROM activity_notices WHERE id = ? AND revision = ? AND draft = ?)`)
    .bind(id, draft.source_url, fingerprint, id, revision, JSON.stringify(draft))]);
  return saved.meta.changes;
}

async function createNotice(db, input) {
  const draft = parseDraft(input);
  if (typeof input.id !== 'string' || !NOTICE_ID.test(input.id) || !draft) return error('bad_fields');
  if (input.candidate_fingerprint) {
    const write = db.prepare(`INSERT INTO activity_notices(id, draft) SELECT ?, ? WHERE ${PENDING_SOURCE}
      ON CONFLICT(id) DO NOTHING`).bind(input.id, JSON.stringify(draft), draft.source_url, input.candidate_fingerprint, input.id);
    const saved = await saveWithCandidate(db, write, draft, input.candidate_fingerprint, input.id, 1);
    return saved ? reply({ ok: true, id: input.id }, 201) : error('candidate_changed', 409);
  }
  const { meta } = await db.prepare(`INSERT INTO activity_notices(id, draft) VALUES (?, ?)
    ON CONFLICT(id) DO NOTHING`).bind(input.id, JSON.stringify(draft)).run();
  if (!meta.changes) {
    const existing = await db.prepare('SELECT draft FROM activity_notices WHERE id = ?').bind(input.id).first();
    if (existing.draft !== JSON.stringify(draft)) return error('conflict', 409);
  }
  return reply({ ok: true, id: input.id }, meta.changes ? 201 : 200);
}

async function saveDraft(db, current, input) {
  const draft = parseDraft(input);
  if (!draft) return error('bad_fields');
  if (current.published) {
    const live = JSON.parse(current.published);
    const moved = JSON.stringify(live.sessions) !== JSON.stringify(draft.sessions);
    if (moved && draft.state === 'scheduled') return error('schedule_change');
    if (moved && draft.state === 'rescheduled') draft.previous_sessions = live.sessions;
  }
  const update = `UPDATE activity_notices SET draft = ?, revision = revision + 1,
    updated_at = datetime('now') WHERE id = ? AND revision = ?`;
  const args = [JSON.stringify(draft), current.id, current.revision];
  if (input.candidate_fingerprint) {
    const write = db.prepare(`${update} AND ${PENDING_SOURCE}`).bind(...args, draft.source_url, input.candidate_fingerprint, current.id);
    const saved = await saveWithCandidate(db, write, draft, input.candidate_fingerprint, current.id, current.revision + 1);
    return saved ? reply({ ok: true }) : error('candidate_changed', 409);
  }
  const { meta } = await db.prepare(update).bind(...args).run();
  return meta.changes ? reply({ ok: true }) : error('conflict', 409);
}

async function recordPublication(db, current, actor, action) {
  const publishing = action === 'publish';
  if (!publishing && !current.published) return error('invalid_transition', 409);
  const draft = JSON.parse(current.draft);
  if (publishing) {
    if (current.revision === current.published_revision) return reply({ ok: true });
    if (!draft.summary || !draft.location || !draft.source_name || !draft.source_url || !draft.source_date
      || !draft.verified_on || !draft.sessions.length || (draft.state !== 'scheduled' && !draft.change_note)
      || (draft.state === 'rescheduled' && (!draft.previous_sessions.length
        || JSON.stringify(draft.sessions) === JSON.stringify(draft.previous_sessions)))) return error('incomplete');
  }
  const { start, until } = publishing ? noticeWindow(draft) : { start: null, until: null };
  // The revision predicate is shared by both statements so a concurrent action cannot produce an audit entry.
  const [, updated] = await db.batch([
    db.prepare(`INSERT INTO activity_notice_history(notice_id, revision, action, actor_uid, content)
      SELECT id, revision + 1, ?, ?, ${publishing ? 'draft' : 'published'}
      FROM activity_notices WHERE id = ? AND revision = ?`).bind(action, actor, current.id, current.revision),
    db.prepare(`UPDATE activity_notices SET published = ?, published_revision = ?, public_state = ?, public_start = ?,
      public_until = ?, revision = revision + 1, updated_at = datetime('now') WHERE id = ? AND revision = ?`)
      .bind(publishing ? current.draft : null, publishing ? current.revision + 1 : null,
        publishing ? draft.state : null, start, until, current.id, current.revision),
  ]);
  return updated.meta.changes ? reply({ ok: true }) : error('conflict', 409);
}

export async function handleActivityNoticesAdmin(request, env, path, actor) {
  const db = env.DB;
  if (path === '/api/activity-notices' && request.method === 'GET') return listNotices(db, request);
  if (path === '/api/activity-notices/inbox' && request.method === 'GET') return listInbox(db);
  if (path === '/api/activity-notices/inbox/dismiss' && request.method === 'POST') return dismissCandidate(db, await readJson(request));
  const route = /^\/api\/activity-notices\/([0-9a-f-]+)(?:\/(publish|withdraw))?$/.exec(path);
  if (path !== '/api/activity-notices' && (!route || !NOTICE_ID.test(route[1]))) return error('not_found', 404);
  if (route && !route[2] && request.method === 'GET') {
    const row = await db.prepare('SELECT id, draft, revision FROM activity_notices WHERE id = ?').bind(route[1]).first();
    return row ? reply({ ok: true, row: { ...row, draft: JSON.parse(row.draft) } }) : error('not_found', 404);
  }
  if (request.method !== 'POST') return error('method_not_allowed', 405);
  const input = await readJson(request);
  if (!input || typeof input !== 'object') return error('bad_fields');
  if (input.candidate_fingerprint !== undefined && (typeof input.candidate_fingerprint !== 'string' ||
    !FINGERPRINT.test(input.candidate_fingerprint) || route?.[2])) return error('bad_fields');
  if (!route) return createNotice(db, input);
  const current = await db.prepare('SELECT * FROM activity_notices WHERE id = ?').bind(route[1]).first();
  if (!current) return error('not_found', 404);
  if (input.revision !== current.revision) return error('conflict', 409);
  return route[2] ? recordPublication(db, current, actor, route[2]) : saveDraft(db, current, input);
}
