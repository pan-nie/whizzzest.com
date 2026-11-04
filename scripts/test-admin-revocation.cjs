const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const esbuild = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

const origin = 'https://admin.whizzzest.com';
const secret = 'test-only-admin-session-secret';
const password = 'test-only-operator-password';
const salt = '00112233445566778899aabbccddeeff';
const hash = crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex');
const keys = new Map();
let mf, db;

function signedCookie(uid) {
  const value = `${uid}.${Date.now() + 3600000}`;
  return 'wa_session=' + value + '.' + crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function request(path, { uid = 0, cookie = signedCookie(uid), method = 'GET', body, browser = false } = {}) {
  return mf.dispatchFetch(origin + path, {
    method, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body),
    // Non-browser management clients have no Origin. Miniflare rewrites Host internally.
    headers: { host: 'admin.whizzzest.com', ...(browser ? { origin } : {}), cookie, 'content-type': 'application/json' },
  });
}

function credential(uid) {
  if (keys.has(uid)) return keys.get(uid);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  // COSE EC2/P-256/ES256 map: {1:2, 3:-7, -1:1, -2:x, -3:y}.
  const cose = Buffer.concat([
    Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x, 'base64url'),
    Buffer.from('225820', 'hex'), Buffer.from(jwk.y, 'base64url'),
  ]);
  const value = { id: crypto.randomBytes(32).toString('base64url'), privateKey, publicKey: cose.toString('base64url') };
  keys.set(uid, value);
  return value;
}

async function passkeyLogin(uid) {
  const options = await request('/api/webauthn/login-options', { cookie: '', method: 'POST', body: {}, browser: true });
  assert.equal(options.status, 200);
  const challengeCookie = options.headers.get('set-cookie').split(';')[0];
  const { options: { challenge } } = await options.json();
  const key = credential(uid);
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
  const count = Buffer.alloc(4); count.writeUInt32BE(1);
  const authData = Buffer.concat([crypto.createHash('sha256').update('admin.whizzzest.com').digest(), Buffer.from([5]), count]);
  const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]), key.privateKey);
  return request('/api/webauthn/login-verify', { cookie: challengeCookie, method: 'POST', browser: true, body: {
    id: key.id, rawId: key.id, type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url'), userHandle: null },
  } });
}

