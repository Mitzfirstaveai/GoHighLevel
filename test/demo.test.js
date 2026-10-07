const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');

let t;

before(async () => {
  t = await startTestApp({ demoMode: true, adminEmail: '' });
});

after(() => t.close());

test('demo mode fills an empty database and offers one-tap sign-in', async () => {
  const { db } = t;
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 10);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM membership_plans').get().n, 5);
  const c = new t.Client();
  let res = await c.get('/login');
  assert.match(res.text, /Admin \(committee\)/);
  assert.match(res.text, /Member \(Family level\)/);

  // The demo button signs the admin in.
  res = await c.post('/login', { email: 'admin@example.com', password: 'demo1234' });
  assert.equal(res.status, 302);
  res = await c.get('/admin');
  assert.match(res.text, /Reset demo data/);

  // Change something, then reset brings the sample data back.
  const eventCount = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  db.prepare('DELETE FROM events').run();
  res = await c.post('/admin/demo/reset');
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, eventCount);
  res = await c.get('/admin');
  assert.match(res.text, /Demo data has been reset/);
});
