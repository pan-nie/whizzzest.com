import { MUSIC_TYPES } from '../opera/music-format.mjs';
import { NEW_TRACK_ID, findMusicTrack, musicCatalog, musicCover, writeMusicTrack } from '../opera/music-library.mjs';

const BASE_PATH = '/api/opera-music';
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_FORM_BYTES = MAX_AUDIO_BYTES + MAX_COVER_BYTES + 32 * 1024;

function reply(error, status = 400) {
  return Response.json({ ok: false, error, message: error }, { status });
}

function hasAudioHeader(bytes, extension) {
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  switch (extension) {
    case 'mp3': return ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case 'm4a': return ascii(4, 4) === 'ftyp';
    case 'ogg': return ascii(0, 4) === 'OggS';
    case 'wav': return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE';
    default: return false;
  }
}

function coverFormat(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ['jpg', 'image/jpeg'];
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ['png', 'image/png'];
  const ascii = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (ascii(0) === 'RIFF' && ascii(8) === 'WEBP') return ['webp', 'image/webp'];
  return [];
}

async function discardObjects(bucket, keys) {
  const objects = keys.filter(Boolean);
  if (objects.length === 0) return;
  try {
    await bucket.delete(objects);
  } catch (error) {
    console.error('Opera music storage cleanup failed', error);
  }
}

async function listTracks(bucket, query, pageSize) {
  const tracks = await musicCatalog(bucket);
  const status = query.get('status');
  const offset = Math.max(0, Number.parseInt(query.get('offset'), 10) || 0);
  const byStatus = { published: 0, hidden: 0 };
  let storage = 0;
  for (const track of tracks) {
    byStatus[track.status]++;
    storage += track.size + track.cover_size;
  }
  const selected = Object.hasOwn(byStatus, status) ? tracks.filter(track => track.status === status) : tracks;
  const page = selected.slice(offset, offset + pageSize).map(({ cover_key, ...track }) => ({
    ...track,
    cover: cover_key ? BASE_PATH + '/' + encodeURIComponent(track.id) + '/cover' : null,
  }));
  return Response.json({ ok: true, total: tracks.length, byStatus, storage, tracks: page });
}

