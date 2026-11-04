const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const esbuild = require('esbuild');

function load(entry) {
  const code = esbuild.buildSync({ entryPoints: [entry], bundle: true, write: false,
    format: 'cjs', platform: 'node', external: ['cloudflare:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  const localRequire = name => name === 'cloudflare:sockets'
    ? { connect() { throw new Error('Network access is forbidden in this test'); } } : require(name);
  new Function('module', 'exports', 'require', code)(module, module.exports, localRequire);
  return module.exports;
}
const { createWebAuthn } = load('shared/webauthn.js');
const endpoints = ['reg-options', 'reg-verify', 'delete', 'login-options', 'login-verify'];

function fixture(portal) {
  const effects = [], rows = [];
  const handler = createWebAuthn({
    portal, rpName: 'Fixture', secret: () => 'test-only-' + portal, limited: () => false,
    userName: () => 'fixture@example.test',
    async listCredentials() { effects.push('list'); return rows; },
    async findCredential(env, id) { effects.push('find'); return rows.find(r => r.credential_id === id); },
    async insertCredential(env, uid, c) { effects.push('insert'); rows.push({ id: 1, user_id: uid, credential_id: c.id, public_key: c.publicKey, counter: c.counter }); },
    async deleteCredential(env, uid, id) { effects.push(['delete', uid, id]); const i = rows.findIndex(r => r.user_id === uid && r.id === id); if (i >= 0) rows.splice(i, 1); },
    async touchCounter(env, id, counter) { effects.push('counter'); rows.find(r => r.id === id).counter = counter; },
    async issueSession(env, uid) { effects.push(['session', uid]); return new Response(portal === 'admin' ? '{"ok":true}' : null,
      { status: portal === 'admin' ? 200 : 302, headers: { 'set-cookie': 'test-session=fixture; HttpOnly; Secure; SameSite=Strict', ...(portal === 'admin' ? {} : { location: '/dashboard' }) } }); },
  });
  return { handler, effects, rows };
}

function call(f, origin, endpoint, { suppliedOrigin = origin, body, cookie, user = { uid: 8 }, contentType = 'application/json' } = {}) {
  const headers = {};
  if (suppliedOrigin !== undefined) headers.origin = suppliedOrigin;
  if (contentType) headers['content-type'] = contentType;
  if (cookie) headers.cookie = cookie;
  const path = '/api/webauthn/' + endpoint;
  return f.handler.handle(new Request(origin + path, { method: 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body) }), {}, path, user);
}

function keyMaterial() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y, 'base64url')]);
  return { privateKey, cose, id: crypto.randomBytes(32) };
}

for (const portal of ['admin', 'merchant', 'writer']) {
  const origin = `https://${portal}.whizzzest.com`;
  test(`${portal}: reject supplied foreign/opaque/malformed origins before effects`, async () => {
    const foreign = ['https://game.whizzzest.com', 'https://whizzzest.com', 'https://example.test',
      'null', '', 'invalid-origin', origin + ', https://example.test', origin + '.evil.test',
      origin.replace('https:', 'http:'), origin + ':8443'];
    for (const suppliedOrigin of foreign) for (const endpoint of endpoints) {
      const f = fixture(portal);
      const res = await call(f, origin, endpoint, { suppliedOrigin, body: { id: 7 }, contentType: 'text/plain;charset=UTF-8' });
      assert.equal(res.status, 403, endpoint + ' / ' + suppliedOrigin);
      assert.equal(res.headers.get('set-cookie'), null);
      assert.deepEqual(f.effects, []);
    }
  });

  test(`${portal}: preserve bodyless same-origin options, absent-origin clients and user checks`, async () => {
    const f = fixture(portal);
    const bodyless = await call(f, origin, 'reg-options', { contentType: null });
    assert.equal(bodyless.status, 200);
    assert.match(bodyless.headers.get('set-cookie'), /wa_chal=reg\./);
    const path = '/api/webauthn/reg-options';
    const client = await f.handler.handle(new Request(origin + path, { method: 'POST' }), {}, path, { uid: 8 });
    assert.equal(client.status, 200);
    assert.equal((await call(f, origin, 'reg-options', { user: null })).status, 401);
    const local = await call(f, 'http://127.0.0.1:8787', 'reg-options', { contentType: null });
    assert.equal(local.status, 200);
  });

  test(`${portal}: real registration, authentication and owned deletion still work`, async () => {
    const f = fixture(portal), key = keyMaterial();
    const options = await call(f, origin, 'reg-options');
    const registrationChallenge = (await options.json()).options.challenge;
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: registrationChallenge, origin }));
    const size = Buffer.alloc(2); size.writeUInt16BE(key.id.length);
    const auth = Buffer.concat([crypto.createHash('sha256').update(new URL(origin).hostname).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), size, key.id, key.cose]);
    assert.ok(auth.length < 256);
    const attestation = Buffer.concat([Buffer.from('a363666d74646e6f6e656761747453746d74a068617574684461746158', 'hex'), Buffer.from([auth.length]), auth]);
    const registration = await call(f, origin, 'reg-verify', { cookie: options.headers.get('set-cookie').split(';')[0], body: {
      id: key.id.toString('base64url'), rawId: key.id.toString('base64url'), type: 'public-key',
      response: { clientDataJSON: clientData.toString('base64url'), attestationObject: attestation.toString('base64url'), transports: ['internal'] },
    } });
    assert.equal(registration.status, 200);
    assert.equal(f.rows.length, 1);
    const loginOptions = await call(f, origin, 'login-options', { user: null });
    const challenge = (await loginOptions.json()).options.challenge;
    const loginClient = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
    const count = Buffer.alloc(4); count.writeUInt32BE(1);
    const authData = Buffer.concat([crypto.createHash('sha256').update(new URL(origin).hostname).digest(), Buffer.from([5]), count]);
    const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(loginClient).digest()]), key.privateKey);
    const login = await call(f, origin, 'login-verify', { user: null, cookie: loginOptions.headers.get('set-cookie').split(';')[0], body: {
      id: key.id.toString('base64url'), rawId: key.id.toString('base64url'), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: loginClient.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url'), userHandle: null },
    } });
    assert.equal(login.status, portal === 'admin' ? 200 : 302);
    if (portal !== 'admin') assert.equal(login.headers.get('location'), '/dashboard');
    assert.ok(f.effects.some(e => Array.isArray(e) && e[0] === 'session' && e[1] === 8));
    assert.equal((await call(f, origin, 'delete', { body: { id: 1, user_id: 9 } })).status, 200);
    assert.equal(f.rows.length, 0);
    assert.deepEqual(f.effects.at(-1), ['delete', 8, 1]);
  });

  test(`${portal}: actual Worker applies the common guard on all credential POSTs`, async () => {
    const worker = load(`${portal}/index.js`).default;
    const env = { ADMIN_SESSION_SECRET: 'test-only-admin', MERCHANT_SESSION_SECRET: 'test-only-merchant', WRITER_SESSION_SECRET: 'test-only-writer' };
    for (const endpoint of endpoints) {
      const response = await worker.fetch(new Request(origin + '/api/webauthn/' + endpoint, {
        method: 'POST', headers: { origin: 'https://game.whizzzest.com', 'content-type': 'text/plain' }, body: '{"id":7}',
      }), env);
      assert.equal(response.status, 403, endpoint);
    }
    const own = await worker.fetch(new Request(origin + '/api/webauthn/login-options', { method: 'POST', headers: { origin } }), env);
    assert.equal(own.status, 200);
  });
}
