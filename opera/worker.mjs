import { COVER_PATH, MEDIA_PATH, findMusicTrack, musicCatalog, musicCover, trackFile } from './music-library.mjs';

async function listMusic(bucket) {
  const catalog = await musicCatalog(bucket);
  const tracks = catalog.filter(track => track.status === 'published').map(track => {
    const id = encodeURIComponent(track.id);
    return {
      title: track.title, description: track.description, artist: track.artist,
      url: MEDIA_PATH + id, cover: track.cover_key ? COVER_PATH + id : null,
      type: trackFile(track.file_key.split('/').at(-1)).type, uploaded: track.created_at,
    };
  });
  return Response.json({ tracks }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function selectedRange(header, size) {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return undefined;
  if (!size) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    const length = Math.min(size, suffix);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset) return null;
  return { offset, length: Math.min(size - 1, end) - offset + 1 };
}

function audioHeaders(object, type) {
  return new Headers({
    'Content-Type': type,
    'Content-Length': String(object.size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'ETag': object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  });
}

async function playMusic(request, bucket, path) {
  const cover = path.startsWith(COVER_PATH);
  let id;
  try {
    id = decodeURIComponent(path.slice((cover ? COVER_PATH : MEDIA_PATH).length));
  } catch {
    return new Response(null, { status: 404 });
  }
  const { track } = await findMusicTrack(bucket, id);
  if (track?.status !== 'published') return new Response(null, {
    status: 404, headers: { 'Cache-Control': 'no-store' },
  });
  if (cover) return musicCover(bucket, track.cover_key, request.method === 'HEAD');
  const objectKey = track.file_key;
  const { type } = trackFile(objectKey.split('/').at(-1));
  const rangeHeader = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');

  if (request.method === 'HEAD' || rangeHeader) {
    const info = await bucket.head(objectKey);
    if (!info) return new Response(null, { status: 404 });
    if (request.method === 'HEAD') return new Response(null, { headers: audioHeaders(info, type) });

    const range = !ifRange || ifRange === info.httpEtag || ifRange === info.uploaded.toUTCString()
      ? selectedRange(rangeHeader, info.size)
      : undefined;
    if (range === null) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': 'bytes */' + info.size, 'Accept-Ranges': 'bytes' },
      });
    }
    if (range) {
      const object = await bucket.get(objectKey, { range, onlyIf: { etagMatches: info.etag } });
      if (object?.body) {
        const headers = audioHeaders(object, type);
        headers.set('Content-Length', String(range.length));
        headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
        return new Response(object.body, { status: 206, headers });
      }
      // If the file was replaced during the ranged read, serve the new complete version.
    }
  }

  const object = await bucket.get(objectKey);
  if (!object) return new Response(null, { status: 404 });
  const headers = audioHeaders(object, type);
  if (request.headers.get('If-None-Match') === object.httpEtag) {
    await object.body.cancel();
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
}

async function pageWithCloudflareNonce(request, assets) {
  const reqHeaders = new Headers(request.headers);
  reqHeaders.delete('If-None-Match');
  reqHeaders.delete('If-Modified-Since');
  const response = await assets.fetch(new Request(request, { headers: reqHeaders }));
  if (!response.ok || !response.headers.get('Content-Type')?.startsWith('text/html')) return response;

  // Cloudflare applies this response nonce to its injected JavaScript Detection script.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
  const headers = new Headers(response.headers);
  const policy = headers.get('Content-Security-Policy');
  if (!policy?.includes("script-src 'self';")) throw new Error('The static script policy has changed');
  headers.set('Content-Security-Policy', policy.replace("script-src 'self';", `script-src 'self' 'nonce-${nonce}';`));
  // The browser enforces both policies. The first still requires a nonce for inline scripts.
  // The second prevents a nonce from authorizing a script fetched from a different origin.
  headers.append('Content-Security-Policy', "script-src 'self' 'unsafe-inline'");
  headers.set('Cache-Control', 'no-store');
  headers.delete('ETag');
  headers.delete('Last-Modified');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/api/music' && !pathname.startsWith(MEDIA_PATH)) {
      return pageWithCloudflareNonce(request, env.ASSETS);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    try {
      if (pathname === '/api/music') {
        if (request.method === 'HEAD') return new Response(null, { headers: { 'Cache-Control': 'no-store' } });
        return await listMusic(env.OPERA_MUSIC);
      }
      return await playMusic(request, env.OPERA_MUSIC, pathname);
    } catch (error) {
      console.error('Music storage unavailable', error);
      return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