async function changeTrack(request, bucket, routeId) {
  const multipart = request.headers.get('Content-Type')?.toLowerCase().startsWith('multipart/form-data;');
  const length = Number(request.headers.get('Content-Length'));
  if (multipart && (!Number.isSafeInteger(length) || length <= 0)) return reply('无法读取上传大小，请重试。', 411);
  if (length > (multipart ? MAX_FORM_BYTES : 32 * 1024)) return reply('音频最多 20 MB，封面最多 5 MB。', 413);

  const data = multipart
    ? await request.formData().then(form => Object.fromEntries(form)).catch(() => null)
    : await request.json().catch(() => null);
  if (!data || typeof data !== 'object') return reply('无法读取曲目信息。');
  const id = routeId || data.id;
  if (!routeId && (typeof id !== 'string' || !NEW_TRACK_ID.test(id))) return reply('表单已失效，请重新打开。');
  const { track: old, object } = await findMusicTrack(bucket, id);
  const revision = typeof data.mutation === 'string' && NEW_TRACK_ID.test(data.mutation)
    ? data.mutation : crypto.randomUUID();
  const success = () => Response.json({
    ok: true, id, message: '曲目已保存。'
  }, { status: routeId ? 200 : 201 });

  // A retry of the same submission does not duplicate an upload or update.
  if (old?.revision === revision || (!routeId && !data.mutation && old?.status === 'published')) return success();
  if (routeId && (!old || old.status === 'deleted')) return reply('找不到这首曲目。', 404);
  if (old && (!routeId || data.revision !== old.revision)) return reply('曲目已发生变化，请刷新列表后重试。', 409);
  if (request.method === 'DELETE') {
    const tombstone = { id, revision, status: 'deleted' };
    if (!await writeMusicTrack(bucket, tombstone, object)) return reply('曲目已发生变化，请刷新列表后重试。', 409);
    await discardObjects(bucket, [old.file_key, old.cover_key]);
    return success();
  }

  const metadata = {};
  for (const [field, max] of Object.entries({ title: 80, artist: 40, description: 500 })) {
    const value = data[field] ?? old?.[field] ?? '';
    if (typeof value !== 'string') return reply('曲目信息格式有误。');
    metadata[field] = value.replace(/\r\n?/g, '\n').trim();
    if (metadata[field].length > max) return reply('曲目信息超过字数限制。');
  }
  if (!metadata.title) return reply('请填写曲名。');
  const status = data.status ?? old?.status ?? 'published';
  if (!['published', 'hidden'].includes(status)) return reply('曲目状态有误。');
  for (const [field, max] of Object.entries({ sort: 999, duration: 86400 })) {
    const value = Number(data[field] ?? old?.[field] ?? 0);
    if (!Number.isInteger(value) || value < 0 || value > max) return reply('曲序或时长超出范围。');
    metadata[field] = value;
  }

  const audio = data.audio;
  const cover = data.cover;
  if (!old && (!(audio instanceof File) || !audio.size)) return reply('请选择音频文件。');
  const extension = audio instanceof File ? audio.name.split('.').at(-1).toLowerCase() : '';
  if (audio instanceof File) {
    if (audio.size > MAX_AUDIO_BYTES) return reply('音频大小不能超过 20 MB。', 413);
    const bytes = new Uint8Array(await audio.slice(0, 12).arrayBuffer());
    if (!Object.hasOwn(MUSIC_TYPES, extension) || !hasAudioHeader(bytes, extension)) {
      return reply('请选择有效的 MP3、M4A、OGG 或 WAV 音频。');
    }
  }
  let coverExt, coverType;
  if (cover instanceof File) {
    if (cover.size > MAX_COVER_BYTES) return reply('封面大小不能超过 5 MB。', 413);
    [coverExt, coverType] = coverFormat(new Uint8Array(await cover.slice(0, 12).arrayBuffer()));
    if (!coverExt) return reply('请选择有效的 JPG、PNG 或 WebP 封面。');
  }

  const uploadId = crypto.randomUUID();
  const written = [];
  const fileKey = extension ? 'audio/' + uploadId + '.' + extension : old.file_key;
  const coverKey = coverExt ? 'covers/' + uploadId + '.' + coverExt : old?.cover_key ?? null;
  try {
    if (extension) {
      await bucket.put(fileKey, await audio.arrayBuffer(), { httpMetadata: { contentType: MUSIC_TYPES[extension] } });
      written.push(fileKey);
    }
    if (coverExt) {
      await bucket.put(coverKey, await cover.arrayBuffer(), { httpMetadata: { contentType: coverType } });
      written.push(coverKey);
    }
  } catch (error) {
    await discardObjects(bucket, written);
    throw error;
  }

  const track = {
    ...metadata, id, status, revision,
    file_key: fileKey, cover_key: coverKey,
    size: extension ? audio.size : old.size,
    cover_size: coverExt ? cover.size : old?.cover_size ?? 0,
    created_at: old?.created_at ?? new Date().toISOString(),
  };
  if (!await writeMusicTrack(bucket, track, object)) {
    await discardObjects(bucket, written);
    const current = await findMusicTrack(bucket, id);
    if (current.track?.revision === revision) return success();
    return reply('曲目已发生变化，请刷新列表后重试。', 409);
  }
  if (old) await discardObjects(bucket, [
    old.file_key !== fileKey ? old.file_key : null,
    old.cover_key !== coverKey ? old.cover_key : null,
  ]);
  return success();
}

export async function handleOperaMusic(request, path, bucket, pageSize) {
  if (!bucket) return reply('音乐存储暂时不可用。', 503);
  const { method } = request;
  if (method !== 'GET' && request.headers.get('Origin') !== new URL(request.url).origin) {
    return reply('请在管理后台提交操作。', 403);
  }
  if (path === BASE_PATH && method === 'GET') return listTracks(bucket, new URL(request.url).searchParams, pageSize);
  if (path === BASE_PATH && method === 'POST') return changeTrack(request, bucket, null);
  const match = path.match(/^\/api\/opera-music\/([^/]+)(\/cover)?$/);
  if (!match) return reply('找不到该曲目接口。', 404);
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return reply('无效的曲目地址。', 404);
  }
  if (match[2] && method === 'GET') {
    const { track } = await findMusicTrack(bucket, id);
    return musicCover(bucket, track?.cover_key);
  }
  if (!match[2] && ['POST', 'DELETE'].includes(method)) return changeTrack(request, bucket, id);
  return reply('该操作不可用。', 405);
}
