import { GALLERY_ID, galleryImage, galleryKey } from '../shared/gallery.mjs';

const PAGE_SIZE = 24;
const FULL_LIMIT = 5 * 1024 * 1024;
const THUMB_LIMIT = 1024 * 1024;
const BODY_LIMIT = FULL_LIMIT + THUMB_LIMIT + 16 * 1024;
const TEXT_FIELDS = {
  photographer: 120,
  title_zh: 120, location_zh: 160, alt_zh: 340, license_zh: 220,
  title_en: 120, location_en: 160, alt_en: 340, license_en: 220,
};
const REQUIRED = ['photographer', 'title_zh', 'location_zh', 'alt_zh', 'license_zh'];
const FIELDS = [...Object.keys(TEXT_FIELDS), 'taken_on', 'sort', 'status'];
const json = (data, status = 200) => Response.json(data, { status });
const error = (code, status = 400) => json({ ok: false, error: code }, status);

function activePhoto(env, id) {
  return env.DB.prepare('SELECT id, image_token, status, revision FROM gallery_photos WHERE id = ?').bind(id).first();
}

function boundedInt(raw, min, max) {
  const number = Number(raw);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function validDate(value) {
  if (!value) return true;
  if (!/^\d{4}-(?:0[1-9]|1[0-2])(?:-\d{2})?$/.test(value)) return false;
  const day = value.length === 7 ? `${value}-01` : value;
  const utc = Date.parse(day);
  return Number.isFinite(utc) && new Date(utc).toISOString().slice(0, 10) === day;
}

async function readForm(request, limit) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('multipart/form-data;') || !request.body) return error('bad_form');
  if (Number(request.headers.get('content-length')) > limit) return error('photo_too_large', 413);
  const chunks = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return error('photo_too_large', 413);
      }
      chunks.push(value);
    }
    const payload = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return await new Response(payload, { headers: { 'content-type': type } }).formData();
  } catch {
    return error('bad_form');
  } finally {
    reader.releaseLock();
  }
}

function metadata(form) {
  const fields = {};
  for (const [name, limit] of Object.entries(TEXT_FIELDS)) {
    const raw = form.get(name) ?? '';
    if (typeof raw !== 'string' || raw.trim().length > limit) return null;
    fields[name] = raw.trim();
  }
  if (REQUIRED.some((name) => !fields[name])) return null;
  const takenOn = form.get('taken_on') ?? '';
  const sort = boundedInt(form.get('sort'), -100000, 100000);
  const status = form.get('status');
  if (typeof takenOn !== 'string' || !validDate(takenOn) || sort === null || !['draft', 'published', 'hidden'].includes(status)) return null;
  return { ...fields, taken_on: takenOn, sort, status };
}

// Only baseline JPEGs from the browser encoder enter storage. App/comment segments that
// can contain camera metadata are rejected. The small JFIF header may not carry a thumbnail.
function jpegDimensions(bytes, maxEdge) {
  const end = bytes.length - 2;
  const word = (index) => bytes[index] * 256 + bytes[index + 1];
  if (bytes.length < 16 || word(0) !== 0xffd8 || word(end) !== 0xffd9) return null;
  let dimensions;
  let start = 2;
  while (start + 4 <= end) {
    if (bytes[start] !== 0xff) return null;
    const marker = bytes[start + 1];
    const length = word(start + 2);
    const next = start + 2 + length;
    if (length < 2 || next > end) return null;
    if (marker === 0xe0) {
      if (length !== 16 || bytes[start + 4] !== 74 || bytes[start + 5] !== 70 || bytes[start + 6] !== 73 ||
          bytes[start + 7] !== 70 || bytes[start + 8] !== 0 || bytes[next - 2] !== 0 || bytes[next - 1] !== 0) return null;
    } else if (marker === 0xc0) {
      if (dimensions || length < 11 || bytes[start + 4] !== 8) return null;
      const height = word(start + 5);
      const width = word(start + 7);
      if (!width || !height || width > maxEdge || height > maxEdge) return null;
      dimensions = { width, height };
    } else if (marker === 0xda) {
      if (!dimensions || length < 8 || next === end) return null;
      for (let i = next; i < end; i++) {
        if (bytes[i] !== 0xff) continue;
        const escaped = bytes[++i];
        if (escaped !== 0 && !(escaped >= 0xd0 && escaped <= 0xd7)) return null;
      }
      return dimensions;
    } else if (![0xc4, 0xdb, 0xdd].includes(marker)) return null;
    start = next;
  }
  return null;
}

async function photoUpload(form, name, size, edge) {
  const file = form.get(name);
  if (!(file instanceof File) || !file.size || file.size > size || file.type !== 'image/jpeg') return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dimensions = jpegDimensions(bytes, edge);
  return dimensions ? { bytes, ...dimensions } : null;
}

function photoKeys(id, token) {
  return ['full', 'thumb'].map((variant) => galleryKey(id, token, variant));
}

async function removeUnused(bucket, id, token) {
  try { await bucket.delete(photoKeys(id, token)); }
  catch (err) { console.error('gallery unused image cleanup failed', { id, token, error: String(err) }); }
}

