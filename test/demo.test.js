const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');

let server;
let base;
let db;

before(async () => {
  const app = createApp(loadConfig({ databaseFile: ':memory:', demoMode: true, allowDemoPayments: true, adminEmail: '', stripeSecretKey: '' }));
  db = app.locals.db;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function fetchWithCookie(path, { cookie = '', form } = {}) {
  const res = await fetch(base + path, {
    method: form ? 'POST' : 'GET',
    headers: { cookie, ...(form && { 'content-type': 'application/x-www-form-urlencoded' }) },
    body: form && new URLSearchParams(form).toString(),
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  return { res, text: await res.text(), cookie: set ? set.split(';')[0] : cookie };
}

test('demo mode fills an empty database and offers one-tap sign-in', async () => {
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 10);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM membership_plans').get().n, 5);
  let { text, cookie } = await fetchWithCookie('/login');
  assert.match(text, /Admin \(committee\)/);
  assert.match(text, /Member \(Family level\)/);
  const csrf = text.match(/name="_csrf" value="([^"]+)"/)[1];

  // The demo button signs the admin in.
  ({ cookie } = await fetchWithCookie('/login', { cookie, form: { _csrf: csrf, email: 'admin@example.com', password: 'demo1234' } }));
  ({ text } = await fetchWithCookie('/admin', { cookie }));
  assert.match(text, /Reset demo data/);

  // Change something, then reset brings the sample data back.
  db.prepare(`DELETE FROM events`).run();
  const token = text.match(/name="_csrf" value="([^"]+)"/)[1];
  const { res } = await fetchWithCookie('/admin/demo/reset', { cookie, form: { _csrf: token } });
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 5);
  ({ text } = await fetchWithCookie('/admin', { cookie }));
  assert.match(text, /Demo data has been reset/);
});
