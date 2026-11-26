import { MUSIC_TYPES } from './music-format.mjs';

const TRACK_PREFIX = 'tracks/';
const INDEX_PREFIX = 'index/';
export const MEDIA_PATH = '/media/music/';
export const COVER_PATH = MEDIA_PATH + 'cover/';
export const NEW_TRACK_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function trackFile(name) {
  if (!/^[^/\\\x00-\x1f\x7f]+\.[a-z0-9]+$/i.test(name)) return null;
  const dot = name.lastIndexOf('.');
  const title = name.slice(0, dot).trim();
  const type = MUSIC_TYPES[name.slice(dot + 1).toLowerCase()];
  return title && typeof type === 'string' ? { title, type } : null;
}

function legacyTrack(object) {
  const id = object.key.slice(TRACK_PREFIX.length);
  const audio = trackFile(id);
  if (!audio || !object.size) return null;
  return {
    id,
    title: object.customMetadata?.title?.trim() || audio.title,
    description: object.customMetadata?.description?.trim() || '',
    artist: '', sort: 0, duration: 0, status: 'published',
    file_key: object.key, cover_key: null, size: object.size, cover_size: 0,
    created_at: object.uploaded.toISOString(),
    revision: 'legacy-' + object.etag,
  };
}

function indexedTrack(object) {
  return JSON.parse(object.customMetadata.track);
}

async function objectsAt(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, delimiter: '/', include: ['customMetadata'] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

export async function musicCatalog(bucket) {
  const [legacy, records] = await Promise.all([objectsAt(bucket, TRACK_PREFIX), objectsAt(bucket, INDEX_PREFIX)]);
  const indexed = new Map(records.map(object => [object.key.slice(INDEX_PREFIX.length), indexedTrack(object)]));
  const tracks = [...indexed.values()].filter(track => track.status !== 'deleted');
  for (const object of legacy) {
    const track = legacyTrack(object);
    if (track && !indexed.has(track.id)) tracks.push(track);
  }
  tracks.sort((a, b) => a.sort - b.sort || b.created_at.localeCompare(a.created_at) ||
    a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
  return tracks;
}

export async function findMusicTrack(bucket, id) {
  if (!NEW_TRACK_ID.test(id) && !trackFile(id)) return { track: null, object: null };
  const object = await bucket.head(INDEX_PREFIX + id);
  if (object) return { track: indexedTrack(object), object };
  const legacy = trackFile(id) ? await bucket.head(TRACK_PREFIX + id) : null;
  return { track: legacy ? legacyTrack(legacy) : null, object: null };
}

export async function writeMusicTrack(bucket, track, previousObject) {
  const value = JSON.stringify(track);
  // The record body changes on every revision so R2's ETag guards simultaneous edits.
  return bucket.put(INDEX_PREFIX + track.id, value, {
    customMetadata: { track: value },
    onlyIf: previousObject
      ? { etagMatches: previousObject.etag }
      : new Headers({ 'If-None-Match': '*' }),
  });
}

export async function musicCover(bucket, key, headOnly = false) {
  const object = key ? await (headOnly ? bucket.head(key) : bucket.get(key)) : null;
  const type = object?.httpMetadata?.contentType;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
    await object?.body?.cancel();
    return new Response(null, { status: 404 });
  }
  return new Response(headOnly ? null : object.body, { headers: {
    'Content-Type': type,
    'Content-Length': String(object.size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}