async function createPhoto(request, env) {
  const form = await readForm(request, BODY_LIMIT);
  if (form instanceof Response) return form;
  const id = form.get('id');
  const details = metadata(form);
  if (typeof id !== 'string' || !GALLERY_ID.test(id) || !details) return error('bad_fields');
  const existing = await activePhoto(env, id);
  if (existing) return existing.status === 'deleted' ? error('conflict', 409) : json({ ok: true, id });
  const full = await photoUpload(form, 'full', FULL_LIMIT, 2048);
  const thumb = await photoUpload(form, 'thumb', THUMB_LIMIT, 640);
  if (!full || !thumb) return error('bad_photo');

  const token = crypto.randomUUID();
  const imageMetadata = { httpMetadata: { contentType: 'image/jpeg' } };
  try {
    await env.MEDIA.put(galleryKey(id, token, 'full'), full.bytes, imageMetadata);
    await env.MEDIA.put(galleryKey(id, token, 'thumb'), thumb.bytes, imageMetadata);
  } catch (err) {
    console.error('gallery image upload failed', { id, error: String(err) });
    await removeUnused(env.MEDIA, id, token);
    return error('upload_failed', 503);
  }

  try {
    const { meta } = await env.DB.prepare(`INSERT INTO gallery_photos (id, image_token, width, height, ${FIELDS.join(', ')})
      VALUES (${Array(4 + FIELDS.length).fill('?').join(', ')}) ON CONFLICT(id) DO NOTHING`)
      .bind(id, token, full.width, full.height, ...FIELDS.map((name) => details[name])).run();
    if (meta.changes) return json({ ok: true, id }, 201);
  } catch (err) {
    console.error('gallery metadata write failed', { id, error: String(err) });
  }

  // After an uncertain D1 write, verify the key is unused before removing it.
  let actual;
  try { actual = await activePhoto(env, id); }
  catch { return error('save_failed', 503); }
  if (actual?.image_token !== token) await removeUnused(env.MEDIA, id, token);
  if (!actual) return error('save_failed', 503);
  return actual.status === 'deleted' ? error('conflict', 409) : json({ ok: true, id });
}

async function editPhoto(request, env, id) {
  const form = await readForm(request, 16 * 1024);
  if (form instanceof Response) return form;
  const details = metadata(form);
  const revision = boundedInt(form.get('revision'), 1, Number.MAX_SAFE_INTEGER);
  if (!details || revision === null) return error('bad_fields');
  const { meta } = await env.DB.prepare(`UPDATE gallery_photos SET
    ${FIELDS.map((name) => `${name} = ?`).join(', ')}, revision = revision + 1, updated_at = datetime('now')
    WHERE id = ? AND revision = ? AND status <> 'deleted'`)
    .bind(...FIELDS.map((name) => details[name]), id, revision).run();
  return meta.changes ? json({ ok: true }) : error('conflict', 409);
}

async function deletePhoto(request, env, id) {
  const photo = await activePhoto(env, id);
  if (!photo) return json({ ok: true });
  if (photo.status !== 'deleted') {
    const revision = boundedInt(new URL(request.url).searchParams.get('revision'), 1, Number.MAX_SAFE_INTEGER);
    if (revision === null) return error('bad_fields');
    const { meta } = await env.DB.prepare(`UPDATE gallery_photos SET status = 'deleted', revision = revision + 1,
      updated_at = datetime('now') WHERE id = ? AND revision = ? AND status <> 'deleted'`).bind(id, revision).run();
    if (!meta.changes) return error('conflict', 409);
  }
  try {
    await env.MEDIA.delete(photoKeys(id, photo.image_token));
    await env.DB.prepare("DELETE FROM gallery_photos WHERE id = ? AND status = 'deleted' AND image_token = ?")
      .bind(id, photo.image_token).run();
    return json({ ok: true });
  } catch (err) {
    console.error('gallery deletion needs retry', { id, error: String(err) });
    return error('cleanup_pending', 503);
  }
}

export async function handleGalleryAdmin(request, env, pathname) {
  if (pathname === '/api/gallery') {
    if (request.method === 'POST') return createPhoto(request, env);
    if (request.method === 'GET') {
      const offset = boundedInt(new URL(request.url).searchParams.get('offset'), 0, 1000000) || 0;
      const { results } = await env.DB.prepare(`SELECT id, revision, ${FIELDS.join(', ')} FROM gallery_photos
        ORDER BY sort, created_at DESC, id LIMIT ? OFFSET ?`).bind(PAGE_SIZE + 1, offset).all();
      return json({ ok: true, photos: results.slice(0, PAGE_SIZE), more: results.length > PAGE_SIZE });
    }
  }
  const match = /^\/api\/gallery\/([^/]+)(?:\/(full|thumb))?$/.exec(pathname);
  if (!match || !GALLERY_ID.test(match[1])) return error('not_found', 404);
  const [, id, variant] = match;
  if (variant && ['GET', 'HEAD'].includes(request.method)) {
    const photo = await activePhoto(env, id);
    return galleryImage(request, env.MEDIA, photo?.status === 'deleted' ? null : photo, variant);
  }
  if (!variant && request.method === 'POST') return editPhoto(request, env, id);
  if (!variant && request.method === 'DELETE') return deletePhoto(request, env, id);
  return error('not_found', 404);
}
