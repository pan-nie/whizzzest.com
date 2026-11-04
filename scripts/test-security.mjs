import test from 'node:test';
import assert from 'node:assert/strict';
import { requireHttps } from '../shared/https.mjs';

test('login pages upgrade without losing their path or query', () => {
  const res = requireHttps(new Request('http://writer.whizzzest.com/login?next=%2Fdashboard'));
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), 'https://writer.whizzzest.com/login?next=%2Fdashboard');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('HTTP credential submissions are rejected without consuming their body or redirecting', () => {
  const req = new Request('http://im.whizzzest.com/api/login', { method: 'POST', body: 'test-only' });
  const res = requireHttps(req);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('location'), null);
  assert.equal(req.bodyUsed, false);
});

test('API reads, non-GET forms and WebSocket handshakes cannot use HTTP', () => {
  for (const [path, init] of [
    ['/api', {}], ['/api/me', {}], ['/login', { method: 'POST' }],
    ['/ws', {}], ['/other', { headers: { upgrade: 'websocket' } }],
  ]) {
    assert.equal(requireHttps(new Request('http://im.whizzzest.com' + path, init)).status, 403);
  }
});

test('a forged proxy header cannot bypass the transport check', () => {
  const req = new Request('http://merchant.whizzzest.com/api/login', {
    headers: { 'x-forwarded-proto': 'https', forwarded: 'proto=https' },
  });
  assert.equal(requireHttps(req).status, 403);
});

test('HTTPS requests pass through, including API and WebSocket requests', () => {
  for (const path of ['/login', '/api/me', '/ws']) {
    assert.equal(requireHttps(new Request('https://im.whizzzest.com' + path)), null);
  }
});

test('only exact loopback hosts may use local HTTP', () => {
  for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787']) {
    assert.equal(requireHttps(new Request('http://' + host + '/api/me')), null);
  }
  assert.equal(requireHttps(new Request('http://localhost.example.com/api/me')).status, 403);
});
