/**
 * Reject insecure API/upgrade requests before authentication, storage or mail.
 * The zone-level HTTPS redirect also covers assets that bypass the Worker.
 * Never trust client-supplied Forwarded/X-Forwarded-Proto headers here.
 */
export function requireHttps(request) {
  const url = new URL(request.url);
  if (url.protocol === 'https:') return null;
  // Wrangler's local development server uses HTTP on loopback only.
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;

  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-type': 'text/plain; charset=utf-8',
  };
  const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
  const upgrade = url.pathname === '/ws' || request.headers.has('upgrade');
  if (api || upgrade || !['GET', 'HEAD'].includes(request.method)) {
    return new Response('HTTPS is required.', { status: 403, headers });
  }

  url.protocol = 'https:';
  url.port = '';
  return new Response(null, {
    status: 308,
    headers: { ...headers, location: url.href },
  });
}