before(async () => {
  const script = esbuild.buildSync({ entryPoints: ['admin/index.js'], bundle: true, write: false,
    format: 'esm', platform: 'browser', external: ['cloudflare:*'] }).outputFiles[0].text;
  const options = { modules: true, script, compatibilityDate: '2026-09-01',
    bindings: { ADMIN_SESSION_SECRET: secret, ADMIN_PASSWORD: 'test-only-owner-password' }, d1Databases: ['DB'], d1Persist: false };
  mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  db = await mf.getD1Database('DB');
  const schema = fs.readFileSync('schema.sql', 'utf8');
  for (const table of ['admin_users', 'webauthn_credentials']) {
    const statement = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\([\\s\\S]*?\\);`));
    assert.ok(statement, table + ' schema exists');
    await db.prepare(statement[0]).run();
  }
});
after(async () => { if (mf) await mf.dispose(); });
beforeEach(async () => {
  await db.prepare('DROP TRIGGER IF EXISTS fail_key_cleanup').run();
  await db.batch([db.prepare('DELETE FROM admin_users'), db.prepare('DELETE FROM webauthn_credentials')]);
  for (const [id, username] of [[7, 'deleted-op'], [8, 'active-op']]) {
    await db.prepare('INSERT INTO admin_users (id, username, pass_hash, pass_salt) VALUES (?1, ?2, ?3, ?4)').bind(id, username, hash, salt).run();
  }
  for (const [portal, uid] of [['admin', 0], ['admin', 7], ['admin', 8], ['writer', 7], ['merchant', 7]]) {
    const key = credential(uid);
    await db.prepare('INSERT INTO webauthn_credentials (portal, user_id, credential_id, public_key, counter, transports, device) VALUES (?1, ?2, ?3, ?4, 0, ?, ?)')
      .bind(portal, uid, portal === 'admin' ? key.id : Buffer.from(portal + '-' + uid).toString('base64url'), key.publicKey, '[]', 'test-only').run();
  }
});

test('deleting an operator revokes its password session on every protected boundary', async () => {
  const login = await request('/api/login', { cookie: '', method: 'POST', body: { username: 'deleted-op', password } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/accounts/7', { method: 'DELETE' })).status, 200);
  for (const path of ['/api/me', '/api/accounts', '/api/webauthn/list']) assert.equal((await request(path, { cookie })).status, 401, path);
  const page = await request('/', { cookie });
  assert.equal(page.status, 302); assert.equal(page.headers.get('location'), '/login');
  assert.equal((await request('/api/accounts/8', { cookie, method: 'DELETE' })).status, 401);
  assert.ok(await db.prepare('SELECT id FROM admin_users WHERE id = 8').first());
});

test('an old orphan Passkey cannot mint a new admin session', async () => {
  await db.prepare('DELETE FROM admin_users WHERE id = 7').run();
  const response = await passkeyLogin(7);
  assert.equal(response.status, 401);
  assert.equal((response.headers.get('set-cookie') || '').includes('wa_session='), false);
});

test('owner and existing operator Passkeys still authenticate with real P-256 assertions', async () => {
  for (const uid of [0, 8]) {
    const response = await passkeyLogin(uid);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /wa_session=/);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  }
});

test('the owner still logs in without an admin_users row', async () => {
  const response = await request('/api/login', { cookie: '', method: 'POST', body: { password: 'test-only-owner-password' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^wa_session=0\./);
  assert.equal((await request('/api/me')).status, 200);
});

test('operator deletion removes only that operator admin credentials', async () => {
  assert.equal((await request('/api/accounts/7', { method: 'DELETE' })).status, 200);
  for (const [portal, uid, expected] of [['admin', 7, 0], ['admin', 0, 1], ['admin', 8, 1], ['writer', 7, 1], ['merchant', 7, 1]]) {
    const { n } = await db.prepare('SELECT count(*) n FROM webauthn_credentials WHERE portal = ?1 AND user_id = ?2').bind(portal, uid).first();
    assert.equal(n, expected, portal + '/' + uid);
  }
});

test('deleting owner, missing or unsafe identifiers preserves owner keys and returns 404', async () => {
  for (const id of ['0', '99', '9007199254740993']) assert.equal((await request('/api/accounts/' + id, { method: 'DELETE' })).status, 404);
  assert.equal((await db.prepare("SELECT count(*) n FROM webauthn_credentials WHERE portal = 'admin' AND user_id = 0").first()).n, 1);
});

test('account and credential deletion roll back together if cleanup fails', async () => {
  await db.prepare("CREATE TRIGGER fail_key_cleanup BEFORE DELETE ON webauthn_credentials WHEN OLD.portal = 'admin' AND OLD.user_id = 7 BEGIN SELECT RAISE(ABORT, 'test-only cleanup failure'); END").run();
  assert.equal((await request('/api/accounts/7', { method: 'DELETE' })).status, 500);
  assert.ok(await db.prepare('SELECT id FROM admin_users WHERE id = 7').first());
});

test('recreating a username cannot revive the deleted identity', async () => {
  const cookie = signedCookie(7);
  assert.equal((await request('/api/accounts/7', { method: 'DELETE' })).status, 200);
  assert.equal((await request('/api/accounts', { method: 'POST', body: { username: 'deleted-op', password } })).status, 200);
  const row = await db.prepare("SELECT id FROM admin_users WHERE username = 'deleted-op'").first();
  assert.notEqual(row.id, 7);
  assert.equal((await request('/api/me', { cookie })).status, 401);
});
