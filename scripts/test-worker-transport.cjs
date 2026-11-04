// Exercise the bundled handlers in workerd with no production bindings or data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

async function main() {
  for (const name of ['main', 'admin', 'merchant', 'writer', 'im', 'game']) {
    const file = process.argv[2]
      ? path.resolve(process.argv[2], name, 'index.js')
      : path.resolve(name === 'main' ? '.' : name, '.wrangler-dry', 'index.js');
    const options = {
      modules: true,
      script: fs.readFileSync(file, 'utf8'),
      compatibilityDate: '2026-09-01', // Same target as the production configs.
    };
    if (name === 'im') {
      options.durableObjects = {
        ROOM: { className: 'IMRoom', useSQLite: true },
        PRESENCE: { className: 'IMPresence', useSQLite: true },
        LIMITERS: { className: 'RateLimiter', useSQLite: true },
      };
    }
    const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
    const origin = name === 'main' ? 'http://whizzzest.com' : `http://${name}.whizzzest.com`;
    try {
      const page = await mf.dispatchFetch(origin + '/login?next=%2Fdashboard', { redirect: 'manual' });
      assert.equal(page.status, 308, `${name}: insecure login page`);
      assert.equal(page.headers.get('location'), origin.replace('http:', 'https:') + '/login?next=%2Fdashboard');
      const login = await mf.dispatchFetch(origin + '/api/login', { method: 'POST', body: 'test-only', redirect: 'manual' });
      assert.equal(login.status, 403, `${name}: insecure login submission`);
      assert.equal(login.headers.get('location'), null);
      const socket = await mf.dispatchFetch(origin + '/ws', { headers: { upgrade: 'websocket' }, redirect: 'manual' });
      assert.equal(socket.status, 403, `${name}: insecure websocket`);
      console.log(`${name}: transport checks passed in workerd`);
    } finally {
      await mf.dispose();
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
